"""Audit locked installed versions without pip resolution or silent CPU-wheel skips."""

import json
import subprocess
import sys
from importlib.metadata import distributions
from pathlib import Path

from packaging.version import Version


def advisory_version(name: str, version: str) -> str:
    parsed = Version(version)
    if parsed.local is None:
        return version
    if name.lower().replace("_", "-") == "torch" and parsed.local == "cpu":
        return parsed.public
    raise ValueError(f"unrecognized local build requires audit review: {name} {version}")


def main() -> int:
    output = Path("artifacts")
    output.mkdir(exist_ok=True)
    rows = sorted(
        (
            {"name": dist.metadata["Name"], "installed": dist.version}
            for dist in distributions()
            if dist.metadata["Name"]
        ),
        key=lambda row: row["name"].lower(),
    )
    for row in rows:
        row["advisoryVersion"] = advisory_version(row["name"], row["installed"])
    (output / "python-audit-scope.json").write_text(
        json.dumps(
            {
                "packages": rows,
                "limitation": (
                    "torch +cpu maps to the same public torch version for advisory lookup. "
                    "This does not independently attest CPU-wheel binary provenance. "
                    "All other local version suffixes fail closed. No packages are skipped."
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    requirements = output / "python-audit-requirements.txt"
    requirements.write_text(
        "".join(f"{row['name']}=={row['advisoryVersion']}\n" for row in rows), encoding="utf-8"
    )
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip_audit",
            "--strict",
            "--no-deps",
            "--disable-pip",
            "--cache-dir",
            ".cache/pip-audit",
            "--requirement",
            str(requirements),
            "--format",
            "json",
            "--output",
            str(output / "python-pip-audit.json"),
        ],
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
