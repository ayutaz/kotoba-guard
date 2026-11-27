# QUInt8 CPU and WASM parity investigation

Documentation follow-up: 2026-11-28. The QUInt8 disagreements and closed trials
below retain their original sources. A distinct FP16-storage model later passed
the fixed64 native-all/WASM-all gate and was integrated into a local development
preview. This does not resolve the older QOperator graph's root cause or establish
general accuracy. See [current preview](../preview-validation.md). Development is paused.

Investigation date: 2026-11-27 (JST). This note records the fixed browser
parity result and the evidence currently available for a difference between
the Python ONNX Runtime CPU result and the ONNX Runtime Web WASM result. It
does not claim a root cause until a same-runtime, same-input experiment
isolates one.

## Current evidence

The distributed model is the sanitized copy of the pinned QUInt8 artifact.
The fixed artifact and graph inspection provide these facts:

- `artifacts/browser-corpus-parity-initial.json` contains 64 rows. All 64
  shapes and tokenizer offsets match. One row has an ordinary-token argmax
  mismatch. Forty rows have an ordinary-token maximum absolute logit delta
  above `0.001`; the maximum is `2.606649398803711`. Three rows differ in the
  SDK span result at the existing `0.5` confidence threshold.
- The raw quantized model is SHA-256
  `51e8977b11e3c9353062216a7de6b4ebc54abd823647ac04c0dfadd48eb9e203`.
  The distributed sanitized model is SHA-256
  `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`.
  The sanitization check already recorded CPU output identity for its fixed
  lengths; this does not explain the browser difference.
- The distributed graph has opset 18, 809 nodes, 42 `DynamicQuantizeLinear`
  nodes, 42 `MatMulInteger` nodes, one quantized embedding `Gather` followed by
  `DequantizeLinear`, and ordinary floating-point `MatMul` nodes. Its inputs
  are `int64` `input_ids` and `attention_mask`; its output is float32 logits
  with nine labels. This is dynamic activation quantization plus QUInt8
  weights, rather than a float model with only metadata changes.
- `scripts/model_pipeline.py` invokes
  `onnxruntime.quantization.quantize_dynamic` with
  `op_types_to_quantize=["Gather", "MatMul"]`, `weight_type=QUInt8`,
  `per_channel=True`, `reduce_range=False`, and
  `MatMulConstBOnly=True`.
- The lockfile records Python `onnxruntime` 1.32.0. The browser package in
  `package-lock.json` is `onnxruntime-web` 1.31.1 (its package-local common
  dependency is 1.31.1). The fixed initial parity JSON records the browser
  version but not either runtime package version or the WASM sidecar hashes.
  Later diagnostics record both native versions, and the FP32 browser report
  records all bundled WASM sidecar hashes. The same-input 1.31.1 CPU control
  below rules out a native-version-only explanation for these rows.

- `artifacts/browser-corpus-parity-tokenids.json` checks all 64 rows with the
  exact cached `input_ids` and `attention_mask`. All IDs, masks, shapes, and
  offsets match; the original logit/span gate failures remain. This rules out a
  feed-token mismatch for this fixture, while preserving the numerical failure.
- `artifacts/browser-corpus-native-diagnostic.json` compares all 64 rows using
  Python ONNX Runtime 1.32.0, `CPUExecutionProvider`, one intra-op thread, one
  inter-op thread, and `ORT_ENABLE_ALL`. Every row has zero logit delta and
  argmax agreement, and its gate passes. This shows that the native one-thread
  diagnostic reproduces the cached native result; it does not identify a WASM
  kernel as the cause.
- `artifacts/browser-corpus-fp32-wasm.json` is a passed offline FP32 WASM
  control from source commit `a8f01fc917672f526d7e8b6cd0738ee4e3824de1`.
  Across all 64 rows, input IDs, attention masks, shapes, offsets, ordinary
  token argmaxes, and SDK spans match the CPU reference. The maximum absolute
  logit delta is `0.00004291534423828125` (`4.291534423828125e-05`); the
  report records zero external requests and zero page errors.
