"""Experimental hybrid QDQ conversion for attention-output projections.

This module deliberately has no effect on the canonical quantized model.  It
replaces only the ten attention-output ``MatMulInteger`` paths selected by
their graph edges, leaving the other quantized paths untouched.  The command
line entry point is intended for a scratch candidate directory only.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import re
import sys
from pathlib import Path
from typing import Any

MODEL_SHA256 = "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab"
UPSTREAM_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
# The 42nd MatMulInteger is the classifier projection.  Attention-output
# projections occupy indices 1, 5, ..., 37 only.
SELECTED_PATH_INDICES = tuple(range(1, 41, 4))


class HybridQuantizationError(ValueError):
    """The candidate graph does not satisfy the narrow hybrid contract."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _initializer_fingerprint(graph: Any) -> str:
    digest = hashlib.sha256()
    for initializer in sorted(graph.initializer, key=lambda item: item.name):
        encoded_name = initializer.name.encode("utf-8")
        digest.update(len(encoded_name).to_bytes(4, "big"))
        digest.update(encoded_name)
        payload = initializer.SerializeToString()
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _node_fingerprint(nodes: list[Any]) -> str:
    digest = hashlib.sha256()
    for node in nodes:
        payload = node.SerializeToString()
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _embedding_binding(graph: Any) -> list[dict[str, str]]:
    initializers = _initializer_map(graph)
    return [
        {"node": node.name, "weight": node.input[0]}
        for node in graph.node
        if node.op_type == "Gather" and node.input and node.input[0] in initializers
    ]


def _embedding_initializer_fingerprint(graph: Any, bindings: list[dict[str, str]]) -> str:
    initializers = _initializer_map(graph)
    digest = hashlib.sha256()
    for binding in bindings:
        initializer = initializers.get(binding["weight"])
        if initializer is None:
            raise HybridQuantizationError(
                f"embedding Gather initializer is missing: {binding['weight']}"
            )
        payload = initializer.SerializeToString()
        digest.update(binding["weight"].encode("utf-8"))
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _initializer_map(graph: Any) -> dict[str, Any]:
    return {item.name: item for item in graph.initializer}


def _node_attr(node: Any, name: str, default: int | None = None) -> int | None:
    return next((attribute.i for attribute in node.attribute if attribute.name == name), default)


def _producers(graph: Any) -> dict[str, list[Any]]:
    result: dict[str, list[Any]] = {}
    for node in graph.node:
        for output in node.output:
            if output:
                result.setdefault(output, []).append(node)
    return result


def _consumers(graph: Any) -> dict[str, list[Any]]:
    result: dict[str, list[Any]] = {}
    for node in graph.node:
        for input_name in node.input:
            if input_name:
                result.setdefault(input_name, []).append(node)
    return result


def _validate_node_names(graph: Any) -> None:
    names = [node.name for node in graph.node]
    if any(not name for name in names) or len(set(names)) != len(names):
        raise HybridQuantizationError("candidate graph node names must be unique and non-empty")


def _data_type_name(data_type: int) -> str:
    import onnx

    return onnx.TensorProto.DataType.Name(data_type)


def _iter_graphs(graph: Any):
    import onnx

    yield graph
    for node in graph.node:
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                yield from _iter_graphs(attribute.g)
            elif attribute.type == onnx.AttributeProto.GRAPHS:
                for nested in attribute.graphs:
                    yield from _iter_graphs(nested)


def _reject_external_data(model: Any) -> None:
    """Keep this candidate converter self-contained and deterministic."""

    import onnx

    for graph in _iter_graphs(model.graph):
        for initializer in graph.initializer:
            if initializer.data_location == onnx.TensorProto.EXTERNAL or initializer.external_data:
                raise HybridQuantizationError(
                    "hybrid candidate requires a self-contained ONNX model; "
                    "external data is unsupported"
                )


def _validate_weight(initializer: Any, scale: Any, zero_point: Any) -> None:
    import numpy as np
    import onnx
    from onnx import numpy_helper

    if initializer.data_type != onnx.TensorProto.UINT8:
        raise HybridQuantizationError("selected path weight must be UINT8")
    if zero_point.data_type != onnx.TensorProto.UINT8:
        raise HybridQuantizationError("selected path zero point must be UINT8")
    if scale.data_type != onnx.TensorProto.FLOAT:
        raise HybridQuantizationError("selected path scale must be FLOAT")
    if len(initializer.dims) != 2:
        raise HybridQuantizationError("selected path weight must be rank-2")
    if list(scale.dims) != [initializer.dims[1]]:
        raise HybridQuantizationError("selected path scale must match axis 1")
    if list(zero_point.dims) != [initializer.dims[1]]:
        raise HybridQuantizationError("selected path zero point must match axis 1")
    values = numpy_helper.to_array(scale)
    if not np.isfinite(values).all() or (values <= 0).any():
        raise HybridQuantizationError("selected path scale must be finite and positive")


