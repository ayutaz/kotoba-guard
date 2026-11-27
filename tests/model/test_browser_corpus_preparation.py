import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace

from scripts.prepare_browser_corpus import (
    BrowserCorpusError,
    codepoint_to_utf16,
    prepare_browser_corpus,
    run_candidate_cpu_diagnostic,
    run_fp32_cpu_diagnostic,
    run_native_diagnostic,
    select_subset,
)


def _write_fixture(tmp_path: Path) -> tuple[Path, Path, Path, Path, Path, Path, Path, Path]:
    dataset = tmp_path / "held-out.json"
    items = []
    for index, label in enumerate(("a", "b", "a", "b")):
        pair_id = f"pair-{index}"
        pre = {
            "id": f"{pair_id}:pre",
            "pair_id": pair_id,
            "text": f"錯 {index}",
            "errors": [{"start": 0, "end": 1, "label": label}],
            "corrected_text": f"正{index}",
            "source_role": "typo_pre",
        }
        post = {
            "id": f"{pair_id}:post",
            "pair_id": pair_id,
            "text": f"正 {index}",
            "errors": [],
            "source_role": "corrected_clean",
        }
        items.extend((pre, post))
    dataset.write_text(json.dumps({"schema_version": "jwtd-v1", "items": items}), encoding="utf-8")
    cache = tmp_path / "logits.npz"
    rows = []
    offsets = []
    bounds = [0]
    for index in range(len(items)):
        rows.append(np.full((2, 3), index, dtype=np.float32))
        offsets.extend(((0, 1), (0, 0)))
        bounds.append(bounds[-1] + 2)
    np.savez_compressed(
        cache, logits=np.concatenate(rows), offsets=np.asarray(offsets), bounds=bounds
    )
    raw_model_sha = "a" * 64
    sidecar = tmp_path / "cache.json"
    sidecar.write_text(
        json.dumps(
            {
                "inputs": {
                    "dataset_sha256": hashlib.sha256(dataset.read_bytes()).hexdigest(),
                    "model_sha256": raw_model_sha,
                    "revision": "revision",
                    "tokenizer_sha256": "b" * 64,
                    "tokenizer_config_sha256": "c" * 64,
                },
                "cache_sha256": hashlib.sha256(cache.read_bytes()).hexdigest(),
                "items": len(items),
            }
        ),
        encoding="utf-8",
    )
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "id2label": {"0": "OK", "1": "a", "2": "b"},
                "label2id": {"OK": 0, "a": 1, "b": 2},
            }
        ),
        encoding="utf-8",
    )
    tokenizer = tmp_path / "tokenizer.json"
    test_tokenizer = Tokenizer(WordLevel({"[UNK]": 0, "錯": 1, "正": 2}, unk_token="[UNK]"))
    test_tokenizer.pre_tokenizer = Whitespace()
    test_tokenizer.save(str(tokenizer))
    tokenizer_config = tmp_path / "tokenizer_config.json"
    tokenizer_config.write_text("{}", encoding="utf-8")
    sidecar_payload = json.loads(sidecar.read_text(encoding="utf-8"))
    sidecar_payload["inputs"]["tokenizer_sha256"] = hashlib.sha256(
        tokenizer.read_bytes()
    ).hexdigest()
    sidecar_payload["inputs"]["tokenizer_config_sha256"] = hashlib.sha256(
        tokenizer_config.read_bytes()
    ).hexdigest()
    sidecar_payload["inputs"]["model_config_sha256"] = hashlib.sha256(
        config.read_bytes()
    ).hexdigest()
    sidecar.write_text(json.dumps(sidecar_payload), encoding="utf-8")
    protocol = tmp_path / "protocol.json"
    protocol.write_text('{"protocol_id":"fixture"}', encoding="utf-8")
    distribution = tmp_path / "manifest.json"
    distribution.write_text(
        json.dumps(
            {
                "files": {"onnx/model_quantized.onnx": {"sha256": "d" * 64}},
                "sanitization": {"sha256": "d" * 64, "sourceSha256": raw_model_sha},
            }
        ),
        encoding="utf-8",
    )
    return dataset, cache, sidecar, config, protocol, distribution, tokenizer, tokenizer_config


