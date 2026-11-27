# Kotoba Guard

Japanese typo detection inside a Chrome MV3 extension. No input text may leave
the extension, enter logs or persist. No telemetry, remote runtime code/model
downloads, accounts, paid inference or automatic text rewriting.

## Current state and release scope

The owner resumed the four-step minimal-release plan: fix audit cleanup,
automate publication, verify the ZIP, and publish a GitHub preview. That scope
includes local fixes/tests/commits and the intended ayutaz/kotoba-guard preview
publication. Chrome Web Store/Hugging Face/npm, paid services and credential
changes remain outside scope. Optimization stays deferred.
Read docs/status.md, docs/preview-validation.md and docs/next-steps.md first.

Saved preview runtime source is aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17.
Its78-asset build and seven E2E passed. Auditor source e627333 subsequently
fixed debugger/session shutdown and passed real-model coverage/source/assets,
offline6, unexpected0, OS memory samples and all eight cleanup operations.
Preserve earlier cleanup failures. Final public source and extracted ZIP need
their own bound checks; old dist/ZIP must not be relabeled as the preview.

Owner prioritizes early delivery and defers optimization. The preview contains
the numerically consistent embedding-UINT8/MatMul-FP16-storage model (FLOAT
compute),48,188,514 bytes, SHA4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7.
Source2914a68 fixed64 CPU/WASM parity passed;128-token p50=150.1ms did not meet
100ms. That experiment is closed. No new threshold/layer/thread/model search.
Accuracy, practical independent gold, physical IME/native permissions, services,
current-platform/remote validation and fullM5 remain incomplete.

The auditor cleanup fix is complete. Finish publication automation review, then
final-source extracted-ZIP/E2E/audit and SHA/SBOM/package checks. Preserve the6de3a00 failures,
aea6caf results, frozen distribution and all historical source-bound evidence.
Do not rerun a failed trial unchanged, extend deadlines without grounds,
or substitute documentation/old evidence for actual acceptance.

## Stack and commands

Node24 LTS, npm lockfile, TypeScript strict, Vite/Vitest/Playwright. Python3.12
with uv/uv.lock, PyTorch CPU, ONNX/ORT, pytest and Ruff. Use uv add (--dev for
tools), uv run --locked, uv sync --locked; no pip/global Python changes.

Normal development commands after resume: npm ci; npm run check; npm test;
uv run --locked python scripts/harness/run_checks.py. See docs/development.md
for isolated build/E2E/package paths. Default build/harness/package commands
can overwrite frozen dist or reports: never run them for status/docs checks.
Restricted Windows caches belong under .cache/uv, .cache/npm and .cache/playwright.
For ownership errors use per-command git -c safe.directory=<verified checkout>;
never change global trust or machine settings. No remote is configured.

## Implementation and TDD

Use behavioral Red → minimal Green → Refactor, relevant regression/lint/type
checks, security review and documentation updates. Preserve failures; do not
delete tests, add skips or silently relax gates. SDK/DOM offsets are UTF-16
half-open ranges; Python codepoints need conversion. Labels come from pinned
config, never guessed. Keep adapters separate; ignore stale results and IME
composition; bound requests and dispose resources. Shared Worker runs one
request and queues one; the third is busy. A response timeout cannot cancel ORT.

## Privacy and delivery

Explicit per-site opt-in; manual checks require activeTab action. Exclude
sensitive fields before reading. Validate sender/schema/origin/size. Use safe
DOM methods, bundled JS/WASM/tokenizer/model and local-only runtime paths.
No input logging/storage, arbitrary HTML/eval, telemetry or remote fallback.
Inspect actual artifacts, licenses, hashes and traffic; CSP alone is insufficient.
Source/model/publication claims must match the actual checked bytes and scope.

Commit reviewed source/tests/docs in scoped Conventional Commits. Preserve user
changes; never force push, reset --hard, commit secrets or large model weights.
Local commits are authorized. Public repo/Store/HF/npm releases, paid services,
credential changes and destructive operations require explicit permission.

## Skills, docs and completion

Read the relevant .agents/skills/<name>/SKILL.md (project-development,
model-conversion, browser-inference, chrome-extension, test-driven-development,
security-review, release-management). Keep skills focused; detailed history
lives in docs/index.md research/ADR links. Skill discovery reference remains
https://developers.openai.com/codex/skills/ (checked2026-11-25, not rechecked).

Update Japanese/English README, status/roadmap/checklist and affected docs/skills.
For docs-only maintenance verify links/format/source/evidence hashes without
running builds or inference. Historical research dates and test source commits
stay unchanged; a docs commit is not a newly tested runtime. Distinguish mock,
real model, WASM/WebGPU, Windows/Linux, local checks and remote CI. MVP/M5 is
complete only when docs/requirements.md and docs/mvp-checklist.md are actually
verified. On stop record results, failures, artifacts, commit and exact restart
scope. Documentation-only requests do not authorize broader development.
