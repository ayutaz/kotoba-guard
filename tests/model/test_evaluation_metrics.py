import numpy as np
import pytest

from scripts.evaluation import (
    ErrorSpan,
    aggregate_label_scores,
    aggregate_span_scores,
    check_conversion,
    exact_span_scores,
    label_scores,
    scores,
    spans_from_logits,
    token_label_scores,
)


def _conversion_payload(*, fp32_delta: float = 0.0, quint8_f1: float = 0.9) -> dict:
    return {
        "parity_to_pytorch": {"onnx_fp32": {"max_abs_logit_delta": fp32_delta}},
        "thresholds": {
            "0.5": {
                "pytorch": {
                    "span": {"f1": 0.9},
                    "clean_false_positive_rate": 0.01,
                },
                "onnx_fp32": {
                    "span": {"f1": 0.9},
                    "clean_false_positive_rate": 0.01,
                },
                "onnx_quint8": {
                    "span": {"f1": quint8_f1},
                    "clean_false_positive_rate": 0.01,
                },
                "onnx_fp16": {
                    "span": {"f1": 0.9},
                    "clean_false_positive_rate": 0.01,
                },
            }
        },
    }


def test_conversion_gate_rejects_logit_or_f1_regression() -> None:
    result = check_conversion(_conversion_payload(fp32_delta=0.0011, quint8_f1=0.88))

    assert result["passed"] is False
    assert any("FP32" in failure for failure in result["failures"])
    assert any("onnx_quint8" in failure for failure in result["failures"])


def test_conversion_gate_accepts_bounded_regression() -> None:
    result = check_conversion(_conversion_payload(fp32_delta=0.001, quint8_f1=0.89))

    assert result == {"passed": True, "failures": []}


@pytest.mark.parametrize(
    ("metric", "value"),
    [("fp32_delta", float("nan")), ("quint8_f1", float("nan")), ("fp32_delta", float("inf"))],
)
def test_conversion_gate_rejects_nonfinite_metrics(metric: str, value: float) -> None:
    kwargs = {metric: value}
    result = check_conversion(_conversion_payload(**kwargs))

    assert result["passed"] is False
    assert any("finite" in failure.lower() for failure in result["failures"])


def test_aggregate_span_metrics_keep_document_identity() -> None:
    same_span = ErrorSpan(2, 3, "substitution")

    result = aggregate_span_scores([([], [same_span]), ([same_span], [])])

    assert result["tp"] == 0
    assert result["fp"] == 1
    assert result["fn"] == 1


def test_aggregate_label_metrics_count_same_span_in_each_document() -> None:
    same_span = ErrorSpan(2, 3, "substitution")

    result = aggregate_label_scores([([same_span], []), ([same_span], [])], ["substitution"])

    assert result["substitution"]["tp"] == 0
    assert result["substitution"]["fp"] == 0
    assert result["substitution"]["fn"] == 2


def test_exact_span_metrics_use_unique_labeled_spans() -> None:
    gold = [ErrorSpan(2, 3, "substitution"), ErrorSpan(8, 9, "deletion")]
    predicted = [ErrorSpan(2, 3, "substitution"), ErrorSpan(4, 5, "others")]
    assert exact_span_scores(gold, predicted) == {
        "tp": 1,
        "fp": 1,
        "fn": 1,
        "precision": 0.5,
        "recall": 0.5,
        "f1": 0.5,
    }


def test_label_metrics_keep_zero_support_labels_explicit() -> None:
    result = label_scores([ErrorSpan(0, 1, "substitution")], [], ["substitution", "others"])
    assert result["substitution"]["fn"] == 1
    assert result["others"] == {
        "tp": 0,
        "fp": 0,
        "fn": 0,
        "precision": 0.0,
        "recall": 0.0,
        "f1": 0.0,
    }


def test_token_metrics_assign_zero_width_deletion_to_containing_token() -> None:
    offsets = [(0, 1), (1, 2), (0, 0)]
    result = token_label_scores(
        [ErrorSpan(1, 1, "deletion")],
        [ErrorSpan(1, 2, "deletion")],
        offsets,
        ["OK", "deletion"],
    )
    assert result["tp"] == 1
    assert result["fn"] == 0


def test_token_metrics_count_wrong_non_ok_label_as_fp_and_fn() -> None:
    result = token_label_scores(
        [ErrorSpan(0, 1, "substitution")],
        [ErrorSpan(0, 1, "deletion")],
        [(0, 1)],
        ["OK", "deletion", "substitution"],
    )

    assert result["tp"] == 0
    assert result["fp"] == 1
    assert result["fn"] == 1


def test_logits_threshold_and_contiguous_spans() -> None:
    logits = np.array([[0.0, 0.0], [0.0, 4.0], [0.0, 3.0], [4.0, 0.0]])
    spans = spans_from_logits(logits, [(0, 0), (0, 1), (1, 2), (2, 3)], ["OK", "substitution"], 0.8)
    assert spans == [ErrorSpan(0, 2, "substitution", 1 / (1 + np.exp(-3)))]


def test_scores_empty_input_is_zero_without_nan() -> None:
    result = scores({"tp": 0, "fp": 0, "fn": 0})
    assert result["f1"] == 0.0
