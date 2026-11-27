"""Cross-platform quality gates. Record each exit status; never hide a failure."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def configure_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    configure_console()
    parser = argparse.ArgumentParser()
    parser.add_argument("--e2e", action="store_true")
    parser.add_argument("--package", action="store_true")
    parser.add_argument("--model", action="store_true")
    args = parser.parse_args()
    # Fresh Linux checkouts may keep uv/npm caches outside the repository.
    (ROOT / ".cache").mkdir(exist_ok=True)
    commands = [
        ["uv", "run", "--locked", "ruff", "check", "."],
        ["uv", "run", "--locked", "ruff", "format", "--check", "."],
        [
            "uv",
            "run",
            "--locked",
            "python",
            "-m",
            "pytest",
            "-q",
            "--junitxml=artifacts/pytest.xml",
            "--basetemp=.cache/pytest-harness",
        ],
        ["npm", "run", "check"],
        ["npm", "run", "test:coverage"],
        ["npm", "run", "build"],
    ]
    if args.model or args.package:
        commands.append(["npm", "run", "test:model"])
    if args.model:
        commands.append(
            ["uv", "run", "--locked", "python", "scripts/evaluation.py", "--check-conversion"]
        )
    if args.e2e:
        commands.append(["npm", "run", "test:e2e"])
    if args.package:
        commands.append(["npm", "run", "package"])
    output = ROOT / "artifacts"
    output.mkdir(exist_ok=True)
    results = []
    for index, command in enumerate(commands):
        started = time.perf_counter()
        executable = shutil.which(command[0])
        if not executable:
            results.append({"command": command, "exitCode": 127, "error": "tool missing"})
            continue
        print("Running: " + " ".join(command), flush=True)
        result = subprocess.run(
            [executable, *command[1:]],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            check=False,
        )
        (output / f"check-{index}.txt").write_text(result.stdout + result.stderr, encoding="utf-8")
        print(result.stdout[-4000:] + result.stderr[-2000:], flush=True)
        results.append(
            {
                "command": command,
                "exitCode": result.returncode,
                "seconds": round(time.perf_counter() - started, 3),
            }
        )
    ok = all(result["exitCode"] == 0 for result in results)
    (output / "checks.json").write_text(
        json.dumps({"ok": ok, "results": results}, indent=2), encoding="utf-8"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
