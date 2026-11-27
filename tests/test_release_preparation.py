"""Fail-closed release evidence preparation tests."""

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from scripts.prepare_release import PreparationError, prepare_candidate

NAMES = (
    "checks",
    "e2e",
    "security",
    "accuracy",
    "native_ime",
    "native_permission",
    "remote_ci",
)


def _write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _write_package(path: Path, manifest: bytes, model: bytes) -> None:
    files = {
        "manifest.json": json.dumps(
            {
                "manifest_version": 3,
                "permissions": ["activeTab", "scripting", "storage", "offscreen"],
                "content_security_policy": {
                    "extension_pages": (
                        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; "
                        "connect-src 'self'"
                    )
                },
            }
        ).encode(),
        "models/config.json": b"{}",
        "models/tokenizer.json": b"{}",
        "models/tokenizer_config.json": b"{}",
        "models/LICENSE": b"MIT",
        "models/manifest.json": manifest,
        "models/onnx/model_quantized.onnx": model,
        "wasm/runtime.wasm": b"wasm-fixture",
    }
    inventory = {
        name: {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
        for name, value in files.items()
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
        archive.writestr("distribution-manifest.json", json.dumps({"files": inventory}))


def _rewrite_package(path: Path, mutate) -> None:
    with zipfile.ZipFile(path) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    mutate(entries)
    inventory = {
        name: {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
        for name, value in entries.items()
        if name != "distribution-manifest.json"
    }
    entries["distribution-manifest.json"] = json.dumps({"files": inventory}).encode()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)


def _fixture(tmp_path: Path, *, statuses: dict[str, str] | None = None) -> dict:
    statuses = {name: "passed" for name in NAMES} | (statuses or {})
    package = tmp_path / "artifacts" / "package.zip"
    package.parent.mkdir(parents=True)
    model_bytes = b"model"
    model_sha256 = hashlib.sha256(model_bytes).hexdigest()
    model = _write_json(
        tmp_path / "dist" / "extension" / "models" / "manifest.json",
        {
            "model_id": "sbintuitions/ja-typo-detector-modernbert-ja-base-30m",
            "revision": "8d640720bddeb64c89dc1fa7780c3ea29fa523e8",
            "source_license": "mit",
            "files": {
                "onnx/model_quantized.onnx": {
                    "bytes": len(model_bytes),
                    "sha256": model_sha256,
                }
            },
            "sanitization": {"sha256": model_sha256, "removedDebugFields": 1},
        },
    )
    _write_package(package, model.read_bytes(), model_bytes)
    reference_path = tmp_path / "evidence" / "reference-receipt.txt"
    reference_path.parent.mkdir(parents=True, exist_ok=True)
    reference_path.write_text("current reference", encoding="utf-8")
    reference_hash = hashlib.sha256(reference_path.read_bytes()).hexdigest()
    evidence = {}
    for name in NAMES:
        payload = {
            "status": statuses[name],
            "evidence_id": f"{name}-current",
            "source_commit": "a" * 40,
            "scope": f"full-{name}",
            "references": [{"path": "evidence/reference-receipt.txt", "sha256": reference_hash}],
        }
        if name == "accuracy":
            payload["metrics"] = {
                "span_f1": 0.9,
                "precision": 0.95,
                "recall": 0.8,
                "reference_precision": 0.95,
                "reference_recall": 0.8,
                "clean_false_positive_rate": 0.02,
                "clean_items": 1000,
                "quantization_f1_drop": 0.01,
            }
        evidence[name] = _write_json(
            tmp_path / "evidence" / f"{name}.json",
            payload,
        )
    environment = _write_json(
        tmp_path / "evidence" / "environment.json",
        {"os": "test", "source_commit": "a" * 40},
    )
    sbom = _write_json(
        tmp_path / "evidence" / "sbom.json",
        {"bomFormat": "CycloneDX", "source_commit": "a" * 40},
    )
    licenses = _write_json(
        tmp_path / "evidence" / "licenses.json",
        {"licenses": ["MIT"], "source_commit": "a" * 40},
    )
    return {
        "package": package,
        "model": model,
        "evidence": evidence,
        "environment": environment,
        "sbom": sbom,
        "licenses": licenses,
    }


def _prepare(tmp_path: Path, fixture: dict, *, kind: str = "release_candidate") -> Path:
    return prepare_candidate(
        tmp_path,
        kind=kind,
        source={"commit": "a" * 40, "clean": True},
        package_path=fixture["package"],
        model_manifest_path=fixture["model"],
        evidence=fixture["evidence"],
        environment_path=fixture["environment"],
        sbom_path=fixture["sbom"],
        licenses_path=fixture["licenses"],
    )


def test_release_candidate_binds_hashes_and_named_evidence(tmp_path):
    fixture = _fixture(tmp_path)
    output = _prepare(tmp_path, fixture)

    receipt = json.loads((output / "release-candidate.json").read_text(encoding="utf-8"))
    assert receipt["kind"] == "release_candidate"
    assert receipt["acceptance"] == "accepted"
    assert receipt["source"] == {"commit": "a" * 40, "clean": True}
    assert (
        receipt["package"]["sha256"] == hashlib.sha256(fixture["package"].read_bytes()).hexdigest()
    )
    assert set(receipt["evidence"]) == set(NAMES)
    assert receipt["blockers"] == []
    assert (output / "allowlist.json").exists()


def test_snapshot_preserves_unknown_gates_without_calling_them_accepted(tmp_path):
    fixture = _fixture(tmp_path, statuses={name: "unknown" for name in NAMES})
    output = _prepare(tmp_path, fixture, kind="development_snapshot")

    receipt = json.loads((output / "release-candidate.json").read_text(encoding="utf-8"))
    assert receipt["kind"] == "development_snapshot"
    assert receipt["acceptance"] == "blocked"
    assert set(receipt["blockers"]) == {
        *(f"{name}: unknown" for name in NAMES),
        "kind: development snapshot is not a release candidate",
    }


def test_release_candidate_rejects_failed_or_unknown_evidence(tmp_path):
    fixture = _fixture(tmp_path, statuses={"accuracy": "unknown", "remote_ci": "failed"})
    with pytest.raises(PreparationError, match="accuracy: unknown.*remote_ci: failed"):
        _prepare(tmp_path, fixture)
    assert not (tmp_path / "artifacts" / "candidates").exists()


def test_missing_required_evidence_is_a_snapshot_blocker(tmp_path):
    fixture = _fixture(tmp_path)
    del fixture["evidence"]["native_ime"]
    output = _prepare(tmp_path, fixture, kind="development_snapshot")
    receipt = json.loads((output / "release-candidate.json").read_text(encoding="utf-8"))
    assert "native_ime: missing" in receipt["blockers"]


def test_rejects_raw_or_dataset_inputs(tmp_path):
    fixture = _fixture(tmp_path)
    raw = tmp_path / "rawmodels" / "model.onnx"
    raw.parent.mkdir()
    raw.write_bytes(b"raw")
    fixture["evidence"]["accuracy"] = raw
    with pytest.raises(PreparationError, match="allowlist|raw|dataset"):
        _prepare(tmp_path, fixture, kind="development_snapshot")


def test_does_not_overwrite_existing_candidate(tmp_path):
    fixture = _fixture(tmp_path)
    _prepare(tmp_path, fixture, kind="development_snapshot")
    with pytest.raises(PreparationError, match="already exists"):
        _prepare(tmp_path, fixture, kind="development_snapshot")


def test_old_evidence_cannot_be_relabelled_for_current_commit(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["evidence"]["checks"].read_text(encoding="utf-8"))
    payload["source_commit"] = "b" * 40
    fixture["evidence"]["checks"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match="checks: source commit mismatch"):
        _prepare(tmp_path, fixture)


def test_development_snapshot_is_never_accepted_when_all_gates_pass(tmp_path):
    fixture = _fixture(tmp_path)
    output = _prepare(tmp_path, fixture, kind="development_snapshot")
    receipt = json.loads((output / "release-candidate.json").read_text(encoding="utf-8"))
    assert receipt["acceptance"] == "blocked"
    assert "kind: development snapshot is not a release candidate" in receipt["blockers"]


def test_negative_quantization_delta_is_valid_when_finite_and_bounded(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["evidence"]["accuracy"].read_text(encoding="utf-8"))
    payload["metrics"]["quantization_f1_drop"] = -0.1
    fixture["evidence"]["accuracy"].write_text(json.dumps(payload), encoding="utf-8")
    output = _prepare(tmp_path, fixture)
    assert json.loads((output / "release-candidate.json").read_text())["acceptance"] == "accepted"


def test_verified_reference_records_are_stored(tmp_path):
    fixture = _fixture(tmp_path)
    output = _prepare(tmp_path, fixture)
    receipt = json.loads((output / "release-candidate.json").read_text(encoding="utf-8"))
    reference = receipt["evidence"]["checks"]["references"][0]
    assert reference["path"] == "evidence/reference-receipt.txt"
    assert reference["bytes"] == len(b"current reference")
    assert reference["sha256"] == hashlib.sha256(b"current reference").hexdigest()


@pytest.mark.parametrize("mutation,expected", [("hash", "SHA-256 mismatch"), ("path", "missing")])
def test_reference_must_exist_and_match_hash(tmp_path, mutation, expected):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["evidence"]["accuracy"].read_text(encoding="utf-8"))
    if mutation == "hash":
        payload["references"][0]["sha256"] = "0" * 64
    else:
        payload["references"][0]["path"] = "evidence/missing-receipt.txt"
    fixture["evidence"]["accuracy"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match=f"accuracy: reference {expected}"):
        _prepare(tmp_path, fixture)


def test_reference_accuracy_metrics_are_required(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["evidence"]["accuracy"].read_text(encoding="utf-8"))
    del payload["metrics"]["reference_recall"]
    fixture["evidence"]["accuracy"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match="reference_recall invalid"):
        _prepare(tmp_path, fixture)


def test_clean_false_positive_count_must_match_rate(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["evidence"]["accuracy"].read_text(encoding="utf-8"))
    payload["metrics"]["clean_false_positive_items"] = 30
    fixture["evidence"]["accuracy"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match="clean false-positive count"):
        _prepare(tmp_path, fixture)


def test_tampered_zip_model_is_rejected(tmp_path):
    fixture = _fixture(tmp_path)
    entries = {}
    with zipfile.ZipFile(fixture["package"]) as archive:
        for name in archive.namelist():
            entries[name] = archive.read(name)
    entries["models/onnx/model_quantized.onnx"] = b"tampered"
    inventory = json.loads(entries["distribution-manifest.json"])
    inventory["files"]["models/onnx/model_quantized.onnx"] = {
        "bytes": len(entries["models/onnx/model_quantized.onnx"]),
        "sha256": hashlib.sha256(entries["models/onnx/model_quantized.onnx"]).hexdigest(),
    }
    entries["distribution-manifest.json"] = json.dumps(inventory).encode()
    with zipfile.ZipFile(fixture["package"], "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    with pytest.raises(PreparationError, match="model SHA-256 mismatch"):
        _prepare(tmp_path, fixture)


def test_manifest_hash_parity_is_required(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["model"].read_text(encoding="utf-8"))
    payload["sanitization"]["sha256"] = "0" * 64
    fixture["model"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match="quantized and sanitization hashes differ"):
        _prepare(tmp_path, fixture)


def test_model_identity_and_revision_are_pinned(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["model"].read_text(encoding="utf-8"))
    payload["revision"] = "f" * 40
    fixture["model"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match="unexpected revision"):
        _prepare(tmp_path, fixture)


def test_passed_accuracy_with_bad_metrics_is_rejected(tmp_path):
    fixture = _fixture(tmp_path)
    payload = json.loads(fixture["evidence"]["accuracy"].read_text(encoding="utf-8"))
    payload["metrics"]["precision"] = 0.5
    fixture["evidence"]["accuracy"].write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(PreparationError, match="accuracy: metrics"):
        _prepare(tmp_path, fixture)


def test_git_source_scopes_safe_directory_per_command(tmp_path, monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(
            command, 0, "a" * 40 if "rev-parse" in command else "", ""
        )

    monkeypatch.setattr("scripts.prepare_release.subprocess.run", fake_run)
    from scripts.prepare_release import git_source

    assert git_source(tmp_path) == {"commit": "a" * 40, "clean": True}
    expected = f"safe.directory={tmp_path.resolve().as_posix()}"
    assert all(command[0:3] == ["git", "-c", expected] for command in calls)


def test_cli_help_works_when_invoked_by_script_path():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "scripts/prepare_release.py", "--help"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "--kind" in result.stdout


def test_cli_rejects_invalid_named_evidence_with_exit_two():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            sys.executable,
            "scripts/prepare_release.py",
            "--kind",
            "release_candidate",
            "--package",
            "missing.zip",
            "--model-manifest",
            "missing.json",
            "--evidence",
            "not-a-name-path",
        ],
        cwd=root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "evidence" in result.stderr


def test_full_zip_audit_rejects_missing_bundled_asset(tmp_path):
    fixture = _fixture(tmp_path)
    _rewrite_package(fixture["package"], lambda entries: entries.pop("models/config.json"))
    with pytest.raises(PreparationError, match="extension distribution"):
        _prepare(tmp_path, fixture)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda entries: entries.update(
            {
                "manifest.json": json.dumps(
                    {
                        "manifest_version": 3,
                        "host_permissions": ["<all_urls>"],
                    }
                ).encode()
            }
        ),
        lambda entries: entries.update(
            {
                "manifest.json": json.dumps(
                    {
                        "manifest_version": 3,
                        "permissions": ["activeTab"],
                        "content_security_policy": {
                            "extension_pages": (
                                "script-src 'self'; object-src 'self'; connect-src https:"
                            )
                        },
                    }
                ).encode()
            }
        ),
    ],
)
def test_full_zip_audit_rejects_unsafe_manifest(mutation, tmp_path):
    fixture = _fixture(tmp_path)
    _rewrite_package(fixture["package"], mutation)
    with pytest.raises(PreparationError, match="extension distribution"):
        _prepare(tmp_path, fixture)
