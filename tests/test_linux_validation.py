"""Unit tests for the isolated Linux validation launcher."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from scripts.harness import linux_validation


def test_source_snapshot_rejects_dirty_checkout(tmp_path, monkeypatch):
    monkeypatch.setattr(linux_validation, "ROOT", tmp_path)

    def fake_git(*args, **kwargs):
        assert args[0:2] == ("status", "--porcelain")
        return subprocess.CompletedProcess(args, 0, " M private.txt\n?? secret.txt\n", "")

    monkeypatch.setattr(linux_validation, "_git", fake_git)
    with pytest.raises(RuntimeError, match="clean checkout"):
        linux_validation.source_snapshot(tmp_path / ".cache" / "linux-validation")


def test_source_snapshot_archives_only_clean_head(tmp_path, monkeypatch):
    monkeypatch.setattr(linux_validation, "ROOT", tmp_path)
    calls = []

    def fake_git(*args, **kwargs):
        calls.append(args)
        if args[0:2] == ("status", "--porcelain"):
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0:2] == ("rev-parse", "HEAD"):
            return subprocess.CompletedProcess(args, 0, "abc123\n", "")
        if args[0] == "archive":
            output = Path(
                next(value.split("=", 1)[1] for value in args if value.startswith("--output="))
            )
            output.write_bytes(b"tracked archive")
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError(args)

    monkeypatch.setattr(linux_validation, "_git", fake_git)
    archive, commit = linux_validation.source_snapshot(tmp_path / ".cache" / "linux-validation")
    assert commit == "abc123"
    assert archive.read_bytes() == b"tracked archive"
    assert calls[0][0:2] == ("status", "--porcelain")
    assert calls[-1][0] == "archive"
    assert "--format=tar" in calls[-1]


def test_build_command_uses_archive_and_linux_only_dependency_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(linux_validation, "ROOT", tmp_path)
    upstream = tmp_path / "models" / "upstream" / linux_validation.MODEL_REVISION
    converted = tmp_path / "models" / "converted" / linux_validation.MODEL_REVISION
    upstream.mkdir(parents=True)
    converted.mkdir(parents=True)
    archive = tmp_path / ".cache" / "linux-validation" / "source.tar"
    archive.parent.mkdir(parents=True)
    archive.write_bytes(b"tar")
    config = linux_validation.Config(
        image="kotoba-guard-linux-check:test",
        image_id="",
        cache_dir=tmp_path / ".cache" / "linux-validation",
        playwright_cache=tmp_path / ".cache" / "linux-playwright",
        output_dir=tmp_path / "artifacts" / "linux-check",
        model_root=tmp_path / "models",
        model=True,
        e2e=True,
        package=True,
    )

    command = linux_validation.build_command(config, archive, "abc123")
    rendered = " ".join(command)
    assert command[:4] == ["docker", "run", "--rm", "--cpus"]
    assert "target=/validation/source.tar,readonly" in rendered
    assert "target=/validation/assets/upstream,readonly" in rendered
    assert "target=/validation/assets/converted,readonly" in rendered
    assert "target=/cache/playwright" in rendered
    assert "target=/cache/uv" in rendered
    assert "target=/cache/npm" in rendered
    assert "target=/validation/results" in rendered
    assert "KOTOBA_GUARD_SOURCE_SHA=abc123" in command
    assert "KOTOBA_GUARD_E2E_MODE=real" in command
    assert "SOURCE_COMMIT=abc123" in command
    assert "RUNTIME_SOURCE_COMMIT=abc123" in command
    script = command[-1]
    assert "cp -a /workspace/.venv" in script
    assert "cp -a /workspace/node_modules" in script
    assert "npm ci" in script
    assert "uv sync --locked" in script
    assert "npx playwright install --with-deps chromium" in script
    assert "run_checks.py --model --e2e --package" in script
    assert f"models/upstream/{linux_validation.MODEL_REVISION}" in script
    assert f"models/converted/{linux_validation.MODEL_REVISION}" in script
    assert (config.cache_dir / "uv").is_dir()
    assert (config.cache_dir / "npm").is_dir()
    assert "target=/workspace" not in rendered
    assert str(tmp_path / "node_modules") not in rendered
    assert str(tmp_path / ".venv") not in rendered


def test_parse_args_requires_an_explicit_validation_lane():
    with pytest.raises(SystemExit):
        linux_validation.parse_args([])


def test_quality_only_runs_base_checks_without_model_or_browser():
    config = linux_validation.parse_args(["--quality-only"])
    assert config.quality_only
    assert not (config.model or config.e2e or config.package)
    script = linux_validation._shell_script(config)
    assert script.endswith("uv run --locked python scripts/harness/run_checks.py")
    assert "playwright install" not in script
    assert " --model" not in script
    assert " --e2e" not in script
    assert " --package" not in script


@pytest.mark.parametrize("lane", ["--model", "--e2e", "--package", "--collect-results"])
def test_quality_only_cannot_add_other_validation_lanes(lane, capsys):
    args = ["--quality-only", lane]
    if lane == "--collect-results":
        args.append("output")
    with pytest.raises(SystemExit):
        linux_validation.parse_args(args)
    assert "cannot be combined" in capsys.readouterr().err


def test_parse_args_uses_dedicated_linux_playwright_cache():
    config = linux_validation.parse_args(["--e2e"])
    assert config.e2e is True
    assert config.playwright_cache.name == "linux-playwright"


def test_git_safe_directory_uses_posix_path_for_windows_checkout(monkeypatch):
    class WindowsPathProbe:
        def as_posix(self):
            return "C:/checkout/kotoba-guard"

    monkeypatch.setattr(linux_validation, "ROOT", Path("checkout"))
    monkeypatch.setattr(linux_validation, "_absolute", lambda _path: WindowsPathProbe())
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(linux_validation, "_run", fake_run)
    linux_validation._git("status", "--porcelain")

    assert calls == [
        [
            "git",
            "-c",
            "safe.directory=C:/checkout/kotoba-guard",
            "status",
            "--porcelain",
        ]
    ]


def test_main_sanitizes_git_preflight_failure(monkeypatch, capsys):
    def fail_snapshot(_cache_dir):
        raise subprocess.CalledProcessError(
            128, ["git", "status"], stderr="fatal: dubious ownership"
        )

    monkeypatch.setattr(linux_validation, "source_snapshot", fail_snapshot)

    assert linux_validation.main(["--e2e", "--dry-run"]) == 2
    captured = capsys.readouterr()
    assert "Linux validation preflight failed:" in captured.err
    assert "dubious ownership" in captured.err
    assert "Traceback" not in captured.err


def test_dependency_image_recipe_is_pinned_and_excludes_runtime_assets():
    root = Path(__file__).resolve().parents[1]
    dockerfile = (root / "tools" / "linux-validation" / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (root / ".dockerignore").read_text(encoding="utf-8")

    assert "FROM node:24.15.0-bookworm-slim" in dockerfile
    assert "ARG UV_VERSION=0.12.20" in dockerfile
    assert "uv sync --locked" in dockerfile
    assert "npm ci" in dockerfile
    assert "COPY models" not in dockerfile
    assert "COPY source.tar" not in dockerfile
    assert "*" in dockerignore.splitlines()
    assert "!uv.lock" in dockerignore
    assert "!package-lock.json" in dockerignore
    assert "!packages/core/package.json" in dockerignore
    assert "!models" not in dockerignore
    assert "!node_modules" not in dockerignore


def test_collect_results_preserves_nested_reports_and_browser_failures(tmp_path):
    workspace = tmp_path / "workspace"
    files = {
        "artifacts/checks.json": b'{"ok":false}',
        "artifacts/idle-real/trial/report.json": b'{"status":"failed"}',
        "coverage/coverage-final.json": b"{}",
        "test-results/idle-failure/trace.zip": b"retained trace fixture",
    }
    for name, content in files.items():
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    destination = tmp_path / "results"

    linux_validation.collect_runtime_results(workspace, destination)

    for name, content in files.items():
        relative = name.removeprefix("artifacts/")
        assert (destination / relative).read_bytes() == content
        assert (workspace / name).read_bytes() == content


def test_collect_results_preserves_built_extension_for_cross_os_hash_audit(tmp_path):
    workspace = tmp_path / "workspace"
    files = {
        "artifacts/checks.json": b'{"ok":true}',
        "dist/extension/background.js": b"local runtime fixture",
        "dist/extension/models/onnx/model_quantized.onnx": b"model fixture",
        "dist/extension/distribution-manifest.json": b'{"files":{}}',
    }
    for name, content in files.items():
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    destination = tmp_path / "results"

    linux_validation.collect_runtime_results(workspace, destination)

    for name, content in files.items():
        relative = name.removeprefix("artifacts/").removeprefix("dist/")
        assert (destination / relative).read_bytes() == content
        assert (workspace / name).read_bytes() == content


@pytest.mark.parametrize("relative", ["dist", "dist/extension", "dist/extension/model.onnx"])
def test_collect_results_rejects_extension_or_ancestor_links_before_copy(
    tmp_path, monkeypatch, relative
):
    workspace = tmp_path / "workspace"
    asset = workspace / "dist/extension/model.onnx"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"fixture")
    linked = workspace / relative
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == linked or original(path))
    destination = tmp_path / "results"

    with pytest.raises(ValueError, match="symbolic links"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert not destination.exists()


def test_collect_results_rejects_extension_output_collision_before_copy(tmp_path):
    workspace = tmp_path / "workspace"
    (workspace / "artifacts/extension").mkdir(parents=True)
    (workspace / "dist/extension").mkdir(parents=True)
    destination = tmp_path / "results"

    with pytest.raises(ValueError, match="collide"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert not destination.exists()


def test_collect_results_refuses_existing_evidence(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    destination = tmp_path / "results"
    destination.mkdir()
    previous = destination / "previous.json"
    previous.write_text("retained", encoding="utf-8")

    with pytest.raises(ValueError, match="already contains evidence"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert previous.read_text(encoding="utf-8") == "retained"


def test_main_rejects_existing_result_directory_before_docker(tmp_path, monkeypatch):
    monkeypatch.setattr(linux_validation, "ROOT", tmp_path)
    monkeypatch.setattr(
        linux_validation, "source_snapshot", lambda _cache: (tmp_path / "source.tar", "abc123")
    )
    monkeypatch.setattr(linux_validation, "_verify_image", lambda _config: "image-id")
    destination = tmp_path / "results"
    (destination / "abc123").mkdir(parents=True)
    marker = destination / "abc123" / "previous.json"
    marker.write_text("retained", encoding="utf-8")
    monkeypatch.setattr(
        linux_validation,
        "build_command",
        lambda *_args: pytest.fail("must not launch or prepare Docker"),
    )

    assert linux_validation.main(["--e2e", "--output-dir", str(destination)]) == 2
    assert marker.read_text(encoding="utf-8") == "retained"


def test_result_export_mode_copies_without_git_or_docker(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    artifact = workspace / "artifacts" / "nested" / "report.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"fixture")
    destination = tmp_path / "results"
    monkeypatch.setattr(linux_validation, "ROOT", workspace)
    monkeypatch.setattr(
        linux_validation, "source_snapshot", lambda *_args: pytest.fail("export does not snapshot")
    )

    assert linux_validation.main(["--collect-results", str(destination)]) == 0
    assert (destination / "nested" / "report.json").read_bytes() == b"fixture"


def test_result_export_failure_is_nonzero(tmp_path, monkeypatch, capsys):
    def fail_export(*_args):
        raise OSError("fixture failure containing private-path-marker")

    monkeypatch.setattr(linux_validation, "collect_runtime_results", fail_export)
    assert linux_validation.main(["--collect-results", str(tmp_path / "result")]) == 2
    error = capsys.readouterr().err
    assert "not fully collected" in error
    assert "private-path-marker" not in error


def test_result_export_cannot_start_validation():
    with pytest.raises(SystemExit):
        linux_validation.parse_args(["--collect-results", "results", "--e2e"])


def test_result_export_rejects_recursive_destination(tmp_path):
    with pytest.raises(ValueError, match="outside"):
        linux_validation.collect_runtime_results(tmp_path, tmp_path / "results")


def test_result_export_refuses_symbolic_links_before_copy(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    artifact = workspace / "artifacts" / "link"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"fixture")
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == artifact or original(path))
    destination = tmp_path / "results"

    with pytest.raises(ValueError, match="symbolic links"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert not destination.exists()


def test_result_export_refuses_colliding_names_before_copy(tmp_path):
    workspace = tmp_path / "workspace"
    (workspace / "artifacts" / "coverage").mkdir(parents=True)
    (workspace / "coverage").mkdir()
    destination = tmp_path / "results"

    with pytest.raises(ValueError, match="collide"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert not destination.exists()


@pytest.mark.parametrize("empty_directories", [False, True])
def test_result_export_refuses_missing_or_empty_evidence(tmp_path, empty_directories):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    if empty_directories:
        for name in ("artifacts", "coverage", "test-results"):
            (workspace / name).mkdir()
    destination = tmp_path / "results"
    with pytest.raises(ValueError, match="no evidence files"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert not destination.exists()


def test_result_export_refuses_link_destination_before_resolving(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    artifact = workspace / "artifacts" / "report.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"fixture")
    destination = tmp_path / "results"
    destination.mkdir()
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == destination or original(path))
    with pytest.raises(ValueError, match="destination symbolic link"):
        linux_validation.collect_runtime_results(workspace, destination)
    assert list(destination.iterdir()) == []
