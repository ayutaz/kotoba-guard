"""Prepare an auditable, text-bearing JWTD evaluation fixture.

The downloaded JWTD archive is never copied into the repository.  This command
only writes the small derived fixtures under ``artifacts/corpus`` (which are
ignored) and a manifest containing hashes and counts, never corpus text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.corpus_evaluation import DatasetError, parse_pair

MODEL_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
DATASET_NAME = "Japanese Wikipedia Typo Dataset (v2)"
DATASET_VERSION = "jwtd-v1"
ARCHIVE_URL = "https://nlp.ist.i.kyoto-u.ac.jp/nl-resource/JWTD/jwtd_v2.0.tar.gz"
DECODED_TAR_SHA256 = "57e1d06046f83324db8d8a9e9601957f5ff17c3f1409425c5da3c0167aa871a6"
DECODED_TAR_BYTES = 478_873_600
COMPRESSED_BYTES = 98_567_960
COMPRESSED_SHA256: str | None = "2c6d864905adbac75a2c0181aa8796c81d3f86df41aa8bf79b37d47ee8ec5025"
SOURCE_ETAG = '"5e00718-5bda469ceccc0"'
CONTENT_ENCODING = "gzip"
SOURCE_URL = (
    "https://nlp.ist.i.kyoto-u.ac.jp/?"
    "%E6%97%A5%E6%9C%AC%E8%AA%9EWikipedia%E5%85%A5%E5%8A%9B%E8%AA%A4%E3%82%8A%E3%83%87%E3%83%BC%E3%82%BF%E3%82%BB%E3%83%83%E3%83%88"
)
LICENSE = "CC-BY-SA-3.0"
DEFAULT_SOURCE = Path(".cache/research-dataset/jwtd_v2.0")
DEFAULT_OUTPUT = Path("artifacts/corpus/jwtd-v1")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _stable_id(split: str, line_number: int, record: dict[str, Any]) -> str:
    page = str(record.get("page", "unknown"))
    pre_rev = str(record.get("pre_rev", "unknown"))
    post_rev = str(record.get("post_rev", "unknown"))
    return f"jwtd-v2:{split}:{page}:{pre_rev}:{post_rev}:line-{line_number}"


def _safe_reason(error: Exception) -> str:
    """Return a reason that cannot accidentally contain corpus text."""

    reason = str(error)
    reason = re.sub(r"[\r\n\t]+", " ", reason)
    return reason[:240] or error.__class__.__name__


def _read_jsonl(
    path: Path, split: str
) -> tuple[list[tuple[int, dict[str, Any]]], list[dict[str, Any]]]:
    records: list[tuple[int, dict[str, Any]]] = []
    quarantine: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            quarantine.append(
                {
                    "id": f"jwtd-v2:{split}:line-{line_number}",
                    "split": split,
                    "line": line_number,
                    "reason": "empty line",
                }
            )
            continue
        identity = f"jwtd-v2:{split}:line-{line_number}"
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise DatasetError("record is not an object")
            identity = _stable_id(split, line_number, value)
            records.append((line_number, value))
        except (json.JSONDecodeError, DatasetError, TypeError, ValueError) as error:
            quarantine.append(
                {"id": identity, "split": split, "line": line_number, "reason": _safe_reason(error)}
            )
    return records, quarantine


def _labels_from_config(config_path: Path) -> tuple[str, ...]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    id2label = config.get("id2label")
    if not isinstance(id2label, dict):
        raise ValueError("config.json has no id2label map")
    try:
        labels = tuple(str(id2label[str(index)]) for index in range(len(id2label)))
    except (KeyError, TypeError) as error:
        raise ValueError("config.json id2label keys are not contiguous") from error
    label2id = config.get("label2id")
    if isinstance(label2id, dict):
        for index, label in enumerate(labels):
            if str(label2id.get(label)) != str(index):
                raise ValueError("config.json id2label and label2id maps disagree")
    if "OK" not in labels or len(set(labels)) != len(labels):
        raise ValueError("config.json labels are missing OK or contain duplicates")
    return labels


def _normal_key(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


def _item(
    parsed: dict[str, Any], split: str, line_number: int, record: dict[str, Any]
) -> dict[str, Any]:
    item = {
        "id": f"{parsed['id']}:pre",
        "pair_id": parsed["id"],
        "text": parsed["text"],
        "errors": parsed["errors"],
        "corrected_text": parsed["corrected_text"],
        "page": parsed["page"],
        "pre_rev": str(record.get("pre_rev", "")),
        "post_rev": str(record.get("post_rev", "")),
        "source_split": split,
        "source_line": line_number,
        "source_role": "typo_pre",
    }
    if "error_alternatives" in parsed:
        item["error_alternatives"] = parsed["error_alternatives"]
    return item


def _post_item(item: dict[str, Any]) -> dict[str, Any]:
    """Create the paired corrected clean example used for false-positive checks."""

    post = {
        **item,
        "id": f"{item['pair_id']}:post",
        "text": item["corrected_text"],
        "errors": [],
        "source_role": "corrected_clean",
    }
    post.pop("error_alternatives", None)
    return post


def _paired_examples(pairs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []
    for item in pairs:
        examples.extend((item, _post_item(item)))
    return examples


def _counts(
    pairs: list[dict[str, Any]], output_items: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    labels: Counter[str] = Counter()
    for item in pairs:
        labels.update(error["label"] for error in item["errors"])
    outputs = pairs if output_items is None else output_items
    alternative_counts = [len(item.get("error_alternatives", [item["errors"]])) for item in pairs]
    return {
        "eligible": len(pairs),
        "eligible_pairs": len(pairs),
        "output_examples": len(outputs),
        "clean": sum(not item["errors"] for item in outputs),
        "typo": sum(bool(item["errors"]) for item in outputs),
        "label_counts": dict(sorted(labels.items())),
        "ambiguous_pairs": sum(count > 1 for count in alternative_counts),
        "max_alternatives": max(alternative_counts, default=0),
    }


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prepare_corpus(
    source_root: Path = DEFAULT_SOURCE,
    output_root: Path = DEFAULT_OUTPUT,
    *,
    labels: tuple[str, ...] | None = None,
    config_path: Path | None = None,
    development_size: int = 1000,
    decoded_tar_sha256: str = DECODED_TAR_SHA256,
) -> dict[str, Any]:
    """Build fixed held-out, exposed development and corrected-clean fixtures."""

    if development_size < 0:
        raise ValueError("development_size must be non-negative")
    if labels is None:
        config = config_path or Path("models/upstream") / MODEL_REVISION / "config.json"
        labels = _labels_from_config(config)
    if not labels or "OK" not in labels:
        raise ValueError("labels must contain the model's OK label")

    output_root.mkdir(parents=True, exist_ok=True)
    source_records: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    quarantine: list[dict[str, Any]] = []
    file_metadata: dict[str, dict[str, Any]] = {}
    for split in ("train", "test", "gold"):
        path = source_root / f"{split}.jsonl"
        if not path.is_file():
            raise FileNotFoundError(path)
        rows, invalid = _read_jsonl(path, split)
        source_records[split] = rows
        quarantine.extend(invalid)
        file_metadata[f"{split}.jsonl"] = {
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
            "records": len(rows) + len(invalid),
        }

    page_sets = {
        split: {str(record.get("page")) for _, record in rows if record.get("page") is not None}
        for split, rows in source_records.items()
    }
    protected_texts = {
        _normal_key(text)
        for split in ("test", "gold")
        for _, record in source_records[split]
        for text in (record.get("pre_text"), record.get("post_text"))
        if isinstance(text, str)
    }

    parsed: dict[str, list[dict[str, Any]]] = {"train": [], "test": [], "gold": []}
    raw_counts: dict[str, dict[str, Any]] = {}
    for split, rows in source_records.items():
        for line_number, record in rows:
            identity = _stable_id(split, line_number, record)
            try:
                if split == "gold":
                    pre = record.get("pre_text")
                    post = record.get("post_text")
                    if not isinstance(pre, str) or not isinstance(post, str):
                        raise DatasetError("invalid pair schema")
                    if record.get("diffs") not in (None, []):
                        raise DatasetError("gold record unexpectedly has diffs")
                    item = {
                        "id": identity,
                        "text": post,
                        "errors": [],
                        "corrected_text": post,
                        "page": str(record.get("page", identity)),
                        "pre_rev": str(record.get("pre_rev", "")),
                        "post_rev": str(record.get("post_rev", "")),
                        "source_split": split,
                        "source_line": line_number,
                        "source_role": "corrected_clean",
                    }
                else:
                    item = _item(
                        parse_pair(record, labels, identity, allow_ambiguous=True),
                        split,
                        line_number,
                        record,
                    )
                parsed[split].append(item)
            except (DatasetError, TypeError, ValueError) as error:
                quarantine.append(
                    {
                        "id": identity,
                        "split": split,
                        "line": line_number,
                        "reason": _safe_reason(error),
                    }
                )
        raw_counts[split] = {
            "records": len(source_records[split]),
            "quarantined": sum(entry["split"] == split for entry in quarantine),
        }

    page_filtered = [
        item
        for item in parsed["train"]
        if item["page"] not in page_sets["test"] | page_sets["gold"]
    ]
    train_candidates = [
        item
        for item in page_filtered
        if _normal_key(item["text"]) not in protected_texts
        and _normal_key(item["corrected_text"]) not in protected_texts
    ]
    excluded_pages = len(parsed["train"]) - len(page_filtered)
    excluded_texts = len(page_filtered) - len(train_candidates)
    seen_pairs: set[tuple[str, str]] = set()
    unique_candidates: list[dict[str, Any]] = []
    for item in train_candidates:
        key = (_normal_key(item["text"]), _normal_key(item["corrected_text"]))
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        unique_candidates.append(item)
    unique_candidates.sort(key=lambda item: hashlib.sha256(item["id"].encode()).hexdigest())
    development = sorted(unique_candidates[:development_size], key=lambda item: item["id"])

    held_out_pairs = sorted(parsed["test"], key=lambda item: item["id"])
    held_out = _paired_examples(held_out_pairs)
    development_examples = _paired_examples(development)
    gold_clean = sorted(parsed["gold"], key=lambda item: item["id"])
    development_payload = {
        "schema_version": DATASET_VERSION,
        "metadata": {
            "dataset": DATASET_NAME,
            "license": LICENSE,
            "source_split": "train",
            "purpose": "training-exposed calibration/development fixture; not independent",
            "official_split": "train",
            "calibration_disjoint": False,
            "pretraining_overlap": "unknown",
            "offset_unit": "python_unicode_codepoint",
            "eligible_pairs": len(development),
            "output_examples": len(development_examples),
        },
        "items": development_examples,
    }
    held_out_payload = {
        "schema_version": DATASET_VERSION,
        "metadata": {
            "dataset": DATASET_NAME,
            "license": LICENSE,
            "source_split": "official_test",
            "purpose": "fixed official held-out evaluation",
            "official_split": "test",
            "calibration_disjoint": True,
            "pretraining_overlap": "unknown",
            "offset_unit": "python_unicode_codepoint",
            "eligible_pairs": len(held_out_pairs),
            "output_examples": len(held_out),
        },
        "items": held_out,
    }
    gold_payload = {
        "schema_version": DATASET_VERSION,
        "metadata": {
            "dataset": DATASET_NAME,
            "license": LICENSE,
            "source_split": "gold",
            "purpose": "corrected-clean auxiliary false-positive evaluation",
            "official_split": "gold",
            "calibration_disjoint": None,
            "pretraining_overlap": "unknown",
            "offset_unit": "python_unicode_codepoint",
            "eligible_pairs": len(gold_clean),
            "output_examples": len(gold_clean),
        },
        "items": gold_clean,
    }
    _write_json(output_root / "development.json", development_payload)
    _write_json(output_root / "held-out.json", held_out_payload)
    _write_json(output_root / "gold-clean.json", gold_payload)
    quarantine.sort(key=lambda entry: (entry["split"], entry.get("line", 0), entry["id"]))
    _write_json(output_root / "quarantine.json", quarantine)

    counts: dict[str, Any] = {}
    for split in ("train", "test", "gold"):
        output_items = {
            "train": development_examples,
            "test": held_out,
            "gold": gold_clean,
        }[split]
        counts[split] = {
            **raw_counts[split],
            **_counts(parsed[split], output_items),
        }
    counts["train"].update(
        {
            "excluded_pages": excluded_pages,
            "excluded_texts": excluded_texts,
            "deduplicated": len(train_candidates) - len(unique_candidates),
            "eligible_after_filters": len(unique_candidates),
            "development_selected_pairs": len(development),
            "development_selected_output_examples": len(development_examples),
        }
    )

    output_metadata = {}
    for name in ("development.json", "held-out.json", "gold-clean.json", "quarantine.json"):
        path = output_root / name
        output_metadata[name] = {"bytes": path.stat().st_size, "sha256": _sha256(path)}
    manifest = {
        "schema_version": DATASET_VERSION,
        "dataset": DATASET_NAME,
        "model_revision": MODEL_REVISION,
        "labels": list(labels),
        "license": LICENSE,
        "metadata": {
            "offset_unit": "python_unicode_codepoint",
            "development": {
                "eligible_pairs": len(development),
                "output_examples": len(development_examples),
                "independent": False,
                "official_split": "train",
                "calibration_disjoint": False,
                "pretraining_overlap": "unknown",
                "calibration_exposed_to_training": True,
            },
            "held_out": {
                "eligible_pairs": len(held_out_pairs),
                "output_examples": len(held_out),
                "official_split": "test",
                "calibration_disjoint": True,
                "pretraining_overlap": "unknown",
            },
            "gold_clean": {
                "eligible_pairs": len(gold_clean),
                "output_examples": len(gold_clean),
                "official_split": "gold",
                "calibration_disjoint": None,
                "pretraining_overlap": "unknown",
            },
        },
        "source": {
            "url": SOURCE_URL,
            "archive_url": ARCHIVE_URL,
            "decoded_tar_sha256": decoded_tar_sha256,
            "decoded_tar_bytes": DECODED_TAR_BYTES,
            "compressed_sha256": COMPRESSED_SHA256,
            "compressed_bytes": COMPRESSED_BYTES,
            "content_encoding": CONTENT_ENCODING,
            "etag": SOURCE_ETAG,
            "raw_files_are_external": True,
        },
        "files": file_metadata,
        "outputs": output_metadata,
        "counts": counts,
        "quarantine_count": len(quarantine),
        "split_policy": {
            "held_out": "official test.jsonl; no re-sampling",
            "development": (
                "deterministic hash selection from train.jsonl after test/gold page "
                "and normalized pre/post text exclusion; each selected pair emits typo "
                "pre and corrected clean post examples"
            ),
            "development_independent": False,
            "excluded_page_sets": ["test", "gold"],
        },
    }
    _write_json(output_root / "manifest.json", manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--development-size", type=int, default=1000)
    args = parser.parse_args()
    manifest = prepare_corpus(
        args.source,
        args.output,
        config_path=args.config,
        development_size=args.development_size,
    )
    print(
        json.dumps(
            {
                "output": args.output.as_posix(),
                "counts": manifest["counts"],
                "quarantine_count": manifest["quarantine_count"],
                "source_files": manifest["files"],
                "output_files": manifest["outputs"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
