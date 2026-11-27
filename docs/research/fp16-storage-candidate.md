# Embedding UINT8 / MatMul FP16 storage candidate

Documentation follow-up: 2026-11-28. The source2914a68 performance experiment
below remains closed and failed; its original adoption decision is historical.
After the owner deferred optimization, the same model SHA was integrated into
the isolated sourceaea6caf preview. Build and seven E2E tests passed; the
communication audit failed on context cleanup, so ZIP/SBOM were not generated.
General-corpus accuracy and formal M5 remain incomplete. Development is paused.
See [current preview validation](../preview-validation.md). This does not authorize
a retry of the closed performance experiment or public release.

## Registered decision

This is one new candidate, `embedding-u8-matmul-fp16-storage`. Keep the pinned
30M model revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8` and the exact
existing UINT8 embedding. Gather its selected rows before dequantization.
Store the original 42 constant MatMul B tensors as FLOAT16, then Cast to FLOAT
before the original float MatMul operations. Activations remain FLOAT32.
This changes weight storage; it does not request FLOAT16 CPU arithmetic.

The static graph inspection in `artifacts/fp16-storage-inspection.json` found
10,553,600 MatMul elements and 26,214,400 embedding elements. Their stored
payload would be 47,321,600 bytes, excluding graph and other constants.
Actual size, numerical parity, speed and accuracy are unmeasured at registration.

[ONNX Cast](https://onnx.ai/onnx/operators/onnx__Cast.html) defines the numeric
conversion. [ORT float16 guidance](https://onnxruntime.ai/docs/performance/model-optimizations/float16.html)
does not establish CPU FP16 arithmetic support or a performance improvement for
this storage-only graph. Kernel selection and optimizer folding require measurement.

## Gates and stopping conditions

Commit reviewed source before real conversion. Record that commit, the converter
manifest and all input/output hashes. Use fresh isolated output directories;
preserve the frozen distribution, old ZIP and all prior candidate results.

1. Convert exactly one candidate. Require the existing strict 43 mappings,
   42 FLOAT16-to-FLOAT MatMul casts, one exact UINT8 embedding, no dynamic
   integer MatMul/activation quantization and a self-contained model at most
   50,000,000 bytes. A failed conversion or invariant stops the candidate.
2. Run native ORT once, one thread, ORT_ENABLE_ALL, on the existing fixed 64-row
   token-ID fixture. Its SHA-256 is
   `4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47`.
3. Compare WASM once with optimization `all`, the identical model and inputs.
   Require float32 finite outputs, exact dimensions/IDs/masks/offsets, ordinary
   token logit difference at most 0.001, equal argmax and equal spans.
   Require process exit zero and browser cleanup. Failure stops this candidate;
   no disabled-optimization fallback, layer search or retry.
4. Only after numerical success, permit up to three fresh WASM one-thread
   benchmarks, 128 tokens only, each with three warmups and 20 measured samples.
   Every run must meet p50 <=100ms and p95 <=250ms and existing benchmark
   integrity checks. Stop at the first failure; do not search thread counts.
   Record memory observations as scoped measurements, not long-term acceptance.

Conversion and native stage each have a 600-second outer limit; each browser
stage has a 600-second outer limit. Timeout, unknown cleanup or infrastructure
failure is inconclusive/failed, never a reason to start a replacement browser.
No accuracy-corpus run or product adoption is authorized by this experiment.
The independent-gold and original-model accuracy gaps remain open even if all
these numerical and performance gates pass. Prior rejected candidates remain
closed.

## Original experiment result — closed, not adopted at that gate

Executed once at clean source `2914a68d0fe78552162bede86d110455b95d67c0`,
tree `52fc9a543b4724ed46d8ba72a443f0a169f4f2ef`, on Windows11 x64,
Node24.15.0, Chromium159.0.8154.6, native ORT1.32.0 / web ORT1.31.1.
Evidence is under `artifacts/candidates/fp16-storage/<source>/`.

| Gate                  | Measured result                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Conversion            | 48,188,514 bytes; self-contained, 43 mappings / 42 FP16 MatMul casts / one embedding DQ      |
| Native CPU            | 64 rows, ORT_ENABLE_ALL, one intra/inter-op thread, exit0                                    |
| WASM parity           | 64/64 pass, max ordinary logit difference 0.0000247955322265625                              |
| Input/output checks   | Exact IDs/masks/offsets/shapes, finite float32, identical ordinary argmax and spans on all64 |
| First performance run | 128 tokens, three warmups / 20 samples, p50 150.1ms / p95 200.5ms                            |
| Decision              | p50 exceeds100ms: stop; second/third runs unexecuted; candidate not adopted                  |

Model SHA-256:
`4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7`.
The conversion, CPU, browser and first benchmark subprocesses exited0; the
outer decision process exited1 for the failed latency gate. Both browser
commands completed their context cleanup. Their scoped network/page-error
counts were0. This is direct-ORT evidence, not a new product-Worker test or
a full-context communication audit. The requested WASM graph optimization
was accepted as `all`; internal optimized kernels were not observed.

Cold initialization was2490.8ms. Benchmark CDP-associated process Working Set
sum after measurement was905,142,272 bytes; HWM sum1,137,917,952 bytes is not
a simultaneous peak. Process membership changed, so no growth ratio or
extension-only memory improvement is inferred. WebGPU, new accuracy-corpus
evaluation, product integration and other platforms were not run.

Final relevant Python13 tests/Ruff and all TypeScript602 tests passed. The
benchmark review regressions were Red3 → Green22; the legacy manifest
regression was Red1 → Green13. Lint/type/format checks passed. The existing
distribution and recorded input/source controls were unchanged after execution.
The experiment budget is closed; do not rerun it, change threads/optimization,
or relax the latency gate to adopt it. Original accuracy, independent practical
gold, long-term memory and the remaining M5 gates are still unresolved.

## Development-preview policy

The delivery priority changed after this experiment: speed, model size and
long-term memory optimization are deferred to a later phase. The candidate's
measured numerical parity therefore permitted a separately validated development
preview integration, subject to the required security, offline and real-E2E
checks. The latency result and the open accuracy constraints remain explicit;
this preview plan does not mark the formal M5 gate as passed, adopt the
candidate for general release, or grant publication permission.

The isolated runner copied the unchanged frozen distribution, then added the
candidate ONNX file and `models/candidate-manifest.json`. The latter combines
the baseline tokenizer/config inventory with the candidate size/hash, converter
manifest SHA-256, and its `conversion.schema_version/options`. The benchmark
requires the FP16 storage schema and FLOAT compute options. A changed token-length
scope also requires a source commit and refuses existing output, even without
candidate-model options. The legacy converter manifest shape is preserved.
