import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from scripts.quantize import (
    WeightOnlyConversionError,
    _weight_mappings,
    convert_weight_only,
)


def _write_toy_graphs(tmp_path: Path) -> tuple[Path, Path]:
    fp32_graph = helper.make_graph(
        [
            helper.make_node("Gather", ["embed", "input_ids"], ["embedding"]),
            helper.make_node("MatMul", ["embedding", "weight"], ["logits"]),
        ],
        "fp32",
        [helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "sequence"])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, "sequence", 3])],
        initializer=[
            numpy_helper.from_array(np.arange(8, dtype=np.float32).reshape(4, 2), "embed"),
            numpy_helper.from_array(np.arange(6, dtype=np.float32).reshape(2, 3), "weight"),
        ],
    )
    fp32_model = helper.make_model(fp32_graph, opset_imports=[helper.make_opsetid("", 18)])
    fp32_model.ir_version = 10
    fp32_model.graph.doc_string = r"C:\Users\private\debug"
    fp32_path = tmp_path / "model.onnx"
    onnx.save(fp32_model, fp32_path)

    q_graph = helper.make_graph(
        [
            helper.make_node("Gather", ["embed_quantized", "input_ids"], ["embedding_quantized"]),
            helper.make_node(
                "DequantizeLinear",
                ["embedding_quantized", "embed_scale", "embed_zero_point"],
                ["embedding_float"],
            ),
            helper.make_node(
                "DynamicQuantizeLinear",
                ["embedding_float"],
                ["activation_quantized", "activation_scale", "activation_zero_point"],
            ),
            helper.make_node(
                "MatMulInteger",
                [
                    "activation_quantized",
                    "weight_quantized",
                    "activation_zero_point",
                    "weight_zero_point",
                ],
                ["logits_integer"],
            ),
            helper.make_node("Cast", ["logits_integer"], ["logits"], to=TensorProto.FLOAT),
            helper.make_node(
                "Mul",
                ["output_activation_scale", "weight_scale"],
                ["weight_output_scale"],
            ),
            helper.make_node(
                "Mul",
                ["logits", "weight_output_scale"],
                ["scaled_logits"],
            ),
            helper.make_node(
                "Mul",
                ["scaled_logits", "downstream_scale"],
                ["final_logits"],
            ),
        ],
        "quantized",
        [helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "sequence"])],
        [helper.make_tensor_value_info("final_logits", TensorProto.FLOAT, [1, "sequence", 3])],
        initializer=[
            numpy_helper.from_array(np.arange(8, dtype=np.uint8).reshape(4, 2), "embed_quantized"),
            numpy_helper.from_array(np.asarray(0.1, dtype=np.float32), "embed_scale"),
            numpy_helper.from_array(np.asarray(0, dtype=np.uint8), "embed_zero_point"),
            numpy_helper.from_array(np.arange(6, dtype=np.uint8).reshape(2, 3), "weight_quantized"),
            numpy_helper.from_array(np.full(3, 0.1, dtype=np.float32), "weight_scale"),
            numpy_helper.from_array(np.zeros(3, dtype=np.uint8), "weight_zero_point"),
            numpy_helper.from_array(np.ones(3, dtype=np.float32), "output_activation_scale"),
            numpy_helper.from_array(np.ones(3, dtype=np.float32), "downstream_scale"),
        ],
    )
    q_model = helper.make_model(q_graph, opset_imports=[helper.make_opsetid("", 18)])
    q_model.ir_version = 10
    q_path = tmp_path / "model_quantized.onnx"
    onnx.save(q_model, q_path)
    return fp32_path, q_path


