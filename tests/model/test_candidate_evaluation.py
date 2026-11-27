from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

import scripts.evaluate_candidate as candidate_cli
from scripts.evaluate_candidate import (
    BASELINE_RUNNER_SHA256,
    BASELINE_SOURCE_COMMIT,
    CandidateEvaluationError,
    _validate_event_metrics,
    evaluate_candidate,
)
from scripts.model_pipeline import EXPECTED_REVISION, ROOT

LABELS = ["OK", "substitution"]


@pytest.mark.parametrize(
    ("metrics", "expected"),
    [
        ({"tp": 1, "fp": 0, "fn": 0, "precision": 1.0, "recall": 1.0, "f1": 1.0}, None),
        ({"tp": 1, "fp": 1, "fn": 1, "precision": 0.5, "recall": 0.5, "f1": 0.5}, None),
        ({"tp": 1, "fp": 0, "fn": 0, "precision": 1.0, "recall": 1.0, "f1": 0.5}, "disagrees"),
        (
            {"tp": 1, "fp": 0, "fn": 0, "precision": 1.0, "recall": 1.0, "f1": float("nan")},
            "nonfinite",
        ),
        ({"tp": True, "fp": 0, "fn": 0, "precision": 1.0, "recall": 1.0, "f1": 1.0}, "counts"),
    ],
)
def test_event_metric_validation(metrics: dict, expected: str | None):
    if expected is None:
        _validate_event_metrics(metrics, "toy")
    else:
        with pytest.raises(CandidateEvaluationError, match=expected):
            _validate_event_metrics(metrics, "toy")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class _ToyRunner:
    def logits(self, text: str):
        if text == "clean":
            return np.asarray([[4.0, 0.0]], dtype=np.float64), [(0, 5)]
        return np.asarray([[0.0, 4.0]], dtype=np.float64), [(0, 3)]


@pytest.fixture
def candidate_inputs(tmp_path: Path) -> dict[str, Path]:
    dataset = {
        "schema_version": "jwtd-v1",
        "metadata": {"source_split": "train"},
        "items": [
            {"id": "clean-1", "text": "clean", "errors": []},
            {
                "id": "typo-1",
                "text": "bad",
                "errors": [{"start": 0, "end": 3, "label": "substitution"}],
            },
        ],
    }
    dataset_path = tmp_path / "development.json"
    dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
    dataset_manifest = {
        "model_revision": EXPECTED_REVISION,
        "labels": LABELS,
        "outputs": {
            dataset_path.name: {
                "sha256": _sha256(dataset_path),
                "bytes": dataset_path.stat().st_size,
            }
        },
    }
    dataset_manifest_path = tmp_path / "manifest.json"
    dataset_manifest_path.write_text(json.dumps(dataset_manifest), encoding="utf-8")
    protocol_path = tmp_path / "protocol.json"
    protocol_path.write_text('{"schema":"frozen"}\n', encoding="utf-8")

    model_dir = tmp_path / "candidate"
    model_dir.mkdir()
    config = {
        "id2label": {"0": "OK", "1": "substitution"},
        "label2id": {"OK": 0, "substitution": 1},
    }
    config_path = model_dir / "config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    tokenizer_path = model_dir / "tokenizer.json"
    tokenizer_path.write_bytes(b"toy-tokenizer")
    tokenizer_config_path = model_dir / "tokenizer_config.json"
    tokenizer_config_path.write_text("{}\n", encoding="utf-8")
    model_path = model_dir / "model_weight_only.onnx"
    model_path.write_bytes(b"toy-onnx")
    candidate_manifest = {
        "revision": EXPECTED_REVISION,
        "model_kind": "toy-weight-only-qdq",
        "files": {
            "model_weight_only.onnx": {"sha256": _sha256(model_path)},
            "config.json": {"sha256": _sha256(config_path)},
            "tokenizer.json": {"sha256": _sha256(tokenizer_path)},
            "tokenizer_config.json": {"sha256": _sha256(tokenizer_config_path)},
        },
    }
    candidate_manifest_path = tmp_path / "candidate-manifest.json"
    candidate_manifest_path.write_text(json.dumps(candidate_manifest), encoding="utf-8")

    baseline = {
        "source_commit": BASELINE_SOURCE_COMMIT,
        "model_revision": EXPECTED_REVISION,
        "phase": "development",
        "dataset_sha256": _sha256(dataset_path),
        "dataset_manifest_sha256": _sha256(dataset_manifest_path),
        "protocol_sha256": _sha256(protocol_path),
        "models": {
            "pytorch": {
                "0.5": {
                    "clean_rate": 0.0,
                    "event": {
                        "tp": 1,
                        "fp": 0,
                        "fn": 0,
                        "precision": 1.0,
                        "recall": 1.0,
                        "f1": 1.0,
                    },
                }
            }
        },
        "cache": {
            "pytorch": {
                "inputs": {
                    "runner_sha256": BASELINE_RUNNER_SHA256,
                    "scorer_sha256": _sha256(ROOT / "scripts" / "corpus_evaluation.py"),
                    "evaluation_sha256": _sha256(ROOT / "scripts" / "evaluation.py"),
                    "model_config_sha256": _sha256(config_path),
                    "tokenizer_sha256": _sha256(tokenizer_path),
                    "tokenizer_config_sha256": _sha256(tokenizer_config_path),
                }
            }
        },
    }
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    return {
        "dataset": dataset_path,
        "dataset_manifest": dataset_manifest_path,
        "protocol": protocol_path,
        "baseline": baseline_path,
        "model": model_path,
        "manifest": candidate_manifest_path,
        "model_dir": model_dir,
    }


