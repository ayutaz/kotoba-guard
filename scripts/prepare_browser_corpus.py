"""Freeze a small, model-result-blind corpus for browser parity checks.

The output is an ignored fixture because it contains source text and expected
logits.  The command validates every provenance input before copying either
into the fixture, and prints counts and hashes only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np
from tokenizers import Tokenizer

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

DEFAULT_DATASET = Path("artifacts/corpus/jwtd-v1/held-out.json")
DEFAULT_CACHE = Path("artifacts/corpus-evaluation/held-out-v1/onnx_quint8-logits.npz")
DEFAULT_CACHE_META = Path("artifacts/corpus-evaluation/held-out-v1/onnx_quint8-cache.json")
DEFAULT_CONFIG = Path("models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/config.json")
DEFAULT_PROTOCOL = Path("benchmarks/protocols/jwtd-browser-v1.json")
DEFAULT_OUTPUT = Path("artifacts/corpus-browser/jwtd-browser-v1.json")
DEFAULT_TOKENIZER = Path("models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/tokenizer.json")
DEFAULT_TOKENIZER_CONFIG = Path(
    "models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/tokenizer_config.json"
)
DEFAULT_DISTRIBUTION_MANIFEST = Path("dist/extension/models/manifest.json")
DEFAULT_NATIVE_MODEL = Path("dist/extension/models/onnx/model_quantized.onnx")
DEFAULT_NATIVE_OUTPUT = Path("artifacts/browser-corpus-native-diagnostic.json")
DEFAULT_FP32_MODEL = Path(
    "models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/onnx/model.onnx"
)
DEFAULT_FP32_MANIFEST = Path(
    "models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8/manifest.json"
)
DEFAULT_FP32_FIXTURE_OUTPUT = Path("artifacts/corpus-browser/jwtd-fp32-browser.json")
DEFAULT_FP32_REPORT_OUTPUT = Path("artifacts/browser-corpus-fp32-cpu.json")
DEFAULT_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
DEFAULT_RAW_MODEL_SHA = "51e8977b11e3c9353062216a7de6b4ebc54abd823647ac04c0dfadd48eb9e203"


class BrowserCorpusError(ValueError):
    """The parity fixture cannot be bound to its declared inputs."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def codepoint_to_utf16(text: str, start: int, end: int) -> tuple[int, int]:
    """Convert Python codepoint offsets to JavaScript UTF-16 code units."""

    if not (0 <= start <= end <= len(text)):
        raise BrowserCorpusError("invalid codepoint offset")
    prefix_start = len(text[:start].encode("utf-16-le")) // 2
    prefix_end = len(text[:end].encode("utf-16-le")) // 2
    return prefix_start, prefix_end


def load_labels(config_path: Path) -> tuple[str, ...]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    id2label = config.get("id2label")
    if not isinstance(id2label, dict) or not id2label:
        raise BrowserCorpusError("model config has no id2label map")
    try:
        labels = tuple(str(id2label[str(index)]) for index in range(len(id2label)))
    except (KeyError, TypeError) as error:
        raise BrowserCorpusError("model config label IDs are not contiguous") from error
    label2id = config.get("label2id")
    if isinstance(label2id, dict):
        for index, label in enumerate(labels):
            if str(label2id.get(label)) != str(index):
                raise BrowserCorpusError("model config label maps disagree")
    if "OK" not in labels or len(set(labels)) != len(labels):
        raise BrowserCorpusError("model config labels are invalid")
    return labels


def _item_id(item: dict[str, Any]) -> str:
    value = item.get("id")
    if not isinstance(value, str) or not value.endswith(":pre"):
        raise BrowserCorpusError("held-out items must have :pre IDs")
    return value


def select_subset(
    items: list[dict[str, Any]], labels: tuple[str, ...], per_label: int = 4
) -> list[dict[str, Any]]:
    """Select deterministic typo pairs, keeping each pair at most once."""

    if per_label < 1:
        raise ValueError("per_label must be positive")
    non_ok = [label for label in labels if label != "OK"]
    by_id = {_item_id(item): item for item in items if item.get("errors")}
    selected: dict[str, dict[str, Any]] = {}
    for label in non_ok:
        candidates = [
            item
            for item in by_id.values()
            if any(error.get("label") == label for error in item.get("errors", []))
        ]
        candidates.sort(key=lambda item: hashlib.sha256(_item_id(item).encode()).hexdigest())
        chosen = 0
        for item in candidates:
            item_id = _item_id(item)
            if item_id in selected:
                continue
            selected[item_id] = item
            chosen += 1
            if chosen == per_label:
                break
        if chosen != per_label:
            raise BrowserCorpusError(f"not enough distinct candidates for label {label}")
    return [selected[item_id] for item_id in sorted(selected)]