- `artifacts/browser-corpus-fp32-cpu.json` is the matching CPU reference for
  the same FP32 model, using ONNX Runtime 1.32.0, `CPUExecutionProvider`, one
  intra-op thread, one inter-op thread, and `ORT_ENABLE_ALL`. Its gate passes
  for all 64 rows and records the same FP32 model hash as the browser report.

These observations rule out an offset/UTF-16 mapping explanation for the
reported rows. The FP32 pair passes while the QUInt8 pair fails under the same
fixed 64-row protocol, localizing the observed parity failure to the
quantized graph or execution path for this fixture. The native-version control
below rules out a native-version-only explanation; provider-specific kernels
and optimizations remain candidates. No particular operator is proven faulty.

## What the official documentation establishes

The following are primary ONNX/ONNX Runtime sources, checked on 2026-11-27:

- [ONNX Runtime quantization guide](https://onnxruntime.ai/docs/how-to/quantization.html)
  defines dynamic quantization as calculating activation quantization
  parameters during inference, describes signed and unsigned 8-bit formats,
  and states that quantization is not lossless. It recommends the quantization
  debugging APIs that compare intermediate tensors when accuracy changes.
- [ONNX Runtime quantization representation](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
  documents both QOperator (`MatMulInteger`) and QDQ forms and states that
  dynamic quantization inserts the calculation of activation parameters at
  runtime. The project's graph inspection confirms the former form for its
  `MatMulInteger` nodes.
- [ONNX Runtime Web tutorial](https://onnxruntime.ai/docs/tutorials/web/) says
  that WASM is the browser CPU provider, WebGPU is a separate provider, and
  that all ONNX operators are supported by WASM while GPU providers support a
  subset. Operator load success therefore does not imply CPU bit identity.
- [Execution Provider architecture](https://onnxruntime.ai/docs/execution-providers/index.html)
  says providers advertise capabilities and receive supported nodes or
  subgraphs. [The architecture reference](https://onnxruntime.ai/docs/reference/high-level-design.html)
  explains that graph partitioning is provider-specific. This supports an EP
  implementation hypothesis, but does not identify the node responsible here.
- [ONNX Runtime Web build documentation](https://onnxruntime.ai/docs/build/web)
  documents separate WASM builds with SIMD and threads. The shipped runtime
  uses the SIMD/threaded artifact, while the parity script explicitly sets
  `numThreads: 1`; this makes thread-count matching possible but does not make
  SIMD arithmetic identical to native CPU kernels.
- [ONNX `MatMulInteger` operator specification](https://onnx.ai/onnx/operators/onnx__MatMulInteger.html)
  permits int8 or uint8 inputs, optional per-tensor or per-row/column zero
  points, and int32 accumulation. The model's quantized graph exercises this
  operator with dynamic zero points, so the arithmetic path is materially
  different from the FP32 graph.

The documentation does not state that CPU and WASM executions are bitwise
identical. It also does not establish that the current ORT Web WASM kernel is
incorrect. A public non-primary report is intentionally not used as proof of
the cause.

## Ranked hypotheses

1. **Runtime/provider arithmetic difference (plausible, unverified).** The
   Python CPU provider and WASM provider can use different kernels, SIMD
   reductions, or graph transformations for the 42 dynamic quantized linear
   layers. Small intermediate differences can propagate through ten
   transformer layers and produce larger final-logit deltas.
2. **Native runtime version alone (ruled out for these inputs).** An isolated
   uv project pinned to Python 3.12.13, NumPy 2.5.5, tokenizers 0.23.3, and
   ONNX Runtime 1.31.1 reproduced all 64 cached native outputs exactly
   (`artifacts/browser-corpus-native-1311.json`). The provider-specific
   implementation can still differ. The FP32 browser report also binds all
   bundled WASM sidecar hashes.
3. **Thread/SIMD configuration difference (downgraded, not fully isolated).**
   The cache metadata records four Python threads, whereas browser parity
   forces one WASM thread. The one-thread native diagnostic reproduced all 64
   cached rows exactly, so native thread count alone does not explain the
   observed difference. Native and WASM SIMD/reduction paths remain different
   implementations. The FP32 browser control now passes, so the observed
   difference is specific to the QUInt8 graph or its execution path on this
   fixture.
4. **Tokenizer or offset mismatch (ruled out for the fixed fixture).** Exact
   input IDs, attention masks, shapes, and offsets all match in the token-ID
   artifact. This does not establish numerical equality for a different input
   or model.

## Minimal diagnostic matrix

Keep the existing `0.001` gate and do not retune the confidence threshold.
The next controlled measurements should record runtime versions, model hash,
input tensor IDs, and sidecar hashes in the result:

1. **Completed:** bind the fixed report to exact input IDs/masks and record the
   native runtime/provider/thread configuration. The two diagnostic artifacts
   are now the evidence for this step.
2. **Completed:** compare the FP32 ONNX model in Python CPU and WASM. The
   fixed 64-row protocol passes for IDs, masks, offsets, argmaxes, spans, and
   the logit-delta gate. Together with the failing QUInt8 comparison, this
   localizes investigation to quantized arithmetic or its graph path; it does
   not identify a bad kernel.
3. **Completed:** isolated Python ONNX Runtime 1.31.1 with the existing
   one-thread configuration reproduces the cached 1.32.0 output exactly.
4. **Completed:** disabling native graph optimization changes the QUInt8
   result: 32 rows exceed 0.001, the maximum delta is 2.423532485961914, and
   two rows have argmax differences (`artifacts/browser-corpus-native-noopt.json`).
   This establishes sensitivity to the optimization path. It does not show
   that disabling optimization reproduces WASM or fixes the browser gate.
5. Use ONNX Runtime's documented quantization
   debugging approach to capture matching intermediate tensors around the
   first `DynamicQuantizeLinear`/`MatMulInteger` pair. The first divergent
   node, not the final logits, should determine the fix or model-format
   decision.

The browser parity gate remains failed for the existing quantized model;
the FP32 browser gate is passed. The separate experimental weight-only QDQ
conversion was generated at `215a37e`: 37,825,117 bytes, SHA-256
`693fbd3f1fecd8a421f2ff6c7cb60ff1cb3a333361a0fc74425bd8c5e1a42aff`.
It reuses the verified UINT8 weights in 43 DequantizeLinear nodes before
float MatMul/Gather. This describes the serialized graph, not a guarantee
about the runtime's optimized execution path.

The paired CPU/WASM experiment at `7e6c7c1` completed all 64 rows with exact
IDs/masks/offsets and no external requests or page errors. It still failed:
all 64 rows exceeded 0.001, maximum delta was 0.39871931076049805, two rows
had argmax differences, and one had SDK span differences. Reports are
`artifacts/browser-corpus-weight-only-cpu-v1.json` and
`artifacts/browser-corpus-weight-only-wasm-v1.json`. Native CPU used ORT1.32.0,
one intra/inter-op thread, and `ORT_ENABLE_ALL`; WASM retained its default
optimization settings. This experiment does not justify replacing the
canonical QUInt8 model.

The single-condition control at `d1380d0` disabled native candidate graph
optimization while retaining the browser settings. All 64 rows passed,
with maximum logit delta 0.00002574920654296875, exact IDs/masks/offsets,
no argmax or span mismatches, and no external requests or page errors.
Reports are `artifacts/browser-corpus-weight-only-noopt-cpu-v1.json` and
`artifacts/browser-corpus-weight-only-native-noopt-wasm-v1.json`.
This establishes sensitivity to native graph optimization for this candidate;
it does not identify a particular faulty kernel or establish general accuracy.
The next adoption checks are development-set F1 degradation, WASM latency,
cold initialization, and measured process memory. The canonical distribution
remains unchanged. The 37,825,117-byte candidate meets the size target only;
accuracy, latency, and memory remain separate adoption gates.
Raising a tolerance or changing the confidence threshold would hide a
reproducibility defect rather than resolve it.

## M3 registered control: requested WASM graph optimization

Registered 2026-11-27 before execution. Hypothesis: the WASM optimizer path
contributes to the canonical QUInt8 discrepancy. Keep the same sanitized model
(`dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`),
frozen 64-item fixture/protocol, runtime assets, one WASM thread, offline
context and threshold 0.5. Run two fresh browser contexts serially: direct ORT
with `graphOptimizationLevel: all`, then `disabled`. The existing distribution
build is retained for this control; SDK and extension changes are tested
separately after a new build.

```powershell
node scripts/browser_corpus_parity.mjs --fixture artifacts/corpus-browser/jwtd-browser-v1-tokenids.json --wasm-graph-optimization all --output artifacts/wasm-optimizer/NEW-SOURCE-COMMIT/all-tokenids.json
node scripts/browser_corpus_parity.mjs --fixture artifacts/corpus-browser/jwtd-browser-v1-tokenids.json --wasm-graph-optimization disabled --output artifacts/wasm-optimizer/NEW-SOURCE-COMMIT/disabled-tokenids.json
```

The script records the requested and submitted session option. ORT's internal
optimized graph is not observed, so `effective` remains null. Gate: all 64
items must match IDs/masks/offsets/shapes, finite outputs, ordinary logits
within 0.001 and zero argmax/span mismatches, external requests or page errors.
Do not compare this diagnostic's timing with a performance benchmark.

If disabling optimization resolves the discrepancy, investigate the first
changed intermediate operation before adopting a runtime setting. If it does
not, preserve the failed gate; an unchanged result weakens this optimizer
hypothesis but does not prove a particular faulty kernel. Either result leaves
M2 accuracy, full extension-path parity and latency gates separate. Do not
repeat the already measured weight-only/no-opt control or change tolerances.

### Measured result at 7db6271

Both fresh contexts completed 64 rows and failed the numerical gate. Input IDs,
masks, offsets, shapes and finite values matched throughout; external requests
and page errors were zero in this diagnostic's observed scope.

| Requested WASM optimization | Rows above 0.001 | Maximum logit delta | Argmax mismatch rows | SDK span mismatch rows |
| --------------------------- | ---------------- | ------------------- | -------------------- | ---------------------- |
| all                         | 40               | 2.606649398803711   | 1                    | 3                      |
| disabled                    | 41               | 2.544703483581543   | 3                    | 4                      |

The diagnostic source was clean `7db627156a76f9968e0eecf8b2f27849d7351b4a`.
Before running, all 81 files in the existing distribution were byte-compared
with the archived `67217cc` ZIP (SHA
`759785fe9a542b413eeea8e6e9e5b5247613004b6c9973022c6b610c076a23cd`)
and matched. This controlled comparison used that build, before the later
Windows harness rebuilt the extension. It does not validate the new runtime's
entire extension path.

Fixture SHA: `4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47`.
Reports are under `artifacts/wasm-optimizer/7db627156a76f9968e0eecf8b2f27849d7351b4a/`:
`all-tokenids.json` SHA
`2c96e17044c61e865c8b7f9751867dc6520f90c4473b826194974b5a933533d9`,
`disabled-tokenids.json` SHA
`becde09472f5016e8c376eb20bc6c9b0701c63f143c565f0c9e1e1389ab75d2c`.
Both commands exited 1 because parity failed, after completing inference.
The first `all.json` and an instrumented execution-diagnostic attempt stopped
before inference: the legacy default fixture lacked token ID/mask arrays.
Those failures remain preserved; the explicit token-ID fixture above was used
for the measured pair. No missing-array check was relaxed.

Disabling optimization changes results but does not resolve disagreement.
The canonical model and acceptance thresholds remain unchanged. These final
logit comparisons do not identify a faulty kernel.

### Next bounded intermediate diagnostic

Registered after the failed optimizer control and before implementation/run:
capture only the first DynamicQuantizeLinear/MatMulInteger pair and one
deterministically selected failing fixture item. The
[official ORT quantization debugging guide](https://onnxruntime.ai/docs/how-to/quantization.html)
recommends matching intermediate activations. The installed QDQ helper selects
FLOAT/FLOAT16 tensors; the current QOperator graph also requires UINT8/INT32
outputs, so a scratch graph with explicit existing outputs is needed.

Select the first row in fixed fixture order with ordinary logit delta above
0.001 in the bound all-control report (index 2 in this run). This selection is
for numerical fault diagnosis only, never an accuracy estimate. Keep the
original sanitized model immutable. Expose layer_norm, its DQL quantized data,
scale/zero-point, MatMulInteger output, cast/scaling and linear output. Use CPU
one intra/inter-op thread and WASM one thread; compare shape, finite values,
integer exact mismatch counts and floating maximum/mean differences.

Adding graph outputs may inhibit fusion or packing. First require the scratch
graph's final logits to reproduce the unmodified graph separately on each
backend with identical options. If this prerequisite fails, report the
instrumentation effect and do not attribute intermediate differences to the
canonical model. Start with `all`; if instrumentation prevents reproduction,
allow one separately recorded `disabled` control. Stop after these two settings
and one operator pair, preserving inconclusive results. Do not broaden the
capture, retune thresholds or infer a kernel fault from final logits alone.

### Measured first-pair result at 0dc814c

The bounded diagnostic ran on clean source
`0dc814cda3bfec86379928f505c6d3ed2725b5dc`. The copied runtime build was
`7db6271`; all 81 distribution files were byte-compared with its archived ZIP
before adding the scratch graph. It is separate from the subsequent new
extension build's full Windows/Linux validation.

Fixed fixture index2 was selected from the SHA-bound all-control report:
`jwtd-v2:test:12091:20947570:21018355:line-244:pre`, 33 tokens. CPU1/1 and
WASM1 thread both requested `all`; internal optimizer graphs remain unobserved.
Both instrumented graphs reproduced their own unmodified final logits exactly
(maximum delta0). Shape/dtype/finite checks passed for all nine outputs.

| Captured value                    | CPU/WASM difference                |
| --------------------------------- | ---------------------------------- |
| layer_norm                        | max0.00000095367431640625          |
| layer_norm_quantized / zero_point | exact integer mismatch0            |
| layer_norm_scale                  | max3.725290298461914e-9            |
| MatMulInteger output              | exact integer mismatch0            |
| Cast output                       | max0                               |
| combined scales                   | max1.4551915228366852e-11          |
| linear output                     | max0.0000019073486328125           |
| final logits                      | max0.2579023838043213; gate failed |

The selected first quantization pair matches within the frozen floating gate
and exactly for integer activations. The final discrepancy therefore remains
downstream for this row; this does not identify a faulty kernel or prove other
rows/pairs match. No disabled control ran: the registered condition was an
instrumentation effect, and both reproduction deltas were zero. Stop at one
row/one pair, with no model or tolerance change.

Evidence: `artifacts/quantized-intermediates/0dc814cda3bfec86379928f505c6d3ed2725b5dc/`.
`all/cpu.json` SHA `34f54876d34f4980574402a98c45c64f10ec9a2b3344a7c3473eea7dc9e37164`,
`all/browser.json` SHA `a9605b62d4841dc1f09fd8e7e32a8331f4b6f756697c39ce1fba4e5b43d0d8a7`,
NPZ SHA `119a8f773e8b582f124ee0c8b21937ca00795bba6c5b7d6904a00effc8f77fa9`.
CPU command exited0, browser command exited1 for final-logit mismatch. The
browser diagnostic observed zero requests/page errors after listener attachment;
startup before registration is outside that sample. The later full-context
security audit is separate. Independent review verified hashes, numerical
claims, stopping condition and absence of input text in reports/NPZ.

The CLI is `scripts/diagnose_quantized_intermediates.py` with required
`--output-model`, `--output-npz` (use a `.npz` suffix), `--output-report` and
`--graph-optimization all|disabled`. It pins source model, fixture and baseline
report. Place the generated model in an isolated extension copy, then use
`scripts/browser_intermediate_parity.mjs --extension <scratch-extension>
--model-relative diagnostics/all.onnx --cpu-report <new-cpu.json>
--cpu-npz <new-cpu.npz> --output <new-browser.json> --graph-optimization all`.
Choose new destinations; existing outputs are rejected. Never add diagnostic
outputs to the canonical distribution or rerun disabled without a registered
reason. A later-block boundary capture requires a new hypothesis and gate.
