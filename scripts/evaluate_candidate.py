"""Evaluate one candidate ONNX model on the frozen development split.

This command deliberately evaluates only the training-exposed development
fixture. It binds every input to the frozen dataset, protocol, scorer, and
baseline evaluation before running a fresh one-thread CPU ORT session. Corpus
text and tokenizer IDs are never written to reports or cache sidecars.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
from tokenizers import Tokenizer

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.corpus_evaluation import accuracy_gate
from scripts.model_pipeline import EXPECTED_REVISION, ROOT
from scripts.run_corpus_evaluation import evaluate_outputs

THRESHOLD = 0.5
MAX_SEQUENCE_LENGTH = 8192
BASELINE_SOURCE_COMMIT = "af8cd9480431052da280bc0e536f8ae5f65eeb62"
BASELINE_RUNNER_SHA256 = "304082a891f049473c26a5d383b066e2135eb9bab23f3bc919da4df0ffe1e7da"
FROZEN_RUNNER_SNAPSHOT = ROOT / "benchmarks" / "protocols" / "frozen-evaluator-v1.txt"
FROZEN_RUNNER_METADATA = ROOT / "benchmarks" / "protocols" / "frozen-evaluator-v1.json"


class CandidateEvaluationError(ValueError):
    """The candidate evaluation inputs are not safely bound."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _frozen_runner_source() -> bytes:
    if not FROZEN_RUNNER_SNAPSHOT.is_file() or not FROZEN_RUNNER_METADATA.is_file():
        raise CandidateEvaluationError("frozen evaluator snapshot is missing")
    try:
        metadata = json.loads(FROZEN_RUNNER_METADATA.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CandidateEvaluationError("frozen evaluator metadata is invalid") from error
    if not isinstance(metadata, dict) or metadata.get("schema_version") != "frozen-evaluator-v1":
        raise CandidateEvaluationError("frozen evaluator metadata is invalid")
    if (
        metadata.get("origin_commit") != BASELINE_SOURCE_COMMIT
        or metadata.get("origin_path") != "scripts/run_corpus_evaluation.py"
        or metadata.get("license") != "MIT"
        or metadata.get("sha256") != BASELINE_RUNNER_SHA256
    ):
        raise CandidateEvaluationError("frozen evaluator metadata does not match baseline")
    try:
        source = FROZEN_RUNNER_SNAPSHOT.read_bytes()
    except OSError as error:
        raise CandidateEvaluationError("frozen evaluator snapshot cannot be read") from error
    if (
        len(source) != metadata.get("bytes")
        or hashlib.sha256(source).hexdigest() != BASELINE_RUNNER_SHA256
    ):
        raise CandidateEvaluationError("frozen evaluator snapshot hash mismatch")
    return source


def _function_semantic_hash(source: bytes, names: tuple[str, ...]) -> dict[str, str]:
    try:
        tree = ast.parse(source.decode("utf-8"))
    except (UnicodeDecodeError, SyntaxError) as error:
        raise CandidateEvaluationError(
            "frozen evaluator source is not valid UTF-8 Python"
        ) from error
    functions = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    result: dict[str, str] = {}
    for name in names:
        node = functions.get(name)
        if node is None:
            raise CandidateEvaluationError(f"evaluator function is missing: {name}")
        semantic = ast.dump(node, annotate_fields=True, include_attributes=False).encode("utf-8")
        result[name] = hashlib.sha256(semantic).hexdigest()
    return result


def _validate_runner_compatibility(
    baseline_inputs: dict[str, Any], evaluation_path: Path
) -> dict[str, Any]:
    frozen_source = _frozen_runner_source()
    frozen_sha = hashlib.sha256(frozen_source).hexdigest()
    if baseline_inputs.get("runner_sha256") != frozen_sha:
        raise CandidateEvaluationError("baseline runner hash does not match frozen source")
    current_source = evaluation_path.read_bytes()
    frozen_semantic = _function_semantic_hash(
        frozen_source, ("validate_output", "evaluate_outputs")
    )
    current_semantic = _function_semantic_hash(
        current_source, ("validate_output", "evaluate_outputs")
    )
    if current_semantic != frozen_semantic:
        raise CandidateEvaluationError(
            "current evaluator scoring functions differ from frozen baseline"
        )
    return {
        "baseline_runner_sha256": frozen_sha,
        "current_runner_sha256": sha256_file(evaluation_path),
        "semantic_sha256": current_semantic,
    }


def _validate_event_metrics(metrics: dict[str, Any], description: str) -> None:
    counts = (metrics.get("tp"), metrics.get("fp"), metrics.get("fn"))
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counts):
        raise CandidateEvaluationError(f"{description} event counts are invalid")
    tp, fp, fn = counts
    expected = {
        "precision": tp / (tp + fp) if tp + fp else 0.0,
        "recall": tp / (tp + fn) if tp + fn else 0.0,
    }
    denominator = expected["precision"] + expected["recall"]
    expected["f1"] = (
        2 * expected["precision"] * expected["recall"] / denominator if denominator else 0.0
    )
    for name, value in expected.items():
        actual = metrics.get(name)
        if (
            not isinstance(actual, (int, float))
            or not math.isfinite(actual)
            or not 0 <= actual <= 1
        ):
            raise CandidateEvaluationError(f"{description} {name} is missing or nonfinite")
        if not math.isclose(float(actual), value, rel_tol=1e-9, abs_tol=1e-12):
            raise CandidateEvaluationError(f"{description} {name} disagrees with event counts")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CandidateEvaluationError(f"invalid JSON input: {path.name}") from error
    if not isinstance(payload, dict):
        raise CandidateEvaluationError(f"JSON input must be an object: {path.name}")
    return payload


