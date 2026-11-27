"""Security-oriented unit tests for release and quantization path handling."""

from pathlib import Path

import pytest

from scripts.prepare_release import PreparationError, _parse_evidence
from scripts.quantize import _external_data_path


def test_release_evidence_parser_accepts_unique_named_paths():
    parsed = _parse_evidence(["checks=artifacts/checks.json", "security=security.json"])

    assert parsed == {
        "checks": Path("artifacts/checks.json"),
        "security": Path("security.json"),
    }


@pytest.mark.parametrize(
    "value",
    [
        "checks",
        "unknown=evidence.json",
        "checks=",
        "checks=first.json",
    ],
)
def test_release_evidence_parser_rejects_malformed_or_duplicate_entries(value):
    values = [value, "checks=second.json"] if value == "checks=first.json" else [value]

    with pytest.raises(PreparationError, match="expected one unique NAME=PATH"):
        _parse_evidence(values)


def test_quantization_external_data_path_stays_under_model_directory(tmp_path):
    model = tmp_path / "models" / "model.onnx"
    external = model.parent / "weights" / "model.onnx.data"
    external.parent.mkdir(parents=True)
    external.write_bytes(b"weights")

    assert _external_data_path(model, "weights/model.onnx.data") == external
