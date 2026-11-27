# Model benchmark notes

Documentation checked 2026-11-28; no measurements rerun. The current preview uses
the 48,188,514-byte FP16-storage candidate described below. Its latency target is
unmet; general-corpus accuracy, current WebGPU and long-term memory are unmeasured.
Build/E2E passed, but audit cleanup failed and ZIP/SBOM were not generated.
See [preview validation](preview-validation.md). Historical QUInt8/FP16/FP32
measurements retain their own model hashes, settings and sources.

The closed [FP16-storage candidate](research/fp16-storage-candidate.md), source2914a68,
measured48,188,514 bytes and passed CPU/WASM parity64/64. Its first Windows11 /
Chromium159 / WASM1thread128-token run (3 warmups,20 samples) measured
p50=150.1ms/p95=200.5ms. It failed the100ms p50 target; subsequent performance runs were stopped.
The owner later deferred optimization and the same SHA was integrated into the
source aea6caf development preview, without claiming formal acceptance. This is direct ORT timing, not product end-to-end latency.

2026-11-27 resource observation at clean `72236f2`: the [offscreen close/recreate trial](research/offscreen-brokered-identity.md) completed four WASM inferences over three generations and two idle cycles. The associated-process working-set totals were 1,051,549,696 bytes at resume-1 and 2,669,510,656 bytes at resume-2; PID/role maps differed, so the ratio is unknown and resource acceptance remains unresolved. This is neither extension-only RSS nor simultaneous peak. No new accuracy, quantization or inference-latency benchmark was performed.

2026-11-27 update: source `67217cc` freshly evaluated the bundled sanitized QUInt8 on 2,000 development examples at threshold 0.5, using native ORT 1.32 on one CPU thread with graph optimization disabled. Event TP/FP/FN were 647/171/380, precision 79.0954%, recall 62.9990%, F1 0.701355, and clean false positives 50/1,000. F1 drop versus the frozen PyTorch baseline was 0.0148395; acceptance failed (exit 1). These training-exposed diagnostics are separate from optimized native results, held-out evaluation and browser-WASM accuracy. No new latency benchmark was run. The final audit measured a CDP-process HWM sum of 1,351,823,360 bytes, not simultaneous RSS peak or model-only memory. See [source-bound validation](validation-67217cc.md) and [next experiments](research/next-experiments.md). Historical timings below retain their original sources.

Measurements below were taken on 2026-11-26 JST on Windows with Python 3.12.13, CPU-only `torch==2.15.0+cpu`, `onnxruntime==1.32.0`, and `transformers==5.24.1` in the locked uv environment. The source model is revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`.

Reports referenced below are ignored local evidence, absent from a fresh checkout. Commands regenerate them after model preparation; they are not public download links. The historical previous packaged build used source `dd951b5`; the newer development snapshot is `67217cc`, described above. Linux validation used a different Python version (3.12.14) and is not part of these historical Windows timings. Updating this historical section did not rerun its measurements.

## Smoke measurements

Input: `明日の予定については、来週移行にご連絡します。` (12 non-special tokens in the tokenizer output).

| Path              |                                      Size | Inference time | Detection                      |
| ----------------- | ----------------------------------------: | -------------: | ------------------------------ |
| PyTorch reference |              147,101,260-byte safetensors |        53.3 ms | `[13,15)` `kanji-conversion_a` |
| ONNX FP32         | 148,552,783 bytes including external data |       12.21 ms | same                           |
| ONNX QUInt8       |                          38,356,996 bytes |        5.79 ms | same                           |
| ONNX FP16         |                          75,004,051 bytes |       11.25 ms | same                           |

The timings are single warm calls and must not be read as p50/p95. Browser WASM and the isolated WebGPU probe are measured separately below; the project makes no device-independent latency claim.

## Historical single-sentence parity

The following early smoke values are a separate single-sentence observation, retained as historical context rather than the current 40-item aggregate below. For that sentence, FP32 ONNX had max absolute logit error `1.34e-5`, mean absolute error `4.67e-6`, and 100% token argmax agreement against the PyTorch output. FP16 had max absolute error `1.90e-2`, mean absolute error `3.50e-3`, and 100% argmax agreement. The QUInt8 candidate had max absolute error `2.5451`, mean absolute error `0.4510`, and 91.7% argmax agreement. QUInt8 therefore remains a candidate requiring a larger evaluation set, despite producing the expected span in this smoke example.

The pipeline can be rerun with the conversion commands in [`docs/model-conversion.md`](model-conversion.md). The browser measurements are reported in the sections below; WebGPU results remain device-specific. A future general-accuracy benchmark must use a licensed, immutable corpus beyond the current self-authored synthetic set and report span-level precision, recall, F1, normal-text false positives, p50/p95/p99 latency, and peak memory separately for PyTorch, ONNX Runtime WASM, and WebGPU.

## Synthetic-v1 evaluation

`benchmarks/datasets/synthetic-v1.json` contains 20 clean and 20 self-authored typo sentences. It is MIT licensed, contains no private or external user text, and stores gold spans as Python Unicode codepoint offsets. The evaluation command loads each model once, runs all 40 sentences, and writes the detailed JSON result to the ignored `artifacts/benchmarks/synthetic-v1.json`:

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
uv run --locked python scripts/evaluation.py --output artifacts/benchmarks/synthetic-v1.json
uv run --locked python scripts/evaluation.py --output artifacts/benchmarks/synthetic-v1.json --check-conversion
```

