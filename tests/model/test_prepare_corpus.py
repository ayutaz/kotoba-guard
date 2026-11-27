"""TDD coverage for the JWTD corpus preparation boundary."""

import hashlib
import json
import unicodedata
from pathlib import Path

from scripts.prepare_corpus import _normal_key, prepare_corpus

LABELS = ("OK", "substitution", "deletion", "others")


def test_protected_text_normalization_is_nfc_and_whitespace_stable() -> None:
    composed = "がく"
    decomposed = unicodedata.normalize("NFD", composed)
    assert _normal_key(composed) == _normal_key(decomposed)
    assert _normal_key("保護  文字") == _normal_key(" 保護 文字 ")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
    )


def pair(page: str, pre: str, post: str, *, label: str = "substitution") -> dict:
    return {
        "page": page,
        "title": "fixture",
        "pre_rev": "1",
        "post_rev": "2",
        "pre_text": pre,
        "post_text": post,
        "diffs": [{"pre_str": pre, "post_str": post, "category": label}],
    }


def test_prepare_keeps_official_test_and_quarantines_unknown_without_text(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    write_jsonl(source / "train.jsonl", [pair("train", "甲", "乙")])
    write_jsonl(
        source / "test.jsonl",
        [
            pair("test", "甲", "乙"),
            {
                **pair("bad", "丙", "丁"),
                "diffs": [{"pre_str": "丙", "post_str": "丁", "category": "unknown"}],
            },
        ],
    )
    write_jsonl(
        source / "gold.jsonl",
        [{"page": "gold", "pre_text": "甲", "post_text": "乙", "diffs": []}],
    )

    result = prepare_corpus(source, tmp_path / "out", labels=LABELS, development_size=1)
    held_out = json.loads((tmp_path / "out/held-out.json").read_text(encoding="utf-8"))
    gold_clean = json.loads((tmp_path / "out/gold-clean.json").read_text(encoding="utf-8"))
    quarantine = json.loads((tmp_path / "out/quarantine.json").read_text(encoding="utf-8"))

    assert len(held_out["items"]) == 2
    assert held_out["metadata"]["source_split"] == "official_test"
    assert held_out["metadata"]["eligible_pairs"] == 1
    assert held_out["metadata"]["output_examples"] == 2
    assert [item["text"] for item in held_out["items"]] == ["甲", "乙"]
    assert held_out["items"][1]["errors"] == []
    assert held_out["items"][1]["id"].endswith(":post")
    assert "error_alternatives" not in held_out["items"][1]
    assert held_out["items"][0]["error_alternatives"] == [held_out["items"][0]["errors"]]
    assert gold_clean["items"][0]["text"] == "乙"
    assert gold_clean["items"][0]["errors"] == []
    assert len(quarantine) == 1
    assert quarantine[0]["split"] == "test"
    assert "text" not in quarantine[0]
    assert "丙" not in json.dumps(quarantine, ensure_ascii=False)
    assert result["counts"]["test"]["quarantined"] == 1


def test_development_excludes_test_gold_pages_and_duplicate_pairs(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    write_jsonl(
        source / "test.jsonl",
        [pair("held", "テスト誤", "テスト正"), pair("protected-space", "保護  文字", "保護正")],
    )
    write_jsonl(
        source / "gold.jsonl",
        [{"page": "gold", "pre_text": "ゴールド誤", "post_text": "ゴールド正", "diffs": []}],
    )
    write_jsonl(
        source / "train.jsonl",
        [
            pair("held", "禁止", "禁上"),
            pair("gold", "禁止", "禁上"),
            pair("eligible", "甲", "乙"),
            pair("duplicate", " 甲 ", "乙"),
            pair("eligible-2", "丙", "丁"),
            pair("text-hit-pre", "テスト誤", "別の正"),
            pair("text-hit-post", "別の誤", "ゴールド正"),
            pair("normalized-hit", "保護 文字", "別の正"),
        ],
    )

    first = prepare_corpus(source, tmp_path / "out-a", labels=LABELS, development_size=2)
    prepare_corpus(source, tmp_path / "out-b", labels=LABELS, development_size=2)
    first_items = json.loads((tmp_path / "out-a/development.json").read_text(encoding="utf-8"))[
        "items"
    ]
    second_items = json.loads((tmp_path / "out-b/development.json").read_text(encoding="utf-8"))[
        "items"
    ]

    assert [item["id"] for item in first_items] == [item["id"] for item in second_items]
    assert {item["page"] for item in first_items} <= {"eligible", "eligible-2"}
    assert first["counts"]["train"]["deduplicated"] == 1
    assert first["counts"]["train"]["excluded_texts"] == 3
    assert first["metadata"]["development"]["independent"] is False


def test_manifest_records_source_hashes_and_quarantine_has_no_machine_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for split in ("train", "test", "gold"):
        write_jsonl(source / f"{split}.jsonl", [])

    output = tmp_path / "out"
    prepare_corpus(source, output, labels=LABELS, development_size=0)
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    expected = hashlib.sha256((source / "train.jsonl").read_bytes()).hexdigest()

    assert manifest["license"] == "CC-BY-SA-3.0"
    assert manifest["files"]["train.jsonl"]["sha256"] == expected
    assert manifest["source"]["decoded_tar_sha256"]
    assert manifest["source"]["compressed_sha256"] == (
        "2c6d864905adbac75a2c0181aa8796c81d3f86df41aa8bf79b37d47ee8ec5025"
    )
    assert manifest["source"]["content_encoding"] == "gzip"
    assert str(tmp_path) not in json.dumps(manifest)
