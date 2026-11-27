"""CLI entry points for the pinned ONNX INT8 conversions.

The default invocation remains the historical dynamic QUInt8 conversion. The
experimental ``--weight-only`` mode builds a separate QDQ graph and never
overwrites the canonical artifacts.
"""

import argparse
import hashlib
import json
import platform
import sys
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any
from urllib.parse import urlsplit

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.model_pipeline import CONVERTED_ROOT, quantize_int8


class WeightOnlyConversionError(ValueError):
    """The experimental weight-only graph cannot be constructed safely."""


@dataclass(frozen=True)
class WeightMapping:
    """One source FP32 weight and its exact quantized companion tensors."""

    float_name: str
    quantized_name: str
    scale_name: str
    zero_point_name: str
    shape: tuple[int, ...]
    axis: int
    kind: str


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _canonical_roots() -> tuple[Path, ...]:
    root = Path(__file__).resolve().parents[1]
    return (
        root / "models" / "converted",
        root / "models" / "upstream",
        root / "dist" / "extension" / "models",
    )


def _refuse_unsafe_output(fp32: Path, quantized: Path, output: Path) -> None:
    fp32_resolved = fp32.resolve()
    quantized_resolved = quantized.resolve()
    output_resolved = output.resolve()
    if output_resolved in (fp32_resolved, quantized_resolved):
        raise WeightOnlyConversionError("weight-only output must differ from both inputs")
    if output_resolved.name.lower() == "manifest.json":
        raise WeightOnlyConversionError("weight-only output name collides with manifest")
    if output.exists():
        raise WeightOnlyConversionError("weight-only output already exists")
    if output_resolved.with_name("manifest.json").exists():
        raise WeightOnlyConversionError("weight-only manifest already exists")
    for canonical in _canonical_roots():
        try:
            output_resolved.relative_to(canonical)
        except ValueError:
            continue
        raise WeightOnlyConversionError(
            "weight-only output must be outside canonical model directories"
        )


def _tensor_type_name(data_type: int) -> str:
    import onnx

    return onnx.TensorProto.DataType.Name(data_type)


def _initializer_map(graph: Any) -> dict[str, Any]:
    return {initializer.name: initializer for initializer in graph.initializer}


def _iter_graphs(graph: Any):
    """Yield a graph and any nested GraphProto attributes below its nodes."""

    import onnx

    yield graph
    for node in graph.node:
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                yield from _iter_graphs(attribute.g)
            elif attribute.type == onnx.AttributeProto.GRAPHS:
                for nested in attribute.graphs:
                    yield from _iter_graphs(nested)


def _initializer_uses(graph: Any, names: set[str]) -> dict[str, list[tuple[str, int]]]:
    """Collect all node-input uses, including nested graph attributes."""

    uses = {name: [] for name in names}
    for nested_graph in _iter_graphs(graph):
        for value in (*nested_graph.input, *nested_graph.output):
            if value.name in uses:
                uses[value.name].append(("GraphValue", -1))
        for node in nested_graph.node:
            for index, input_name in enumerate(node.input):
                if input_name in uses:
                    uses[input_name].append((node.op_type, index))
    return uses


