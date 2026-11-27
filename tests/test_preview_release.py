"""TDD coverage for the isolated preview release workflow."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.preview_release import (
    ReleaseError,
    _sbom_from_entries,
    create_release_bundle,
    extract_zip_safely,
    prepare_preview,
    publish_preview,
    verify_release,
)

COMMIT = "a" * 40


def _write(path: Path, value: object, *, binary: bool = False) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if binary:
        path.write_bytes(value)  # type: ignore[arg-type]
    else:
        path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _extension(root: Path) -> Path:
    extension = root / "extension"
    _write(
        extension / "manifest.json",
        {
            "manifest_version": 3,
            "version": "0.1.0",
            "permissions": ["activeTab", "scripting", "storage", "offscreen"],
            "content_security_policy": {
                "extension_pages": (
                    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'"
                )
            },
        },
    )
    model = b"model-bytes"
    model_hash = hashlib.sha256(model).hexdigest()
    _write(extension / "models/onnx/model_quantized.onnx", model, binary=True)
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json"):
        _write(extension / f"models/{name}", {})
    _write(extension / "models/LICENSE", b"MIT", binary=True)
    _write(
        extension / "models/manifest.json",
        {
            "model_id": "sbintuitions/ja-typo-detector-modernbert-ja-base-30m",
            "revision": "8d640720bddeb64c89dc1fa7780c3ea29fa523e8",
            "source_license": "mit",
            "files": {"onnx/model_quantized.onnx": {"bytes": len(model), "sha256": model_hash}},
        },
    )
    _write(extension / "wasm/runtime.wasm", b"wasm", binary=True)
    _write(extension / "dependency-licenses.json", [], binary=False)
    inventory = {}
    for path in extension.rglob("*"):
        if path.is_file():
            relative = path.relative_to(extension).as_posix()
            inventory[relative] = {
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
    _write(extension / "distribution-manifest.json", {"files": inventory})
    return extension


def _distribution(extension: Path) -> dict[str, dict[str, int | str]]:
    distribution = {}
    for path in extension.rglob("*"):
        if path.is_file():
            relative = path.relative_to(extension).as_posix()
            distribution[relative] = {
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
    return distribution


def _evidence(root: Path, extension: Path) -> tuple[Path, Path]:
    e2e = _write(
        root / "e2e.json",
        {
            "config": {"metadata": {"sourceCommit": COMMIT}},
            "stats": {"expected": 7, "unexpected": 0, "skipped": 0, "flaky": 0},
        },
    )
    security = _write(
        root / "security.json",
        {
            "schemaVersion": 2,
            "execution": {"status": "completed", "gate": {"passed": True}},
            "evidenceBinding": {
                "before": {"source": {"commit": COMMIT}, "distribution": _distribution(extension)},
                "after": {"source": {"commit": COMMIT}, "distribution": _distribution(extension)},
            },
            "cleanup": {
                "schemaVersion": 3,
                "completed": True,
                "operations": {
                    "popup": True,
                    "monitor": True,
                    "pages": True,
                    "cdp": True,
                    "context": True,
                    "browser": True,
                    "fixture": True,
                    "profile": True,
                },
            },
            "network": {"unexpectedRequests": []},
            "extensionRuntime": {"coverageComplete": True},
            "positiveControl": {"coverageComplete": True},
            "securityFailures": [],
        },
    )
    return e2e, security


def test_prepare_packages_twice_and_writes_only_allowlisted_outputs(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)

    result = prepare_preview(
        extension_dir=extension,
        source_commit=COMMIT,
        e2e_path=e2e,
        security_path=security,
        output_dir=tmp_path / "release",
        version="0.1.0",
    )

    assert result["source_commit"] == COMMIT
    output = tmp_path / "release"
    assert set(path.name for path in output.iterdir()) == {
        "kotoba-guard-0.1.0.zip",
        "kotoba-guard-0.1.0.zip.sha256",
        "model-manifest.json",
        "sbom.json",
        "e2e-evidence.json",
        "security-evidence.json",
        "release-summary.json",
        "release-notes.md",
        "release-manifest.json",
    }
    assert result["reproducibility"]["sha256_match"] is True
    assert verify_release(output)["package"]["sha256"] == result["package"]["sha256"]


def test_prepare_rejects_source_or_gate_mismatch(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    payload = json.loads(e2e.read_text())
    payload["sourceCommit"] = "b" * 40
    e2e.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ReleaseError, match="source commit"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=tmp_path / "release",
            version="0.1.0",
        )


def test_prepare_rejects_existing_output_and_failed_cleanup(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    output = tmp_path / "release"
    output.mkdir()
    with pytest.raises(ReleaseError, match="already exists"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=output,
            version="0.1.0",
        )
    security_payload = json.loads(security.read_text())
    security_payload["cleanup"]["completed"] = False
    security.write_text(json.dumps(security_payload), encoding="utf-8")
    with pytest.raises(ReleaseError, match="cleanup"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=tmp_path / "other-release",
            version="0.1.0",
        )


def test_publish_is_read_only_without_explicit_flag(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    output = tmp_path / "release"
    prepare_preview(
        extension_dir=extension,
        source_commit=COMMIT,
        e2e_path=e2e,
        security_path=security,
        output_dir=output,
        version="0.1.0",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr("scripts.preview_release.run_command", lambda args: calls.append(args))
    result = publish_preview(output, tag="v0.1.0", title="Kotoba Guard", publish=False)
    assert result["published"] is False
    assert calls == []


def test_publish_rejects_existing_release_before_gh_write(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    output = tmp_path / "release"
    prepare_preview(
        extension_dir=extension,
        source_commit=COMMIT,
        e2e_path=e2e,
        security_path=security,
        output_dir=output,
        version="0.1.0",
    )
    monkeypatch.setattr(
        "scripts.preview_release.run_command",
        lambda args: subprocess.CompletedProcess(args, 0, "existing", ""),
    )
    with pytest.raises(ReleaseError, match="already exists"):
        publish_preview(output, tag="v0.1.0", title="Kotoba Guard", publish=True)


def test_publish_checks_404_and_binds_tag_to_source(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    output = tmp_path / "release"
    prepare_preview(
        extension_dir=extension,
        source_commit=COMMIT,
        e2e_path=e2e,
        security_path=security,
        output_dir=output,
        version="0.1.0",
    )
    calls: list[list[str]] = []
    responses = iter(
        [
            subprocess.CompletedProcess([], 1, "", "HTTP 404: release not found"),
            subprocess.CompletedProcess([], 2, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
    )

    def fake_run(args):
        calls.append(args)
        return next(responses)

    monkeypatch.setattr("scripts.preview_release.run_command", fake_run)
    result = publish_preview(output, tag="v0.1.0", title="Kotoba Guard", publish=True)
    assert result["published"] is True
    create_args = calls[2]
    assert "--target" in create_args
    assert create_args[create_args.index("--target") + 1] == COMMIT
    assert str(output / "release-manifest.json") in create_args
    manifest = json.loads((output / "release-manifest.json").read_text())
    asset_args = create_args[create_args.index("--notes-file") + 2 :]
    assert all(str(output / name) in asset_args for name in manifest["allowlist"])


def test_publish_rejects_non_404_release_check_failure(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    output = tmp_path / "release"
    prepare_preview(
        extension_dir=extension,
        source_commit=COMMIT,
        e2e_path=e2e,
        security_path=security,
        output_dir=output,
        version="0.1.0",
    )
    monkeypatch.setattr(
        "scripts.preview_release.run_command",
        lambda args: subprocess.CompletedProcess(args, 1, "", "network error"),
    )
    with pytest.raises(ReleaseError, match="unable to check existing release"):
        publish_preview(output, tag="v0.1.0", title="Kotoba Guard", publish=True)


def test_cli_help_works_from_script_path():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "scripts/preview_release.py", "--help"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "prepare" in result.stdout
    assert "publish" in result.stdout


def test_prepare_rejects_distribution_binding_mismatch(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    payload = json.loads(security.read_text())
    payload["evidenceBinding"]["after"]["distribution"]["manifest.json"]["bytes"] += 1
    security.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ReleaseError, match="distribution"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=tmp_path / "release",
            version="0.1.0",
        )


def test_prepare_rejects_version_or_overlapping_output(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    with pytest.raises(ReleaseError, match="version"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=tmp_path / "release",
            version="1.0",
        )
    with pytest.raises(ReleaseError, match="overlap"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=extension / "release",
            version="0.1.0",
        )


def test_extract_zip_rejects_zip_slip(tmp_path):
    archive = tmp_path / "bad.zip"
    import zipfile

    with zipfile.ZipFile(archive, "w") as handle:
        handle.writestr("../escape.txt", "bad")
    with pytest.raises(ReleaseError, match="unsafe ZIP"):
        extract_zip_safely(archive, tmp_path / "out")


def test_bundle_round_trip_is_verified_and_deterministic(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    release = tmp_path / "release"
    prepare_preview(
        extension_dir=extension,
        source_commit=COMMIT,
        e2e_path=e2e,
        security_path=security,
        output_dir=release,
        version="0.1.0",
    )
    first = create_release_bundle(release, tmp_path / "first-bundle.zip")
    extract_zip_safely(tmp_path / "first-bundle.zip", tmp_path / "unpacked")
    assert verify_release(tmp_path / "unpacked")["manifest"]["source_commit"] == COMMIT
    with pytest.raises(ReleaseError, match="already exists"):
        create_release_bundle(release, tmp_path / "first-bundle.zip")
    assert (
        first["sha256"] == hashlib.sha256((tmp_path / "first-bundle.zip").read_bytes()).hexdigest()
    )


def test_verify_rechecks_e2e_sbom_summary_and_reproducibility(tmp_path, monkeypatch):
    checks = [
        ("e2e-evidence.json", {"source_commit": "b" * 40}, "e2e evidence"),
        (
            "sbom.json",
            {"components": [{"type": "library", "name": "fake", "version": "1"}]},
            "sbom",
        ),
        ("release-summary.json", {"package_sha256": "0" * 64}, "release summary"),
        (
            "release-manifest.json",
            {"reproducibility": {"sha256_match": False}},
            "reproducibility",
        ),
    ]
    for index, (name, change, expected_message) in enumerate(checks):
        case = tmp_path / f"case-{index}"
        extension = _extension(case)
        e2e, security = _evidence(case, extension)
        monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
        output = case / "release"
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=output,
            version="0.1.0",
        )
        path = output / name
        payload = json.loads(path.read_text())
        payload.update(change)
        if name == "e2e-evidence.json":
            path.write_text(json.dumps(payload), encoding="utf-8")
            manifest_path = output / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["evidence"]["e2e"]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        else:
            path.write_text(json.dumps(payload), encoding="utf-8")
        with pytest.raises(ReleaseError, match=expected_message):
            verify_release(output)


def test_sbom_uses_spdx_expressions_and_excludes_unbundled_dependencies():
    sbom = _sbom_from_entries(
        [
            {"name": "bundled", "version": "1.0.0", "license": "MIT"},
            {"name": "expression", "version": "2.0.0", "license": "MIT OR CC0-1.0"},
            {"name": "unbundled", "notBundledReason": "not in extension"},
        ],
        COMMIT,
        "b" * 64,
    )
    assert [component["name"] for component in sbom["components"]] == [
        "bundled",
        "expression",
    ]
    assert sbom["components"][0]["licenses"] == [{"license": {"id": "MIT"}}]
    assert sbom["components"][1]["licenses"] == [{"expression": "MIT OR CC0-1.0"}]


def test_strict_boolean_gates_reject_integer_values(tmp_path, monkeypatch):
    extension = _extension(tmp_path)
    e2e, security = _evidence(tmp_path, extension)
    monkeypatch.setattr("scripts.preview_release.git_commit", lambda _: COMMIT)
    payload = json.loads(security.read_text())
    payload["cleanup"]["operations"]["monitor"] = 1
    security.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ReleaseError, match="operations"):
        prepare_preview(
            extension_dir=extension,
            source_commit=COMMIT,
            e2e_path=e2e,
            security_path=security,
            output_dir=tmp_path / "release",
            version="0.1.0",
        )


def test_workflow_extracts_into_new_destination_and_uses_env_summary():
    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text()
    assert "mkdir -p .cache/bootstrap .cache/release" not in workflow
    assert 'echo "- Source: \\`${{ inputs.source_commit }}\\`"' not in workflow
    assert 'echo "- Version: \\`${{ inputs.version }}\\`"' not in workflow


def test_workflow_validates_input_hashes_before_checkout_and_scopes_token():
    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text()
    prepare_validation = workflow.index("- name: Validate release input hashes")
    prepare_checkout = workflow.index("- name: Check out tested source")
    publish_validation = workflow.index("- name: Validate publish input hashes")
    publish_checkout = workflow.index("- name: Check out release source")
    assert prepare_validation < prepare_checkout
    assert publish_validation < publish_checkout
    assert workflow.count("GH_TOKEN:") == 3
    assert "      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}" not in workflow.splitlines()
