from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest

import scripts.evaluate_candidate as candidate_cli
from scripts.evaluate_candidate import CandidateEvaluationError, CandidateOnnxRunner


class _FakeEncoding:
    def __init__(self, length: int):
        self.ids = list(range(length))
        self.attention_mask = [1] * length
        self.offsets = [(index, index + 1) for index in range(length)]


class _FakeTokenizer:
    def __init__(self, length: int):
        self.length = length
        self.calls: list[str] = []

    def no_truncation(self) -> None:
        self.calls.append("no_truncation")

    def no_padding(self) -> None:
        self.calls.append("no_padding")

    def encode(self, _text: str) -> _FakeEncoding:
        return _FakeEncoding(self.length)


class _FakeSessionOptions:
    def __init__(self):
        self.intra_op_num_threads = None
        self.inter_op_num_threads = None
        self.graph_optimization_level = None


class _FakeGraphOptimizationLevel:
    ORT_DISABLE_ALL = "disabled"


def _install_runtime(
    monkeypatch: pytest.MonkeyPatch,
    *,
    input_names: tuple[str, ...] = ("input_ids", "attention_mask", "token_type_ids"),
    output: np.ndarray | None = None,
    tokenizer_length: int = 2,
) -> tuple[_FakeTokenizer, type]:
    tokenizer = _FakeTokenizer(tokenizer_length)
    monkeypatch.setattr(
        candidate_cli,
        "Tokenizer",
        types.SimpleNamespace(from_file=staticmethod(lambda _path: tokenizer)),
    )
    session_holder: dict[str, type] = {}

    class _FakeSession:
        def __init__(self, _path, *, sess_options, providers):
            self.options = sess_options
            self.providers = providers
            self.feeds: list[dict[str, np.ndarray]] = []
            session_holder["session"] = self

        def get_inputs(self):
            return [types.SimpleNamespace(name=name) for name in input_names]

        def get_outputs(self):
            return [types.SimpleNamespace(name="logits")]

        def run(self, _names, feeds):
            self.feeds.append(feeds)
            values = output if output is not None else np.zeros((1, 2, 2), dtype=np.float32)
            return [values]

    fake_ort = types.SimpleNamespace(
        SessionOptions=_FakeSessionOptions,
        GraphOptimizationLevel=_FakeGraphOptimizationLevel,
        InferenceSession=_FakeSession,
        __version__="fake-ort",
    )
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    return tokenizer, session_holder


def _runner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kwargs
) -> tuple[CandidateOnnxRunner, _FakeTokenizer, dict[str, type]]:
    tokenizer, session_holder = _install_runtime(monkeypatch, **kwargs)
    runner = CandidateOnnxRunner(tmp_path / "model.onnx", tmp_path, ("OK", "substitution"))
    return runner, tokenizer, session_holder


def test_runner_disables_tokenizer_policies_and_builds_supported_feeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    runner, tokenizer, session_holder = _runner(tmp_path, monkeypatch)

    logits, offsets = runner.logits("ab")

    assert tokenizer.calls == ["no_truncation", "no_padding"]
    assert runner.ort_version == "fake-ort"
    assert offsets == [(0, 1), (1, 2)]
    assert logits.shape == (2, 2)
    session = session_holder["session"]
    assert session.options.intra_op_num_threads == 1
    assert session.options.inter_op_num_threads == 1
    assert session.options.graph_optimization_level == "disabled"
    assert session.providers == ["CPUExecutionProvider"]
    feeds = session.feeds[0]
    assert set(feeds) == {"input_ids", "attention_mask", "token_type_ids"}
    assert all(value.shape == (1, 2) for value in feeds.values())
    assert feeds["attention_mask"].tolist() == [[1, 1]]


def test_runner_rejects_more_than_model_maximum_without_running_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    runner, _tokenizer, session_holder = _runner(tmp_path, monkeypatch, tokenizer_length=8193)

    with pytest.raises(CandidateEvaluationError, match="exceeds 8192"):
        runner.logits("too long")
    assert session_holder["session"].feeds == []


@pytest.mark.parametrize(
    "output",
    [
        np.zeros((1, 1, 2), dtype=np.float32),
        np.asarray([[[0.0, np.nan], [0.0, 1.0]]], dtype=np.float32),
    ],
)
def test_runner_rejects_shape_or_nonfinite_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, output: np.ndarray
):
    runner, _tokenizer, _session_holder = _runner(tmp_path, monkeypatch, output=output)

    with pytest.raises(CandidateEvaluationError, match="shape or values"):
        runner.logits("ab")


def test_runner_rejects_unsupported_model_input(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    runner, _tokenizer, _session_holder = _runner(
        tmp_path, monkeypatch, input_names=("input_ids", "unexpected_input")
    )

    with pytest.raises(CandidateEvaluationError, match="unsupported input"):
        runner.logits("ab")
