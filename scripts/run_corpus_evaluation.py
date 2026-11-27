"""Run frozen development selection and held-out evaluation without text logs."""

from __future__ import annotations

import argparse
import gc
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.corpus_evaluation import (
    DatasetError,
    accuracy_gate,
    containment_scores,
    project_gold,
    select_threshold,
    wilson_interval,
)
from scripts.evaluation import (
    ErrorSpan,
    OnnxRunner,
    TorchRunner,
    aggregate_span_scores,
    scores,
    spans_from_logits,
    token_label_scores,
)
from scripts.model_pipeline import (
    CONVERTED_ROOT,
    EXPECTED_REVISION,
    ROOT,
    UPSTREAM_ROOT,
    load_model_metadata,
    sha256_file,
)


def validate_output(logits: np.ndarray, offsets: list, labels: tuple) -> None:
    if logits.shape != (len(offsets), len(labels)) or not np.isfinite(logits).all():
        raise ValueError("nonfinite logits or incompatible label/token shape")


def evaluate_outputs(
    items: list[dict], outputs: list[tuple], labels: tuple, threshold: float
) -> dict:
    if len(items) != len(outputs) or not items:
        raise ValueError("missing corpus outputs")
    totals = {name: {"tp": 0, "fp": 0, "fn": 0} for name in ("event", "location", "token")}
    raw_pairs, projected_pairs = [], []
    per_label = {label: {"tp": 0, "fp": 0, "fn": 0} for label in labels if label != "OK"}
    clean_count = clean_fp = typo_count = conflicts = gaps = ambiguous = 0
    record_hits = {
        f"record_{kind}_{scope}_hits": 0
        for kind in ("location", "label")
        for scope in ("any", "all")
    }
    for item, (logits, offsets) in zip(items, outputs, strict=True):
        validate_output(logits, offsets, labels)
        gold = [ErrorSpan(**entry) for entry in item["errors"]]
        alternatives = [
            [ErrorSpan(**entry) for entry in scenario]
            for scenario in item.get("error_alternatives", [item["errors"]])
        ]
        if not alternatives or any(
            len(scenario) != len(gold)
            or sorted(span.label for span in scenario) != sorted(span.label for span in gold)
            for scenario in alternatives
        ):
            raise ValueError("invalid joint alignment alternatives")
        if any(
            span.label not in labels
            or span.label == "OK"
            or not 0 <= span.start <= span.end <= len(item["text"])
            for scenario in alternatives
            for span in scenario
        ):
            raise ValueError("unknown corpus label")
        ambiguous += len(alternatives) > 1
        predicted = spans_from_logits(logits, offsets, list(labels), threshold)
        raw_pairs.append((gold, predicted))
        # One complete reconstruction per metric, never an independent union of
        # possible event positions. Exact/token diagnostics use canonical gold.
        primary_gold = max(
            alternatives, key=lambda scenario: containment_scores(scenario, predicted)["tp"]
        )
        for name, labeled in (("event", True), ("location", False)):
            metric_gold = (
                primary_gold
                if labeled
                else max(
                    alternatives,
                    key=lambda scenario: containment_scores(scenario, predicted, labeled=False)[
                        "tp"
                    ],
                )
            )
            result = containment_scores(metric_gold, predicted, labeled=labeled)
            for key in ("tp", "fp", "fn"):
                totals[name][key] += result[key]
            if gold:
                kind = "label" if labeled else "location"
                record_hits[f"record_{kind}_any_hits"] += result["tp"] > 0
                record_hits[f"record_{kind}_all_hits"] += result["tp"] == len(gold)
        for label, counts in per_label.items():
            result = containment_scores(
                [span for span in primary_gold if span.label == label],
                [span for span in predicted if span.label == label],
            )
            for key in counts:
                counts[key] += result[key]
        gaps += sum(span.start == span.end for span in gold)
        try:
            projected = project_gold(gold, offsets)
            projected_pairs.append((projected, predicted))
            token = token_label_scores(projected, predicted, offsets, list(labels))
            for key in totals["token"]:
                totals["token"][key] += token[key]
        except DatasetError:
            conflicts += 1
        if gold:
            typo_count += 1
        else:
            clean_count += 1
            clean_fp += bool(predicted)
    event = scores(totals["event"])
    event["precision_interval95"] = wilson_interval(event["tp"], event["tp"] + event["fp"])
    event["recall_interval95"] = wilson_interval(event["tp"], event["tp"] + event["fn"])
    return {
        "threshold": threshold,
        "items": len(items),
        "typo_items": typo_count,
        "clean_items": clean_count,
        "clean_false_positive_items": clean_fp,
        "clean_rate": clean_fp / clean_count if clean_count else None,
        "clean_rate_interval95": wilson_interval(clean_fp, clean_count),
        "event": event,
        "location": scores(totals["location"]),
        "raw_exact": aggregate_span_scores(raw_pairs),
        "projected_span": aggregate_span_scores(projected_pairs),
        "token": scores(totals["token"]),
        "label_wise": {label: scores(counts) for label, counts in per_label.items()},
        "projection_unscorable_documents": conflicts,
        "ambiguous_alignment_documents": ambiguous,
        "zero_width_gold_events": gaps,
        **record_hits,
    }


