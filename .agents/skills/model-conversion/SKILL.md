---
name: model-conversion
description: Convert and validate the pinned Japanese ModernBERT typo model locally.
---

## Current boundary — 2026-11-28

Read [current preview validation](../../../docs/preview-validation.md) and
[restart scope](../../../docs/next-steps.md). The owner-requested development
pause is active; docs-only work does not authorize implementation or model/browser
runs. Preserve historical source bindings and frozen artifacts.

FP16-storage candidate2914a68 failed its latency gate and that experiment stays
closed. The owner subsequently deferred optimization, and the identical model
SHA was integrated into the sourceaea6caf development preview. This is not formal
acceptance. For staging existing candidates use prepare_models.py --preview-from
<candidate.onnx> --output <fresh bundle>; it validates provenance/assets without
download/export/inference. Preserve legacy converter schema in default mode;
the opt-in FP16 schema/options and actual model hashes must be bound explicitly.

## Procedures and historical lessons

The source-specific results and “next/latest” statements below describe their
original trials. They do not supersede the current boundary or authorize closed
experiments. Use the linked current docs for present model, test and release state.

Read docs/research/upstream-model.md and docs/model-conversion.md. Validate the full 40-character revision against the model API. Read labels from config, use local_files_only and no trust_remote_code. Preserve PyTorch logits/offsets as reference. Compare FP32, embedding QUInt8 and FP16 size and parity before choosing bundled weights. The existing MatMul-only comparison records size only; do not present it as a retained parity evaluation. Browser WASM execution is required separately from Python ORT success. Include tokenizer and upstream MIT text in distribution. Never publish weights without authorization.

Keep document identity when aggregating span metrics: identical offsets in different sentences are separate examples. Count a wrong non-OK label as both FP and FN. Run `scripts/evaluation.py --check-conversion` at the SDK's default threshold and retain other thresholds as separate results. Do not treat that small synthetic regression gate as general precision acceptance. Use a separate output directory and coverage DB for instrumentation; never overwrite frozen canonical models after browser measurements. Derive manifest dates from artifact provenance rather than hardcoding a session date.

ONNX export may embed developer filesystem paths in stacktrace metadata. Keep raw conversion outputs private. The build verifies the raw source SHA, sanitizes a separate distribution copy with `scripts/sanitize_model.py --verify`, and records both hashes. Remove only debug metadata, preserve license metadata and graph semantics, and reject private paths in semantic fields. Re-run browser measurements against the actual sanitized distribution hash; never publish raw artifacts or unreviewed benchmark reports containing machine paths.

For JWTD use docs/evaluation-protocol.md and scripts/prepare_corpus.py. Preserve all equivalent joint edit reconstructions; never combine positions from incompatible scenarios. Corrected clean examples must not inherit error alternatives. Exclude normalized individual pre/post texts as well as pages before calibration selection. A transparent HTTP client can decode x-gzip into a plain tar named .tar.gz: record original compressed and decoded hashes separately. Bind dataset bytes, config/tokenizer/scorer hashes and cache bytes; do not tune on held-out results or call training-exposed calibration independent accuracy.

The installed ONNX external-data loader rejects a weight file with multiple hard links. Linux/coverage worktrees can create this condition. Preserve the guard: make an ordinary isolated copy of the graph and every declared external-data file, verify source/copy SHA-256 equality, and convert from the copies. Do not disable the loader's hardlink safety check or modify frozen canonical weights. Experimental QDQ conversion must remove replaced FP32 initializers, reject existing model/manifest outputs, and retain source hashes.

Experimental weight-only mappings must follow actual local graph edges, including MatMulInteger weight/zero-point inputs, Cast(FLOAT), output scaling and Gather scale/zero-point. Do not infer binding from tensor names or arbitrary downstream reachability. Inspect and validate external-data locations before materializing them; reject absolute paths, traversal, URI/drive paths and escaping links. The optional --embedding-after-gather commutes scalar embedding DQ after Gather to expand selected rows only; retain default behavior and compare batched/repeated/negative IDs. Its fixed 64-row gate passed, but the one-thread 128-token p50 remained 187ms. Fresh model SHA requires fresh accuracy/performance evidence before adoption.

Candidate evaluation must work from source archives and shallow checkouts. Do not require git show of an old evaluator commit at runtime. The tracked benchmarks/protocols/frozen-evaluator-v1.txt is a provenance fixture, not imported executable code: verify its exact frozen SHA, byte count and adjacent origin/license/schema metadata before comparing scoring ASTs. Retain the original baseline commit/hash in reports, and fail on a missing or modified fixture. Regressions must include a git-unavailable environment; the snapshot must retain LF bytes across Windows/Linux.

For cache-only alignment diagnosis use scripts/analyze_scoring_sensitivity.py. Pin the baseline JSON itself as well as its dataset/model/cache hashes; otherwise a coherent replacement can masquerade as the frozen experiment. Keep canonical diagnostics fixed across primary alignment modes. The default run requires a clean Git source and checks it again before writing. Explicit dirty/custom-baseline fixture runs retain their actual source state and cannot establish frozen development evidence. See docs/research/scoring-sensitivity.md for the completed M1 result.

