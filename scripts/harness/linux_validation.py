"""Run the Linux validation gates from an isolated, reproducible Docker snapshot.

The host checkout is never mounted into the container.  A clean HEAD archive is
created and extracted into a temporary container workspace; Linux dependencies
come from the pinned validation image and are refreshed with the lock files.
"""

from __future__ import annotations

import argparse
import json
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_IMAGE = "kotoba-guard-linux-check:d850fdf"
DEFAULT_IMAGE_ID = "sha256:2d1f93a0bdcdb63528771914a9027bf6382e1b8950d47384c823149d7b856b87"
DEFAULT_CACHE = ROOT / ".cache" / "linux-validation"
DEFAULT_PLAYWRIGHT_CACHE = ROOT / ".cache" / "linux-playwright"
DEFAULT_OUTPUT = ROOT / "artifacts" / "linux-check"
MODEL_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"


@dataclass(frozen=True)
class Config:
    image: str = DEFAULT_IMAGE
    image_id: str = DEFAULT_IMAGE_ID
    cache_dir: Path = DEFAULT_CACHE
    playwright_cache: Path = DEFAULT_PLAYWRIGHT_CACHE
    output_dir: Path = DEFAULT_OUTPUT
    model_root: Path = ROOT / "models"
    cpus: int = 2
    memory: str = "8g"
    model: bool = False
    e2e: bool = False
    package: bool = False
    quality_only: bool = False
    dry_run: bool = False
    collect_results: Path | None = None


def _run(
    command: list[str], *, cwd: Path = ROOT, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=check)


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    # Git accepts forward-slash paths on Windows too.  The Docker/Linux
    # snapshot uses this value as a per-command trust exception, so avoid
    # passing backslashes that can be interpreted as escape characters by
    # downstream Git tooling.
    safe_directory = _absolute(ROOT).as_posix()
    return _run(["git", "-c", f"safe.directory={safe_directory}", *args], check=check)


def _absolute(path: Path) -> Path:
    return path.expanduser().resolve()


def _inside_root(path: Path, label: str) -> Path:
    resolved = _absolute(path)
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside the repository: {resolved}") from exc
    if "," in str(resolved):
        raise ValueError(f"{label} cannot contain a comma because Docker mount fields use commas")
    return resolved


def source_snapshot(cache_dir: Path) -> tuple[Path, str]:
    """Create a tracked-only tar archive from a clean HEAD and return its SHA."""

    status = _git("status", "--porcelain").stdout
    if status.strip():
        names = "\n".join(line[3:] for line in status.splitlines()[:20])
        suffix = "\n..." if len(status.splitlines()) > 20 else ""
        raise RuntimeError(
            "Linux validation requires a clean checkout before creating the source archive:\n"
            f"{names}{suffix}"
        )
    commit = _git("rev-parse", "HEAD").stdout.strip()
    cache_dir = _inside_root(cache_dir, "cache_dir")
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / "source.tar"
    _git("archive", "--format=tar", f"--output={archive}", "HEAD")
    return archive, commit


def _mount(source: Path, target: str, *, readonly: bool) -> list[str]:
    mode = ",readonly" if readonly else ""
    return ["--mount", f"type=bind,source={source},target={target}{mode}"]


