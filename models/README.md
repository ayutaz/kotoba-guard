# Model artifacts

## Current preview assets (documentation checked 2026-11-28)

Development is paused. The saved current model bundle is under
`artifacts/preview/aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17/bundle/`, with
its unpacked build in the adjacent `extension/`. Both are ignored local assets.
The model is UINT8 embedding / MatMul FLOAT16 storage with FLOAT computation,
48,188,514 bytes, SHA-256 `4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7`.
The legacy filename `onnx/model_quantized.onnx` does not describe its full format;
read the generated model_kind and provenance. No new preview ZIP/SBOM was produced.
See [preview validation](../docs/preview-validation.md) and [isolated staging/build](../docs/release.md#ローカルpreviewの作成).

## Default conversion layout

The following default pipeline regenerates the older dynamic-QUInt8 path.
It is distinct from staging the existing preview candidate.

The upstream model and converted ONNX artifacts are intentionally not committed
to the source repository. Download and build them with the scripts in
`scripts/model_pipeline.py` using the pinned revision in `models/manifest.json`.

The expected local layout is:

```text
models/
├── upstream/<revision>/        # Hugging Face files, ignored by Git
└── converted/<revision>/       # ONNX files and manifest, ignored by Git
```

The tracked `models/manifest.json` records the upstream pin and label authority; its `artifacts` map is intentionally empty. Generated raw manifests, binaries, checksums and local test reports are ignored, not committed by default. See the complete [PowerShell build sequence](../README.md#ローカルで-unpacked-拡張機能を作る). The manifest command performs tokenizer/config/LICENSE/README copying automatically. A fresh checkout has no measured model assets or generated reports.

Raw ONNX files can contain local debug stacktraces. `npm run build` verifies the
converted source hash and creates a separate sanitized QUInt8 distribution copy,
with exact CPU output checks. Do not publish raw conversion files; see
[model conversion](../docs/model-conversion.md) for provenance and sanitization details.
