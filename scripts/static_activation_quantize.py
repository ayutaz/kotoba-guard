"""Experimental fixed activation quantization for the pinned QUInt8 graph.

This module is deliberately separate from the canonical dynamic-quantization
pipeline.  It only observes the inputs of the existing DynamicQuantizeLinear
operators, then replaces those operators with fixed scalar QuantizeLinear
nodes.  The source graph is never overwritten.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import platform
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.model_pipeline import EXPECTED_REVISION, sha256_file

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_REVISION = EXPECTED_REVISION
CALIBRATION_ROWS = 64
CALIBRATION_MAX_TOKENS = 128
REGISTERED_MODEL_SHA256 = "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab"
REGISTERED_DATASET_SHA256 = "94f257e7968e496dd2ff043b7c58fa3a547a665e185b81e97d5c3384b7dcbdd1"
REGISTERED_DATASET_MANIFEST_SHA256 = (
    "0ee9a84e9c81597ee5f3fe2421d9f695c01818a586d49a5a98fbef5dbf8279be"
)
REGISTERED_FIXTURE_SHA256 = "4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47"
REGISTERED_PROTOCOL_SHA256 = "ae45a8faba56f2c2d1add338f21ea153860a8b7f2f8b9577c07bb5c32c7c61ca"
REGISTERED_TOKENIZER_SHA256 = "6a0734cf21c802169defaffe719bc2ef12bb9d0be37e54b61ed27aa89394723d"
REGISTERED_TOKENIZER_CONFIG_SHA256 = (
    "4e2b5f5a5159b1b0b5b75e6d099cf96f9b0399b9037685275ffcd4b18f02d759"
)
_SOURCE_COMMIT_RE = r"^[0-9a-f]{40}$"


class StaticActivationError(ValueError):
    """The experimental fixed-activation conversion cannot be trusted."""


def _hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _fingerprint_named(values: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(values):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(values[name])
    return digest.hexdigest()


def _normal_key(value: str) -> str:
    import unicodedata

    return " ".join(unicodedata.normalize("NFC", value).split())


def _load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StaticActivationError(f"invalid JSON: {path}") from exc
    if not isinstance(value, dict):
        raise StaticActivationError(f"JSON object required: {path}")
    return value


def _load_model(path: Path) -> Any:
    import onnx

    try:
        model = onnx.load(str(path), load_external_data=False)
    except Exception as exc:  # noqa: BLE001 - normalize protobuf errors
        raise StaticActivationError(f"unable to load ONNX model: {path}") from exc
    for graph in _iter_graphs(model.graph):
        node_names = [node.name for node in graph.node]
        if any(not name for name in node_names) or len(node_names) != len(set(node_names)):
            raise StaticActivationError("graph node names must be nonempty and unique")
        initializer_names = [tensor.name for tensor in graph.initializer]
        if len(initializer_names) != len(set(initializer_names)):
            raise StaticActivationError("initializer names must be unique")
        for tensor in graph.initializer:
            if tensor.data_location == onnx.TensorProto.EXTERNAL or tensor.external_data:
                raise StaticActivationError("external ONNX data is not supported")
    return model


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


def _dql_nodes(model: Any, *, expected_path_count: int | None = 42) -> list[Any]:
    nodes = [node for node in model.graph.node if node.op_type == "DynamicQuantizeLinear"]
    if not nodes:
        raise StaticActivationError("source graph has no DynamicQuantizeLinear nodes")
    if expected_path_count is not None and len(nodes) != expected_path_count:
        raise StaticActivationError(
            f"expected {expected_path_count} DynamicQuantizeLinear nodes, found {len(nodes)}"
        )
    for node in nodes:
        if len(node.input) != 1 or len(node.output) != 3 or not node.name:
            raise StaticActivationError("invalid DynamicQuantizeLinear binding")
    return nodes


def compute_quantization_params(minimum: float, maximum: float) -> tuple[float, int]:
    """Return deterministic UINT8 affine parameters for one scalar range."""
    if not all(math.isfinite(value) for value in (minimum, maximum)) or minimum > maximum:
        raise StaticActivationError("activation range must be finite and ordered")
    lower, upper = min(minimum, 0.0), max(maximum, 0.0)
    if lower == upper == 0:
        return 1.0, 0
    scale = float(np.float32((upper - lower) / 255.0))
    if not math.isfinite(scale) or scale <= 0:
        raise StaticActivationError("activation range produced an invalid scale")
    zero_point = int(np.clip(np.rint(-lower / scale), 0, 255))
    return scale, zero_point


def _tokenizer_encoding(tokenizer: Any, text: str) -> list[int]:
    encoded = tokenizer.encode(text, add_special_tokens=True)
    ids = getattr(encoded, "ids", None)
    if not isinstance(ids, list) or not ids or not all(isinstance(value, int) for value in ids):
        raise StaticActivationError("tokenizer returned invalid input IDs")
    return ids


def _frozen_keys(path: Path) -> tuple[set[str], set[str], set[str]]:
    payload = _load_object(path)
    items = payload.get("items")
    if not isinstance(items, list):
        raise StaticActivationError("frozen fixture items are missing")
    ids: set[str] = set()
    pairs: set[str] = set()
    texts: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise StaticActivationError("frozen fixture item is invalid")
        if not all(isinstance(item.get(key), str) for key in ("id", "pair_id", "text")):
            raise StaticActivationError("frozen fixture item lacks id, pair_id, or text")
        ids.add(item["id"])
        pairs.add(item["pair_id"])
        texts.add(_normal_key(item["text"]))
    return ids, pairs, texts


def select_calibration_rows(
    dataset_path: Path,
    tokenizer: Any,
    *,
    fixture_path: Path | None = None,
    count: int = CALIBRATION_ROWS,
    max_tokens: int = CALIBRATION_MAX_TOKENS,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Select a stable, text-free calibration feed from development data."""
    if count <= 0 or max_tokens <= 0:
        raise StaticActivationError("calibration count and token limit must be positive")
    payload = _load_object(dataset_path)
    if payload.get("schema_version") != "jwtd-v1":
        raise StaticActivationError("unsupported calibration dataset schema")
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("source_split") != "train":
        raise StaticActivationError("calibration data must come from the train split")
    items = payload.get("items")
    if not isinstance(items, list):
        raise StaticActivationError("calibration dataset items are missing")
    frozen_ids, frozen_pairs, frozen_texts = (set(), set(), set())
    if fixture_path is not None:
        frozen_ids, frozen_pairs, frozen_texts = _frozen_keys(fixture_path)
    enable_truncation = getattr(tokenizer, "enable_truncation", None)
    no_padding = getattr(tokenizer, "no_padding", None)
    if not callable(enable_truncation) or not callable(no_padding):
        raise StaticActivationError("tokenizer must support truncation and no_padding")
    enable_truncation(max_length=max_tokens, strategy="longest_first", direction="right")
    no_padding()
    candidates = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise StaticActivationError("calibration item has no string id")
        identity = item["id"]
        if identity in seen:
            raise StaticActivationError("duplicate calibration item id")
        seen.add(identity)
        pair_id = item.get("pair_id")
        text = item.get("text")
        if not isinstance(pair_id, str) or not isinstance(text, str):
            raise StaticActivationError("calibration item schema is invalid")
        if item.get("source_split") != "train":
            raise StaticActivationError("every calibration item must come from train")
        ids = _tokenizer_encoding(tokenizer, text)
        candidates.append((hashlib.sha256(identity.encode("utf-8")).hexdigest(), identity, ids))
    candidates.sort(key=lambda value: value[0])
    selected = candidates[:count]
    if len(selected) != count:
        raise StaticActivationError(
            f"only {len(selected)} calibration rows satisfy the fixed selection constraints"
        )
    overlaps = [
        identity
        for _, identity, _ in selected
        if identity in frozen_ids
        or any(item.get("pair_id") in frozen_pairs for item in items if item.get("id") == identity)
    ]
    # Text normalization is checked by looking up the selected source records,
    # rather than carrying source text into the calibration feed.
    overlaps.extend(
        identity
        for _, identity, _ in selected
        if any(
            item.get("id") == identity and _normal_key(item.get("text", "")) in frozen_texts
            for item in items
        )
    )
    if overlaps:
        raise StaticActivationError("calibration rows overlap frozen fixture")
    too_long = [identity for _, identity, ids in selected if len(ids) > max_tokens]
    if too_long:
        raise StaticActivationError("selected calibration row exceeds token limit")
    rows = [
        {
            "id": identity,
            "input_ids": np.asarray([ids], dtype=np.int64),
            "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
            "token_count": len(ids),
        }
        for _, identity, ids in selected
    ]
    selected_ids = json.dumps(
        [row["id"] for row in rows], ensure_ascii=False, separators=(",", ":")
    )
    return rows, {
        "selected_count": len(rows),
        "selected_ids_sha256": _hash_bytes(selected_ids.encode("utf-8")),
        "max_tokens": max_tokens,
        "padding": False,
        "dataset_sha256": sha256_file(dataset_path),
        "frozen_ids_sha256": _hash_bytes(
            json.dumps(sorted(frozen_ids), separators=(",", ":")).encode("utf-8")
        ),
        "overlap_counts": {"id": 0, "pair": 0, "normalized_text": 0},
        "feeds_sha256": _hash_bytes(
            json.dumps(
                [
                    {
                        "id": r["id"],
                        "input_ids": r["input_ids"].tolist(),
                        "attention_mask": r["attention_mask"].tolist(),
                    }
                    for r in rows
                ],
                separators=(",", ":"),
            ).encode("utf-8")
        ),
    }