def _shell_script(config: Config) -> str:
    commands = [
        "set -euo pipefail",
        "rm -rf /validation/run",
        "mkdir -p /validation/run/workspace",
        "cp -a /workspace/.venv /validation/run/workspace/.venv",
        "cp -a /workspace/node_modules /validation/run/workspace/node_modules",
        "tar -xf /validation/source.tar -C /validation/run/workspace",
        "rm -rf /validation/run/workspace/models/upstream "
        "/validation/run/workspace/models/converted",
        "mkdir -p /validation/run/workspace/models/upstream "
        "/validation/run/workspace/models/converted",
        f"ln -s /validation/assets/upstream "
        f"/validation/run/workspace/models/upstream/{MODEL_REVISION}",
        f"ln -s /validation/assets/converted "
        f"/validation/run/workspace/models/converted/{MODEL_REVISION}",
        "cd /validation/run/workspace",
        "export PATH=/validation/run/workspace/.venv/bin:$PATH",
        "collect_results() { local check_status=$?; local export_status=0; "
        "python scripts/harness/linux_validation.py --collect-results /validation/results "
        '|| export_status=$?; if [ "$check_status" -ne 0 ]; then '
        'exit "$check_status"; fi; exit "$export_status"; }',
        "trap collect_results EXIT",
        "uv sync --locked",
        "npm ci",
    ]
    if config.e2e:
        commands.append("npx playwright install --with-deps chromium")
    commands.extend(
        [
            "uv run --locked python scripts/harness/check_environment.py",
            "uv run --locked python scripts/harness/run_checks.py"
            + (" --model" if config.model else "")
            + (" --e2e" if config.e2e else "")
            + (" --package" if config.package else ""),
        ]
    )
    return " && ".join(commands)


def build_command(config: Config, archive: Path, commit: str) -> list[str]:
    model_root = _inside_root(config.model_root, "model_root")
    upstream = model_root / "upstream" / MODEL_REVISION
    converted = model_root / "converted" / MODEL_REVISION
    if not upstream.is_dir() or not converted.is_dir():
        raise FileNotFoundError("Both pinned upstream and converted model directories are required")
    archive = _inside_root(archive, "source archive")
    cache_dir = _inside_root(config.cache_dir, "cache_dir")
    playwright_cache = _inside_root(config.playwright_cache, "playwright_cache")
    output_dir = _inside_root(config.output_dir, "output_dir")
    for path in (cache_dir, playwright_cache, output_dir, cache_dir / "uv", cache_dir / "npm"):
        path.mkdir(parents=True, exist_ok=True)

    command = [
        "docker",
        "run",
        "--rm",
        "--cpus",
        str(config.cpus),
        "--memory",
        config.memory,
        "-e",
        "CI=true",
        "-e",
        "KOTOBA_GUARD_E2E_MODE=real" if config.e2e else "KOTOBA_GUARD_E2E_MODE=mock",
        "-e",
        "UV_CACHE_DIR=/cache/uv",
        "-e",
        "npm_config_cache=/cache/npm",
        "-e",
        "PLAYWRIGHT_BROWSERS_PATH=/cache/playwright",
        "-e",
        f"KOTOBA_GUARD_SOURCE_SHA={commit}",
        "-e",
        f"SOURCE_COMMIT={commit}",
        "-e",
        f"RUNTIME_SOURCE_COMMIT={commit}",
    ]
    command += _mount(archive, "/validation/source.tar", readonly=True)
    command += _mount(upstream, "/validation/assets/upstream", readonly=True)
    command += _mount(converted, "/validation/assets/converted", readonly=True)
    command += _mount(playwright_cache, "/cache/playwright", readonly=False)
    command += _mount(cache_dir / "uv", "/cache/uv", readonly=False)
    command += _mount(cache_dir / "npm", "/cache/npm", readonly=False)
    command += _mount(output_dir, "/validation/results", readonly=False)
    command += [config.image, "bash", "-lc", _shell_script(config)]
    return command


def _verify_image(config: Config) -> str:
    result = _run(["docker", "image", "inspect", config.image, "--format", "{{.Id}}"])
    actual = result.stdout.strip()
    if config.image_id and actual != config.image_id:
        raise RuntimeError(f"Docker image ID mismatch: expected {config.image_id}, got {actual}")
    return actual