def _validate_matmul_scale_path(graph: Any, node: Any, scale_name: str) -> None:
    """Validate the quantized graph's required weight-scale path.

    The ONNX quantizer emits a scale ``Mul`` before the output dequantization
    ``Mul``. The full path is required and must join the integer-result path
    exactly once.
    """

    import onnx

    uses = _initializer_uses(graph, {scale_name})[scale_name]
    if not uses:
        raise WeightOnlyConversionError(f"missing or disconnected weight scale path: {scale_name}")
    if len(uses) != 1 or uses[0][0] != "Mul" or uses[0][1] < 0:
        raise WeightOnlyConversionError(f"ambiguous weight scale path: {scale_name}")
    scale_nodes = [
        candidate
        for candidate in graph.node
        if candidate.op_type == "Mul" and scale_name in candidate.input
    ]
    if len(scale_nodes) != 1 or not scale_nodes[0].output:
        raise WeightOnlyConversionError(f"ambiguous weight scale path: {scale_name}")

    integer_consumers = [candidate for candidate in graph.node if node.output[0] in candidate.input]
    if len(integer_consumers) != 1 or integer_consumers[0].op_type != "Cast":
        raise WeightOnlyConversionError(
            f"MatMulInteger must feed exactly one Cast before scale path: {scale_name}"
        )
    cast = integer_consumers[0]
    cast_type = next((attribute.i for attribute in cast.attribute if attribute.name == "to"), None)
    if cast_type != onnx.TensorProto.FLOAT or len(cast.output) != 1 or not cast.output[0]:
        raise WeightOnlyConversionError(f"MatMulInteger Cast must produce FLOAT: {scale_name}")
    output_muls = [
        candidate
        for candidate in graph.node
        if candidate.op_type == "Mul" and cast.output[0] in candidate.input
    ]
    scale_output = scale_nodes[0].output[0]
    if len(output_muls) != 1 or list(output_muls[0].input).count(cast.output[0]) != 1:
        raise WeightOnlyConversionError(f"missing or ambiguous output scale Mul: {scale_name}")
    if list(output_muls[0].input).count(scale_output) != 1:
        raise WeightOnlyConversionError(f"disconnected weight scale path: {scale_name}")


def _external_data_path(model_path: Path, location: str) -> Path:
    """Resolve one ONNX external-data location under the model directory."""

    if not isinstance(location, str) or not location or "\x00" in location:
        raise WeightOnlyConversionError("invalid external data location")
    normalized = location.replace("\\", "/")
    parsed = urlsplit(normalized)
    windows_path = PureWindowsPath(location)
    posix_path = PurePosixPath(normalized)
    if (
        parsed.scheme
        or normalized.startswith("//")
        or posix_path.is_absolute()
        or windows_path.is_absolute()
        or bool(windows_path.drive)
        or ".." in posix_path.parts
    ):
        raise WeightOnlyConversionError(f"unsafe external data location: {location}")
    root = model_path.resolve().parent
    resolved = (root / Path(*posix_path.parts)).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise WeightOnlyConversionError(f"unsafe external data location: {location}") from exc
    if not resolved.is_file():
        raise WeightOnlyConversionError(f"external data file is missing: {location}")
    return resolved


def _external_data_manifest(model_path: Path, model: Any) -> list[dict[str, Any]]:
    """Hash every external-data file declared by the graph metadata."""

    import onnx

    records: dict[Path, dict[str, Any]] = {}
    for graph in _iter_graphs(model.graph):
        for tensor in graph.initializer:
            if tensor.data_location != onnx.TensorProto.EXTERNAL and not tensor.external_data:
                continue
            location = next(
                (entry.value for entry in tensor.external_data if entry.key == "location"),
                None,
            )
            if location is None:
                raise WeightOnlyConversionError(f"external data location is missing: {tensor.name}")
            resolved = _external_data_path(model_path, location)
            records.setdefault(
                resolved,
                {
                    "location": location.replace("\\", "/"),
                    "bytes": resolved.stat().st_size,
                    "sha256": _sha256(resolved),
                },
            )
    return sorted(records.values(), key=lambda record: record["location"])


def _copy_initializer(target_graph: Any, source: Any, names: set[str]) -> None:
    if source.name in names:
        raise WeightOnlyConversionError(f"conflicting initializer name: {source.name}")
    target_graph.initializer.append(source)
    names.add(source.name)