def parity(reference: list[tuple], candidate: list[tuple]) -> dict:
    if len(reference) != len(candidate):
        raise ValueError("parity document count mismatch")
    maximum = total = count = matches = tokens = 0
    for (expected, offsets), (actual, candidate_offsets) in zip(reference, candidate, strict=True):
        if expected.shape != actual.shape or offsets != candidate_offsets:
            raise ValueError("parity shape/offset mismatch")
        if not np.isfinite(expected).all() or not np.isfinite(actual).all():
            raise ValueError("nonfinite parity logits")
        delta = np.abs(expected - actual)
        maximum = max(maximum, float(delta.max()))
        total += float(delta.sum(dtype=np.float64))
        count += delta.size
        active = np.array([end > start for start, end in offsets])
        matches += int(np.sum((expected.argmax(-1) == actual.argmax(-1))[active]))
        tokens += int(active.sum())
    return {
        "max_abs_logit_delta": maximum,
        "mean_abs_logit_delta": total / count,
        "token_argmax_agreement": matches / tokens,
        "ordinary_tokens": tokens,
    }


class StrictTokenizer:
    def _tokenize(self, text: str):
        encoded = self.tokenizer(
            text, return_offsets_mapping=True, return_tensors="np", truncation=False
        )
        if encoded["input_ids"].shape[1] > self.max_length:
            raise ValueError("corpus exceeds model limit; refusing silent truncation")
        offsets = [tuple(pair) for pair in encoded.pop("offset_mapping")[0].tolist()]
        return encoded, offsets


class CorpusTorchRunner(StrictTokenizer, TorchRunner):
    pass


class CorpusOnnxRunner(StrictTokenizer, OnnxRunner):
    pass