def _bind_selected_paths(graph: Any) -> dict[int, dict[str, Any]]:
    """Bind selected paths using producer/consumer edges, never tensor names."""

    import onnx

    initializers = _initializer_map(graph)
    producers = _producers(graph)
    consumers = _consumers(graph)
    matmuls = [node for node in graph.node if node.op_type == "MatMulInteger"]
    if len(matmuls) != 42:
        raise HybridQuantizationError(
            f"expected exactly 42 MatMulInteger paths, got {len(matmuls)}"
        )
    result: dict[int, dict[str, Any]] = {}
    for index in SELECTED_PATH_INDICES:
        mmi = matmuls[index]
        expected_mmi_name = f"node_linear_{index}_quant"
        if mmi.name != expected_mmi_name:
            raise HybridQuantizationError(
                f"selected path {index} has unexpected MatMulInteger role"
            )
        if len(mmi.input) < 4 or not mmi.output or not mmi.output[0]:
            raise HybridQuantizationError(f"selected path {index} has malformed MatMulInteger")
        q_name = mmi.input[0]
        q_producers = producers.get(q_name, [])
        if len(q_producers) != 1 or q_producers[0].op_type != "DynamicQuantizeLinear":
            raise HybridQuantizationError(
                f"selected path {index} is not bound to DynamicQuantizeLinear"
            )
        dql = q_producers[0]
        expected_activation = f"view_{3 * ((index - 1) // 4) + 2}"
        if dql.input[0] != expected_activation:
            raise HybridQuantizationError(f"selected path {index} has unexpected activation source")
        if len(dql.input) != 1 or len(dql.output) != 3:
            raise HybridQuantizationError(
                f"selected path {index} has malformed DynamicQuantizeLinear"
            )
        if mmi.input[2] != dql.output[2]:
            raise HybridQuantizationError(
                f"selected path {index} has a disconnected activation zero point"
            )
        weight_name, weight_zero_name = mmi.input[1], mmi.input[3]
        if weight_name not in initializers or weight_zero_name not in initializers:
            raise HybridQuantizationError(f"selected path {index} has missing weight initializer")
        scale_muls = [
            node for node in graph.node if node.op_type == "Mul" and dql.output[1] in node.input
        ]
        if len(scale_muls) != 1:
            raise HybridQuantizationError(f"selected path {index} has ambiguous weight scale")
        scale_names = [name for name in scale_muls[0].input if name != dql.output[1]]
        scale_candidates = [initializers[name] for name in scale_names if name in initializers]
        if len(scale_candidates) != 1:
            raise HybridQuantizationError(f"selected path {index} has missing weight scale")
        scale = scale_candidates[0]
        _validate_weight(initializers[weight_name], scale, initializers[weight_zero_name])

        cast_nodes = [node for node in consumers.get(mmi.output[0], []) if node.op_type == "Cast"]
        if len(cast_nodes) != 1 or len(cast_nodes[0].output) != 1:
            raise HybridQuantizationError(f"selected path {index} must feed exactly one Cast")
        cast = cast_nodes[0]
        if _node_attr(cast, "to") != onnx.TensorProto.FLOAT:
            raise HybridQuantizationError(f"selected path {index} Cast must produce FLOAT")
        output_muls = [node for node in consumers.get(cast.output[0], []) if node.op_type == "Mul"]
        if len(output_muls) != 1 or len(output_muls[0].output) != 1:
            raise HybridQuantizationError(f"selected path {index} has ambiguous output scale Mul")
        output_mul = output_muls[0]
        expected_output = f"linear_{index}"
        if output_mul.output[0] != expected_output:
            raise HybridQuantizationError(f"selected path {index} has unexpected output role")
        if len(scale_muls[0].output) != 1 or scale.name not in scale_muls[0].input:
            raise HybridQuantizationError(
                f"selected path {index} has disconnected weight scale path"
            )
        combined_mul = scale_muls[0]
        if combined_mul.output[0] not in output_mul.input:
            raise HybridQuantizationError(f"selected path {index} scale path does not reach output")
        removed = (dql, combined_mul, mmi, cast, output_mul)
        result[index] = {
            "dql": dql,
            "combined_mul": combined_mul,
            "mmi": mmi,
            "cast": cast,
            "output_mul": output_mul,
            "activation": dql.input[0],
            "weight": weight_name,
            "scale": scale.name,
            "zero_point": weight_zero_name,
            "output": output_mul.output[0],
            "removed": removed,
        }
    return result