For bounded QOperator intermediate diagnostics expose only existing tensor outputs in a scratch graph. Require instrumented logits to reproduce the unmodified graph separately on CPU and WASM before attributing a discrepancy. Validate actual output dtype, rank and concrete dimensions against ORT metadata, and test the installed GraphOptimizationLevel enum rather than only fake top-level constants. NumPy savez emits Zip64 local headers even for small arrays: browser readers need a real NumPy multi-array roundtrip fixture. Compare integer activations exactly and normalize browser dims/type fields explicitly. Preserve failed or inconclusive instrumentation and stop at the pre-registered row/operator/settings boundary.

For downstream capture, read docs/research/downstream-parity-diagnostic.md before running. The all boundary graph changed CPU logits by 9.536743e-7 and failed exact reproduction; its disabled fallback reproduced CPU/WASM originals but first exceeded 0.001 at add_27. This does not identify the normal all path or a kernel defect. The registered two-run budget is exhausted. Sort graph values by both producer node index and output index: a set sorted only by node index gives hash-dependent ordering for DQL outputs. Validate profile-specific browser output order, classifier val_1245 names, and actual residual input edges. Preserve old first-pair report compatibility.

For the completed block5 and attention-output hybrid experiments read docs/research/block5-parity-diagnostic.md and docs/research/attention-output-hybrid.md. One DQL element differed with different float inputs; this is not a kernel-defect proof. The ten-projection hybrid failed 39/64 numerical rows and its single-run budget is closed. Do not run its accuracy/performance stage, change selected layers, or retry with disabled optimization. Preserve source a68f91b and runtime 0dc814c separately. Actual output dtype was not asserted in those reports: future CPU/browser harnesses must reject wrong dtype before converting arrays, and old evidence remains unverified. Converter provenance requires full SOURCE_COMMIT before writes and the verified actual source SHA in every nested record; do not leave the production SHA in toy/custom-source records.

The static-activation candidate at35d0a1b is closed and rejected: logit25/64, argmax2/span1, maxdelta2.738905. Read docs/research/static-activation-candidate.md. Do not recalibrate, change settings, or run accuracy/performance/worker stages for this candidate. Its completed protocol used fixed train64 calibration and separate fixed64 parity inputs, one candidate and one CPU/WASM comparison. Its CLI requires clean Git HEAD equal to SOURCE_COMMIT before calibration and before output; fixture APIs alone may override hashes/path counts. Include zero in MinMax, calculate zero point from the stored float32 scale, retain special tokens with tokenizer truncation, and reject unrepresentable scales. Validate every integer/scaling edge and both runtime input/output metadata. Protect manifest and scratch paths as well as model outputs; attempt every cleanup even when release fails. Do not claim old27-file coverage covers the new28-file inventory.

The complete28-file Python coverage measurement at clean8432112 passed all9 commands and362 unit tests, line82.23%; the static converter reached412/510 lines (80.78%). This isolated original-model integration does not repeat the rejected candidate, establish accuracy or numerical parity, or rebind runtime0dc814c. Preserve the35d0a1b and d7f100c coverage failures and the one nonfatal pytest cache warning in the successful report.

For the preregistered M2 confidence diagnostic read docs/research/confidence-frontier.md. The optional --threshold-frontier mode uses verified development caches only. Enumerate float64 nextafter boundaries after inclusive token confidences, apply ties atomically, and rescore whole documents: removing a middle token can split spans and increase recall. Compare all representatives with the frozen scorer. Preserve default modes and source/cache binding; never tune on held-out, emit text, or adopt an optimal diagnostic threshold as product policy. The old8432112 coverage does not cover this later function; scoped tests are separate evidence.

The registered full confidence sweep is now completed and closed at d9c44d6: all4 development caches had0 feasible points, reference maximum recall687/1027 (66.89%), QUInt8 672/1027 (65.43%). Preserve the source-bound JSON and independent audit in docs/research/confidence-frontier.md. Do not repeat the sweep or finer confidence scans, adopt its maximum-F1 threshold, or equate training-exposed development evidence with independent practical gold.

The FP16 weight-storage candidate at2914a68 is closed and not adopted. Its
embedding retains exact UINT8 Gather-to-DQ, while42 original MatMul weights
are FLOAT16 storage with Cast(FLOAT) before float arithmetic. It measured
48,188,514 bytes and passed native-all/WASM-all64 rows, but its first one-thread
128-token p50=150.1ms failed the100ms gate. Do not rerun or switch settings.
See docs/research/fp16-storage-candidate.md; accuracy and Worker integration
were not evaluated. Preserve legacy converter manifest keys in default mode;
only the opt-in mode emits the FP16 schema/options. Candidate runtime manifests
must bind the converter manifest hash/schema/options and actual model bytes.

Owner later explicitly deferred optimization for early delivery. The closed performance gate does not block a separately verified local development preview. Keep the failed measurement unchanged and require real editor/offline/privacy tests, communication audit and package verification; do not call performance, accuracy or M5 passed.