def _make_fp16_storage_initializer(source: Any) -> Any:
    """Convert one verified FP32 weight to a finite, representable FLOAT16 tensor."""

    import numpy as np
    from onnx import TensorProto, numpy_helper

    if source.data_type != TensorProto.FLOAT:
        raise WeightOnlyConversionError(f"MatMul source weight is not FLOAT: {source.name}")
    values = numpy_helper.to_array(source)
    if values.dtype != np.float32:
        raise WeightOnlyConversionError(f"MatMul source weight has unexpected dtype: {source.name}")
    if not np.isfinite(values).all():
        raise WeightOnlyConversionError(
            f"MatMul source weight must be finite for FLOAT16 storage: {source.name}"
        )
    if values.size and float(np.max(np.abs(values))) > float(np.finfo(np.float16).max):
        raise WeightOnlyConversionError(
            f"MatMul source weight is not representable as FLOAT16: {source.name}"
        )
    return numpy_helper.from_array(values.astype(np.float16), source.name)


def _weight_mappings(fp32_graph: Any, quantized_graph: Any) -> list[WeightMapping]:
    """Derive all Q weights from graph uses rather than fixed model names."""

    import numpy as np
    import onnx
    from onnx import numpy_helper

    fp32_initializers = _initializer_map(fp32_graph)
    quantized_initializers = _initializer_map(quantized_graph)
    quantized_weight_names = {
        name for name in quantized_initializers if name.endswith("_quantized")
    }
    if not quantized_weight_names:
        raise WeightOnlyConversionError("quantized graph has no quantized weight initializers")

    matmul_weight_nodes: list[tuple[str, Any]] = []
    for node in quantized_graph.node:
        if node.op_type != "MatMulInteger":
            continue
        if len(node.input) < 2:
            raise WeightOnlyConversionError("MatMulInteger has no weight input")
        weight_name = node.input[1]
        if weight_name not in quantized_weight_names:
            raise WeightOnlyConversionError(
                f"MatMulInteger weight is not a quantized initializer: {weight_name}"
            )
        if len(node.input) < 4:
            raise WeightOnlyConversionError("MatMulInteger zero point input is missing")
        expected_zero_point = f"{weight_name.removesuffix('_quantized')}_zero_point"
        if node.input[3] != expected_zero_point:
            raise WeightOnlyConversionError(
                f"MatMulInteger zero point input does not match weight: {weight_name}"
            )
        matmul_weight_nodes.append((weight_name, node))
    matmul_weight_names = [name for name, _ in matmul_weight_nodes]
    if len(matmul_weight_names) != len(set(matmul_weight_names)):
        raise WeightOnlyConversionError("quantized weight is used by multiple MatMulInteger nodes")

    embedding_weight_nodes: list[tuple[str, Any]] = []
    for node in quantized_graph.node:
        if node.op_type != "Gather" or not node.input:
            continue
        weight_name = node.input[0]
        if weight_name in quantized_weight_names:
            embedding_weight_nodes.append((weight_name, node))
    embedding_weight_names = [name for name, _ in embedding_weight_nodes]
    if len(embedding_weight_names) != 1:
        raise WeightOnlyConversionError("expected exactly one quantized embedding Gather")
    if set(matmul_weight_names) & set(embedding_weight_names):
        raise WeightOnlyConversionError("embedding and MatMulInteger weights overlap")
    used_weight_names = set(matmul_weight_names) | set(embedding_weight_names)
    if used_weight_names != quantized_weight_names:
        unused = sorted(quantized_weight_names - used_weight_names)
        raise WeightOnlyConversionError(f"unused quantized weight initializers: {unused}")

    fp32_matmul_users: dict[str, list[tuple[Any, int]]] = {}
    for node in fp32_graph.node:
        if node.op_type != "MatMul":
            continue
        for index, input_name in enumerate(node.input):
            if input_name in fp32_initializers:
                fp32_matmul_users.setdefault(input_name, []).append((node, index))
    quantized_uses: dict[str, list[tuple[str, int]]] = {name: [] for name in quantized_weight_names}
    for node in quantized_graph.node:
        for index, input_name in enumerate(node.input):
            if input_name in quantized_uses:
                quantized_uses[input_name].append((node.op_type, index))
    mappings: list[WeightMapping] = []
    mapped_float_names: set[str] = set()
    for quantized_name in matmul_weight_names:
        float_name = quantized_name.removesuffix("_quantized")
        scale_name = f"{float_name}_scale"
        zero_point_name = f"{float_name}_zero_point"
        source = fp32_initializers.get(float_name)
        q_weight = quantized_initializers[quantized_name]
        scale = quantized_initializers.get(scale_name)
        zero_point = quantized_initializers.get(zero_point_name)
        users = fp32_matmul_users.get(float_name, [])
        if source is None or len(users) != 1 or users[0][1] != 1:
            raise WeightOnlyConversionError(
                f"FP32 MatMul mapping is missing or ambiguous: {float_name}"
            )
        if quantized_uses[quantized_name] != [("MatMulInteger", 1)]:
            raise WeightOnlyConversionError(f"conflicting quantized weight uses: {quantized_name}")
        matmul_node = next(node for name, node in matmul_weight_nodes if name == quantized_name)
        if float_name in mapped_float_names:
            raise WeightOnlyConversionError(f"conflicting FP32 weight mapping: {float_name}")
        if len(source.dims) != 2:
            raise WeightOnlyConversionError(f"MatMul weight must be rank-2: {float_name}")
        if tuple(source.dims) != tuple(q_weight.dims):
            raise WeightOnlyConversionError(f"weight shape mismatch: {float_name}")
        if source.data_type != onnx.TensorProto.FLOAT:
            raise WeightOnlyConversionError(f"FP32 weight is not FLOAT: {float_name}")
        if q_weight.data_type != onnx.TensorProto.UINT8:
            raise WeightOnlyConversionError(f"quantized weight is not UINT8: {quantized_name}")
        if scale is None or zero_point is None:
            raise WeightOnlyConversionError(f"quantization metadata is missing: {float_name}")
        if scale.data_type != onnx.TensorProto.FLOAT:
            raise WeightOnlyConversionError(f"scale is not FLOAT: {scale_name}")
        if zero_point.data_type != onnx.TensorProto.UINT8:
            raise WeightOnlyConversionError(f"zero point is not UINT8: {zero_point_name}")
        expected_axis_shape = (source.dims[1],)
        if (
            tuple(scale.dims) != expected_axis_shape
            or tuple(zero_point.dims) != expected_axis_shape
        ):
            raise WeightOnlyConversionError(f"per-channel metadata shape mismatch: {float_name}")
        scale_values = numpy_helper.to_array(scale)
        if not np.isfinite(scale_values).all() or (scale_values <= 0).any():
            raise WeightOnlyConversionError(f"scale must be finite and positive: {scale_name}")
        _validate_matmul_scale_path(quantized_graph, matmul_node, scale_name)
        mappings.append(
            WeightMapping(
                float_name=float_name,
                quantized_name=quantized_name,
                scale_name=scale_name,
                zero_point_name=zero_point_name,
                shape=tuple(source.dims),
                axis=1,
                kind="matmul",
            )
        )
        mapped_float_names.add(float_name)

    quantized_embedding, embedding_gather = embedding_weight_nodes[0]
    embedding_float_name = quantized_embedding.removesuffix("_quantized")
    embedding_source = fp32_initializers.get(embedding_float_name)
    embedding_q = quantized_initializers[quantized_embedding]
    embedding_scale = quantized_initializers.get(f"{embedding_float_name}_scale")
    embedding_zero_point = quantized_initializers.get(f"{embedding_float_name}_zero_point")
    if embedding_source is None:
        raise WeightOnlyConversionError(f"FP32 embedding is missing: {embedding_float_name}")
    if quantized_uses[quantized_embedding] != [("Gather", 0)]:
        raise WeightOnlyConversionError(
            f"conflicting quantized embedding uses: {quantized_embedding}"
        )
    if len(embedding_gather.output) != 1 or not embedding_gather.output[0]:
        raise WeightOnlyConversionError("embedding Gather output is missing")
    embedding_output_uses = _initializer_uses(quantized_graph, {embedding_gather.output[0]})[
        embedding_gather.output[0]
    ]
    if embedding_output_uses != [("DequantizeLinear", 0)]:
        raise WeightOnlyConversionError("embedding Gather must feed exactly one DequantizeLinear")
    embedding_dequantizes = [
        node
        for node in quantized_graph.node
        if node.op_type == "DequantizeLinear"
        and node.input
        and node.input[0] == embedding_gather.output[0]
    ]
    if len(embedding_dequantizes) != 1:
        raise WeightOnlyConversionError("embedding DequantizeLinear is missing or ambiguous")
    embedding_dequantize = embedding_dequantizes[0]
    if embedding_float_name in mapped_float_names:
        raise WeightOnlyConversionError(f"conflicting FP32 weight mapping: {embedding_float_name}")
    if tuple(embedding_source.dims) != tuple(embedding_q.dims):
        raise WeightOnlyConversionError("embedding shape mismatch")
    if len(embedding_source.dims) != 2:
        raise WeightOnlyConversionError("embedding weight must be rank-2")
    if embedding_source.data_type != onnx.TensorProto.FLOAT:
        raise WeightOnlyConversionError("FP32 embedding is not FLOAT")
    if embedding_q.data_type != onnx.TensorProto.UINT8:
        raise WeightOnlyConversionError("quantized embedding is not UINT8")
    if embedding_scale is None or embedding_zero_point is None:
        raise WeightOnlyConversionError("embedding quantization metadata is missing")
    if len(embedding_dequantize.input) < 3 or (
        embedding_dequantize.input[1] != embedding_scale.name
        or embedding_dequantize.input[2] != embedding_zero_point.name
    ):
        raise WeightOnlyConversionError(
            "embedding DequantizeLinear scale or zero point does not match"
        )
    embedding_axis = next(
        (attribute.i for attribute in embedding_dequantize.attribute if attribute.name == "axis"),
        None,
    )
    if embedding_axis not in (None, 0):
        raise WeightOnlyConversionError("embedding DequantizeLinear axis is invalid")
    if embedding_scale.data_type != onnx.TensorProto.FLOAT:
        raise WeightOnlyConversionError("embedding scale is not FLOAT")
    if embedding_zero_point.data_type != onnx.TensorProto.UINT8:
        raise WeightOnlyConversionError("embedding zero point is not UINT8")
    if tuple(embedding_scale.dims) != () or tuple(embedding_zero_point.dims) != ():
        raise WeightOnlyConversionError("embedding scale must be scalar")
    embedding_scale_values = numpy_helper.to_array(embedding_scale)
    if not np.isfinite(embedding_scale_values).all() or (embedding_scale_values <= 0).any():
        raise WeightOnlyConversionError("embedding scale must be finite and positive")
    mappings.append(
        WeightMapping(
            float_name=embedding_float_name,
            quantized_name=quantized_embedding,
            scale_name=embedding_scale.name,
            zero_point_name=embedding_zero_point.name,
            shape=tuple(embedding_source.dims),
            axis=0,
            kind="embedding",
        )
    )
    return mappings