def instrument_dql_inputs(
    model: Any, *, expected_path_count: int | None = 42
) -> tuple[Any, tuple[str, ...]]:
    """Expose every unique DQL input as a temporary graph output."""
    names = []
    existing = {output.name for output in model.graph.output}
    for node in _dql_nodes(model, expected_path_count=expected_path_count):
        name = node.input[0]
        if name not in names:
            names.append(name)
    for name in names:
        if name not in existing:
            value_info = next(
                (
                    candidate
                    for candidate in (
                        *model.graph.input,
                        *model.graph.value_info,
                        *model.graph.output,
                    )
                    if candidate.name == name
                ),
                None,
            )
            if value_info is None:
                raise StaticActivationError(f"DQL input has no type metadata: {name}")
            model.graph.output.append(copy.deepcopy(value_info))
    return model, tuple(names)


def _validate_runtime_float(name: str, metadata: Any, values: Any) -> np.ndarray:
    """Validate ORT metadata and raw output before numeric aggregation."""
    raw = np.asarray(values)
    if getattr(metadata, "type", None) != "tensor(float)":
        raise StaticActivationError(f"DQL capture metadata is not tensor(float): {name}")
    shape = getattr(metadata, "shape", None)
    if not isinstance(shape, list) or raw.ndim != len(shape) or raw.size == 0:
        raise StaticActivationError(f"DQL capture shape is invalid: {name}")
    for expected, actual in zip(shape, raw.shape, strict=True):
        if isinstance(expected, int) and expected >= 0 and expected != actual:
            raise StaticActivationError(f"DQL capture shape mismatch: {name}")
    if raw.dtype != np.dtype(np.float32) or not np.isfinite(raw).all():
        raise StaticActivationError(f"DQL capture dtype or finite check failed: {name}")
    return raw