The run used an AMD Ryzen 9 5900X 12-Core Processor (12 physical cores, 24 logical processors, 3701 MHz reported maximum) and PyTorch's default 12 intra-op threads. These are CPU-only results; ONNX Runtime used its default thread pool. Aggregate results are exact labeled span metrics; clean false-positive rate is the fraction of clean sentences with at least one predicted span.

Span evaluation merges adjacent tokens carrying the same non-OK label and uses the minimum token confidence for that merged span. Counts are calculated per sentence before aggregation. The extension SDK exposes token ranges, so adjacent marks and its displayed detection count need not equal the grouped span count in this report. Softmax confidence is not a calibrated probability that a human would judge the text incorrect.

`--check-conversion` is a bounded conversion regression gate for this small set. At threshold 0.5 it fails when any ONNX artifact's span F1 drops by more than 0.01 or clean false-positive rate rises by more than 0.02 versus PyTorch, or when FP32 maximum absolute logit delta exceeds 1e-3. It does not claim general Japanese precision or recall targets.

The QUInt8 artifact includes both the `Gather` embedding and `MatMul` weights: 38,356,996 bytes total, with the embedding block reduced from 104,857,600 FP32 bytes to 26,214,400 raw uint8 bytes. A MatMul-only comparison produced 116,999,844 bytes, so embedding quantization accounts for the dominant size reduction. The comparison artifact is ignored and is not a distribution target.

| Artifact          | Threshold |       Span P / R / F1 | Token F1 / accuracy | Clean FP rate | Max / mean abs logit delta vs PyTorch | Token argmax agreement |
| ----------------- | --------: | --------------------: | ------------------: | ------------: | ------------------------------------: | ---------------------: |
| PyTorch reference |      0.50 | 0.308 / 0.200 / 0.242 |       0.235 / 0.897 |         0.000 |                             reference |              reference |
| ONNX FP32         |      0.50 | 0.308 / 0.200 / 0.242 |       0.235 / 0.897 |         0.000 |                     3.00e-5 / 4.72e-6 |                 100.0% |
| ONNX QUInt8       |      0.50 | 0.364 / 0.200 / 0.258 |       0.255 / 0.897 |         0.000 |                       2.8061 / 0.4760 |                  93.3% |
| ONNX FP16         |      0.50 | 0.308 / 0.200 / 0.242 |       0.235 / 0.897 |         0.000 |                     1.98e-2 / 3.53e-3 |                 100.0% |
| PyTorch reference |      0.80 | 0.500 / 0.150 / 0.231 |       0.256 / 0.893 |         0.000 |                             reference |              reference |
| ONNX FP32         |      0.80 | 0.500 / 0.150 / 0.231 |       0.256 / 0.893 |         0.000 |                         same as above |                 100.0% |
| ONNX QUInt8       |      0.80 | 0.500 / 0.100 / 0.167 |       0.216 / 0.889 |         0.000 |                         same as above |                  93.3% |
| ONNX FP16         |      0.80 | 0.500 / 0.150 / 0.231 |       0.256 / 0.893 |         0.000 |                         same as above |                 100.0% |
| PyTorch reference |      0.95 | 1.000 / 0.050 / 0.095 |       0.061 / 0.882 |         0.000 |                             reference |              reference |
| ONNX FP32         |      0.95 | 1.000 / 0.050 / 0.095 |       0.061 / 0.882 |         0.000 |                         same as above |                 100.0% |
| ONNX QUInt8       |      0.95 | 1.000 / 0.050 / 0.095 |       0.061 / 0.882 |         0.000 |                         same as above |                  93.3% |
| ONNX FP16         |      0.95 | 1.000 / 0.050 / 0.095 |       0.061 / 0.882 |         0.000 |                         same as above |                 100.0% |

