"""Capture a bounded QOperator profile for CPU/browser parity diagnosis.

The diagnostic operates on a scratch copy of the pinned sanitized QUInt8 model.
It exposes only pre-registered graph values, keeping the canonical model and
the frozen corpus intact. The default remains the first quantized pair.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import platform
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "dist" / "extension" / "models" / "onnx" / "model_quantized.onnx"
DEFAULT_FIXTURE = ROOT / "artifacts" / "corpus-browser" / "jwtd-browser-v1-tokenids.json"
DEFAULT_BASELINE = (
    ROOT
    / "artifacts"
    / "wasm-optimizer"
    / "7db627156a76f9968e0eecf8b2f27849d7351b4a"
    / "all-tokenids.json"
)
DEFAULT_OUTPUT_ROOT = ROOT / ".cache" / "quantized-intermediate-diagnostic"

MODEL_SHA256 = "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab"
FIXTURE_SHA256 = "4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47"
BASELINE_REPORT_SHA256 = "2c96e17044c61e865c8b7f9751867dc6520f90c4473b826194974b5a933533d9"
LOGIT_GATE = 0.001

INTERMEDIATE_OUTPUTS = (
    "layer_norm",
    "layer_norm_quantized",
    "layer_norm_scale",
    "layer_norm_zero_point",
    "linear_output_quantized",
    "linear_output_quantized_cast_output",
    "node_linear_quant_scales_mul:0",
    "linear",
)
BLOCK_BOUNDARY_OUTPUTS = tuple(f"add_{index}" for index in range(7, 44, 4))
CAPTURE_PROFILES = (
    "first-pair",
    "block-boundaries",
    "classifier",
    *(f"block-{i}" for i in range(10)),
)


def _profile_source_name(path_index: int) -> str:
    if path_index == 0:
        return "layer_norm"
    if path_index == 1:
        return "view_2"
    if path_index == 2:
        return "layer_norm_1"
    if path_index == 3:
        return "mul_29"
    if path_index == 40:
        return "layer_norm_20"
    if path_index == 41:
        return "layer_norm_21"
    block, offset = divmod(path_index, 4)
    if offset == 0:
        return f"layer_norm_{2 * block}"
    if offset == 1:
        return f"view_{3 * block + 2}"
    if offset == 2:
        return f"layer_norm_{2 * block + 1}"
    return f"mul_{24 * block + 29}"


def _profile_expected_names(profile: str) -> tuple[str, ...] | None:
    if profile == "first-pair":
        return INTERMEDIATE_OUTPUTS
    if profile == "block-boundaries":
        return BLOCK_BOUNDARY_OUTPUTS
    if profile == "classifier":
        indices = (40, 41)
    elif profile.startswith("block-"):
        block = int(profile.removeprefix("block-"))
        indices = tuple(range(block * 4, block * 4 + 4))
    else:
        return None
    names: list[str] = []
    for path_index in indices:
        source = _profile_source_name(path_index)
        if path_index == 41:
            scale = "node_MatMul_1201_quant_scales_mul:0"
            integer = "val_1245_output_quantized"
            cast = "val_1245_output_quantized_cast_output"
            linear = "val_1245"
        else:
            suffix = "" if path_index == 0 else f"_{path_index}"
            scale = f"node_linear{suffix}_quant_scales_mul:0"
            integer = f"linear{suffix}_output_quantized"
            cast = f"linear{suffix}_output_quantized_cast_output"
            linear = f"linear{suffix}"
        names.extend(
            [
                source,
                f"{source}_quantized",
                f"{source}_scale",
                f"{source}_zero_point",
                scale,
                integer,
                cast,
                linear,
            ]
        )
    return tuple(names)


class DiagnosticError(RuntimeError):
    """Raised when the diagnostic cannot produce trustworthy evidence."""


@dataclass(frozen=True)
class SelectedRow:
    index: int
    row_id: str
    input_ids: tuple[int, ...]
    attention_mask: tuple[int, ...]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require_file(path: Path, description: str) -> None:
    if not path.is_file():
        raise DiagnosticError(f"{description} is missing")


def _require_hash(path: Path, expected: str, description: str) -> str:
    _require_file(path, description)
    actual = sha256_file(path)
    if actual != expected.lower():
        raise DiagnosticError(f"{description} SHA-256 does not match the pinned input")
    return actual


def _require_new_output(path: Path, description: str) -> None:
    if path.exists():
        raise DiagnosticError(f"{description} already exists; refusing overwrite")
    path.parent.mkdir(parents=True, exist_ok=True)


def _read_object(path: Path, description: str) -> dict[str, Any]:
    _require_file(path, description)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DiagnosticError(f"{description} is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise DiagnosticError(f"{description} must contain a JSON object")
    return value


def _select_first_failed_row(
    fixture_path: Path,
    baseline_path: Path,
    *,
    expected_fixture_sha: str = FIXTURE_SHA256,
    expected_baseline_sha: str = BASELINE_REPORT_SHA256,
) -> SelectedRow:
    _require_hash(fixture_path, expected_fixture_sha, "browser fixture")
    _require_hash(baseline_path, expected_baseline_sha, "baseline parity report")
    fixture = _read_object(fixture_path, "browser fixture")
    baseline = _read_object(baseline_path, "baseline parity report")
    items = fixture.get("items")
    rows = baseline.get("rows")
    if not isinstance(items, list) or not isinstance(rows, list) or not items or not rows:
        raise DiagnosticError("fixture and baseline report must contain nonempty rows")
    fixture_by_id = {
        item.get("id"): (index, item)
        for index, item in enumerate(items)
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise DiagnosticError("baseline row identity is invalid")
        delta = row.get("max_abs_logit_delta")
        if isinstance(delta, bool) or not isinstance(delta, (int, float)) or not np.isfinite(delta):
            raise DiagnosticError("baseline row logit delta is invalid")
        if delta <= LOGIT_GATE:
            continue
        row_id = row["id"]
        item_entry = fixture_by_id.get(row_id)
        if item_entry is None:
            raise DiagnosticError("baseline row is absent from the pinned fixture")
        index, item = item_entry
        input_ids = item.get("expected_input_ids")
        attention_mask = item.get("expected_attention_mask")
        if (
            not isinstance(input_ids, list)
            or not isinstance(attention_mask, list)
            or len(input_ids) == 0
            or len(input_ids) != len(attention_mask)
            or any(
                isinstance(value, bool) or not isinstance(value, int) or value < 0
                for value in input_ids
            )
            or any(value not in (0, 1) for value in attention_mask)
        ):
            raise DiagnosticError("selected fixture tokenizer arrays are invalid")
        return SelectedRow(index, row_id, tuple(input_ids), tuple(attention_mask))
    raise DiagnosticError("baseline report has no row beyond the fixed logit gate")


def _value_info_map(model: Any) -> dict[str, Any]:
    values = list(model.graph.value_info) + list(model.graph.input) + list(model.graph.output)
    return {value.name: value for value in values}


def _profile_output_names(model: Any, capture_profile: str) -> tuple[str, ...]:
    if capture_profile not in CAPTURE_PROFILES:
        raise DiagnosticError(f"unsupported capture profile: {capture_profile}")
    values = _value_info_map(model)
    if capture_profile in {"first-pair", "block-boundaries"}:
        names = list(_profile_expected_names(capture_profile) or ())
        if capture_profile == "block-boundaries":
            for name in names:
                additions = [
                    node
                    for node in model.graph.node
                    if node.op_type == "Add" and name in node.output
                ]
                boundary_index = int(name.removeprefix("add_"))
                expected_inputs = {
                    f"add_{boundary_index - 1}",
                    f"linear_{boundary_index - 4}",
                }
                if len(additions) != 1 or set(additions[0].input) != expected_inputs:
                    raise DiagnosticError("capture boundary is not a residual Add")
    else:
        quantized = [node for node in model.graph.node if node.op_type == "MatMulInteger"]
        if len(quantized) != 42:
            raise DiagnosticError("capture profile requires exactly 42 MatMulInteger nodes")
        if capture_profile == "classifier":
            path_indices = (40, 41)
        else:
            block = int(capture_profile.removeprefix("block-"))
            path_indices = tuple(range(block * 4, block * 4 + 4))
        producers = {
            output: (index, output_index, node)
            for index, node in enumerate(model.graph.node)
            for output_index, output in enumerate(node.output)
        }
        initializers = {initializer.name: initializer for initializer in model.graph.initializer}
        names = []
        for path_index in path_indices:
            matmul = quantized[path_index]
            if len(matmul.input) < 1 or len(matmul.output) != 1:
                raise DiagnosticError("capture profile MatMulInteger binding is invalid")
            quantized_input = matmul.input[0]
            dql_entry = producers.get(quantized_input)
            if dql_entry is None or dql_entry[2].op_type != "DynamicQuantizeLinear":
                raise DiagnosticError("capture profile DQL binding is invalid")
            dql = dql_entry[2]
            if len(dql.input) != 1 or len(dql.output) != 3:
                raise DiagnosticError("capture profile DQL arity is invalid")
            if len(matmul.input) != 4 or matmul.input[2] != dql.output[2]:
                raise DiagnosticError("capture profile zero-point binding is invalid")
            if any(
                matmul.input[index] not in initializers
                or initializers[matmul.input[index]].data_type != 2
                for index in (1, 3)
            ):
                raise DiagnosticError("capture profile quantized initializer dtype is invalid")
            cast_entry = next(
                (
                    (index, node)
                    for index, node in enumerate(model.graph.node)
                    if (
                        node.op_type == "Cast"
                        and matmul.output[0] in node.input
                        and len(node.output) == 1
                    )
                ),
                None,
            )
            if cast_entry is None:
                raise DiagnosticError("capture profile cast binding is invalid")
            cast = cast_entry[1]
            to_attributes = [
                attribute for attribute in getattr(cast, "attribute", []) if attribute.name == "to"
            ]
            if len(to_attributes) != 1 or to_attributes[0].i != 1:
                raise DiagnosticError("capture profile Cast must produce FLOAT")
            final_candidates = []
            for index, node in enumerate(model.graph.node):
                if (
                    node.op_type != "Mul"
                    or cast.output[0] not in node.input
                    or len(node.output) != 1
                ):
                    continue
                for other_input in node.input:
                    if other_input == cast.output[0]:
                        continue
                    candidate = producers.get(other_input)
                    if (
                        candidate
                        and candidate[2].op_type == "Mul"
                        and dql.output[1] in candidate[2].input
                    ):
                        final_candidates.append((candidate, (index, node)))
                        break
            if len(final_candidates) != 1:
                raise DiagnosticError("capture profile scale or linear binding is invalid")
            combined_entry, final_entry = final_candidates[0]
            names.extend(
                [
                    dql.input[0],
                    *dql.output,
                    matmul.output[0],
                    cast.output[0],
                    combined_entry[2].output[0],
                    final_entry[1].output[0],
                ]
            )
        names = sorted(
            set(names),
            key=lambda name: producers.get(name, (-1, -1, None))[:2],
        )
    missing = [name for name in names if name not in values]
    if missing:
        description = (
            "required intermediate value is missing"
            if capture_profile == "first-pair"
            else "capture profile value is missing"
        )
        raise DiagnosticError(f"{description}: {missing[0]}")
    if len(names) != len(set(names)):
        raise DiagnosticError("capture profile contains duplicate outputs")
    return tuple(names)


def augment_intermediate_outputs(
    source_path: Path, output_path: Path, capture_profile: str = "first-pair"
) -> Path:
    """Add the selected profile's existing values as scratch graph outputs."""
    if source_path.resolve() == output_path.resolve():
        raise DiagnosticError("instrumented output must differ from the source model")
    _require_file(source_path, "source model")
    _require_new_output(output_path, "instrumented model")
    try:
        import onnx
        from onnx import shape_inference

        model = shape_inference.infer_shapes(
            onnx.load(str(source_path), load_external_data=False),
        )
    except Exception as exc:  # pragma: no cover - dependency-specific diagnostics
        raise DiagnosticError("source model could not be loaded for instrumentation") from exc
    values = _value_info_map(model)
    existing = {value.name for value in model.graph.output}
    names = _profile_output_names(model, capture_profile)
    missing = [name for name in names if name not in values]
    if missing:
        raise DiagnosticError(f"capture profile value is missing: {missing[0]}")
    for name in names:
        if name not in existing:
            model.graph.output.append(copy.deepcopy(values[name]))
    try:
        onnx.checker.check_model(model)
        onnx.save(model, str(output_path), save_as_external_data=False)
    except Exception as exc:  # pragma: no cover - dependency-specific diagnostics
        raise DiagnosticError("instrumented model failed ONNX validation") from exc
    return output_path