def collect_runtime_results(workspace: Path, destination: Path) -> None:
    """Retain nested browser reports and failures before the container disappears."""
    if destination.is_symlink():
        raise ValueError("result destination symbolic link is not supported")
    workspace = workspace.resolve()
    destination = destination.resolve()
    if destination.is_relative_to(workspace):
        raise ValueError("result directory must be outside the container workspace")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("result directory already contains evidence")
    sources = [
        (workspace / "artifacts", destination),
        (workspace / "coverage", destination / "coverage"),
        (workspace / "test-results", destination / "test-results"),
        (workspace / "dist" / "extension", destination / "extension"),
    ]
    for source, _target in sources:
        ancestors = (
            parent for parent in (source, *source.parents) if parent.is_relative_to(workspace)
        )
        if any(parent.is_symlink() for parent in ancestors) or any(
            path.is_symlink() for path in source.rglob("*")
        ):
            raise ValueError("result symbolic links are not supported")
    for source, target in sources[1:]:
        if (workspace / "artifacts" / target.name).exists() and source.exists():
            raise ValueError("result directories would collide")
    if not any(path.is_file() for source, _target in sources for path in source.rglob("*")):
        raise ValueError("no evidence files to collect")
    destination.mkdir(parents=True, exist_ok=True)
    for source, target in sources:
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)


def parse_args(argv: list[str] | None = None) -> Config:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--image-id", default=DEFAULT_IMAGE_ID)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--playwright-cache", type=Path, default=DEFAULT_PLAYWRIGHT_CACHE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", action="store_true")
    parser.add_argument("--e2e", action="store_true")
    parser.add_argument("--package", action="store_true")
    parser.add_argument("--quality-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--collect-results", type=Path)
    args = parser.parse_args(argv)
    if args.quality_only and (
        args.model or args.e2e or args.package or args.collect_results is not None
    ):
        parser.error("--quality-only cannot be combined with other validation lanes")
    if args.collect_results is not None and (
        args.model or args.e2e or args.package or args.dry_run
    ):
        parser.error("--collect-results cannot run validation lanes")
    if not (
        args.model
        or args.e2e
        or args.package
        or args.quality_only
        or args.collect_results is not None
    ):
        parser.error("an explicit --quality-only, --model, --e2e, or --package lane is required")
    return Config(
        image=args.image,
        image_id=args.image_id,
        cache_dir=args.cache_dir,
        playwright_cache=args.playwright_cache,
        output_dir=args.output_dir,
        model=args.model,
        e2e=args.e2e,
        package=args.package,
        quality_only=args.quality_only,
        dry_run=args.dry_run,
        collect_results=args.collect_results,
    )


def main(argv: list[str] | None = None) -> int:
    config = parse_args(argv)
    if config.collect_results is not None:
        try:
            collect_runtime_results(ROOT, config.collect_results)
        except (OSError, ValueError):
            print("Linux result export failed; evidence was not fully collected", file=sys.stderr)
            return 2
        return 0
    try:
        archive, commit = source_snapshot(config.cache_dir)
        image_id = _verify_image(config)
        run_config = Config(**{**config.__dict__, "output_dir": config.output_dir / commit})
        result_dir = _inside_root(run_config.output_dir, "output_dir")
        if result_dir.exists() and any(result_dir.iterdir()):
            raise RuntimeError("result directory already contains evidence")
        command = build_command(run_config, archive, commit)
    except (
        FileNotFoundError,
        OSError,
        RuntimeError,
        ValueError,
        subprocess.CalledProcessError,
    ) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        print(f"Linux validation preflight failed: {detail.strip()}", file=sys.stderr)
        return 2
    print("Source commit:", commit)
    print("Docker image:", config.image, image_id)
    print("Command:", shlex.join(command))
    if config.dry_run:
        return 0
    result = subprocess.run(command, cwd=ROOT, check=False)
    receipt = {
        "sourceCommit": commit,
        "image": config.image,
        "imageId": image_id,
        "command": command,
        "exitCode": result.returncode,
    }
    run_config.output_dir.mkdir(parents=True, exist_ok=True)
    (run_config.output_dir / "linux-validation.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