def _add_weight_only_qdq(
    fp32: Any,
    quantized: Any,
    mappings: list[WeightMapping],
    *,
    embedding_after_gather: bool = False,
    matmul_fp16_storage: bool = False,
) -> tuple[Any, int]:
    import onnx
    from onnx import helper

    if matmul_fp16_storage and not embedding_after_gather:
        raise WeightOnlyConversionError("matmul FP16 storage requires embedding-after-gather")
    quantized_initializers = _initializer_map(quantized.graph)
    fp32_initializers = _initializer_map(fp32.graph)
    output = onnx.ModelProto()
    output.CopyFrom(fp32)
    graph = output.graph
    existing_names = {initializer.name for initializer in graph.initializer}
    value_names = set(existing_names)
    value_names.update(value.name for value in graph.input)
    value_names.update(value.name for value in graph.output)
    value_names.update(value.name for value in graph.value_info)
    value_names.update(output_name for node in graph.node for output_name in node.output)
    mapping_by_float = {mapping.float_name: mapping for mapping in mappings}
    expected_uses = {
        mapping.float_name: [("Gather", 0)] if mapping.kind == "embedding" else [("MatMul", 1)]
        for mapping in mappings
    }
    uses = _initializer_uses(graph, set(mapping_by_float))
    for float_name, expected in expected_uses.items():
        if uses.get(float_name) != expected:
            raise WeightOnlyConversionError(
                f"FP32 weight has unsupported or nested uses: {float_name}"
            )
    inserted = 0
    new_nodes: list[Any] = []
    for node in graph.node:
        append_node = True
        if node.op_type == "Gather" and node.input and node.input[0] in mapping_by_float:
            mapping = mapping_by_float[node.input[0]]
            if mapping.kind != "embedding":
                raise WeightOnlyConversionError("non-embedding weight feeds Gather")
            dq_output = f"{mapping.float_name}_weight_only_dequantized"
            if dq_output in value_names:
                raise WeightOnlyConversionError(f"conflicting graph value name: {dq_output}")
            if embedding_after_gather:
                if len(node.output) != 1 or not node.output[0]:
                    raise WeightOnlyConversionError("embedding Gather output is missing")
                gather_output = node.output[0]
                quantized_gather_output = f"{gather_output}_weight_only_quantized"
                if quantized_gather_output in value_names:
                    raise WeightOnlyConversionError(
                        f"conflicting graph value name: {quantized_gather_output}"
                    )
                node.input[0] = mapping.quantized_name
                node.output[0] = quantized_gather_output
                new_nodes.append(node)
                new_nodes.append(
                    helper.make_node(
                        "DequantizeLinear",
                        [
                            quantized_gather_output,
                            mapping.scale_name,
                            mapping.zero_point_name,
                        ],
                        [gather_output],
                        name=f"{mapping.float_name}_weight_only_DequantizeLinear",
                    )
                )
                value_names.add(quantized_gather_output)
                append_node = False
            else:
                new_nodes.append(
                    helper.make_node(
                        "DequantizeLinear",
                        [mapping.quantized_name, mapping.scale_name, mapping.zero_point_name],
                        [dq_output],
                        name=f"{mapping.float_name}_weight_only_DequantizeLinear",
                    )
                )
                node.input[0] = dq_output
                value_names.add(dq_output)
            inserted += 1
        elif node.op_type == "MatMul":
            for index, input_name in enumerate(node.input):
                mapping = mapping_by_float.get(input_name)
                if mapping is None:
                    continue
                if mapping.kind != "matmul" or mapping.axis != 1:
                    raise WeightOnlyConversionError("invalid MatMul weight mapping")
                if index != 1:
                    raise WeightOnlyConversionError("MatMul weight must be input index 1")
                if matmul_fp16_storage:
                    cast_output = f"{mapping.float_name}_weight_only_fp16_to_float"
                    if cast_output in value_names:
                        raise WeightOnlyConversionError(
                            f"conflicting graph value name: {cast_output}"
                        )
                    new_nodes.append(
                        helper.make_node(
                            "Cast",
                            [mapping.float_name],
                            [cast_output],
                            name=f"{mapping.float_name}_weight_only_FP16Cast",
                            to=onnx.TensorProto.FLOAT,
                        )
                    )
                    node.input[index] = cast_output
                    value_names.add(cast_output)
                else:
                    dq_output = f"{mapping.float_name}_weight_only_dequantized"
                    if dq_output in value_names:
                        raise WeightOnlyConversionError(
                            f"conflicting graph value name: {dq_output}"
                        )
                    new_nodes.append(
                        helper.make_node(
                            "DequantizeLinear",
                            [
                                mapping.quantized_name,
                                mapping.scale_name,
                                mapping.zero_point_name,
                            ],
                            [dq_output],
                            name=f"{mapping.float_name}_weight_only_DequantizeLinear",
                            axis=1,
                        )
                    )
                    node.input[index] = dq_output
                    value_names.add(dq_output)
                inserted += 1
        if append_node:
            new_nodes.append(node)
    if inserted != len(mappings):
        raise WeightOnlyConversionError(
            f"weight mapping use count mismatch: mapped={len(mappings)} inserted={inserted}"
        )
    replaced_float_names = set(mapping_by_float)
    kept_initializers = [
        initializer
        for initializer in graph.initializer
        if initializer.name not in replaced_float_names
    ]
    del graph.initializer[:]
    graph.initializer.extend(kept_initializers)
    existing_names.difference_update(replaced_float_names)
    for mapping in mappings:
        if mapping.kind == "matmul" and matmul_fp16_storage:
            _copy_initializer(
                graph,
                _make_fp16_storage_initializer(fp32_initializers[mapping.float_name]),
                existing_names,
            )
            continue
        for name in (mapping.quantized_name, mapping.scale_name, mapping.zero_point_name):
            _copy_initializer(graph, quantized_initializers[name], existing_names)
    del graph.node[:]
    graph.node.extend(new_nodes)
    removed_float_names = {
        mapping.float_name
        for mapping in mappings
        if mapping.kind == "embedding" or not matmul_fp16_storage
    }
    remaining_uses = _initializer_uses(graph, removed_float_names)
    if any(remaining_uses.values()):
        raise WeightOnlyConversionError(
            f"removed FP32 weight remains referenced: "
            f"{[name for name, refs in remaining_uses.items() if refs]}"
        )
    if any(node.op_type in {"DynamicQuantizeLinear", "MatMulInteger"} for node in graph.node):
        raise WeightOnlyConversionError("weight-only output retained dynamic integer operators")
    return output, inserted


