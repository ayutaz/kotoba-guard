"""Dataset alignment, leakage prevention and product accuracy gates."""

import math

import pytest

from scripts.corpus_evaluation import (
    DatasetError,
    accuracy_gate,
    containment_scores,
    parse_pair,
    partition_pairs,
    project_gold,
    select_threshold,
    wilson_interval,
)
from scripts.evaluation import ErrorSpan

LABELS = ("OK", "substitution", "deletion", "others")


def pair(pre="誤った文", post="正しい文", page="1", **extra):
    return {
        "page": page,
        "pre_text": pre,
        "post_text": post,
        "diffs": [{"pre_str": pre, "post_str": post, "category": "substitution"}],
        **extra,
    }


def test_pair_alignment_uses_corrected_sentence_to_resolve_repeated_context():
    record = pair("甲甲😀", "乙甲😀")
    record["diffs"] = [{"pre_str": "甲", "post_str": "乙", "category": "substitution"}]
    result = parse_pair(record, LABELS, "source:1")
    assert result["errors"] == [{"start": 0, "end": 1, "label": "substitution"}]
    assert result["text"] == "甲甲😀"


def test_pair_alignment_preserves_codepoint_offsets_and_multiple_edits():
    record = pair("😀甲と丙", "😀乙と丁")
    record["diffs"] = [
        {"pre_str": "甲", "post_str": "乙", "category": "substitution"},
        {"pre_str": "丙", "post_str": "丁", "category": "others"},
    ]
    assert parse_pair(record, LABELS, "r")["errors"] == [
        {"start": 1, "end": 2, "label": "substitution"},
        {"start": 3, "end": 4, "label": "others"},
    ]


@pytest.mark.parametrize("category", ["invented", "OK"])
def test_unknown_or_clean_diff_labels_are_rejected(category):
    record = pair()
    record["diffs"][0]["category"] = category
    with pytest.raises(DatasetError, match="label"):
        parse_pair(record, LABELS, "r")


def test_ambiguous_or_inconsistent_edits_are_not_silently_scored():
    record = pair("ああ", "あ")
    record["diffs"] = [{"pre_str": "あ", "post_str": "", "category": "deletion"}]
    with pytest.raises(DatasetError, match="ambiguous"):
        parse_pair(record, LABELS, "r")
    record["post_text"] = "い"
    with pytest.raises(DatasetError, match="reconstruct"):
        parse_pair(record, LABELS, "r")


def test_equivalent_duplicate_edits_preserve_all_joint_reconstructions():
    record = pair("あああ", "あ")
    record["diffs"] = [
        {"pre_str": "あ", "post_str": "", "category": "deletion"},
        {"pre_str": "あ", "post_str": "", "category": "deletion"},
    ]
    result = parse_pair(record, LABELS, "r", allow_ambiguous=True)
    assert result["error_alternatives"] == [
        [{"start": 0, "end": 1, "label": "deletion"}, {"start": 1, "end": 2, "label": "deletion"}],
        [{"start": 0, "end": 1, "label": "deletion"}, {"start": 2, "end": 3, "label": "deletion"}],
        [{"start": 1, "end": 2, "label": "deletion"}, {"start": 2, "end": 3, "label": "deletion"}],
    ]
    assert result["errors"] == result["error_alternatives"][0]


def test_zero_width_deletion_and_overlapping_token_projection_are_explicit():
    record = pair("甲乙", "甲の乙")
    record["diffs"] = [{"pre_str": "", "post_str": "の", "category": "deletion"}]
    assert parse_pair(record, LABELS, "r")["errors"][0]["start"] == 1
    assert project_gold([ErrorSpan(1, 1, "deletion")], [(0, 0), (0, 2), (0, 0)]) == [
        ErrorSpan(0, 2, "deletion")
    ]
    assert project_gold([ErrorSpan(2, 2, "deletion")], [(0, 1), (1, 2)]) == [
        ErrorSpan(1, 2, "deletion")
    ]


