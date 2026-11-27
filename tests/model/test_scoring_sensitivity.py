"""Scoring diagnostics must reuse verified logits without changing the baseline."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import pytest

from scripts import analyze_scoring_sensitivity as diagnostic
from scripts.analyze_scoring_sensitivity import (
    SensitivityError,
    analyze_outputs,
    run_analysis,
)
from scripts.evaluate_candidate import BASELINE_RUNNER_SHA256, BASELINE_SOURCE_COMMIT
from scripts.model_pipeline import EXPECTED_REVISION, ROOT
from scripts.run_corpus_evaluation import evaluate_outputs

LABELS = ("OK", "substitution", "deletion")
MODEL_NAMES = ("pytorch", "onnx_fp32", "onnx_quint8", "onnx_fp16")


def span(start, end, label="substitution"):
    return {"start": start, "end": end, "label": label}


def row(text, errors, alternatives=None, identifier="fixture"):
    value = {"id": identifier, "text": text, "errors": errors}
    if alternatives is not None:
        value["error_alternatives"] = alternatives
    return value


def logits(ids):
    values = np.full((len(ids), len(LABELS)), -4.0)
    for index, label in enumerate(ids):
        values[index, label] = 4.0
    return values


def test_canonical_best_worst_keep_whole_reconstructions_and_frozen_diagnostics():
    canonical = [span(0, 1)]
    alternative = [span(2, 3)]
    items = [row("甲乙丙", canonical, [canonical, alternative])]
    outputs = [(logits([0, 1]), [(0, 1), (2, 3)])]
    original = copy.deepcopy(items)

    report = analyze_outputs(items, outputs, LABELS)

    assert report["modes"]["best"] == evaluate_outputs(items, outputs, LABELS, 0.5)
    assert report["modes"]["canonical"]["event"]["tp"] == 0
    assert report["modes"]["best"]["event"]["tp"] == 1
    assert report["modes"]["worst"]["event"]["tp"] == 0
    for mode in report["modes"].values():
        assert mode["raw_exact"]["tp"] == 0
        assert mode["projected_span"]["tp"] == 0
        assert mode["token"]["tp"] == 0
    assert report["ambiguous_document_ranges"] == [
        {"index": 0, "alternatives": 2, "event_tp": {"canonical": 0, "best": 1, "worst": 0}}
    ]
    assert items == original


def test_primary_metrics_never_union_events_from_incompatible_scenarios():
    first = [span(0, 1), span(2, 3)]
    second = [span(0, 1), span(4, 5)]
    items = [row("甲乙丙丁戊", first, [first, second])]
    outputs = [(logits([0, 1, 1]), [(0, 1), (2, 3), (4, 5)])]
    result = analyze_outputs(items, outputs, LABELS)
    for mode in result["modes"].values():
        assert {key: mode["event"][key] for key in ("tp", "fp", "fn")} == {
            "tp": 1,
            "fp": 1,
            "fn": 1,
        }


def test_document_identity_wrong_labels_clean_records_and_zero_width_are_preserved():
    items = [
        row("甲", [span(0, 1)], identifier="miss"),
        row("乙", [], identifier="clean"),
        row("丙", [span(0, 1)], identifier="wrong-label"),
        row("丁戊", [span(1, 1, "deletion")], identifier="gap"),
    ]
    outputs = [
        (logits([0]), [(0, 1)]),
        (logits([1]), [(0, 1)]),
        (logits([2]), [(0, 1)]),
        (logits([2, 0]), [(0, 1), (1, 2)]),
    ]
    report = analyze_outputs(items, outputs, LABELS)
    for mode in report["modes"].values():
        assert {key: mode["event"][key] for key in ("tp", "fp", "fn")} == {
            "tp": 1,
            "fp": 2,
            "fn": 2,
        }
        assert mode["raw_exact"]["tp"] == 0
        assert mode["clean_false_positive_items"] == mode["clean_items"] == 1
        assert mode["zero_width_gold_events"] == 1
        assert mode["label_wise"]["substitution"]["fn"] == 2


def test_location_selection_is_independent_but_labels_share_the_event_scenario():
    first = [span(0, 1), span(2, 3, "deletion")]
    second = [span(4, 5), span(0, 1, "deletion")]
    items = [row("甲乙丙丁戊", first, [first, second])]
    outputs = [(logits([1, 0, 2]), [(0, 1), (2, 3), (4, 5)])]
    modes = analyze_outputs(items, outputs, LABELS)["modes"]
    assert modes["best"]["event"]["tp"] == 1
    assert modes["best"]["location"]["tp"] == 2
    assert modes["worst"]["event"]["tp"] == 0
    assert modes["worst"]["location"]["tp"] == 1
    assert modes["best"]["label_wise"]["substitution"]["tp"] == 1
    assert modes["best"]["label_wise"]["deletion"]["tp"] == 0
    assert sum(value["tp"] for value in modes["worst"]["label_wise"].values()) == 0


@pytest.mark.parametrize("kind", ["nan", "shape", "offset", "canonical", "unknown-label"])
def test_invalid_diagnostic_inputs_fail_closed(kind):
    items = [row("甲乙", [span(0, 1)])]
    outputs = [(logits([1]), [(0, 1)])]
    if kind == "nan":
        outputs[0][0][0, 0] = np.nan
    elif kind == "shape":
        outputs = [(np.zeros((1, 2)), [(0, 1)])]
    elif kind == "offset":
        outputs = [(logits([1]), [(0, 3)])]
    elif kind == "canonical":
        items[0]["error_alternatives"] = [[span(1, 2)]]
    else:
        items[0]["errors"][0]["label"] = "invented"
    with pytest.raises(SensitivityError):
        analyze_outputs(items, outputs, LABELS)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")


@pytest.fixture
def inputs(tmp_path):
    upstream, converted, cache = (tmp_path / name for name in ("upstream", "converted", "cache"))
    for directory in (upstream, converted, cache):
        directory.mkdir()
    config = {
        "id2label": {str(index): label for index, label in enumerate(LABELS)},
        "label2id": {label: index for index, label in enumerate(LABELS)},
        "model_type": "modernbert",
        "max_position_embeddings": 8192,
    }
    for directory in (upstream, converted):
        write_json(directory / "config.json", config)
        (directory / "tokenizer.json").write_bytes(b"fixture-tokenizer-not-loadable")
        write_json(directory / "tokenizer_config.json", {})
    (upstream / "model.safetensors").write_bytes(b"fixture-weights-not-loadable")
    (converted / "onnx").mkdir()
    for name in ("model.onnx", "model_quantized.onnx", "model_fp16.onnx", "model.onnx.data"):
        (converted / "onnx" / name).write_bytes(name.encode())
    canonical = [span(0, 1)]
    alternative = [span(2, 3)]
    items = [
        row("甲乙丙", canonical, [canonical, alternative], "ambiguous"),
        row("正常な文", [], identifier="normal"),
    ]
    outputs = [(logits([0, 1]), [(0, 1), (2, 3)]), (logits([0]), [(0, 4)])]
    dataset = tmp_path / "development.json"
    write_json(dataset, {"metadata": {"source_split": "train"}, "items": items})
    manifest = tmp_path / "manifest.json"
    write_json(
        manifest,
        {
            "model_revision": EXPECTED_REVISION,
            "labels": list(LABELS),
            "outputs": {dataset.name: {"sha256": sha(dataset), "bytes": dataset.stat().st_size}},
        },
    )
    protocol = ROOT / "benchmarks/protocols/jwtd-v1.json"
    baseline = {
        "source_commit": BASELINE_SOURCE_COMMIT,
        "model_revision": EXPECTED_REVISION,
        "phase": "development",
        "dataset_sha256": sha(dataset),
        "dataset_manifest_sha256": sha(manifest),
        "protocol_sha256": sha(protocol),
        "models": {},
        "cache": {},
    }
    for name, filename in zip(
        MODEL_NAMES, (None, "model.onnx", "model_quantized.onnx", "model_fp16.onnx"), strict=True
    ):
        model = (
            upstream / "model.safetensors" if filename is None else converted / "onnx" / filename
        )
        provenance = {
            "dataset_sha256": sha(dataset),
            "model_sha256": sha(model),
            "revision": EXPECTED_REVISION,
            "runner_sha256": BASELINE_RUNNER_SHA256,
            "tokenizer_sha256": sha(upstream / "tokenizer.json"),
            "tokenizer_config_sha256": sha(upstream / "tokenizer_config.json"),
            "model_config_sha256": sha(upstream / "config.json"),
            "scorer_sha256": sha(ROOT / "scripts/corpus_evaluation.py"),
            "evaluation_sha256": sha(ROOT / "scripts/evaluation.py"),
        }
        if name == "onnx_fp32":
            provenance["external_data_sha256"] = sha(converted / "onnx/model.onnx.data")
        npz = cache / f"{name}-logits.npz"
        np.savez_compressed(
            npz,
            logits=np.concatenate([v for v, _ in outputs]),
            offsets=np.array([[0, 1], [2, 3], [0, 4]]),
            bounds=np.array([0, 2, 3]),
        )
        sidecar = {"inputs": provenance, "cache_sha256": sha(npz), "items": len(items)}
        write_json(cache / f"{name}-cache.json", sidecar)
        baseline["cache"][name] = sidecar
        baseline["models"][name] = {"0.5": evaluate_outputs(items, outputs, LABELS, 0.5)}
    baseline_path = tmp_path / "baseline.json"
    write_json(baseline_path, baseline)
    return dict(
        dataset=dataset,
        dataset_manifest=manifest,
        protocol=protocol,
        baseline=baseline_path,
        cache_dir=cache,
        upstream_dir=upstream,
        converted_dir=converted,
        baseline_sha256=sha(baseline_path),
        allow_dirty_source=True,
    )


def test_run_uses_only_verified_caches_and_does_not_write_corpus_text(inputs, tmp_path):
    output = tmp_path / "diagnostic"
    report = run_analysis(**inputs, output=output)
    assert report["execution"]["status"] == "completed"
    assert report["inference_performed"] is False
    assert report["baseline_reproduced"] is True
    assert set(report["models"]) == set(MODEL_NAMES)
    assert set(path.name for path in output.iterdir()) == {"sensitivity.json", "summary.md"}
    serialized = (output / "sensitivity.json").read_text(encoding="utf-8")
    assert "正常な文" not in serialized and "甲乙丙" not in serialized
    assert report["baseline"]["source_commit"] == BASELINE_SOURCE_COMMIT
    assert report["baseline"]["canonical_development_v1"] is False
    assert report["source"]["commit"]
    assert isinstance(report["source"]["clean"], bool)
    assert report["provenance"]["dataset_sha256"] == sha(inputs["dataset"])
    assert report["product_acceptance"] == "not established by this development diagnostic"


@pytest.mark.parametrize(
    "kind",
    ["cache", "sidecar", "baseline", "dataset", "weights", "tokenizer", "missing", "held-out"],
)
def test_changed_or_unbound_inputs_fail_before_creating_output(inputs, tmp_path, kind):
    if kind in ("cache", "missing"):
        path = inputs["cache_dir"] / "pytorch-logits.npz"
        path.unlink() if kind == "missing" else path.write_bytes(b"changed")
    elif kind == "sidecar":
        write_json(inputs["cache_dir"] / "pytorch-cache.json", {})
    elif kind == "baseline":
        baseline = json.loads(inputs["baseline"].read_text(encoding="utf-8"))
        baseline["models"]["pytorch"]["0.5"]["event"]["tp"] = 99
        write_json(inputs["baseline"], baseline)
    elif kind == "weights":
        (inputs["upstream_dir"] / "model.safetensors").write_bytes(b"changed")
    elif kind == "tokenizer":
        (inputs["converted_dir"] / "tokenizer.json").write_bytes(b"changed")
    else:
        dataset = json.loads(inputs["dataset"].read_text(encoding="utf-8"))
        if kind == "held-out":
            dataset["metadata"]["source_split"] = "official_test"
            write_json(inputs["dataset"], dataset)
            manifest = json.loads(inputs["dataset_manifest"].read_text(encoding="utf-8"))
            manifest["outputs"][inputs["dataset"].name] = {
                "sha256": sha(inputs["dataset"]),
                "bytes": inputs["dataset"].stat().st_size,
            }
            write_json(inputs["dataset_manifest"], manifest)
        else:
            inputs["dataset"].write_text("{}", encoding="utf-8")
    output = tmp_path / "diagnostic"
    with pytest.raises(SensitivityError):
        run_analysis(**inputs, output=output)
    assert not output.exists()


def test_existing_output_is_not_overwritten(inputs, tmp_path):
    output = tmp_path / "existing"
    output.mkdir()
    sentinel = output / "keep.txt"
    sentinel.write_text("preserve", encoding="utf-8")
    with pytest.raises(SensitivityError, match="output"):
        run_analysis(**inputs, output=output)
    assert sentinel.read_text() == "preserve"


def test_opt_in_frontier_is_source_bound_and_preserves_default_report(inputs, tmp_path):
    ordinary = run_analysis(**inputs, output=tmp_path / "ordinary")
    expanded = run_analysis(**inputs, output=tmp_path / "expanded", threshold_frontier=True)
    assert "threshold_frontier" not in ordinary["models"]["pytorch"]
    for name in MODEL_NAMES:
        assert expanded["models"][name]["modes"] == ordinary["models"][name]["modes"]
        assert expanded["models"][name]["threshold_frontier"]["points"]
    assert expanded["inference_performed"] is False
    text = (tmp_path / "expanded" / "sensitivity.json").read_text(encoding="utf-8")
    assert "正常な文" not in text and "甲乙丙" not in text
    assert "threshold" in (tmp_path / "expanded" / "summary.md").read_text(encoding="utf-8")


def test_coherently_replaced_development_inputs_do_not_replace_the_pinned_baseline(
    inputs, tmp_path
):
    data = json.loads(inputs["dataset"].read_text(encoding="utf-8"))
    data["items"][1]["text"] = "別の正常"
    write_json(inputs["dataset"], data)
    manifest = json.loads(inputs["dataset_manifest"].read_text(encoding="utf-8"))
    manifest["outputs"][inputs["dataset"].name] = {
        "sha256": sha(inputs["dataset"]),
        "bytes": inputs["dataset"].stat().st_size,
    }
    write_json(inputs["dataset_manifest"], manifest)
    baseline = json.loads(inputs["baseline"].read_text(encoding="utf-8"))
    baseline["dataset_sha256"] = sha(inputs["dataset"])
    baseline["dataset_manifest_sha256"] = sha(inputs["dataset_manifest"])
    for name in MODEL_NAMES:
        sidecar = baseline["cache"][name]
        sidecar["inputs"]["dataset_sha256"] = sha(inputs["dataset"])
        write_json(inputs["cache_dir"] / f"{name}-cache.json", sidecar)
    write_json(inputs["baseline"], baseline)
    with pytest.raises(SensitivityError, match="baseline"):
        run_analysis(**inputs, output=tmp_path / "replacement")


def test_dirty_diagnostic_source_is_rejected_by_default(inputs, tmp_path, monkeypatch):
    inputs.pop("allow_dirty_source")
    monkeypatch.setattr(
        diagnostic, "git_source", lambda _: {"commit": "a" * 40, "clean": False}, raising=False
    )
    with pytest.raises(SensitivityError, match="source"):
        run_analysis(**inputs, output=tmp_path / "dirty")


def test_custom_baseline_requires_explicit_pin(inputs, tmp_path):
    inputs.pop("baseline_sha256")
    with pytest.raises(SensitivityError, match="baseline"):
        run_analysis(**inputs, output=tmp_path / "unpinned")


def test_source_change_during_analysis_refuses_output(inputs, tmp_path, monkeypatch):
    contexts = iter([{"commit": "a" * 40, "clean": True}, {"commit": "b" * 40, "clean": True}])
    monkeypatch.setattr(diagnostic, "git_source", lambda _: next(contexts))
    output = tmp_path / "source-changed"
    with pytest.raises(SensitivityError, match="source changed"):
        run_analysis(**inputs, output=output)
    assert not output.exists()


def test_git_unavailable_is_explicitly_unbound_for_fixture_diagnostics(
    inputs, tmp_path, monkeypatch
):
    def unavailable(_):
        raise diagnostic.PreparationError("git unavailable")

    monkeypatch.setattr(diagnostic, "git_source", unavailable)
    with pytest.raises(SensitivityError, match="source"):
        run_analysis(**{**inputs, "allow_dirty_source": False}, output=tmp_path / "strict")
    report = run_analysis(**inputs, output=tmp_path / "unbound")
    assert report["source"] == {"commit": "unknown", "clean": False, "git_unavailable": True}


@pytest.mark.parametrize(
    "directory,filename",
    [
        ("upstream_dir", "config.json"),
        ("upstream_dir", "tokenizer_config.json"),
        ("converted_dir", "onnx/model.onnx"),
        ("converted_dir", "onnx/model.onnx.data"),
        ("converted_dir", "onnx/model_quantized.onnx"),
        ("converted_dir", "onnx/model_fp16.onnx"),
    ],
)
def test_each_bound_model_asset_is_verified(inputs, tmp_path, directory, filename):
    (inputs[directory] / filename).write_bytes(b"changed")
    output = tmp_path / "changed-asset"
    with pytest.raises(SensitivityError):
        run_analysis(**inputs, output=output)
    assert not output.exists()


@pytest.mark.parametrize("kind", ["bounds", "offsets", "logits"])
def test_hash_bound_malformed_npz_is_rejected(inputs, tmp_path, kind):
    path = inputs["cache_dir"] / "pytorch-logits.npz"
    arrays = {
        "bounds": np.array([0, 2, 3]),
        "offsets": np.array([[0, 1], [2, 3], [0, 4]]),
        "logits": logits([0, 1, 0]),
    }
    arrays[kind] = {
        "bounds": np.array([0, 4, 3]),
        "offsets": np.array([[0, 1]]),
        "logits": np.full((3, 3), np.nan),
    }[kind]
    np.savez_compressed(path, **arrays)
    baseline = json.loads(inputs["baseline"].read_text(encoding="utf-8"))
    baseline["cache"]["pytorch"]["cache_sha256"] = sha(path)
    write_json(inputs["cache_dir"] / "pytorch-cache.json", baseline["cache"]["pytorch"])
    write_json(inputs["baseline"], baseline)
    inputs["baseline_sha256"] = sha(inputs["baseline"])
    output = tmp_path / "invalid-array"
    with pytest.raises(SensitivityError):
        run_analysis(**inputs, output=output)
    assert not output.exists()


@pytest.mark.parametrize("with_frontier", [False, True])
def test_cli_runs_without_inference_and_reports_errors_without_traceback(
    inputs, tmp_path, with_frontier
):
    command = [sys.executable, str(ROOT / "scripts/analyze_scoring_sensitivity.py")]
    for name, value in {**inputs, "output": tmp_path / "cli-output"}.items():
        if value is True:
            command.append("--" + name.replace("_", "-"))
        else:
            command.extend(["--" + name.replace("_", "-"), str(value)])
    if with_frontier:
        command.append("--threshold-frontier")
    result = subprocess.run(
        command,
        cwd=ROOT,
        env={**os.environ, "PYTHONUTF8": "1"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["baseline_reproduced"] is True
    saved = json.loads((tmp_path / "cli-output/sensitivity.json").read_text(encoding="utf-8"))
    assert all(
        ("threshold_frontier" in saved["models"][name]) == with_frontier for name in MODEL_NAMES
    )
    assert "正常な文" not in result.stdout + result.stderr
    failure = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
    assert failure.returncode != 0 and "Traceback" not in failure.stderr
