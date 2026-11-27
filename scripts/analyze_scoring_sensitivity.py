"""Diagnose alignment sensitivity from immutable development caches, without inference."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.corpus_evaluation import containment_scores, wilson_interval
from scripts.evaluate_candidate import (
    BASELINE_RUNNER_SHA256,
    BASELINE_SOURCE_COMMIT,
    _validate_runner_compatibility,
)
from scripts.evaluation import ErrorSpan, scores, spans_from_logits
from scripts.model_pipeline import EXPECTED_REVISION, ROOT, load_model_metadata, sha256_file
from scripts.prepare_release import PreparationError, git_source
from scripts.run_corpus_evaluation import evaluate_outputs, validate_dataset

MODEL_FILES = {
    "pytorch": "model.safetensors",
    "onnx_fp32": "model.onnx",
    "onnx_quint8": "model_quantized.onnx",
    "onnx_fp16": "model_fp16.onnx",
}
FROZEN_BASELINE_SHA256 = "fe1926d09ac6051e8180ecf726e11cbc2335c843b85226eb2b2ac0311a727328"


class SensitivityError(ValueError):
    """An input cannot be accepted as frozen development evidence."""


def _require(condition, message):
    if not condition:
        raise SensitivityError(message)


def _source(allow_dirty):
    try:
        return git_source(ROOT)
    except PreparationError as error:
        if not allow_dirty:
            raise SensitivityError("diagnostic source could not be bound") from error
        return {"commit": "unknown", "clean": False, "git_unavailable": True}


def _validate(items, outputs, labels):
    _require(
        bool(labels) and labels[0] == "OK" and len(set(labels)) == len(labels), "invalid labels"
    )
    _require(bool(items) and len(items) == len(outputs), "missing corpus outputs")
    for item, (logits, offsets) in zip(items, outputs, strict=True):
        text = item["text"]
        _require(isinstance(text, str), "invalid text type")
        _require(
            isinstance(logits, np.ndarray)
            and np.issubdtype(logits.dtype, np.floating)
            and logits.shape == (len(offsets), len(labels))
            and np.isfinite(logits).all(),
            "invalid logits",
        )
        _require(0 < len(offsets) <= 8192, "invalid token count")
        for pair in offsets:
            _require(
                len(pair) == 2
                and all(isinstance(v, (int, np.integer)) and not isinstance(v, bool) for v in pair)
                and 0 <= pair[0] <= pair[1] <= len(text),
                "invalid offsets",
            )
        canonical = item["errors"]
        alternatives = item.get("error_alternatives", [canonical])
        _require(
            bool(alternatives) and alternatives[0] == canonical, "canonical alignment must be first"
        )
        for scenario in alternatives:
            _require(
                len(scenario) == len(canonical)
                and sorted(v["label"] for v in scenario) == sorted(v["label"] for v in canonical),
                "inconsistent complete reconstructions",
            )
            for entry in scenario:
                _require(
                    all(
                        isinstance(entry[k], int) and not isinstance(entry[k], bool)
                        for k in ("start", "end")
                    )
                    and 0 <= entry["start"] <= entry["end"] <= len(text)
                    and entry["label"] in labels[1:],
                    "invalid gold span",
                )


def analyze_outputs(items, outputs, labels):
    """Vary primary alignment selection; retain all frozen canonical diagnostics."""
    try:
        _validate(items, outputs, labels)
        best = evaluate_outputs(items, outputs, labels, 0.5)
        modes = {name: copy.deepcopy(best) for name in ("canonical", "best", "worst")}
        ranges = []
        for mode in ("canonical", "worst"):
            totals = {
                name: dict.fromkeys(("tp", "fp", "fn"), 0)
                for name in ("event", "location", *labels[1:])
            }
            hits = {
                f"record_{kind}_{scope}_hits": 0
                for kind in ("label", "location")
                for scope in ("any", "all")
            }
            for item, (logits, offsets) in zip(items, outputs, strict=True):
                alternatives = [
                    [ErrorSpan(**v) for v in scenario]
                    for scenario in item.get("error_alternatives", [item["errors"]])
                ]
                predicted = spans_from_logits(logits, offsets, list(labels), 0.5)
                selected = {}
                for name, labeled in (("event", True), ("location", False)):
                    chosen = (
                        alternatives[0]
                        if mode == "canonical"
                        else min(
                            alternatives,
                            key=lambda scenario: containment_scores(
                                scenario, predicted, labeled=labeled
                            )["tp"],
                        )
                    )
                    selected[name] = chosen
                    result = containment_scores(chosen, predicted, labeled=labeled)
                    for key in ("tp", "fp", "fn"):
                        totals[name][key] += result[key]
                    if chosen:
                        kind = "label" if labeled else "location"
                        hits[f"record_{kind}_any_hits"] += result["tp"] > 0
                        hits[f"record_{kind}_all_hits"] += result["tp"] == len(chosen)
                for label in labels[1:]:
                    result = containment_scores(
                        [v for v in selected["event"] if v.label == label],
                        [v for v in predicted if v.label == label],
                    )
                    for key in ("tp", "fp", "fn"):
                        totals[label][key] += result[key]
            event = scores(totals["event"])
            for name, denominator in (
                ("precision", event["tp"] + event["fp"]),
                ("recall", event["tp"] + event["fn"]),
            ):
                event[name + "_interval95"] = wilson_interval(event["tp"], denominator)
            modes[mode].update(
                event=event,
                location=scores(totals["location"]),
                label_wise={label: scores(totals[label]) for label in labels[1:]},
                **hits,
            )
        for index, (item, (logits, offsets)) in enumerate(zip(items, outputs, strict=True)):
            alternatives = item.get("error_alternatives", [item["errors"]])
            if len(alternatives) > 1:
                predicted = spans_from_logits(logits, offsets, list(labels), 0.5)
                counts = [
                    containment_scores([ErrorSpan(**v) for v in scenario], predicted)["tp"]
                    for scenario in alternatives
                ]
                ranges.append(
                    {
                        "index": index,
                        "alternatives": len(alternatives),
                        "event_tp": {
                            "canonical": counts[0],
                            "best": max(counts),
                            "worst": min(counts),
                        },
                    }
                )
        return {"modes": modes, "ambiguous_document_ranges": ranges}
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise SensitivityError("invalid diagnostic inputs") from error


def _read(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    _require(isinstance(value, dict), "invalid JSON object")
    return value


def _frontier_counts(item, output, labels, threshold):
    logits, offsets = output
    predicted = spans_from_logits(logits, offsets, list(labels), threshold)
    alternatives = [
        [ErrorSpan(**value) for value in scenario]
        for scenario in item.get("error_alternatives", [item["errors"]])
    ]
    chosen = max(alternatives, key=lambda scenario: containment_scores(scenario, predicted)["tp"])
    return {
        **containment_scores(chosen, predicted),
        "clean_fp": int(not item["errors"] and bool(predicted)),
    }


def confidence_frontier(items, outputs, labels):
    """Enumerate every inclusive confidence threshold state without new inference.

    Only changed documents are rescored. Removing a token can split a merged span,
    so neither event counts nor recall are assumed monotonic. Ties change together.
    """
    try:
        _validate(items, outputs, labels)
        totals = dict.fromkeys(("tp", "fp", "fn", "clean_fp"), 0)
        changes = defaultdict(lambda: dict.fromkeys(totals, 0))
        clean_items = sum(not value["errors"] for value in items)
        for item, (logits, offsets) in zip(items, outputs, strict=True):
            shifted = logits - np.max(logits, axis=-1, keepdims=True)
            probabilities = np.exp(shifted)
            probabilities /= np.sum(probabilities, axis=-1, keepdims=True)
            boundaries = set()
            for (start, end), row in zip(offsets, probabilities, strict=True):
                label_id = int(np.argmax(row))
                confidence = float(row[label_id])
                if end > start and label_id != 0 and confidence < 1:
                    boundaries.add(float(np.nextafter(confidence, np.inf)))
            previous = _frontier_counts(item, (logits, offsets), labels, 0.0)
            for key in totals:
                totals[key] += previous[key]
            for boundary in sorted(boundaries):
                current = _frontier_counts(item, (logits, offsets), labels, boundary)
                for key in totals:
                    changes[boundary][key] += current[key] - previous[key]
                previous = current
        points = []
        for threshold in sorted({0.0, 1.0, *changes}):
            for key, value in changes.get(threshold, {}).items():
                totals[key] += value
            points.append(
                {
                    "threshold": threshold,
                    "event": scores({key: totals[key] for key in ("tp", "fp", "fn")}),
                    "clean_items": clean_items,
                    "clean_false_positive_items": totals["clean_fp"],
                    "clean_rate": totals["clean_fp"] / clean_items if clean_items else None,
                }
            )
        return {
            "domain": [0.0, 1.0],
            "policy": "inclusive token confidence; complete best gold; atomic ties",
            "targets": {"precision_min": 0.95, "recall_min": 0.8, "clean_rate_max": 0.02},
            "representative_points": len(points),
            "points": points,
            "attainable_points": sum(
                point["event"]["precision"] >= 0.95
                and point["event"]["recall"] >= 0.8
                and point["clean_rate"] is not None
                and point["clean_rate"] <= 0.02
                for point in points
            ),
            "max_recall": max(points, key=lambda point: point["event"]["recall"]),
            "max_f1": max(points, key=lambda point: point["event"]["f1"]),
        }
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise SensitivityError("invalid confidence diagnostic inputs") from error


def _load_cache(path, count):
    with np.load(path, allow_pickle=False) as arrays:
        _require(set(arrays.files) == {"bounds", "logits", "offsets"}, "invalid cache keys")
        bounds, logits, offsets = (arrays[name] for name in ("bounds", "logits", "offsets"))
        _require(
            bounds.ndim == 1
            and np.issubdtype(bounds.dtype, np.integer)
            and len(bounds) == count + 1
            and bounds[0] == 0
            and logits.ndim == 2
            and offsets.shape == (len(logits), 2)
            and np.issubdtype(offsets.dtype, np.integer)
            and bounds[-1] == len(logits)
            and np.all(np.diff(bounds) > 0),
            "invalid cache bounds",
        )
        return [
            (logits[a:b], [tuple(v) for v in offsets[a:b].tolist()])
            for a, b in zip(bounds[:-1], bounds[1:], strict=True)
        ]


def run_analysis(
    *,
    dataset,
    dataset_manifest,
    protocol,
    baseline,
    cache_dir,
    upstream_dir,
    converted_dir,
    output,
    baseline_sha256=FROZEN_BASELINE_SHA256,
    allow_dirty_source=False,
    threshold_frontier=False,
):
    """Validate every input and reproduce the baseline before writing any report."""
    try:
        _require(
            not output.exists() or (output.is_dir() and not any(output.iterdir())),
            "output must be empty",
        )
        source = _source(allow_dirty_source)
        _require(allow_dirty_source or source["clean"], "diagnostic source must be clean")
        _require(sha256_file(baseline) == baseline_sha256, "frozen baseline hash mismatch")
        data, manifest, rules, reference = map(
            _read, (dataset, dataset_manifest, protocol, baseline)
        )
        metadata = load_model_metadata(upstream_dir)
        labels = metadata.labels
        validate_dataset(dataset, data, manifest, "development", labels)
        _require(
            metadata.model_type == "modernbert" and metadata.max_position_embeddings == 8192,
            "invalid model configuration",
        )
        _require(
            reference.get("phase") == "development"
            and reference.get("source_commit") == BASELINE_SOURCE_COMMIT
            and reference.get("model_revision") == EXPECTED_REVISION,
            "invalid baseline origin",
        )
        _require(
            rules.get("model_revision") == EXPECTED_REVISION
            and rules.get("default_product_threshold") == 0.5,
            "invalid protocol",
        )
        provenance = {
            "dataset_sha256": sha256_file(dataset),
            "dataset_manifest_sha256": sha256_file(dataset_manifest),
            "protocol_sha256": sha256_file(protocol),
        }
        for key, digest in provenance.items():
            _require(reference.get(key) == digest, "baseline input hash mismatch")
        shared = {
            "dataset_sha256": provenance["dataset_sha256"],
            "revision": EXPECTED_REVISION,
            "runner_sha256": BASELINE_RUNNER_SHA256,
            "scorer_sha256": sha256_file(ROOT / "scripts/corpus_evaluation.py"),
            "evaluation_sha256": sha256_file(ROOT / "scripts/evaluation.py"),
        }
        for filename, key in (
            ("config.json", "model_config_sha256"),
            ("tokenizer.json", "tokenizer_sha256"),
            ("tokenizer_config.json", "tokenizer_config_sha256"),
        ):
            shared[key] = sha256_file(upstream_dir / filename)
            _require(
                shared[key] == sha256_file(converted_dir / filename), "converted metadata mismatch"
            )
        compatibility = _validate_runner_compatibility(
            shared, ROOT / "scripts/run_corpus_evaluation.py"
        )
        models, caches = {}, {}
        for name, filename in MODEL_FILES.items():
            model = (
                upstream_dir / filename if name == "pytorch" else converted_dir / "onnx" / filename
            )
            expected = {**shared, "model_sha256": sha256_file(model)}
            if name == "onnx_fp32":
                expected["external_data_sha256"] = sha256_file(model.with_suffix(".onnx.data"))
            cache = cache_dir / f"{name}-logits.npz"
            sidecar = _read(cache_dir / f"{name}-cache.json")
            _require(
                sidecar == reference["cache"][name]
                and sidecar.get("inputs") == expected
                and sidecar.get("cache_sha256") == sha256_file(cache)
                and sidecar.get("items") == len(data["items"]),
                "cache provenance mismatch",
            )
            outputs = _load_cache(cache, len(data["items"]))
            result = analyze_outputs(data["items"], outputs, labels)
            _require(
                json.loads(json.dumps(result["modes"]["best"], allow_nan=False))
                == reference["models"][name]["0.5"],
                "frozen baseline not reproduced",
            )
            if threshold_frontier:
                result["threshold_frontier"] = confidence_frontier(data["items"], outputs, labels)
            models[name], caches[name] = result, sidecar
        report = {
            "schema_version": 1,
            "execution": {"status": "completed"},
            "inference_performed": False,
            "baseline_reproduced": True,
            "baseline": {
                "source_commit": reference["source_commit"],
                "sha256": sha256_file(baseline),
                "expected_sha256": baseline_sha256,
                "canonical_development_v1": baseline_sha256 == FROZEN_BASELINE_SHA256,
            },
            "source": source,
            "dirty_source_explicitly_allowed": allow_dirty_source,
            "model_revision": EXPECTED_REVISION,
            "provenance": {**provenance, **shared},
            "diagnostic_sha256": sha256_file(Path(__file__)),
            "runner_compatibility": compatibility,
            "cache": caches,
            "models": models,
            "product_acceptance": "not established by this development diagnostic",
            "diagnostics_policy": (
                "raw_exact, projected_span and token remain canonical in every mode; "
                "labeled and unlabeled primary selection are independent complete reconstructions"
            ),
        }
        lines = [
            "# Development alignment sensitivity",
            "",
            "No inference; frozen best metrics reproduced. Training-exposed development data.",
            "",
            "| Model | Mode | TP | FP | FN | Precision | Recall | F1 |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for name, result in models.items():
            for mode, value in result["modes"].items():
                event = value["event"]
                lines.append(
                    f"| {name} | {mode} | {event['tp']} | {event['fp']} | {event['fn']} | "
                    f"{event['precision']:.6f} | {event['recall']:.6f} | {event['f1']:.6f} |"
                )
        lines += ["", report["diagnostics_policy"], "", report["product_acceptance"], ""]
        if threshold_frontier:
            lines += [
                "## Exhaustive confidence threshold diagnostic",
                "",
                "Development only; product threshold unchanged. Tied tokens change atomically.",
                "",
                "| Model | Points | Attainable | Maximum recall | Maximum F1 |",
                "| --- | --- | --- | --- | --- |",
            ]
            for name, result in models.items():
                frontier = result["threshold_frontier"]
                lines.append(
                    f"| {name} | {frontier['representative_points']} | "
                    f"{frontier['attainable_points']} | "
                    f"{frontier['max_recall']['event']['recall']:.6f} | "
                    f"{frontier['max_f1']['event']['f1']:.6f} |"
                )
            lines.append("")
        _require(_source(allow_dirty_source) == source, "diagnostic source changed during analysis")
        output.mkdir(parents=True, exist_ok=True)
        (output / "sensitivity.json").write_text(
            json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
        )
        (output / "summary.md").write_text("\n".join(lines), encoding="utf-8")
        return report
    except (OSError, ValueError, KeyError, TypeError, IndexError, PreparationError) as error:
        if isinstance(error, SensitivityError):
            raise
        raise SensitivityError("cannot validate development diagnostic inputs") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "dataset",
        "dataset-manifest",
        "protocol",
        "baseline",
        "cache-dir",
        "upstream-dir",
        "converted-dir",
        "output",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--baseline-sha256", default=FROZEN_BASELINE_SHA256)
    parser.add_argument("--allow-dirty-source", action="store_true")
    parser.add_argument("--threshold-frontier", action="store_true")
    args = parser.parse_args()
    try:
        report = run_analysis(**vars(args))
    except SensitivityError as error:
        parser.error(str(error))
    print(
        json.dumps(
            {"baseline_reproduced": report["baseline_reproduced"], "inference_performed": False}
        )
    )


if __name__ == "__main__":
    main()
