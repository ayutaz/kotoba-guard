"""Bounded, reproducible metrics for the pinned typo-detector artifacts."""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.model_pipeline import EXPECTED_REVISION, MODEL_ID, load_model_metadata


@dataclass(frozen=True)
class ErrorSpan:
    start: int
    end: int
    label: str
    confidence: float = 1.0

    def key(self) -> tuple[int, int, str]:
        return self.start, self.end, self.label


def _counts(gold: Iterable[ErrorSpan], predicted: Iterable[ErrorSpan]) -> dict[str, int]:
    gold_keys = {item.key() for item in gold}
    predicted_keys = {item.key() for item in predicted}
    tp = len(gold_keys & predicted_keys)
    return {"tp": tp, "fp": len(predicted_keys - gold_keys), "fn": len(gold_keys - predicted_keys)}


def scores(counts: dict[str, int]) -> dict[str, float | int]:
    tp, fp, fn = counts["tp"], counts["fp"], counts["fn"]
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {**counts, "precision": precision, "recall": recall, "f1": f1}


def exact_span_scores(gold: list[ErrorSpan], predicted: list[ErrorSpan]) -> dict[str, float | int]:
    return scores(_counts(gold, predicted))


SpanPair = tuple[list[ErrorSpan], list[ErrorSpan]]


def aggregate_span_scores(pairs: Iterable[SpanPair]) -> dict[str, float | int]:
    """Aggregate exact spans per document so offsets cannot collide across texts."""
    totals = {"tp": 0, "fp": 0, "fn": 0}
    for gold, predicted in pairs:
        counts = _counts(gold, predicted)
        for field in totals:
            totals[field] += counts[field]
    return scores(totals)


def label_scores(
    gold: list[ErrorSpan], predicted: list[ErrorSpan], labels: Iterable[str]
) -> dict[str, dict[str, float | int]]:
    return {
        label: scores(
            _counts(
                [item for item in gold if item.label == label],
                [item for item in predicted if item.label == label],
            )
        )
        for label in labels
    }


def aggregate_label_scores(
    pairs: Iterable[SpanPair], labels: Iterable[str]
) -> dict[str, dict[str, float | int]]:
    """Aggregate label spans per document while preserving document identity."""
    totals = {label: {"tp": 0, "fp": 0, "fn": 0} for label in labels}
    for gold, predicted in pairs:
        for label, counts in totals.items():
            local = _counts(
                [item for item in gold if item.label == label],
                [item for item in predicted if item.label == label],
            )
            for field in counts:
                counts[field] += local[field]
    return {label: scores(counts) for label, counts in totals.items()}


def check_conversion(
    result: dict[str, Any],
    *,
    threshold: float = 0.5,
    f1_tolerance: float = 0.01,
    clean_fp_tolerance: float = 0.02,
    fp32_logit_limit: float = 1e-3,
) -> dict[str, Any]:
    """Apply bounded conversion regression gates to a completed evaluation."""
    key = str(threshold)
    reference = result["thresholds"][key]["pytorch"]
    failures: list[str] = []
    epsilon = 1e-12

    def finite_metric(value: Any, name: str) -> float | None:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            failures.append(f"{name} must be finite, got {value!r}")
            return None
        if not np.isfinite(numeric):
            failures.append(f"{name} must be finite, got {value!r}")
            return None
        return numeric

    for name in ("onnx_fp32", "onnx_quint8", "onnx_fp16"):
        candidate = result["thresholds"][key][name]
        reference_f1 = finite_metric(reference["span"]["f1"], "pytorch span F1")
        candidate_f1 = finite_metric(candidate["span"]["f1"], f"{name} span F1")
        if reference_f1 is not None and candidate_f1 is not None:
            f1_drop = reference_f1 - candidate_f1
        else:
            f1_drop = None
        if f1_drop is not None and f1_drop - f1_tolerance > epsilon:
            failures.append(f"{name} span F1 dropped by {f1_drop:.6f}, limit is {f1_tolerance:.6f}")
        reference_clean_fp = finite_metric(
            reference["clean_false_positive_rate"], "pytorch clean false-positive rate"
        )
        candidate_clean_fp = finite_metric(
            candidate["clean_false_positive_rate"],
            f"{name} clean false-positive rate",
        )
        if reference_clean_fp is not None and candidate_clean_fp is not None:
            clean_fp_increase = candidate_clean_fp - reference_clean_fp
        else:
            clean_fp_increase = None
        if clean_fp_increase is not None and clean_fp_increase - clean_fp_tolerance > epsilon:
            failures.append(
                f"{name} clean false-positive rate increased by "
                f"{clean_fp_increase:.6f}, limit is {clean_fp_tolerance:.6f}"
            )
    fp32_delta = finite_metric(
        result["parity_to_pytorch"]["onnx_fp32"]["max_abs_logit_delta"],
        "FP32 max absolute logit delta",
    )
    if fp32_delta is not None and fp32_delta - fp32_logit_limit > epsilon:
        failures.append(
            f"FP32 max absolute logit delta is {fp32_delta:.6f}, limit is {fp32_logit_limit:.6f}"
        )
    return {"passed": not failures, "failures": failures}


