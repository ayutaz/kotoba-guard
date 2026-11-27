# Model conversion

現在はGitHub v0.1.0プレビュー公開済み。[v0.1.0公開記録](validation-v0.1.0.md)を参照。以下の測定・停止記録は各記載日時点の範囲を示す。

Documentation checked 2026-11-28. The GitHub preview is published; additional experiments remain deferred. The current preview uses
FP16 weight storage with FLOAT computation; the default pipeline and historical
artifact tables below retain the old dynamic-QUInt8 conversion path.

To stage an existing FP16-storage candidate after resume, use
`uv run --locked python scripts/prepare_models.py --preview-from <candidate.onnx> --output <fresh bundle>`.
It verifies adjacent converter provenance, model size/SHA, and canonical
config/tokenizer/tokenizer_config/LICENSE before copying the five runtime assets.
No download, conversion or inference occurs in that staging mode. It writes the
pinned ID/revision/license, model_kind and converter hashes/options to the bundle
manifest; it rejects existing, overlapping or linked paths. Then use the explicit
`--model-source`/`--out-dir` build flags in [release](release.md#ローカルpreviewの作成).
Do not replace frozen canonical outputs or run this during documentation maintenance.

The opt-in `--weight-only --embedding-after-gather --matmul-fp16-storage`
mode stores the original MatMul B weights as FLOAT16 and casts them to FLOAT
before arithmetic, retaining the exact UINT8 embedding. The closed
[2914a68 experiment](research/fp16-storage-candidate.md) measured48,188,514 bytes
and passed CPU/WASM64-row numerical parity, but failed the128-token p50 target
(150.1ms). The performance experiment remains closed and failed. The owner
later deferred optimization, and the same SHA was integrated into the isolated
development preview at source aea6caf; this is not formal acceptance or publication.
See [preview validation](preview-validation.md). Do not repeat the experiment.
Default conversion and legacy manifest schema are preserved.

The conversion pipeline is implemented in [`scripts/model_pipeline.py`](../scripts/model_pipeline.py). It keeps the upstream revision explicit and writes browser-facing artifacts to `models/converted/<revision>/onnx`:

| Artifact                            | Purpose                                                                                                        |              Local result |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------: |
| `model.onnx` plus `model.onnx.data` | FP32 ONNX Runtime model                                                                                        | 1458255 + 147094528 bytes |
| `model_quantized.onnx`              | Dynamic QUInt8 quantization of the embedding `Gather` and `MatMul` weights for CPU use; browser WASM candidate |          38,356,996 bytes |
| `model_fp16.onnx`                   | FP16 weights for WebGPU evaluation                                                                             |          75,004,051 bytes |

The FP32 export uses PyTorch's dynamo exporter, opset 18, and dynamic batch/sequence axes. The model is wrapped to expose `input_ids`, `attention_mask`, and `logits` only. ONNX Runtime CPU loaded the FP32, QUInt8, and FP16 artifacts locally. The FP32 external-data file is required alongside `model.onnx`; moving only the small graph file is incomplete.

## Distribution metadata sanitization

Raw export metadata contained developer filesystem paths in debug stacktraces. Raw conversion files remain private and are not copied unchanged into the extension. The build verifies the raw QUInt8 source SHA and invokes `scripts/sanitize_model.py --verify` on a separate output. The sanitizer removes only private-path-bearing debug metadata, retains license metadata, and fails on private paths in semantic fields. Tests preserve the source model and graph bindings.

The shipped QUInt8 copy removes 584 debug fields, measures 37,789,676 bytes, and has SHA-256 `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`. Its raw source SHA is `51e8977b11e3c9353062216a7de6b4ebc54abd823647ac04c0dfadd48eb9e203`. CPU logits were bit-for-bit equal for fixed synthetic token-ID inputs at lengths 8, 32, and 128. The bundled manifest records `sanitization`, source hash, and an inventory of actual distributed bytes. Package verification rejects recognizable private filesystem paths even when inventory hashes match. These checks cover the documented path patterns, not every possible form of personal data.

INT8 uses ONNX Runtime dynamic quantization with `QUInt8`, per-channel weights, `op_types_to_quantize=["Gather", "MatMul"]`, and `MatMulConstBOnly`. An initial QInt8 trial was rejected after observed logit/span drift. No durable comparison report for that trial is retained, so it is not part of the published numerical evidence; the shipped candidate uses QUInt8. Quantization remains an accuracy gate and is not advertised as equivalent to the reference model until a larger licensed evaluation set passes.

## Experimental weight-only QDQ conversion

The repository also contains an isolated experimental converter in
`scripts/quantize.py`. It starts from the FP32 graph, derives the one-to-one
mapping between the quantized graph's 43 UINT8 weight tensors and the FP32
initializers, and inserts `DequantizeLinear` nodes before the float `Gather`
and `MatMul` operations. Activations remain float, so the output graph has no
`DynamicQuantizeLinear` or `MatMulInteger` nodes. The 42 linear mappings use
per-output-channel metadata on axis 1; the embedding uses its scalar metadata
before `Gather`.

The additional opt-in `--embedding-after-gather` flag moves only the scalar
embedding dequantization after Gather. It requires `--weight-only`, preserves
the float output names and linear QDQ mapping, and avoids expanding the full
102,400-row embedding for each inference. Batch, repeated and negative index
toy tests compare it with the original ordering. The real isolated conversion
at `bdd81fe` produced 37,825,039 bytes, SHA-256
`4cd8f3a048ec403c1aa521da1e00e38c5b24414ffa97a6ffb325de15b68d9ee7`.
Its fixed 64-row CPU/WASM gate passed, but one-thread 128-token p50 was 187ms
and remains above the 100ms target. See [benchmarks](benchmarks.md). It is not
the currently distributed model.

This mode is opt-in and refuses existing files, input paths, and canonical
model directories. It writes a self-contained ONNX file and adjacent manifest
with source hashes, mapping metadata, sanitizer counts, and an empty
performance-claims list. It does not modify the shipped QUInt8 artifact:

```powershell
uv run --locked python scripts/quantize.py `
  --weight-only `
  --fp32 models/converted/<revision>/onnx/model.onnx `
  --quantized dist/extension/models/onnx/model_quantized.onnx `
  --output .cache/weight-only/model_weight_only.onnx
```

Small synthetic graphs and NumPy tensor checks cover converter invariants.
The separate real conversion at `215a37e` produced 37,825,117 bytes, SHA-256
`693fbd3f1fecd8a421f2ff6c7cb60ff1cb3a333361a0fc74425bd8c5e1a42aff`.
The loader rejected the canonical FP32 external weights because a validation
worktree had hard-linked them. Ordinary isolated graph/data copies with equal
SHA-256 values allowed conversion without disabling the loader's safety guard.
Replaced FP32 initializers are removed; the model is self-contained.

The fixed 64-row numerical test at `d1380d0` passed with native CPU
`ORT_DISABLE_ALL` and unchanged default browser WASM optimization, with maximum
logit delta 0.0000257492 and no argmax/span mismatches. Native `ORT_ENABLE_ALL`
failed in a separate preserved run. This identifies sensitivity to the native
optimization path without identifying a particular kernel. See
[the diagnostic reports](research/onnx-wasm-parity.md). General accuracy,
WASM latency, cold initialization, and process memory remain adoption gates;
the distributed QUInt8 model is unchanged.

The candidate development evaluation at `b63801b` completed 2,000 fresh CPU
inferences: F1 0.715957 versus the frozen PyTorch baseline 0.716195, a drop of
0.0002371 within the 0.01 conversion gate. Product acceptance remains failed:
precision 78.90%, recall 65.53%, and 56/1,000 clean examples flagged (5.6%).
See [benchmark scope and evidence](benchmarks.md). This is training-exposed
development data, not an independent general-accuracy result.

The exported embedding is a `102,400 x 256` FP32 `Gather` initializer (104,857,600 bytes). The raw embedding-inclusive candidate stores that block as 26,214,400 bytes of uint8 weights plus quantization metadata and is 38,356,996 bytes total before distribution sanitization. For comparison, the same pipeline restricted to `MatMul` only produced a separate ignored artifact of 116,999,844 bytes; this confirms that embedding quantization is the dominant size reduction. The comparison artifact is not distributed and the browser runtime must validate the shipped graph independently. These values are recorded in the generated `manifest.json`.

The FP16 conversion uses `onnxconverter-common`. The exported ModernBERT graph contains a rotary-position Cast whose intermediate value type is converted to float16. The converter leaves its `to=float` attribute unchanged, which ONNX Runtime rejects. The pipeline repairs that specific Cast to float16 and preserves the final logits Cast to float32; ORT CPU loading and inference were then successful. An isolated FP16 probe subsequently ran on NVIDIA Lovelace / Chromium159 without WASM fallback; see [benchmarks](benchmarks.md). This is separate from CPU parity, and FP16/WebGPU is not included in the normal extension.

For a fresh checkout, follow the complete PowerShell sequence in [README](../README.md#ローカルで-unpacked-拡張機能を作る): download → reference → export → convert → manifest → build. The manifest command copies upstream config, tokenizer, LICENSE and README assets automatically; no separate manual copy is required. The lower-level commands below assume the upstream snapshot and FP32 export already exist; they overwrite the canonical converted variants. Do not rerun them on frozen measured artifacts:

```powershell
uv run --locked python scripts/model_pipeline.py convert
uv run --locked python scripts/model_pipeline.py manifest
```

`manifest.json` records the source revision, tool versions, platform, file sizes, and SHA-256 values. Converted model binaries and generated manifests are ignored by Git. `models/manifest.json` is only the tracked upstream pin, with an empty `artifacts` map. The raw conversion manifest describes Python CPU validation, so its browser `pending` fields are not a live browser test registry. The generated `dist/extension/models/manifest.json` records the sanitized distribution inventory; browser evidence is recorded separately. Local JSON reports are not available in a fresh checkout and must be reproduced or explicitly attached to a reviewed release. The frozen raw/distribution hashes above identify this Windows snapshot; another export need not produce byte-identical ONNX metadata.
