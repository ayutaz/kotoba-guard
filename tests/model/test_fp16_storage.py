import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from scripts.quantize import WeightOnlyConversionError, convert_weight_only


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
            numpy_helper.from_array(
                np.asarray([[1.0, -2.0, 3.5], [4.0, 5.0, -6.0]], dtype=np.float32),
                "weight",
            ),
            numpy_helper.from_array(np.asarray([7.0], dtype=np.float32), "untouched"),
        ],
    )
    fp32_model = helper.make_model(fp32_graph, opset_imports=[helper.make_opsetid("", 18)])
    fp32_model.ir_version = 10
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
            helper.make_node("Mul", ["logits", "weight_output_scale"], ["scaled_logits"]),
            helper.make_node("Mul", ["scaled_logits", "downstream_scale"], ["final_logits"]),
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


def _initializers(model: onnx.ModelProto) -> dict[str, onnx.TensorProto]:
    return {item.name: item for item in model.graph.initializer}


def test_default_conversion_retains_legacy_mapping_schema(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    result = convert_weight_only(fp32_path, q_path, tmp_path / "default" / "model.onnx")
    manifest = json.loads(result["manifest"].read_text(encoding="utf-8"))
    assert set(manifest["mapping"]) == {
        "total",
        "matmul",
        "embedding",
        "dequantize_nodes",
        "quantized_weight_dtype",
        "per_channel_axis",
        "weights",
    }


def test_fp16_storage_requires_embedding_after_gather(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    with pytest.raises(WeightOnlyConversionError, match="embedding-after-gather"):
        convert_weight_only(
            fp32_path,
            q_path,
            tmp_path / "bad.onnx",
            matmul_fp16_storage=True,
        )


def test_fp16_storage_preserves_embedding_and_runs_cpu(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    output = tmp_path / "candidate" / "model.onnx"
    result = convert_weight_only(
        fp32_path,
        q_path,
        output,
        embedding_after_gather=True,
        matmul_fp16_storage=True,
    )
    converted = onnx.load(output, load_external_data=False)
    source = onnx.load(fp32_path, load_external_data=False)
    quantized = onnx.load(q_path, load_external_data=False)
    converted_init = _initializers(converted)
    source_init = _initializers(source)
    quantized_init = _initializers(quantized)

    assert result["mapping"]["matmul_fp16_storage"] is True
    assert result["mapping"]["matmul_fp16_cast_nodes"] == 1
    assert converted_init["weight"].data_type == TensorProto.FLOAT16
    assert (
        converted_init["untouched"].SerializeToString()
        == source_init["untouched"].SerializeToString()
    )
    np.testing.assert_array_equal(
        numpy_helper.to_array(converted_init["weight"]),
        numpy_helper.to_array(source_init["weight"]).astype(np.float16),
    )
    for name in ("embed_quantized", "embed_scale", "embed_zero_point"):
        assert converted_init[name].SerializeToString() == quantized_init[name].SerializeToString()
    assert not {"weight_quantized", "weight_scale", "weight_zero_point"} & set(converted_init)
    assert all(node.op_type != "MatMulInteger" for node in converted.graph.node)
    assert all(node.op_type != "DynamicQuantizeLinear" for node in converted.graph.node)
    casts = [node for node in converted.graph.node if node.op_type == "Cast"]
    assert len(casts) == 1
    assert casts[0].attribute[0].i == TensorProto.FLOAT
    assert {node.op_type for node in converted.graph.node} == {
        "Gather",
        "DequantizeLinear",
        "Cast",
        "MatMul",
    }
    onnx.checker.check_model(converted)

    import onnxruntime as ort

    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    actual = session.run(None, {"input_ids": np.asarray([[0, 1]], dtype=np.int64)})[0]
    embed = numpy_helper.to_array(quantized_init["embed_quantized"]).astype(np.float32)
    embed_scale = float(numpy_helper.to_array(quantized_init["embed_scale"]))
    weight = numpy_helper.to_array(source_init["weight"]).astype(np.float16).astype(np.float32)
    expected = (embed[[0, 1]] * embed_scale) @ weight
    np.testing.assert_allclose(actual, expected[None, ...], rtol=1e-5, atol=1e-5)

    manifest = json.loads(result["manifest"].read_text(encoding="utf-8"))
    assert manifest["schema_version"] == "weight-only-matmul-fp16-storage-v1"
    assert manifest["options"]["matmul_storage_dtype"] == "FLOAT16"
    assert manifest["options"]["matmul_compute_dtype"] == "FLOAT"


def test_fp16_storage_rejects_nonfinite_and_overflow_weights(tmp_path: Path) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    model = onnx.load(fp32_path)
    for item in model.graph.initializer:
        if item.name == "weight":
            item.CopyFrom(
                numpy_helper.from_array(
                    np.asarray([[np.inf, 0, 0], [0, 0, 0]], dtype=np.float32), "weight"
                )
            )
    onnx.save(model, fp32_path)
    with pytest.raises(WeightOnlyConversionError, match="finite"):
        convert_weight_only(
            fp32_path,
            q_path,
            tmp_path / "nonfinite.onnx",
            embedding_after_gather=True,
            matmul_fp16_storage=True,
        )

    overflow_root = tmp_path / "overflow"
    overflow_root.mkdir()
    fp32_path, q_path = _write_toy_graphs(overflow_root)
    model = onnx.load(fp32_path)
    for item in model.graph.initializer:
        if item.name == "weight":
            item.CopyFrom(
                numpy_helper.from_array(
                    np.asarray([[70000, 0, 0], [0, 0, 0]], dtype=np.float32), "weight"
                )
            )
    onnx.save(model, fp32_path)
    with pytest.raises(WeightOnlyConversionError, match="FLOAT16"):
        convert_weight_only(
            fp32_path,
            q_path,
            tmp_path / "overflow" / "overflow.onnx",
            embedding_after_gather=True,
            matmul_fp16_storage=True,
        )


def test_fp16_storage_rejects_shared_weights_and_generated_name_conflicts(
    tmp_path: Path,
) -> None:
    fp32_path, q_path = _write_toy_graphs(tmp_path)
    model = onnx.load(fp32_path)
    model.graph.node.append(helper.make_node("MatMul", ["embedding", "weight"], ["second_logits"]))
    onnx.save(model, fp32_path)
    with pytest.raises(WeightOnlyConversionError, match="missing or ambiguous"):
        convert_weight_only(
            fp32_path,
            q_path,
            tmp_path / "shared.onnx",
            embedding_after_gather=True,
            matmul_fp16_storage=True,
        )

    conflict_root = tmp_path / "conflict"
    conflict_root.mkdir()
    fp32_path, q_path = _write_toy_graphs(conflict_root)
    model = onnx.load(fp32_path)
    model.graph.value_info.append(
        helper.make_tensor_value_info("weight_weight_only_fp16_to_float", TensorProto.FLOAT, [2, 3])
    )
    onnx.save(model, fp32_path)
    with pytest.raises(WeightOnlyConversionError, match="conflicting graph value name"):
        convert_weight_only(
            fp32_path,
            q_path,
            conflict_root / "conflict.onnx",
            embedding_after_gather=True,
            matmul_fp16_storage=True,
        )


def test_fp16_storage_cli_requires_weight_only_and_embedding_flag() -> None:
    completed = subprocess.run(
        [sys.executable, "scripts/quantize.py", "--matmul-fp16-storage"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "requires --weight-only" in completed.stderr
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/quantize.py",
            "--weight-only",
            "--fp32",
            "fp32.onnx",
            "--quantized",
            "quantized.onnx",
            "--output",
            "candidate.onnx",
            "--matmul-fp16-storage",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "requires --embedding-after-gather" in completed.stderr
