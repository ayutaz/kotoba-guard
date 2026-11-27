"""Report tools without exposing authentication or environment secrets."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def inspect() -> dict:
    tools = {}
    for name, args in {"node": ["--version"], "npm": ["--version"], "uv": ["--version"]}.items():
        command = shutil.which(name)
        if not command:
            tools[name] = {"available": False}
            continue
        result = subprocess.run([command, *args], capture_output=True, text=True, check=False)
        tools[name] = {"available": result.returncode == 0, "version": result.stdout.strip()}
    node = tools["node"].get("version", "")
    ok = node.startswith("v24.") and sys.version_info[:2] == (3, 12)
    return {"ok": ok, "python": sys.version.split()[0], "tools": tools}


if __name__ == "__main__":
    report = inspect()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["ok"] else 1)