def test_projection_rejects_conflicting_labels_and_uncovered_gold():
    with pytest.raises(DatasetError, match="conflict"):
        project_gold([ErrorSpan(0, 1, "deletion"), ErrorSpan(1, 2, "others")], [(0, 2)])
    with pytest.raises(DatasetError, match="uncovered"):
        project_gold([ErrorSpan(4, 5, "deletion")], [(0, 1)])


def test_partition_groups_pages_pairs_and_duplicate_text_and_is_order_independent():
    records = [
        parse_pair(pair("甲", "乙", "1"), LABELS, "a"),
        parse_pair(pair("乙", "丙", "2"), LABELS, "b"),
        parse_pair(pair("丁", "戊", "1"), LABELS, "c"),
        parse_pair(pair("別", "文", "3"), LABELS, "d"),
    ]
    first = partition_pairs(records)
    second = partition_pairs(list(reversed(records)))
    assignment = {item["id"]: split for split, items in first.items() for item in items}
    assert assignment["a"] == assignment["b"] == assignment["c"]
    assert assignment == {item["id"]: split for split, items in second.items() for item in items}


def test_clean_false_positive_interval_exposes_small_sample_uncertainty():
    low, high = wilson_interval(0, 20)
    assert low == pytest.approx(0)
    assert 0.15 < high < 0.17
    assert wilson_interval(0, 0) == (None, None)
    with pytest.raises(ValueError):
        wilson_interval(2, 1)


def test_accuracy_gate_rejects_low_recall_even_with_no_predictions():
    metric = {"precision": 0.0, "recall": 0.0, "f1": 0.0}
    result = accuracy_gate(metric, metric, 0, 1000)
    assert not result["passed"]
    assert any("recall" in message for message in result["failures"])


def test_accuracy_gate_checks_all_targets_support_and_nonfinite_values():
    reference = {"precision": 0.97, "recall": 0.85, "f1": 0.91}
    candidate = {"precision": 0.96, "recall": 0.84, "f1": 0.90}
    assert accuracy_gate(reference, candidate, 5, 1000)["passed"]
    assert not accuracy_gate(reference, {**candidate, "f1": 0.899}, 5, 1000)["passed"]
    assert not accuracy_gate(reference, candidate, 21, 1000)["passed"]
    assert not accuracy_gate(reference, candidate, 0, 0)["passed"]
    assert not accuracy_gate(reference, {**candidate, "precision": math.nan}, 0, 1000)["passed"]


def test_containment_matches_each_diff_and_prediction_only_once():
    gold = [ErrorSpan(0, 1, "deletion"), ErrorSpan(1, 2, "deletion")]
    broad = ErrorSpan(0, 2, "deletion")
    assert containment_scores(gold, [broad])["tp"] == 1
    assert containment_scores(gold, [broad])["fn"] == 1
    assert containment_scores(gold, [broad, ErrorSpan(0, 1, "deletion")])["tp"] == 2


def test_containment_distinguishes_location_from_label_and_handles_gaps():
    gold = [ErrorSpan(1, 1, "deletion")]
    predicted = [ErrorSpan(0, 2, "others")]
    assert containment_scores(gold, predicted)["tp"] == 0
    assert containment_scores(gold, predicted, labeled=False)["tp"] == 1


def test_threshold_selection_uses_only_admissible_development_metrics():
    rows = {
        "0.5": {"event": {"precision": 0.90, "recall": 0.9}, "clean_rate": 0.0},
        "0.8": {"event": {"precision": 0.96, "recall": 0.8}, "clean_rate": 0.01},
        "0.95": {"event": {"precision": 0.99, "recall": 0.3}, "clean_rate": 0.0},
    }
    assert select_threshold(rows) == {"threshold": 0.8, "admissible": True}
    assert select_threshold({"0.5": rows["0.5"]}) == {"threshold": 0.5, "admissible": False}
