# JWTD v2 preparation

Kotoba Guard uses the [Japanese Wikipedia Typo Dataset v2 (JWTD v2)](https://nlp.ist.i.kyoto-u.ac.jp/?%E6%97%A5%E6%9C%AC%E8%AA%9EWikipedia%E5%85%A5%E5%8A%9B%E8%AA%A4%E3%82%8A%E3%83%87%E3%83%BC%E3%82%BF%E3%82%BB%E3%83%83%E3%83%88) only as a local evaluation input. The dataset was built from Japanese Wikipedia revision pairs and is licensed CC BY-SA 3.0. The upstream [SB Intuitions model report](https://www.sbintuitions.co.jp/blog/entry/2026/11/25/170000) describes the same `train`, `test`, and `gold` JSONL splits and the character-range to token-label projection used for training.

The source archive is:

```text
URL: https://nlp.ist.i.kyoto-u.ac.jp/nl-resource/JWTD/jwtd_v2.0.tar.gz
HTTP Content-Encoding: gzip
HTTP Content-Length: 98,567,960 bytes
HTTP ETag: "5e00718-5bda469ceccc0"
Decoded tar bytes: 478,873,600
Decoded tar SHA-256: 57e1d06046f83324db8d8a9e9601957f5ff17c3f1409425c5da3c0167aa871a6
Compressed-body SHA-256: 2c6d864905adbac75a2c0181aa8796c81d3f86df41aa8bf79b37d47ee8ec5025
```

Both hashes are recorded because the server response uses `Content-Encoding:
gzip`: the compressed-body hash is from the original 98,567,960-byte response,
while the decoded-tar hash is from the 478,873,600-byte extracted stream. A
transparent HTTP client can save decoded bytes under a `.tar.gz` name, so the
manifest records the encoding, byte counts, ETag, and hash type separately.

The checked-out raw files are expected at `.cache/research-dataset/jwtd_v2.0/` and are ignored by Git. The raw archive and its extracted JSONL files must not be committed, included in an extension package, or printed to logs. The preparation manifest records the decoded-tar provenance, source-file hashes, record counts, output hashes, and license provenance without storing corpus text in metadata or quarantine records.

## Preparation command

The preparation script reads the local files, reconstructs each typo span from the complete `pre_text`/`post_text` pair, and writes ignored derived fixtures:

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
uv run --locked python scripts/prepare_corpus.py `
  --source .cache/research-dataset/jwtd_v2.0 `
  --output artifacts/corpus/jwtd-v1
```

The script loads labels from the pinned model `config.json` by default. Use `--config` only when validating an equivalent pinned checkout. It does not load or execute a model. The command prints counts and hashes only.

For the captured raw files, the run had 696,193 physical train records
(696,187 valid JSON records), 5,440 test records, and 1,127 gold records. The
fixed held-out output has 5,436 eligible pairs (10,872 examples); four test
records were quarantined. The train development output has 1,000 selected
pairs (2,000 examples), and the gold-clean output has 1,127 examples. These
are local source counts, not the upstream paper's headline counts.

## Output contract

`artifacts/corpus/jwtd-v1/` contains:

| File               | Role                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held-out.json`    | All eligible pairs from the official `test.jsonl`; no resampling or threshold fitting. Every pair emits a typo-side `:pre` item and its corrected clean `:post` item.                                                                                                                                                             |
| `development.json` | Up to 1,000 deterministic pairs from `train.jsonl`, after excluding every `test` and `gold` page and any train record whose normalized `pre_text` or `post_text` occurs in either protected split. Every selected pair emits `:pre` and `:post` items. This is training-exposed calibration data and is not independent evidence. |
| `gold-clean.json`  | Corrected `post_text` records from `gold.jsonl`, used as an auxiliary clean-text false-positive set.                                                                                                                                                                                                                              |
| `quarantine.json`  | IDs, source split, line numbers, and bounded reasons for malformed, ambiguous, unknown-label, or otherwise unusable records. It contains no source text.                                                                                                                                                                          |
| `manifest.json`    | Dataset, license, revision, archive/file/output hashes, split policy, counts, label counts, and quarantine count.                                                                                                                                                                                                                 |

Each fixture has `schema_version`, metadata, and `items`. Development and
held-out metadata distinguish `eligible_pairs` from `output_examples` (two
examples per eligible typo pair). A `:pre` item has the typo-side `text`,
`errors` with Python Unicode codepoint offsets and labels, and
`corrected_text`; its paired `:post` item has the corrected text and an empty
error list. `gold-clean.json` uses corrected text and empty error lists.

The item ID preserves the source split, page, revision pair, and JSONL line number. Page sets and normalized `pre_text`/`post_text` values from all valid `test` and `gold` source records are used for leakage exclusion before development selection. Development selection is stable across runs: candidates are ordered by the SHA-256 of their source ID and the requested prefix is selected. Normalization for duplicate detection and protected-text matching is NFC followed by whitespace collapsing. The manifest records official split identity, calibration disjointness, and unknown possible overlap with the model's pretraining data; it does not claim that `test` or `gold` is independent of pretraining.

## Evaluation boundaries

The official test fixture remains fixed and must be reported separately from development calibration. The preparation script quarantines records when `parse_pair` cannot reconstruct the corrected sentence, when a diff label is unknown or `OK`, or when the source schema is invalid. For records with multiple valid full-text alignments, it retains the first deterministic alignment as `errors` and stores every joint alignment in `error_alternatives`; scoring code must evaluate alternatives as whole scenarios and must not mix spans across scenarios. The current raw run has 539 ambiguous eligible test pairs (maximum four alternatives), 75 ambiguous selected development pairs (maximum two), and four test quarantines. It never resolves ambiguity by occurrence order alone.

The model's upstream projection labels every token whose offset range overlaps a character error range. Product-side zero-width deletion handling is documented separately in the corpus evaluator; the prepared JSON preserves the original zero-width character span. The derived fixtures are evaluation inputs, not claims of general Japanese accuracy, and the CC BY-SA 3.0 attribution and ShareAlike obligations apply to any later redistribution of corpus-derived material.
