"""Exercise model-tool CLI wrappers without downloading or loading a model."""

from __future__ import annotations

import json
import pathlib
import runpy
import sys
from types import ModuleType
from typing import Any

import pytest

ROOT = pathlib.Path(__file__).parents[2]


def fake_pipeline(**functions: Any) -> ModuleType:
    module = ModuleType("scripts.model_pipeline")
    for name, value in functions.items():
        setattr(module, name, value)
    return module


def run_wrapper(
    monkeypatch: pytest.MonkeyPatch,
    relative_path: str,
    module: ModuleType,
    *arguments: str,
) -> dict[str, Any]:
    monkeypatch.setitem(sys.modules, "scripts.model_pipeline", module)
    monkeypatch.setattr(sys, "argv", [str(ROOT / relative_path), *arguments])
    return runpy.run_path(str(ROOT / relative_path), run_name="__main__")


def test_benchmark_dispatches_each_distributed_model(monkeypatch, tmp_path, capsys):
    calls: list[tuple[pathlib.Path, str]] = []
    converted_root = tmp_path / "converted"

    def onnx_infer(path: pathlib.Path, text: str) -> dict[str, Any]:
        calls.append((path, text))
        return {"elapsed_ms": 1.25, "detections": []}

    run_wrapper(
        monkeypatch,
        "scripts/benchmark.py",
        fake_pipeline(CONVERTED_ROOT=converted_root, onnx_infer=onnx_infer),
    )

    expected_text = "明日の予定については、来週移行にご連絡します。"
    assert calls == [
        (converted_root / "onnx" / "model.onnx", expected_text),
        (converted_root / "onnx" / "model_quantized.onnx", expected_text),
        (converted_root / "onnx" / "model_fp16.onnx", expected_text),
    ]
    assert "model_quantized.onnx" in capsys.readouterr().out


def test_export_wrapper_dispatches_and_propagates_export_failure(monkeypatch):
    calls: list[str] = []

    def export_onnx() -> str:
        calls.append("export")
        raise RuntimeError("synthetic export failure")

    with pytest.raises(RuntimeError, match="synthetic export failure"):
        run_wrapper(
            monkeypatch,
            "scripts/export_onnx.py",
            fake_pipeline(export_onnx=export_onnx),
        )
    assert calls == ["export"]


def test_prepare_wrapper_dispatches_pipeline_in_order(monkeypatch, tmp_path, capsys):
    upstream_root = tmp_path / "upstream"
    converted_root = tmp_path / "converted"
    calls: list[tuple[str, tuple[pathlib.Path, ...]]] = []

    def record(name: str, result: pathlib.Path | None = None):
        def operation(*arguments: pathlib.Path) -> pathlib.Path | None:
            calls.append((name, arguments))
            return result

        return operation

    manifest = converted_root / "manifest.json"
    run_wrapper(
        monkeypatch,
        "scripts/prepare_models.py",
        fake_pipeline(
            UPSTREAM_ROOT=upstream_root,
            CONVERTED_ROOT=converted_root,
            download_upstream=record("download", upstream_root),
            export_onnx=record("export", converted_root / "onnx" / "model.onnx"),
            quantize_int8=record("quantize", converted_root / "onnx" / "model_quantized.onnx"),
            convert_fp16=record("fp16", converted_root / "onnx" / "model_fp16.onnx"),
            write_manifest=record("manifest", manifest),
        ),
    )

    assert calls == [
        ("download", (upstream_root,)),
        ("export", (upstream_root, converted_root)),
        ("quantize", (converted_root / "onnx" / "model.onnx",)),
        ("fp16", (converted_root / "onnx" / "model.onnx",)),
        ("manifest", (converted_root, upstream_root)),
    ]
    assert str(manifest) in capsys.readouterr().out


def test_prepare_wrapper_propagates_download_failure(monkeypatch, tmp_path):
    def download_upstream(_output: pathlib.Path) -> pathlib.Path:
        raise RuntimeError("synthetic download failure")

    with pytest.raises(RuntimeError, match="synthetic download failure"):
        run_wrapper(
            monkeypatch,
            "scripts/prepare_models.py",
            fake_pipeline(
                UPSTREAM_ROOT=tmp_path / "upstream",
                CONVERTED_ROOT=tmp_path / "converted",
                download_upstream=download_upstream,
                export_onnx=lambda *_: None,
                quantize_int8=lambda *_: None,
                convert_fp16=lambda *_: None,
                write_manifest=lambda *_: None,
            ),
        )


def test_tokenizer_fixture_wrapper_writes_all_special_token_cases(monkeypatch, capsys):
    calls: list[tuple[str, bool]] = []
    written: dict[str, Any] = {}

    class FakeEncoding:
        ids = [101]
        tokens = ["fixture"]
        offsets = [(0, 1)]

    class FakeTokenizer:
        def encode(self, text: str, *, add_special_tokens: bool) -> FakeEncoding:
            calls.append((text, add_special_tokens))
            return FakeEncoding()

    class FakeTokenizerFactory:
        @staticmethod
        def from_file(path: str) -> FakeTokenizer:
            written["source"] = path
            return FakeTokenizer()

    tokenizers = ModuleType("tokenizers")
    tokenizers.Tokenizer = FakeTokenizerFactory  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tokenizers", tokenizers)

    class CapturePath:
        def __init__(self, value: str):
            self.value = value

        def write_text(self, text: str, *, encoding: str) -> None:
            written["destination"] = self.value
            written["encoding"] = encoding
            written["payload"] = text

    monkeypatch.setattr(pathlib, "Path", CapturePath)
    runpy.run_path(str(ROOT / "scripts/tokenizer_fixtures.py"), run_name="__main__")

    payload = json.loads(written["payload"])
    assert written["source"].endswith(
        "models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/tokenizer.json"
    )
    assert written["destination"] == "tests/fixtures/tokenizer-reference.json"
    assert written["encoding"] == "utf-8"
    assert payload["revision"] == "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
    assert len(payload["cases"]) == 34
    assert len(calls) == 34
    assert {special for _, special in calls} == {False, True}
    assert "tokenizer-reference" not in capsys.readouterr().out


def test_tokenizer_fixture_wrapper_propagates_tokenizer_failure(monkeypatch):
    class FailingTokenizer:
        @staticmethod
        def from_file(_path: str):
            raise RuntimeError("synthetic tokenizer failure")

    tokenizers = ModuleType("tokenizers")
    tokenizers.Tokenizer = FailingTokenizer  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tokenizers", tokenizers)

    with pytest.raises(RuntimeError, match="synthetic tokenizer failure"):
        runpy.run_path(str(ROOT / "scripts/tokenizer_fixtures.py"), run_name="__main__")
