import hashlib
import json
from pathlib import Path

import pytest

from scripts import prepare_models
from scripts.prepare_models import PreviewPreparationError, prepare_preview


def _write_candidate(tmp_path: Path) -> tuple[Path, Path, Path]:
    asset_root = tmp_path / "converted"
    asset_root.mkdir(parents=True)
    asset_artifacts = {}
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "LICENSE"):
        asset_path = asset_root / name
        asset_path.write_text(f"{name}\n", encoding="utf-8")
        asset_artifacts[name] = {
            "bytes": asset_path.stat().st_size,
            "sha256": hashlib.sha256(asset_path.read_bytes()).hexdigest(),
        }
    (asset_root / "manifest.json").write_text(
        json.dumps({"artifacts": asset_artifacts}), encoding="utf-8"
    )
    candidate = tmp_path / "candidate.onnx"
    candidate.write_bytes(b"tiny-candidate")
    manifest = {
        "schema_version": "weight-only-matmul-fp16-storage-v1",
        "model_kind": "embedding-u8-matmul-fp16-storage",
        "options": {
            "embedding_dequantize_after_gather": True,
            "matmul_fp16_storage": True,
            "matmul_storage_dtype": "FLOAT16",
            "matmul_compute_dtype": "FLOAT",
        },
        "source": {"fp32_sha256": "a" * 64, "quantized_sha256": "b" * 64},
        "output": {
            "filename": candidate.name,
            "bytes": candidate.stat().st_size,
            "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
        },
    }
    manifest_path = candidate.with_name("manifest.json")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return candidate, asset_root, manifest_path


def test_prepare_preview_copies_five_assets_and_records_provenance(tmp_path: Path) -> None:
    candidate, asset_root, _ = _write_candidate(tmp_path)
    output = tmp_path / "preview"
    result = prepare_preview(candidate, output, asset_root=asset_root)

    assert result == output / "manifest.json"
    assert sorted(path.relative_to(output).as_posix() for path in output.rglob("*")) == [
        "LICENSE",
        "config.json",
        "manifest.json",
        "onnx",
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
    ]
    manifest = json.loads(result.read_text(encoding="utf-8"))
    assert manifest["model_id"] == "sbintuitions/ja-typo-detector-modernbert-ja-base-30m"
    assert manifest["revision"] == "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
    assert manifest["source_license"] == "mit"
    assert manifest["model_kind"] == "embedding-u8-matmul-fp16-storage"
    assert set(manifest["artifacts"]) == {
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "LICENSE",
        "onnx/model_quantized.onnx",
    }
    assert manifest["converter"]["schema_version"] == "weight-only-matmul-fp16-storage-v1"
    assert manifest["converter"]["options"]["matmul_compute_dtype"] == "FLOAT"


def test_prepare_preview_rejects_checksum_mismatch_and_existing_output(tmp_path: Path) -> None:
    candidate, asset_root, manifest_path = _write_candidate(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["output"]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PreviewPreparationError, match="candidate SHA-256"):
        prepare_preview(candidate, tmp_path / "bad", asset_root=asset_root)

    candidate, asset_root, _ = _write_candidate(tmp_path / "existing")
    output = tmp_path / "existing-output"
    output.mkdir()
    with pytest.raises(PreviewPreparationError, match="already exists"):
        prepare_preview(candidate, output, asset_root=asset_root)


def test_prepare_preview_rejects_same_size_asset_manifest_tampering(tmp_path: Path) -> None:
    candidate, asset_root, _ = _write_candidate(tmp_path)
    asset = asset_root / "config.json"
    asset.write_text("x\n", encoding="utf-8")
    with pytest.raises(PreviewPreparationError, match="source asset"):
        prepare_preview(candidate, tmp_path / "tampered", asset_root=asset_root)


def test_prepare_preview_rejects_existing_output_ancestor_link(tmp_path: Path, monkeypatch) -> None:
    candidate, asset_root, _ = _write_candidate(tmp_path)
    link = tmp_path / "linked-parent"
    output = link / "preview"
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: path == link or original_is_symlink(path),
    )
    with pytest.raises(PreviewPreparationError, match="symlink"):
        prepare_preview(candidate, output, asset_root=asset_root)


def test_prepare_preview_rejects_invalid_candidate_manifest_and_canonical_output(
    tmp_path: Path,
) -> None:
    candidate, asset_root, manifest_path = _write_candidate(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["model_kind"] = "other"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PreviewPreparationError, match="model_kind"):
        prepare_preview(candidate, tmp_path / "bad-kind", asset_root=asset_root)

    candidate, asset_root, _ = _write_candidate(tmp_path / "canonical")
    canonical = Path("models/converted/preview-fp16")
    with pytest.raises(PreviewPreparationError, match="canonical"):
        prepare_preview(candidate, canonical, asset_root=asset_root)


def test_prepare_preview_cli_dispatches_without_pipeline(tmp_path: Path, monkeypatch) -> None:
    candidate, asset_root, _ = _write_candidate(tmp_path)
    calls: list[tuple[Path, Path]] = []

    def fake_prepare(candidate_path: Path, output_dir: Path) -> Path:
        calls.append((candidate_path, output_dir))
        return output_dir / "manifest.json"

    monkeypatch.setattr(prepare_models, "prepare_preview", fake_prepare)
    monkeypatch.setattr(
        prepare_models.sys,
        "argv",
        [
            "prepare_models.py",
            "--preview-from",
            str(candidate),
            "--output",
            str(tmp_path / "cli-preview"),
        ],
    )
    assert prepare_models.main() == 0
    assert calls == [(candidate, tmp_path / "cli-preview")]
    assert asset_root.is_dir()
