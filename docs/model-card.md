# Kotoba Guard converted model card

## Current development preview — documentation checked 2026-11-28

The tested preview source is `aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17`.
It bundles `embedding-u8-matmul-fp16-storage`: 48,188,514 bytes, SHA-256
`4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7`.
The original UINT8 embedding is gathered before DQ; 42 original MatMul B weights
are stored as FLOAT16 and cast to FLOAT for FLOAT32 computation. This is not
all-FP16 arithmetic or WebGPU. The compatibility filename remains `onnx/model_quantized.onnx`;
the manifest's model_kind identifies the variant.

At converter source `2914a68`, all 64 fixed native-all/WASM-all rows passed
ID/mask/offset/shape/dtype/finite, ordinary argmax and span checks; maximum
ordinary logit delta was 0.0000247955322265625. One 128-token WASM1thread run
(3 warmups/20 samples) measured p50=150.1ms/p95=200.5ms, missing the 100ms p50
target. Optimization was then deferred by the owner and the same numerical
model was integrated into the local preview. No general-corpus accuracy
evaluation of this variant was run. Do not transfer historical QUInt8 metrics below.

The saved preview passed its build and seven E2E tests. Auditor source e627333
subsequently fixed cleanup and passed the real-model audit with zero unexpected
requests, verified coverage/assets and all eight cleanup operations. Final-source
ZIP validation and GitHub preview publication are being prepared.
See [preview validation](preview-validation.md) and [FP16-storage experiment](research/fp16-storage-candidate.md).

## Historical conversion and evaluation records

The following sizes, sanitized QUInt8 inventory and evaluations describe earlier
artifacts. References to bundled QUInt8 apply to the frozen older distribution,
not the current preview. Their original sources and measurement dates are retained.

## Model