def rewrite_hybrid_graph(
    source_model: Any, *, selected_indices: tuple[int, ...] = SELECTED_PATH_INDICES
) -> tuple[Any, dict[str, Any]]:
    """Return a candidate model and structural metadata without writing files."""

    import onnx

    if tuple(selected_indices) != SELECTED_PATH_INDICES:
        raise HybridQuantizationError(
            "hybrid candidate selection is fixed to ten attention-output paths"
        )
    model = copy.deepcopy(source_model)
    _validate_node_names(model.graph)
    bindings = _bind_selected_paths(model.graph)
    original_mmi_names = [node.name for node in model.graph.node if node.op_type == "MatMulInteger"]
    original_initializer_fingerprint = _initializer_fingerprint(model.graph)
    original_nonselected_nodes = [
        node
        for index, node in enumerate(
            node for node in model.graph.node if node.op_type == "MatMulInteger"
        )
        if index not in SELECTED_PATH_INDICES
    ]
    original_embedding_binding = _embedding_binding(model.graph)
    original_embedding_fingerprint = _embedding_initializer_fingerprint(
        model.graph, original_embedding_binding
    )
    replacements: dict[str, tuple[Any, Any]] = {}
    removed_names: set[str] = set()
    new_nodes: list[Any] = []
    injected: set[str] = set()
    for index in SELECTED_PATH_INDICES:
        binding = bindings[index]
        for node in binding["removed"]:
            removed_names.add(node.name)
        dq_output = f"hybrid_{index}_weight_float"
        dq = onnx.helper.make_node(
            "DequantizeLinear",
            [binding["weight"], binding["scale"], binding["zero_point"]],
            [dq_output],
            name=f"hybrid_{index}_weight_dequantize",
            axis=1,
        )
        matmul = onnx.helper.make_node(
            "MatMul",
            [binding["activation"], dq_output],
            [binding["output"]],
            name=f"hybrid_{index}_attention_output_matmul",
        )
        replacements[binding["dql"].name] = (dq, matmul)
    original_retained_nodes = [node for node in model.graph.node if node.name not in removed_names]
    for node in model.graph.node:
        if node.name in replacements:
            new_nodes.extend(replacements[node.name])
            injected.add(node.name)
        elif node.name not in removed_names:
            new_nodes.append(node)
    if len(injected) != len(SELECTED_PATH_INDICES):
        raise HybridQuantizationError("failed to inject every selected hybrid path")
    model.graph.ClearField("node")
    model.graph.node.extend(new_nodes)

    all_removed_outputs = {
        output
        for binding in bindings.values()
        for node in binding["removed"]
        for output in node.output
        if output and output != binding["output"]
    }
    for node in model.graph.node:
        if any(input_name in all_removed_outputs for input_name in node.input):
            raise HybridQuantizationError(
                "candidate graph retains a removed intermediate reference"
            )
    retained_value_info = [
        value for value in model.graph.value_info if value.name not in all_removed_outputs
    ]
    model.graph.ClearField("value_info")
    model.graph.value_info.extend(retained_value_info)
    remaining = sum(node.op_type == "MatMulInteger" for node in model.graph.node)
    if remaining != 32:
        raise HybridQuantizationError(
            f"candidate graph must retain 32 MatMulInteger paths, got {remaining}"
        )
    onnx.checker.check_model(model)
    rewritten_nonselected_nodes = [
        node
        for node in model.graph.node
        if node.op_type == "MatMulInteger"
        and node.name in {candidate.name for candidate in original_nonselected_nodes}
    ]
    retained_names = {node.name for node in original_retained_nodes}
    rewritten_retained_nodes = [node for node in model.graph.node if node.name in retained_names]
    nonremoved_unchanged = _node_fingerprint(original_retained_nodes) == _node_fingerprint(
        rewritten_retained_nodes
    )
    nonselected_unchanged = _node_fingerprint(original_nonselected_nodes) == _node_fingerprint(
        rewritten_nonselected_nodes
    )
    output_initializer_fingerprint = _initializer_fingerprint(model.graph)
    initializers_unchanged = original_initializer_fingerprint == output_initializer_fingerprint
    embedding_unchanged = original_embedding_binding == _embedding_binding(model.graph)
    output_embedding_fingerprint = _embedding_initializer_fingerprint(
        model.graph, original_embedding_binding
    )
    if not (
        nonselected_unchanged
        and nonremoved_unchanged
        and initializers_unchanged
        and embedding_unchanged
    ):
        raise HybridQuantizationError("hybrid conversion changed an unselected graph component")
    metadata = {
        "selected_path_count": len(SELECTED_PATH_INDICES),
        "selected_mmi_indices": list(SELECTED_PATH_INDICES),
        "selected_paths": [
            {
                "index": index,
                "matmul_integer_node": bindings[index]["mmi"].name,
                "dql_source": bindings[index]["activation"],
                "output": bindings[index]["output"],
                "weight": bindings[index]["weight"],
                "scale": bindings[index]["scale"],
                "zero_point": bindings[index]["zero_point"],
            }
            for index in SELECTED_PATH_INDICES
        ],
        "remaining_matmul_integer_count": remaining,
        "unchanged_matmul_integer_node_names": [
            name
            for index, name in enumerate(original_mmi_names)
            if index not in SELECTED_PATH_INDICES
        ],
        "unchanged_initializer_fingerprint": original_initializer_fingerprint,
        "provenance": {
            "expected_revision": UPSTREAM_REVISION,
            "tool_versions": {
                "python": platform.python_version(),
                "onnx": onnx.__version__,
            },
        },
        "graph_invariance": {
            "nonselected_matmul_integer": nonselected_unchanged,
            "nonremoved_nodes": nonremoved_unchanged,
            "initializers": initializers_unchanged,
            "embedding": embedding_unchanged,
            "initializer_fingerprint_before": original_initializer_fingerprint,
            "initializer_fingerprint_after": output_initializer_fingerprint,
            "nonselected_matmul_integer_fingerprint_before": _node_fingerprint(
                original_nonselected_nodes
            ),
            "nonselected_matmul_integer_fingerprint": _node_fingerprint(
                rewritten_nonselected_nodes
            ),
            "nonremoved_nodes_fingerprint_before": _node_fingerprint(original_retained_nodes),
            "nonremoved_nodes_fingerprint_after": _node_fingerprint(rewritten_retained_nodes),
        },
        "embedding_binding": {
            "status": "unchanged",
            "gathers": original_embedding_binding,
            "initializer_fingerprint_before": original_embedding_fingerprint,
            "initializer_fingerprint_after": output_embedding_fingerprint,
        },
        "runtime": "onnxruntime/browser unverified",
    }
    return model, metadata


