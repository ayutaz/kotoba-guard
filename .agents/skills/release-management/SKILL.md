---
name: release-management
description: Prepare reproducible Kotoba Guard distribution and release evidence.
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

For Windows ownership exceptions, inherited Git safe.directory must use a
normalized forward-slash path. Scope GIT_CONFIG_COUNT/KEY_0/VALUE_0 to the
current process; do not change global trust. Set GH_REPO to the intended repo.
A backslash path caused the first tag check to stop before any release write;
normalizing it restored the documented absent-tag exit2. Preserve that boundary.

## Procedures and historical lessons

The source-specific results and “next/latest” statements below describe their
original trials. They do not supersede the current boundary or authorize closed
experiments. Use the linked current docs for present model, test and release state.

Read docs/release.md and status. Run locked quality gates plus real model E2E and package verification. Verify source/model hashes, upstream attribution, dependency licenses and SBOM. Produce ZIP, SHA256 and source commit mapping in artifacts. Fail packaging if assets are missing. Compare two package runs for reproducibility. Package does not run build; rebuild when bundled policies or assets change. Keep the old ZIP receipt tied to its original source commit after documentation-only changes. The manual release workflow runs real E2E only; run both mock and real locally for the full matrix. Local artifacts do not authorize GitHub/Hugging Face/npm/Chrome Store publication.

Release preparation fails if real-model E2E, extension-origin traffic monitoring, or the built package permission audit has not run successfully. A development build or mock test cannot satisfy these gates.

Audit the actual distributed model bytes for private paths. Raw ONNX conversion outputs can contain developer stacktraces; upload only sanitized distribution artifacts and explicitly allowlisted reports. Never upload the entire raw conversion or local artifacts directory as a release payload. Keep raw-source and sanitized-model hashes distinct in manifests.

Linux optional Node image packages can have a different license-file layout from Windows. Do not bypass missing-license failures without proving exclusion from the actual browser bundle. The build audits a nonempty Vite core source map, rejects Sharp sources, records its hash/count, and removes the raw map before packaging. All bundled code still requires license text. Preserve initial failing Linux logs and rerun the current committed source after a fix.

Pass an absolute directory to browser_security_audit.mjs --extension-dir: Chrome Extensions.loadUnpacked rejects relative paths before extension startup. Keep the failed report and rerun the confirmed absolute path under a new output name; do not alter monitoring thresholds. Source 67217cc passed full Windows/Linux validation and the absolute-path traffic audit. Its immutable development_snapshot remains blocked for failed accuracy and unknown native/remote gates; later documentation or Skill commits do not rebind its receipt.

The receipt validates direct reference hashes, not arbitrary nested links. Independently verify the second ZIP recorded in reproducibility JSON, SBOM document hashes/components and every license file; keep standard CycloneDX documents unchanged and use a separate source-bound metadata index. Interpret kind and acceptance rather than the release-candidate schema name. A reference_precision/recall invalid blocker can mean below-threshold finite metrics; inspect the underlying evidence rather than treating it as a malformed input or changing the gate.

Linux949fe5e exposed platform-specific native licenses/audit JSON despite identical executable/model hashes. Fixed packaging0ba3630 derives Sharp exclusion records from the production lock graph, requires clean source-map evidence and copies no license files for excluded native code. Windows/Linux all78 assets matched under quality-only6 gates; preserve230 evidence files. Keep bundled-code license texts mandatory. This proves the two tested OS dependency layouts, not all optional packages/platforms or M5 acceptance.