def _optimization_level(ort_module: Any, value: str) -> tuple[str, Any]:
    if value == "all":
        name = "ORT_ENABLE_ALL"
    elif value == "disabled":
        name = "ORT_DISABLE_ALL"
    else:
        raise DiagnosticError("graph optimization must be 'all' or 'disabled'")
    try:
        enum = getattr(ort_module, "GraphOptimizationLevel", ort_module)
        return name, getattr(enum, name)
    except AttributeError as exc:
        raise DiagnosticError(
            "ONNX Runtime does not expose the requested optimization level"
        ) from exc


def _session_options(ort_module: Any, graph_optimization: str) -> Any:
    option = ort_module.SessionOptions()
    option.intra_op_num_threads = 1
    option.inter_op_num_threads = 1
    _, level = _optimization_level(ort_module, graph_optimization)
    option.graph_optimization_level = level
    return option


_ORT_DTYPE_MAP = {
    "tensor(bool)": np.dtype("bool"),
    "tensor(uint8)": np.dtype("uint8"),
    "tensor(int8)": np.dtype("int8"),
    "tensor(uint16)": np.dtype("uint16"),
    "tensor(int16)": np.dtype("int16"),
    "tensor(uint32)": np.dtype("uint32"),
    "tensor(int32)": np.dtype("int32"),
    "tensor(uint64)": np.dtype("uint64"),
    "tensor(int64)": np.dtype("int64"),
    "tensor(float16)": np.dtype("float16"),
    "tensor(float)": np.dtype("float32"),
    "tensor(double)": np.dtype("float64"),
}


