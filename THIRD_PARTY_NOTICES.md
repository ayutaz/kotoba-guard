# Third-party notices

Kotoba Guard source is MIT. Upstream model development belongs to **SB Intuitions**, not Kotoba Guard. The pinned `sbintuitions/ja-typo-detector-modernbert-ja-base-30m` model and tokenizer are MIT, Copyright (c) 2026 SB Intuitions. Distribution must contain the complete upstream `LICENSE` in `models/LICENSE`.

ONNX Runtime Web is MIT (Microsoft); Transformers.js is Apache-2.0 (Hugging Face). Their dependency licenses are separate from the model license. Build/distribution tooling must preserve the corresponding license texts and produce an npm SBOM and dependency license inventory. A successful unit test does not complete the distribution license review.

The distributed browser runtime is ONNX Runtime Web 1.31.1. Complete upstream LICENSE and ThirdPartyNotices are retained with pinned source metadata in `third_party/onnxruntime` and copied into the ZIP. The npm dependency inventory includes development-time Node and nested ORT packages; those packages are marked as not bundled because the build externalizes all ORT imports to the root browser runtime. A notice inventory is broader than the executable code included in the extension.

Sharp and its platform-specific libvips packages are Node image-processing dependencies, excluded from the browser core. The build checks the actual Vite core source map before recording this exclusion and fails if Sharp code is present or evidence is missing. The audit retains source-map hashes and source counts; raw source maps and native image-processing binaries are not distributed. License text remains mandatory for bundled code.

No competing extension source code is incorporated. Research references and their licenses are documented in docs/research/competitors.md. Python conversion dependencies are development tools and not bundled in the extension. Exact resolved dependencies are recorded in uv.lock and package-lock.json.