def convert_weight_only(
    fp32_path: Path,
    quantized_path: Path,
    output_path: Path,
    *,
    embedding_after_gather: bool = False,
    matmul_fp16_storage: bool = False,
) -> dict[str, Any]:
    """Create an isolated self-contained QDQ model and its manifest."""

    if matmul_fp16_storage and not embedding_after_gather:
        raise WeightOnlyConversionError("matmul FP16 storage requires embedding-after-gather")
    _refuse_unsafe_output(fp32_path, quantized_path, output_path)
    if fp32_path.resolve() == quantized_path.resolve():
        raise WeightOnlyConversionError("FP32 and quantized inputs must differ")
    import onnx

    from scripts.sanitize_model import sanitize_model

    fp32_metadata = onnx.load(str(fp32_path), load_external_data=False)
    quantized_metadata = onnx.load(str(quantized_path), load_external_data=False)
    fp32_external_data = _external_data_manifest(fp32_path, fp32_metadata)
    quantized_external_data = _external_data_manifest(quantized_path, quantized_metadata)
    fp32 = onnx.load(str(fp32_path), load_external_data=True)
    quantized = onnx.load(str(quantized_path), load_external_data=True)
    mappings = _weight_mappings(fp32.graph, quantized.graph)
    converted, inserted = _add_weight_only_qdq(
        fp32,
        quantized,
        mappings,
        embedding_after_gather=embedding_after_gather,
        matmul_fp16_storage=matmul_fp16_storage,
    )
    sanitized, removed = sanitize_model(converted)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(sanitized, str(output_path), save_as_external_data=False)
    onnx.checker.check_model(str(output_path))
    manifest_path = output_path.with_name("manifest.json")
    matmul_count = sum(mapping.kind == "matmul" for mapping in mappings)
    embedding_count = sum(mapping.kind == "embedding" for mapping in mappings)
    if matmul_fp16_storage:
        manifest = {
            "schema_version": "weight-only-matmul-fp16-storage-v1",
            "model_kind": "embedding-u8-matmul-fp16-storage",
            "method": (
                "FP32 graph with original MatMul weights stored as FLOAT16 and cast to "
                "FLOAT before MatMul; embedding retains exact QUInt8 Gather-to-DQ"
            ),
            "options": {
                "embedding_dequantize_after_gather": True,
                "matmul_fp16_storage": True,
                "matmul_storage_dtype": "FLOAT16",
                "matmul_compute_dtype": "FLOAT",
                "activation_dtype": "FLOAT",
            },
        }
    else:
        manifest = {
            "schema_version": "weight-only-qdq-v2",
            "method": (
                "FP32 graph with exact QUInt8 weights dequantized after embedding Gather "
                "and before float MatMul"
                if embedding_after_gather
                else "FP32 graph with exact QUInt8 weights dequantized before float MatMul/Gather"
            ),
            "options": {
                "embedding_dequantize_after_gather": embedding_after_gather,
            },
        }
    manifest.update(
        {
            "source": {
                "fp32_filename": fp32_path.name,
                "fp32_sha256": _sha256(fp32_path),
                "fp32_external_data": fp32_external_data,
                "quantized_filename": quantized_path.name,
                "quantized_sha256": _sha256(quantized_path),
                "quantized_external_data": quantized_external_data,
            },
            "output": {
                "filename": output_path.name,
                "bytes": output_path.stat().st_size,
                "sha256": _sha256(output_path),
                "self_contained": True,
                "sanitized_debug_fields": removed,
            },
            "mapping": {
                "total": len(mappings),
                "matmul": matmul_count,
                "embedding": embedding_count,
                "dequantize_nodes": embedding_count if matmul_fp16_storage else inserted,
                "quantized_weight_dtype": "UINT8 embedding only"
                if matmul_fp16_storage
                else "UINT8",
                "per_channel_axis": None if matmul_fp16_storage else 1,
                "weights": [asdict(mapping) for mapping in mappings],
            },
            "tools": {
                "python": platform.python_version(),
                "onnx": onnx.__version__,
            },
            "performance_claims": [],
        }
    )
    if matmul_fp16_storage:
        manifest["mapping"].update(
            matmul_fp16_storage=True,
            matmul_fp16_cast_nodes=matmul_count,
            matmul_storage_dtype="FLOAT16",
            matmul_compute_dtype="FLOAT",
        )
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"output": output_path, "manifest": manifest_path, "mapping": manifest["mapping"]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weight-only", action="store_true")
    parser.add_argument("--fp32", type=Path)
    parser.add_argument("--quantized", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--embedding-after-gather", action="store_true")
    parser.add_argument("--matmul-fp16-storage", action="store_true")
    args = parser.parse_args()
    if not args.weight_only:
        if any(value is not None for value in (args.fp32, args.quantized, args.output)):
            parser.error("--fp32/--quantized/--output require --weight-only")
        if args.embedding_after_gather:
            parser.error("--embedding-after-gather requires --weight-only")
        if args.matmul_fp16_storage:
            parser.error("--matmul-fp16-storage requires --weight-only")
        print(quantize_int8(CONVERTED_ROOT / "onnx" / "model.onnx"))
        return 0
    if not all(value is not None for value in (args.fp32, args.quantized, args.output)):
        parser.error("--weight-only requires --fp32, --quantized, and --output")
    if args.matmul_fp16_storage and not args.embedding_after_gather:
        parser.error("--matmul-fp16-storage requires --embedding-after-gather")
    result = convert_weight_only(
        args.fp32,
        args.quantized,
        args.output,
        embedding_after_gather=args.embedding_after_gather,
        matmul_fp16_storage=args.matmul_fp16_storage,
    )
    print(json.dumps({key: str(value) for key, value in result.items()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
