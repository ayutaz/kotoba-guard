"""Prepare and optionally publish one immutable Kotoba Guard preview.

The default operation is local and read-only with respect to GitHub.  It only
packages an already-built extension directory after checking source-bound E2E
and security evidence.  Publishing requires the explicit ``--publish`` flag.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.package_extension import create_zip, verify_zip
from scripts.verify_package import verify_directory


class ReleaseError(ValueError):
    """Raised when a preview cannot be made immutable and source-bound."""


_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"{label}: invalid JSON") from exc
    if not isinstance(value, dict):
        raise ReleaseError(f"{label}: object required")
    return value


def _strict_int(value: Any, label: str) -> int:
    if type(value) is not int:
        raise ReleaseError(f"{label}: integer required")
    return value


def _commit(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(c not in "0123456789abcdef" for c in value.lower())
    ):
        raise ReleaseError(f"{label}: invalid source commit")
    return value


def git_commit(root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-c", f"safe.directory={root.resolve().as_posix()}", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("source: unable to read git commit") from exc


def _source_from_e2e(payload: dict[str, Any]) -> str | None:
    candidates: list[Any] = [payload]
    config = payload.get("config")
    if isinstance(config, dict):
        metadata = config.get("metadata")
        if isinstance(metadata, dict):
            candidates.append(metadata)
    for candidate in candidates:
        for key in ("sourceCommit", "source_commit"):
            value = candidate.get(key) if isinstance(candidate, dict) else None
            if isinstance(value, str):
                return value
    return None


def _check_e2e(path: Path, source_commit: str) -> dict[str, Any]:
    payload = _json(path, "e2e")
    observed = _source_from_e2e(payload)
    if observed is None:
        raise ReleaseError("e2e: source commit missing")
    if observed != source_commit:
        raise ReleaseError("e2e: source commit mismatch")
    stats = payload.get("stats")
    if not isinstance(stats, dict):
        raise ReleaseError("e2e: stats missing")
    for field in ("expected", "unexpected", "skipped", "flaky"):
        _strict_int(stats.get(field), f"e2e: stats {field}")
    if stats["expected"] <= 0 or any(
        stats[field] != 0 for field in ("unexpected", "skipped", "flaky")
    ):
        raise ReleaseError("e2e: gate failed")
    return {
        "path": path.name,
        "sha256": sha256_file(path),
        "source_commit": observed,
        "tests": stats["expected"],
        "unexpected": stats["unexpected"],
    }


def _security_source(payload: dict[str, Any]) -> str | None:
    binding = payload.get("evidenceBinding")
    if isinstance(binding, dict):
        after = binding.get("after")
        if isinstance(after, dict):
            source = after.get("source")
            if isinstance(source, dict) and isinstance(source.get("commit"), str):
                return source["commit"]
    return payload.get("source_commit") if isinstance(payload.get("source_commit"), str) else None


def _distribution_map(value: Any, label: str) -> dict[str, dict[str, int | str]]:
    if not isinstance(value, dict) or not value:
        raise ReleaseError(f"security: {label} distribution missing")
    result: dict[str, dict[str, int | str]] = {}
    for relative, metadata in value.items():
        path = Path(relative) if isinstance(relative, str) else Path(".")
        if (
            not isinstance(relative, str)
            or path.is_absolute()
            or "\\" in relative
            or any(part in ("", ".", "..") for part in relative.split("/"))
        ):
            raise ReleaseError(f"security: unsafe {label} distribution path")
        if (
            not isinstance(metadata, dict)
            or type(metadata.get("bytes")) is not int
            or metadata["bytes"] < 0
            or not isinstance(metadata.get("sha256"), str)
            or not _SHA256.fullmatch(metadata["sha256"])
        ):
            raise ReleaseError(f"security: invalid {label} distribution entry")
        result[relative] = {"bytes": metadata["bytes"], "sha256": metadata["sha256"]}
    return result


def _check_security(path: Path, source_commit: str) -> dict[str, Any]:
    payload = _json(path, "security")
    if payload.get("schemaVersion") != 2:
        raise ReleaseError("security: root schemaVersion 2 required")
    observed = _security_source(payload)
    if observed != source_commit:
        raise ReleaseError("security: source commit mismatch")
    cleanup = payload.get("cleanup")
    operations = cleanup.get("operations") if isinstance(cleanup, dict) else None
    required = {"popup", "monitor", "cdp", "pages", "browser", "context", "fixture", "profile"}
    if (
        not isinstance(cleanup, dict)
        or cleanup.get("schemaVersion") != 3
        or cleanup.get("completed") is not True
    ):
        raise ReleaseError("security: cleanup incomplete")
    if (
        not isinstance(operations, dict)
        or set(operations) != required
        or not all(value is True for value in operations.values())
    ):
        raise ReleaseError("security: cleanup operations incomplete")
    network = payload.get("network")
    unexpected_requests = network.get("unexpectedRequests") if isinstance(network, dict) else None
    if not isinstance(network, dict) or not (
        unexpected_requests == [] or (type(unexpected_requests) is int and unexpected_requests == 0)
    ):
        raise ReleaseError("security: unexpected network requests")
    for section in ("extensionRuntime", "positiveControl"):
        value = payload.get(section)
        if not isinstance(value, dict) or value.get("coverageComplete") is not True:
            raise ReleaseError(f"security: {section} coverage incomplete")
    if payload.get("securityFailures") not in ([], None):
        raise ReleaseError("security: failures present")
    execution = payload.get("execution")
    if not isinstance(execution, dict) or execution.get("status") != "completed":
        raise ReleaseError("security: execution incomplete")
    gate = execution.get("gate")
    if not isinstance(gate, dict) or gate.get("passed") is not True:
        raise ReleaseError("security: gate failed")
    binding = payload.get("evidenceBinding")
    if not isinstance(binding, dict):
        raise ReleaseError("security: evidence binding missing")
    before = binding.get("before")
    after = binding.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ReleaseError("security: before/after binding missing")
    before_source = (
        before.get("source", {}).get("commit") if isinstance(before.get("source"), dict) else None
    )
    after_source = (
        after.get("source", {}).get("commit") if isinstance(after.get("source"), dict) else None
    )
    if before_source != source_commit or after_source != source_commit:
        raise ReleaseError("security: before/after source commit mismatch")
    before_distribution = _distribution_map(before.get("distribution"), "before")
    after_distribution = _distribution_map(after.get("distribution"), "after")
    if before_distribution != after_distribution:
        raise ReleaseError("security: before/after distribution mismatch")
    return {
        "path": path.name,
        "sha256": sha256_file(path),
        "source_commit": observed,
        "schema": payload["schemaVersion"],
        "cleanup_schema": cleanup["schemaVersion"],
        "unexpected_requests": 0,
        "cleanup": "complete",
        "distribution": after_distribution,
        "coverage": {
            "extension_runtime": True,
            "positive_control": True,
        },
        "execution": {"status": "completed", "gate_passed": True},
        "security_failures": [],
    }


def _model_manifest(extension_dir: Path) -> dict[str, Any]:
    path = extension_dir / "models" / "manifest.json"
    payload = _json(path, "model manifest")
    files = payload.get("files")
    if not isinstance(files, dict) or not files:
        raise ReleaseError("model manifest: files missing")
    model = files.get("onnx/model_quantized.onnx")
    if not isinstance(model, dict) or not isinstance(model.get("sha256"), str):
        raise ReleaseError("model manifest: distributed model hash missing")
    model_path = extension_dir / "models" / "onnx" / "model_quantized.onnx"
    if not model_path.is_file() or sha256_file(model_path) != model["sha256"]:
        raise ReleaseError("model manifest: distributed model hash mismatch")
    return payload


def _validate_version(extension_dir: Path, version: str) -> None:
    if not _SEMVER.fullmatch(version):
        raise ReleaseError("version: valid semantic version required")
    manifest = _json(extension_dir / "manifest.json", "extension manifest")
    if manifest.get("version") != version:
        raise ReleaseError("version: extension manifest mismatch")


def _resolved_absolute(path: Path) -> Path:
    return Path.cwd().joinpath(path).absolute() if not path.is_absolute() else path.absolute()


def _has_symlink_ancestor(path: Path) -> bool:
    current = _resolved_absolute(path)
    while True:
        if current.is_symlink():
            return True
        if current.parent == current:
            return False
        current = current.parent


def _paths_overlap(first: Path, second: Path) -> bool:
    left = first.resolve(strict=False)
    right = second.resolve(strict=False)
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


def _zip_inventory(path: Path) -> dict[str, dict[str, int | str]]:
    try:
        with zipfile.ZipFile(path) as archive:
            inventory: dict[str, dict[str, int | str]] = {}
            for info in archive.infolist():
                name = info.filename
                relative = Path(name)
                if (
                    not name
                    or name.endswith("/")
                    or relative.is_absolute()
                    or "\\" in name
                    or any(part in ("", ".", "..") for part in name.split("/"))
                ):
                    raise ReleaseError("package: unsafe ZIP entry")
                content = archive.read(info)
                if name in inventory:
                    raise ReleaseError("package: duplicate ZIP entry")
                inventory[name] = {
                    "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            return inventory
    except zipfile.BadZipFile as exc:
        raise ReleaseError("package: invalid ZIP") from exc


def extract_zip_safely(archive_path: Path, destination: Path) -> None:
    """Extract a bootstrap archive only after checking every member path."""

    if destination.exists() or destination.is_symlink():
        raise ReleaseError("extract: destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            names: set[str] = set()
            for info in members:
                name = info.filename
                relative = Path(name)
                if (
                    not name
                    or name.endswith("/")
                    or name in names
                    or relative.is_absolute()
                    or "\\" in name
                    or any(part in ("", ".", "..") for part in name.split("/"))
                ):
                    raise ReleaseError("extract: unsafe ZIP entry")
                names.add(name)
            destination.mkdir()
            for info in members:
                target = destination / info.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
    except zipfile.BadZipFile as exc:
        raise ReleaseError("extract: invalid ZIP") from exc


def create_release_bundle(release_dir: Path, output: Path) -> dict[str, Any]:
    """Seal a verified release directory for a later read-only workflow job."""

    verify_release(release_dir)
    if output.exists() or output.is_symlink():
        raise ReleaseError(f"bundle: already exists: {output}")
    if _has_symlink_ancestor(output.parent) or _paths_overlap(output, release_dir):
        raise ReleaseError("bundle: path overlap or symlink ancestor")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = _json(release_dir / "release-manifest.json", "release manifest")
    allowlist = manifest.get("allowlist")
    if not isinstance(allowlist, list) or not allowlist:
        raise ReleaseError("bundle: allowlist missing")
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(allowlist):
            path = release_dir / name
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    return {"path": output.name, "bytes": output.stat().st_size, "sha256": sha256_file(output)}


def _write_json(path: Path, payload: object) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _sbom_from_entries(entries: Any, source_commit: str, package_sha: str) -> dict[str, Any]:
    dependencies = []
    if not isinstance(entries, list):
        raise ReleaseError("sbom: dependency license inventory must be a list")
    for entry in entries:
        if not isinstance(entry, dict):
            raise ReleaseError("sbom: dependency entry invalid")
        if entry.get("notBundledReason"):
            continue
        if not entry.get("name") or not entry.get("version"):
            raise ReleaseError("sbom: dependency entry invalid")
        component = {
            "type": "library",
            "name": entry["name"],
            "version": entry["version"],
        }
        if entry.get("license"):
            license_value = entry["license"]
            if not isinstance(license_value, str) or not license_value.strip():
                raise ReleaseError("sbom: dependency license invalid")
            if re.search(r"\s(?:OR|AND|WITH)\s|[()]", license_value):
                component["licenses"] = [{"expression": license_value}]
            else:
                component["licenses"] = [{"license": {"id": license_value}}]
        dependencies.append(component)
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "metadata": {
            "component": {"type": "application", "name": "kotoba-guard", "version": "preview"}
        },
        "components": dependencies,
        "properties": [
            {"name": "kotoba.guard.source_commit", "value": source_commit},
            {"name": "kotoba.guard.package_sha256", "value": package_sha},
        ],
    }


def _sbom(extension_dir: Path, source_commit: str, package_sha: str) -> dict[str, Any]:
    licenses_path = extension_dir / "dependency-licenses.json"
    if not licenses_path.is_file():
        raise ReleaseError("sbom: dependency license inventory missing")
    try:
        entries = json.loads(licenses_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseError("sbom: dependency license inventory invalid") from exc
    return _sbom_from_entries(entries, source_commit, package_sha)


def _ensure_new_directory(path: Path) -> None:
    if path.exists() or path.is_symlink():
        raise ReleaseError(f"output: already exists: {path}")
    if _has_symlink_ancestor(path.parent):
        raise ReleaseError("output: symlink ancestor is not allowed")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir()


def prepare_preview(
    *,
    extension_dir: Path,
    source_commit: str,
    e2e_path: Path,
    security_path: Path,
    output_dir: Path,
    version: str,
    root: Path | None = None,
) -> dict[str, Any]:
    """Package one verified extension twice and write a bounded release record."""

    source_commit = _commit(source_commit, "source")
    extension_dir = extension_dir.resolve()
    if not extension_dir.is_dir():
        raise ReleaseError("extension: directory missing")
    output_candidate = _resolved_absolute(output_dir)
    if (
        _paths_overlap(output_candidate, extension_dir)
        or _paths_overlap(output_candidate, e2e_path)
        or _paths_overlap(output_candidate, security_path)
    ):
        raise ReleaseError("output: path overlap")
    current = git_commit((root or Path.cwd()).resolve())
    if current != source_commit:
        raise ReleaseError("source commit does not match current checkout")
    verify_directory(extension_dir)
    _validate_version(extension_dir, version)
    model_manifest = _model_manifest(extension_dir)
    e2e = _check_e2e(e2e_path.resolve(), source_commit)
    security = _check_security(security_path.resolve(), source_commit)
    package_name = f"kotoba-guard-{version}.zip"
    with tempfile.TemporaryDirectory(prefix="kotoba-release-") as temporary:
        first = Path(temporary) / "first.zip"
        second = Path(temporary) / "second.zip"
        create_zip(extension_dir, first)
        create_zip(extension_dir, second)
        first_sha = sha256_file(first)
        second_sha = sha256_file(second)
        if first.read_bytes() != second.read_bytes():
            raise ReleaseError("package: reproducibility mismatch")
        package_bytes = first.read_bytes()
        package_inventory = _zip_inventory(first)
    if security["distribution"] != package_inventory:
        raise ReleaseError("security: distribution does not match package")
    _ensure_new_directory(output_dir)
    output_dir = output_dir.resolve()
    package = output_dir / package_name
    package.write_bytes(package_bytes)
    package_sha = sha256_file(package)
    verify_zip(package)
    (output_dir / f"{package_name}.sha256").write_text(
        f"{package_sha}  {package_name}\n", encoding="utf-8"
    )
    (output_dir / "model-manifest.json").write_bytes(
        (extension_dir / "models" / "manifest.json").read_bytes()
    )
    _write_json(output_dir / "e2e-evidence.json", e2e)
    security_public = {
        "schema": "kotoba-guard.security-evidence.v1",
        "source_commit": security["source_commit"],
        "audit_schema_version": security["schema"],
        "cleanup": {
            "schema_version": security["cleanup_schema"],
            "completed": True,
            "operations": {
                "popup": True,
                "monitor": True,
                "cdp": True,
                "pages": True,
                "browser": True,
                "context": True,
                "fixture": True,
                "profile": True,
            },
        },
        "execution": security["execution"],
        "coverage": security["coverage"],
        "network": {"unexpected_requests": security["unexpected_requests"]},
        "security_failures": security["security_failures"],
        "distribution": security["distribution"],
    }
    _write_json(output_dir / "security-evidence.json", security_public)
    e2e_public = {
        **e2e,
        "path": "e2e-evidence.json",
        "sha256": sha256_file(output_dir / "e2e-evidence.json"),
    }
    security_public = {
        "path": "security-evidence.json",
        "sha256": sha256_file(output_dir / "security-evidence.json"),
    }
    _write_json(output_dir / "sbom.json", _sbom(extension_dir, source_commit, package_sha))
    summary = {
        "kind": "development_preview",
        "version": version,
        "source_commit": source_commit,
        "package_sha256": package_sha,
        "model_id": model_manifest.get("model_id"),
        "model_revision": model_manifest.get("revision"),
        "model_sha256": model_manifest["files"]["onnx/model_quantized.onnx"]["sha256"],
        "e2e_tests": e2e["tests"],
        "security_unexpected_requests": security["unexpected_requests"],
        "publication": "not performed",
    }
    _write_json(output_dir / "release-summary.json", summary)
    (output_dir / "release-notes.md").write_text(
        "\n".join(
            [
                f"# Kotoba Guard preview {version}",
                "",
                "ローカル推論拡張機能の検証済みプレビューです。",
                "入力文章はこの公開物に含まれません。",
                "",
                f"- Source commit: `{source_commit}`",
                f"- Model: `{model_manifest.get('model_id')}`",
                f"- Model revision: `{model_manifest.get('revision')}`",
                f"- Model SHA-256: `{summary['model_sha256']}`",
                f"- Package SHA-256: `{package_sha}`",
                f"- E2E tests: `{e2e['tests']}`",
                "",
                "精度・速度の一般的な保証を示すものではありません。",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    manifest = {
        "schema": "kotoba-guard.preview-release.v1",
        "version": version,
        "source_commit": source_commit,
        "package": {"path": package.name, "bytes": package.stat().st_size, "sha256": package_sha},
        "model_manifest": {
            "path": "model-manifest.json",
            "sha256": sha256_file(output_dir / "model-manifest.json"),
        },
        "evidence": {"e2e": e2e_public, "security": security_public},
        "reproducibility": {
            "sha256_first": first_sha,
            "sha256_second": second_sha,
            "sha256_match": first_sha == second_sha,
        },
        "allowlist": [
            package.name,
            f"{package_name}.sha256",
            "model-manifest.json",
            "sbom.json",
            "e2e-evidence.json",
            "security-evidence.json",
            "release-summary.json",
            "release-notes.md",
            "release-manifest.json",
        ],
        "publication": "not performed",
    }
    _write_json(output_dir / "release-manifest.json", manifest)
    return manifest


def verify_release(
    output_dir: Path,
    *,
    expected_source_commit: str | None = None,
    expected_version: str | None = None,
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    manifest = _json(output_dir / "release-manifest.json", "release manifest")
    if manifest.get("schema") != "kotoba-guard.preview-release.v1":
        raise ReleaseError("manifest: unsupported schema")
    if (
        expected_source_commit is not None
        and manifest.get("source_commit") != expected_source_commit
    ):
        raise ReleaseError("source: release manifest mismatch")
    if expected_version is not None and manifest.get("version") != expected_version:
        raise ReleaseError("version: release manifest mismatch")
    package_value = manifest.get("package")
    model_value = manifest.get("model_manifest")
    package_name = package_value.get("path") if isinstance(package_value, dict) else None
    model_manifest_name = model_value.get("path") if isinstance(model_value, dict) else None
    if (
        not isinstance(package_name, str)
        or Path(package_name).name != package_name
        or not isinstance(model_manifest_name, str)
        or Path(model_manifest_name).name != model_manifest_name
    ):
        raise ReleaseError("manifest: unsafe artifact path")
    package_meta = manifest.get("package")
    model_meta = manifest.get("model_manifest")
    if not isinstance(package_meta, dict) or not isinstance(model_meta, dict):
        raise ReleaseError("manifest: package metadata missing")
    package_sha = package_meta.get("sha256")
    package_bytes = package_meta.get("bytes")
    model_sha = model_meta.get("sha256")
    if (
        not isinstance(package_sha, str)
        or not _SHA256.fullmatch(package_sha)
        or type(package_bytes) is not int
        or package_bytes < 0
        or not isinstance(model_sha, str)
        or not _SHA256.fullmatch(model_sha)
    ):
        raise ReleaseError("manifest: invalid package metadata")
    _commit(manifest.get("source_commit"), "manifest source")
    if not isinstance(manifest.get("version"), str) or not _SEMVER.fullmatch(manifest["version"]):
        raise ReleaseError("manifest: invalid version")
    package = output_dir / package_name
    if (
        not package.is_file()
        or package.stat().st_size != package_bytes
        or sha256_file(package) != package_sha
    ):
        raise ReleaseError("package: manifest SHA-256 mismatch")
    package_sha_file = output_dir / f"{package.name}.sha256"
    if not package_sha_file.is_file() or package_sha_file.read_text(encoding="utf-8") != (
        f"{package_sha}  {package.name}\n"
    ):
        raise ReleaseError("package: checksum file mismatch")
    model_manifest = output_dir / model_manifest_name
    if not model_manifest.is_file() or sha256_file(model_manifest) != model_sha:
        raise ReleaseError("model manifest: manifest SHA-256 mismatch")
    allowlist_value = manifest.get("allowlist")
    if (
        not isinstance(allowlist_value, list)
        or not allowlist_value
        or any(not isinstance(name, str) for name in allowlist_value)
        or len(set(allowlist_value)) != len(allowlist_value)
    ):
        raise ReleaseError("manifest: invalid allowlist")
    allowed = set(allowlist_value)
    if set(path.name for path in output_dir.iterdir()) != allowed:
        raise ReleaseError("output: unexpected files outside allowlist")
    verify_zip(package)
    with zipfile.ZipFile(package) as archive:
        if archive.read("models/manifest.json") != model_manifest.read_bytes():
            raise ReleaseError("model manifest: package mismatch")
        try:
            package_licenses = json.loads(archive.read("dependency-licenses.json"))
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReleaseError("sbom: package license inventory missing or invalid") from exc
    package_inventory = _zip_inventory(package)
    sbom_path = output_dir / "sbom.json"
    if not sbom_path.is_file():
        raise ReleaseError("sbom: CycloneDX document missing")
    expected_sbom = _sbom_from_entries(package_licenses, manifest["source_commit"], package_sha)
    if _json(sbom_path, "sbom") != expected_sbom:
        raise ReleaseError("sbom: generated document mismatch")
    evidence_root = manifest.get("evidence")
    if not isinstance(evidence_root, dict):
        raise ReleaseError("manifest: evidence missing")
    for name in ("e2e", "security"):
        evidence = evidence_root.get(name, {})
        evidence_path = evidence.get("path") if isinstance(evidence, dict) else None
        evidence_sha = evidence.get("sha256") if isinstance(evidence, dict) else None
        if (
            not isinstance(evidence_path, str)
            or Path(evidence_path).name != evidence_path
            or not isinstance(evidence_sha, str)
            or sha256_file(output_dir / evidence_path) != evidence_sha
        ):
            raise ReleaseError(f"{name}: evidence hash mismatch")
    e2e_evidence = _json(output_dir / "e2e-evidence.json", "e2e evidence")
    if (
        e2e_evidence.get("source_commit") != manifest.get("source_commit")
        or type(e2e_evidence.get("tests")) is not int
        or e2e_evidence.get("tests", 0) <= 0
        or type(e2e_evidence.get("unexpected")) is not int
        or e2e_evidence.get("unexpected") != 0
    ):
        raise ReleaseError("e2e evidence: gate mismatch")
    security_evidence = _json(output_dir / "security-evidence.json", "security evidence")
    security_cleanup = security_evidence.get("cleanup")
    security_execution = security_evidence.get("execution")
    security_coverage = security_evidence.get("coverage")
    security_network = security_evidence.get("network")
    if (
        security_evidence.get("schema") != "kotoba-guard.security-evidence.v1"
        or security_evidence.get("source_commit") != manifest.get("source_commit")
        or security_evidence.get("audit_schema_version") != 2
        or not isinstance(security_cleanup, dict)
        or security_cleanup.get("schema_version") != 3
        or security_cleanup.get("completed") is not True
        or not isinstance(security_execution, dict)
        or security_execution.get("status") != "completed"
        or security_execution.get("gate_passed") is not True
        or not isinstance(security_coverage, dict)
        or security_coverage.get("extension_runtime") is not True
        or security_coverage.get("positive_control") is not True
        or not isinstance(security_network, dict)
        or type(security_network.get("unexpected_requests")) is not int
        or security_network.get("unexpected_requests") != 0
        or security_evidence.get("security_failures") != []
        or security_evidence.get("distribution") != package_inventory
    ):
        raise ReleaseError("security evidence: sanitized binding mismatch")
    operations = security_cleanup.get("operations") if isinstance(security_cleanup, dict) else None
    required_operations = {
        "popup",
        "monitor",
        "cdp",
        "pages",
        "browser",
        "context",
        "fixture",
        "profile",
    }
    if (
        not isinstance(operations, dict)
        or set(operations) != required_operations
        or not all(value is True for value in operations.values())
    ):
        raise ReleaseError("security evidence: cleanup operations incomplete")
    summary = _json(output_dir / "release-summary.json", "release summary")
    model_payload = _json(model_manifest, "model manifest")
    model_files = model_payload.get("files")
    model_entry = (
        model_files.get("onnx/model_quantized.onnx") if isinstance(model_files, dict) else None
    )
    if (
        summary.get("version") != manifest.get("version")
        or summary.get("source_commit") != manifest.get("source_commit")
        or summary.get("package_sha256") != package_sha
        or summary.get("model_id") != model_payload.get("model_id")
        or summary.get("model_revision") != model_payload.get("revision")
        or not isinstance(model_entry, dict)
        or summary.get("model_sha256") != model_entry.get("sha256")
        or type(summary.get("e2e_tests")) is not int
        or summary.get("e2e_tests") != e2e_evidence.get("tests")
        or type(summary.get("security_unexpected_requests")) is not int
        or summary.get("security_unexpected_requests") != 0
        or summary.get("publication") != "not performed"
    ):
        raise ReleaseError("release summary: binding mismatch")
    reproducibility = manifest.get("reproducibility")
    if (
        not isinstance(reproducibility, dict)
        or not isinstance(reproducibility.get("sha256_first"), str)
        or not _SHA256.fullmatch(reproducibility["sha256_first"])
        or not isinstance(reproducibility.get("sha256_second"), str)
        or not _SHA256.fullmatch(reproducibility["sha256_second"])
        or reproducibility.get("sha256_first") != reproducibility.get("sha256_second")
        or reproducibility.get("sha256_first") != package_sha
        or reproducibility.get("sha256_match") is not True
    ):
        raise ReleaseError("reproducibility: binding mismatch")
    notes = output_dir / "release-notes.md"
    if not notes.is_file() or not notes.read_text(encoding="utf-8").startswith(
        "# Kotoba Guard preview"
    ):
        raise ReleaseError("release notes: Markdown document missing")
    if manifest.get("publication") != "not performed":
        raise ReleaseError("publication: release record is not unpublished")
    return {"manifest": manifest, "package": {"path": package.name, "sha256": sha256_file(package)}}


def run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def _not_found(result: subprocess.CompletedProcess[str]) -> bool:
    text = f"{result.stdout}\n{result.stderr}".lower()
    return result.returncode == 1 and any(
        marker in text for marker in ("not found", "not_found", "http 404", "404 not")
    )


def publish_preview(
    output_dir: Path,
    *,
    tag: str,
    title: str,
    publish: bool = False,
    notes_file: Path | None = None,
) -> dict[str, Any]:
    verified = verify_release(output_dir)
    manifest = verified["manifest"]
    version = manifest.get("version")
    if not isinstance(version, str) or tag != f"v{version}":
        raise ReleaseError("tag: must match release version")
    if not publish:
        return {"published": False, "tag": tag, "package_sha256": verified["package"]["sha256"]}
    existing = run_command(["gh", "release", "view", tag, "--json", "tagName,assets"])
    if existing.returncode == 0:
        raise ReleaseError("release or asset already exists")
    if not _not_found(existing):
        raise ReleaseError("unable to check existing release")
    tag_check = run_command(["git", "ls-remote", "--exit-code", "origin", f"refs/tags/{tag}"])
    if tag_check.returncode == 0:
        raise ReleaseError("tag already exists")
    if tag_check.returncode != 2:
        raise ReleaseError("unable to check existing tag")
    package = output_dir / manifest["package"]["path"]
    notes = notes_file or (output_dir / "release-notes.md")
    if not notes.is_file():
        raise ReleaseError("release notes: file missing")
    create = run_command(
        [
            "gh",
            "release",
            "create",
            tag,
            "--draft",
            "--prerelease",
            "--target",
            manifest["source_commit"],
            "--title",
            title,
            "--notes-file",
            str(notes),
            str(package),
            str(output_dir / f"{package.name}.sha256"),
            str(output_dir / "model-manifest.json"),
            str(output_dir / "sbom.json"),
            str(output_dir / "e2e-evidence.json"),
            str(output_dir / "security-evidence.json"),
            str(output_dir / "release-summary.json"),
            str(output_dir / "release-notes.md"),
            str(output_dir / "release-manifest.json"),
        ]
    )
    if create.returncode != 0:
        raise ReleaseError(f"gh release create failed: {create.stderr.strip()}")
    publish_result = run_command(
        ["gh", "release", "edit", tag, "--draft=false", "--prerelease=true"]
    )
    if publish_result.returncode != 0:
        raise ReleaseError(f"gh release publish failed: {publish_result.stderr.strip()}")
    return {"published": True, "tag": tag, "package_sha256": verified["package"]["sha256"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--extension-dir", type=Path, required=True)
    prepare.add_argument("--source-commit", required=True)
    prepare.add_argument("--e2e", type=Path, required=True)
    prepare.add_argument("--security", type=Path, required=True)
    prepare.add_argument("--output-dir", type=Path, required=True)
    prepare.add_argument("--version", required=True)
    prepare.add_argument("--root", type=Path, default=Path("."))
    publish = subparsers.add_parser("publish")
    publish.add_argument("--release-dir", type=Path, required=True)
    publish.add_argument("--tag", required=True)
    publish.add_argument("--title", required=True)
    publish.add_argument("--notes-file", type=Path)
    publish.add_argument("--publish", action="store_true")
    verify = subparsers.add_parser("verify")
    verify.add_argument("--release-dir", type=Path, required=True)
    verify.add_argument("--source-commit")
    verify.add_argument("--version")
    bundle = subparsers.add_parser("bundle")
    bundle.add_argument("--release-dir", type=Path, required=True)
    bundle.add_argument("--output", type=Path, required=True)
    extract = subparsers.add_parser("extract")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare_preview(
                extension_dir=args.extension_dir,
                source_commit=args.source_commit,
                e2e_path=args.e2e,
                security_path=args.security,
                output_dir=args.output_dir,
                version=args.version,
                root=args.root,
            )
        elif args.command == "publish":
            result = publish_preview(
                args.release_dir,
                tag=args.tag,
                title=args.title,
                publish=args.publish,
                notes_file=args.notes_file,
            )
        elif args.command == "verify":
            if args.source_commit is not None:
                _commit(args.source_commit, "source")
            result = verify_release(
                args.release_dir,
                expected_source_commit=args.source_commit,
                expected_version=args.version,
            )
        elif args.command == "bundle":
            result = create_release_bundle(args.release_dir, args.output)
        else:
            extract_zip_safely(args.archive, args.destination)
            result = {"extracted": True}
    except (ReleaseError, OSError, ValueError) as exc:
        print(f"preview_release: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