def _inventory_entries(manifest: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    entries: list[tuple[str, dict[str, Any]]] = []
    for key in ("files", "artifacts"):
        inventory = manifest.get(key)
        if not isinstance(inventory, dict):
            continue
        entries.extend(
            (str(relative), value)
            for relative, value in inventory.items()
            if isinstance(value, dict) and isinstance(value.get("sha256"), str)
        )
    return entries


def _declared_hash(entries: list[tuple[str, dict[str, Any]]], basename: str) -> str:
    values = {value["sha256"] for relative, value in entries if Path(relative).name == basename}
    if len(values) != 1:
        raise CandidateEvaluationError(
            f"candidate manifest hash is missing or ambiguous: {basename}"
        )
    return values.pop()


def _labels_from_config(config_path: Path) -> tuple[str, ...]:
    config = _read_json(config_path)
    id2label = config.get("id2label")
    if not isinstance(id2label, dict) or not id2label:
        raise CandidateEvaluationError("candidate config lacks id2label")
    try:
        labels = tuple(str(id2label[str(index)]) for index in range(len(id2label)))
    except (KeyError, TypeError) as error:
        raise CandidateEvaluationError("candidate config labels are not contiguous") from error
    label2id = config.get("label2id")
    if not isinstance(label2id, dict) or any(
        str(label2id.get(label)) != str(index) for index, label in enumerate(labels)
    ):
        raise CandidateEvaluationError("candidate config label maps disagree")
    if labels[0] != "OK" or len(set(labels)) != len(labels):
        raise CandidateEvaluationError("candidate config labels are invalid")
    return labels


def _validate_output_directory(output: Path) -> None:
    if output.exists() and (output.is_file() or any(output.iterdir())):
        raise CandidateEvaluationError("candidate evaluation output must be a new empty directory")


def _require_file(path: Path, description: str) -> None:
    if not path.is_file():
        raise CandidateEvaluationError(f"{description} file not found: {path}")


def _validate_inputs(
    dataset_path: Path,
    dataset_manifest_path: Path,
    protocol_path: Path,
    baseline_path: Path,
    candidate_model_path: Path,
    candidate_manifest_path: Path,
    candidate_model_dir: Path,
    output_path: Path,
) -> dict[str, Any]:
    _validate_output_directory(output_path)
    for path, description in (
        (dataset_path, "development dataset"),
        (dataset_manifest_path, "dataset manifest"),
        (protocol_path, "evaluation protocol"),
        (baseline_path, "baseline evaluation"),
        (candidate_model_path, "candidate model"),
        (candidate_manifest_path, "candidate manifest"),
    ):
        _require_file(path, description)
    if not candidate_model_dir.is_dir():
        raise CandidateEvaluationError(
            f"candidate model directory not found: {candidate_model_dir}"
        )
    dataset = _read_json(dataset_path)
    dataset_manifest = _read_json(dataset_manifest_path)
    protocol_sha = sha256_file(protocol_path)
    baseline = _read_json(baseline_path)
    items = dataset.get("items")
    if not isinstance(items, list) or not items:
        raise CandidateEvaluationError("development dataset is empty")
    if dataset.get("metadata", {}).get("source_split") != "train":
        raise CandidateEvaluationError("candidate evaluation accepts development train split only")
    expected_output = dataset_manifest.get("outputs", {}).get(dataset_path.name, {})
    if (
        expected_output.get("sha256") != sha256_file(dataset_path)
        or expected_output.get("bytes") != dataset_path.stat().st_size
    ):
        raise CandidateEvaluationError("development dataset hash/size does not match manifest")
    if dataset_manifest.get("model_revision") != EXPECTED_REVISION:
        raise CandidateEvaluationError("development dataset revision mismatch")
    labels = tuple(dataset_manifest.get("labels", ()))
    if not labels or labels[0] != "OK":
        raise CandidateEvaluationError("development dataset labels are invalid")
    if baseline.get("phase") != "development":
        raise CandidateEvaluationError("baseline evaluation is not development phase")
    dataset_sha = sha256_file(dataset_path)
    dataset_manifest_sha = sha256_file(dataset_manifest_path)
    if (
        baseline.get("dataset_sha256") != dataset_sha
        or baseline.get("dataset_manifest_sha256") != dataset_manifest_sha
        or baseline.get("protocol_sha256") != protocol_sha
        or baseline.get("model_revision") != EXPECTED_REVISION
    ):
        raise CandidateEvaluationError("baseline evaluation provenance mismatch")
    source_commit_value = baseline.get("source_commit")
    if (
        not isinstance(source_commit_value, str)
        or re.fullmatch(r"[0-9a-f]{40}", source_commit_value) is None
        or source_commit_value != BASELINE_SOURCE_COMMIT
    ):
        raise CandidateEvaluationError("baseline source commit is not the frozen development run")
    baseline_threshold = baseline.get("models", {}).get("pytorch", {}).get("0.5")
    if not isinstance(baseline_threshold, dict) or not isinstance(
        baseline_threshold.get("event"), dict
    ):
        raise CandidateEvaluationError("baseline PyTorch threshold 0.5 metrics are missing")
    _validate_event_metrics(baseline_threshold["event"], "baseline")
    baseline_inputs = baseline.get("cache", {}).get("pytorch", {}).get("inputs")
    if not isinstance(baseline_inputs, dict):
        raise CandidateEvaluationError("baseline PyTorch cache provenance is missing")
    scorer_path = ROOT / "scripts" / "corpus_evaluation.py"
    evaluator_path = ROOT / "scripts" / "run_corpus_evaluation.py"
    scoring_path = ROOT / "scripts" / "evaluation.py"
    if baseline_inputs.get("scorer_sha256") != sha256_file(scorer_path):
        raise CandidateEvaluationError("baseline scorer hash does not match current scorer")
    if baseline_inputs.get("evaluation_sha256") != sha256_file(scoring_path):
        raise CandidateEvaluationError(
            "baseline evaluation dependency hash does not match current source"
        )
    runner_compatibility = _validate_runner_compatibility(baseline_inputs, evaluator_path)
    candidate_manifest = _read_json(candidate_manifest_path)
    entries = _inventory_entries(candidate_manifest)
    if not entries:
        raise CandidateEvaluationError("candidate manifest lacks files or artifacts")
    if candidate_manifest.get("revision") != EXPECTED_REVISION:
        raise CandidateEvaluationError("candidate model revision mismatch")
    candidate_sha = sha256_file(candidate_model_path)
    model_hashes = {
        value["sha256"]
        for relative, value in entries
        if Path(relative).name == candidate_model_path.name
    }
    if candidate_sha not in model_hashes:
        raise CandidateEvaluationError("candidate model hash does not match manifest")
    config_path = candidate_model_dir / "config.json"
    tokenizer_path = candidate_model_dir / "tokenizer.json"
    tokenizer_config_path = candidate_model_dir / "tokenizer_config.json"
    candidate_text_paths = {
        "config.json": config_path,
        "tokenizer.json": tokenizer_path,
        "tokenizer_config.json": tokenizer_config_path,
    }
    baseline_text_keys = {
        "config.json": "model_config_sha256",
        "tokenizer.json": "tokenizer_sha256",
        "tokenizer_config.json": "tokenizer_config_sha256",
    }
    for basename, path in candidate_text_paths.items():
        _require_file(path, f"candidate {basename}")
        actual = sha256_file(path)
        if actual != baseline_inputs.get(baseline_text_keys[basename]):
            raise CandidateEvaluationError(
                f"candidate {basename} does not match baseline tokenizer/config"
            )
        if actual != _declared_hash(entries, basename):
            raise CandidateEvaluationError(f"candidate {basename} hash does not match manifest")
    candidate_labels = _labels_from_config(config_path)
    if candidate_labels != labels:
        raise CandidateEvaluationError("candidate labels do not match development manifest")
    return {
        "dataset": dataset,
        "labels": labels,
        "baseline": baseline,
        "baseline_inputs": baseline_inputs,
        "candidate_manifest": candidate_manifest,
        "candidate_sha256": candidate_sha,
        "candidate_model_dir": candidate_model_dir,
        "candidate_config": config_path,
        "candidate_tokenizer": tokenizer_path,
        "dataset_sha256": dataset_sha,
        "dataset_manifest_sha256": dataset_manifest_sha,
        "protocol_sha256": protocol_sha,
        "runner_compatibility": runner_compatibility,
    }


class CandidateOnnxRunner:
    """Rust-tokenizer + one-thread CPU ORT runner with no silent truncation."""

    def __init__(self, model_path: Path, model_dir: Path, labels: tuple[str, ...]):
        import onnxruntime as ort

        self.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        # Candidate evaluation must observe the raw token count.  A tokenizer
        # JSON carrying a stale truncation/padding policy must never silently
        # change the inputs used for the frozen development comparison.
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        self.session = ort.InferenceSession(
            str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.ort_version = str(ort.__version__)
        self.labels = labels
        self.input_names = [str(value.name) for value in self.session.get_inputs()]
        self.output_names = [str(value.name) for value in self.session.get_outputs()]
        if not self.input_names or not self.output_names:
            raise CandidateEvaluationError("candidate ONNX session has no inputs or outputs")

    def logits(self, text: str) -> tuple[np.ndarray, list[tuple[int, int]]]:
        encoded = self.tokenizer.encode(text)
        if len(encoded.ids) > MAX_SEQUENCE_LENGTH:
            raise CandidateEvaluationError("candidate tokenizer input exceeds 8192 tokens")
        input_ids = np.asarray(encoded.ids, dtype=np.int64)
        attention_mask = np.asarray(encoded.attention_mask, dtype=np.int64)
        feeds: dict[str, np.ndarray] = {}
        for name in self.input_names:
            if name == "input_ids":
                feeds[name] = input_ids[None, :]
            elif name == "attention_mask":
                feeds[name] = attention_mask[None, :]
            elif name == "token_type_ids":
                feeds[name] = np.zeros_like(input_ids)[None, :]
            else:
                raise CandidateEvaluationError(f"candidate model has unsupported input: {name}")
        actual = np.asarray(self.session.run([self.output_names[0]], feeds)[0])
        if actual.shape != (1, len(encoded.ids), len(self.labels)) or not np.isfinite(actual).all():
            raise CandidateEvaluationError("candidate output shape or values are invalid")
        offsets = [tuple(map(int, pair)) for pair in encoded.offsets]
        return actual[0].astype(np.float64, copy=False), offsets


def evaluate_candidate(
    dataset_path: Path,
    dataset_manifest_path: Path,
    protocol_path: Path,
    baseline_path: Path,
    candidate_model_path: Path,
    candidate_manifest_path: Path,
    candidate_model_dir: Path,
    output_path: Path,
    *,
    runner_factory: Callable[[Path, Path, tuple[str, ...]], Any] | None = None,
    source_commit: str | None = None,
) -> dict[str, Any]:
    context = _validate_inputs(
        dataset_path,
        dataset_manifest_path,
        protocol_path,
        baseline_path,
        candidate_model_path,
        candidate_manifest_path,
        candidate_model_dir,
        output_path,
    )
    # Validation allows an existing empty directory so callers can pre-create
    # an ignored artifact root.  Keep the non-empty overwrite guard above, then
    # reuse that empty directory for this fresh run.
    output_path.mkdir(parents=True, exist_ok=True)
    items = context["dataset"]["items"]
    labels = context["labels"]
    runner = (
        runner_factory(candidate_model_path, candidate_model_dir, labels)
        if runner_factory is not None
        else CandidateOnnxRunner(candidate_model_path, candidate_model_dir, labels)
    )
    outputs = [runner.logits(item["text"]) for item in items]
    metrics = evaluate_outputs(items, outputs, labels, THRESHOLD)
    _validate_event_metrics(metrics["event"], "candidate")
    cache_path = output_path / "candidate-logits.npz"
    bounds = np.cumsum([0, *[len(offsets) for _, offsets in outputs]])
    np.savez_compressed(
        cache_path,
        logits=np.concatenate([value for value, _ in outputs]),
        offsets=np.concatenate([np.asarray(offsets, dtype=np.int64) for _, offsets in outputs]),
        bounds=bounds,
    )
    candidate_runner_sha = sha256_file(Path(__file__))
    current_commit = source_commit or os.environ.get("SOURCE_COMMIT") or "unknown"
    if source_commit is None and not os.environ.get("SOURCE_COMMIT"):
        try:
            current_commit = subprocess.check_output(
                ["git", "-c", f"safe.directory={ROOT.as_posix()}", "rev-parse", "HEAD"],
                text=True,
            ).strip()
        except (OSError, subprocess.CalledProcessError):
            current_commit = "unknown"
    cache_provenance = {
        "dataset_sha256": context["dataset_sha256"],
        "dataset_manifest_sha256": context["dataset_manifest_sha256"],
        "protocol_sha256": context["protocol_sha256"],
        "candidate_model_sha256": context["candidate_sha256"],
        "candidate_manifest_sha256": sha256_file(candidate_manifest_path),
        "candidate_runner_sha256": candidate_runner_sha,
        "scorer_sha256": sha256_file(ROOT / "scripts" / "corpus_evaluation.py"),
        "model_revision": EXPECTED_REVISION,
        "threshold": THRESHOLD,
        "phase": "development",
    }
    sidecar = {
        "schema_version": "candidate-logits-cache-v1",
        "items": len(items),
        "inputs": cache_provenance,
        "cache_sha256": sha256_file(cache_path),
    }
    sidecar_path = output_path / "candidate-cache.json"
    sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
    baseline_metrics = context["baseline"]["models"]["pytorch"]["0.5"]
    acceptance = accuracy_gate(
        baseline_metrics["event"],
        metrics["event"],
        metrics["clean_false_positive_items"],
        metrics["clean_items"],
    )
    report = {
        "schema_version": "candidate-evaluation-v1",
        "phase": "development",
        "threshold": THRESHOLD,
        "dataset_sha256": context["dataset_sha256"],
        "dataset_manifest_sha256": context["dataset_manifest_sha256"],
        "protocol_sha256": context["protocol_sha256"],
        "baseline": {
            "source_commit": context["baseline"]["source_commit"],
            "model_sha256": context["baseline_inputs"].get("model_sha256"),
            "runner_sha256": context["baseline_inputs"]["runner_sha256"],
            "scorer_sha256": context["baseline_inputs"]["scorer_sha256"],
            "evaluation_sha256": context["baseline_inputs"]["evaluation_sha256"],
            "metrics": baseline_metrics,
        },
        "candidate": {
            "model_kind": context["candidate_manifest"].get("model_kind", "unknown"),
            "model_sha256": context["candidate_sha256"],
            "manifest_sha256": sha256_file(candidate_manifest_path),
            "source_commit": current_commit,
            "runner_sha256": candidate_runner_sha,
            "metrics": metrics,
        },
        "comparison": {
            "event_f1_drop": baseline_metrics["event"]["f1"] - metrics["event"]["f1"],
            "clean_rate_delta": metrics["clean_rate"] - baseline_metrics["clean_rate"],
        },
        "acceptance": acceptance,
        "provenance": {
            "source_commit": current_commit,
            "code_sha256": candidate_runner_sha,
            "candidate_runner_sha256": candidate_runner_sha,
            "scorer_sha256": cache_provenance["scorer_sha256"],
            "runner_compatibility": context["runner_compatibility"],
            "evaluation_dependency_sha256": sha256_file(ROOT / "scripts" / "evaluation.py"),
            "environment": {"python": sys.version.split()[0], "platform": sys.platform},
            "runtime": {
                "execution_provider": "CPUExecutionProvider",
                "onnxruntime": getattr(runner, "ort_version", "unknown"),
                "intra_op_num_threads": 1,
                "inter_op_num_threads": 1,
                "graph_optimization": "ORT_DISABLE_ALL",
            },
        },
        "cache": {
            "path": cache_path.name,
            "sidecar": sidecar_path.name,
            "sha256": sidecar["cache_sha256"],
        },
    }
    report_path = output_path / "candidate-evaluation.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--dataset-manifest", type=Path, required=True)
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--baseline-evaluation", type=Path, required=True)
    parser.add_argument("--candidate-model", type=Path, required=True)
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--candidate-model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=THRESHOLD)
    args = parser.parse_args()
    if args.threshold != THRESHOLD:
        parser.error("candidate evaluation fixes threshold at 0.5")
    try:
        report = evaluate_candidate(
            args.dataset,
            args.dataset_manifest,
            args.protocol,
            args.baseline_evaluation,
            args.candidate_model,
            args.candidate_manifest,
            args.candidate_model_dir,
            args.output,
        )
    except CandidateEvaluationError as error:
        parser.error(str(error))
    print(json.dumps({"output": str(args.output), "accepted": report["acceptance"]["passed"]}))
    return 0 if report["acceptance"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