def test_subset_is_deterministic_and_deduplicates_pairs(tmp_path: Path) -> None:
    dataset, _cache, _sidecar, config, _protocol, _distribution, _tokenizer, _tokenizer_config = (
        _write_fixture(tmp_path)
    )
    labels = ("OK", "a", "b")
    items = json.loads(dataset.read_text(encoding="utf-8"))["items"]
    first = [item["id"] for item in select_subset(items, labels, per_label=1)]
    second = [item["id"] for item in select_subset(list(reversed(items)), labels, per_label=1)]
    assert first == second
    assert len(first) == 2
    assert {json.loads(config.read_text())["id2label"][str(index)] for index in range(3)} == {
        "OK",
        "a",
        "b",
    }


def test_prepare_binds_cache_and_distribution_sanitization(tmp_path: Path) -> None:
    dataset, cache, sidecar, config, protocol, distribution, tokenizer, tokenizer_config = (
        _write_fixture(tmp_path)
    )
    output = tmp_path / "browser.json"
    result = prepare_browser_corpus(
        dataset,
        cache,
        sidecar,
        config,
        protocol,
        output,
        distribution_manifest=distribution,
        tokenizer_path=tokenizer,
        tokenizer_config_path=tokenizer_config,
        expected_revision="revision",
        expected_model_sha="a" * 64,
        per_label=1,
    )
    assert len(result["items"]) == 4
    assert result["provenance"]["raw_model_sha256"] == "a" * 64
    assert result["provenance"]["distribution_model_sha256"] == "d" * 64
    assert result["items"][0]["expected_logits"]
    assert result["items"][1]["errors"] == []
    assert result["items"][0]["expected_offset_unit"] == "unicode_codepoint"
    assert result["items"][0]["expected_input_ids"]
    assert result["items"][0]["expected_attention_mask"] == [1] * len(
        result["items"][0]["expected_input_ids"]
    )


def test_cache_dataset_binding_is_required(tmp_path: Path) -> None:
    dataset, cache, sidecar, config, protocol, _distribution, tokenizer, tokenizer_config = (
        _write_fixture(tmp_path)
    )
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    payload["inputs"]["dataset_sha256"] = "f" * 64
    sidecar.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="different dataset"):
        prepare_browser_corpus(
            dataset,
            cache,
            sidecar,
            config,
            protocol,
            tmp_path / "out.json",
            tokenizer_path=tokenizer,
            tokenizer_config_path=tokenizer_config,
            expected_revision="revision",
            expected_model_sha="a" * 64,
        )


def test_cache_shape_and_nonfinite_values_fail_closed(tmp_path: Path) -> None:
    dataset, cache, sidecar, config, protocol, _distribution, tokenizer, tokenizer_config = (
        _write_fixture(tmp_path)
    )
    with np.load(cache, allow_pickle=False) as arrays:
        logits = arrays["logits"]
        offsets = arrays["offsets"]
        bounds = arrays["bounds"]
    np.savez_compressed(cache, logits=logits, offsets=offsets, bounds=bounds[:-1])
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    payload["cache_sha256"] = hashlib.sha256(cache.read_bytes()).hexdigest()
    sidecar.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="bounds"):
        prepare_browser_corpus(
            dataset,
            cache,
            sidecar,
            config,
            protocol,
            tmp_path / "shape.json",
            distribution_manifest=_distribution,
            tokenizer_path=tokenizer,
            tokenizer_config_path=tokenizer_config,
            expected_revision="revision",
            expected_model_sha="a" * 64,
            per_label=1,
        )

    nonfinite_root = tmp_path / "nonfinite"
    nonfinite_root.mkdir()
    dataset2, cache2, sidecar2, config2, protocol2, distribution2, tokenizer2, tokenizer_config2 = (
        _write_fixture(nonfinite_root)
    )
    with np.load(cache2, allow_pickle=False) as arrays:
        logits2 = arrays["logits"].copy()
        offsets2 = arrays["offsets"]
        bounds2 = arrays["bounds"]
    logits2[0, 0] = np.nan
    np.savez_compressed(cache2, logits=logits2, offsets=offsets2, bounds=bounds2)
    payload2 = json.loads(sidecar2.read_text(encoding="utf-8"))
    payload2["cache_sha256"] = hashlib.sha256(cache2.read_bytes()).hexdigest()
    sidecar2.write_text(json.dumps(payload2), encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="nonfinite"):
        prepare_browser_corpus(
            dataset2,
            cache2,
            sidecar2,
            config2,
            protocol2,
            tmp_path / "nonfinite.json",
            distribution_manifest=distribution2,
            tokenizer_path=tokenizer2,
            tokenizer_config_path=tokenizer_config2,
            expected_revision="revision",
            expected_model_sha="a" * 64,
            per_label=1,
        )


