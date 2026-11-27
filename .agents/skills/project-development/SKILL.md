---
name: project-development
description: Continue Kotoba Guard implementation and verify local development gates.
---

Read [AGENTS](../../../AGENTS.md), [status](../../../docs/status.md),
[preview validation](../../../docs/preview-validation.md) and
[next steps](../../../docs/next-steps.md) before selecting work.

## Current boundary (2026-11-28)

The minimal release plan is complete. GitHub prerelease v0.1.0 is public,
source f2d6afdd5bd241a5bed30b77faef226702f09cd2. Read
[release validation](../../../docs/validation-v0.1.0.md) and
[next steps](../../../docs/next-steps.md). Final extracted-ZIP7 E2E, real audit,
Windows/Linux quality CI and downloaded11 asset hashes passed. The release
workflow verification job passed; its publish job was intentionally skipped.
Actual first publication used the local CLI. Formal M5 remains incomplete.
This delivery is complete; do not begin optimization or Store/HF/npm work.
Preserve private local main history and frozen evidence; public branch maps to
origin/main and must use the GitHub public noreply identity.

The owner deferred optimization. The 48,188,514-byte preview model stores UINT8
embedding/FLOAT16 MatMul weights and computes in FLOAT. Its fixed64 numerical
gate passed at2914a68, while128-token p50=150.1ms missed100ms. That experiment
is closed; general accuracy and formalM5 remain incomplete.

## Documentation maintenance

Check changed links/anchors, formatting, bilingual claims and evidence/model
hashes. Preserve historical source commits, dates and failures. Do not run the
default harness/build/E2E/package merely to update docs: they overwrite frozen
dist or reports. Record new docs checks separately from older runtime evidence.

## Implementation after an owner resume

Use the scoped next task in next-steps: finalize publication automation,
then isolated packaging, extracted-ZIP checks and source/SHA/SBOM/license checks. Do not expand into
model/thread/threshold searches or site adapters. Public release requires explicit
authorization. Use fresh output paths and preserve every failed report.

Use uv run --locked, uv sync --locked and npm ci as needed for authorized work;
follow [development](../../../docs/development.md) for cache/output selection.
Use behavioral Red → minimal Green → Refactor, then related lint/type/regression.
Keep mocks, real models, operating systems, CI and native UI evidence distinct.
Coverage includes all declared entrypoints; never remove files to improve it.
Commit reviewed source/tests/docs in Conventional Commits and update status,
roadmap/checklist and affected Skills before a stopping boundary.

Read only relevant [research records](../../../docs/index.md#研究と過去の検証)
for completed experiments and known pitfalls. Their old “next/latest” paragraphs
are historical, not instructions to repeat closed budgets. Earlier chronological
Skill notes are preserved in `git show c14a591:.agents/skills/project-development/SKILL.md`.
