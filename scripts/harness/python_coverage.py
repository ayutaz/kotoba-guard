"""Measure all declared Python sources with unit and real integration commands.

The driver uses one parallel coverage data stem for every command, writes only
to a new output directory, and fails closed when a command, source inventory,
or coverage threshold is incomplete.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
THRESHOLD = 80.0
MODEL_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
DECLARED_PYTHON_FILES = (
    "scripts/__init__.py",
    "scripts/analyze_scoring_sensitivity.py",
    "scripts/audit_python.py",
    "scripts/benchmark.py",
    "scripts/corpus_evaluation.py",
    "scripts/diagnose_quantized_intermediates.py",
    "scripts/evaluation.py",
    "scripts/evaluate_candidate.py",
    "scripts/export_onnx.py",
    "scripts/generate_icons.py",
    "scripts/harness/check_environment.py",
    "scripts/harness/linux_validation.py",
    "scripts/harness/python_coverage.py",
    "scripts/harness/run_checks.py",
    "scripts/hybrid_quantize.py",
    "scripts/model_pipeline.py",
    "scripts/package_extension.py",
    "scripts/prepare_browser_corpus.py",
    "scripts/prepare_corpus.py",
    "scripts/prepare_models.py",
    "scripts/prepare_release.py",
    "scripts/preview_release.py",
    "scripts/quantize.py",
    "scripts/run_corpus_evaluation.py",
    "scripts/sanitize_model.py",
    "scripts/static_activation_quantize.py",
    "scripts/tokenizer_fixtures.py",
    "scripts/validate_model.py",
    "scripts/verify_package.py",
)


class CoveragePreparationError(RuntimeError):
    """Raised when current coverage evidence cannot be accepted."""


def _validate_threshold(value: float) -> float:
    if not math.isfinite(value) or not THRESHOLD <= value <= 100.0:
        raise CoveragePreparationError("threshold must be finite and between 80 and 100")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normal(path: str) -> str:
    normalized = path.replace("\\", "/")
    marker = "scripts/"
    if marker in normalized:
        return normalized[normalized.rindex(marker) :]
    return normalized


def _coverage_stats(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Union line/branch hits from root and isolated-sandbox aliases."""

    executed_lines: set[int] = set()
    missing_lines: set[int] = set()
    executed_branches: set[tuple[int, int]] = set()
    missing_branches: set[tuple[int, int]] = set()
    line_lists_present = False
    branch_lists_present = False
    summary_covered = 0
    summary_statements = 0
    summary_branch_covered = 0
    summary_branches = 0
    for entry in entries:
        executed = entry.get("executed_lines", [])
        missing = entry.get("missing_lines", [])
        line_lists_present |= bool(executed or missing)
        executed_lines.update(int(line) for line in executed)
        missing_lines.update(int(line) for line in missing)
        executed_branch_values = entry.get("executed_branches", [])
        missing_branch_values = entry.get("missing_branches", [])
        branch_lists_present |= bool(executed_branch_values or missing_branch_values)
        executed_branches.update(tuple(map(int, branch)) for branch in executed_branch_values)
        missing_branches.update(tuple(map(int, branch)) for branch in missing_branch_values)
        summary = entry.get("summary", {})
        summary_covered = max(summary_covered, int(summary.get("covered_lines", 0)))
        summary_statements = max(summary_statements, int(summary.get("num_statements", 0)))
        summary_branch_covered = max(
            summary_branch_covered, int(summary.get("covered_branches", 0))
        )
        summary_branches = max(summary_branches, int(summary.get("num_branches", 0)))
    covered_lines = len(executed_lines) if line_lists_present else summary_covered
    num_statements = (
        len(executed_lines | missing_lines) if line_lists_present else summary_statements
    )
    covered_branches = len(executed_branches) if branch_lists_present else summary_branch_covered
    num_branches = (
        len(executed_branches | missing_branches) if branch_lists_present else summary_branches
    )
    return {
        "covered_lines": covered_lines,
        "num_statements": num_statements,
        "covered_branches": covered_branches,
        "num_branches": num_branches,
    }


