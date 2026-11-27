import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from scripts.hybrid_quantize import (
    SELECTED_PATH_INDICES,
    HybridQuantizationError,
    convert_hybrid_model,
    rewrite_hybrid_graph,
)


@pytest.fixture(autouse=True)
def fixed_source_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOURCE_COMMIT", "a" * 40)


def _toy_model() -> onnx.ModelProto:
    nodes: list[onnx.NodeProto] = []
    initializers: list[onnx.TensorProto] = []
    for index in range(42):
        activation_name = "x"
        if index in SELECTED_PATH_INDICES:
            ordinal = (index - 1) // 4
            activation_name = f"view_{3 * ordinal + 2}"
        q = f"q_{index}"
        scale = f"activation_scale_{index}"
        zero = f"activation_zero_{index}"
        weight = f"weight_{index}"
        weight_scale = f"weight_scale_{index}"
        weight_zero = f"weight_zero_{index}"
        integer = f"integer_{index}"
        cast = f"cast_{index}"
        combined = f"combined_{index}"
        output = f"linear_{index}"
        nodes.extend(
            [
                helper.make_node(
                    "DynamicQuantizeLinear",
                    [activation_name],
                    [q, scale, zero],
                    name=f"quantize_{index}",
                ),
                helper.make_node(
                    "MatMulInteger",
                    [q, weight, zero, weight_zero],
                    [integer],
                    name=f"node_linear_{index}_quant",
                ),
                helper.make_node(
                    "Cast",
                    [integer],
                    [cast],
                    name=f"cast_{index}",
                    to=TensorProto.FLOAT,
                ),
                helper.make_node(
                    "Mul",
                    [scale, weight_scale],
                    [combined],
                    name=f"weight_scale_{index}_mul",
                ),
                helper.make_node(
                    "Mul",
                    [cast, combined],
                    [output],
                    name=f"output_scale_{index}_mul",
                ),
            ]
        )
        initializers.extend(
            [
                numpy_helper.from_array(np.full((2, 2), index + 1, dtype=np.uint8), weight),
                numpy_helper.from_array(np.full(2, 0.25, dtype=np.float32), weight_scale),
                numpy_helper.from_array(np.zeros(2, dtype=np.uint8), weight_zero),
            ]
        )
    graph = helper.make_graph(
        nodes,
        "hybrid_fixture",
        [
            helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 2]),
            *[
                helper.make_tensor_value_info(f"view_{3 * ordinal + 2}", TensorProto.FLOAT, [1, 2])
                for ordinal in range(10)
            ],
        ],
        [helper.make_tensor_value_info("linear_37", TensorProto.FLOAT, [1, 2])],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    model.ir_version = 10
    return model


def _write_source(tmp_path: Path) -> Path:
    path = tmp_path / "source.onnx"
    onnx.save(_toy_model(), path)
    return path


def test_selected_attention_paths_are_exactly_ten() -> None:
    assert SELECTED_PATH_INDICES == (1, 5, 9, 13, 17, 21, 25, 29, 33, 37)


def test_rewrite_replaces_selected_paths_and_keeps_other_mmi() -> None:
    model, metadata = rewrite_hybrid_graph(_toy_model())
    assert metadata["selected_path_count"] == 10
    assert metadata["remaining_matmul_integer_count"] == 32
    assert sum(node.op_type == "MatMulInteger" for node in model.graph.node) == 32
    assert sum(node.op_type == "DequantizeLinear" for node in model.graph.node) == 10
    assert sum(node.op_type == "MatMul" for node in model.graph.node) == 10
    assert len(metadata["selected_paths"]) == 10
    assert metadata["selected_paths"][0]["index"] == 1
    assert metadata["selected_paths"][0]["dql_source"] == "view_2"
    assert metadata["selected_paths"][-1]["output"] == "linear_37"
    assert len(metadata["unchanged_matmul_integer_node_names"]) == 32
    assert metadata["provenance"]["expected_revision"]
    assert metadata["provenance"]["tool_versions"]["onnx"]
    assert metadata["graph_invariance"]["nonselected_matmul_integer"] is True
    assert metadata["graph_invariance"]["nonremoved_nodes"] is True
    assert metadata["graph_invariance"]["initializers"] is True
    assert metadata["embedding_binding"]["status"] == "unchanged"
    assert (
        metadata["graph_invariance"]["initializer_fingerprint_before"]
        == metadata["graph_invariance"]["initializer_fingerprint_after"]
    )
    assert (
        metadata["embedding_binding"]["initializer_fingerprint_before"]
        == metadata["embedding_binding"]["initializer_fingerprint_after"]
    )
    assert all(
        not (
            node.op_type == "DynamicQuantizeLinear"
            and node.name.endswith(tuple(f"_{i}" for i in SELECTED_PATH_INDICES))
        )
        for node in model.graph.node
    )