def token_label_scores(
    gold: list[ErrorSpan],
    predicted: list[ErrorSpan],
    offsets: list[tuple[int, int]],
    labels: list[str],
) -> dict[str, float | int]:
    """Compare labels over tokenizer tokens, excluding special zero-width tokens."""
    gold_ids = [0] * len(offsets)
    predicted_ids = [0] * len(offsets)
    label_to_id = {label: index for index, label in enumerate(labels)}

    def assign(spans: list[ErrorSpan], target: list[int]) -> None:
        for span in spans:
            matched = False
            for index, (start, end) in enumerate(offsets):
                if end > start and start < span.end and end > span.start:
                    target[index] = label_to_id[span.label]
                    matched = True
            if not matched and span.start == span.end:
                for index, (start, end) in enumerate(offsets):
                    if start <= span.start < end:
                        target[index] = label_to_id[span.label]
                        break

    assign(gold, gold_ids)
    assign(predicted, predicted_ids)
    active = [index for index, (_, end) in enumerate(offsets) if end > 0]
    tp = sum(gold_ids[index] == predicted_ids[index] and gold_ids[index] != 0 for index in active)
    fp = sum(
        predicted_ids[index] != 0 and predicted_ids[index] != gold_ids[index] for index in active
    )
    fn = sum(gold_ids[index] != 0 and gold_ids[index] != predicted_ids[index] for index in active)
    correct = sum(gold_ids[index] == predicted_ids[index] for index in active)
    return {
        **scores({"tp": tp, "fp": fp, "fn": fn}),
        "accuracy": correct / len(active) if active else 1.0,
        "correct": correct,
        "total": len(active),
    }


def spans_from_logits(
    logits: np.ndarray,
    offsets: list[tuple[int, int]],
    labels: list[str],
    threshold: float,
) -> list[ErrorSpan]:
    logits = np.asarray(logits)
    logits = logits - np.max(logits, axis=-1, keepdims=True)
    probabilities = np.exp(logits)
    probabilities /= np.sum(probabilities, axis=-1, keepdims=True)
    spans: list[ErrorSpan] = []
    for _index, ((start, end), row) in enumerate(zip(offsets, probabilities, strict=True)):
        if end <= start:
            continue
        label_id = int(np.argmax(row))
        confidence = float(row[label_id])
        if label_id != 0 and confidence >= threshold:
            spans.append(ErrorSpan(start, end, labels[label_id], confidence))
    merged: list[ErrorSpan] = []
    for span in spans:
        if merged and merged[-1].label == span.label and merged[-1].end == span.start:
            previous = merged[-1]
            merged[-1] = ErrorSpan(
                previous.start, span.end, span.label, min(previous.confidence, span.confidence)
            )
        else:
            merged.append(span)
    return merged


class LogitRunner(Protocol):
    name: str

    def logits(self, text: str) -> tuple[np.ndarray, list[tuple[int, int]]]: ...


class _TokenizerMixin:
    def _tokenize(self, text: str):
        encoded = self.tokenizer(
            text,
            return_offsets_mapping=True,
            return_tensors="np",
            truncation=True,
            max_length=self.max_length,
        )
        offsets = [tuple(pair) for pair in encoded.pop("offset_mapping")[0].tolist()]
        return encoded, offsets


class TorchRunner(_TokenizerMixin):
    name = "pytorch"

    def __init__(self, model_dir: Path):
        import torch
        from transformers import AutoModelForTokenClassification, AutoTokenizer

        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(model_dir), local_files_only=True, use_fast=True
        )
        self.model = AutoModelForTokenClassification.from_pretrained(
            str(model_dir), local_files_only=True
        )
        self.model.eval()
        self.max_length = load_model_metadata(model_dir).max_position_embeddings

    def logits(self, text: str) -> tuple[np.ndarray, list[tuple[int, int]]]:
        encoded, offsets = self._tokenize(text)
        # The tokenizer returns NumPy for the shared interface; reference model needs tensors.
        inputs = {key: self.torch.from_numpy(value) for key, value in encoded.items()}
        with self.torch.inference_mode():
            logits = self.model(**inputs).logits[0].cpu().numpy()
        return logits, offsets


class OnnxRunner(_TokenizerMixin):
    def __init__(self, path: Path, model_dir: Path):
        import onnxruntime as ort
        from transformers import AutoTokenizer

        self.name = {
            "model.onnx": "onnx_fp32",
            "model_quantized.onnx": "onnx_quint8",
            "model_fp16.onnx": "onnx_fp16",
        }.get(path.name, path.stem)
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(model_dir), local_files_only=True, use_fast=True
        )
        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.max_length = load_model_metadata(model_dir).max_position_embeddings

    def logits(self, text: str) -> tuple[np.ndarray, list[tuple[int, int]]]:
        encoded, offsets = self._tokenize(text)
        names = {item.name for item in self.session.get_inputs()}
        feed = {name: encoded[name] for name in names if name in encoded}
        return self.session.run(["logits"], feed)[0][0], offsets


