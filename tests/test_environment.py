"""Environment report tests that never expose credentials or run heavy work."""

import subprocess

from scripts.harness import check_environment


def test_inspect_reports_supported_node_and_python_versions(monkeypatch):
    paths = {"node": "node", "npm": "npm", "uv": "uv"}
    versions = {
        "node": "v24.11.1\n",
        "npm": "11.6.1\n",
        "uv": "uv 0.9.8\n",
    }

    monkeypatch.setattr(check_environment.shutil, "which", paths.__getitem__)
    monkeypatch.setattr(check_environment.sys, "version_info", (3, 12, 7))

    def run(command, **kwargs):
        executable = command[0]
        return subprocess.CompletedProcess(command, 0, versions[executable], "")

    monkeypatch.setattr(check_environment.subprocess, "run", run)

    report = check_environment.inspect()

    assert report["ok"] is True
    assert report["python"] == check_environment.sys.version.split()[0]
    assert report["tools"]["node"] == {"available": True, "version": "v24.11.1"}
    assert report["tools"]["npm"]["available"] is True
    assert report["tools"]["uv"]["version"] == "uv 0.9.8"


def test_inspect_fails_closed_for_missing_or_unsupported_tools(monkeypatch):
    def which(name):
        return None if name == "uv" else name

    monkeypatch.setattr(check_environment.shutil, "which", which)
    monkeypatch.setattr(check_environment.sys, "version_info", (3, 11, 9))

    def run(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, "", "not available")

    monkeypatch.setattr(check_environment.subprocess, "run", run)

    report = check_environment.inspect()

    assert report["ok"] is False
    assert report["tools"]["uv"] == {"available": False}
    assert report["tools"]["node"]["available"] is False
