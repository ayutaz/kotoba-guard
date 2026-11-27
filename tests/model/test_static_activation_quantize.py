import hashlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from scripts import static_activation_quantize as static
from scripts.static_activation_quantize import (
    StaticActivationError,
    collect_activation_ranges,
    compute_quantization_params,
    convert_static_activations,
    select_calibration_rows,
)


def _toy_model() -> onnx.ModelProto:
    nodes = [
        helper.make_node(
            "DynamicQuantizeLinear",
            ["x"],
            ["q", "activation_scale", "activation_zero"],
            name="dql",
        ),
        helper.make_node(
            "MatMulInteger",
            ["q", "weight", "activation_zero", "weight_zero"],
            ["integer"],
            name="mmi",
        ),
        helper.make_node("Cast", ["integer"], ["cast"], name="cast", to=TensorProto.FLOAT),
        helper.make_node(
            "Mul", ["activation_scale", "weight_scale"], ["combined"], name="scale_mul"
        ),
        helper.make_node("Mul", ["cast", "combined"], ["logits"], name="output_mul"),
    ]
    initializers = [
        numpy_helper.from_array(np.ones((2, 2), dtype=np.uint8), "weight"),
        numpy_helper.from_array(np.array([0.25, 0.25], dtype=np.float32), "weight_scale"),
        numpy_helper.from_array(np.zeros(2, dtype=np.uint8), "weight_zero"),
    ]
    graph = helper.make_graph(
        nodes,
        "static_fixture",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 2])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2])],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    model.ir_version = 10
    return model


def _ort_calibration_model() -> onnx.ModelProto:
    nodes = [
        helper.make_node("Gather", ["table", "input_ids"], ["gather"], axis=0, name="gather"),
        helper.make_node(
            "Cast", ["attention_mask"], ["mask_float"], name="mask_cast", to=TensorProto.FLOAT
        ),
        helper.make_node("Add", ["gather", "mask_float"], ["x"], name="activation"),
        helper.make_node(
            "DynamicQuantizeLinear", ["x"], ["q", "activation_scale", "activation_zero"], name="dql"
        ),
        helper.make_node(
            "MatMulInteger",
            ["q", "weight", "activation_zero", "weight_zero"],
            ["integer"],
            name="mmi",
        ),
        helper.make_node("Cast", ["integer"], ["cast"], name="cast", to=TensorProto.FLOAT),
        helper.make_node(
            "Mul", ["activation_scale", "weight_scale"], ["combined"], name="scale_mul"
        ),
        helper.make_node("Mul", ["cast", "combined"], ["logits"], name="output_mul"),
    ]
    initializers = [
        numpy_helper.from_array(np.arange(8, dtype=np.float32).reshape(4, 2), "table"),
        numpy_helper.from_array(np.ones((2, 2), dtype=np.uint8), "weight"),
        numpy_helper.from_array(np.asarray(0.25, dtype=np.float32), "weight_scale"),
        numpy_helper.from_array(np.asarray(0, dtype=np.uint8), "weight_zero"),
    ]
    graph = helper.make_graph(
        nodes,
        "ort_static_fixture",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, 2]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, 2]),
        ],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2, 2])],
        initializers,
        value_info=[helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 2, 2])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    model.ir_version = 10
    return model


