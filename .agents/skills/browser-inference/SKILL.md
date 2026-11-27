---
name: browser-inference
description: Implement or diagnose Kotoba Guard tokenizer and browser inference SDK.
---

## Current boundary — 2026-11-28

Read [current preview validation](../../../docs/preview-validation.md) and
[restart scope](../../../docs/next-steps.md). The owner-requested development
pause is active; docs-only work does not authorize implementation or model/browser
runs. Preserve historical source bindings and frozen artifacts.

Current preview is sourceaea6caf, using UINT8 embedding / FLOAT16 MatMul
weight storage with FLOAT computation, SHA4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7.
Fixed64 CPU/WASM parity passed;128-token p50=150.1ms missed100ms. Optimization
is deferred; no search/retry. General accuracy is unmeasured. Worker serialization
passed the latest real-model E2E; audit cleanup remains failed. Avoid rebinding
older QUInt8 parity or memory results to this model.

## Procedures and historical lessons

The source-specific results and “next/latest” statements below describe their
original trials. They do not supersede the current boundary or authorize closed
experiments. Use the linked current docs for present model, test and release state.

Read packages/core and docs/architecture.md. Preserve original UTF-16 offsets through normalization, emoji and combining marks; verify against pinned Python tokenizer fixtures. Never use substring search as a substitute for tokenizer alignment. Bundle ORT WASM locally and disable remote/cache fallback. Bound token chunks, overlap and queued work. Test cancellation and disposal; keep one model in the shared worker. Record actual WASM and WebGPU backend independently. The shipped extension worker is WASM-only; WebGPU selection/fallback belongs to the SDK and isolated probe, not the current normal UI.

Demonstrated pitfalls: the JavaScript Unigram tokenizer did not reproduce Python ByteFallback IDs for emoji. Run `npm run test:model` against all 34 pinned fixtures, including literal special tokens and U+2581. ORT 1.31.1 may select the asyncify companion at runtime; bundling only the jsep WASM is insufficient. Keep all selected runtime sidecars local and verify an offline cold start. Do not inline WASM through Vite library mode; externalize ORT to the bundled local ESM. A discovered GPU adapter is not evidence that model inference executed on a hardware GPU.

When investigating CPU/WASM disagreement, compare exact input IDs, masks, offsets and the same distribution hash before changing tokenizer or tolerance. The fixed 64-row diagnosis found exact native CPU parity but QUInt8 WASM drift; paired FP32 WASM passed. Read docs/research/onnx-wasm-parity.md and docs/browser-corpus-parity.md for scope and next controls. FP32 external weights need explicit ORT Web externalData entries; use the isolated diagnostic rather than changing the shipped model.

For experimental weight-only QDQ, the fixed 64-row CPU/WASM gate passed with native ORT_DISABLE_ALL and the browser's unchanged default optimization, while native ORT_ENABLE_ALL failed. Record the actual native optimization enum in the fixture; the model's serialized float operations do not prove which optimized kernels execute. This result is a numerical control, not general accuracy or permission to replace bundled assets. See docs/research/onnx-wasm-parity.md for the model hash and separate failed/passed reports.

Distinguish the model limit (8192 tokens), extension chunk length (256 including special tokens, overlap 32), and input limit (20000 UTF-16 units). Validate explicit SDK limits and the final special-token encoding on both short and long paths. Cancellation cannot interrupt an ORT session.run; invalidate stale results, share the disposal promise, wait for initialization/in-flight inference, and release the session once. Test deferred factory/run/release promises, including release rejection and empty input superseding pending work. A hung standalone session.run can keep SDK disposal pending; the extension worker owner provides the separate timeout/termination boundary.

Real-model heap observation58042c2 is closed: current Worker WASM114,556,928bytes/used JS about36MB stayed level across3 generations, while identical resume PID-role maps grew2.305 in process working set. Before/shared has PID churn, so six-phase fixed-cohort claims are invalid. Read docs/research/model-worker-heap-observation.md and additive cohort-audit; preserve26 original frozen files. Compare process ratios only after matching nonduplicate positive PID/role maps (mismatch=unknown). PID equality is not target ownership or process-start proof. Hook/attach overhead and linear capacity are distinct from resident/native memory. Next offscreen-close hypothesis requires separate registration; no unchanged retry or M5/leak-fix claim.

A shared LocalTypoDetector cancels its previous detect call. Serialize distinct extension clients in the Worker (one running/one waiting), rather than sending them concurrently into this SDK. A response timeout does not stop ORT: hold the execution slot until the underlying Promise settles or the owning Broker terminates the Worker. Reject queued requests from an earlier release generation. The real-SDK regression at8c9988e reproduced three failures hidden by immediate detector mocks; two real-model requests later succeeded, but the external CIM process gate failed. Keep functional success separate from owned-process cleanup and memory-growth acceptance.
