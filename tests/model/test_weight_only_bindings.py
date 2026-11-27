"""Regression tests for weight-only graph binding and external-data provenance."""

import hashlib
from pathlib import Path
from unittest.mock import patch

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from scripts.quantize import (
    WeightOnlyConversionError,
    _external_data_manifest,
    _weight_mappings,
    convert_weight_only,
)
from tests.model.test_weight_only_quantization import _write_toy_graphs


def _graphs(tmp_path: Path) -> tuple[onnx.ModelProto, onnx.ModelProto]:
    fp32_path, quantized_path = _write_toy_graphs(tmp_path)
    return onnx.load(fp32_path), onnx.load(quantized_path)


def test_matmul_integer_binds_weight_zero_point_input(tmp_path: Path) -> None:
    fp32, quantized = _graphs(tmp_path)
    matmul = next(node for node in quantized.graph.node if node.op_type == "MatMulInteger")
    matmul.input[3] = "other_zero_point"
    quantized.graph.initializer.append(
        numpy_helper.from_array(np.zeros(3, dtype=np.uint8), "other_zero_point")
    )

    with pytest.raises(WeightOnlyConversionError, match="zero point input"):
        _weight_mappings(fp32.graph, quantized.graph)


def test_embedding_gather_binds_following_dequantize_metadata_and_axis(
    tmp_path: Path,
) -> None:
    fp32, quantized = _graphs(tmp_path)
    dequantize = next(node for node in quantized.graph.node if node.op_type == "DequantizeLinear")
    dequantize.input[1] = "wrong_scale"
    quantized.graph.initializer.append(
        numpy_helper.from_array(np.asarray(0.1, dtype=np.float32), "wrong_scale")
    )

    with pytest.raises(WeightOnlyConversionError, match="embedding DequantizeLinear"):
        _weight_mappings(fp32.graph, quantized.graph)

    axis_dir = tmp_path / "axis"
    axis_dir.mkdir()
    _, quantized = _graphs(axis_dir)
    dequantize = next(node for node in quantized.graph.node if node.op_type == "DequantizeLinear")
    dequantize.attribute.append(helper.make_attribute("axis", 1))
    with pytest.raises(WeightOnlyConversionError, match="embedding DequantizeLinear axis"):
        _weight_mappings(fp32.graph, quantized.graph)


def test_matmul_weight_scale_path_rejects_multiple_direct_consumers(tmp_path: Path) -> None:
    fp32, quantized = _graphs(tmp_path)
    matmul = next(node for node in quantized.graph.node if node.op_type == "MatMulInteger")
    quantized.graph.node.append(
        helper.make_node(
            "Mul",
            [matmul.output[0], "weight_scale"],
            ["scaled_logits"],
        )
    )
    with pytest.raises(WeightOnlyConversionError, match="scale path"):
        _weight_mappings(fp32.graph, quantized.graph)


def test_matmul_weight_scale_path_cannot_be_missing_or_ambiguous(tmp_path: Path) -> None:
    fp32, quantized = _graphs(tmp_path)
    matmul = next(node for node in quantized.graph.node if node.op_type == "MatMulInteger")
    retained_nodes = [node for node in quantized.graph.node if node.op_type != "Mul"]
    del quantized.graph.node[:]
    quantized.graph.node.extend(retained_nodes)
    quantized.graph.node.append(
        helper.make_node("Mul", [matmul.output[0], "other_scale"], ["scaled_logits"])
    )
    quantized.graph.initializer.append(
        numpy_helper.from_array(np.ones(3, dtype=np.float32), "other_scale")
    )
    with pytest.raises(WeightOnlyConversionError, match="scale path"):
        _weight_mappings(fp32.graph, quantized.graph)

    ambiguous_dir = tmp_path / "ambiguous"
    ambiguous_dir.mkdir()
    _, quantized = _graphs(ambiguous_dir)
    quantized.graph.node.append(
        helper.make_node("Mul", ["weight_scale", "weight_scale"], ["other_scaled"])
    )
    with pytest.raises(WeightOnlyConversionError, match="scale path"):
        _weight_mappings(fp32.graph, quantized.graph)


def test_external_data_manifest_hashes_declared_locations(tmp_path: Path) -> None:
    model_path = tmp_path / "model.onnx"
    data_path = tmp_path / "weights.bin"
    data_path.write_bytes(b"external-weight")
    tensor = helper.make_tensor("weight", TensorProto.FLOAT, [1], [1.0])
    tensor.data_location = TensorProto.EXTERNAL
    tensor.external_data.add(key="location", value="weights.bin")
    graph = helper.make_graph([], "graph", [], [], initializer=[tensor])
    model = helper.make_model(graph)
    onnx.save(model, model_path)

    records = _external_data_manifest(model_path, model)
    assert records == [
        {
            "location": "weights.bin",
            "bytes": len(data_path.read_bytes()),
            "sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
        }
    ]


def test_convert_checks_external_data_before_materializing_model(tmp_path: Path) -> None:
    fp32_path, quantized_path = _write_toy_graphs(tmp_path)
    quantized = onnx.load(quantized_path)
    tensor = next(item for item in quantized.graph.initializer if item.name == "weight_quantized")
    tensor.data_location = TensorProto.EXTERNAL
    del tensor.external_data[:]
    tensor.external_data.add(key="location", value="../outside.bin")
    quantized_path.write_bytes(quantized.SerializeToString())

    real_load = onnx.load
    load_external_data_flags: list[bool | None] = []

    def recording_load(*args: object, **kwargs: object) -> onnx.ModelProto:
        load_external_data_flags.append(kwargs.get("load_external_data"))
        return real_load(*args, **kwargs)

    with patch("onnx.load", side_effect=recording_load):
        with pytest.raises(WeightOnlyConversionError, match="unsafe external data location"):
            convert_weight_only(fp32_path, quantized_path, tmp_path / "output.onnx")

    assert load_external_data_flags
    assert all(flag is not True for flag in load_external_data_flags)


@pytest.mark.parametrize(
    "location", ["../weights.bin", "/tmp/weights.bin", "https://x/weights.bin", "C:\\weights.bin"]
)
def test_external_data_manifest_rejects_unsafe_locations(tmp_path: Path, location: str) -> None:
    model_path = tmp_path / "model.onnx"
    tensor = helper.make_tensor("weight", TensorProto.FLOAT, [1], [1.0])
    tensor.data_location = TensorProto.EXTERNAL
    tensor.external_data.add(key="location", value=location)
    model = helper.make_model(helper.make_graph([], "graph", [], [], initializer=[tensor]))

    with pytest.raises(WeightOnlyConversionError, match="external data location"):
        _external_data_manifest(model_path, model)