def source_inventory(root: Path, declared_files: tuple[str, ...] = DECLARED_PYTHON_FILES) -> dict:
    """Capture every declared Python file and report omissions explicitly."""

    root = root.resolve()
    actual = {
        path.relative_to(root).as_posix()
        for path in (root / "scripts").rglob("*.py")
        if path.is_file()
    }
    declared = set(declared_files)
    files = []
    missing = []
    for relative in sorted(declared):
        path = root / relative
        if not path.is_file():
            missing.append(relative)
            files.append({"path": relative, "status": "missing"})
            continue
        files.append(
            {
                "path": relative,
                "status": "present",
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    return {
        "declared_files": list(sorted(declared)),
        "files": files,
        "missing_files": missing,
        "unexpected_files": sorted(actual - declared),
        "exclusions": [],
    }


def coverage_command(*arguments: str) -> list[str]:
    return [
        "uv",
        "run",
        "--locked",
        "coverage",
        "run",
        "--parallel-mode",
        *arguments,
    ]


def _pytest_temp(root: Path, output: Path) -> Path:
    identity = hashlib.sha256(output.resolve().as_posix().encode("utf-8")).hexdigest()[:20]
    return root.resolve() / ".cache" / "coverage-pytest" / identity


def command_plan(output: Path, *, root: Path = ROOT) -> dict[str, list[list[str]]]:
    """Return the frozen unit and current-model integration command plan."""

    return {
        "unit": [
            coverage_command(
                "-m", "pytest", "-q", "tests", f"--basetemp={_pytest_temp(root, output)}"
            )
        ],
        "integration": [
            coverage_command("scripts/generate_icons.py"),
            coverage_command("scripts/model_pipeline.py", "reference"),
            coverage_command("scripts/model_pipeline.py", "export"),
            coverage_command("scripts/quantize.py"),
            coverage_command("scripts/model_pipeline.py", "convert"),
            coverage_command("scripts/model_pipeline.py", "manifest"),
            coverage_command("scripts/evaluation.py", "--check-conversion"),
            coverage_command(
                "scripts/validate_model.py",
                f"models/converted/{MODEL_REVISION}/onnx/model_quantized.onnx",
            ),
        ],
    }


def _command_environment(output: Path, source_root: Path) -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "COVERAGE_FILE": str(output / ".coverage"),
        "COVERAGE_RCFILE": str((source_root / "pyproject.toml").resolve()),
    }


def _prepare_model_sandbox(root: Path, output: Path) -> Path:
    """Create a fresh model workspace so integration cannot alter repo artifacts."""

    source = root / "models" / "upstream" / MODEL_REVISION
    if not source.is_dir():
        raise CoveragePreparationError(f"pinned upstream model is missing: {source}")
    sandbox = output / "model-sandbox"
    sandbox.mkdir()
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".cache")
    shutil.copytree(
        root / "scripts",
        sandbox / "scripts",
        copy_function=os.link,
        ignore=ignore,
    )
    shutil.copytree(
        source,
        sandbox / "models" / "upstream" / MODEL_REVISION,
        copy_function=os.link,
        ignore=ignore,
    )
    dataset = root / "benchmarks" / "datasets" / "synthetic-v1.json"
    if not dataset.is_file():
        raise CoveragePreparationError(f"evaluation dataset is missing: {dataset}")
    dataset_target = sandbox / "benchmarks" / "datasets"
    dataset_target.mkdir(parents=True)
    os.link(dataset, dataset_target / dataset.name)
    return sandbox


def _run_process(command: list[str], *, runner=None, **kwargs):
    """Keep process creation failures on the same recorded failure path."""
    try:
        return (runner or subprocess.run)(command, **kwargs)
    except OSError as exc:
        return subprocess.CompletedProcess(
            command, 127, "", f"launch error: {type(exc).__name__}: {exc}\n"
        )


def execute_commands(
    root: Path,
    output: Path,
    plan: dict[str, list[list[str]]],
    *,
    phase_roots: dict[str, Path] | None = None,
    runner=subprocess.run,
) -> list[dict[str, Any]]:
    """Execute all planned commands and persist their raw results."""

    output.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for phase, commands in plan.items():
        phase_root = (phase_roots or {}).get(phase, root)
        for index, command in enumerate(commands):
            result = _run_process(
                command,
                runner=runner,
                cwd=phase_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=_command_environment(output, root),
                check=False,
            )
            (output / f"{phase}-{index}.log").write_text(
                result.stdout + result.stderr, encoding="utf-8"
            )
            results.append(
                {
                    "phase": phase,
                    "index": index,
                    "command": command,
                    "exitCode": result.returncode,
                }
            )
            if result.returncode != 0:
                payload = {"results": results}
                (output / "commands.json").write_text(
                    json.dumps(payload, indent=2), encoding="utf-8"
                )
                raise CoveragePreparationError(f"{phase}[{index}] exit {result.returncode}")
    (output / "commands.json").write_text(
        json.dumps({"results": results}, indent=2), encoding="utf-8"
    )
    return results