def _load_cache(
    dataset_path: Path,
    cache_path: Path,
    sidecar_path: Path,
    item_count: int,
    class_count: int,
) -> tuple[list[np.ndarray], list[list[tuple[int, int]]], dict[str, Any]]:
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    inputs = sidecar.get("inputs")
    if not isinstance(inputs, dict) or inputs.get("dataset_sha256") != sha256_file(dataset_path):
        raise BrowserCorpusError("logit cache is bound to a different dataset")
    if sidecar.get("cache_sha256") != sha256_file(cache_path):
        raise BrowserCorpusError("logit cache sidecar hash mismatch")
    if int(sidecar.get("items", -1)) != item_count:
        raise BrowserCorpusError("logit cache item count does not match held-out dataset")
    with np.load(cache_path, allow_pickle=False) as arrays:
        for required in ("logits", "offsets", "bounds"):
            if required not in arrays:
                raise BrowserCorpusError(f"logit cache lacks {required}")
        logits = np.asarray(arrays["logits"])
        offsets = np.asarray(arrays["offsets"])
        bounds = np.asarray(arrays["bounds"])
    if logits.ndim != 2 or logits.shape[1] != class_count or offsets.shape != (logits.shape[0], 2):
        raise BrowserCorpusError("logit cache tensor shapes are invalid")
    if not np.issubdtype(bounds.dtype, np.integer):
        raise BrowserCorpusError("logit cache bounds must be integers")
    if not np.issubdtype(offsets.dtype, np.integer):
        raise BrowserCorpusError("logit cache offsets must be integers")
    if (
        bounds.shape != (item_count + 1,)
        or bounds[0] != 0
        or bounds[-1] != len(logits)
        or np.any(bounds[1:] < bounds[:-1])
    ):
        raise BrowserCorpusError("logit cache bounds are invalid")
    if not np.isfinite(logits).all() or not np.isfinite(offsets).all():
        raise BrowserCorpusError("logit cache contains nonfinite values")
    outputs: list[np.ndarray] = []
    output_offsets: list[list[tuple[int, int]]] = []
    for start, end in zip(bounds[:-1], bounds[1:], strict=True):
        start_int, end_int = int(start), int(end)
        outputs.append(logits[start_int:end_int].copy())
        output_offsets.append([tuple(map(int, pair)) for pair in offsets[start_int:end_int]])
    return outputs, output_offsets, sidecar


def _validate_distribution_manifest(path: Path, raw_model_sha: str) -> str:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    files = manifest.get("files", {})
    distributed = files.get("onnx/model_quantized.onnx", {}).get("sha256")
    sanitization = manifest.get("sanitization", {})
    sanitized = sanitization.get("sha256")
    source = sanitization.get("sourceSha256")
    if not isinstance(distributed, str) or distributed != sanitized:
        raise BrowserCorpusError("distribution manifest lacks sanitized model hash")
    if source != raw_model_sha or distributed == raw_model_sha:
        raise BrowserCorpusError("sanitization provenance does not bind raw model hash")
    return distributed


def _load_tokenizer(tokenizer_path: Path) -> Tokenizer:
    try:
        return Tokenizer.from_file(str(tokenizer_path))
    except Exception as error:
        raise BrowserCorpusError("pinned tokenizer could not be loaded") from error


def _tokenize_inputs(tokenizer: Tokenizer, text: str) -> tuple[list[int], list[int]]:
    try:
        encoded = tokenizer.encode(text)
    except Exception as error:
        raise BrowserCorpusError("pinned tokenizer could not encode fixture text") from error
    input_ids = [int(value) for value in encoded.ids]
    attention_mask = [int(value) for value in encoded.attention_mask]
    if not input_ids or len(input_ids) != len(attention_mask):
        raise BrowserCorpusError("pinned tokenizer returned invalid input arrays")
    if any(value not in (0, 1) for value in attention_mask):
        raise BrowserCorpusError("pinned tokenizer returned invalid attention mask")
    return input_ids, attention_mask


