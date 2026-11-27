import json

import numpy as np
import pytest

import scripts.run_corpus_evaluation as corpus_runner
from scripts.run_corpus_evaluation import (
    cache_outputs,
    evaluate_outputs,
    parity,
    validate_dataset,
    validate_decision,
)

LABELS = ("OK", "substitution", "deletion")


def test_dataset_binding_rejects_changed_bytes_and_phase_mixups(tmp_path):
    import json

    from scripts.model_pipeline import EXPECTED_REVISION, sha256_file

    dataset_path = tmp_path / "development.json"
    dataset = {"metadata": {"source_split": "train"}, "items": [{"text": "文", "errors": []}]}
    dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
    manifest = {
        "model_revision": EXPECTED_REVISION,
        "labels": list(LABELS),
        "outputs": {
            dataset_path.name: {
                "sha256": sha256_file(dataset_path),
                "bytes": dataset_path.stat().st_size,
            }
        },
    }
    validate_dataset(dataset_path, dataset, manifest, "development", LABELS)
    with pytest.raises(ValueError, match="phase"):
        validate_dataset(dataset_path, dataset, manifest, "held-out", LABELS)
    dataset_path.write_text("changed", encoding="utf-8")
    with pytest.raises(ValueError, match="hash"):
        validate_dataset(dataset_path, dataset, manifest, "development", LABELS)


def test_primary_scoring_accepts_equivalent_alignment_without_widening_gold():
    item = {
        "id": "duplicate",
        "text": "ああ",
        "errors": [{"start": 0, "end": 1, "label": "deletion"}],
        "error_alternatives": [
            [{"start": 0, "end": 1, "label": "deletion"}],
            [{"start": 1, "end": 2, "label": "deletion"}],
        ],
    }
    result = evaluate_outputs(
        [item], [(np.array([[5, 0, 0], [0, 0, 5]]), [(0, 1), (1, 2)])], LABELS, 0
    )
    assert result["event"]["tp"] == 1
    assert result["ambiguous_alignment_documents"] == 1
    assert result["raw_exact"]["f1"] == 0


def test_primary_scoring_never_mixes_incompatible_joint_alignments():
    def span(start):
        return {"start": start, "end": start + 1, "label": "deletion"}

    alternatives = [[span(0), span(2)], [span(1), span(3)]]
    item = {
        "id": "joint",
        "text": "ああああ",
        "errors": alternatives[0],
        "error_alternatives": alternatives,
    }
    logits = np.array([[0, 0, 5], [5, 0, 0], [5, 0, 0], [0, 0, 5]])
    result = evaluate_outputs([item], [(logits, [(0, 1), (1, 2), (2, 3), (3, 4)])], LABELS, 0)
    assert result["event"]["tp"] == 1
    assert result["event"]["fp"] == result["event"]["fn"] == 1


def test_corpus_metrics_separate_containment_exact_projection_and_clean_false_positives():
    items = [
        {
            "id": "error",
            "text": "甲乙",
            "errors": [{"start": 1, "end": 2, "label": "substitution"}],
        },
        {"id": "clean", "text": "丙丁", "errors": []},
    ]
    outputs = [
        (np.array([[0, 4, 0]]), [(0, 2)]),
        (np.array([[4, 0, 0]]), [(0, 2)]),
    ]
    result = evaluate_outputs(items, outputs, LABELS, 0.5)
    assert result["event"]["f1"] == 1
    assert result["raw_exact"]["f1"] == 0
    assert result["projected_span"]["f1"] == 1
    assert result["clean_false_positive_items"] == 0
    assert result["record_label_all_hits"] == 1


def test_wrong_label_is_location_hit_but_not_labeled_event_hit():
    items = [{"id": "x", "text": "甲", "errors": [{"start": 0, "end": 1, "label": "deletion"}]}]
    result = evaluate_outputs(items, [(np.array([[0, 4, 0]]), [(0, 1)])], LABELS, 0)
    assert result["event"]["fp"] == result["event"]["fn"] == 1
    assert result["location"]["tp"] == 1
    assert result["clean_rate"] is None


@pytest.mark.parametrize("logits", [np.array([[np.nan, 1, 0]]), np.array([[1, 0]])])
def test_nonfinite_or_wrong_label_shape_fails_before_scoring(logits):
    with pytest.raises(ValueError):
        evaluate_outputs(
            [{"id": "x", "text": "甲", "errors": []}], [(logits, [(0, 1)])], LABELS, 0.5
        )


