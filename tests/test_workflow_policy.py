"""Policy tests for bounded, opt-in GitHub Actions resource use."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))


def _job_blocks(text: str) -> list[str]:
    starts = [match.start() for match in re.finditer(r"^  [A-Za-z0-9_-]+:\s*$", text, re.MULTILINE)]
    return [text[start:end] for start, end in zip(starts, [*starts[1:], len(text)], strict=True)]


def test_every_workflow_job_has_an_explicit_timeout() -> None:
    for workflow in WORKFLOWS:
        blocks = [
            block
            for block in _job_blocks(workflow.read_text(encoding="utf-8"))
            if "runs-on:" in block
        ]
        assert blocks, workflow.name
        assert all("timeout-minutes:" in block for block in blocks), workflow.name


def test_artifact_uploads_are_explicitly_opt_in() -> None:
    for workflow in WORKFLOWS:
        lines = workflow.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if "uses: actions/upload-artifact@" not in line:
                continue
            block = "\n".join(lines[max(0, index - 8) : index + 1])
            assert "vars.KOTOBA_GUARD_UPLOAD_ARTIFACTS == 'true'" in block, (
                f"{workflow.name}: upload-artifact is not opt-in"
            )


def test_upload_lists_do_not_use_unbounded_artifact_roots() -> None:
    for workflow in WORKFLOWS:
        text = workflow.read_text(encoding="utf-8")
        assert not re.search(r"^\s+artifacts/\s*$", text, re.MULTILINE), workflow.name
        assert not re.search(r"^\s+path:\s+artifacts/\s*$", text, re.MULTILINE), workflow.name


def test_actions_cache_is_disabled_until_explicitly_revisited() -> None:
    for workflow in WORKFLOWS:
        text = workflow.read_text(encoding="utf-8")
        assert not re.search(r"^\s+cache:", text, re.MULTILINE), workflow.name
        setup_uv_lines = [
            index
            for index, line in enumerate(text.splitlines())
            if "uses: astral-sh/setup-uv@" in line
        ]
        for index in setup_uv_lines:
            block = "\n".join(text.splitlines()[index : index + 8])
            assert re.search(r'^\s+enable-cache:\s+["\']false["\']\s*$', block, re.MULTILINE), (
                f"{workflow.name}: setup-uv cache must be explicitly disabled"
            )


def test_codeql_is_gated_and_skips_are_reported() -> None:
    security = (ROOT / ".github" / "workflows" / "security.yml").read_text(encoding="utf-8")
    assert "github.event.repository.visibility == 'public'" in security
    assert "vars.KOTOBA_GUARD_CODEQL_PRIVATE_ENABLED == 'true'" in security
    assert "GITHUB_STEP_SUMMARY" in security
    assert "not a security pass" in security


def test_codeql_init_and_analyze_use_the_same_pinned_revision() -> None:
    security = (ROOT / ".github" / "workflows" / "security.yml").read_text(encoding="utf-8")
    actions = re.findall(r"uses: github/codeql-action/(init|analyze)@([^\s]+)", security)
    assert len(actions) == 2
    revisions = dict(actions)
    assert set(revisions) == {"init", "analyze"}
    assert re.fullmatch(r"[0-9a-f]{40}", revisions["init"])
    assert revisions["init"] == revisions["analyze"]


def test_workflows_write_only_sanitized_step_summaries() -> None:
    for workflow in WORKFLOWS:
        text = workflow.read_text(encoding="utf-8")
        assert "GITHUB_STEP_SUMMARY" in text, workflow.name
        assert "cat artifacts/" not in text, workflow.name
        assert "cat .cache/" not in text, workflow.name
