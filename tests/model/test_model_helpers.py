import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from scripts.model_pipeline import (
    collect_file_manifest,
    reference_infer,
    sha256_file,
    write_manifest,
)

FIXTURE = Path(__file__).parent / "fixtures" / "tokenizer-offsets.json"


def test_sha256_and_manifest_are_stable(tmp_path: Path) -> None:
    sample = tmp_path / "sample.bin"
    sample.write_bytes(b"kotoba-guard")
    expected = hashlib.sha256(b"kotoba-guard").hexdigest()
    assert sha256_file(sample) == expected
    manifest = collect_file_manifest(tmp_path)
    assert manifest == {"sample.bin": {"bytes": 12, "sha256": expected}}


def test_manifest_is_json_serializable(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text(json.dumps({"id2label": {"0": "OK"}}), encoding="utf-8")
    assert json.loads(json.dumps(collect_file_manifest(tmp_path)))["config.json"]["bytes"] > 0


def test_manifest_excludes_self_and_temporary_conversion_outputs(tmp_path: Path) -> None:
    (tmp_path / "manifest.json").write_text("stale", encoding="utf-8")
    (tmp_path / "try_uint8.onnx").write_bytes(b"temporary")
    (tmp_path / "onnx").mkdir()
    (tmp_path / "onnx" / "model.onnx").write_bytes(b"canonical")

    manifest = collect_file_manifest(tmp_path)

    assert "manifest.json" not in manifest
    assert "try_uint8.onnx" not in manifest
    assert "onnx/model.onnx" in manifest


def test_reference_empty_text_is_side_effect_free() -> None:
    result = reference_infer("")
    assert result == {"text": "", "tokens": [], "detections": [], "elapsed_ms": 0.0}


def test_manifest_conversion_time_tracks_artifacts_not_a_hardcoded_session(tmp_path):
    source = tmp_path / "upstream"
    source.mkdir()
    output = tmp_path / "converted"
    model = output / "onnx" / "model.onnx"
    model.parent.mkdir(parents=True)
    model.write_bytes(b"fixture")
    timestamp = datetime(2026, 11, 26, 1, 2, 3, tzinfo=UTC).timestamp()
    os.utime(model, (timestamp, timestamp))
    path = write_manifest(output, source)
    first = json.loads(path.read_text())
    assert first["conversion"]["converted_at_utc"] == "2026-11-26T01:02:03Z"
    write_manifest(output, source)
    assert json.loads(path.read_text())["conversion"] == first["conversion"]


def test_sha256_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        sha256_file(tmp_path / "missing")


def test_tokenizer_fixture_preserves_python_codepoint_offsets() -> None:
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert cases[0]["offset_mapping"][2] == [2, 3]
    assert cases[0]["text"][2:3] == "🌸"
    assert cases[0]["text"][5:6] == "́"
    assert all(case["offset_unit"] == "python_unicode_codepoint" for case in cases)