def evaluate_coverage(
    coverage_data: dict,
    inventory: dict,
    command_results: list[dict[str, Any]],
    *,
    threshold: float = THRESHOLD,
) -> dict:
    """Build the current report and fail status when evidence is incomplete."""

    coverage_aliases: dict[str, list[str]] = {}
    coverage_entries: dict[str, list[dict[str, Any]]] = {}
    coverage_unmapped = []
    for raw_path, entry in coverage_data.get("files", {}).items():
        canonical = _normal(raw_path)
        if not canonical.startswith("scripts/"):
            coverage_unmapped.append(raw_path)
            continue
        coverage_aliases.setdefault(canonical, []).append(raw_path)
        coverage_entries.setdefault(canonical, []).append(entry)
    report_files = []
    coverage_missing = []
    covered = 0
    statements = 0
    for item in inventory["files"]:
        relative = item["path"]
        entries = coverage_entries.get(relative)
        if entries is None:
            coverage_missing.append(relative)
            report_files.append({**item, "coverage_status": "missing"})
            continue
        stats = _coverage_stats(entries)
        file_covered = stats["covered_lines"]
        file_statements = stats["num_statements"]
        file_branch_covered = stats["covered_branches"]
        file_branches = stats["num_branches"]
        covered += file_covered
        statements += file_statements
        report_files.append(
            {
                **item,
                "coverage_status": "measured",
                "covered_lines": file_covered,
                "num_statements": file_statements,
                "percent_covered": round(
                    file_covered / file_statements * 100 if file_statements else 0.0,
                    2,
                ),
                "covered_branches": file_branch_covered,
                "num_branches": file_branches,
                "branch_percent_covered": round(
                    file_branch_covered / file_branches * 100 if file_branches else 0.0,
                    2,
                ),
            }
        )
    percent = round((covered / statements * 100) if statements else 0.0, 2)
    branch_covered = sum(item.get("covered_branches", 0) for item in report_files)
    branches = sum(item.get("num_branches", 0) for item in report_files)
    branch_percent = round((branch_covered / branches * 100) if branches else 0.0, 2)
    command_failures = [item for item in command_results if item["exitCode"] != 0]
    complete = not (
        inventory["missing_files"]
        or inventory["unexpected_files"]
        or coverage_missing
        or coverage_unmapped
        or inventory.get("exclusions", [])
        or command_failures
    )
    status = "passed" if complete and percent >= threshold else "failed"
    phase_results = {}
    for command in command_results:
        phase_results.setdefault(command["phase"], []).append(command)
    return {
        "schema": "kotoba-guard.python-coverage.v1",
        "status": status,
        "threshold": threshold,
        "thresholds": {"line_percent": threshold, "branch_percent": None},
        "totals": {
            "covered_lines": covered,
            "num_statements": statements,
            "percent_covered": percent,
            "line_percent_covered": percent,
            "covered_branches": branch_covered,
            "num_branches": branches,
            "branch_percent_covered": branch_percent,
        },
        "files": report_files,
        "missing_files": inventory["missing_files"],
        "unexpected_files": inventory["unexpected_files"],
        "coverage_missing_files": coverage_missing,
        "coverage_unmapped_files": coverage_unmapped,
        "coverage_aliases": coverage_aliases,
        "command_failures": command_failures,
        "exclusions": inventory.get("exclusions", []),
        "commands": command_results,
        "phase_results": phase_results,
    }


