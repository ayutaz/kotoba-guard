"""Lightweight guards for corpus-evaluation validation paths."""

import json
import sys
from types import SimpleNamespace

import numpy as np
import pytest

import scripts.run_corpus_evaluation as corpus_runner
from scripts.model_pipeline import EXPECTED_REVISION
from scripts.run_corpus_evaluation import StrictTokenizer, main, validate_dataset

LABELS = ("OK", "substitution", "deletion")


def _write_dataset_binding(tmp_path, dataset):
    dataset_path = tmp_path / "development.json"
    dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
    manifest = {
        "model_revision": EXPECTED_REVISION,
        "labels": list(LABELS),
        "outputs": {
            dataset_path.name: {
                "sha256": corpus_runner.sha256_file(dataset_path),
                "bytes": dataset_path.stat().st_size,
            }
        },
    }
    return dataset_path, manifest


def test_validate_dataset_rejects_empty_items_after_hash_binding(tmp_path):
    dataset_path, manifest = _write_dataset_binding(
        tmp_path,
        {"metadata": {"source_split": "train"}, "items": []},
    )

    with pytest.raises(ValueError, match="empty evaluation dataset"):
        validate_dataset(
            dataset_path,
            {"metadata": {"source_split": "train"}, "items": []},
            manifest,
            "development",
            LABELS,
        )


class _Tokenizer:
    def __call__(self, text, **_kwargs):
        token_count = len(text)
        return {
            "input_ids": np.zeros((1, token_count), dtype=np.int64),
            "attention_mask": np.ones((1, token_count), dtype=np.int64),
            "offset_mapping": np.array(
                [[[index, index + 1] for index in range(token_count)]], dtype=np.int64
            ),
        }


def test_strict_tokenizer_returns_offsets_and_rejects_silent_truncation():
    runner = object.__new__(StrictTokenizer)
    runner.tokenizer = _Tokenizer()
    runner.max_length = 3

    encoded, offsets = runner._tokenize("日本語")

    assert offsets == [(0, 1), (1, 2), (2, 3)]
    assert "offset_mapping" not in encoded
    with pytest.raises(ValueError, match="model limit"):
        runner._tokenize("日本語文")


def test_main_rejects_held_out_evaluation_without_frozen_decision(tmp_path, monkeypatch):
    dataset_path, manifest = _write_dataset_binding(
        tmp_path,
        {"metadata": {"source_split": "official_test"}, "items": [{"text": "文", "errors": []}]},
    )
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    protocol = tmp_path / "protocol.json"
    protocol.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        corpus_runner,
        "load_model_metadata",
        lambda _path: SimpleNamespace(labels=LABELS),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "scripts/run_corpus_evaluation.py",
            "--dataset",
            str(dataset_path),
            "--output",
            str(tmp_path / "output"),
            "--phase",
            "held-out",
            "--protocol",
            str(protocol),
        ],
    )

    with pytest.raises(ValueError, match="frozen development decision"):
        main()