At threshold 0.50, label-wise F1 for the reference/FP32/FP16 was 0.000 for `deletion`, 0.375 for `kanji-conversion_a`, 0.000 for `kanji-conversion_b`, and 0.167 for `substitution`; QUInt8 changed `kanji-conversion_a` to 0.429 while `substitution` remained 0.167. Span and label counts are aggregated per document, so identical offsets in different sentences remain distinct examples. The remaining labels had no gold support and are retained in the JSON as zero-support rows. This result is useful for conversion regression, but it is not a claim of production accuracy: the synthetic set is small, the gold label conventions cover only three non-OK labels, and no licensed real-world corpus has been evaluated yet.

## JWTD development calibration (2026-11-27)

Source `af8cd94`, pinned model revision and locked Windows CPU environment. The [frozen protocol](evaluation-protocol.md) uses labeled one-to-one diff containment, preserving equivalent full reconstruction alternatives. This training-exposed calibration subset has 1,000 typo/corrected pairs (2,000 examples) with test/gold page and normalized-text overlap excluded. It is not independent general-accuracy evidence. No held-out threshold fitting is allowed.

| Model       | Precision | Recall |     F1 | Clean records flagged |
| ----------- | --------: | -----: | -----: | --------------------: |
| PyTorch     |    79.38% | 65.24% | 0.7162 |              55/1,000 |
| ONNX FP32   |    79.38% | 65.24% | 0.7162 |              55/1,000 |
| ONNX QUInt8 |    78.18% | 62.80% | 0.6965 |              55/1,000 |
| ONNX FP16   |    79.60% | 65.34% | 0.7176 |              54/1,000 |

These rows use threshold 0.5. None of 0.5/0.6/0.7/0.8/0.9/0.95/0.99 satisfied all development targets. The frozen decision retains 0.5 for diagnosis with `admissible: false`. QUInt8 F1 is lower than the reference by 0.01965 here, exceeding the 0.01 target. The reference itself misses precision/recall/clean targets, so quantization alone does not explain the unmet quality gate.

FP32 maximum absolute logit delta was 0.0000401 and ordinary-token argmax agreement 100% over 62,936 tokens. QUInt8 agreement was 99.79%, FP16 100%; their max logit deltas were 5.7777 and 0.02769. Token agreement is distinct from span accuracy. Per-label metrics, thresholds, intervals, source/dataset/protocol/model/tokenizer SHA values and caches are in local `artifacts/corpus-evaluation/development-v1/`. These corpus runs are accuracy evaluation, not latency benchmarks.

## Experimental weight-only development evaluation (2026-11-27)

Source `b63801b1c31d9bc6ce3f4308f03edf174f69ca81`, candidate SHA
`693fbd3f1fecd8a421f2ff6c7cb60ff1cb3a333361a0fc74425bd8c5e1a42aff`,
37,825,117 bytes. A fresh native CPU run used ORT1.32.0 with one intra/inter-op
thread and `ORT_DISABLE_ALL`, matching the reference condition in the passed
fixed-input WASM diagnostic. It evaluated the same frozen development 2,000
examples at threshold 0.5, without using or retuning on held-out results.

| Path                      | Precision | Recall |       F1 | Clean records flagged |
| ------------------------- | --------: | -----: | -------: | --------------------: |
| Frozen PyTorch baseline   |    79.38% | 65.24% | 0.716195 |       55/1,000 (5.5%) |
| Weight-only QDQ candidate |    78.90% | 65.53% | 0.715957 |       56/1,000 (5.6%) |

The candidate has 673 TP, 180 FP, and 354 FN. F1 degradation is
0.0002371016 (about 0.024 percentage points), within the 0.01 conversion target.
The candidate and reference still fail the precision/recall targets, and the
candidate's clean false-positive rate exceeds 2%. The command completed all
inference and returned exit code 1 for failed product acceptance. This does
not establish independent accuracy or justify a release candidate.

Evidence is `artifacts/candidate-evaluation/weight-only-b63801b/` with a numeric
report, fresh logits cache and sidecar. The earlier baseline keeps source
`af8cd948...` and its original SHA values. The driver verifies unchanged
scoring functions against that source's Git blob and unchanged scorer
dependencies, recording both old and current runner hashes. No historical
cache was relabeled. WASM latency and memory are separate measurements.

