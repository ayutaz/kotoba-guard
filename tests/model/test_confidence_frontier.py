"""An exact threshold diagnostic must include splitting and tied token changes."""

import numpy as np
import pytest

from scripts import analyze_scoring_sensitivity as diagnostic
from scripts.run_corpus_evaluation import evaluate_outputs

LABELS = ("OK", "substitution", "deletion")


def item(text, spans):
    return {"text": text, "errors": spans}


def span(start, end, label="substitution"):
    return {"start": start, "end": end, "label": label}


def probabilities(values, dtype=np.float64):
    return np.log(np.asarray(values, dtype=dtype))


def assert_matches_frozen_scorer(items, outputs, result):
    for point in result["points"]:
        expected = evaluate_outputs(items, outputs, LABELS, point["threshold"])
        assert point["event"] == {
            k: v for k, v in expected["event"].items() if not k.endswith("interval95")
        }
        for key in ("clean_items", "clean_false_positive_items", "clean_rate"):
            assert point[key] == expected[key]


def test_removing_middle_token_splits_a_span_and_can_increase_recall():
    items = [item("甲乙丙", [span(0, 1), span(2, 3)]), item("正常", [])]
    outputs = [
        (
            probabilities([[0.02, 0.95, 0.03], [0.3, 0.55, 0.15], [0.03, 0.9, 0.07]]),
            [(0, 1), (1, 2), (2, 3)],
        ),
        (probabilities([[0.98, 0.01, 0.01]]), [(0, 2)]),
    ]
    result = diagnostic.confidence_frontier(items, outputs, LABELS)
    assert result["points"][0]["event"]["recall"] == 0.5
    assert result["max_recall"]["event"]["recall"] == 1.0
    assert result["attainable_points"] > 0
    assert result["max_f1"]["event"]["f1"] == 1.0
    assert_matches_frozen_scorer(items, outputs, result)


def test_equal_confidences_across_documents_change_atomically():
    items = [item("誤", [span(0, 1)]), item("正", [])]
    values = probabilities([[0.1, 0.8, 0.1]])
    result = diagnostic.confidence_frontier(items, [(values, [(0, 1)])] * 2, LABELS)
    assert result["attainable_points"] == 0
    assert len(result["points"]) == 3
    assert all(not (p["event"]["tp"] == 1 and p["clean_rate"] == 0) for p in result["points"])
    assert_matches_frozen_scorer(items, [(values, [(0, 1)])] * 2, result)


def test_special_and_ok_tokens_make_no_boundaries_and_confidence_one_stays():
    items = [item("甲", [span(0, 1)]), item("乙", [])]
    outputs = [
        (np.array([[0.0, 3.0, 1.0], [-1000.0, 1000.0, -1000.0]]), [(0, 0), (0, 1)]),
        (np.array([[5.0, 0.0, 0.0]]), [(0, 1)]),
    ]
    result = diagnostic.confidence_frontier(items, outputs, LABELS)
    assert [p["threshold"] for p in result["points"]] == [0.0, 1.0]
    assert result["points"][-1]["event"]["tp"] == 1
    assert result["max_recall"]["threshold"] == result["max_f1"]["threshold"] == 0
    assert_matches_frozen_scorer(items, outputs, result)


def test_no_clean_records_cannot_establish_three_target_feasibility():
    items = [item("甲", [span(0, 1)])]
    result = diagnostic.confidence_frontier(items, [(np.array([[0, 10, 0.0]]), [(0, 1)])], LABELS)
    assert result["attainable_points"] == 0
    assert all(p["clean_rate"] is None for p in result["points"])


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
def test_boundary_is_strictly_after_inclusive_confidence_and_matches_brute_force(dtype):
    first = [span(0, 1), span(2, 3, "deletion")]
    other = [span(1, 2), span(2, 3, "deletion")]
    items = [dict(item("甲乙丙", first), error_alternatives=[first, other]), item("正常", [])]
    values = probabilities([[0.15, 0.7, 0.15], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]], dtype)
    outputs = [(values, [(0, 1), (1, 2), (2, 3)]), (values[:1], [(0, 2)])]
    result = diagnostic.confidence_frontier(items, outputs, LABELS)
    shifted = values - values.max(axis=-1, keepdims=True)
    probs = np.exp(shifted)
    probs /= probs.sum(axis=-1, keepdims=True)
    confidences = {float(row.max()) for row in probs}
    assert {p["threshold"] for p in result["points"]} == {
        0.0,
        1.0,
        *(float(np.nextafter(c, np.inf)) for c in confidences),
    }
    for threshold in [*confidences, 0.5, 0.75, 0.99]:
        state = max(
            (p for p in result["points"] if p["threshold"] <= threshold),
            key=lambda p: p["threshold"],
        )
        expected = evaluate_outputs(items, outputs, LABELS, threshold)
        assert all(state["event"][k] == expected["event"][k] for k in ("tp", "fp", "fn"))
    assert_matches_frozen_scorer(items, outputs, result)


@pytest.mark.parametrize("bad", ["empty", "nan", "integer", "offset"])
def test_invalid_inputs_fail_closed(bad):
    items = [item("甲", [span(0, 1)])]
    values, offsets = np.array([[0.0, 3.0, 0.0]]), [(0, 1)]
    if bad == "empty":
        items = []
    elif bad == "nan":
        values[0, 1] = np.nan
    elif bad == "integer":
        values = values.astype(np.int64)
    else:
        offsets = [(0, 2)]
    with pytest.raises(diagnostic.SensitivityError):
        diagnostic.confidence_frontier(items, [(values, offsets)], LABELS)
