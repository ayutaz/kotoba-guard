"""Prepare a bound, fail-closed release evidence snapshot.

This tool only writes a receipt and an allowlist.  It does not build, test,
publish, copy model weights, or overwrite the historical artifacts directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.package_extension import verify_zip
from scripts.verify_package import verify_directory

EXPECTED_MODEL_ID = "sbintuitions/ja-typo-detector-modernbert-ja-base-30m"
EXPECTED_MODEL_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
REQUIRED_EVIDENCE = (
    "checks",
    "e2e",
    "security",
    "accuracy",
    "native_ime",
    "native_permission",
    "remote_ci",
)
_FORBIDDEN_PARTS = {"raw", "rawmodels", "rawdatasets", "datasets", "converted", "upstream"}
_SHA256_LENGTH = 64
_ACCURACY_THRESHOLDS = {
    "precision": 0.95,
    "recall": 0.80,
    "clean_false_positive_rate": 0.02,
    "clean_items": 1000,
    "quantization_f1_drop": 0.01,
}


class PreparationError(ValueError):
    """Raised when release evidence cannot be bound without making a claim."""


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == _SHA256_LENGTH
        and all(character in "0123456789abcdef" for character in value.lower())
    )


def sha256_file(path: Path) -> str:
    """Return a streaming SHA-256 digest for *path*."""

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreparationError(f"{label}: invalid JSON ({path})") from exc


def _inside(root: Path, path: Path, label: str) -> Path:
    root = root.resolve()
    candidate = path if path.is_absolute() else root / path
    try:
        resolved = candidate.resolve(strict=False)
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise PreparationError(f"{label}: path is outside repository") from exc
    parts = {part.lower() for part in relative.parts}
    if parts & _FORBIDDEN_PARTS:
        raise PreparationError(f"{label}: raw/model/dataset path is not on the allowlist")
    return resolved


def _file_record(root: Path, path: Path, label: str, blockers: list[str]) -> dict[str, Any]:
    resolved = _inside(root, path, label)
    record: dict[str, Any] = {"path": resolved.relative_to(root.resolve()).as_posix()}
    if not resolved.is_file():
        record["status"] = "missing"
        blockers.append(f"{label}: missing")
        return record
    record.update({"bytes": resolved.stat().st_size, "sha256": sha256_file(resolved)})
    return record


def _source(source: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    blockers: list[str] = []
    commit = source.get("commit")
    clean = source.get("clean")
    if (
        not isinstance(commit, str)
        or len(commit) != 40
        or any(character not in "0123456789abcdef" for character in commit.lower())
    ):
        blockers.append("source: invalid commit")
    if clean is not True:
        blockers.append("source: dirty")
    return {"commit": commit, "clean": clean}, blockers


def git_source(root: Path) -> dict[str, Any]:
    """Read the current commit and worktree cleanliness without mutating Git."""

    root = root.resolve()
    safe_directory = f"safe.directory={root.as_posix()}"
    try:
        commit = subprocess.run(
            ["git", "-c", safe_directory, "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-c", safe_directory, "status", "--porcelain", "--untracked-files=all"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise PreparationError("source: unable to read Git commit and cleanliness") from exc
    return {"commit": commit, "clean": not bool(status.strip())}


def _model_record(root: Path, path: Path, blockers: list[str]) -> dict[str, Any]:
    record = _file_record(root, path, "model_manifest", blockers)
    if record.get("status") == "missing":
        return record
    payload = _json(root / record["path"], "model_manifest")
    if not isinstance(payload, dict):
        blockers.append("model_manifest: object required")
        return record
    for field in ("model_id", "revision", "source_license", "files", "sanitization"):
        if not payload.get(field):
            blockers.append(f"model_manifest: missing {field}")
    if payload.get("model_id") != EXPECTED_MODEL_ID:
        blockers.append("model_manifest: unexpected model_id")
    if payload.get("revision") != EXPECTED_MODEL_REVISION:
        blockers.append("model_manifest: unexpected revision")
    files = payload.get("files")
    quantized = files.get("onnx/model_quantized.onnx") if isinstance(files, dict) else None
    if not isinstance(quantized, dict) or not _is_sha256(quantized.get("sha256")):
        blockers.append("model_manifest: missing sanitized quantized model hash")
    sanitization = payload.get("sanitization")
    if not isinstance(sanitization, dict) or not _is_sha256(sanitization.get("sha256")):
        blockers.append("model_manifest: missing sanitization hash")
    elif isinstance(quantized, dict) and quantized.get("sha256") != sanitization.get("sha256"):
        blockers.append("model_manifest: quantized and sanitization hashes differ")
    record["model_id"] = payload.get("model_id")
    record["revision"] = payload.get("revision")
    record["source_license"] = payload.get("source_license")
    record["distributed_model_sha256"] = (
        quantized.get("sha256") if isinstance(quantized, dict) else None
    )
    record["sanitized_model_sha256"] = (
        sanitization.get("sha256") if isinstance(sanitization, dict) else None
    )
    return record


def _package_record(
    root: Path,
    path: Path,
    model_manifest_path: Path,
    blockers: list[str],
) -> dict[str, Any]:
    """Verify the ZIP and its distributed model entries without extraction."""

    record = _file_record(root, path, "package", blockers)
    if record.get("status") == "missing":
        return record
    package = root / record["path"]
    manifest = root / _inside(root, model_manifest_path, "model_manifest").relative_to(root)
    audit_root: Path | None = None
    try:
        verify_zip(package)
        with zipfile.ZipFile(package) as archive:
            if len(archive.infolist()) > 1000:
                raise ValueError("too many ZIP entries")
            total_size = 0
            for info in archive.infolist():
                name = info.filename
                if (
                    not name
                    or "\\" in name
                    or "\x00" in name
                    or name.startswith("/")
                    or PurePosixPath(name).is_absolute()
                    or PureWindowsPath(name).drive
                    or ".." in PurePosixPath(name).parts
                    or "." in PurePosixPath(name).parts
                ):
                    raise ValueError("unsafe ZIP path")
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise ValueError("ZIP symlink is forbidden")
                total_size += info.file_size
            if total_size > 200 * 1024 * 1024:
                raise ValueError("ZIP expanded size exceeds 200 MiB")
            packaged_manifest = archive.read("models/manifest.json")
            if packaged_manifest != manifest.read_bytes():
                blockers.append("package: model manifest mismatch")
            payload = json.loads(packaged_manifest.decode("utf-8"))
            expected = payload["files"]["onnx/model_quantized.onnx"]
            model_bytes = archive.read("models/onnx/model_quantized.onnx")
            if len(model_bytes) != expected["bytes"]:
                blockers.append("package: model byte size mismatch")
            if sha256_file_from_bytes(model_bytes) != expected["sha256"]:
                blockers.append("package: model SHA-256 mismatch")
            cache_root = (root / ".cache").resolve()
            if not cache_root.is_relative_to(root):
                raise ValueError("audit cache escapes repository")
            cache_root.mkdir(parents=True, exist_ok=True)
            audit_root = Path(tempfile.mkdtemp(prefix="release-package-", dir=cache_root))
            archive.extractall(audit_root)
        verify_directory(audit_root)
    except (
        OSError,
        KeyError,
        TypeError,
        ValueError,
        UnicodeDecodeError,
        zipfile.BadZipFile,
    ) as exc:
        blockers.append(f"package: invalid ZIP/model/extension distribution ({exc})")
    finally:
        if audit_root is not None:
            shutil.rmtree(audit_root, ignore_errors=True)
    return record


def sha256_file_from_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _evidence_record(
    root: Path,
    name: str,
    path: Path | None,
    source_commit: str,
    blockers: list[str],
) -> dict[str, Any]:
    if path is None:
        blockers.append(f"{name}: missing")
        return {"status": "missing"}
    record = _file_record(root, path, name, blockers)
    if record.get("status") == "missing":
        return record
    payload = _json(root / record["path"], name)
    if not isinstance(payload, dict):
        blockers.append(f"{name}: invalid")
        return record
    status = payload.get("status")
    if status not in {"passed", "failed", "unknown"}:
        blockers.append(f"{name}: invalid status")
    elif status != "passed":
        blockers.append(f"{name}: {status}")
    if payload.get("source_commit") != source_commit:
        blockers.append(f"{name}: source commit mismatch")
    if not isinstance(payload.get("evidence_id"), str) or not payload["evidence_id"]:
        blockers.append(f"{name}: missing evidence_id")
    if not isinstance(payload.get("scope"), str) or not payload["scope"]:
        blockers.append(f"{name}: missing scope")
    references = payload.get("references")
    verified_references: list[dict[str, Any]] = []
    if not isinstance(references, list) or not references:
        blockers.append(f"{name}: missing references")
    else:
        for reference in references:
            if not isinstance(reference, dict):
                blockers.append(f"{name}: reference invalid")
                continue
            reference_path = reference.get("path")
            expected_hash = reference.get("sha256")
            if not isinstance(reference_path, str) or not _is_sha256(expected_hash):
                blockers.append(f"{name}: reference invalid")
                continue
            try:
                resolved_reference = _inside(root, Path(reference_path), f"{name}: reference")
            except PreparationError:
                blockers.append(f"{name}: reference path invalid")
                continue
            if not resolved_reference.is_file():
                blockers.append(f"{name}: reference missing")
                continue
            actual_hash = sha256_file(resolved_reference)
            if actual_hash != expected_hash:
                blockers.append(f"{name}: reference SHA-256 mismatch")
                continue
            verified_references.append(
                {
                    "path": resolved_reference.relative_to(root.resolve()).as_posix(),
                    "bytes": resolved_reference.stat().st_size,
                    "sha256": actual_hash,
                }
            )
    if name == "accuracy" and not isinstance(payload.get("metrics"), dict):
        blockers.append("accuracy: missing metrics")
    if name == "accuracy" and isinstance(payload.get("metrics"), dict):
        metrics = payload["metrics"]
        for metric, threshold in _ACCURACY_THRESHOLDS.items():
            value = metrics.get(metric)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or (metric == "clean_items" and not isinstance(value, int))
            ):
                blockers.append(f"accuracy: metrics {metric} invalid")
                continue
            if metric in {"precision", "recall"} and not 0 <= value <= 1:
                blockers.append(f"accuracy: metrics {metric} out of range")
            elif metric == "clean_false_positive_rate" and not 0 <= value <= 1:
                blockers.append("accuracy: metrics clean_false_positive_rate out of range")
            elif metric == "clean_items" and value < threshold:
                blockers.append("accuracy: metrics clean_items below 1000")
            elif metric == "quantization_f1_drop" and not -1 <= value <= 1:
                blockers.append("accuracy: metrics quantization_f1_drop out of range")
            elif metric in {"precision", "recall"} and value < threshold:
                blockers.append(f"accuracy: metrics {metric} below threshold")
            elif metric == "clean_false_positive_rate" and value > threshold:
                blockers.append("accuracy: metrics clean_false_positive_rate above threshold")
            elif metric == "quantization_f1_drop" and value > threshold:
                blockers.append("accuracy: metrics quantization_f1_drop above threshold")
        for metric in ("reference_precision", "reference_recall"):
            value = metrics.get(metric)
            threshold = _ACCURACY_THRESHOLDS[metric.removeprefix("reference_")]
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 1
                or value < threshold
            ):
                blockers.append(f"accuracy: metrics {metric} invalid")
        false_positive_count = metrics.get("clean_false_positive_items")
        if false_positive_count is not None:
            rate = metrics.get("clean_false_positive_rate")
            clean_items = metrics.get("clean_items")
            if (
                isinstance(false_positive_count, bool)
                or not isinstance(false_positive_count, int)
                or false_positive_count < 0
                or not isinstance(rate, (int, float))
                or not math.isfinite(rate)
                or not isinstance(clean_items, int)
                or clean_items <= 0
                or not math.isclose(
                    false_positive_count / clean_items, rate, rel_tol=1e-9, abs_tol=1e-12
                )
            ):
                blockers.append("accuracy: clean false-positive count/rate inconsistent")
    record["status"] = status
    record["evidence_id"] = payload.get("evidence_id")
    record["source_commit"] = payload.get("source_commit")
    record["scope"] = payload.get("scope")
    record["references"] = verified_references
    return record


def _metadata_record(
    root: Path,
    path: Path | None,
    label: str,
    source_commit: str,
    blockers: list[str],
) -> dict[str, Any]:
    if path is None:
        blockers.append(f"{label}: missing")
        return {"status": "missing"}
    record = _file_record(root, path, label, blockers)
    if record.get("status") == "missing":
        return record
    payload = _json(root / record["path"], label)
    if not isinstance(payload, (dict, list)) or not payload:
        blockers.append(f"{label}: invalid")
    elif label == "sbom" and (not isinstance(payload, dict) or not payload.get("bomFormat")):
        blockers.append("sbom: CycloneDX bomFormat required")
    elif label == "licenses" and not isinstance(payload, (dict, list)):
        blockers.append("licenses: list or object required")
    if not isinstance(payload, dict) or payload.get("source_commit") != source_commit:
        blockers.append(f"{label}: source commit mismatch")
    return record


def prepare_candidate(
    root: Path,
    *,
    kind: str,
    source: Mapping[str, Any] | None = None,
    package_path: Path,
    model_manifest_path: Path,
    evidence: Mapping[str, Path],
    environment_path: Path | None,
    sbom_path: Path | None,
    licenses_path: Path | None,
    output_root: Path | None = None,
) -> Path:
    """Validate and write one immutable candidate receipt.

    A development snapshot may be written with blockers, but it is always
    marked ``blocked``.  An accepted release candidate requires every named
    gate and all provenance metadata to pass.
    """

    if kind not in {"development_snapshot", "release_candidate"}:
        raise PreparationError(f"kind: unsupported value {kind!r}")
    root = root.resolve()
    source_record, blockers = _source(source or git_source(root))
    commit = source_record.get("commit")
    if not isinstance(commit, str) or len(commit) != 40:
        raise PreparationError("source: cannot create candidate without a commit")
    if set(evidence) - set(REQUIRED_EVIDENCE):
        unknown = sorted(set(evidence) - set(REQUIRED_EVIDENCE))
        raise PreparationError(f"evidence: unknown names {unknown}")

    package = _package_record(root, package_path, model_manifest_path, blockers)
    model = _model_record(root, model_manifest_path, blockers)
    evidence_records = {
        name: _evidence_record(root, name, evidence.get(name), commit, blockers)
        for name in REQUIRED_EVIDENCE
    }
    metadata = {
        "environment": _metadata_record(root, environment_path, "environment", commit, blockers),
        "sbom": _metadata_record(root, sbom_path, "sbom", commit, blockers),
        "licenses": _metadata_record(root, licenses_path, "licenses", commit, blockers),
    }
    if kind == "development_snapshot":
        blockers.append("kind: development snapshot is not a release candidate")
    blockers = sorted(dict.fromkeys(blockers))
    if kind == "release_candidate" and blockers:
        raise PreparationError("release candidate blocked: " + ", ".join(blockers))

    destination_root = (output_root or root / "artifacts" / "candidates").resolve()
    expected_root = (root / "artifacts" / "candidates").resolve()
    if destination_root != expected_root:
        raise PreparationError("output: must be artifacts/candidates under repository")
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = destination_root / commit
    if destination.exists():
        raise PreparationError(f"candidate destination already exists: {destination}")
    destination.mkdir()
    allowlist = {
        "package": package,
        "model_manifest": model,
        "evidence": evidence_records,
        "environment": metadata["environment"],
        "sbom": metadata["sbom"],
        "licenses": metadata["licenses"],
    }
    receipt = {
        "schema": "kotoba-guard.release-candidate.v1",
        "kind": kind,
        "acceptance": "accepted" if kind == "release_candidate" and not blockers else "blocked",
        "source": source_record,
        "package": package,
        "model": model,
        "evidence": evidence_records,
        "metadata": metadata,
        "blockers": blockers,
        "publication": "not performed",
    }
    (destination / "allowlist.json").write_text(
        json.dumps(allowlist, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (destination / "release-candidate.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return destination


def _parse_evidence(values: list[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for value in values:
        name, separator, path = value.partition("=")
        if not separator or name not in REQUIRED_EVIDENCE or not path or name in result:
            raise PreparationError(f"evidence: expected one unique NAME=PATH for {value!r}")
        result[name] = Path(path)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument(
        "--kind", choices=("development_snapshot", "release_candidate"), required=True
    )
    parser.add_argument("--package", dest="package_path", type=Path, required=True)
    parser.add_argument("--model-manifest", type=Path, required=True)
    parser.add_argument("--evidence", action="append", default=[], metavar="NAME=PATH")
    parser.add_argument("--environment", type=Path)
    parser.add_argument("--sbom", type=Path)
    parser.add_argument("--licenses", type=Path)
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args(argv)
    try:
        destination = prepare_candidate(
            args.root,
            kind=args.kind,
            package_path=args.package_path,
            model_manifest_path=args.model_manifest,
            evidence=_parse_evidence(args.evidence),
            environment_path=args.environment,
            sbom_path=args.sbom,
            licenses_path=args.licenses,
            output_root=args.output_root,
        )
    except PreparationError as exc:
        print(f"prepare_release: {exc}", file=sys.stderr)
        return 2
    print((destination / "release-candidate.json").as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