## JWTD official-test evaluation (2026-11-27)

Source `af8cd9480431052da280bc0e536f8ae5f65eeb62`, the same pinned model and Windows CPU environment. Of 5,440 source pairs, 5,436 were accepted: three could not be reconstructed and one used an undefined label. Both sides produce 10,872 examples. The diagnostic threshold remains 0.5 from the failed development selection; no test threshold tuning was performed. Wikipedia pretraining exposure is unknown, and this dataset does not establish accuracy on everyday mail, SNS, or technical writing.

| Model       | Precision | Recall |     F1 | Clean records flagged |
| ----------- | --------: | -----: | -----: | --------------------: |
| PyTorch     |    74.57% | 63.32% | 0.6849 |     469/5,436 (8.63%) |
| ONNX FP32   |    74.57% | 63.32% | 0.6849 |     469/5,436 (8.63%) |
| ONNX QUInt8 |    74.15% | 62.07% | 0.6757 |     459/5,436 (8.44%) |
| ONNX FP16   |    74.56% | 63.32% | 0.6848 |     469/5,436 (8.63%) |

The reference and candidate fail precision, recall, and clean false-positive targets; no admissible development threshold exists. The runner completed inference and returned exit code 1 for failed acceptance. QUInt8 F1 is lower than reference by 0.00915 on this test, within the 0.01 target for this scope, while the development drop exceeded that target. This does not override the failed product gate.

FP32 maximum/mean absolute logit deltas were 0.0000591/0.00000459 with 100% ordinary-token argmax agreement over 345,726 tokens. QUInt8 agreement was 99.7536%, with maximum/mean deltas 7.12851/0.42210; FP16 agreement was 99.9962%, with deltas 0.04692/0.00254. The local evidence is `artifacts/corpus-evaluation/held-out-v1/evaluation.json` and four SHA-bound caches. Do not derive browser latency from corpus runtime.

The separate fixed 64-example QUInt8 browser comparison failed: 40 rows exceeded the 0.001 ordinary-token logit tolerance (maximum 2.6066494), one row had an argmax mismatch, and three had SDK span mismatches. All input IDs, attention masks, shapes, and offsets matched; external requests and page errors were zero. The same sanitized model on native CPU with one intra-op/inter-op thread reproduced every cached logit exactly. Evidence: `artifacts/browser-corpus-parity-tokenids.json` and `artifacts/browser-corpus-native-diagnostic.json`. This isolates the tested feed and native-thread cases, but does not yet prove a specific WASM kernel or runtime-version cause. The subset measures parity, not general accuracy; see [the diagnostic protocol](browser-corpus-parity.md).

## Browser WASM benchmark

The standalone `scripts/browser_benchmark.mjs` measured the frozen `dist/extension` inference assets in offline headless Chromium on Windows 11 (Chromium `159.0.8154.6`, Node `24.15.0`). It loaded the bundled `core.js`, tokenizer, QUInt8 model, and local ORT WASM files from the extension origin. The model was initialized once with one WASM thread; each length used three warm-up calls followed by 20 `session.run` samples. Inputs are exact tensor lengths with valid tokenizer IDs, a BOS token, and an EOS token.

| Input tokens |        p50 |        p95 |        p99 |       mean |
| -----------: | ---------: | ---------: | ---------: | ---------: |
|           32 |    30.9 ms |    41.5 ms |    50.7 ms |    31.7 ms |
|           64 |    44.6 ms |    59.0 ms |    65.9 ms |    46.2 ms |
|          128 |    90.6 ms |   108.6 ms |   115.3 ms |    91.9 ms |
|          256 |   204.5 ms |   251.0 ms |   251.2 ms |   210.5 ms |
|          512 |   484.0 ms |   559.2 ms |   598.6 ms |   487.4 ms |
|        1,024 | 1,610.2 ms | 1,821.5 ms | 1,919.9 ms | 1,613.6 ms |

At 128 tokens, the measured WASM p50 of 90.6 ms and p95 of 108.6 ms are below the provisional 100 ms and 250 ms targets. These are measurements of the frozen local inference assets and do not establish a device-independent performance guarantee.

