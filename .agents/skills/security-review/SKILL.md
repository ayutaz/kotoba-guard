---
name: security-review
description: Audit Kotoba Guard input privacy, messages, dependencies and package.
---

## Current boundary — 2026-11-28

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

## Procedures and historical lessons

The source-specific results and “next/latest” statements below describe their
original trials. They do not supersede the current boundary or authorize closed
experiments. Use the linked current docs for present model, test and release state.

Read docs/threat-model.md, PRIVACY.md and manifest. Review exclusions before value reads, opt-in registration and permission revocation. Reject untrusted message sender/schema and excessive requests. Never log/store user text or render it as HTML. Check built JS/WASM/model inventory, hashes and CSP. Run adversarial input and network monitoring with the real extension; distinguish page-origin requests. Audit locks and generate SBOM; document actual scope and unresolved findings.

A full CDP audit must account for auto/manual duplicate sessions and target lifetimes. A paused secondary debugger session can hold the primary Network.enable/resume ACK behind a second barrier. Queue primary initialization first, then promptly resume an auto-attached secondary with waitingForDebugger=true; do not wait for primary.ready before releasing that barrier. Retire secondaries after primary readiness, preserve fatal initialization errors, and retain lifetime monitoring gaps even after reattachment. Destroyed targets are covered only if their entire observed lifetime was monitored. Use HTTP/WebSocket positive controls and real page/background/offscreen/worker inference; a timeout-free unit fake alone cannot establish full coverage. The real v5 audit passed after this fix; preserve previous failed reports.

For generation identity review use docs/research/offscreen-instance-identity.md. UUID format alone is insufficient: compare the marker with current document discovery and exercise current-document/old-marker rejection. Report only validity/equality booleans; retain markers solely in private browser memory. Keep model-free attack controls, real-model disposal ACK/document disappearance and product-wide audit as separate evidence. A/B0e13b12 passed, but memory/fullM5 acceptance is false.

Audit6c1a810 against frozen0ba3630 all78assets passed one Windows/Chrome159 trial. Use the schema2 evidence path in docs/research/instance-full-context-audit.md. Reserve output before side effects, verify real Git controls and full manifest before/after, and set offline before triggerAction/first extension page. Keep the9 eligible covered targets distinct from excluded browser UI; bootstrap is outside monitoring. Preserve popup cleanup failure separately from primary inference errors and write final evidence only after cleanup. Retain22 new/604 prior evidence files; closed trial and oldZIP must not be rebound. FullM5 and long-term memory acceptance remain false.

Validate audit report acceptance from target/event evidence, exact pre/post source/assets, offline check counts, cleanup operations and measured resource rows, rather than a passing flag alone. Require all seven runtime identity keys even when the full distribution is present. Schema2 environment source is the audit commit; runtime provenance belongs to the external preflight, not the standalone report. The reported model file list must exactly match the frozen model manifest; a self-consistent shorter list/declaredCount can otherwise omit config/tokenizer files. The session-runtime audit validator has a behavioral omission Red/Green regression. Read docs/research/session-runtime-full-audit.md for the separately registered default-retention0 audit. Its six initial/continuous checks do not validate retained release/expiry traffic or memory-growth acceptance.

A denied Windows CIM query can emit a nonterminating PowerShell error followed by empty JSON; set ErrorAction Stop and keep unknown identity fail-closed. Preserve the initial failed smoke separately from a newly registered changed-permission probe. At d306948 the latter observed an owned tree4→0 after intentional timeout, and the one default-retention0 real audit passed six checks/nine eligible targets with cleanup6→0. Keep four duplicate-session detach warnings, browser UI/bootstrap exclusions and external runtime provenance. Both budgets are closed; read the frozen38-file receipt in docs/research/session-runtime-full-audit.md. Neither result accepts retained release/expiry traffic, memory growth or M5.