def _native_provenance(
    fixture: dict[str, Any], model_path: Path, manifest_path: Path
) -> tuple[str, dict[str, Any]]:
    provenance = fixture.get("provenance")
    if not isinstance(provenance, dict):
        raise BrowserCorpusError("native diagnostic fixture lacks provenance")
    raw_sha = provenance.get("raw_model_sha256")
    expected_model_sha = provenance.get("distribution_model_sha256")
    revision = provenance.get("model_revision")
    if not all(
        isinstance(value, str) and len(value) == 64 for value in (raw_sha, expected_model_sha)
    ):
        raise BrowserCorpusError("native diagnostic fixture has invalid model hashes")
    if not isinstance(revision, str) or not revision:
        raise BrowserCorpusError("native diagnostic fixture lacks model revision")
    actual_model_sha = sha256_file(model_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    declared_sha = (
        files.get("onnx/model_quantized.onnx", {}).get("sha256")
        if isinstance(files, dict)
        else None
    )
    sanitization = manifest.get("sanitization")
    if not isinstance(sanitization, dict):
        raise BrowserCorpusError("native diagnostic manifest lacks sanitization provenance")
    if (
        actual_model_sha != expected_model_sha
        or declared_sha != actual_model_sha
        or sanitization.get("sha256") != actual_model_sha
        or sanitization.get("sourceSha256") != raw_sha
        or actual_model_sha == raw_sha
    ):
        raise BrowserCorpusError("native diagnostic distribution model hash provenance mismatch")
    if manifest.get("revision") != revision:
        raise BrowserCorpusError("native diagnostic model revision provenance mismatch")
    return actual_model_sha, {
        "raw_model_sha256": raw_sha,
        "distribution_model_sha256": actual_model_sha,
        "model_revision": revision,
    }


def _manifest_artifact_sha(manifest: dict[str, Any], relative_path: str) -> str | None:
    for key in ("files", "artifacts"):
        inventory = manifest.get(key)
        if not isinstance(inventory, dict):
            continue
        entry = inventory.get(relative_path)
        if isinstance(entry, dict) and isinstance(entry.get("sha256"), str):
            return entry["sha256"]
    return None


def _fp32_provenance(
    fixture: dict[str, Any], model_path: Path, manifest_path: Path
) -> tuple[str, str | None, dict[str, Any]]:
    provenance = fixture.get("provenance")
    if not isinstance(provenance, dict):
        raise BrowserCorpusError("FP32 diagnostic fixture lacks provenance")
    revision = provenance.get("model_revision")
    if not isinstance(revision, str) or not revision:
        raise BrowserCorpusError("FP32 diagnostic fixture lacks model revision")
    for key in ("config_sha256", "tokenizer_file_sha256", "tokenizer_config_file_sha256"):
        value = provenance.get(key)
        if not isinstance(value, str) or len(value) != 64:
            raise BrowserCorpusError(f"FP32 diagnostic fixture lacks {key}")
    actual_model_sha = sha256_file(model_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    declared_sha = _manifest_artifact_sha(manifest, "onnx/model.onnx")
    if declared_sha != actual_model_sha or manifest.get("revision") != revision:
        raise BrowserCorpusError("FP32 model manifest provenance mismatch")
    external_data_path = model_path.with_name(f"{model_path.name}.data")
    declared_external_sha = _manifest_artifact_sha(manifest, "onnx/model.onnx.data")
    external_data_sha = None
    if external_data_path.exists():
        external_data_sha = sha256_file(external_data_path)
    if declared_external_sha != external_data_sha:
        raise BrowserCorpusError("FP32 external data provenance mismatch")
    expected_external_sha = provenance.get("fp32_external_data_sha256")
    if expected_external_sha is not None and external_data_sha != expected_external_sha:
        raise BrowserCorpusError("FP32 external data provenance mismatch")
    return (
        actual_model_sha,
        external_data_sha,
        {
            "source_fixture_sha256": provenance.get("fixture_sha256"),
            "fp32_model_sha256": actual_model_sha,
            "fp32_external_data_sha256": external_data_sha,
            "model_revision": revision,
            "config_sha256": provenance.get("config_sha256"),
            "tokenizer_file_sha256": provenance.get("tokenizer_file_sha256"),
            "tokenizer_config_file_sha256": provenance.get("tokenizer_config_file_sha256"),
        },
    )


def _candidate_provenance(
    fixture: dict[str, Any], model_path: Path, manifest_path: Path, model_kind: str
) -> tuple[str, str | None, dict[str, Any]]:
    """Validate a non-FP32 candidate against its files/artifacts manifest."""

    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]+", model_kind):
        raise BrowserCorpusError("candidate model kind is invalid")
    provenance = fixture.get("provenance")
    if not isinstance(provenance, dict):
        raise BrowserCorpusError("candidate diagnostic fixture lacks provenance")
    revision = provenance.get("model_revision")
    if not isinstance(revision, str) or not revision:
        raise BrowserCorpusError("candidate diagnostic fixture lacks model revision")
    expected_text_hashes = {
        "config.json": provenance.get("config_sha256"),
        "tokenizer.json": provenance.get("tokenizer_file_sha256"),
        "tokenizer_config.json": provenance.get("tokenizer_config_file_sha256"),
    }
    if any(
        not isinstance(value, str) or len(value) != 64 for value in expected_text_hashes.values()
    ):
        raise BrowserCorpusError("candidate diagnostic fixture lacks text-file hashes")
    actual_model_sha = sha256_file(model_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    inventories = [
        inventory
        for key in ("files", "artifacts")
        if isinstance(inventory := manifest.get(key), dict)
    ]
    if not inventories:
        raise BrowserCorpusError("candidate manifest lacks files or artifacts")
    entries = [
        (str(relative), value)
        for inventory in inventories
        for relative, value in inventory.items()
        if isinstance(value, dict) and isinstance(value.get("sha256"), str)
    ]
    model_entries = [
        value["sha256"] for relative, value in entries if Path(relative).name == model_path.name
    ]
    if actual_model_sha not in model_entries:
        raise BrowserCorpusError("candidate model hash does not match manifest")
    manifest_revision = manifest.get("revision") or manifest.get("model_revision")
    if manifest_revision != revision:
        raise BrowserCorpusError("candidate model revision provenance mismatch")
    for basename, expected_sha in expected_text_hashes.items():
        declared = {
            value["sha256"] for relative, value in entries if Path(relative).name == basename
        }
        if expected_sha not in declared:
            raise BrowserCorpusError(f"candidate {basename} hash does not match manifest")
    external_path = model_path.with_name(f"{model_path.name}.data")
    external_sha = sha256_file(external_path) if external_path.is_file() else None
    declared_external = {
        value["sha256"] for relative, value in entries if Path(relative).name == external_path.name
    }
    if external_sha is not None and external_sha not in declared_external:
        raise BrowserCorpusError("candidate external data hash does not match manifest")
    if external_sha is None and declared_external:
        raise BrowserCorpusError("candidate external data is missing")
    return (
        actual_model_sha,
        external_sha,
        {
            "model_kind": model_kind,
            "candidate_model_sha256": actual_model_sha,
            "candidate_external_data_sha256": external_sha,
            "model_revision": revision,
            "config_sha256": expected_text_hashes["config.json"],
            "tokenizer_file_sha256": expected_text_hashes["tokenizer.json"],
            "tokenizer_config_file_sha256": expected_text_hashes["tokenizer_config.json"],
        },
    )


def _refuse_candidate_outputs(
    fixture_path: Path,
    model_path: Path,
    manifest_path: Path,
    fixture_output_path: Path,
    report_output_path: Path,
) -> None:
    source_paths = {path.resolve() for path in (fixture_path, model_path, manifest_path)}
    output_paths = {
        "fixture": fixture_output_path.resolve(),
        "report": report_output_path.resolve(),
    }
    if output_paths["fixture"] == output_paths["report"]:
        raise BrowserCorpusError("candidate output paths must be distinct")
    for output_name, output_path in output_paths.items():
        if output_path in source_paths:
            raise BrowserCorpusError(f"candidate output path overlaps input: {output_name}")
        if output_path.exists():
            raise BrowserCorpusError(f"candidate output already exists: {output_name}")


def run_fp32_cpu_diagnostic(
    fixture_path: Path,
    model_path: Path,
    manifest_path: Path,
    fixture_output_path: Path,
    report_output_path: Path,
    *,
    ort_module: Any | None = None,
    diagnostic_kind: str = "fp32",
    graph_optimization: str = "all",
) -> dict[str, Any]:
    """Generate a CPU logits fixture for the paired WASM diagnostic."""

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    items = fixture.get("items")
    labels = fixture.get("labels")
    if not isinstance(items, list) or not items or not isinstance(labels, list) or not labels:
        raise BrowserCorpusError("CPU diagnostic fixture is empty or malformed")
    if diagnostic_kind == "fp32":
        model_sha, external_data_sha, provenance = _fp32_provenance(
            fixture, model_path, manifest_path
        )
    else:
        model_sha, external_data_sha, provenance = _candidate_provenance(
            fixture, model_path, manifest_path, diagnostic_kind
        )
    if ort_module is None:
        import onnxruntime as ort_module
    optimization_names = {
        "all": "ORT_ENABLE_ALL",
        "disabled": "ORT_DISABLE_ALL",
    }
    try:
        optimization_name = optimization_names[graph_optimization]
    except (KeyError, TypeError) as error:
        raise BrowserCorpusError(
            f"{diagnostic_kind} diagnostic graph optimization must be 'all' or 'disabled'"
        ) from error
    options = ort_module.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    optimization_level = getattr(
        getattr(ort_module, "GraphOptimizationLevel", None), optimization_name, None
    )
    if optimization_level is None:
        raise BrowserCorpusError(f"CPU diagnostic runtime lacks {optimization_name}")
    options.graph_optimization_level = optimization_level
    session = ort_module.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )
    get_inputs = getattr(session, "get_inputs", None)
    get_outputs = getattr(session, "get_outputs", None)
    if not callable(get_inputs) or not callable(get_outputs):
        raise BrowserCorpusError("FP32 diagnostic ONNX session lacks Python metadata API")
    input_names = [str(value.name) for value in get_inputs()]
    output_names = [str(value.name) for value in get_outputs()]
    if not input_names or not output_names:
        raise BrowserCorpusError("FP32 diagnostic ONNX session has no inputs or outputs")
    output_items: list[dict[str, Any]] = []
    report_rows: list[dict[str, Any]] = []
    structural_failure = False
    for item in items:
        item_id = item.get("id")
        input_ids = np.asarray(item.get("expected_input_ids"), dtype=np.int64)
        attention_mask = np.asarray(item.get("expected_attention_mask"), dtype=np.int64)
        expected_offsets = np.asarray(item.get("expected_offsets"), dtype=np.int64)
        if (
            not isinstance(item_id, str)
            or input_ids.ndim != 1
            or attention_mask.shape != input_ids.shape
            or expected_offsets.shape != (input_ids.shape[0], 2)
        ):
            raise BrowserCorpusError("FP32 diagnostic fixture row shapes are invalid")
        feeds: dict[str, np.ndarray] = {}
        for name in input_names:
            if name == "input_ids":
                feeds[name] = input_ids[None, :]
            elif name == "attention_mask":
                feeds[name] = attention_mask[None, :]
            elif name == "token_type_ids":
                feeds[name] = np.zeros_like(input_ids)[None, :]
            else:
                raise BrowserCorpusError(f"FP32 diagnostic unsupported ONNX input: {name}")
        actual = np.asarray(session.run([output_names[0]], feeds)[0])
        shape_valid = actual.shape == (1, input_ids.shape[0], len(labels))
        dtype_valid = actual.dtype == np.dtype(np.float32)
        finite = bool(np.isfinite(actual).all())
        report_row: dict[str, Any] = {
            "id": item_id,
            "shape_valid": shape_valid,
            "dtype": str(actual.dtype),
            "dtype_valid": dtype_valid,
            "finite": finite,
            "token_count": int(input_ids.shape[0]),
        }
        if not shape_valid or not dtype_valid or not finite:
            structural_failure = True
            report_rows.append(report_row)
            continue
        logits = actual[0].astype(np.float64, copy=False)
        report_rows.append(report_row)
        output_items.append(
            {
                "id": item_id,
                "pair_id": item.get("pair_id"),
                "source_role": item.get("source_role"),
                "text": item["text"],
                "errors": item.get("errors", []),
                "expected_logits": logits.tolist(),
                "expected_offsets": item["expected_offsets"],
                "expected_offset_unit": item.get("expected_offset_unit", "unicode_codepoint"),
                "expected_input_ids": item["expected_input_ids"],
                "expected_attention_mask": item["expected_attention_mask"],
            }
        )
    is_fp32 = diagnostic_kind == "fp32"
    if not is_fp32:
        provenance["candidate_graph_optimization"] = optimization_name
        provenance["candidate_graph_optimization_level"] = int(optimization_level)
    output_fixture = {
        "schema_version": "jwtd-fp32-browser-v1" if is_fp32 else "jwtd-candidate-browser-v1",
        "labels": labels,
        "subset_is_model_result_blind": fixture.get("subset_is_model_result_blind"),
        "provenance": {
            **provenance,
            "source_fixture_sha256": sha256_file(fixture_path),
            "protocol_sha256": fixture.get("provenance", {}).get("protocol_sha256"),
        },
        "items": output_items,
    }
    fixture_output_path.parent.mkdir(parents=True, exist_ok=True)
    fixture_output_path.write_text(
        json.dumps(output_fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    report = {
        "schema_version": (
            "jwtd-fp32-cpu-diagnostic-v1" if is_fp32 else "jwtd-candidate-cpu-diagnostic-v1"
        ),
        "status": "failed" if structural_failure else "completed",
        "source_fixture_sha256": sha256_file(fixture_path),
        "model_kind": diagnostic_kind,
        "candidate_model_sha256" if not is_fp32 else "model_sha256": model_sha,
        "candidate_external_data_sha256"
        if not is_fp32
        else "external_data_sha256": external_data_sha,
        **(
            {"fp32_fixture_sha256": sha256_file(fixture_output_path)}
            if is_fp32
            else {"candidate_fixture_sha256": sha256_file(fixture_output_path)}
        ),
        "provenance": provenance,
        "runtime": {
            "onnxruntime": getattr(ort_module, "__version__", "unknown"),
            "execution_provider": "CPUExecutionProvider",
            "intra_op_num_threads": 1,
            "inter_op_num_threads": 1,
            "graph_optimization": optimization_name,
            "graph_optimization_level": int(optimization_level),
        },
        "gate": {
            "passed": not structural_failure,
            "failures": [
                row["id"]
                for row in report_rows
                if not row["shape_valid"] or not row["dtype_valid"] or not row["finite"]
            ],
        },
        "rows": report_rows,
    }
    report_output_path.parent.mkdir(parents=True, exist_ok=True)
    report_output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def run_candidate_cpu_diagnostic(
    fixture_path: Path,
    model_path: Path,
    manifest_path: Path,
    fixture_output_path: Path,
    report_output_path: Path,
    *,
    model_kind: str,
    ort_module: Any | None = None,
    graph_optimization: str = "all",
) -> dict[str, Any]:
    """Generate CPU logits for an isolated candidate model kind."""

    if model_kind == "fp32":
        raise BrowserCorpusError("candidate diagnostic model kind must not be fp32")
    _refuse_candidate_outputs(
        fixture_path,
        model_path,
        manifest_path,
        fixture_output_path,
        report_output_path,
    )
    return run_fp32_cpu_diagnostic(
        fixture_path,
        model_path,
        manifest_path,
        fixture_output_path,
        report_output_path,
        ort_module=ort_module,
        diagnostic_kind=model_kind,
        graph_optimization=graph_optimization,
    )


def run_native_diagnostic(
    fixture_path: Path,
    model_path: Path,
    manifest_path: Path,
    output_path: Path,
    *,
    ort_module: Any | None = None,
    graph_optimization: str = "all",
) -> dict[str, Any]:
    """Compare the frozen fixture logits with one local ONNX Runtime CPU run.

    This diagnostic deliberately has no accuracy gate. It isolates CPU runtime
    and sanitized-model behavior from browser execution while keeping the
    fixture's model provenance and source text out of the report.
    """

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    items = fixture.get("items")
    labels = fixture.get("labels")
    if not isinstance(items, list) or not items or not isinstance(labels, list) or not labels:
        raise BrowserCorpusError("native diagnostic fixture is empty or malformed")
    model_sha, provenance = _native_provenance(fixture, model_path, manifest_path)
    if ort_module is None:
        import onnxruntime as ort_module

    optimization_names = {
        "all": "ORT_ENABLE_ALL",
        "disabled": "ORT_DISABLE_ALL",
    }
    try:
        optimization_name = optimization_names[graph_optimization]
    except KeyError as error:
        raise BrowserCorpusError(
            "native diagnostic graph optimization must be 'all' or 'disabled'"
        ) from error
    options = ort_module.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    optimization_level = getattr(
        getattr(ort_module, "GraphOptimizationLevel", None), optimization_name, None
    )
    if optimization_level is None:
        raise BrowserCorpusError(f"native diagnostic runtime lacks {optimization_name}")
    options.graph_optimization_level = optimization_level
    session = ort_module.InferenceSession(
        str(model_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    get_inputs = getattr(session, "get_inputs", None)
    get_outputs = getattr(session, "get_outputs", None)
    if not callable(get_inputs) or not callable(get_outputs):
        raise BrowserCorpusError("native diagnostic ONNX session lacks Python metadata API")
    input_names = [str(value.name) for value in get_inputs()]
    output_names = [str(value.name) for value in get_outputs()]
    if not input_names or not output_names:
        raise BrowserCorpusError("native diagnostic ONNX session has no inputs or outputs")
    rows: list[dict[str, Any]] = []
    structural_failure = False
    for item in items:
        item_id = item.get("id")
        expected_logits = np.asarray(item.get("expected_logits"), dtype=np.float64)
        expected_offsets = np.asarray(item.get("expected_offsets"), dtype=np.int64)
        input_ids = np.asarray(item.get("expected_input_ids"), dtype=np.int64)
        attention_mask = np.asarray(item.get("expected_attention_mask"), dtype=np.int64)
        if not isinstance(item_id, str) or expected_logits.ndim != 2:
            raise BrowserCorpusError("native diagnostic fixture row is malformed")
        if (
            input_ids.ndim != 1
            or attention_mask.shape != input_ids.shape
            or expected_offsets.shape != (expected_logits.shape[0], 2)
            or input_ids.shape[0] != expected_logits.shape[0]
        ):
            raise BrowserCorpusError("native diagnostic fixture row shapes are invalid")
        feeds: dict[str, np.ndarray] = {}
        for name in input_names:
            if name == "input_ids":
                feeds[name] = input_ids[None, :]
            elif name == "attention_mask":
                feeds[name] = attention_mask[None, :]
            elif name == "token_type_ids":
                feeds[name] = np.zeros_like(input_ids)[None, :]
            else:
                raise BrowserCorpusError(f"native diagnostic unsupported ONNX input: {name}")
        actual = np.asarray(session.run([output_names[0]], feeds)[0])
        shape_valid = actual.shape == (1, expected_logits.shape[0], expected_logits.shape[1])
        dtype_valid = actual.dtype == np.dtype(np.float32)
        actual_dtype = str(actual.dtype)
        if shape_valid:
            actual = actual[0].astype(np.float64, copy=False)
        finite = bool(np.isfinite(actual).all()) and bool(np.isfinite(expected_logits).all())
        row: dict[str, Any] = {
            "id": item_id,
            "shape_valid": shape_valid,
            "dtype": actual_dtype,
            "dtype_valid": dtype_valid,
            "finite": finite,
            "token_count": int(expected_logits.shape[0]),
            "ordinary_token_count": 0,
            "ordinary_max_abs_logit_delta": None,
            "ordinary_mean_abs_logit_delta": None,
            "all_tokens_max_abs_logit_delta": None,
            "all_tokens_mean_abs_logit_delta": None,
            "ordinary_token_argmax_agreement": None,
        }
        if not shape_valid or not dtype_valid or not finite:
            structural_failure = True
            rows.append(row)
            continue
        deltas = np.abs(actual - expected_logits)
        ordinary = expected_offsets[:, 1] > expected_offsets[:, 0]
        ordinary_deltas = deltas[ordinary]
        all_argmax = np.argmax(actual, axis=1) == np.argmax(expected_logits, axis=1)
        row.update(
            {
                "ordinary_token_count": int(ordinary.sum()),
                "ordinary_max_abs_logit_delta": float(ordinary_deltas.max())
                if ordinary_deltas.size
                else 0.0,
                "ordinary_mean_abs_logit_delta": float(ordinary_deltas.mean())
                if ordinary_deltas.size
                else 0.0,
                "all_tokens_max_abs_logit_delta": float(deltas.max()),
                "all_tokens_mean_abs_logit_delta": float(deltas.mean()),
                "ordinary_token_argmax_agreement": float(all_argmax[ordinary].mean())
                if ordinary.any()
                else 1.0,
            }
        )
        rows.append(row)
    report = {
        "schema_version": "jwtd-native-diagnostic-v1",
        "status": "failed" if structural_failure else "completed",
        "fixture_sha256": sha256_file(fixture_path),
        "fixture_item_count": len(items),
        "model_sha256": model_sha,
        "provenance": provenance,
        "runtime": {
            "onnxruntime": getattr(ort_module, "__version__", "unknown"),
            "execution_provider": "CPUExecutionProvider",
            "intra_op_num_threads": 1,
            "inter_op_num_threads": 1,
            "graph_optimization": optimization_name,
            "graph_optimization_level": int(optimization_level),
        },
        "gate": {
            "passed": not structural_failure,
            "failures": [
                row["id"]
                for row in rows
                if not row["shape_valid"] or not row["dtype_valid"] or not row["finite"]
            ],
        },
        "rows": rows,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report


def prepare_browser_corpus(
    dataset_path: Path,
    cache_path: Path,
    cache_meta_path: Path,
    config_path: Path,
    protocol_path: Path,
    output_path: Path,
    *,
    distribution_manifest: Path | None = None,
    tokenizer_path: Path = DEFAULT_TOKENIZER,
    tokenizer_config_path: Path = DEFAULT_TOKENIZER_CONFIG,
    expected_revision: str = DEFAULT_REVISION,
    expected_model_sha: str = DEFAULT_RAW_MODEL_SHA,
    per_label: int = 4,
) -> dict[str, Any]:
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    items = dataset.get("items")
    if not isinstance(items, list) or not items:
        raise BrowserCorpusError("held-out dataset has no items")
    labels = load_labels(config_path)
    outputs, offsets, sidecar = _load_cache(
        dataset_path, cache_path, cache_meta_path, len(items), len(labels)
    )
    raw_model_sha = sidecar["inputs"].get("model_sha256")
    if not isinstance(raw_model_sha, str):
        raise BrowserCorpusError("logit cache lacks raw model hash")
    if raw_model_sha != expected_model_sha:
        raise BrowserCorpusError("logit cache model hash is not the pinned raw model")
    if sidecar["inputs"].get("revision") != expected_revision:
        raise BrowserCorpusError("logit cache revision does not match the pinned model")
    for path, key in (
        (tokenizer_path, "tokenizer_sha256"),
        (tokenizer_config_path, "tokenizer_config_sha256"),
        (config_path, "model_config_sha256"),
    ):
        expected_hash = sidecar["inputs"].get(key)
        if (
            not isinstance(expected_hash, str)
            or len(expected_hash) != 64
            or expected_hash != sha256_file(path)
        ):
            raise BrowserCorpusError(f"logit cache {key} does not match the local file")
    for item, item_offsets in zip(items, offsets, strict=True):
        text_length = len(item.get("text", ""))
        if any(start < 0 or end < start or end > text_length for start, end in item_offsets):
            raise BrowserCorpusError("logit cache offsets exceed source text")
    distributed_sha = (
        _validate_distribution_manifest(distribution_manifest, raw_model_sha)
        if distribution_manifest is not None
        else None
    )
    selected_pre = select_subset(items, labels, per_label)
    by_id = {
        _item_id(item): index
        for index, item in enumerate(items)
        if item.get("id", "").endswith(":pre")
    }
    by_pair = {item.get("pair_id"): item for item in items if item.get("id", "").endswith(":post")}
    tokenizer = _load_tokenizer(tokenizer_path)
    fixture_items: list[dict[str, Any]] = []
    for pre in selected_pre:
        pre_id = _item_id(pre)
        pair_id = pre.get("pair_id")
        post = by_pair.get(pair_id)
        if not isinstance(post, dict):
            raise BrowserCorpusError("selected typo pair has no corrected clean item")
        for item in (pre, post):
            item_id = str(item["id"])
            index = (
                by_id.get(pre_id)
                if item is pre
                else next(
                    index for index, candidate in enumerate(items) if candidate.get("id") == item_id
                )
            )
            input_ids, attention_mask = _tokenize_inputs(tokenizer, item["text"])
            fixture_items.append(
                {
                    "id": item_id,
                    "pair_id": pair_id,
                    "source_role": item.get("source_role"),
                    "text": item["text"],
                    "errors": item.get("errors", []),
                    "expected_logits": outputs[index].astype(float).tolist(),
                    "expected_offsets": [list(pair) for pair in offsets[index]],
                    "expected_offset_unit": "unicode_codepoint",
                    "expected_input_ids": input_ids,
                    "expected_attention_mask": attention_mask,
                }
            )
    manifest = {
        "schema_version": "jwtd-browser-v1",
        "dataset": dataset.get("schema_version"),
        "subset_is_model_result_blind": True,
        "labels": list(labels),
        "selection": {
            "per_non_ok_label": per_label,
            "pre_items": len(selected_pre),
            "clean_post_items": len(selected_pre),
            "deduplication": "pair_id; SHA-256(item ID) ordering",
        },
        "provenance": {
            "dataset_sha256": sha256_file(dataset_path),
            "cache_sha256": sha256_file(cache_path),
            "cache_metadata_sha256": sha256_file(cache_meta_path),
            "raw_model_sha256": raw_model_sha,
            "distribution_model_sha256": distributed_sha,
            "tokenizer_sha256": sidecar["inputs"].get("tokenizer_sha256"),
            "tokenizer_config_sha256": sidecar["inputs"].get("tokenizer_config_sha256"),
            "model_revision": sidecar["inputs"].get("revision"),
            "config_sha256": sha256_file(config_path),
            "tokenizer_file_sha256": sha256_file(tokenizer_path),
            "tokenizer_config_file_sha256": sha256_file(tokenizer_config_path),
            "protocol_sha256": sha256_file(protocol_path),
        },
        "items": fixture_items,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--native-diagnostic",
        action="store_true",
        help="compare fixture logits with one local sanitized ONNX CPU run",
    )
    parser.add_argument("--fixture", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", type=Path, default=DEFAULT_NATIVE_MODEL)
    parser.add_argument("--model-manifest", type=Path, default=DEFAULT_DISTRIBUTION_MANIFEST)
    parser.add_argument("--native-output", type=Path, default=DEFAULT_NATIVE_OUTPUT)
    parser.add_argument(
        "--native-graph-optimization",
        choices=("all", "disabled"),
        default="all",
        help="native ORT graph optimization level for the diagnostic",
    )
    parser.add_argument(
        "--fp32-diagnostic",
        action="store_true",
        help="generate an FP32 CPU logits fixture for the paired WASM diagnostic",
    )
    parser.add_argument(
        "--candidate-diagnostic",
        action="store_true",
        help="generate a candidate-model CPU logits fixture for paired WASM diagnostics",
    )
    parser.add_argument(
        "--model-kind",
        help="candidate diagnostic model kind, for example weight-only-qdq",
    )
    parser.add_argument("--candidate-model", type=Path)
    parser.add_argument("--candidate-manifest", type=Path)
    parser.add_argument("--candidate-fixture-output", type=Path)
    parser.add_argument("--candidate-report-output", type=Path)
    parser.add_argument(
        "--candidate-graph-optimization",
        choices=("all", "disabled"),
        default="all",
        help="candidate CPU ORT graph optimization level",
    )
    parser.add_argument("--fp32-input-fixture", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--fp32-model", type=Path, default=DEFAULT_FP32_MODEL)
    parser.add_argument("--fp32-manifest", type=Path, default=DEFAULT_FP32_MANIFEST)
    parser.add_argument("--fp32-fixture-output", type=Path, default=DEFAULT_FP32_FIXTURE_OUTPUT)
    parser.add_argument("--fp32-report-output", type=Path, default=DEFAULT_FP32_REPORT_OUTPUT)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--cache-meta", type=Path, default=DEFAULT_CACHE_META)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--protocol", type=Path, default=DEFAULT_PROTOCOL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--distribution-manifest", type=Path, default=DEFAULT_DISTRIBUTION_MANIFEST)
    parser.add_argument("--tokenizer", type=Path, default=DEFAULT_TOKENIZER)
    parser.add_argument("--tokenizer-config", type=Path, default=DEFAULT_TOKENIZER_CONFIG)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--raw-model-sha", default=DEFAULT_RAW_MODEL_SHA)
    parser.add_argument("--per-label", type=int, default=4)
    args = parser.parse_args()
    if args.fp32_diagnostic and args.candidate_diagnostic:
        parser.error("--fp32-diagnostic and --candidate-diagnostic are mutually exclusive")
    if args.candidate_diagnostic and not args.model_kind:
        parser.error("--candidate-diagnostic requires --model-kind")
    if args.fp32_diagnostic:
        report = run_fp32_cpu_diagnostic(
            args.fp32_input_fixture,
            args.fp32_model,
            args.fp32_manifest,
            args.fp32_fixture_output,
            args.fp32_report_output,
        )
        print(
            json.dumps(
                {
                    "fixture_output": args.fp32_fixture_output.as_posix(),
                    "report_output": args.fp32_report_output.as_posix(),
                    "status": report["status"],
                    "model_sha256": report["model_sha256"],
                    "runtime": report["runtime"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if report["status"] == "completed" else 1
    if args.candidate_diagnostic:
        if args.candidate_model is None or args.candidate_manifest is None:
            parser.error(
                "--candidate-diagnostic requires --candidate-model and --candidate-manifest"
            )
        fixture_output = args.candidate_fixture_output or Path(
            f"artifacts/corpus-browser/jwtd-{args.model_kind}-browser.json"
        )
        report_output = args.candidate_report_output or Path(
            f"artifacts/browser-corpus-{args.model_kind}-cpu.json"
        )
        report = run_candidate_cpu_diagnostic(
            args.fixture,
            args.candidate_model,
            args.candidate_manifest,
            fixture_output,
            report_output,
            model_kind=args.model_kind,
            graph_optimization=args.candidate_graph_optimization,
        )
        print(
            json.dumps(
                {
                    "fixture_output": fixture_output.as_posix(),
                    "report_output": report_output.as_posix(),
                    "status": report["status"],
                    "model_kind": report["model_kind"],
                    "candidate_model_sha256": report["candidate_model_sha256"],
                    "runtime": report["runtime"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if report["status"] == "completed" else 1
    if args.native_diagnostic:
        report = run_native_diagnostic(
            args.fixture,
            args.model,
            args.model_manifest,
            args.native_output,
            graph_optimization=args.native_graph_optimization,
        )
        print(
            json.dumps(
                {
                    "output": args.native_output.as_posix(),
                    "status": report["status"],
                    "fixture_item_count": report["fixture_item_count"],
                    "model_sha256": report["model_sha256"],
                    "runtime": report["runtime"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if report["status"] == "completed" else 1
    manifest = prepare_browser_corpus(
        args.dataset,
        args.cache,
        args.cache_meta,
        args.config,
        args.protocol,
        args.output,
        distribution_manifest=args.distribution_manifest,
        tokenizer_path=args.tokenizer,
        tokenizer_config_path=args.tokenizer_config,
        expected_revision=args.revision,
        expected_model_sha=args.raw_model_sha,
        per_label=args.per_label,
    )
    print(
        json.dumps(
            {
                "output": args.output.as_posix(),
                "items": len(manifest["items"]),
                "pre_items": manifest["selection"]["pre_items"],
                "clean_post_items": manifest["selection"]["clean_post_items"],
                "provenance": manifest["provenance"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
