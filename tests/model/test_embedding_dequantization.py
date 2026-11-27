"""Tests for the opt-in embedding Gather-before-DequantizeLinear graph."""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnx

from scripts.quantize import convert_weight_only
from tests.model.test_weight_only_quantization import _write_toy_graphs


def _make_batch_dynamic(path: Path) -> None:
    model = onnx.load(path)
    for value_info in (*model.graph.input, *model.graph.output):
        dimension = value_info.type.tensor_type.shape.dim[0]
        dimension.ClearField("dim_value")
        dimension.dim_param = "batch"
    onnx.save(model, path)


def test_embedding_after_gather_matches_full_dequantization_for_batch_and_ids(
    tmp_path: Path,
) -> None:
    fp32_path, quantized_path = _write_toy_graphs(tmp_path)
    _make_batch_dynamic(fp32_path)
    _make_batch_dynamic(quantized_path)
    default_output = tmp_path / "default" / "model.onnx"
    optimized_output = tmp_path / "optimized" / "model.onnx"

    convert_weight_only(fp32_path, quantized_path, default_output)
    optimized_result = convert_weight_only(
        fp32_path,
        quantized_path,
        optimized_output,
        embedding_after_gather=True,
    )

    import onnxruntime as ort

    input_ids = np.asarray([[0, 1, 1, -1], [2, -2, 0, 3]], dtype=np.int64)
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    default_session = ort.InferenceSession(
        str(default_output), options, providers=["CPUExecutionProvider"]
    )
    optimized_session = ort.InferenceSession(
        str(optimized_output), options, providers=["CPUExecutionProvider"]
    )
    default_result = default_session.run(None, {"input_ids": input_ids})[0]
    optimized_result_value = optimized_session.run(None, {"input_ids": input_ids})[0]
    np.testing.assert_allclose(optimized_result_value, default_result, rtol=0, atol=0)

    optimized = onnx.load(optimized_output, load_external_data=False)
    gather = next(node for node in optimized.graph.node if node.op_type == "Gather")
    assert gather.input[0] == "embed_quantized"
    embedding_dequantize = next(
        node
        for node in optimized.graph.node
        if node.op_type == "DequantizeLinear" and node.input[1] == "embed_scale"
    )
    assert embedding_dequantize.input[0] == gather.output[0]
    assert embedding_dequantize.input[2] == "embed_zero_point"
    assert all(
        node.input[0] != "embed_quantized"
        for node in optimized.graph.node
        if node.op_type == "DequantizeLinear"
    )
    assert all(initializer.name != "embed" for initializer in optimized.graph.initializer)

    manifest = json.loads(optimized_result["manifest"].read_text(encoding="utf-8"))
    assert manifest["options"]["embedding_dequantize_after_gather"] is True


def test_default_embedding_order_remains_unchanged(tmp_path: Path) -> None:
    fp32_path, quantized_path = _write_toy_graphs(tmp_path)
    output = tmp_path / "default" / "model.onnx"
    result = convert_weight_only(fp32_path, quantized_path, output)
    model = onnx.load(output, load_external_data=False)
    gather = next(node for node in model.graph.node if node.op_type == "Gather")
    assert gather.input[0] == "embed_weight_only_dequantized"
    manifest = json.loads(result["manifest"].read_text(encoding="utf-8"))
    assert manifest["options"]["embedding_dequantize_after_gather"] is False


def test_embedding_after_gather_cli_option_requires_weight_only() -> None:
    repository = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, "scripts/quantize.py", "--embedding-after-gather"],
        cwd=repository,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "requires --weight-only" in result.stderr