def _run(inputs: dict[str, Path], output: Path):
    return evaluate_candidate(
        inputs["dataset"],
        inputs["dataset_manifest"],
        inputs["protocol"],
        inputs["baseline"],
        inputs["model"],
        inputs["manifest"],
        inputs["model_dir"],
        output,
        runner_factory=lambda *_args: _ToyRunner(),
        source_commit="current-test-commit",
    )


def test_candidate_evaluation_uses_fresh_logits_and_numeric_report(
    candidate_inputs: dict[str, Path], tmp_path: Path
):
    output = tmp_path / "candidate-evaluation"
    report = _run(candidate_inputs, output)

    assert report["phase"] == "development"
    assert report["candidate"]["metrics"]["event"]["f1"] == 1.0
    assert report["candidate"]["metrics"]["clean_false_positive_items"] == 0
    assert {path.name for path in output.iterdir()} == {
        "candidate-cache.json",
        "candidate-evaluation.json",
        "candidate-logits.npz",
    }
    serialized = json.dumps(report) + (output / "candidate-cache.json").read_text()
    assert "clean-1" not in serialized
    assert "bad" not in serialized
    with np.load(output / "candidate-logits.npz", allow_pickle=False) as arrays:
        assert arrays["logits"].shape == (2, 2)
        assert arrays["offsets"].shape == (2, 2)


def test_nonempty_output_and_held_out_inputs_are_rejected(
    candidate_inputs: dict[str, Path], tmp_path: Path
):
    output = tmp_path / "existing"
    output.mkdir()
    (output / "sentinel").write_text("do not overwrite", encoding="utf-8")
    with pytest.raises(CandidateEvaluationError, match="new empty directory"):
        _run(candidate_inputs, output)

    dataset = json.loads(candidate_inputs["dataset"].read_text(encoding="utf-8"))
    dataset["metadata"]["source_split"] = "test"
    candidate_inputs["dataset"].write_text(json.dumps(dataset), encoding="utf-8")
    with pytest.raises(CandidateEvaluationError, match="train split"):
        _run(candidate_inputs, tmp_path / "held-out")


def test_existing_empty_output_is_reused_without_overwrite(
    candidate_inputs: dict[str, Path], tmp_path: Path
):
    output = tmp_path / "precreated"
    output.mkdir()
    report = _run(candidate_inputs, output)
    assert report["candidate"]["model_kind"] == "toy-weight-only-qdq"
    assert (output / "candidate-evaluation.json").is_file()


