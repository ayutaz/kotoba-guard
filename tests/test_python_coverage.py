"""Fail-closed tests for the Python coverage driver."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.harness import python_coverage as driver
from scripts.harness.python_coverage import (
    CoveragePreparationError,
    _git_source,
    _write_command_failure_report,
    command_plan,
    evaluate_coverage,
    execute_commands,
    source_inventory,
)


def test_repository_coverage_inventory_includes_every_python_source():
    inventory = source_inventory(Path(__file__).resolve().parents[1])
    assert inventory["missing_files"] == []
    assert inventory["unexpected_files"] == []


def test_command_failure_is_not_hidden(tmp_path):
    def failed_runner(command, **kwargs):
        return type("Result", (), {"returncode": 7, "stdout": "out", "stderr": "err"})()

    with pytest.raises(CoveragePreparationError, match="exit 7"):
        execute_commands(
            tmp_path,
            tmp_path / "coverage",
            {"unit": [["fake", "unit"]]},
            runner=failed_runner,
        )
    result = json.loads((tmp_path / "coverage" / "commands.json").read_text(encoding="utf-8"))
    assert result["results"][0]["exitCode"] == 7


def test_process_launch_failure_is_recorded_like_other_failures(tmp_path):
    def unavailable(*args, **kwargs):
        raise FileNotFoundError("test executable unavailable")

    output = tmp_path / "output"
    with pytest.raises(CoveragePreparationError, match="exit 127"):
        execute_commands(tmp_path, output, {"unit": [["missing"]]}, runner=unavailable)
    result = json.loads((output / "commands.json").read_text(encoding="utf-8"))
    assert result["results"][0]["exitCode"] == 127
    assert "launch error" in (output / "unit-0.log").read_text(encoding="utf-8")


@pytest.mark.parametrize("stage", ["combine", "json"])
def test_coverage_processing_launch_failure_persists_report(tmp_path, monkeypatch, stage):
    monkeypatch.setattr(driver, "_git_source", lambda root: {"commit": "a" * 40, "clean": True})
    monkeypatch.setattr(
        driver,
        "source_inventory",
        lambda root: {"files": [], "missing_files": [], "unexpected_files": [], "exclusions": []},
    )
    monkeypatch.setattr(driver, "_prepare_model_sandbox", lambda root, output: root)
    monkeypatch.setattr(driver, "execute_commands", lambda *args, **kwargs: [])

    def unavailable(command, **kwargs):
        if stage in command:
            raise FileNotFoundError("test executable unavailable")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(driver.subprocess, "run", unavailable)
    output = tmp_path / "artifacts/coverage/measurement"
    with pytest.raises(CoveragePreparationError, match="exit 127"):
        driver.run_coverage(tmp_path, output)
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert "127" in report["coverage_processing_error"]


def test_command_failure_persists_report_and_phase_results(tmp_path):
    output = tmp_path / "coverage"
    calls = 0

    def failed_runner(command, **kwargs):
        nonlocal calls
        calls += 1
        code = 0 if calls == 1 else 9
        return type("Result", (), {"returncode": code, "stdout": "", "stderr": ""})()

    with pytest.raises(CoveragePreparationError):
        execute_commands(
            tmp_path,
            output,
            {"unit": [["unit"]], "integration": [["integration"]]},
            runner=failed_runner,
        )
    report = _write_command_failure_report(
        output,
        {"commit": "test", "clean": True},
        {"files": [], "missing_files": [], "unexpected_files": [], "exclusions": []},
        80.0,
        CoveragePreparationError("integration[0] exit 9"),
    )
    persisted = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert persisted["phase_results"]["integration"][0]["exitCode"] == 9


def test_integration_commands_use_isolated_phase_root(tmp_path):
    seen = []

    def successful_runner(command, **kwargs):
        seen.append(kwargs["cwd"])
        return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    execute_commands(
        tmp_path,
        tmp_path / "coverage",
        {"unit": [["unit"]], "integration": [["integration"]]},
        phase_roots={"integration": tmp_path / "sandbox"},
        runner=successful_runner,
    )
    assert seen == [tmp_path, tmp_path / "sandbox"]


def test_isolated_real_coverage_runs_share_branch_configuration(tmp_path):
    from coverage import CoverageData

    (tmp_path / "pyproject.toml").write_text(
        '[tool.coverage.run]\nbranch = true\nsource = ["scripts"]\nparallel = true\n',
        encoding="utf-8",
    )
    sandbox = tmp_path / "sandbox"
    for directory in (tmp_path, sandbox):
        (directory / "scripts").mkdir(parents=True)
        (directory / "scripts" / "sample.py").write_text(
            "import sys\nif len(sys.argv) > 1:\n    result = 1\nelse:\n    result = 0\n",
            encoding="utf-8",
        )
    output = tmp_path / "measurements"
    command = [sys.executable, "-m", "coverage", "run", "--parallel-mode", "scripts/sample.py"]
    execute_commands(
        tmp_path,
        output,
        {"unit": [command], "integration": [[*command, "argument"]]},
        phase_roots={"integration": sandbox},
    )
    fragments = list(output.glob(".coverage.*"))
    assert len(fragments) == 2
    for fragment in fragments:
        data = CoverageData(basename=str(fragment))
        data.read()
        assert data.has_arcs(), fragment.name


def test_frozen_integration_plan_includes_fp16_for_evaluation(tmp_path):
    integration = command_plan(tmp_path)["integration"]
    assert any(command[-1] == "scripts/generate_icons.py" for command in integration)
    assert any(command[-2:] == ["scripts/model_pipeline.py", "convert"] for command in integration)
    assert any(
        command[-2:] == ["scripts/evaluation.py", "--check-conversion"] for command in integration
    )


def test_unit_phase_never_reuses_another_measurements_pytest_directory(tmp_path):
    commands = [command_plan(tmp_path / name)["unit"][0] for name in ("first", "second")]
    paths = [
        Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--basetemp=")))
        for command in commands
    ]
    assert paths[0] != paths[1]
    for path in paths:
        assert path.is_relative_to(Path(__file__).resolve().parents[1] / ".cache")
        assert "pytest-coverage-harness" not in str(path)


def test_new_measurement_can_start_real_pytest_with_no_temp_parent(tmp_path, monkeypatch):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_fixture.py").write_text(
        "def test_writable_temp(tmp_path):\n    (tmp_path / 'marker').write_text('ok')\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(driver, "_git_source", lambda root: {"commit": "a" * 40, "clean": True})
    monkeypatch.setattr(
        driver,
        "source_inventory",
        lambda root: {"files": [], "missing_files": [], "unexpected_files": [], "exclusions": []},
    )
    monkeypatch.setattr(driver, "_prepare_model_sandbox", lambda root, output: root)
    output = tmp_path / "artifacts/coverage/measurement"
    monkeypatch.setattr(
        driver,
        "command_plan",
        lambda output, **kwargs: {
            "unit": [
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    "-q",
                    "tests",
                    f"--basetemp={driver._pytest_temp(tmp_path, output)}",
                ]
            ]
        },
    )

    def unit_only(root, target, plan, **kwargs):
        execute_commands(root, target, plan)
        raise CoveragePreparationError("unit fixture completed")

    monkeypatch.setattr(driver, "execute_commands", unit_only)
    with pytest.raises(CoveragePreparationError, match="unit fixture completed"):
        driver.run_coverage(tmp_path, output)
    commands = json.loads((output / "commands.json").read_text(encoding="utf-8"))
    assert commands["results"][0]["exitCode"] == 0
    assert "1 passed" in (output / "unit-0.log").read_text(encoding="utf-8")


def test_model_assets_are_prepared_before_conversion_evaluation(tmp_path):
    commands = command_plan(tmp_path)["integration"]
    manifest_index = next(
        index
        for index, command in enumerate(commands)
        if command[-2:] == ["scripts/model_pipeline.py", "manifest"]
    )
    evaluation_index = next(
        index
        for index, command in enumerate(commands)
        if command[-2:] == ["scripts/evaluation.py", "--check-conversion"]
    )
    assert manifest_index < evaluation_index


def test_omitted_declared_python_file_is_explicit_and_fails(tmp_path):
    source = tmp_path / "scripts"
    source.mkdir()
    (source / "present.py").write_text("x = 1\n", encoding="utf-8")
    inventory = source_inventory(
        tmp_path,
        declared_files=("scripts/present.py", "scripts/missing.py"),
    )
    report = evaluate_coverage(
        {"files": {"scripts/present.py": {"summary": {"covered_lines": 1, "num_statements": 1}}}},
        inventory,
        [],
    )
    assert report["missing_files"] == ["scripts/missing.py"]
    assert report["exclusions"] == []
    assert report["status"] == "failed"


def test_unexpected_declared_scope_file_is_explicit_and_fails(tmp_path):
    source = tmp_path / "scripts"
    source.mkdir()
    (source / "declared.py").write_text("x = 1\n", encoding="utf-8")
    (source / "untracked.py").write_text("x = 2\n", encoding="utf-8")

    inventory = source_inventory(tmp_path, declared_files=("scripts/declared.py",))

    assert inventory["missing_files"] == []
    assert inventory["unexpected_files"] == ["scripts/untracked.py"]
    report = evaluate_coverage(
        {"files": {"scripts/declared.py": {"summary": {"covered_lines": 1, "num_statements": 1}}}},
        inventory,
        [],
    )
    assert report["status"] == "failed"


def test_git_source_rejects_dirty_worktree_without_global_safe_directory(monkeypatch, tmp_path):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[-2:] == ["rev-parse", "HEAD"]:
            return type("Result", (), {"stdout": "abc123\n"})()
        return type("Result", (), {"stdout": " M scripts/example.py\n"})()

    monkeypatch.setattr("scripts.harness.python_coverage.subprocess.run", run)

    with pytest.raises(CoveragePreparationError, match="worktree is dirty"):
        _git_source(tmp_path)

    assert len(calls) == 2
    expected = f"safe.directory={tmp_path.resolve().as_posix()}"
    assert all(command[0:3] == ["git", "-c", expected] for command in calls)


def test_git_source_binds_head_and_clean_status_with_scoped_safe_directory(monkeypatch, tmp_path):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[-2:] == ["rev-parse", "HEAD"]:
            return type("Result", (), {"stdout": "deadbeef\n"})()
        return type("Result", (), {"stdout": ""})()

    monkeypatch.setattr("scripts.harness.python_coverage.subprocess.run", run)

    assert _git_source(tmp_path) == {"commit": "deadbeef", "clean": True}
    assert len(calls) == 2


def test_below_threshold_cannot_be_relabelled_as_passed():
    inventory = {
        "files": [{"path": "scripts/example.py", "status": "present"}],
        "missing_files": [],
        "unexpected_files": [],
    }
    report = evaluate_coverage(
        {
            "files": {
                "scripts/example.py": {"summary": {"covered_lines": 79, "num_statements": 100}}
            }
        },
        inventory,
        [],
        threshold=80.0,
    )
    assert report["totals"]["percent_covered"] == 79.0
    assert report["status"] == "failed"


def test_root_and_model_sandbox_coverage_aliases_are_unioned():
    inventory = {
        "files": [{"path": "scripts/example.py", "status": "present"}],
        "missing_files": [],
        "unexpected_files": [],
        "exclusions": [],
    }
    report = evaluate_coverage(
        {
            "files": {
                "C:/repo/scripts/example.py": {
                    "executed_lines": [1],
                    "missing_lines": [2],
                    "summary": {"covered_lines": 1, "num_statements": 2},
                },
                "C:/repo/model-sandbox/scripts/example.py": {
                    "executed_lines": [2],
                    "missing_lines": [1],
                    "summary": {"covered_lines": 1, "num_statements": 2},
                },
            }
        },
        inventory,
        [],
    )
    assert report["totals"]["covered_lines"] == 2
    assert report["totals"]["num_statements"] == 2
    assert report["totals"]["percent_covered"] == 100.0
    assert len(report["coverage_aliases"]["scripts/example.py"]) == 2


def test_cli_help_and_threshold_validation_are_real_subprocesses():
    script = Path(__file__).parents[1] / "scripts" / "harness" / "python_coverage.py"
    help_result = subprocess.run(
        [sys.executable, str(script), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert help_result.returncode == 0
    for invalid_threshold in ("79", "101", "nan", "inf"):
        invalid_result = subprocess.run(
            [sys.executable, str(script), "--threshold", invalid_threshold],
            capture_output=True,
            text=True,
            check=False,
        )
        assert invalid_result.returncode == 2
        assert "between 80 and 100" in invalid_result.stderr


def test_coverage_subprocess_keeps_empty_init_in_json(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "__init__.py").write_text("", encoding="utf-8")
    (scripts / "nonempty.py").write_text("VALUE = 1\n", encoding="utf-8")
    (tmp_path / "run.py").write_text(
        "from scripts.nonempty import VALUE\nassert VALUE == 1\n", encoding="utf-8"
    )
    rcfile = tmp_path / ".coveragerc"
    rcfile.write_text(
        "[run]\nsource = scripts\nparallel = true\n[report]\nskip_empty = true\n",
        encoding="utf-8",
    )
    env = {**os.environ, "COVERAGE_FILE": str(tmp_path / ".coverage")}
    run_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "coverage",
            "run",
            "--rcfile",
            str(rcfile),
            "--parallel-mode",
            "run.py",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert run_result.returncode == 0, run_result.stderr
    combine_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "coverage",
            "combine",
            "--rcfile",
            str(rcfile),
            "--data-file",
            str(tmp_path / ".coverage"),
            str(tmp_path),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert combine_result.returncode == 0, combine_result.stderr
    json_path = tmp_path / "coverage.json"
    json_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "coverage",
            "json",
            "--rcfile",
            str(rcfile),
            "--data-file",
            str(tmp_path / ".coverage"),
            "-o",
            str(json_path),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert json_result.returncode == 0, json_result.stderr
    files = json.loads(json_path.read_text(encoding="utf-8"))["files"]
    normalized = {path.replace("\\", "/") for path in files}
    assert any(path.endswith("scripts/__init__.py") for path in normalized)
