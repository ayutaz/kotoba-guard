# Browser corpus parity fixture

Documentation follow-up: 2026-11-28. The fixed64 inputs also support the distinct
FP16-storage candidate's native-all/WASM-all numerical result at source2914a68.
Its same model SHA is now in the aea6caf preview. These remain numerical controls,
not accuracy estimates. [Current results and pause](preview-validation.md).

`jwtd-browser-v1` is a frozen, model-result-blind parity check. It is separate
from the frozen `jwtd-v1` accuracy protocol and must not be used to estimate
precision, recall, or product quality.

The preparer selects four typo-side records for every non-`OK` label in the
pinned model `config.json`. Candidates are ordered by SHA-256 of their source
item ID and deduplicated by `pair_id`. The corrected `:post` item for every
selected pair is included as a clean control. With the current nine-label
configuration this produces 32 typo and 32 corrected examples. Selection is
made from gold annotations before reading cache logits, so model results do
not influence membership.

The fixture is ignored because it contains source text and expected logits:

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
uv run --locked python scripts/prepare_browser_corpus.py `
  --dataset artifacts/corpus/jwtd-v1/held-out.json `
  --cache artifacts/corpus-evaluation/held-out-v1/onnx_quint8-logits.npz `
  --cache-meta artifacts/corpus-evaluation/held-out-v1/onnx_quint8-cache.json `
  --config models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/config.json `
  --protocol benchmarks/protocols/jwtd-browser-v1.json `
  --distribution-manifest dist/extension/models/manifest.json `
  --output artifacts/corpus-browser/jwtd-browser-v1.json
```

The cache sidecar must bind the exact held-out dataset hash, raw QUInt8 model
hash, revision, and all three local text inputs: `tokenizer_sha256`,
`tokenizer_config_sha256`, and `model_config_sha256`. Missing or non-64-character
hashes fail closed. Cache logits must have the configured class count, integer
`bounds` and `offsets`, finite values, and codepoint offsets inside their source
text. This prevents silently comparing a cache from one model or tokenizer with
another distributed model.

The distribution manifest is checked separately: the extension model is the
sanitized artifact, whose SHA-256 is expected to differ from the raw cache model
SHA-256. Its `sanitization.sourceSha256` must equal the raw hash, and its
declared file hash must equal the actual file. The browser runner also verifies
the distributed `config.json`, `tokenizer.json`, and `tokenizer_config.json`
against the fixture before starting Chromium.

`browser_corpus_parity.mjs` loads the actual `dist/extension` in Chromium,
enables offline mode before opening the extension page, imports the bundled
core SDK, tokenizes each fixture item, executes the bundled ONNX Runtime Web
WASM session, and calls `LocalTypoDetector`. The fixture carries the pinned
Python tokenizer's input IDs and attention mask; both arrays are compared
exactly with the browser tokenizer and any mismatch fails the gate. Reports
contain only match booleans, mismatch counts, and mismatch indexes for these
arrays, never token values. Cached logits are converted into
expected token-level argmax spans at threshold 0.5; the SDK spans are compared
with those cached-model spans. Gold error spans are retained as a diagnostic
only and are not used as the parity gate. The gate fails on tensor shape or
finite-value violations, offset mismatch, ordinary-token argmax disagreement,
ordinary-token maximum logit delta above `0.001`, SDK span mismatch, or any
external request. It records every token's expected/actual argmax and delta.
The report contains only item IDs, numeric summaries, and span coordinates; it
does not write source text. Any HTTP, HTTPS, WebSocket, or secure WebSocket
request is recorded by protocol and host only and fails the run.

```powershell
npm run build
node scripts/browser_corpus_parity.mjs `
  --fixture artifacts/corpus-browser/jwtd-browser-v1.json `
  --extension dist/extension `
  --output artifacts/browser-corpus-parity.json
```

The report is persisted with `status: failed` when startup, loading, inference,
fixture validation, page errors, or external requests fail, and the command
exits nonzero. Empty or incomplete fixture rows are rejected before Chromium
starts. Successful reports include SHA-256 values for the fixture and frozen
browser protocol, the source commit identity, and the Node/Chromium/platform
environment. This prevents a missing model, wrong sanitized hash, or malformed
cache from being mistaken for an empty successful parity result.

Python reference offsets are Unicode codepoint ranges. Browser tokenizer and
SDK offsets are UTF-16 code-unit ranges suitable for JavaScript strings and DOM
APIs. The parity runner converts Python boundaries explicitly before comparing
offsets. Special zero-width tokens are excluded from ordinary-token numerical
agreement. WebGPU is outside this parity protocol.

The initial 64-row browser run is recorded in
`artifacts/browser-corpus-parity-initial.json` and failed the numerical gate:
offsets matched for all rows, with zero external requests and page errors, but
40 rows exceeded the `0.001` ordinary-token maximum delta, one row had an
argmax mismatch, and three rows had SDK span mismatches. The largest ordinary
maximum delta was `2.606649398803711`. This is a failed parity result, not a
successful browser inference claim. The native CPU diagnostics below isolate
the tested model and runtime conditions before browser-runtime interpretation.

## Native CPU diagnostic

After fixture preparation, the separate native diagnostic runs the sanitized
QUInt8 artifact once through ONNX Runtime's `CPUExecutionProvider` with one
intra-op and one inter-op thread. It compares the result with the cached
fixture logits without changing the fixture, cache, quantization, or browser
protocol:

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
uv run --locked python scripts/prepare_browser_corpus.py `
  --native-diagnostic `
  --fixture artifacts/corpus-browser/jwtd-browser-v1.json `
  --model dist/extension/models/onnx/model_quantized.onnx `
  --model-manifest dist/extension/models/manifest.json `
  --native-graph-optimization all `
  --native-output artifacts/browser-corpus-native-diagnostic.json
```