def test_cache_provenance_and_numeric_contracts_fail_closed(tmp_path: Path) -> None:
    dataset, cache, sidecar, config, protocol, distribution, tokenizer, tokenizer_config = (
        _write_fixture(tmp_path)
    )

    missing_hash = json.loads(sidecar.read_text(encoding="utf-8"))
    del missing_hash["inputs"]["model_config_sha256"]
    sidecar.write_text(json.dumps(missing_hash), encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="model_config_sha256"):
        prepare_browser_corpus(
            dataset,
            cache,
            sidecar,
            config,
            protocol,
            tmp_path / "missing-hash.json",
            distribution_manifest=distribution,
            tokenizer_path=tokenizer,
            tokenizer_config_path=tokenizer_config,
            expected_revision="revision",
            expected_model_sha="a" * 64,
            per_label=1,
        )

    def rewrite_cache(
        root: Path, *, logits, offsets, bounds
    ) -> tuple[Path, Path, Path, Path, Path, Path, Path, Path]:
        paths = _write_fixture(root)
        cache_path, sidecar_path = paths[1], paths[2]
        np.savez_compressed(cache_path, logits=logits, offsets=offsets, bounds=bounds)
        payload = json.loads(sidecar_path.read_text(encoding="utf-8"))
        payload["cache_sha256"] = hashlib.sha256(cache_path.read_bytes()).hexdigest()
        sidecar_path.write_text(json.dumps(payload), encoding="utf-8")
        return paths

    with np.load(cache, allow_pickle=False) as arrays:
        logits = arrays["logits"]
        offsets = arrays["offsets"]
        bounds = arrays["bounds"]

    float_root = tmp_path / "float-bounds"
    float_root.mkdir()
    paths = rewrite_cache(
        float_root,
        logits=logits,
        offsets=offsets,
        bounds=bounds.astype(np.float64),
    )
    with pytest.raises(BrowserCorpusError, match="bounds must be integers"):
        prepare_browser_corpus(
            paths[0],
            paths[1],
            paths[2],
            paths[3],
            paths[4],
            float_root / "out.json",
            tokenizer_path=paths[6],
            tokenizer_config_path=paths[7],
            expected_revision="revision",
            expected_model_sha="a" * 64,
        )

    float_root = tmp_path / "float-offsets"
    float_root.mkdir()
    paths = rewrite_cache(
        float_root,
        logits=logits,
        offsets=offsets.astype(np.float64),
        bounds=bounds,
    )
    with pytest.raises(BrowserCorpusError, match="offsets must be integers"):
        prepare_browser_corpus(
            paths[0],
            paths[1],
            paths[2],
            paths[3],
            paths[4],
            float_root / "out.json",
            tokenizer_path=paths[6],
            tokenizer_config_path=paths[7],
            expected_revision="revision",
            expected_model_sha="a" * 64,
        )

    class_root = tmp_path / "class-count"
    class_root.mkdir()
    paths = rewrite_cache(
        class_root,
        logits=logits[:, :2],
        offsets=offsets,
        bounds=bounds,
    )
    with pytest.raises(BrowserCorpusError, match="tensor shapes"):
        prepare_browser_corpus(
            paths[0],
            paths[1],
            paths[2],
            paths[3],
            paths[4],
            class_root / "out.json",
            tokenizer_path=paths[6],
            tokenizer_config_path=paths[7],
            expected_revision="revision",
            expected_model_sha="a" * 64,
        )

    range_root = tmp_path / "offset-range"
    range_root.mkdir()
    invalid_offsets = offsets.copy()
    invalid_offsets[0] = (-1, 1)
    paths = rewrite_cache(
        range_root,
        logits=logits,
        offsets=invalid_offsets,
        bounds=bounds,
    )
    with pytest.raises(BrowserCorpusError, match="exceed source text"):
        prepare_browser_corpus(
            paths[0],
            paths[1],
            paths[2],
            paths[3],
            paths[4],
            range_root / "out.json",
            tokenizer_path=paths[6],
            tokenizer_config_path=paths[7],
            expected_revision="revision",
            expected_model_sha="a" * 64,
        )


