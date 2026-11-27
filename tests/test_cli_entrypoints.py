"""Exercise harness command-line entrypoints without starting heavy gates."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]


def run_script(relative_path: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ROOT / relative_path), *arguments],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    "relative_path",
    [
        "scripts/harness/python_coverage.py",
        "scripts/harness/run_checks.py",
    ],
)
def test_harness_help_is_available_from_direct_script_entrypoint(relative_path):
    result = run_script(relative_path, "--help")

    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout.lower()


def test_run_checks_rejects_unknown_argument_before_running_any_gate():
    result = run_script("scripts/harness/run_checks.py", "--unexpected")

    assert result.returncode == 2
    assert "unrecognized arguments" in result.stderr


def test_check_environment_direct_entrypoint_emits_machine_readable_json():
    result = run_script("scripts/harness/check_environment.py")

    assert result.returncode in (0, 1)
    report = json.loads(result.stdout)
    assert set(report) == {"ok", "python", "tools"}
    assert set(report["tools"]) == {"node", "npm", "uv"}


def test_python_coverage_rejects_threshold_below_frozen_gate_before_git_access():
    result = run_script(
        "scripts/harness/python_coverage.py",
        "--threshold",
        "79",
    )

    assert result.returncode == 2
    assert "between 80 and 100" in result.stderr