def test_rewrite_matches_explicit_float_dequantized_matmul(tmp_path: Path) -> None:
    import onnxruntime as ort

    model, _ = rewrite_hybrid_graph(_toy_model())
    candidate = tmp_path / "candidate.onnx"
    onnx.save(model, candidate)
    session = ort.InferenceSession(str(candidate), providers=["CPUExecutionProvider"])
    values = np.asarray([[1.0, 2.0]], dtype=np.float32)
    actual = session.run(
        None,
        {"view_29": values, "x": values}
        | {f"view_{3 * ordinal + 2}": values for ordinal in range(9)},
    )[0]
    quantized = np.full((2, 2), 38.0, dtype=np.float32)
    expected = values @ (quantized * 0.25)
    np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-5)


def test_rewrite_rejects_misconnected_selected_path() -> None:
    model = _toy_model()
    selected_mmi = next(node for node in model.graph.node if node.name == "node_linear_1_quant")
    selected_mmi.input[0] = "unrelated_q"
    with pytest.raises(HybridQuantizationError, match="selected path"):
        rewrite_hybrid_graph(model)


def test_rewrite_rejects_duplicate_node_names() -> None:
    model = _toy_model()
    model.graph.node[1].name = model.graph.node[0].name
    with pytest.raises(HybridQuantizationError, match="unique"):
        rewrite_hybrid_graph(model)


def test_conversion_writes_manifest_and_refuses_collisions(tmp_path: Path) -> None:
    source = _write_source(tmp_path)
    output = tmp_path / "candidate" / "hybrid.onnx"
    manifest = output.with_name("manifest.json")
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    result = convert_hybrid_model(
        source,
        output,
        manifest,
        expected_source_sha=source_sha,
    )
    assert result["selected_path_count"] == 10
    saved = json.loads(manifest.read_text(encoding="utf-8"))
    assert saved["source_model_sha256"] == source_sha
    assert saved["provenance"]["source_sha256"] == source_sha
    assert saved["provenance"]["source_commit"] == "a" * 40
    assert saved["remaining_matmul_integer_count"] == 32
    assert saved["output_model_sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    with pytest.raises(HybridQuantizationError, match="already exists"):
        convert_hybrid_model(source, output, manifest, expected_source_sha=source_sha)


def test_conversion_rejects_source_hash_mismatch(tmp_path: Path) -> None:
    source = _write_source(tmp_path)
    with pytest.raises(HybridQuantizationError, match="source SHA-256"):
        convert_hybrid_model(
            source,
            tmp_path / "candidate.onnx",
            tmp_path / "manifest.json",
            expected_source_sha="0" * 64,
        )


@pytest.mark.parametrize("commit", [None, "unknown", "abc", "g" * 40])
def test_conversion_rejects_unbound_source_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, commit: str | None
) -> None:
    source = _write_source(tmp_path)
    if commit is None:
        monkeypatch.delenv("SOURCE_COMMIT")
    else:
        monkeypatch.setenv("SOURCE_COMMIT", commit)
    output = tmp_path / "candidate.onnx"
    manifest = tmp_path / "manifest.json"
    with pytest.raises(HybridQuantizationError, match="SOURCE_COMMIT"):
        convert_hybrid_model(
            source,
            output,
            manifest,
            expected_source_sha=hashlib.sha256(source.read_bytes()).hexdigest(),
        )
    assert not output.exists()
    assert not manifest.exists()