def test_codepoint_to_utf16_handles_surrogate_pairs_and_combining_text() -> None:
    text = "A😀か\u0301"
    assert codepoint_to_utf16(text, 1, 2) == (1, 3)
    assert codepoint_to_utf16(text, 2, 4) == (3, 5)


def test_browser_runner_gates_tokenizer_mismatches_without_logging_token_values() -> None:
    source = (Path(__file__).parents[2] / "scripts" / "browser_corpus_parity.mjs").read_text(
        encoding="utf-8"
    )
    assert "tokenizer input IDs mismatch" in source
    assert "tokenizer attention mask mismatch" in source
    assert "input_id_mismatch_indexes" in source
    assert "expected_input_ids" in source
    assert "expected_attention_mask" in source
    assert "item.expected_input_ids[index]" in source
    assert "inputIds[index]" in source


def test_browser_runner_has_isolated_fp32_diagnostic_path() -> None:
    source = (Path(__file__).parents[2] / "scripts" / "browser_corpus_parity.mjs").read_text(
        encoding="utf-8"
    )
    assert '"fp32-diagnostic"' in source
    assert '"model-relative"' in source
    assert '"model-manifest"' in source
    assert "fp32_model_sha256" in source
    assert "fp32_external_data_sha256" in source
    assert "wasm_runtime_files" in source
    assert "jwtd-fp32-browser-diagnostic-v1" in source
    assert "externalData" in source
    assert "ort-wasm.*\\.(?:wasm|mjs)" in source
    assert "detectorSession" in source
    assert '"candidate-diagnostic"' in source
    assert '"model-kind"' in source
    assert "jwtd-candidate-browser-diagnostic-v1" in source
    assert "candidate_model_sha256" in source


class _FakeOrtSessionOptions:
    def __init__(self) -> None:
        self.intra_op_num_threads = None
        self.inter_op_num_threads = None
        self.graph_optimization_level = None


class _FakeOrtSession:
    class _Arg:
        def __init__(self, name: str) -> None:
            self.name = name

    def get_inputs(self):
        return [self._Arg("input_ids"), self._Arg("attention_mask")]

    def get_outputs(self):
        return [self._Arg("logits")]

    def __init__(self, _path, sess_options, providers) -> None:
        self.options = sess_options
        self.providers = providers

    def run(self, _names, feeds):
        assert feeds["input_ids"].shape == (1, 2)
        assert feeds["attention_mask"].shape == (1, 2)
        return [np.asarray([[[0.0, 1.1], [2.0, 0.0]]], dtype=np.float32)]


class _FakeOrt:
    __version__ = "fake-ort"
    GraphOptimizationLevel = type(
        "GraphOptimizationLevel",
        (),
        {"ORT_ENABLE_ALL": 99, "ORT_DISABLE_ALL": 0},
    )
    SessionOptions = _FakeOrtSessionOptions
    InferenceSession = _FakeOrtSession


class _FakeBadShapeSession(_FakeOrtSession):
    def run(self, _names, _feeds):
        return [np.asarray([[[0.0, 1.0]]], dtype=np.float32)]


class _FakeBadShapeOrt(_FakeOrt):
    InferenceSession = _FakeBadShapeSession


class _FakeFloat64Session(_FakeOrtSession):
    def run(self, _names, _feeds):
        return [np.asarray([[[0.0, 1.1], [2.0, 0.0]]], dtype=np.float64)]


class _FakeFloat64Ort(_FakeOrt):
    InferenceSession = _FakeFloat64Session