def test_projection_conflicts_are_counted_without_removing_error_events():
    items = [
        {
            "id": "x",
            "text": "甲乙",
            "errors": [
                {"start": 0, "end": 1, "label": "substitution"},
                {"start": 1, "end": 2, "label": "deletion"},
            ],
        }
    ]
    result = evaluate_outputs(items, [(np.array([[0, 4, 0]]), [(0, 2)])], LABELS, 0.5)
    assert result["projection_unscorable_documents"] == 1
    assert result["event"]["tp"] == 1
    assert result["event"]["fn"] == 1


def test_parity_rejects_offset_or_shape_mismatch_and_excludes_special_tokens():
    reference = [(np.array([[4, 0, 0], [0, 4, 0]]), [(0, 0), (0, 1)])]
    candidate = [(np.array([[0, 4, 0], [0, 4, 0]]), [(0, 0), (0, 1)])]
    assert parity(reference, candidate)["token_argmax_agreement"] == 1
    with pytest.raises(ValueError):
        parity(reference, [(candidate[0][0], [(0, 0), (1, 2)])])


def test_held_out_decision_must_bind_protocol_and_dataset_manifest():
    from scripts.model_pipeline import EXPECTED_REVISION

    decision = {
        "phase": "development",
        "model_revision": EXPECTED_REVISION,
        "dataset_manifest_sha256": "a" * 64,
        "protocol_sha256": "b" * 64,
        "selection": {"threshold": 0.5, "admissible": False},
    }
    validate_decision(decision, "a" * 64, "b" * 64)
    with pytest.raises(ValueError, match="manifest"):
        validate_decision(decision, "c" * 64, "b" * 64)
    with pytest.raises(ValueError, match="protocol"):
        validate_decision(decision, "a" * 64, "c" * 64)


@pytest.mark.parametrize("threshold", [np.nan, np.inf, -0.01, 1.01, True])
def test_decision_rejects_nonfinite_or_out_of_range_thresholds(threshold):
    from scripts.model_pipeline import EXPECTED_REVISION

    decision = {
        "phase": "development",
        "model_revision": EXPECTED_REVISION,
        "dataset_manifest_sha256": "a" * 64,
        "protocol_sha256": "b" * 64,
        "selection": {"threshold": threshold, "admissible": True},
    }

    with pytest.raises(ValueError, match="threshold"):
        validate_decision(decision, "a" * 64, "b" * 64)


@pytest.mark.parametrize(
    "field,value",
    [("phase", "held-out"), ("model_revision", "other-revision")],
)
def test_decision_rejects_non_development_binding(field, value):
    from scripts.model_pipeline import EXPECTED_REVISION

    decision = {
        "phase": "development",
        "model_revision": EXPECTED_REVISION,
        "dataset_manifest_sha256": "a" * 64,
        "protocol_sha256": "b" * 64,
        "selection": {"threshold": 0.5, "admissible": True},
    }
    decision[field] = value

    with pytest.raises(ValueError, match="development"):
        validate_decision(decision, "a" * 64, "b" * 64)


def _cache_fixture(tmp_path, monkeypatch, *, logits, offsets, bounds=None, item_count=1):
    upstream = tmp_path / "upstream"
    converted = tmp_path / "converted" / "onnx"
    output = tmp_path / "cache"
    upstream.mkdir(parents=True)
    converted.mkdir(parents=True)
    output.mkdir()
    for name in ("tokenizer.json", "tokenizer_config.json", "config.json"):
        (upstream / name).write_text(name, encoding="utf-8")
    model_path = converted / "model_quantized.onnx"
    model_path.write_bytes(b"toy-model")
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "corpus_evaluation.py").write_text("score", encoding="utf-8")
    (tmp_path / "scripts" / "evaluation.py").write_text("evaluate", encoding="utf-8")
    monkeypatch.setattr(corpus_runner, "ROOT", tmp_path)
    monkeypatch.setattr(corpus_runner, "UPSTREAM_ROOT", upstream)
    monkeypatch.setattr(corpus_runner, "CONVERTED_ROOT", tmp_path / "converted")
    monkeypatch.setattr(corpus_runner, "EXPECTED_REVISION", "toy-revision")
    cache = output / "onnx_quint8-logits.npz"
    np.savez_compressed(
        cache,
        logits=logits,
        offsets=offsets,
        bounds=np.array([0, len(logits)]) if bounds is None else bounds,
    )
    inputs = {
        "dataset_sha256": "dataset-sha",
        "model_sha256": corpus_runner.sha256_file(model_path),
        "revision": "toy-revision",
        "runner_sha256": corpus_runner.sha256_file(corpus_runner.Path(corpus_runner.__file__)),
        "tokenizer_sha256": corpus_runner.sha256_file(upstream / "tokenizer.json"),
        "tokenizer_config_sha256": corpus_runner.sha256_file(upstream / "tokenizer_config.json"),
        "model_config_sha256": corpus_runner.sha256_file(upstream / "config.json"),
        "scorer_sha256": corpus_runner.sha256_file(tmp_path / "scripts" / "corpus_evaluation.py"),
        "evaluation_sha256": corpus_runner.sha256_file(tmp_path / "scripts" / "evaluation.py"),
    }
    (output / "onnx_quint8-cache.json").write_text(
        json.dumps(
            {
                "inputs": inputs,
                "cache_sha256": corpus_runner.sha256_file(cache),
                "items": item_count,
            }
        ),
        encoding="utf-8",
    )
    return output, model_path