def cache_outputs(
    name: str, items: list[dict], dataset_sha: str, output: Path
) -> tuple[list, dict]:
    filenames = {
        "onnx_fp32": "model.onnx",
        "onnx_quint8": "model_quantized.onnx",
        "onnx_fp16": "model_fp16.onnx",
    }
    model_path = (
        UPSTREAM_ROOT / "model.safetensors"
        if name == "pytorch"
        else CONVERTED_ROOT / "onnx" / filenames[name]
    )
    provenance = {
        "dataset_sha256": dataset_sha,
        "model_sha256": sha256_file(model_path),
        "revision": EXPECTED_REVISION,
        "runner_sha256": sha256_file(Path(__file__)),
        "tokenizer_sha256": sha256_file(UPSTREAM_ROOT / "tokenizer.json"),
        "tokenizer_config_sha256": sha256_file(UPSTREAM_ROOT / "tokenizer_config.json"),
        "model_config_sha256": sha256_file(UPSTREAM_ROOT / "config.json"),
        "scorer_sha256": sha256_file(ROOT / "scripts/corpus_evaluation.py"),
        "evaluation_sha256": sha256_file(ROOT / "scripts/evaluation.py"),
    }
    if name == "onnx_fp32":
        provenance["external_data_sha256"] = sha256_file(model_path.with_suffix(".onnx.data"))
    cache = output / f"{name}-logits.npz"
    sidecar = output / f"{name}-cache.json"
    if cache.exists() and sidecar.exists():
        previous = json.loads(sidecar.read_text(encoding="utf-8"))
        if (
            previous.get("inputs") != provenance
            or previous.get("cache_sha256") != sha256_file(cache)
            or previous.get("items") != len(items)
        ):
            raise ValueError("existing logits cache has different inputs; choose a new output")
        with np.load(cache, allow_pickle=False) as arrays:
            bounds, logits, offsets = arrays["bounds"], arrays["logits"], arrays["offsets"]
            if (
                logits.ndim != 2
                or not np.isfinite(logits).all()
                or offsets.ndim != 2
                or offsets.shape[1] != 2
                or not np.issubdtype(offsets.dtype, np.integer)
                or offsets.shape[0] != logits.shape[0]
                or bounds.ndim != 1
                or not np.issubdtype(bounds.dtype, np.integer)
                or len(bounds) != len(items) + 1
                or len(bounds) == 0
                or bounds[0] != 0
                or bounds[-1] != logits.shape[0]
                or np.any(bounds < 0)
                or np.any(bounds > logits.shape[0])
                or np.any(bounds[1:] <= bounds[:-1])
            ):
                raise ValueError("existing logits cache has invalid shape/offset bounds")
            for item, start, end in zip(items, bounds[:-1], bounds[1:], strict=True):
                item_offsets = offsets[start:end]
                text_length = len(item["text"])
                if np.any(item_offsets[:, 0] < 0) or np.any(item_offsets[:, 1] < 0):
                    raise ValueError("existing logits cache has invalid text offsets")
                if np.any(item_offsets[:, 0] > item_offsets[:, 1]) or np.any(
                    item_offsets[:, 1] > text_length
                ):
                    raise ValueError("existing logits cache has invalid text offsets")
            results = [
                (logits[start:end], [tuple(pair) for pair in offsets[start:end].tolist()])
                for start, end in zip(bounds[:-1], bounds[1:], strict=True)
            ]
        print(f"{name}: verified cached outputs {len(results)}", flush=True)
        return results, previous
    if name == "pytorch":
        import torch

        torch.set_num_threads(4)
        runner = CorpusTorchRunner(UPSTREAM_ROOT)
    else:
        runner = CorpusOnnxRunner(model_path, CONVERTED_ROOT)
    outputs = []
    started = time.perf_counter()
    for index, item in enumerate(items):
        outputs.append(runner.logits(item["text"]))
        if index % 100 == 0:
            print(f"{name}: {index + 1}/{len(items)}", flush=True)
    del runner
    gc.collect()
    bounds = np.cumsum([0, *[len(offsets) for _, offsets in outputs]])
    np.savez_compressed(
        cache,
        logits=np.concatenate([value for value, _ in outputs]),
        offsets=np.concatenate([np.asarray(offsets) for _, offsets in outputs]),
        bounds=bounds,
    )
    metadata = {
        "inputs": provenance,
        "cache_sha256": sha256_file(cache),
        "items": len(items),
        "elapsed_seconds": time.perf_counter() - started,
        "pytorch_threads": 4,
    }
    sidecar.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return outputs, metadata


def validate_dataset(path: Path, dataset: dict, manifest: dict, phase: str, labels: tuple) -> None:
    expected = manifest.get("outputs", {}).get(path.name, {})
    if expected.get("sha256") != sha256_file(path) or expected.get("bytes") != path.stat().st_size:
        raise ValueError("dataset hash/size does not match manifest")
    if manifest.get("model_revision") != EXPECTED_REVISION or manifest.get("labels") != list(
        labels
    ):
        raise ValueError("dataset model revision/labels mismatch")
    split = dataset.get("metadata", {}).get("source_split")
    if split != {"development": "train", "held-out": "official_test"}[phase]:
        raise ValueError("dataset phase/split mismatch")
    if not dataset.get("items"):
        raise ValueError("empty evaluation dataset")