This is a conversion of [SB Intuitions' Japanese typo detector](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m), not a newly trained model. The exact source revision is `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`. The upstream model is MIT licensed; see the upstream `LICENSE` and the copied license in each converted distribution directory.

The task is Japanese token classification. Labels and IDs are read from the upstream `config.json`; the nine labels are `OK`, `deletion`, `insertion_a`, `insertion_b`, `kanji-conversion_a`, `kanji-conversion_b`, `substitution`, `transposition`, and `others`.

## Converted artifacts

The FP32 ONNX graph plus external data is about 148.6 MB in total. The QUInt8 candidate is 38.4 MB and the FP16 candidate is 75.0 MB. These are local Windows measurements from the pinned model and locked environment used for those historical measurements, not a universal download-size guarantee.

The QUInt8 candidate quantizes the embedding `Gather` and `MatMul` weights. The embedding is 104,857,600 bytes in FP32 and 26,214,400 bytes as raw uint8 storage; the complete embedding-inclusive artifact is 38,356,996 bytes. A MatMul-only comparison artifact measured 116,999,844 bytes, confirming the embedding is the dominant size reduction. See the [benchmark report](benchmarks.md) for the current bounded parity and accuracy measurements.

The extension ships a separate sanitized QUInt8 copy: 37,789,676 bytes, SHA-256 `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`. Removing 584 debug fields containing private filesystem paths preserved CPU logits exactly for fixed synthetic token-ID inputs at lengths 8/32/128. Source conversion artifacts are retained privately; their hash and the sanitized inventory are recorded separately. See [model-conversion.md](model-conversion.md).

Raw sizes above describe local conversion artifacts; the frozen older distribution bundled only the sanitized QUInt8 variant. The tracked [pin manifest](../models/manifest.json) does not inventory generated weights. Local raw and distribution manifests and benchmark JSON are ignored; reproduce them using the [build instructions](../README.en.md#build-and-load-the-unpacked-extension) or attach explicitly reviewed assets when publication is authorized. No converted model has been uploaded to Hugging Face.

## Known validation result

The development snapshot at source `67217cc` freshly evaluated the bundled sanitized QUInt8 on 2,000 development examples at threshold 0.5, using native ORT 1.32 on one CPU thread with graph optimization disabled. Precision/recall/F1 were 79.0954%/62.9990%/0.701355; clean records flagged were 50/1,000. F1 drop versus the frozen PyTorch baseline was 0.0148395, so acceptance failed. This is not browser-WASM general accuracy or an independent practical evaluation. Optimized native and held-out measurements below retain their own conditions. See [validation](validation-67217cc.md).

For `明日の予定については、来週移行にご連絡します。`, the PyTorch reference, FP32 ONNX, QUInt8, and FP16 artifacts all reported span `[13, 15)` as `kanji-conversion_a`. In the bounded 40-item evaluation, FP32 had maximum/mean absolute logit deltas `3.00e-5`/`4.72e-6` with 100% token argmax agreement; QUInt8 had `2.8061`/`0.4760` with 93.3% agreement; and FP16 had `1.98e-2`/`3.53e-3` with 100% agreement. These are conversion regression measurements, not production accuracy claims.

No correction sentence is generated. A detected span is a possible typo and must be shown with calibrated language in the extension UI.

On 2026-11-27, a training-exposed JWTD calibration subset (1,000 typo/corrected pairs, 2,000 examples) was evaluated under the [frozen protocol](evaluation-protocol.md). At threshold 0.5, reference labeled-event precision/recall/F1 were 79.38%/65.24%/0.7162, and QUInt8 were 78.18%/62.80%/0.6965. Both flagged 55 of 1,000 corrected clean records. No tested development threshold met all product targets; this is a failed calibration acceptance, not independent general accuracy.

The official-test evaluation then completed on 5,436 accepted pairs (10,872 examples), retaining diagnostic threshold 0.5 without retuning. Reference precision/recall/F1 were 74.57%/63.32%/0.6849; QUInt8 were 74.15%/62.07%/0.6757. Clean records flagged were 469/5,436 (8.63%) and 459/5,436 (8.44%), respectively. Accuracy acceptance failed for both the reference and candidate. The QUInt8 F1 drop was 0.00915 on this test and 0.01965 on development; both scopes are preserved. Full metrics and source provenance are described in [benchmarks](benchmarks.md).

## Experimental weight-only artifact

A separate, unbundled weight-only QDQ artifact is 37,825,117 bytes (SHA-256
`693fbd3f1fecd8a421f2ff6c7cb60ff1cb3a333361a0fc74425bd8c5e1a42aff`).
Native CPU with graph optimization disabled and default browser WASM agreed
on the fixed 64-row diagnostic (maximum logit delta 0.0000257492). This is not
an independent accuracy evaluation. A fresh development run at `b63801b`
measured precision 78.90%, recall 65.53%, F1 0.715957, and 56/1,000 clean
records flagged. F1 degradation versus the frozen reference was 0.0002371.
Product accuracy targets remain unmet.

Its one-thread WASM benchmark at `15531cc` measured 128-token p50 230.2ms
and p95 258.5ms, above the 100/250ms targets. It has not replaced the bundled
QUInt8 model. Process working-set/HWM observations are described separately
in [benchmarks](benchmarks.md); they are not model-only memory or simultaneous
RSS peak measurements. This artifact is a local experiment, not a published
converted model.

An opt-in Gather-before-dequantization variant is 37,825,039 bytes, SHA-256
`4cd8f3a048ec403c1aa521da1e00e38c5b24414ffa97a6ffb325de15b68d9ee7`.
Its fixed 64-row CPU/WASM gate passed, and a fresh 2,000-example development
evaluation at `1d1bc73` measured the same event precision/recall/F1 and clean
false-positive counts as the older weight-only variant. This is a distinct
evaluation with new model/cache hashes, not a relabeled old report.
One-thread 128-token WASM p50/p95 were 187/243.3ms at `838189b`; the p50 target
is unmet. Neither variant has replaced the bundled model. The
[acceptance decision](adr/0008-model-acceptance.md) retains failed accuracy
gates and prohibits treating conversion parity as product acceptance.

## Limitations

The local synthetic set is small, and the JWTD development subset may have been exposed during training. Neither that subset nor the official Wikipedia test establishes performance on everyday mail, SNS, or technical writing. CPU parity, synthetic/calibration/official-test precision/recall/F1, browser WASM latency, and an isolated NVIDIA WebGPU FP16 probe are recorded in the [benchmark report](benchmarks.md). JS heap and scoped CDP/OS process memory are measured separately; complete process peak memory remains unverified. WebGPU is not enabled in the normal extension UI. The model may be wrong on names, domain terms, dialects, and text with unusual formatting.