def test_cache_rejects_model_hash_changes_in_existing_toy_cache(tmp_path, monkeypatch):
    logits = np.array([[1.0, 2.0, 3.0]])
    offsets = np.array([[0, 1]])
    output, model_path = _cache_fixture(tmp_path, monkeypatch, logits=logits, offsets=offsets)
    items = [{"text": "文", "errors": []}]

    outputs, metadata = cache_outputs("onnx_quint8", items, "dataset-sha", output)
    assert len(outputs) == 1
    assert metadata["inputs"]["revision"] == "toy-revision"

    with pytest.raises(ValueError, match="different inputs"):
        cache_outputs("onnx_quint8", items, "changed-dataset-sha", output)
    (tmp_path / "upstream" / "config.json").write_text("changed-config", encoding="utf-8")
    with pytest.raises(ValueError, match="different inputs"):
        cache_outputs("onnx_quint8", items, "dataset-sha", output)

    (tmp_path / "upstream" / "config.json").write_text("config.json", encoding="utf-8")
    model_path.write_bytes(b"tampered-model")

    with pytest.raises(ValueError, match="different inputs"):
        cache_outputs("onnx_quint8", items, "dataset-sha", output)


def test_cache_rejects_logits_and_offset_length_mismatch(tmp_path, monkeypatch):
    logits = np.array([[1.0, 2.0, 3.0], [3.0, 2.0, 1.0]])
    offsets = np.array([[0, 1]])
    output, _ = _cache_fixture(tmp_path, monkeypatch, logits=logits, offsets=offsets)

    with pytest.raises(ValueError, match="shape/offset"):
        cache_outputs("onnx_quint8", [{"text": "文", "errors": []}], "dataset-sha", output)


@pytest.mark.parametrize(
    "bounds",
    [
        np.array([1, 2]),
        np.array([0, 0]),
        np.array([0, 3]),
        np.array([0.0, 1.0]),
        np.array([0, 1, 2]),
        np.array([[0, 1]]),
    ],
)
def test_cache_rejects_invalid_bounds(tmp_path, monkeypatch, bounds):
    output, _ = _cache_fixture(
        tmp_path,
        monkeypatch,
        logits=np.array([[1.0, 2.0, 3.0], [3.0, 2.0, 1.0]]),
        offsets=np.array([[0, 1], [0, 1]]),
        bounds=bounds,
    )

    with pytest.raises(ValueError, match="shape/offset bounds"):
        cache_outputs("onnx_quint8", [{"text": "文", "errors": []}], "dataset-sha", output)


@pytest.mark.parametrize(
    "offsets",
    [np.array([[0, 1.0]]), np.array([[0, 1], [0, 1]])],
)
def test_cache_rejects_invalid_offset_dtype_or_item_count(tmp_path, monkeypatch, offsets):
    output, _ = _cache_fixture(
        tmp_path,
        monkeypatch,
        logits=np.array([[1.0, 2.0, 3.0]]),
        offsets=offsets,
        item_count=2 if len(offsets) == 2 else 1,
    )
    items = [{"text": "文", "errors": []}]

    with pytest.raises(ValueError):
        cache_outputs("onnx_quint8", items, "dataset-sha", output)


def test_cache_rejects_offsets_outside_each_item_text(tmp_path, monkeypatch):
    output, _ = _cache_fixture(
        tmp_path,
        monkeypatch,
        logits=np.array([[1.0, 2.0, 3.0]]),
        offsets=np.array([[-1, 0]]),
    )

    with pytest.raises(ValueError, match="text offsets"):
        cache_outputs("onnx_quint8", [{"text": "文", "errors": []}], "dataset-sha", output)


@pytest.mark.parametrize(
    "logits",
    [np.array([1.0, 2.0, 3.0]), np.array([[np.nan, 2.0, 3.0]])],
)
def test_cache_rejects_nonfinite_or_non_matrix_logits(tmp_path, monkeypatch, logits):
    output, _ = _cache_fixture(
        tmp_path,
        monkeypatch,
        logits=logits,
        offsets=np.array([[0, 1]]),
    )

    with pytest.raises(ValueError, match="shape/offset bounds"):
        cache_outputs("onnx_quint8", [{"text": "文", "errors": []}], "dataset-sha", output)