def validate_decision(decision: dict, manifest_sha: str, protocol_sha: str) -> None:
    if (
        decision.get("model_revision") != EXPECTED_REVISION
        or decision.get("phase") != "development"
    ):
        raise ValueError("invalid development decision")
    if decision.get("dataset_manifest_sha256") != manifest_sha:
        raise ValueError("development dataset manifest mismatch")
    if decision.get("protocol_sha256") != protocol_sha:
        raise ValueError("development protocol mismatch")
    selected = decision.get("selection", {}).get("threshold")
    if (
        isinstance(selected, bool)
        or not isinstance(selected, (float, int))
        or not np.isfinite(selected)
        or not 0 <= selected <= 1
    ):
        raise ValueError("invalid selected threshold")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phase", choices=["development", "held-out"], required=True)
    parser.add_argument("--decision", type=Path)
    parser.add_argument("--protocol", type=Path, default=ROOT / "benchmarks/protocols/jwtd-v1.json")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    items = dataset["items"]
    manifest_sha = sha256_file(args.dataset.parent / "manifest.json")
    protocol_sha = sha256_file(args.protocol)
    metadata = load_model_metadata(UPSTREAM_ROOT)
    validate_dataset(
        args.dataset,
        dataset,
        json.loads((args.dataset.parent / "manifest.json").read_text(encoding="utf-8")),
        args.phase,
        metadata.labels,
    )
    if args.phase == "held-out":
        if args.decision is None:
            raise ValueError("held-out evaluation requires frozen development decision")
        decision = json.loads(args.decision.read_text(encoding="utf-8"))
        validate_decision(decision, manifest_sha, protocol_sha)
        thresholds = sorted({0.0, 0.5, float(decision["selection"]["threshold"])})
    else:
        thresholds = [0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]
    source_commit = subprocess.check_output(
        ["git", "-c", f"safe.directory={ROOT.as_posix()}", "rev-parse", "HEAD"], text=True
    ).strip()
    all_outputs, cache_metadata, results = {}, {}, {}
    for name in ("pytorch", "onnx_fp32", "onnx_quint8", "onnx_fp16"):
        outputs, cache_metadata[name] = cache_outputs(
            name, items, sha256_file(args.dataset), args.output
        )
        all_outputs[name] = outputs
        results[name] = {
            str(value): evaluate_outputs(items, outputs, metadata.labels, value)
            for value in thresholds
        }
    report = {
        "source_commit": source_commit,
        "model_revision": EXPECTED_REVISION,
        "phase": args.phase,
        "dataset_sha256": sha256_file(args.dataset),
        "dataset_manifest_sha256": manifest_sha,
        "protocol_sha256": protocol_sha,
        "models": results,
        "cache": cache_metadata,
        "parity_to_pytorch": {
            name: parity(all_outputs["pytorch"], values)
            for name, values in all_outputs.items()
            if name != "pytorch"
        },
    }
    if args.phase == "development":
        selection = select_threshold(
            {key: row for key, row in results["onnx_quint8"].items() if key != "0.0"}
        )
        decision = {
            "phase": args.phase,
            "model_revision": EXPECTED_REVISION,
            "source_commit": source_commit,
            "development_sha256": sha256_file(args.dataset),
            "dataset_manifest_sha256": manifest_sha,
            "protocol_sha256": protocol_sha,
            "selection": selection,
        }
        (args.output / "decision.json").write_text(
            json.dumps(decision, indent=2) + "\n", encoding="utf-8"
        )
        report["selection"] = selection
    else:
        key = str(float(decision["selection"]["threshold"]))
        ref, candidate = results["pytorch"][key], results["onnx_quint8"][key]
        report["decision_sha256"] = sha256_file(args.decision)
        report["acceptance"] = accuracy_gate(
            ref["event"],
            candidate["event"],
            candidate["clean_false_positive_items"],
            candidate["clean_items"],
        )
        if not decision["selection"]["admissible"]:
            report["acceptance"]["failures"].append("no admissible development threshold")
        if report["parity_to_pytorch"]["onnx_fp32"]["max_abs_logit_delta"] > 0.001:
            report["acceptance"]["failures"].append("FP32 logit delta exceeds 0.001")
        report["acceptance"]["passed"] = not report["acceptance"]["failures"]
    destination = args.output / "evaluation.json"
    destination.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": destination.as_posix(),
                "phase": args.phase,
                "acceptance": report.get("acceptance"),
                "selection": report.get("selection"),
            }
        )
    )
    return 0 if report.get("acceptance", {"passed": True})["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