def test_weight_mapping_is_derived_and_numpy_dequantization_is_finite(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    fp32 = onnx.load(fp32_path)
    quantized = onnx.load(q_path)
    mappings = _weight_mappings(fp32.graph, quantized.graph)
    assert {mapping.kind for mapping in mappings} == {"embedding", "matmul"}
    assert len(mappings) == 2
    assert mappings[0].axis == 1 or mappings[1].axis == 1
    initializers = {item.name: item for item in quantized.graph.initializer}
    q = numpy_helper.to_array(initializers["weight_quantized"]).astype(np.float32)
    scale = numpy_helper.to_array(initializers["weight_scale"])
    zero_point = numpy_helper.to_array(initializers["weight_zero_point"])
    dequantized = (q - zero_point) * scale
    assert dequantized.shape == (2, 3)
    assert np.isfinite(dequantized).all()


def test_weight_only_conversion_is_self_contained_and_forces_float_graph(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    output = tmp_path / "experimental" / "model_weight_only.onnx"
    result = convert_weight_only(fp32_path, q_path, output)
    converted = onnx.load(output, load_external_data=False)
    assert result["mapping"]["total"] == 2
    assert output.is_file()
    assert output.with_name("manifest.json").is_file()
    assert not output.with_name("model_weight_only.onnx.data").exists()
    assert {node.op_type for node in converted.graph.node} == {
        "Gather",
        "MatMul",
        "DequantizeLinear",
    }
    assert all(
        node.op_type not in {"DynamicQuantizeLinear", "MatMulInteger"}
        for node in converted.graph.node
    )
    assert len([node for node in converted.graph.node if node.op_type == "DequantizeLinear"]) == 2
    assert converted.graph.output[0].name == "logits"
    converted_initializers = {item.name: item for item in converted.graph.initializer}
    source_initializers = {item.name: item for item in onnx.load(fp32_path).graph.initializer}
    quantized_initializers = {item.name: item for item in onnx.load(q_path).graph.initializer}
    assert "embed" not in converted_initializers
    assert "weight" not in converted_initializers
    for name in (
        "embed_quantized",
        "embed_scale",
        "embed_zero_point",
        "weight_quantized",
        "weight_scale",
        "weight_zero_point",
    ):
        assert (
            converted_initializers[name].SerializeToString()
            == quantized_initializers[name].SerializeToString()
        )
    assert (
        source_initializers["embed"].SerializeToString()
        != converted_initializers.get("embed", onnx.TensorProto()).SerializeToString()
    )
    manifest = json.loads(output.with_name("manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == "weight-only-qdq-v2"
    assert manifest["source"]["fp32_external_data"] == []
    assert manifest["source"]["quantized_external_data"] == []
    assert manifest["output"]["self_contained"] is True
    assert manifest["output"]["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert manifest["performance_claims"] == []
    assert manifest["output"]["sanitized_debug_fields"] >= 1

    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    session = ort.InferenceSession(str(output), options, providers=["CPUExecutionProvider"])
    actual = session.run(None, {"input_ids": np.asarray([[0, 1]], dtype=np.int64)})[0]
    embed = numpy_helper.to_array(quantized_initializers["embed_quantized"]).astype(np.float32)
    embed_scale = float(numpy_helper.to_array(quantized_initializers["embed_scale"]))
    embed_zp = float(numpy_helper.to_array(quantized_initializers["embed_zero_point"]))
    weight = numpy_helper.to_array(quantized_initializers["weight_quantized"]).astype(np.float32)
    weight_scale = numpy_helper.to_array(quantized_initializers["weight_scale"])
    weight_zp = numpy_helper.to_array(quantized_initializers["weight_zero_point"])
    expected = ((embed[[0, 1]] - embed_zp) * embed_scale) @ ((weight - weight_zp) * weight_scale)
    np.testing.assert_allclose(actual, expected[None, ...], rtol=1e-5, atol=1e-5)


def test_weight_only_rejects_existing_manifest(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    output = tmp_path / "experimental" / "model_weight_only.onnx"
    output.parent.mkdir()
    (output.parent / "manifest.json").write_text("{}", encoding="utf-8")
    with pytest.raises(WeightOnlyConversionError, match="manifest already exists"):
        convert_weight_only(fp32_path, q_path, output)


def test_weight_only_rejects_non_scalar_embedding_metadata_and_non_rank2_matmul(
    tmp_path: Path,
) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    quantized = onnx.load(q_path)
    for initializer in quantized.graph.initializer:
        if initializer.name == "embed_scale":
            initializer.CopyFrom(
                numpy_helper.from_array(np.ones(2, dtype=np.float32), "embed_scale")
            )
    onnx.save(quantized, q_path)
    with pytest.raises(WeightOnlyConversionError, match="embedding scale must be scalar"):
        convert_weight_only(fp32_path, q_path, tmp_path / "bad-embedding.onnx")

    rank_root = tmp_path / "rank"
    rank_root.mkdir()
    fp32_path, q_path = _write_toy_graphs(rank_root)
    fp32 = onnx.load(fp32_path)
    for initializer in fp32.graph.initializer:
        if initializer.name == "weight":
            initializer.CopyFrom(
                numpy_helper.from_array(np.ones((1, 2, 3), dtype=np.float32), "weight")
            )
    onnx.save(fp32, fp32_path)
    with pytest.raises(WeightOnlyConversionError, match="rank-2"):
        convert_weight_only(fp32_path, q_path, rank_root / "bad-rank.onnx")


def test_weight_only_rejects_nested_float_initializer_use(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    model = onnx.load(fp32_path)
    nested = helper.make_graph(
        [helper.make_node("Identity", ["weight"], ["nested_weight"])],
        "nested",
        [],
        [helper.make_tensor_value_info("nested_weight", TensorProto.FLOAT, [])],
    )
    model.graph.node[0].attribute.append(helper.make_attribute("body", nested))
    onnx.save(model, fp32_path)
    with pytest.raises(WeightOnlyConversionError, match="nested uses"):
        convert_weight_only(fp32_path, q_path, tmp_path / "nested.onnx")


def test_weight_only_rejects_unused_or_wrong_type_quantized_weights(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    model = onnx.load(q_path)
    model.graph.initializer.append(
        numpy_helper.from_array(np.ones((2, 2), dtype=np.uint8), "orphan_quantized")
    )
    onnx.save(model, q_path)
    with pytest.raises(WeightOnlyConversionError, match="unused quantized"):
        convert_weight_only(fp32_path, q_path, tmp_path / "unused.onnx")

    wrong_type_root = tmp_path / "wrong-type"
    wrong_type_root.mkdir()
    fp32_path, q_path = _write_toy_graphs(wrong_type_root)
    model = onnx.load(q_path)
    for initializer in model.graph.initializer:
        if initializer.name == "weight_quantized":
            initializer.data_type = TensorProto.FLOAT
            initializer.raw_data = np.ones((2, 3), dtype=np.float32).tobytes()
    onnx.save(model, q_path)
    with pytest.raises(WeightOnlyConversionError, match="not UINT8"):
        convert_weight_only(fp32_path, q_path, tmp_path / "wrong-type.onnx")


def test_weight_only_refuses_existing_and_canonical_outputs(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    with pytest.raises(WeightOnlyConversionError, match="differ from both"):
        convert_weight_only(fp32_path, q_path, fp32_path)
    existing = tmp_path / "existing.onnx"
    existing.write_bytes(b"existing")
    with pytest.raises(WeightOnlyConversionError, match="already exists"):
        convert_weight_only(fp32_path, q_path, existing)
    manifest_named = tmp_path / "manifest.json"
    with pytest.raises(WeightOnlyConversionError, match="collides with manifest"):
        convert_weight_only(fp32_path, q_path, manifest_named)
    with pytest.raises(WeightOnlyConversionError, match="canonical"):
        convert_weight_only(fp32_path, q_path, Path("models/converted/experimental.onnx"))