Cold initialization was 2,110.4 ms, including the bundled core import (56.1 ms), tokenizer initialization (408.3 ms), and ONNX session creation (1,643.5 ms). The measured sanitized model file was 37,789,676 bytes with SHA-256 `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`, revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`.

No external requests were observed in the benchmark's monitored HTTP/page WebSocket scope while offline, and the page reported no errors. All-worker WebSocket/CDP initiator auditing was not performed. JavaScript heap counters were available: 75,006,233 bytes before timed runs and at most 81,498,129 bytes after the measured lengths. These counters cover the extension page's JavaScript heap only; native WASM allocations and process peak memory were not measured.

Chromium reported a WebGPU API and adapter, but adapter information was empty in this headless run. WebGPU inference was not executed, so this result contains no WebGPU latency or hardware-GPU claim. The complete machine-readable report is local `artifacts/browser-benchmark.json`; rerun the measurement with:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/playwright"
node scripts/browser_benchmark.mjs
```

## Experimental weight-only WASM benchmark (2026-11-27)

Source `15531cc854beac95d7767c9dd8c289a6969a2098`, offline Chromium
159.0.8154.6, Node24.15.0, ORT Web1.31.1, one WASM thread. The isolated
37,825,117-byte candidate and tokenizer/config assets were checked against
their manifest before execution. Each length used three warm-ups and 20
`session.run` samples; tokenizer/UI/post-processing are outside these timings.

| Input tokens |       p50 |       p95 |       p99 |
| -----------: | --------: | --------: | --------: |
|           32 |  128.2 ms |  202.5 ms |  205.1 ms |
|           64 |  151.0 ms |  175.1 ms |  176.2 ms |
|          128 |  230.2 ms |  258.5 ms |  262.9 ms |
|          256 |  385.1 ms |  450.1 ms |  481.1 ms |
|          512 |  798.7 ms |  917.6 ms |  951.0 ms |
|         1024 | 2050.9 ms | 2236.6 ms | 2458.5 ms |

The 128-token p50 and p95 exceed the 100/250ms targets. Cold initialization
was 2,357.8ms (core import 55.7ms, tokenizer 537.0ms, session 1,761.6ms).
The report records no popup-page external requests or page errors; that scope
is not the full-extension communication audit. The candidate has not replaced
the distributed model. These are separate measurements from the historical
QUInt8 benchmark, not a randomized paired speed comparison.

Before and after the timed runs, OS memory queries measured the eight
CDP-enumerated browser processes. Aggregate working set was 471,928,832 bytes
before and 899,702,784 bytes after; final per-process high-water marks sum to
1,377,234,944 bytes. These include Chromium overhead and do not isolate model
memory. The HWM sum is not simultaneous RSS peak, helpers omitted by CDP are
outside scope, and samples were taken outside timed runs. JS heap is reported
separately. Evidence: `artifacts/benchmarks/weight-only-wasm-15531cc.json`, SHA
`c8ba8a423a283eff715516fa2ef11bbae3d12e70c8e1caa50872b21a4ec45766`.

## Isolated WASM thread experiment (2026-11-27)

At source `c4f42acf562c04c2b18846d20c655b6051d46e27`, a separate extension
copy added COEP `require-corp` and COOP `same-origin`. Permissions, CSP, model,
tokenizer, and WASM files were unchanged. Both serial runs reported
`crossOriginIsolated=true`, usable SharedArrayBuffer, hardwareConcurrency 24,
and the requested ORT thread setting after initialization. The pinned runtime
sets that setting to 1 on unsupported multithreading; its post-initialization
value is configuration evidence, not a measurement of CPU scheduling.
One/three local asyncify worker events were also observed as diagnostics.

| Requested ORT threads | 128-token p50 | 128-token p95 | Cold init | Final browser working set |  Sum of process HWM |
| --------------------: | ------------: | ------------: | --------: | ------------------------: | ------------------: |
|                     2 |       151.8ms |       179.0ms |  2345.2ms |         933,961,728 bytes | 1,415,503,872 bytes |
|                     4 |       128.6ms |       144.2ms |  2083.6ms |         962,297,856 bytes | 1,421,008,896 bytes |

Both p50 measurements exceed 100ms; p95 is below 250ms. Memory was collected
outside the timed runs and has the same CDP/process/HWM scope limitations as
the one-thread experiment. No popup-page external requests or page errors
were observed. This does not establish multithreaded offscreen-worker
inference, multithreaded numerical parity, or full-extension communication
coverage. The normal extension remains single-threaded and unchanged.

Reports: `artifacts/benchmarks/weight-only-wasm-2threads-c4f42ac.json` (SHA
`5e3b242bc02f8923a622979d4d6ee4a193512541bc0e43f3d540e438ce1a3291`)
and `artifacts/benchmarks/weight-only-wasm-4threads-c4f42ac.json` (SHA
`835419085fb1ed21083d41afcf91c4181d84b4a6d8f2c1b5cf43df9ccf4a15cf`).