def _load_dataset(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items")
    if not isinstance(items, list) or len(items) < 40:
        raise ValueError("synthetic evaluation requires at least 40 items")
    return items


def evaluate(
    dataset_path: Path,
    model_dir: Path,
    converted_dir: Path,
    thresholds: tuple[float, ...] = (0.5, 0.8, 0.95),
) -> dict[str, Any]:
    metadata = load_model_metadata(model_dir)
    items = _load_dataset(dataset_path)
    runners: list[LogitRunner] = [
        TorchRunner(model_dir),
        OnnxRunner(converted_dir / "onnx" / "model.onnx", converted_dir),
        OnnxRunner(converted_dir / "onnx" / "model_quantized.onnx", converted_dir),
        OnnxRunner(converted_dir / "onnx" / "model_fp16.onnx", converted_dir),
    ]
    outputs: dict[str, list[tuple[np.ndarray, list[tuple[int, int]]]]] = {}
    for runner in runners:
        outputs[runner.name] = [runner.logits(item["text"]) for item in items]

    reference_outputs = outputs["pytorch"]
    parity: dict[str, dict[str, float]] = {}
    for runner in runners[1:]:
        deltas: list[np.ndarray] = []
        argmax_matches: list[bool] = []
        for (reference, _), (candidate, _) in zip(
            reference_outputs, outputs[runner.name], strict=True
        ):
            deltas.append(np.abs(reference - candidate))
            argmax_matches.extend(
                (np.argmax(reference, axis=-1) == np.argmax(candidate, axis=-1)).tolist()
            )
        delta = np.concatenate([value.reshape(-1) for value in deltas])
        parity[runner.name] = {
            "max_abs_logit_delta": float(np.max(delta)),
            "mean_abs_logit_delta": float(np.mean(delta)),
            "token_argmax_agreement": float(np.mean(argmax_matches)),
        }

    result: dict[str, Any] = {
        "model_id": MODEL_ID,
        "revision": EXPECTED_REVISION,
        "dataset": dataset_path.as_posix(),
        "items": len(items),
        "clean_items": sum(not item["errors"] for item in items),
        "typo_items": sum(bool(item["errors"]) for item in items),
        "parity_to_pytorch": parity,
        "thresholds": {},
    }
    for threshold in thresholds:
        threshold_key = str(threshold)
        result["thresholds"][threshold_key] = {}
        for runner in runners:
            span_pairs: list[SpanPair] = []
            clean_false_positive = 0
            started = time.perf_counter()
            for item, (logits, offsets) in zip(items, outputs[runner.name], strict=True):
                predicted = spans_from_logits(logits, offsets, list(metadata.labels), threshold)
                gold = [
                    ErrorSpan(error["start"], error["end"], error["label"])
                    for error in item["errors"]
                ]
                span_pairs.append((gold, predicted))
                if not gold and predicted:
                    clean_false_positive += 1
            elapsed = time.perf_counter() - started
            label_result = aggregate_label_scores(span_pairs, metadata.labels[1:])
            token_counts = {"tp": 0, "fp": 0, "fn": 0, "correct": 0, "total": 0}
            for item, (logits, offsets) in zip(items, outputs[runner.name], strict=True):
                gold = [
                    ErrorSpan(error["start"], error["end"], error["label"])
                    for error in item["errors"]
                ]
                predicted = spans_from_logits(logits, offsets, list(metadata.labels), threshold)
                token = token_label_scores(gold, predicted, offsets, list(metadata.labels))
                for field in ("tp", "fp", "fn", "correct"):
                    token_counts[field] += int(token[field])
                token_counts["total"] += sum(end > start for start, end in offsets)
            token_result = scores(
                {"tp": token_counts["tp"], "fp": token_counts["fp"], "fn": token_counts["fn"]}
            )
            token_result["accuracy"] = (
                token_counts["correct"] / token_counts["total"] if token_counts["total"] else 1.0
            )
            result["thresholds"][threshold_key][runner.name] = {
                "span": aggregate_span_scores(span_pairs),
                "label_wise": label_result,
                "token": token_result,
                "clean_false_positive_items": clean_false_positive,
                "clean_false_positive_rate": clean_false_positive / result["clean_items"],
                "elapsed_seconds": elapsed,
            }
    return result


def main() -> int:
    import argparse

    from scripts.model_pipeline import CONVERTED_ROOT, UPSTREAM_ROOT

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset", type=Path, default=Path("benchmarks/datasets/synthetic-v1.json")
    )
    parser.add_argument(
        "--output", type=Path, default=Path("artifacts/benchmarks/synthetic-v1.json")
    )
    parser.add_argument(
        "--check-conversion",
        action="store_true",
        help="fail if bounded conversion regression gates are exceeded",
    )
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = evaluate(args.dataset, UPSTREAM_ROOT, CONVERTED_ROOT)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(args.output)
    if args.check_conversion:
        gate = check_conversion(payload)
        print(json.dumps(gate, ensure_ascii=False))
        return 0 if gate["passed"] else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