def test_baseline_provenance_mismatch_is_rejected(
    candidate_inputs: dict[str, Path], tmp_path: Path
):
    baseline = json.loads(candidate_inputs["baseline"].read_text(encoding="utf-8"))
    baseline["source_commit"] = "different-source"
    candidate_inputs["baseline"].write_text(json.dumps(baseline), encoding="utf-8")
    with pytest.raises(CandidateEvaluationError, match="frozen development run"):
        _run(candidate_inputs, tmp_path / "mismatch")


def test_baseline_runner_hash_is_checked_against_frozen_source(
    candidate_inputs: dict[str, Path], tmp_path: Path
):
    baseline = json.loads(candidate_inputs["baseline"].read_text(encoding="utf-8"))
    baseline["cache"]["pytorch"]["inputs"]["runner_sha256"] = "f" * 64
    candidate_inputs["baseline"].write_text(json.dumps(baseline), encoding="utf-8")
    with pytest.raises(CandidateEvaluationError, match="frozen source"):
        _run(candidate_inputs, tmp_path / "runner-mismatch")


def test_frozen_runner_snapshot_does_not_require_git_history(
    candidate_inputs: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    def no_git(*_args, **_kwargs):
        raise FileNotFoundError("git unavailable in archive")

    monkeypatch.setattr(candidate_cli.subprocess, "check_output", no_git)
    report = _run(candidate_inputs, tmp_path / "no-git")
    assert (
        report["provenance"]["runner_compatibility"]["baseline_runner_sha256"]
        == BASELINE_RUNNER_SHA256
    )


def test_frozen_runner_snapshot_missing_or_modified_is_rejected(
    candidate_inputs: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    snapshot = tmp_path / "frozen.txt"
    metadata = tmp_path / "frozen.json"
    source_bytes = candidate_cli.FROZEN_RUNNER_SNAPSHOT.read_bytes()
    snapshot.write_bytes(source_bytes + b"tampered")
    metadata.write_bytes(candidate_cli.FROZEN_RUNNER_METADATA.read_bytes())
    monkeypatch.setattr(candidate_cli, "FROZEN_RUNNER_SNAPSHOT", snapshot)
    monkeypatch.setattr(candidate_cli, "FROZEN_RUNNER_METADATA", metadata)
    with pytest.raises(CandidateEvaluationError, match="snapshot hash mismatch"):
        _run(candidate_inputs, tmp_path / "tampered")

    snapshot.unlink()
    with pytest.raises(CandidateEvaluationError, match="snapshot is missing"):
        _run(candidate_inputs, tmp_path / "missing")

    snapshot.write_bytes(source_bytes)
    metadata.write_text("[]", encoding="utf-8")
    with pytest.raises(CandidateEvaluationError, match="metadata is invalid"):
        _run(candidate_inputs, tmp_path / "invalid-metadata")


def test_cli_help_and_threshold_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    monkeypatch.setattr(candidate_cli.sys, "argv", ["evaluate_candidate.py", "--help"])
    with pytest.raises(SystemExit) as help_exit:
        candidate_cli.main()
    assert help_exit.value.code == 0
    assert "--candidate-model" in capsys.readouterr().out

    monkeypatch.setattr(
        candidate_cli.sys,
        "argv",
        [
            "evaluate_candidate.py",
            "--dataset",
            "dataset",
            "--dataset-manifest",
            "manifest",
            "--protocol",
            "protocol",
            "--baseline-evaluation",
            "baseline",
            "--candidate-model",
            "model",
            "--candidate-manifest",
            "candidate-manifest",
            "--candidate-model-dir",
            "model-dir",
            "--output",
            "output",
            "--threshold",
            "0.8",
        ],
    )
    with pytest.raises(SystemExit) as threshold_exit:
        candidate_cli.main()
    assert threshold_exit.value.code == 2
    assert "fixes threshold at 0.5" in capsys.readouterr().err
