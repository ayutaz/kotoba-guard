"""CPU wheel advisory lookup must be explicit, bounded and fail closed."""

import json
import subprocess
from types import SimpleNamespace

import pytest

from scripts import audit_python
from scripts.audit_python import advisory_version


def test_public_versions_unchanged():
    assert advisory_version("numpy", "2.5.5") == "2.5.5"


def test_cpu_wheel_matches_base_torch_advisories():
    assert advisory_version("torch", "2.15.0+cpu") == "2.15.0"


@pytest.mark.parametrize("name,version", [("torch", "2.15.0+unknown"), ("other", "1.0+cpu")])
def test_unrecognized_local_build_is_not_silently_normalized(name, version):
    with pytest.raises(ValueError, match="unrecognized"):
        advisory_version(name, version)


def test_main_writes_scope_and_propagates_audit_exit_code(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        audit_python,
        "distributions",
        lambda: [
            SimpleNamespace(metadata={"Name": "torch"}, version="2.15.0+cpu"),
            SimpleNamespace(metadata={"Name": "numpy"}, version="2.5.5"),
        ],
    )
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 9)

    monkeypatch.setattr(audit_python.subprocess, "run", run)

    assert audit_python.main() == 9
    scope = json.loads((tmp_path / "artifacts/python-audit-scope.json").read_text())
    assert [row["name"] for row in scope["packages"]] == ["numpy", "torch"]
    requirements = (tmp_path / "artifacts/python-audit-requirements.txt").read_text()
    assert requirements == "numpy==2.5.5\ntorch==2.15.0\n"
    command = calls[0]
    assert command[1:4] == ["-m", "pip_audit", "--strict"]
    assert "--no-deps" in command
    assert "--disable-pip" in command
    assert "--requirement" in command
    assert "--format" in command and command[command.index("--format") + 1] == "json"


def test_main_fails_closed_before_audit_for_unrecognized_local_version(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        audit_python,
        "distributions",
        lambda: [SimpleNamespace(metadata={"Name": "numpy"}, version="2.5.5+vendor")],
    )
    called = False

    def run(*args, **kwargs):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(args[0], 0)

    monkeypatch.setattr(audit_python.subprocess, "run", run)

    with pytest.raises(ValueError, match="unrecognized local build"):
        audit_python.main()
    assert called is False
    assert not (tmp_path / "artifacts/python-audit-requirements.txt").exists()
