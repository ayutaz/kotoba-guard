---
name: release-management
description: Prepare reproducible Kotoba Guard distribution and release evidence.
---

## Current boundary — 2026-11-28

The owner resumed the minimal release plan through GitHub preview publication.
Read [next steps](../../../docs/next-steps.md) and
[current preview validation](../../../docs/preview-validation.md).
Commit e627333 fixed auditor shutdown; a real-model audit of the saved preview
passed coverage, source/assets binding, offline6, unexpected0 and all eight
cleanup operations. Preserve the earlier failed reports.
The public source and final extracted ZIP still require their own bound checks.
Use the local preview CLI for the first release; later workflow runs verify a
fixed sealed bundle. No model/performance experiments, Store/HF/npm publication,
paid services or credential changes are included. Never overwrite frozen assets.

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
