"""Download and convert the pinned model for local development."""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.model_pipeline import (
    CONVERTED_ROOT,
    UPSTREAM_ROOT,
    convert_fp16,
    download_upstream,
    export_onnx,
    quantize_int8,
    write_manifest,
)

_PREVIEW_ASSETS = ("config.json", "tokenizer.json", "tokenizer_config.json", "LICENSE")
_PREVIEW_MODEL_KIND = "embedding-u8-matmul-fp16-storage"
_PREVIEW_SCHEMA = "weight-only-matmul-fp16-storage-v1"


class PreviewPreparationError(ValueError):
    """A preview candidate or destination failed the distribution checks."""


def _preview_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _preview_canonical_roots() -> tuple[Path, ...]:
    root = Path(__file__).resolve().parents[1]
    return (
        root / "models" / "converted",
        root / "models" / "upstream",
        root / "dist" / "extension" / "models",
    )


def _validate_preview_manifest(candidate: Path) -> tuple[Path, dict[str, object]]:
    if not candidate.is_file():
        raise PreviewPreparationError(f"candidate model is missing: {candidate}")
    manifest_path = candidate.with_name("manifest.json")
    if not manifest_path.is_file():
        raise PreviewPreparationError("candidate manifest.json is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreviewPreparationError("candidate manifest is invalid") from exc
    if not isinstance(manifest, dict):
        raise PreviewPreparationError("candidate manifest must be an object")
    if manifest.get("model_kind") != _PREVIEW_MODEL_KIND:
        raise PreviewPreparationError("candidate manifest model_kind is invalid")
    if manifest.get("schema_version") != _PREVIEW_SCHEMA:
        raise PreviewPreparationError("candidate manifest schema_version is invalid")
    options = manifest.get("options")
    if not isinstance(options, dict):
        raise PreviewPreparationError("candidate manifest options are missing")
    if options.get("matmul_storage_dtype") != "FLOAT16":
        raise PreviewPreparationError("candidate manifest storage dtype is invalid")
    if options.get("matmul_compute_dtype") != "FLOAT":
        raise PreviewPreparationError("candidate manifest compute dtype is invalid")
    output = manifest.get("output")
    if not isinstance(output, dict) or output.get("filename") != candidate.name:
        raise PreviewPreparationError("candidate manifest output filename is invalid")
    if output.get("bytes") != candidate.stat().st_size:
        raise PreviewPreparationError("candidate byte size does not match manifest")
    expected_sha = output.get("sha256")
    if not isinstance(expected_sha, str) or expected_sha != _preview_sha256(candidate):
        raise PreviewPreparationError("candidate SHA-256 does not match manifest")
    return manifest_path, manifest


def _validate_preview_assets(asset_root: Path) -> None:
    manifest_path = asset_root / "manifest.json"
    if not manifest_path.is_file():
        raise PreviewPreparationError("preview source asset manifest is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreviewPreparationError("preview source asset manifest is invalid") from exc
    artifacts = manifest.get("artifacts") if isinstance(manifest, dict) else None
    if not isinstance(artifacts, dict):
        raise PreviewPreparationError("preview source asset manifest artifacts are missing")
    for name in _PREVIEW_ASSETS:
        path = asset_root / name
        entry = artifacts.get(name)
        if not path.is_file() or not isinstance(entry, dict):
            raise PreviewPreparationError(f"preview source asset is missing: {name}")
        if entry.get("bytes") != path.stat().st_size:
            raise PreviewPreparationError(f"preview source asset size mismatch: {name}")
        if entry.get("sha256") != _preview_sha256(path):
            raise PreviewPreparationError(f"preview source asset SHA-256 mismatch: {name}")


def _reject_preview_output_links(output_dir: Path) -> None:
    raw_output = output_dir.absolute()
    for ancestor in (raw_output, *raw_output.parents):
        is_junction = getattr(ancestor, "is_junction", lambda: False)
        if ancestor.is_symlink() or is_junction():
            raise PreviewPreparationError("preview output has a symlink or junction ancestor")


def prepare_preview(
    candidate_path: Path,
    output_dir: Path,
    *,
    asset_root: Path = CONVERTED_ROOT,
) -> Path:
    """Copy a verified FP16 candidate and runtime assets into a preview bundle."""

    from scripts.model_pipeline import EXPECTED_REVISION, MODEL_ID

    _reject_preview_output_links(output_dir)
    candidate = candidate_path.resolve()
    output = output_dir.resolve()
    if output_dir.exists() or output_dir.is_symlink():
        raise PreviewPreparationError("preview output already exists")
    if output == candidate or candidate.is_relative_to(output):
        raise PreviewPreparationError("preview output overlaps candidate input")
    canonical_roots = tuple(root.resolve() for root in _preview_canonical_roots())
    if any(output == root or output.is_relative_to(root) for root in canonical_roots):
        raise PreviewPreparationError("preview output must be outside canonical model roots")

    candidate_manifest_path, candidate_manifest = _validate_preview_manifest(candidate)
    asset_root = asset_root.resolve()
    _validate_preview_assets(asset_root)
    source_files = {name: asset_root / name for name in _PREVIEW_ASSETS}
    missing = [name for name, path in source_files.items() if not path.is_file()]
    if missing:
        raise PreviewPreparationError(f"preview source assets are missing: {missing}")

    output.mkdir(parents=True, exist_ok=False)
    for name, source in source_files.items():
        shutil.copy2(source, output / name)
    destination_model = output / "onnx" / "model_quantized.onnx"
    destination_model.parent.mkdir()
    shutil.copy2(candidate, destination_model)

    artifacts = {
        name: {
            "bytes": (output / name).stat().st_size,
            "sha256": _preview_sha256(output / name),
        }
        for name in _PREVIEW_ASSETS
    }
    artifacts["onnx/model_quantized.onnx"] = {
        "bytes": destination_model.stat().st_size,
        "sha256": _preview_sha256(destination_model),
    }
    manifest = {
        "model_id": MODEL_ID,
        "revision": EXPECTED_REVISION,
        "source_license": "mit",
        "model_kind": _PREVIEW_MODEL_KIND,
        "converter": {
            "source": candidate_manifest.get("source", {}),
            "schema_version": candidate_manifest["schema_version"],
            "options": candidate_manifest["options"],
            "candidate_manifest_sha256": _preview_sha256(candidate_manifest_path),
        },
        "artifacts": artifacts,
    }
    destination_manifest = output / "manifest.json"
    destination_manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return destination_manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview-from", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.preview_from is not None:
        if args.output is None:
            parser.error("--preview-from requires --output")
        print(prepare_preview(args.preview_from, args.output))
        return 0
    if args.output is not None:
        parser.error("--output requires --preview-from")
    download_upstream(UPSTREAM_ROOT)
    export_onnx(UPSTREAM_ROOT, CONVERTED_ROOT)
    fp32 = CONVERTED_ROOT / "onnx" / "model.onnx"
    quantize_int8(fp32)
    convert_fp16(fp32)
    print(write_manifest(CONVERTED_ROOT, UPSTREAM_ROOT))
    return 0


if __name__ == "__main__":
    main()