The `--native-graph-optimization` option accepts `all` (the default) or
`disabled`; the report records the actual ORT enum and numeric level. This
allows a controlled CPU fusion comparison without changing the canonical
model or browser protocol. The report records runtime/version, thread and optimization settings, model
and fixture hashes, and per-item numeric summaries only. It never writes text
or token IDs. This is a diagnostic comparison rather than an accuracy or
release gate; browser WASM behavior remains a separate result.

The completed native result is recorded in
`artifacts/browser-corpus-native-diagnostic.json`: all 64 rows matched the
cached logits exactly with ONNX Runtime 1.32.0 CPU, one intra-op thread, and
one inter-op thread using the sanitized model. The separate browser result in
`artifacts/browser-corpus-parity-tokenids.json` matched input IDs, attention
masks, and offsets for all 64 rows, but retained the same 40 logit-delta
failures, one argmax mismatch, and three span mismatches. This rules out the
tested tokenizer, offset, sanitization, and native thread settings as the
explanation for the observed difference; it does not establish which WASM
operator or runtime version causes it.

An isolated native run with ONNX Runtime 1.31.1 is recorded in
`artifacts/browser-corpus-native-1311.json`; all 64 rows also matched the
1.32.0 cached logits exactly. This rules out the tested native runtime version
alone. The separate graph-optimization-disabled run is recorded in
`artifacts/browser-corpus-native-noopt.json`: 32 rows exceed 0.001, maximum
delta 2.423532485961914, and two rows differ in argmax from the `all`
reference. Disabling native optimization is not established as a browser
parity fix; the `all` report and frozen cache remain unchanged.

The paired FP32 experiment completed with the same fixed input-ID fixture and
browser WASM harness. The native report is
`artifacts/browser-corpus-fp32-cpu.json`; the browser report is
`artifacts/browser-corpus-fp32-wasm.json`. All 64 rows matched offsets,
ordinary-token logits, argmax labels, and SDK spans. The maximum absolute
logit delta was `0.00004291534423828125`, with zero external requests and page
errors. This is a successful FP32 parity diagnostic, not an accuracy estimate.
The contrast with the failed QUInt8 result localizes the remaining
investigation to the quantized graph or its browser WASM kernels. The frozen
QUInt8 gate and fixture remain unchanged.

The paired experiment is executable in two explicit stages. First, generate
an ignored FP32 CPU fixture and numeric report:

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
uv run --locked python scripts/prepare_browser_corpus.py `
  --fp32-diagnostic `
  --fp32-input-fixture artifacts/corpus-browser/jwtd-browser-v1-tokenids.json `
  --fp32-model models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/onnx/model.onnx `
  --fp32-manifest models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/manifest.json `
  --fp32-fixture-output .cache/fp32-browser-fixture.json `
  --fp32-report-output .cache/fp32-cpu-report.json
```

Then place that FP32 model and its `.data` companion, when present, into an
isolated copy of the extension under `models/onnx/model.onnx`, place its
manifest at `models/fp32-manifest.json`, and run the browser stage:

```powershell
node scripts/browser_corpus_parity.mjs `
  --fp32-diagnostic `
  --fixture .cache/fp32-browser-fixture.json `
  --extension .cache/isolated-fp32-extension `
  --model-relative models/onnx/model.onnx `
  --model-manifest models/fp32-manifest.json `
  --output .cache/fp32-browser-report.json
```

The CPU stage binds the FP32 model and external-data hashes to its manifest;
the browser stage rechecks those hashes and records the local WASM sidecar
hashes. Both reports contain no source text or token IDs. This diagnostic does
not alter the distributed extension, frozen QUInt8 fixture, or QUInt8 gate.

## Experimental weight-only candidate

The isolated candidate is 37,825,117 bytes, SHA-256
`693fbd3f1fecd8a421f2ff6c7cb60ff1cb3a333361a0fc74425bd8c5e1a42aff`.
The native CPU optimization level must be recorded independently of the
browser setting. At `7e6c7c1`, native `ORT_ENABLE_ALL` versus default WASM
failed on all 64 logit-delta rows (maximum 0.3987193), with two argmax and one
span mismatch. At `d1380d0`, native `ORT_DISABLE_ALL` versus the same default
WASM settings passed all 64 rows (maximum 0.0000257492), with matching
IDs/masks/offsets and no argmax/span mismatches. Both runs observed zero
external requests and page errors. The reports are respectively
`artifacts/browser-corpus-weight-only-wasm-v1.json` and
`artifacts/browser-corpus-weight-only-native-noopt-wasm-v1.json`.

This is a fixed-input numerical diagnostic. It does not establish general
accuracy, speed, memory suitability, or successful inference by a changed
production extension. The candidate remains isolated and the canonical model
is unchanged. The next measurements are fresh development-set inference and
WASM performance/resource checks before an adoption decision.