def _validate_session_inputs(session: Any, feeds: dict[str, Any]) -> None:
    get_inputs = getattr(session, "get_inputs", None)
    if not callable(get_inputs):
        raise StaticActivationError("runtime input metadata is unavailable")
    fields = list(get_inputs())
    if len(fields) != 2 or {f.name for f in fields} != {"input_ids", "attention_mask"}:
        raise StaticActivationError("runtime input names do not match calibration feeds")
    shape = None
    for field in fields:
        raw = np.asarray(feeds.get(field.name))
        if (
            field.type != "tensor(int64)"
            or raw.dtype != np.int64
            or raw.ndim != 2
            or raw.shape[0] != 1
            or raw.shape[1] == 0
            or len(field.shape) != 2
        ):
            raise StaticActivationError("runtime input dtype or rank mismatch")
        if any(
            isinstance(d, int) and d >= 0 and d != actual
            for d, actual in zip(field.shape, raw.shape, strict=True)
        ):
            raise StaticActivationError("runtime input shape mismatch")
        if shape is not None and raw.shape != shape:
            raise StaticActivationError("runtime input feed shapes disagree")
        shape = raw.shape


def collect_activation_ranges(
    model_path: Path,
    rows: list[dict[str, Any]],
    *,
    session_factory: Callable[[Path], Any] | None = None,
    work_dir: Path | None = None,
    expected_path_count: int | None = 42,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Measure DQL input ranges on the original dynamic graph."""
    import onnx

    if not rows:
        raise StaticActivationError("calibration rows are empty")
    model = _load_model(model_path)
    model, names = instrument_dql_inputs(model, expected_path_count=expected_path_count)
    if work_dir is None:
        temporary = tempfile.TemporaryDirectory(prefix="kotoba-static-")
        work_dir = Path(temporary.name)
    else:
        temporary = None
        work_dir.mkdir(parents=True, exist_ok=True)
    instrumented_path = work_dir / "instrumented.onnx"
    _refuse_output(model_path, instrumented_path, work_dir / "capture-reserved.json")
    runtime_version = "injected session factory"
    if session_factory is None:
        import onnxruntime as ort

        runtime_version = ort.__version__
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session_factory = lambda path: ort.InferenceSession(  # noqa: E731
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
    session = None
    baseline_session = None
    try:
        onnx.checker.check_model(model)
        with instrumented_path.open("xb") as stream:
            stream.write(model.SerializeToString())
        session = session_factory(instrumented_path)
        baseline_session = session_factory(model_path)
        output_metadata = {output.name: output for output in session.get_outputs()}
        output_names = list(output_metadata)
        if any(name not in output_names for name in names):
            raise StaticActivationError("instrumented session did not expose all DQL inputs")
        baseline_metadata = list(baseline_session.get_outputs())
        if not baseline_metadata:
            raise StaticActivationError("baseline session has no outputs")
        baseline_metadata_by_name = {output.name: output for output in baseline_metadata}
        baseline_names = set(baseline_metadata_by_name)
        baseline_name = "logits" if "logits" in baseline_names else baseline_metadata[0].name
        if baseline_name not in output_metadata:
            raise StaticActivationError("instrumented session does not expose baseline logits")
        if getattr(baseline_metadata_by_name[baseline_name], "type", None) != "tensor(float)":
            raise StaticActivationError("baseline logits metadata is not tensor(float)")
        ranges: dict[str, dict[str, Any]] = {
            name: {"minimum": math.inf, "maximum": -math.inf, "values": 0} for name in names
        }
        augmentation_delta = None
        for row_index, row in enumerate(rows):
            feeds = {"input_ids": row["input_ids"], "attention_mask": row["attention_mask"]}
            _validate_session_inputs(session, feeds)
            outputs = session.run(output_names, feeds)
            by_name = dict(zip(output_names, outputs, strict=True))
            if row_index == 0:
                _validate_session_inputs(baseline_session, feeds)
                baseline_values = np.asarray(baseline_session.run([baseline_name], feeds)[0])
                augmented_logits = np.asarray(by_name.get(baseline_name))
                if (
                    baseline_values.size == 0
                    or augmented_logits.size == 0
                    or baseline_values.dtype != np.float32
                    or augmented_logits.dtype != np.float32
                    or baseline_values.shape != augmented_logits.shape
                    or not np.isfinite(baseline_values).all()
                    or not np.isfinite(augmented_logits).all()
                    or float(np.max(np.abs(baseline_values - augmented_logits))) > 0.001
                ):
                    raise StaticActivationError("instrumented graph changed first-row logits")
                augmentation_delta = float(np.max(np.abs(baseline_values - augmented_logits)))
            for name in names:
                values = _validate_runtime_float(name, output_metadata[name], by_name[name])
                item = ranges[name]
                item["minimum"] = min(item["minimum"], float(values.min()))
                item["maximum"] = max(item["maximum"], float(values.max()))
                item["values"] += int(values.size)
        for _name, item in ranges.items():
            item["scale"], item["zero_point"] = compute_quantization_params(
                item["minimum"], item["maximum"]
            )
        return ranges, {
            "dql_input_count": len(names),
            "rows": len(rows),
            "runtime": "onnxruntime-cpu",
            "onnxruntime": runtime_version,
            "graph_optimization": "ORT_DISABLE_ALL",
            "threads": {"intra": 1, "inter": 1},
            "first_row_augmentation_max_abs_delta": augmentation_delta,
            "captured_dtype": "float32",
            "instrumented_graph_sha256": sha256_file(instrumented_path),
        }
    finally:
        failures = []
        for current in (session, baseline_session):
            release = getattr(current, "release", None)
            if callable(release):
                try:
                    release()
                except Exception as exc:
                    failures.append(exc)
        if temporary is not None:
            try:
                temporary.cleanup()
            except Exception as exc:
                failures.append(exc)
        if failures:
            active = sys.exception()
            if isinstance(active, Exception):
                failures.insert(0, active)
            raise ExceptionGroup("activation capture cleanup failed", failures)


def _refuse_output(source: Path, output: Path, manifest: Path) -> None:
    source_resolved = source.resolve()
    output_resolved = output.resolve()
    manifest_resolved = manifest.resolve()
    if output_resolved == source_resolved or manifest_resolved in {
        source_resolved,
        output_resolved,
    }:
        raise StaticActivationError("output paths must differ from source and each other")
    if output.exists() or manifest.exists():
        raise StaticActivationError("output or manifest already exists")
    if output_resolved.name.lower() == "manifest.json":
        raise StaticActivationError("output name collides with manifest")
    root = Path(__file__).resolve().parents[1]
    for canonical in (
        root / "models" / "converted",
        root / "models" / "upstream",
        root / "dist" / "extension" / "models",
    ):
        for candidate in (output_resolved, manifest_resolved):
            try:
                candidate.relative_to(canonical.resolve())
            except ValueError:
                continue
            raise StaticActivationError("output must be outside canonical model directories")


def _graph_consumers(graph: Any, value: str) -> list[Any]:
    return [node for node in graph.node if value in node.input]


def _bind_integer_paths(graph: Any, dql_nodes: list[Any]) -> list[dict[str, Any]]:
    """Bind every activation to its own integer output and affine scaling."""
    from onnx import TensorProto, numpy_helper

    initializers = {item.name: item for item in graph.initializer}

    def consumer(value: str, op: str) -> Any:
        nodes = _graph_consumers(graph, value)
        if len(nodes) != 1 or nodes[0].op_type != op or nodes[0].domain:
            raise StaticActivationError(f"ambiguous {op} consumer binding: {value}")
        return nodes[0]

    bindings = []
    for dql in dql_nodes:
        q, scale, zero = dql.output
        mmi = consumer(q, "MatMulInteger")
        if (
            len(mmi.input) != 4
            or len(mmi.output) != 1
            or mmi.input[0] != q
            or mmi.input[2] != zero
            or consumer(zero, "MatMulInteger").name != mmi.name
        ):
            raise StaticActivationError("integer activation/zero-point binding mismatch")
        combined = consumer(scale, "Mul")
        if len(combined.input) != 2 or len(combined.output) != 1:
            raise StaticActivationError("activation scale binding mismatch")
        weight_scale_name = next((n for n in combined.input if n != scale), None)
        weight = initializers.get(mmi.input[1])
        weight_zero = initializers.get(mmi.input[3])
        weight_scale = initializers.get(weight_scale_name)
        if (
            weight is None
            or weight.data_type != TensorProto.UINT8
            or len(weight.dims) != 2
            or weight_zero is None
            or weight_zero.data_type != TensorProto.UINT8
            or weight_scale is None
            or weight_scale.data_type != TensorProto.FLOAT
        ):
            raise StaticActivationError("integer weight/scale/zero-point binding mismatch")
        width = weight.dims[1]
        if list(weight_scale.dims) not in ([], [width]) or list(weight_zero.dims) not in (
            [],
            [width],
        ):
            raise StaticActivationError("integer weight parameter shape binding mismatch")
        scales = numpy_helper.to_array(weight_scale)
        if not np.isfinite(scales).all() or (scales <= 0).any():
            raise StaticActivationError("integer weight scale binding is invalid")
        cast = consumer(mmi.output[0], "Cast")
        if len(cast.output) != 1 or not any(
            attr.name == "to" and attr.i == TensorProto.FLOAT for attr in cast.attribute
        ):
            raise StaticActivationError("integer output Cast binding mismatch")
        output = consumer(cast.output[0], "Mul")
        if (
            len(output.output) != 1
            or len(output.input) != 2
            or set(output.input) != {cast.output[0], combined.output[0]}
            or consumer(combined.output[0], "Mul").name != output.name
        ):
            raise StaticActivationError("integer output scale binding mismatch")
        bindings.append(
            {
                "dql": dql.name,
                "activation": dql.input[0],
                "quantized": q,
                "scale": scale,
                "zero_point": zero,
                "matmul_integer": mmi.name,
                "weight": weight.name,
                "weight_scale": weight_scale.name,
                "weight_zero_point": weight_zero.name,
                "output": output.output[0],
            }
        )
    if len({binding["matmul_integer"] for binding in bindings}) != len(dql_nodes):
        raise StaticActivationError("integer paths share a MatMulInteger binding")
    return bindings


def _rewrite_nodes(
    model: Any, ranges: dict[str, dict[str, Any]], *, expected_path_count: int | None = 42
) -> dict[str, Any]:
    import onnx
    from onnx import helper, numpy_helper

    dql = _dql_nodes(model, expected_path_count=expected_path_count)
    bindings = _bind_integer_paths(model.graph, dql)
    mmi_count = sum(node.op_type == "MatMulInteger" for node in model.graph.node)
    if expected_path_count is not None and mmi_count != expected_path_count:
        raise StaticActivationError(
            f"expected {expected_path_count} MatMulInteger nodes, found {mmi_count}"
        )
    initializers = {item.name for item in model.graph.initializer}
    replacement_by_id: dict[int, Any] = {}
    for node in dql:
        item = ranges.get(node.input[0])
        if not isinstance(item, dict):
            raise StaticActivationError(f"missing activation range: {node.input[0]}")
        try:
            scale, zero_point = compute_quantization_params(
                float(item["minimum"]), float(item["maximum"])
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise StaticActivationError(f"invalid activation range: {node.input[0]}") from exc
        scale_name, zero_name = node.output[1], node.output[2]
        if scale_name in initializers or zero_name in initializers or scale_name == zero_name:
            raise StaticActivationError("DQL output initializer name collision")
        for output_name in node.output:
            if output_name != node.output[0] and not _graph_consumers(model.graph, output_name):
                raise StaticActivationError("DQL scale or zero-point output has no consumer")
        model.graph.initializer.extend(
            [
                numpy_helper.from_array(np.asarray(scale, dtype=np.float32), scale_name),
                numpy_helper.from_array(np.asarray(zero_point, dtype=np.uint8), zero_name),
            ]
        )
        replacement_by_id[id(node)] = helper.make_node(
            "QuantizeLinear",
            [node.input[0], scale_name, zero_name],
            [node.output[0]],
            name=f"{node.name}_static",
        )
        item.update({"scale": scale, "zero_point": zero_point})
    original_nodes = list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend(replacement_by_id.get(id(node), node) for node in original_nodes)
    try:
        onnx.checker.check_model(model)
    except Exception as exc:  # noqa: BLE001
        raise StaticActivationError("static graph failed ONNX validation") from exc
    return {
        "paths": bindings,
        "dynamic_quantize_linear_before": len(dql),
        "dynamic_quantize_linear_after": sum(
            node.op_type == "DynamicQuantizeLinear" for node in model.graph.node
        ),
        "quantize_linear_after": sum(node.op_type == "QuantizeLinear" for node in model.graph.node),
        "matmul_integer_after": sum(node.op_type == "MatMulInteger" for node in model.graph.node),
    }


def rewrite_static_graph(
    model: Any, ranges: dict[str, dict[str, Any]], *, expected_path_count: int | None = 42
) -> dict[str, Any]:
    return _rewrite_nodes(model, ranges, expected_path_count=expected_path_count)


def convert_static_activations(
    source_path: Path,
    output_path: Path,
    manifest_path: Path,
    ranges: dict[str, dict[str, Any]],
    *,
    expected_source_sha: str,
    selected_rows_summary: dict[str, Any] | None = None,
    source_revision: str = MODEL_REVISION,
    expected_path_count: int | None = 42,
) -> dict[str, Any]:
    """Write a new candidate graph and a provenance manifest."""
    if len(expected_source_sha) != 64 or any(
        char not in "0123456789abcdef" for char in expected_source_sha
    ):
        raise StaticActivationError("source SHA-256 must be lowercase hexadecimal")
    if sha256_file(source_path) != expected_source_sha:
        raise StaticActivationError("source SHA-256 does not match")
    _refuse_output(source_path, output_path, manifest_path)
    source_commit = os.environ.get("SOURCE_COMMIT", "")
    import re

    if not re.fullmatch(_SOURCE_COMMIT_RE, source_commit):
        raise StaticActivationError("SOURCE_COMMIT must be a 40-character commit SHA")
    model = _load_model(source_path)
    source_dql_names = {
        node.name for node in _dql_nodes(model, expected_path_count=expected_path_count)
    }
    before_nodes = {node.name: node.SerializeToString() for node in model.graph.node}
    before_initializers = {item.name: item.SerializeToString() for item in model.graph.initializer}
    counts = rewrite_static_graph(model, ranges, expected_path_count=expected_path_count)
    after_nodes = {node.name: node.SerializeToString() for node in model.graph.node}
    after_initializers = {item.name: item.SerializeToString() for item in model.graph.initializer}
    unchanged_nodes = all(
        after_nodes.get(name) == value
        for name, value in before_nodes.items()
        if name not in source_dql_names
    )
    unchanged_initializers = all(
        after_initializers.get(name) == value for name, value in before_initializers.items()
    )
    if not unchanged_nodes or not unchanged_initializers:
        raise StaticActivationError("static conversion changed a protected graph component")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    import onnx

    onnx.save(model, str(output_path))
    manifest = {
        "schema_version": "static-activation-v1",
        "method": "fixed_scalar_minmax_from_quint8_dql_inputs",
        "model_revision": source_revision,
        "source_model_sha256": expected_source_sha,
        "output_model_sha256": sha256_file(output_path),
        "output_bytes": output_path.stat().st_size,
        "source_commit": source_commit,
        "calibration": selected_rows_summary or {},
        "ranges": {
            name: {
                key: value
                for key, value in item.items()
                if key in {"minimum", "maximum", "scale", "zero_point", "values"}
            }
            for name, item in sorted(ranges.items())
        },
        "graph_counts": counts,
        "runtime_compatibility": "not verified",
        "tool_versions": {
            "python": platform.python_version(),
            "onnx": onnx.__version__,
            "numpy": np.__version__,
            "onnxruntime": (selected_rows_summary or {})
            .get("runtime", {})
            .get("onnxruntime", "not used"),
        },
        "source_node_count": len(before_nodes),
        "invariants": {
            "non_dql_nodes_unchanged": unchanged_nodes,
            "original_initializers_unchanged": unchanged_initializers,
            "embedding_initializers_unchanged": unchanged_initializers,
            "embedding_proof": "all original initializers and all non-DQL nodes unchanged",
            "non_dql_fingerprint_before": _fingerprint_named(
                {
                    name: value
                    for name, value in before_nodes.items()
                    if name not in source_dql_names
                }
            ),
            "non_dql_fingerprint_after": _fingerprint_named(
                {name: after_nodes[name] for name in before_nodes if name not in source_dql_names}
            ),
            "original_initializer_fingerprint": _fingerprint_named(before_initializers),
            "protected_initializer_fingerprint_after": _fingerprint_named(
                {name: after_initializers[name] for name in before_initializers}
            ),
        },
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument(
        "--dataset-manifest",
        type=Path,
        default=PROJECT_ROOT / "artifacts" / "corpus" / "jwtd-v1" / "manifest.json",
    )
    parser.add_argument(
        "--frozen-fixture",
        type=Path,
        default=PROJECT_ROOT / "artifacts" / "corpus-browser" / "jwtd-browser-v1-tokenids.json",
    )
    parser.add_argument(
        "--protocol",
        type=Path,
        default=PROJECT_ROOT / "benchmarks" / "protocols" / "jwtd-browser-v1.json",
    )
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--count", type=int, default=CALIBRATION_ROWS)
    parser.add_argument("--max-tokens", type=int, default=CALIBRATION_MAX_TOKENS)
    return parser


def _validate_source_checkout(source_commit: str) -> dict[str, Any]:
    command = ["git", "-c", f"safe.directory={PROJECT_ROOT.as_posix()}"]
    try:
        head = subprocess.run(
            command + ["rev-parse", "HEAD"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            command + ["status", "--porcelain"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise StaticActivationError("Git source verification failed") from exc
    if head != source_commit:
        raise StaticActivationError("source commit does not match checkout HEAD")
    if status:
        raise StaticActivationError("source checkout must be clean")
    return {"commit": head, "clean": True}


def _validate_cli_inputs(args: argparse.Namespace, manifest_path: Path) -> dict[str, Any]:
    paths = (
        args.model,
        args.dataset,
        args.tokenizer,
        args.dataset_manifest,
        args.frozen_fixture,
        args.protocol,
    )
    if any(not path.is_file() for path in paths):
        raise StaticActivationError(
            "all calibration, protocol, tokenizer, and model inputs must exist"
        )
    if args.count != CALIBRATION_ROWS or args.max_tokens != CALIBRATION_MAX_TOKENS:
        raise StaticActivationError(
            "production calibration requires exactly 64 rows and 128 tokens"
        )
    if args.source_sha256 != REGISTERED_MODEL_SHA256:
        raise StaticActivationError("source SHA-256 is not the preregistered distribution model")
    source_commit = os.environ.get("SOURCE_COMMIT", "")
    import re

    if not re.fullmatch(_SOURCE_COMMIT_RE, source_commit):
        raise StaticActivationError("SOURCE_COMMIT must be a 40-character commit SHA")
    checkout = _validate_source_checkout(source_commit)
    if sha256_file(args.model) != REGISTERED_MODEL_SHA256:
        raise StaticActivationError("model SHA-256 does not match preregistered distribution model")
    if sha256_file(args.dataset) != REGISTERED_DATASET_SHA256:
        raise StaticActivationError("dataset SHA-256 does not match preregistered development data")
    if sha256_file(args.dataset_manifest) != REGISTERED_DATASET_MANIFEST_SHA256:
        raise StaticActivationError("dataset manifest SHA-256 does not match preregistration")
    if sha256_file(args.frozen_fixture) != REGISTERED_FIXTURE_SHA256:
        raise StaticActivationError("frozen fixture SHA-256 does not match preregistration")
    if sha256_file(args.protocol) != REGISTERED_PROTOCOL_SHA256:
        raise StaticActivationError("protocol SHA-256 does not match preregistration")
    tokenizer_config = args.tokenizer.with_name("tokenizer_config.json")
    if sha256_file(args.tokenizer) != REGISTERED_TOKENIZER_SHA256:
        raise StaticActivationError("tokenizer SHA-256 does not match preregistration")
    if (
        not tokenizer_config.is_file()
        or sha256_file(tokenizer_config) != REGISTERED_TOKENIZER_CONFIG_SHA256
    ):
        raise StaticActivationError("tokenizer config SHA-256 does not match preregistration")
    dataset_manifest = _load_object(args.dataset_manifest)
    outputs = dataset_manifest.get("outputs")
    if (
        not isinstance(outputs, dict)
        or outputs.get("development.json", {}).get("sha256") != REGISTERED_DATASET_SHA256
    ):
        raise StaticActivationError("dataset manifest does not bind the development fixture")
    protocol = _load_object(args.protocol)
    if protocol.get("model_revision") != MODEL_REVISION:
        raise StaticActivationError("protocol model revision mismatch")
    _refuse_output(args.model, args.output, manifest_path)
    return {
        "checkout": checkout,
        "source_commit": source_commit,
        "model_sha256": sha256_file(args.model),
        "dataset_sha256": sha256_file(args.dataset),
        "dataset_manifest_sha256": sha256_file(args.dataset_manifest),
        "tokenizer_sha256": sha256_file(args.tokenizer),
        "tokenizer_config_sha256": sha256_file(tokenizer_config),
        "frozen_fixture_sha256": sha256_file(args.frozen_fixture),
        "protocol_sha256": sha256_file(args.protocol),
    }


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        manifest_path = args.manifest or args.output.with_name("manifest.json")
        input_provenance = _validate_cli_inputs(args, manifest_path)
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(args.tokenizer))
        rows, selection = select_calibration_rows(
            args.dataset,
            tokenizer,
            fixture_path=args.frozen_fixture,
            count=args.count,
            max_tokens=args.max_tokens,
        )
        ranges, runtime = collect_activation_ranges(args.model, rows)
        selection["runtime"] = runtime
        _validate_source_checkout(os.environ["SOURCE_COMMIT"])
        selection["input_provenance"] = input_provenance
        manifest = convert_static_activations(
            args.model,
            args.output,
            manifest_path,
            ranges,
            expected_source_sha=args.source_sha256,
            selected_rows_summary=selection,
        )
    except (StaticActivationError, OSError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        return 2
    print(
        json.dumps(
            {
                "status": "completed",
                "selected_count": selection["selected_count"],
                "dql_inputs": runtime["dql_input_count"],
                "output_model_sha256": manifest["output_model_sha256"],
                "output_bytes": manifest["output_bytes"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