def _write_dataset(path: Path, *, text: str = "短い文") -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": "jwtd-v1",
                "metadata": {"source_split": "train"},
                "items": [
                    {"id": "row-a", "pair_id": "pair-a", "text": text, "source_split": "train"},
                    {"id": "row-b", "pair_id": "pair-b", "text": "別の文", "source_split": "train"},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


class _Encoding:
    ids = [1, 2]


class _Tokenizer:
    def enable_truncation(self, **kwargs):
        pass

    def no_padding(self):
        pass

    def encode(self, text, add_special_tokens=True):
        return _Encoding()


def test_calibration_rows_reject_frozen_overlap_without_reselection(tmp_path: Path) -> None:
    dataset = tmp_path / "development.json"
    fixture = tmp_path / "frozen.json"
    _write_dataset(dataset)
    fixture.write_text(
        json.dumps(
            {
                "items": [
                    {"id": "row-a", "pair_id": "pair-a", "text": "別表記"},
                    {"id": "row-b", "pair_id": "pair-b", "text": "別の文"},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    with pytest.raises(StaticActivationError, match="frozen"):
        select_calibration_rows(
            dataset, _Tokenizer(), fixture_path=fixture, count=1, max_tokens=128
        )


@pytest.mark.parametrize(
    ("minimum", "maximum"),
    [(0.0, 0.0), (-3.0, -1.0), (1.0, 4.0), (2.0, 2.0)],
)
def test_minmax_handles_valid_degenerate_and_signed_ranges(minimum: float, maximum: float) -> None:
    scale, zero_point = compute_quantization_params(minimum, maximum)
    assert np.isfinite(scale) and scale > 0
    assert 0 <= zero_point <= 255


@pytest.mark.parametrize(
    ("minimum", "maximum"),
    [(float("nan"), 1.0), (0.0, float("inf")), (2.0, 1.0)],
)
def test_minmax_rejects_nonfinite_or_empty_ranges(minimum: float, maximum: float) -> None:
    with pytest.raises(StaticActivationError):
        compute_quantization_params(minimum, maximum)


def test_conversion_replaces_dql_and_preserves_mmi(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.onnx"
    output = tmp_path / "candidate.onnx"
    manifest = tmp_path / "manifest.json"
    onnx.save(_toy_model(), source)
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    result = convert_static_activations(
        source,
        output,
        manifest,
        {"x": {"minimum": -1.0, "maximum": 2.0}},
        expected_source_sha=hashlib.sha256(source.read_bytes()).hexdigest(),
        selected_rows_summary={"selected_count": 1, "selected_ids_sha256": "b" * 64},
        expected_path_count=1,
    )
    model = onnx.load(str(output), load_external_data=False)
    assert result["graph_counts"]["dynamic_quantize_linear_after"] == 0
    assert result["graph_counts"]["matmul_integer_after"] == 1
    assert [node.op_type for node in model.graph.node].count("QuantizeLinear") == 1
    assert len([item for item in model.graph.initializer if item.name == "activation_scale"]) == 1
    assert (
        json.loads(manifest.read_text(encoding="utf-8"))["output_model_sha256"]
        == hashlib.sha256(output.read_bytes()).hexdigest()
    )


def test_conversion_rejects_source_and_output_collisions(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.onnx"
    onnx.save(_toy_model(), source)
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    with pytest.raises(StaticActivationError, match="output"):
        convert_static_activations(
            source,
            source,
            tmp_path / "manifest.json",
            {"x": {"minimum": 0.0, "maximum": 1.0}},
            expected_source_sha=sha,
            expected_path_count=1,
        )


def test_conversion_rejects_external_data_and_wrong_provenance(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.onnx"
    onnx.save(_toy_model(), source)
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    with pytest.raises(StaticActivationError, match="source SHA"):
        convert_static_activations(
            source,
            tmp_path / "candidate.onnx",
            tmp_path / "manifest.json",
            {"x": {"minimum": 0.0, "maximum": 1.0}},
            expected_source_sha="0" * 64,
            expected_path_count=1,
        )


def test_source_graph_rejects_duplicate_node_names(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.onnx"
    model = _toy_model()
    model.graph.node[1].name = model.graph.node[0].name
    onnx.save(model, source)
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    with pytest.raises(StaticActivationError, match="unique"):
        convert_static_activations(
            source,
            tmp_path / "candidate.onnx",
            tmp_path / "manifest.json",
            {"x": {"minimum": 0.0, "maximum": 1.0}},
            expected_source_sha=hashlib.sha256(source.read_bytes()).hexdigest(),
            expected_path_count=1,
        )


def test_frozen_fixture_requires_identity_fields(tmp_path: Path) -> None:
    dataset = tmp_path / "development.json"
    fixture = tmp_path / "frozen.json"
    _write_dataset(dataset)
    fixture.write_text(json.dumps({"items": [{"id": "only-id"}]}), encoding="utf-8")
    with pytest.raises(StaticActivationError, match="id, pair_id, or text"):
        select_calibration_rows(
            dataset, _Tokenizer(), fixture_path=fixture, count=1, max_tokens=128
        )


def test_real_ort_collects_and_converts_small_fixture(tmp_path: Path, monkeypatch) -> None:
    import onnxruntime as ort

    source = tmp_path / "source.onnx"
    output = tmp_path / "candidate.onnx"
    manifest = tmp_path / "manifest.json"
    onnx.save(_ort_calibration_model(), source)
    rows = [
        {
            "id": "a",
            "input_ids": np.asarray([[0, 1]], dtype=np.int64),
            "attention_mask": np.asarray([[1, 1]], dtype=np.int64),
        },
        {
            "id": "b",
            "input_ids": np.asarray([[2, 3]], dtype=np.int64),
            "attention_mask": np.asarray([[1, 1]], dtype=np.int64),
        },
    ]
    ranges, runtime = collect_activation_ranges(source, rows, expected_path_count=1)
    assert runtime["graph_optimization"] == "ORT_DISABLE_ALL"
    assert set(ranges) == {"x"}
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    manifest_data = convert_static_activations(
        source,
        output,
        manifest,
        ranges,
        expected_source_sha=hashlib.sha256(source.read_bytes()).hexdigest(),
        expected_path_count=1,
    )
    assert manifest_data["invariants"]["non_dql_nodes_unchanged"] is True
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    actual = session.run(
        None, {"input_ids": rows[0]["input_ids"], "attention_mask": rows[0]["attention_mask"]}
    )[0]
    assert actual.dtype == np.float32
    assert np.isfinite(actual).all()


def test_calibration_truncates_with_tokenizer_special_tokens_preserved(tmp_path: Path) -> None:
    dataset = tmp_path / "development.json"
    _write_dataset(dataset)

    class LongTokenizer(_Tokenizer):
        limit = None

        def enable_truncation(self, max_length, **kwargs):
            self.limit = max_length

        def encode(self, text, add_special_tokens=True):
            size = self.limit or 200
            return SimpleNamespace(ids=[101, *([7] * (size - 2)), 102])

    rows, _ = select_calibration_rows(dataset, LongTokenizer(), count=2, max_tokens=128)
    assert all(row["input_ids"].shape == (1, 128) for row in rows)
    assert all(row["input_ids"][0, -1] == 102 for row in rows)


def test_calibration_rejects_non_train_item_even_in_train_dataset(tmp_path: Path) -> None:
    dataset = tmp_path / "development.json"
    _write_dataset(dataset)
    payload = json.loads(dataset.read_text(encoding="utf-8"))
    payload["items"][0]["source_split"] = "test"
    dataset.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(StaticActivationError, match="train"):
        select_calibration_rows(dataset, _Tokenizer(), count=1)


def test_manifest_cannot_be_written_inside_canonical_models(tmp_path: Path) -> None:
    with pytest.raises(StaticActivationError, match="canonical"):
        static._refuse_output(
            tmp_path / "source.onnx",
            tmp_path / "candidate.onnx",
            static.PROJECT_ROOT / "models/upstream/unwritten-static-manifest.json",
        )


def test_capture_never_overwrites_existing_scratch_graph(tmp_path: Path) -> None:
    source = tmp_path / "source.onnx"
    onnx.save(_ort_calibration_model(), source)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    previous = scratch / "instrumented.onnx"
    previous.write_bytes(b"preserve previous capture")
    with pytest.raises(StaticActivationError, match="exist"):
        collect_activation_ranges(
            source,
            [{"input_ids": None, "attention_mask": None}],
            work_dir=scratch,
            expected_path_count=1,
            session_factory=lambda _: pytest.fail("must reject before creating session"),
        )
    assert previous.read_bytes() == b"preserve previous capture"


def test_capture_attempts_all_cleanup_after_release_failure(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.onnx"
    onnx.save(_ort_calibration_model(), source)
    released = []
    cleaned = []
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(
        static.tempfile,
        "TemporaryDirectory",
        lambda **_: SimpleNamespace(name=str(scratch), cleanup=lambda: cleaned.append(True)),
    )

    class Session:
        def __init__(self, augmented):
            self.augmented = augmented

        def get_outputs(self):
            names = ["logits", "x"] if self.augmented else ["logits"]
            return [SimpleNamespace(name=n, type="tensor(float)", shape=[1, 2, 2]) for n in names]

        def run(self, names, feeds):
            return [np.ones((1, 2, 2), dtype=np.float32) for _ in names]

        def release(self):
            released.append(self.augmented)
            if self.augmented:
                raise RuntimeError("release failed")

    with pytest.raises(ExceptionGroup, match="cleanup"):
        collect_activation_ranges(
            source,
            [{"input_ids": None, "attention_mask": None}],
            expected_path_count=1,
            session_factory=lambda p: Session(p.name == "instrumented.onnx"),
        )
    assert released == [True, False]
    assert cleaned == [True]


@pytest.mark.parametrize("corruption", ["shared_quantized", "disconnected_scale"])
def test_conversion_rejects_ambiguous_integer_path(tmp_path: Path, monkeypatch, corruption) -> None:
    model = _toy_model()
    if corruption == "shared_quantized":
        model.graph.node.append(helper.make_node("Identity", ["q"], ["extra"], name="extra"))
    else:
        model.graph.node[-1].input[1] = "weight_scale"
    source = tmp_path / "source.onnx"
    onnx.save(model, source)
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    with pytest.raises(StaticActivationError, match="binding|consumer"):
        convert_static_activations(
            source,
            tmp_path / "candidate.onnx",
            tmp_path / "manifest.json",
            {"x": {"minimum": -1.0, "maximum": 1.0}},
            expected_source_sha=hashlib.sha256(source.read_bytes()).hexdigest(),
            expected_path_count=1,
        )
    assert not (tmp_path / "candidate.onnx").exists()


def _preflight_fixture(tmp_path, monkeypatch):
    monkeypatch.setattr(
        static,
        "_validate_source_checkout",
        lambda commit: {"commit": commit, "clean": True},
        raising=False,
    )
    paths = {
        name: tmp_path / name
        for name in (
            "model",
            "dataset",
            "tokenizer",
            "dataset_manifest",
            "frozen_fixture",
            "protocol",
        )
    }
    for path in paths.values():
        path.write_text("{}", encoding="utf-8")
    config = paths["tokenizer"].with_name("tokenizer_config.json")
    config.write_text("{}", encoding="utf-8")
    paths["protocol"].write_text(
        json.dumps({"model_revision": static.MODEL_REVISION}), encoding="utf-8"
    )

    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    paths["dataset_manifest"].write_text(
        json.dumps({"outputs": {"development.json": {"sha256": digest(paths["dataset"])}}}),
        encoding="utf-8",
    )
    for name, path in {**paths, "tokenizer_config": config}.items():
        constant = "FIXTURE" if name == "frozen_fixture" else name.upper()
        monkeypatch.setattr(static, f"REGISTERED_{constant}_SHA256", digest(path))
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)
    args = SimpleNamespace(
        **paths,
        source_sha256=digest(paths["model"]),
        count=64,
        max_tokens=128,
        output=tmp_path / "candidate.onnx",
    )
    return args, config


def test_preflight_binds_all_inputs_before_any_output(tmp_path: Path, monkeypatch) -> None:
    args, _ = _preflight_fixture(tmp_path, monkeypatch)
    result = static._validate_cli_inputs(args, tmp_path / "manifest.json")
    assert result["source_commit"] == "a" * 40
    assert all(len(value) == 64 for key, value in result.items() if key.endswith("sha256"))
    assert not args.output.exists()


@pytest.mark.parametrize(
    "tampered",
    [
        "model",
        "dataset",
        "dataset_manifest",
        "frozen_fixture",
        "protocol",
        "tokenizer",
        "tokenizer_config",
    ],
)
def test_preflight_rejects_each_modified_input(tmp_path: Path, monkeypatch, tampered) -> None:
    args, config = _preflight_fixture(tmp_path, monkeypatch)
    path = config if tampered == "tokenizer_config" else getattr(args, tampered)
    with path.open("ab") as stream:
        stream.write(b"\n")
    with pytest.raises(StaticActivationError, match="SHA-256"):
        static._validate_cli_inputs(args, tmp_path / "manifest.json")
    assert not args.output.exists()


@pytest.mark.parametrize("setting", ["commit", "count", "max_tokens"])
def test_preflight_rejects_unregistered_conditions(tmp_path: Path, monkeypatch, setting) -> None:
    args, _ = _preflight_fixture(tmp_path, monkeypatch)
    if setting == "commit":
        monkeypatch.delenv("SOURCE_COMMIT")
    else:
        setattr(args, setting, 63)
    with pytest.raises(StaticActivationError):
        static._validate_cli_inputs(args, tmp_path / "manifest.json")
    assert not args.output.exists()


def test_direct_script_help_resolves_imports_without_model() -> None:
    result = subprocess.run(
        [sys.executable, str(Path(static.__file__)), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--frozen-fixture" in result.stdout


@pytest.mark.parametrize("head,status", [("b" * 40, ""), ("a" * 40, " M source.py")])
def test_checkout_must_match_source_commit_and_be_clean(monkeypatch, head, status) -> None:
    replies = iter([head, status])
    monkeypatch.setattr(
        static,
        "subprocess",
        SimpleNamespace(run=lambda *a, **k: SimpleNamespace(stdout=next(replies))),
        raising=False,
    )
    with pytest.raises(StaticActivationError, match="source|clean"):
        static._validate_source_checkout("a" * 40)


@pytest.mark.parametrize("fault", ["missing", "extra", "dtype", "shape", "feed"])
def test_runtime_input_metadata_and_feeds_must_agree(fault) -> None:
    fields = [
        SimpleNamespace(name=n, type="tensor(int64)", shape=[1, 2])
        for n in ("input_ids", "attention_mask")
    ]
    feeds = {n: np.ones((1, 2), dtype=np.int64) for n in ("input_ids", "attention_mask")}
    if fault == "missing":
        fields.pop()
    elif fault == "extra":
        fields.append(SimpleNamespace(name="required_extra", type="tensor(int64)", shape=[1, 2]))
    elif fault == "dtype":
        fields[0].type = "tensor(int32)"
    elif fault == "shape":
        fields[0].shape = [2, 2]
    else:
        feeds["attention_mask"] = np.ones((1, 2), dtype=np.float32)
    with pytest.raises(StaticActivationError, match="input"):
        static._validate_session_inputs(SimpleNamespace(get_inputs=lambda: fields), feeds)