def _write_command_failure_report(
    output: Path,
    source: dict[str, Any],
    inventory: dict,
    threshold: float,
    error: CoveragePreparationError,
) -> dict:
    """Persist a failed report even when command execution aborts early."""

    commands_path = output / "commands.json"
    command_payload = json.loads(commands_path.read_text(encoding="utf-8"))
    report = evaluate_coverage(
        {},
        inventory,
        command_payload.get("results", []),
        threshold=threshold,
    )
    report["source"] = source
    report["model_sandbox"] = "model-sandbox"
    report["historical_artifact_reused"] = False
    report["coverage_processing_error"] = str(error)
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def _git_source(root: Path) -> dict[str, Any]:
    root = root.resolve()
    safe = f"safe.directory={root.as_posix()}"
    try:
        commit = subprocess.run(
            ["git", "-c", safe, "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-c", safe, "status", "--porcelain", "--untracked-files=all"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise CoveragePreparationError("unable to bind clean source commit") from exc
    if status:
        raise CoveragePreparationError("source worktree is dirty")
    return {"commit": commit, "clean": True}


def run_coverage(
    root: Path = ROOT, output: Path | None = None, threshold: float = THRESHOLD
) -> dict:
    """Run the frozen plan and write a new current coverage report."""

    root = root.resolve()
    threshold = _validate_threshold(threshold)
    source = _git_source(root)
    coverage_root = (root / "artifacts" / "coverage").resolve()
    requested_output = output or coverage_root / "python-overall-current"
    output = (
        (root / requested_output).resolve()
        if not requested_output.is_absolute()
        else requested_output.resolve()
    )
    try:
        output.relative_to(coverage_root)
    except ValueError as exc:
        raise CoveragePreparationError("coverage output must be inside artifacts/coverage") from exc
    if output.exists() and any(output.iterdir()):
        raise CoveragePreparationError(f"coverage output already exists: {output}")
    output.mkdir(parents=True, exist_ok=True)
    inventory = source_inventory(root)
    plan = command_plan(output, root=root)
    if _pytest_temp(root, output).exists():
        raise CoveragePreparationError("measurement-specific pytest temp directory already exists")
    _pytest_temp(root, output).parent.mkdir(parents=True, exist_ok=True)
    model_sandbox = _prepare_model_sandbox(root, output)
    (output / "source.json").write_text(
        json.dumps({"source": source, "inventory": inventory}, indent=2), encoding="utf-8"
    )
    try:
        results = execute_commands(
            root,
            output,
            plan,
            phase_roots={"integration": model_sandbox},
        )
    except CoveragePreparationError as error:
        _write_command_failure_report(output, source, inventory, threshold, error)
        raise
    env = _command_environment(output, root)
    combine = _run_process(
        [
            "uv",
            "run",
            "--locked",
            "coverage",
            "combine",
            "--keep",
            "--data-file",
            str(output / ".coverage"),
            str(output),
        ],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    (output / "coverage-combine.log").write_text(combine.stdout + combine.stderr, encoding="utf-8")
    if combine.returncode != 0:
        report = evaluate_coverage({}, inventory, results, threshold=threshold)
        report["source"] = source
        report["historical_artifact_reused"] = False
        report["coverage_processing_error"] = f"coverage combine exit {combine.returncode}"
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        raise CoveragePreparationError(f"coverage combine exit {combine.returncode}")
    json_path = output / "coverage.json"
    report_result = _run_process(
        [
            "uv",
            "run",
            "--locked",
            "coverage",
            "json",
            "--data-file",
            str(output / ".coverage"),
            "-o",
            str(json_path),
        ],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    (output / "coverage-json.log").write_text(
        report_result.stdout + report_result.stderr, encoding="utf-8"
    )
    if report_result.returncode != 0:
        report = evaluate_coverage({}, inventory, results, threshold=threshold)
        report["source"] = source
        report["historical_artifact_reused"] = False
        report["coverage_processing_error"] = f"coverage JSON exit {report_result.returncode}"
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        raise CoveragePreparationError(f"coverage JSON exit {report_result.returncode}")
    report = evaluate_coverage(
        json.loads(json_path.read_text(encoding="utf-8")),
        inventory,
        results,
        threshold=threshold,
    )
    report["source"] = source
    report["model_sandbox"] = "model-sandbox"
    report["historical_artifact_reused"] = False
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if report["status"] != "passed":
        raise CoveragePreparationError(
            f"Python coverage gate failed: {report['totals']['percent_covered']:.2f}%"
        )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--threshold", type=float, default=THRESHOLD)
    args = parser.parse_args(argv)
    try:
        run_coverage(args.root, args.output, args.threshold)
    except CoveragePreparationError as exc:
        print(f"python_coverage: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