class _FakeInt32Session(_FakeOrtSession):
    def run(self, _names, _feeds):
        return [np.asarray([[[0, 1], [2, 0]]], dtype=np.int32)]


class _FakeInt32Ort(_FakeOrt):
    InferenceSession = _FakeInt32Session


def _write_native_fixture(tmp_path: Path) -> tuple[Path, Path, Path]:
    model = tmp_path / "model_quantized.onnx"
    model.write_bytes(b"fake-sanitized-model")
    model_sha = hashlib.sha256(model.read_bytes()).hexdigest()
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "revision": "revision",
                "files": {"onnx/model_quantized.onnx": {"sha256": model_sha}},
                "sanitization": {
                    "sha256": model_sha,
                    "sourceSha256": "a" * 64,
                },
            }
        ),
        encoding="utf-8",
    )
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "schema_version": "jwtd-browser-v1",
                "labels": ["OK", "substitution"],
                "provenance": {
                    "raw_model_sha256": "a" * 64,
                    "distribution_model_sha256": model_sha,
                    "model_revision": "revision",
                    "config_sha256": "b" * 64,
                    "tokenizer_file_sha256": "c" * 64,
                    "tokenizer_config_file_sha256": "d" * 64,
                },
                "items": [
                    {
                        "id": "sample:pre",
                        "text": "AB",
                        "errors": [],
                        "expected_logits": [[0.0, 1.0], [2.0, 0.0]],
                        "expected_offsets": [[0, 1], [1, 2]],
                        "expected_input_ids": [7, 8],
                        "expected_attention_mask": [1, 1],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return fixture, model, manifest


def test_native_diagnostic_uses_single_thread_cpu_and_reports_numeric_parity(
    tmp_path: Path,
) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    report = run_native_diagnostic(
        fixture,
        model,
        manifest,
        tmp_path / "report.json",
        ort_module=_FakeOrt,
    )
    assert report["status"] == "completed"
    assert report["runtime"]["intra_op_num_threads"] == 1
    assert report["runtime"]["inter_op_num_threads"] == 1
    assert report["runtime"]["execution_provider"] == "CPUExecutionProvider"
    assert report["rows"][0]["ordinary_max_abs_logit_delta"] == pytest.approx(0.1)
    assert report["rows"][0]["ordinary_token_argmax_agreement"] == 1.0
    assert report["rows"][0]["dtype"] == "float32"
    assert report["rows"][0]["dtype_valid"] is True
    assert "text" not in json.dumps(report)
    assert "expected_input_ids" not in json.dumps(report)


def test_native_diagnostic_can_disable_graph_optimizations(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    report = run_native_diagnostic(
        fixture,
        model,
        manifest,
        tmp_path / "disabled-report.json",
        graph_optimization="disabled",
        ort_module=_FakeOrt,
    )
    assert report["status"] == "completed"
    assert report["runtime"]["graph_optimization"] == "ORT_DISABLE_ALL"
    assert report["runtime"]["graph_optimization_level"] == 0


def test_native_diagnostic_rejects_unknown_graph_optimization(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    with pytest.raises(BrowserCorpusError, match="graph optimization"):
        run_native_diagnostic(
            fixture,
            model,
            manifest,
            tmp_path / "invalid-report.json",
            graph_optimization="unsupported",
            ort_module=_FakeOrt,
        )


def test_native_diagnostic_rejects_model_provenance_mismatch(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    payload["provenance"]["distribution_model_sha256"] = "b" * 64
    fixture.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="distribution model hash"):
        run_native_diagnostic(
            fixture,
            model,
            manifest,
            tmp_path / "report.json",
            ort_module=_FakeOrt,
        )


def test_native_diagnostic_marks_structural_runtime_failure(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    report = run_native_diagnostic(
        fixture,
        model,
        manifest,
        tmp_path / "report.json",
        ort_module=_FakeBadShapeOrt,
    )
    assert report["status"] == "failed"
    assert report["gate"]["passed"] is False
    assert report["rows"][0]["shape_valid"] is False


@pytest.mark.parametrize("ort_module", [_FakeFloat64Ort, _FakeInt32Ort])
def test_cpu_diagnostics_require_float32_output(tmp_path: Path, ort_module: Any) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    report = run_native_diagnostic(
        fixture,
        model,
        manifest,
        tmp_path / f"report-{ort_module.__name__}.json",
        ort_module=ort_module,
    )
    assert report["status"] == "failed"
    assert report["gate"]["passed"] is False
    assert report["rows"][0]["dtype_valid"] is False
    assert report["rows"][0]["dtype"] in {"float64", "int32"}

    fp32_model = model.with_name("model.onnx")
    model.replace(fp32_model)
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    manifest_payload["files"] = {
        "onnx/model.onnx": {"sha256": hashlib.sha256(fp32_model.read_bytes()).hexdigest()}
    }
    manifest.write_text(json.dumps(manifest_payload), encoding="utf-8")
    fp32_report = run_fp32_cpu_diagnostic(
        fixture,
        fp32_model,
        manifest,
        tmp_path / f"fp32-{ort_module.__name__}.json",
        tmp_path / f"fp32-report-{ort_module.__name__}.json",
        ort_module=ort_module,
    )
    assert fp32_report["status"] == "failed"
    assert fp32_report["rows"][0]["dtype_valid"] is False


def test_fp32_cpu_diagnostic_writes_paired_logits_fixture(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    fp32_model = model.with_name("model.onnx")
    model.replace(fp32_model)
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    manifest_payload["files"] = {
        "onnx/model.onnx": {"sha256": hashlib.sha256(fp32_model.read_bytes()).hexdigest()}
    }
    manifest.write_text(json.dumps(manifest_payload), encoding="utf-8")
    output_fixture = tmp_path / "fp32-fixture.json"
    report = run_fp32_cpu_diagnostic(
        fixture,
        fp32_model,
        manifest,
        output_fixture,
        tmp_path / "fp32-report.json",
        ort_module=_FakeOrt,
    )
    payload = json.loads(output_fixture.read_text(encoding="utf-8"))
    assert report["status"] == "completed"
    assert report["runtime"]["execution_provider"] == "CPUExecutionProvider"
    assert payload["schema_version"] == "jwtd-fp32-browser-v1"
    assert payload["items"][0]["expected_logits"][0][1] == pytest.approx(1.1)
    assert "text" not in json.dumps(report)
    assert "expected_input_ids" not in json.dumps(report)


def test_fp32_cpu_diagnostic_binds_external_data_hash_and_manifest(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    fp32_model = model.with_name("model.onnx")
    model.replace(fp32_model)
    external_data = fp32_model.with_name("model.onnx.data")
    external_data.write_bytes(b"external-weight-bytes")
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    manifest_payload["files"] = {
        "onnx/model.onnx": {"sha256": hashlib.sha256(fp32_model.read_bytes()).hexdigest()},
        "onnx/model.onnx.data": {"sha256": hashlib.sha256(external_data.read_bytes()).hexdigest()},
    }
    manifest.write_text(json.dumps(manifest_payload), encoding="utf-8")
    fixture_payload = json.loads(fixture.read_text(encoding="utf-8"))
    fixture_payload["provenance"]["fp32_external_data_sha256"] = hashlib.sha256(
        external_data.read_bytes()
    ).hexdigest()
    fixture.write_text(json.dumps(fixture_payload), encoding="utf-8")
    output_fixture = tmp_path / "fp32-fixture.json"
    report = run_fp32_cpu_diagnostic(
        fixture,
        fp32_model,
        manifest,
        output_fixture,
        tmp_path / "fp32-report.json",
        ort_module=_FakeOrt,
    )
    assert report["status"] == "completed"
    payload = json.loads(output_fixture.read_text(encoding="utf-8"))
    assert (
        payload["provenance"]["fp32_external_data_sha256"]
        == hashlib.sha256(external_data.read_bytes()).hexdigest()
    )

    external_data.write_bytes(b"tampered")
    with pytest.raises(BrowserCorpusError, match="external data provenance"):
        run_fp32_cpu_diagnostic(
            fixture,
            fp32_model,
            manifest,
            tmp_path / "tampered-fixture.json",
            tmp_path / "tampered-report.json",
            ort_module=_FakeOrt,
        )
    external_data.unlink()
    fixture_payload["provenance"].pop("fp32_external_data_sha256")
    fixture.write_text(json.dumps(fixture_payload), encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="external data provenance"):
        run_fp32_cpu_diagnostic(
            fixture,
            fp32_model,
            manifest,
            tmp_path / "missing-fixture.json",
            tmp_path / "missing-report.json",
            ort_module=_FakeOrt,
        )


def test_fp32_cpu_diagnostic_marks_malformed_output_failed(tmp_path: Path) -> None:
    fixture, model, manifest = _write_native_fixture(tmp_path)
    fp32_model = model.with_name("model.onnx")
    model.replace(fp32_model)
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    manifest_payload["files"] = {
        "onnx/model.onnx": {"sha256": hashlib.sha256(fp32_model.read_bytes()).hexdigest()}
    }
    manifest.write_text(json.dumps(manifest_payload), encoding="utf-8")
    report = run_fp32_cpu_diagnostic(
        fixture,
        fp32_model,
        manifest,
        tmp_path / "fp32-fixture.json",
        tmp_path / "fp32-report.json",
        ort_module=_FakeBadShapeOrt,
    )
    assert report["status"] == "failed"
    assert report["gate"]["passed"] is False
    assert report["rows"][0]["shape_valid"] is False


def test_candidate_cpu_diagnostic_uses_generic_provenance_and_schema(tmp_path: Path) -> None:
    fixture, old_model, old_manifest = _write_native_fixture(tmp_path)
    candidate_model = old_model.with_name("model_weight_only.onnx")
    old_model.replace(candidate_model)
    candidate_sha = hashlib.sha256(candidate_model.read_bytes()).hexdigest()
    manifest = {
        "revision": "revision",
        "files": {
            "onnx/model_weight_only.onnx": {"sha256": candidate_sha},
            "config.json": {"sha256": "b" * 64},
            "tokenizer.json": {"sha256": "c" * 64},
            "tokenizer_config.json": {"sha256": "d" * 64},
        },
    }
    old_manifest.write_text(json.dumps(manifest), encoding="utf-8")
    output_fixture = tmp_path / "candidate-fixture.json"
    report = run_candidate_cpu_diagnostic(
        fixture,
        candidate_model,
        old_manifest,
        output_fixture,
        tmp_path / "candidate-report.json",
        model_kind="weight-only-qdq",
        ort_module=_FakeOrt,
    )
    payload = json.loads(output_fixture.read_text(encoding="utf-8"))
    assert report["schema_version"] == "jwtd-candidate-cpu-diagnostic-v1"
    assert report["model_kind"] == "weight-only-qdq"
    assert report["candidate_model_sha256"] == candidate_sha
    assert report["runtime"]["graph_optimization"] == "ORT_ENABLE_ALL"
    assert report["runtime"]["graph_optimization_level"] == 99
    assert payload["schema_version"] == "jwtd-candidate-browser-v1"
    assert payload["provenance"]["model_kind"] == "weight-only-qdq"
    assert payload["provenance"]["candidate_graph_optimization"] == "ORT_ENABLE_ALL"
    assert payload["provenance"]["candidate_graph_optimization_level"] == 99
    assert "fp32_model_sha256" not in payload["provenance"]
    assert "text" not in json.dumps(report)

    disabled_fixture = tmp_path / "candidate-disabled-fixture.json"
    disabled_report_path = tmp_path / "candidate-disabled-report.json"
    disabled_report = run_candidate_cpu_diagnostic(
        fixture,
        candidate_model,
        old_manifest,
        disabled_fixture,
        disabled_report_path,
        model_kind="weight-only-qdq",
        graph_optimization="disabled",
        ort_module=_FakeOrt,
    )
    disabled_payload = json.loads(disabled_fixture.read_text(encoding="utf-8"))
    assert disabled_report["runtime"]["graph_optimization"] == "ORT_DISABLE_ALL"
    assert disabled_report["runtime"]["graph_optimization_level"] == 0
    assert disabled_payload["provenance"]["candidate_graph_optimization"] == "ORT_DISABLE_ALL"
    assert disabled_payload["provenance"]["candidate_graph_optimization_level"] == 0


def test_candidate_cpu_diagnostic_rejects_manifest_model_hash_mismatch(tmp_path: Path) -> None:
    fixture, old_model, old_manifest = _write_native_fixture(tmp_path)
    candidate_model = old_model.with_name("model_weight_only.onnx")
    old_model.replace(candidate_model)
    old_manifest.write_text(
        json.dumps(
            {
                "revision": "revision",
                "artifacts": {
                    "model_weight_only.onnx": {"sha256": "e" * 64},
                    "config.json": {"sha256": "b" * 64},
                    "tokenizer.json": {"sha256": "c" * 64},
                    "tokenizer_config.json": {"sha256": "d" * 64},
                },
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(BrowserCorpusError, match="candidate model hash"):
        run_candidate_cpu_diagnostic(
            fixture,
            candidate_model,
            old_manifest,
            tmp_path / "candidate-fixture.json",
            tmp_path / "candidate-report.json",
            model_kind="weight-only-qdq",
            ort_module=_FakeOrt,
        )


def test_candidate_cpu_diagnostic_refuses_input_or_existing_output_paths(
    tmp_path: Path,
) -> None:
    fixture, old_model, old_manifest = _write_native_fixture(tmp_path)
    candidate_model = old_model.with_name("model_weight_only.onnx")
    old_model.replace(candidate_model)
    candidate_sha = hashlib.sha256(candidate_model.read_bytes()).hexdigest()
    old_manifest.write_text(
        json.dumps(
            {
                "revision": "revision",
                "files": {
                    "onnx/model_weight_only.onnx": {"sha256": candidate_sha},
                    "config.json": {"sha256": "b" * 64},
                    "tokenizer.json": {"sha256": "c" * 64},
                    "tokenizer_config.json": {"sha256": "d" * 64},
                },
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(BrowserCorpusError, match="output path"):
        run_candidate_cpu_diagnostic(
            fixture,
            candidate_model,
            old_manifest,
            fixture,
            tmp_path / "new-report.json",
            model_kind="weight-only-qdq",
            ort_module=_FakeOrt,
        )
    for source_path, name in ((candidate_model, "model"), (old_manifest, "manifest")):
        with pytest.raises(BrowserCorpusError, match="output path"):
            run_candidate_cpu_diagnostic(
                fixture,
                candidate_model,
                old_manifest,
                source_path,
                tmp_path / f"{name}-report.json",
                model_kind="weight-only-qdq",
                ort_module=_FakeOrt,
            )
    existing_report = tmp_path / "existing-report.json"
    existing_report.write_text("preserve", encoding="utf-8")
    with pytest.raises(BrowserCorpusError, match="already exists"):
        run_candidate_cpu_diagnostic(
            fixture,
            candidate_model,
            old_manifest,
            tmp_path / "new-fixture.json",
            existing_report,
            model_kind="weight-only-qdq",
            ort_module=_FakeOrt,
        )


def test_candidate_cpu_diagnostic_rejects_unknown_or_missing_graph_optimization(
    tmp_path: Path,
) -> None:
    fixture, old_model, old_manifest = _write_native_fixture(tmp_path)
    candidate_model = old_model.with_name("model_weight_only.onnx")
    old_model.replace(candidate_model)
    candidate_sha = hashlib.sha256(candidate_model.read_bytes()).hexdigest()
    old_manifest.write_text(
        json.dumps(
            {
                "revision": "revision",
                "files": {
                    "onnx/model_weight_only.onnx": {"sha256": candidate_sha},
                    "config.json": {"sha256": "b" * 64},
                    "tokenizer.json": {"sha256": "c" * 64},
                    "tokenizer_config.json": {"sha256": "d" * 64},
                },
            }
        ),
        encoding="utf-8",
    )
    for optimization, output_name in (
        ("unsupported", "unknown"),
        (None, "missing"),
    ):
        with pytest.raises(BrowserCorpusError, match="graph optimization"):
            run_candidate_cpu_diagnostic(
                fixture,
                candidate_model,
                old_manifest,
                tmp_path / f"{output_name}-fixture.json",
                tmp_path / f"{output_name}-report.json",
                model_kind="weight-only-qdq",
                graph_optimization=optimization,
                ort_module=_FakeOrt,
            )
