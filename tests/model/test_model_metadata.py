import json
from pathlib import Path

from scripts.model_pipeline import EXPECTED_REVISION, load_model_metadata

ROOT = Path(__file__).parents[2]


def test_manifest_pins_the_official_revision() -> None:
    manifest = json.loads((ROOT / "models" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["revision"] == EXPECTED_REVISION
    assert len(manifest["revision"]) == 40


def test_labels_are_loaded_from_config_and_keep_official_order(tmp_path: Path) -> None:
    config = {
        "id2label": {
            "0": "OK",
            "1": "deletion",
            "2": "insertion_a",
            "3": "insertion_b",
            "4": "kanji-conversion_a",
            "5": "kanji-conversion_b",
            "6": "substitution",
            "7": "transposition",
            "8": "others",
        },
        "label2id": {
            "OK": 0,
            "deletion": 1,
            "insertion_a": 2,
            "insertion_b": 3,
            "kanji-conversion_a": 4,
            "kanji-conversion_b": 5,
            "substitution": 6,
            "transposition": 7,
            "others": 8,
        },
    }
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    metadata = load_model_metadata(tmp_path)
    assert metadata.labels == tuple(config["id2label"].values())
    assert metadata.label_to_id["others"] == 8


def test_missing_label_mapping_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text(json.dumps({"id2label": {"0": "OK"}}), encoding="utf-8")
    try:
        load_model_metadata(tmp_path)
    except ValueError as error:
        assert "label" in str(error)
    else:
        raise AssertionError("missing label2id must fail closed")