def _validate_runtime_output(metadata: Any, value: Any) -> np.ndarray:
    name = getattr(metadata, "name", "<unnamed>")
    expected_dtype = _ORT_DTYPE_MAP.get(getattr(metadata, "type", ""))
    if expected_dtype is None:
        raise DiagnosticError(f"runtime output {name} has unsupported metadata type")
    actual = np.asarray(value)
    if actual.dtype != expected_dtype:
        raise DiagnosticError(
            f"runtime output {name} dtype mismatch: metadata {expected_dtype}, "
            f"actual {actual.dtype}"
        )
    expected_shape = getattr(metadata, "shape", None)
    if not isinstance(expected_shape, (list, tuple)) or len(expected_shape) != actual.ndim:
        raise DiagnosticError(f"runtime output {name} rank does not match metadata")
    symbols: dict[str, int] = {}
    for index, (expected, actual_size) in enumerate(zip(expected_shape, actual.shape, strict=True)):
        if isinstance(expected, bool):
            raise DiagnosticError(f"runtime output {name} has invalid dimension metadata")
        if isinstance(expected, int):
            if expected != actual_size:
                raise DiagnosticError(f"runtime output {name} shape mismatch at dimension {index}")
            continue
        if expected is None:
            continue
        if isinstance(expected, str) and expected:
            previous = symbols.setdefault(expected, int(actual_size))
            if previous != actual_size:
                raise DiagnosticError(f"runtime output {name} symbolic dimensions disagree")
            continue
        raise DiagnosticError(f"runtime output {name} has invalid dimension metadata")
    return actual


