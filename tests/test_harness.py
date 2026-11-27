"""Windows console encoding must not prevent machine-readable gate results."""

import io
import json
from subprocess import CompletedProcess

from scripts.harness import run_checks
from scripts.harness.run_checks import configure_console


def test_cp932_console_accepts_replacement_and_japanese(monkeypatch):
    buffer = io.BytesIO()
    stream = io.TextIOWrapper(buffer, encoding="cp932")
    monkeypatch.setattr("sys.stdout", stream)
    configure_console()
    stream.write("失敗: \ufffd")
    stream.flush()
    assert buffer.getvalue().decode("utf-8") == "失敗: \ufffd"


def test_failed_gate_is_recorded_and_remaining_gates_still_run(tmp_path, monkeypatch):
    monkeypatch.setattr(run_checks, "ROOT", tmp_path)
    monkeypatch.setattr("sys.argv", ["run_checks.py"])
    monkeypatch.setattr(run_checks.shutil, "which", lambda name: name)
    calls = []

    def run(command, **options):
        assert (tmp_path / ".cache").is_dir()
        calls.append(command)
        assert options["env"]["PYTHONIOENCODING"] == "utf-8"
        return CompletedProcess(command, 1 if len(calls) == 1 else 0, "失敗: \ufffd", "")

    monkeypatch.setattr(run_checks.subprocess, "run", run)
    assert run_checks.main() == 1
    report = json.loads((tmp_path / "artifacts/checks.json").read_text())
    assert report["ok"] is False
    assert len(report["results"]) == len(calls) == 6
    assert report["results"][0]["exitCode"] == 1
    assert all(result["exitCode"] == 0 for result in report["results"][1:])