## Gather-before-dequantization candidate (2026-11-27)

An opt-in converter change at `bdd81fe` applies embedding Gather before
DequantizeLinear, so only selected rows are expanded. Linear weights and float
activations retain the weight-only QDQ path. The isolated model is 37,825,039
bytes, SHA `4cd8f3a048ec403c1aa521da1e00e38c5b24414ffa97a6ffb325de15b68d9ee7`.
At source `838189b`, its fixed 64-row CPU/WASM diagnostic passed with maximum
logit delta 0.0000257492 and no argmax/span mismatch. CPU optimization was
disabled; the browser kept default optimization.

The one-thread Windows/Chromium159 benchmark used 3 warmup runs and 20 measured
session runs per length. At 128 tokens p50 was 187ms and p95 243.3ms; cold init
was 2,142.4ms. The p50 100ms target remains unmet. Final CDP-associated working
set was 859,897,856 bytes; process HWM sum was 1,247,326,208 bytes, which is
not simultaneous RSS peak. No popup-page external requests or page errors
were observed. These serial experiments are not randomized paired controls.
Neither full-extension communication coverage nor fresh development accuracy
is established for this model by the benchmark. The distributed model remains
unchanged.

Evidence: `artifacts/browser-corpus-weight-only-after-gather-wasm-v1.json` and
`artifacts/benchmarks/weight-only-after-gather-wasm-1thread-838189b.json`.

The new model's fresh 2,000-example development evaluation at `1d1bc73`
measured event precision 78.90%, recall 65.53%, F1 0.715957 and 56/1,000 clean
records flagged. F1 degradation 0.0002371 passes the quantization criterion;
product accuracy still fails. Evidence:
`artifacts/candidate-evaluation/weight-only-after-gather-1d1bc73/candidate-evaluation.json`.

Two isolated 4-thread runs at `1d1bc73` measured 128-token p50/p95
96.82/118.14ms and 114.595/146.52ms. Both confirmed isolation, SharedArrayBuffer
and effective ORT setting 4. The first run could overlap a unit-test process;
it is preserved as a diagnostic and is not selected as adoption evidence.
The repeat still exceeds the p50 target. Its final CDP working set was
931,045,376 bytes and HWM sum 1,327,710,208 bytes, with the scope limitations
above. Offscreen-worker multithreaded parity has not been tested. The candidate
is not adopted on the basis of the favorable first result.
Reports: `artifacts/benchmarks/weight-only-after-gather-wasm-4threads-1d1bc73.json`
and `artifacts/benchmarks/weight-only-after-gather-wasm-4threads-quiet-1d1bc73.json`
(repeat SHA `4ab5b81757cd27c49e0cb5ca203bd0b88764c1918593a062c8501d9331644e5f`).

## WebGPU FP16 probe

An isolated probe executed the FP16 model through the extension's WebGPU backend without changing `dist/extension`. The script copied the current extension to `.cache/isolated-gpu-extension`, added `models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/onnx/model_fp16.onnx`, opened it in offline headless Chromium `159.0.8154.6`, and requested the `webgpu` execution provider explicitly. It did not fall back to WASM.

| Measurement                |                                                             Result |
| -------------------------- | -----------------------------------------------------------------: |
| Adapter vendor             |                                                           `nvidia` |
| Adapter architecture       |                                                         `lovelace` |
| Adapter fallback flag      |                        unavailable (`null` in this Chromium build) |
| FP16 model size            |                                                   75,004,051 bytes |
| FP16 model SHA-256         | `2bd598540637adf07ffe338c55e81ec7cc37cec017d85a5fdca4c8c5159b28a8` |
| Cold initialization        |                                                         2,743.5 ms |
| Short 16-token inference   |                                                         1,431.9 ms |
| 128-token p50 (20 samples) |                                                            68.4 ms |
| 128-token p95              |                                                            75.8 ms |
| 128-token p99              |                                                            86.4 ms |

The 128-token run used three warm-ups and 20 timed samples. The short inference and timed run both completed with `session.run` on the requested WebGPU provider; the session inputs were `input_ids` and `attention_mask`, and the output was `logits`. No external requests or page errors were observed while offline. This is evidence for the tested NVIDIA/Chromium environment only and is not a cross-device WebGPU performance guarantee. The complete result is local `artifacts/webgpu-probe.json`; rerun with:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/playwright"
node scripts/webgpu_probe.mjs
```