def _run_session(
    model_path: Path,
    input_ids: tuple[int, ...],
    attention_mask: tuple[int, ...],
    graph_optimization: str,
    *,
    ort_module: Any | None = None,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    if ort_module is None:
        import onnxruntime as ort_module
    option = _session_options(ort_module, graph_optimization)
    session = ort_module.InferenceSession(
        str(model_path),
        sess_options=option,
        providers=["CPUExecutionProvider"],
    )
    metadata = list(session.get_outputs())
    names = [output.name for output in metadata]
    values = session.run(
        None,
        {
            "input_ids": np.asarray([input_ids], dtype=np.int64),
            "attention_mask": np.asarray([attention_mask], dtype=np.int64),
        },
    )
    if len(names) != len(values):
        raise DiagnosticError("runtime returned an unexpected output count")
    arrays = {
        output.name: _validate_runtime_output(output, value)
        for output, value in zip(metadata, values, strict=True)
    }
    return arrays, {"runtime": getattr(ort_module, "__version__", "unknown"), "outputs": names}


def _array_summary(reference: np.ndarray, actual: np.ndarray) -> dict[str, Any]:
    reference = np.asarray(reference)
    actual = np.asarray(actual)
    finite = bool(np.isfinite(reference).all() if reference.dtype.kind == "f" else True) and bool(
        np.isfinite(actual).all() if actual.dtype.kind == "f" else True
    )
    summary: dict[str, Any] = {
        "reference_dtype": str(reference.dtype),
        "actual_dtype": str(actual.dtype),
        "dtype_match": bool(reference.dtype == actual.dtype),
        "reference_shape": list(reference.shape),
        "actual_shape": list(actual.shape),
        "shape_match": bool(reference.shape == actual.shape),
        "finite": finite,
    }
    if not summary["shape_match"] or not summary["dtype_match"]:
        summary.update({"exact_mismatch_count": None, "first_mismatch_index": None})
        return summary
    if reference.dtype.kind in "biu" and actual.dtype.kind in "biu":
        equal = reference == actual
        mismatch = np.flatnonzero(~equal)
        summary.update(
            {
                "exact_mismatch_count": int(mismatch.size),
                "first_mismatch_index": int(mismatch[0]) if mismatch.size else None,
            }
        )
    else:
        difference = np.abs(reference.astype(np.float64) - actual.astype(np.float64))
        summary.update(
            {
                "max_abs_delta": float(np.max(difference)) if difference.size else 0.0,
                "mean_abs_delta": float(np.mean(difference)) if difference.size else 0.0,
            }
        )
    return summary


def run_cpu_diagnostic(
    model_path: Path,
    fixture_path: Path,
    baseline_path: Path,
    output_model: Path,
    output_npz: Path,
    output_report: Path,
    *,
    graph_optimization: str = "all",
    expected_model_sha: str = MODEL_SHA256,
    expected_fixture_sha: str = FIXTURE_SHA256,
    expected_baseline_sha: str = BASELINE_REPORT_SHA256,
    ort_module: Any | None = None,
    capture_profile: str = "first-pair",
) -> dict[str, Any]:
    model_sha = _require_hash(model_path, expected_model_sha, "source model")
    selected = _select_first_failed_row(
        fixture_path,
        baseline_path,
        expected_fixture_sha=expected_fixture_sha,
        expected_baseline_sha=expected_baseline_sha,
    )
    _require_new_output(output_npz, "CPU output cache")
    _require_new_output(output_report, "CPU report")
    import onnx
    from onnx import shape_inference

    names_model = shape_inference.infer_shapes(
        onnx.load(str(model_path), load_external_data=False),
    )
    capture_outputs = _profile_output_names(names_model, capture_profile)
    instrumented = augment_intermediate_outputs(model_path, output_model, capture_profile)
    if ort_module is None:
        import onnxruntime as ort_module
    level_name, level_value = _optimization_level(ort_module, graph_optimization)
    unmodified, runtime_meta = _run_session(
        model_path,
        selected.input_ids,
        selected.attention_mask,
        graph_optimization,
        ort_module=ort_module,
    )
    instrumented_values, _ = _run_session(
        instrumented,
        selected.input_ids,
        selected.attention_mask,
        graph_optimization,
        ort_module=ort_module,
    )
    if "logits" not in unmodified or "logits" not in instrumented_values:
        raise DiagnosticError("runtime logits output is missing")
    logits_reproduction = _array_summary(unmodified["logits"], instrumented_values["logits"])
    output_summaries: dict[str, Any] = {}
    failures: list[str] = []
    for name in capture_outputs:
        if name not in instrumented_values:
            failures.append(f"instrumented output missing: {name}")
            continue
        values = instrumented_values[name]
        output_summaries[name] = {
            "dtype": str(values.dtype),
            "shape": list(values.shape),
            "finite": bool(np.isfinite(values).all() if values.dtype.kind == "f" else True),
        }
        if not output_summaries[name]["finite"]:
            failures.append(f"nonfinite intermediate: {name}")
    if (
        not logits_reproduction["shape_match"]
        or not logits_reproduction["dtype_match"]
        or not logits_reproduction["finite"]
    ):
        failures.append("instrumented graph logits shape, dtype, or finite check failed")
    if logits_reproduction.get("max_abs_delta", 0.0) != 0.0:
        failures.append("instrumented graph changed unmodified logits")

    arrays = {
        f"output_{index}": instrumented_values[name]
        for index, name in enumerate(("logits", *capture_outputs))
        if name in instrumented_values
    }
    np.savez(output_npz, **arrays)
    report = {
        "schema_version": "jwtd-quantized-intermediate-cpu-v1",
        "capture_profile": capture_profile,
        "status": "failed" if failures else "passed",
        "model_sha256": model_sha,
        "fixture_sha256": sha256_file(fixture_path),
        "baseline_report_sha256": sha256_file(baseline_path),
        "instrumented_model_sha256": sha256_file(instrumented),
        "row": {
            "index": selected.index,
            "id": selected.row_id,
            "token_count": len(selected.input_ids),
        },
        "graph_optimization": {
            "requested": graph_optimization,
            "effective": None,
            "session_option": level_name,
            "session_option_value": int(level_value),
        },
        "runtime": {
            "provider": "CPUExecutionProvider",
            "intra_op_num_threads": 1,
            "inter_op_num_threads": 1,
            "onnxruntime": runtime_meta["runtime"],
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "intermediate_output_order": list(capture_outputs),
        "instrumented_logits_reproduction": logits_reproduction,
        "outputs": output_summaries,
        "npz_sha256": sha256_file(output_npz),
        "npz": output_npz.name,
        "source_commit": __import__("os").environ.get("SOURCE_COMMIT", "unknown"),
        "gate": {"passed": not failures, "failures": failures},
        "limitations": [
            "This is a one-row intermediate diagnostic, not an accuracy estimate.",
            "The effective optimized graph is not observed from the session API.",
            "Output augmentation must reproduce unmodified logits before intermediate "
            "differences are interpreted.",
        ],
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    output_report.write_text(
        f"{json.dumps(report, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--baseline-report", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--output-model", type=Path, required=True)
    parser.add_argument("--output-npz", type=Path, required=True)
    parser.add_argument("--output-report", type=Path, required=True)
    parser.add_argument("--graph-optimization", choices=("all", "disabled"), default="all")
    parser.add_argument("--capture-profile", choices=CAPTURE_PROFILES, default="first-pair")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = run_cpu_diagnostic(
            args.model,
            args.fixture,
            args.baseline_report,
            args.output_model,
            args.output_npz,
            args.output_report,
            graph_optimization=args.graph_optimization,
            capture_profile=args.capture_profile,
        )
    except DiagnosticError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({"output": str(args.output_report), "status": report["status"]}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
