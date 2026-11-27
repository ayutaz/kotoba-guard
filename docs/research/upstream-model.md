# Upstream model investigation

Investigation date: 2026-11-25/26 (JST).

The selected upstream is [sbintuitions/ja-typo-detector-modernbert-ja-base-30m](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m), pinned to revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8` (the API-reported 40-character commit). The Hugging Face API identifies it as a public MIT-licensed Transformers token-classification model with `ModernBertForTokenClassification` architecture and 36,773,641 FP32 parameters. The source files used locally are `config.json`, `tokenizer.json`, `tokenizer_config.json`, `model.safetensors`, `LICENSE`, and `README.md`.

The release context is the [SB Intuitions technical blog entry](https://www.sbintuitions.co.jp/blog/entry/2026/11/25/170000). The repository treats the model card and pinned files as the machine-readable authority for implementation details and treats the blog as the upstream explanatory reference.

`config.json` is the authority for labels and settings. It defines nine labels in this order: `OK`, `deletion`, `insertion_a`, `insertion_b`, `kanji-conversion_a`, `kanji-conversion_b`, `substitution`, `transposition`, and `others`. The model has hidden size 256, 10 layers, 4 attention heads, vocabulary size 102,400, max position embeddings 8,192, local attention 128, and RoPE parameters for both full and sliding attention. The implementation loads `id2label` and `label2id` at runtime and fails closed when they disagree.

The model detects token-level error categories. It does not generate a corrected sentence. Kotoba Guard therefore exposes spans and confidence only; candidate generation is a separate future feature.

## Reproduction

Use Python 3.12 and the locked environment:

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
uv sync --locked
uv run --locked python scripts/model_pipeline.py download
uv run --locked python scripts/model_pipeline.py reference --text "明日の予定については、来週移行にご連絡します。"
```

The download command uses `snapshot_download` with the revision above and never resolves the moving `main` branch. Downloaded files are ignored by Git under `models/upstream/<revision>`.

## Official training data and evaluation notes