def _refuse_output(source: Path, output: Path, manifest: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    canonical_roots = (
        root / "models" / "converted",
        root / "models" / "upstream",
        root / "dist" / "extension" / "models",
    )
    source_resolved = source.resolve()
    output_resolved = output.resolve()
    manifest_resolved = manifest.resolve()
    if output_resolved == source_resolved or manifest_resolved in {
        source_resolved,
        output_resolved,
    }:
        raise HybridQuantizationError("candidate output must differ from source and model output")
    if output.exists() or manifest.exists():
        raise HybridQuantizationError("candidate output or manifest already exists")
    if output_resolved.name.lower() == "manifest.json":
        raise HybridQuantizationError("candidate output name collides with manifest")
    if manifest_resolved.name.lower() != "manifest.json":
        raise HybridQuantizationError("candidate manifest must be named manifest.json")
    for canonical in canonical_roots:
        for path in (output_resolved, manifest_resolved):
            try:
                path.relative_to(canonical.resolve())
            except ValueError:
                continue
            raise HybridQuantizationError(
                "candidate output must be outside canonical model directories"
            )


def convert_hybrid_model(
    source: Path,
    output: Path,
    manifest: Path,
    *,
    expected_source_sha: str = MODEL_SHA256,
) -> dict[str, Any]:
    """Convert one source model into a new, collision-safe candidate."""

    import onnx

    source = Path(source)
    output = Path(output)
    manifest = Path(manifest)
    source_commit = os.environ.get("SOURCE_COMMIT", "")
    if re.fullmatch(r"[0-9a-fA-F]{40}", source_commit) is None:
        raise HybridQuantizationError("SOURCE_COMMIT must be a full 40-character Git SHA")
    if not source.is_file():
        raise HybridQuantizationError(f"source model does not exist: {source}")
    _refuse_output(source, output, manifest)
    actual_sha = _sha256(source)
    if actual_sha != expected_source_sha:
        raise HybridQuantizationError(
            f"source SHA-256 mismatch: expected {expected_source_sha}, got {actual_sha}"
        )
    model = onnx.load(str(source), load_external_data=False)
    _reject_external_data(model)
    converted, metadata = rewrite_hybrid_graph(model)
    metadata["provenance"].update(
        {"source_sha256": actual_sha, "source_commit": source_commit.lower()}
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(converted, str(output))
    output_sha = _sha256(output)
    result = {
        "schema_version": "hybrid-attention-output-qdq-v1",
        "source_model_sha256": actual_sha,
        "source_model_bytes": source.stat().st_size,
        "output_model_sha256": output_sha,
        "output_bytes": output.stat().st_size,
        **metadata,
    }
    manifest.parent.mkdir(parents=True, exist_ok=True)
    with manifest.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="pinned sanitized QUInt8 model")
    parser.add_argument("--output", type=Path, required=True, help="new candidate ONNX path")
    parser.add_argument(
        "--manifest", type=Path, required=True, help="new candidate manifest.json path"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = convert_hybrid_model(args.model, args.output, args.manifest)
    except (HybridQuantizationError, OSError, ValueError, RuntimeError) as error:
        print(f"hybrid conversion failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