The official [SB Intuitions technical blog](https://www.sbintuitions.co.jp/blog/entry/2026/11/25/170000) and the [pinned model card](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m/tree/8d640720bddeb64c89dc1fa7780c3ea29fa523e8) identify the training source as Kyoto University's [Japanese Wikipedia Input Error Dataset (v2)](https://nlp.ist.i.kyoto-u.ac.jp/?%E6%97%A5%E6%9C%AC%E8%AA%9EWikipedia%E5%85%A5%E5%8A%9B%E8%AA%A4%E3%82%8A%E3%83%87%E3%83%BC%E3%82%BF%E3%82%BB%E3%83%83%E3%83%88). The source is mined from before/after Japanese Wikipedia revision pairs. The published split names are `train`, `test`, and `gold`; the blog describes `train` as approximately 700,000 JSONL sentence pairs. Public dataset notices identify the dataset license as CC BY-SA 3.0. Kotoba Guard does not include that dataset in the repository or download it as part of the extension build; any future benchmark fixture must retain attribution and ShareAlike obligations.

For the typo detector, SB Intuitions converted character error ranges to token labels using `offset_mapping`. A token receives an error label when its range overlaps an error range. The published training procedure assigns 99% of records to training and 1% to validation, uses cross-entropy loss, and trains for two epochs. The original and corrected sentence pairs are both included, so the blog reports an approximately even mixture of erroneous and clean sentences. These details describe the upstream training procedure; they are not a claim that Kotoba Guard retrains the model.

The upstream evaluation uses roughly 5,400 records from `test` and reports (1) whether the error location was detected, (2) whether both location and error type were correct, (3) the rate at which a clean test sentence receives at least one false detection, and (4) per-type location-and-label results. The blog reports that the 70M, 130M, and 310M variants scored better than the compared Recruit model on its location and location-plus-label measures and had lower false-positive rates in that setup, while `transposition` was weaker across the variants. The comparison is only indicative: Recruit uses character tokens, while this model uses SentencePiece subwords, whose spans can be wider than the character error. The published table is an upstream result, not a Kotoba Guard measurement. It remains a historical author-reported result and is not claimed as a reproduction. Kotoba Guard's local evaluation uses a separately frozen pair/span protocol; see [benchmarks](../benchmarks.md) and the local status below.

The same blog also describes an optional multi-error training variant. It combines two error-containing sentences with 50% probability, reducing the training set from 696,189 to 470,006 records and increasing records with multiple errors from 2.42% to 51.68%. Its reported 310M evaluation still found missed or partially detected multi-error examples and identifies class imbalance as an open issue. We therefore treat multiple detections, span grouping, and confidence filtering as behavior requiring regression tests rather than assuming that every error in an input will be found.

## Tokenizer facts that affect browser offsets

The pinned repository contains a [6.72 MB `tokenizer.json`](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m/blob/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/tokenizer.json) and a [667-byte `tokenizer_config.json`](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m/blob/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/tokenizer_config.json). The tokenizer is a SentencePiece-style Unigram tokenizer with byte fallback. Its JSON tokenizer pipeline has a null normalizer and a `Metaspace` pre-tokenizer with `split: false`, followed by `ByteFallback`; the tokenizer does not use a Japanese morphological pre-tokenizer. Raw Japanese text is therefore passed directly to the tokenizer.

There are two different length values that must not be conflated:

- `config.json` sets `max_position_embeddings` to **8192**. This is the model's usable sequence limit and the value the implementation must enforce.
- `tokenizer_config.json` sets `model_max_length` to the Transformers “very large integer” sentinel (`1000000000000000019884624838656`), which means it is not an operational limit.

The official inference example uses `return_offsets_mapping=True`, removes special-token offsets where `start == end`, selects `argmax` labels, and skips label ID 0 (`OK`). It does not define a confidence threshold. Kotoba Guard may expose a user-facing confidence filter, but that is a product policy layered on the logits and must not be described as an upstream calibrated probability. The implementation must preserve UTF-16 browser offsets and test normalization, byte fallback, emoji, combining characters, and subword spans against the pinned tokenizer.

The upstream model card and the blog use the same nine label IDs recorded in `config.json`; no label names or IDs are inferred from examples. See the [model card's label table and reference code](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m/blob/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/README.md) and the [pinned configuration](https://huggingface.co/sbintuitions/ja-typo-detector-modernbert-ja-base-30m/blob/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/config.json).

Local follow-up on 2026-11-27: evaluation of the official `test` split completed under the project's frozen scoring protocol. The fixed held-out fixture contains 5,436 eligible pairs and 10,872 examples (four of the 5,440 source records were quarantined); no held-out threshold fitting was performed. The separate development fixture contains 1,000 deterministically selected `train` pairs and 2,000 examples, after page/text overlap exclusions. It is training-exposed calibration data and is not independent accuracy evidence. The reference and QUInt8 candidate missed the product precision, recall, and clean-record false-positive targets on the held-out protocol. These are local measurements, not a reproduction of the upstream table. See [benchmarks](../benchmarks.md) and [JWTD provenance](jwtd-dataset.md) for the adopted counts, exclusions, metrics, and evidence scope.

### Evidence boundary

The model card, config, tokenizer metadata, and blog are upstream evidence. The dataset license is recorded from the public dataset notice and must be rechecked against the Kyoto source before redistributing any data. The pinned model has now been downloaded, converted, and executed locally; current hashes, bounded parity, local held-out/development evaluation, WASM timings, and an isolated WebGPU probe are recorded in [benchmarks](../benchmarks.md) and the generated manifests. The local held-out evaluation is complete under the frozen project protocol, while the upstream table remains an author-reported historical result rather than a reproduced score. The upstream examples alone do not establish browser or quantized-model behavior.
