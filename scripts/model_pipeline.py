"""Reference inference, ONNX conversion, quantization and validation helpers.

All model paths are explicit so that CI and browser packaging can consume the
same manifest without silently downloading a different revision.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MODEL_ID = "sbintuitions/ja-typo-detector-modernbert-ja-base-30m"
EXPECTED_REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
ONNX_OPSET = 18
ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_ROOT = ROOT / "models" / "upstream" / EXPECTED_REVISION
CONVERTED_ROOT = ROOT / "models" / "converted" / EXPECTED_REVISION


def _ensure_utf8_stdio() -> None:
    """Prevent exporter progress symbols from failing on cp932 consoles."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


@dataclass(frozen=True)
class ModelMetadata:
    labels: tuple[str, ...]
    label_to_id: dict[str, int]
    model_type: str
    max_position_embeddings: int


def load_model_metadata(model_dir: Path) -> ModelMetadata:
    """Read labels and limits from the upstream config; never guess label IDs."""
    config_path = model_dir / "config.json"
    if not config_path.is_file():
        raise FileNotFoundError(config_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    raw_id2label = config.get("id2label")
    raw_label2id = config.get("label2id")
    if not isinstance(raw_id2label, dict) or not isinstance(raw_label2id, dict):
        raise ValueError("config.json must contain id2label and label2id mappings")
    ordered = tuple(raw_id2label[str(index)] for index in range(len(raw_id2label)))
    normalized = {str(name): int(value) for name, value in raw_label2id.items()}
    if any(normalized.get(name) != index for index, name in enumerate(ordered)):
        raise ValueError("id2label and label2id are inconsistent")
    return ModelMetadata(
        labels=ordered,
        label_to_id=normalized,
        model_type=str(config.get("model_type", "")),
        max_position_embeddings=int(config.get("max_position_embeddings", 512)),
    )


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def collect_file_manifest(root: Path) -> dict[str, dict[str, Any]]:
    return {
        path.relative_to(root).as_posix(): {
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name != "manifest.json" and not path.name.startswith("try_")
    }


def download_upstream(output_dir: Path = UPSTREAM_ROOT) -> Path:
    """Download only the pinned upstream files with huggingface_hub."""
    from huggingface_hub import snapshot_download

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_ID,
        revision=EXPECTED_REVISION,
        local_dir=str(output_dir),
        allow_patterns=[
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "model.safetensors",
            "LICENSE",
            "README.md",
        ],
        local_dir_use_symlinks=False,
    )
    metadata = load_model_metadata(output_dir)
    if metadata.model_type != "modernbert":
        raise ValueError(f"unexpected model type: {metadata.model_type}")
    return output_dir


def _load_reference(model_dir: Path):
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, use_fast=True)
    model = AutoModelForTokenClassification.from_pretrained(str(model_dir), local_files_only=True)
    model.eval()
    return tokenizer, model, torch


def reference_infer(text: str, model_dir: Path = UPSTREAM_ROOT) -> dict[str, Any]:
    """Run deterministic CPU reference inference and preserve tokenizer offsets."""
    if not text:
        return {"text": text, "tokens": [], "detections": [], "elapsed_ms": 0.0}
    tokenizer, model, torch = _load_reference(model_dir)
    encoded = tokenizer(
        text,
        return_offsets_mapping=True,
        return_tensors="pt",
        truncation=True,
        max_length=load_model_metadata(model_dir).max_position_embeddings,
    )
    offsets = encoded.pop("offset_mapping")[0].tolist()
    with torch.inference_mode():
        started = time.perf_counter()
        output = model(**encoded)
        elapsed_ms = (time.perf_counter() - started) * 1000
    probabilities = output.logits.softmax(dim=-1)[0]
    labels = load_model_metadata(model_dir).labels
    tokens = []
    detections = []
    for index, (start, end) in enumerate(offsets):
        if end <= start:
            continue
        label_id = int(probabilities[index].argmax())
        confidence = float(probabilities[index, label_id])
        label = labels[label_id]
        item = {
            "token_index": index,
            "start": start,
            "end": end,
            "label_id": label_id,
            "label": label,
            "confidence": confidence,
        }
        tokens.append(item)
        if label != "OK":
            detections.append(item)
    return {"text": text, "tokens": tokens, "detections": detections, "elapsed_ms": elapsed_ms}


def reference_logits(text: str, model_dir: Path = UPSTREAM_ROOT):
    """Return reference logits and tokenizer offsets for numerical parity checks."""
    tokenizer, model, torch = _load_reference(model_dir)
    encoded = tokenizer(
        text,
        return_offsets_mapping=True,
        return_tensors="pt",
        truncation=True,
        max_length=load_model_metadata(model_dir).max_position_embeddings,
    )
    offsets = encoded.pop("offset_mapping")[0].tolist()
    with torch.inference_mode():
        logits = model(**encoded).logits[0].cpu().numpy()
    return logits, offsets


def export_onnx(model_dir: Path = UPSTREAM_ROOT, output_dir: Path = CONVERTED_ROOT) -> Path:
    """Export the token-classification model with dynamic batch/sequence axes."""
    import torch

    _, model, _ = _load_reference(model_dir)
    destination_dir = output_dir / "onnx"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / "model.onnx"
    tokenizer = _load_reference(model_dir)[0]
    sample = tokenizer("これはテストです。", return_tensors="pt")
    input_names = ["input_ids", "attention_mask"]
    inputs = tuple(sample[name] for name in input_names)

    class Wrapper(torch.nn.Module):
        def __init__(self, wrapped):
            super().__init__()
            self.wrapped = wrapped

        def forward(self, input_ids, attention_mask):
            return self.wrapped(input_ids=input_ids, attention_mask=attention_mask).logits

    wrapped = Wrapper(model).eval()
    with torch.inference_mode():
        torch.onnx.export(
            wrapped,
            inputs,
            str(destination),
            input_names=input_names,
            output_names=["logits"],
            dynamic_axes={name: {0: "batch", 1: "sequence"} for name in input_names}
            | {"logits": {0: "batch", 1: "sequence"}},
            opset_version=ONNX_OPSET,
            do_constant_folding=True,
            dynamo=True,
        )
    return destination


def quantize_int8(input_path: Path, output_path: Path | None = None) -> Path:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    output_path = output_path or input_path.with_name("model_quantized.onnx")
    # A signed QInt8 trial was compared with QUInt8; QUInt8 was retained
    # because it produced the more stable bounded-evaluation result.  This is
    # an empirical artifact choice, not an assumption about activation ranges.
    # Include the embedding Gather explicitly: it is the dominant weight block
    # and ORT's supported Gather quantizer makes the browser artifact smaller.
    quantize_dynamic(
        str(input_path),
        str(output_path),
        op_types_to_quantize=["Gather", "MatMul"],
        weight_type=QuantType.QUInt8,
        per_channel=True,
        reduce_range=False,
        extra_options={"MatMulConstBOnly": True},
    )
    return output_path


def convert_fp16(input_path: Path, output_path: Path | None = None) -> Path:
    import onnx
    from onnxconverter_common import float16

    output_path = output_path or input_path.with_name("model_fp16.onnx")
    graph = onnx.load(str(input_path))
    converted = float16.convert_float_to_float16(graph, keep_io_types=True)
    # The exporter emits a rotary-position Cast whose value_info is converted to
    # float16 while the converter leaves its `to=float` attribute unchanged.
    # ORT rejects that inconsistent intermediate type. Keep the rotary path in
    # float16; the final logits Cast still restores the float32 public output.
    for node in converted.graph.node:
        if node.name == "node__to_copy_2" and node.op_type == "Cast":
            for attribute in node.attribute:
                if attribute.name == "to":
                    attribute.i = onnx.TensorProto.FLOAT16
    onnx.save(converted, str(output_path))
    return output_path


def onnx_infer(path: Path, text: str, model_dir: Path = UPSTREAM_ROOT) -> dict[str, Any]:
    import onnxruntime as ort
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, use_fast=True)
    encoded = tokenizer(
        text,
        return_offsets_mapping=True,
        return_tensors="np",
        truncation=True,
        max_length=load_model_metadata(model_dir).max_position_embeddings,
    )
    offsets = encoded.pop("offset_mapping")[0].tolist()
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    feed = {name: encoded[name] for name in ("input_ids", "attention_mask") if name in encoded}
    started = time.perf_counter()
    logits = session.run(["logits"], feed)[0]
    elapsed_ms = (time.perf_counter() - started) * 1000
    labels = load_model_metadata(model_dir).labels
    detections = []
    for index, (start, end) in enumerate(offsets):
        if end <= start:
            continue
        label_id = int(logits[0, index].argmax())
        if labels[label_id] != "OK":
            detections.append(
                {
                    "token_index": index,
                    "start": start,
                    "end": end,
                    "label_id": label_id,
                    "label": labels[label_id],
                }
            )
    return {"logits": logits, "detections": detections, "elapsed_ms": elapsed_ms}


def write_manifest(output_dir: Path = CONVERTED_ROOT, source_dir: Path = UPSTREAM_ROOT) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename in (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "LICENSE",
        "README.md",
    ):
        source = source_dir / filename
        if source.is_file():
            shutil.copy2(source, output_dir / filename)
    artifacts = collect_file_manifest(output_dir)
    artifact_times = [
        (output_dir / name).stat().st_mtime for name in artifacts if name.startswith("onnx/")
    ]
    converted_at = (
        datetime.fromtimestamp(max(artifact_times), UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
        if artifact_times
        else None
    )
    embedding_fp32_bytes = 102_400 * 256 * 4
    quantized_bytes = artifacts.get("onnx/model_quantized.onnx", {}).get("bytes")
    matmul_only_path = ROOT / "artifacts" / "benchmarks" / "model_matmul_only.onnx"
    matmul_only_bytes = matmul_only_path.stat().st_size if matmul_only_path.is_file() else None
    manifest = {
        "model_id": MODEL_ID,
        "revision": EXPECTED_REVISION,
        "source_license": "mit",
        "transformers": _package_version("transformers"),
        "torch": _package_version("torch"),
        "onnxruntime": _package_version("onnxruntime"),
        "conversion": {
            "tool": "scripts/model_pipeline.py",
            "converted_at_utc": converted_at,
            "timestamp_source": "latest canonical ONNX artifact modification time",
            "onnx_opset": ONNX_OPSET,
            "quantization": {
                "method": "onnxruntime.quantize_dynamic",
                "weight_type": "QUInt8",
                "op_types_to_quantize": ["Gather", "MatMul"],
                "per_channel": True,
                "matmul_const_b_only": True,
            },
            "fp16": {
                "method": "onnxconverter-common.float16.convert_float_to_float16",
                "keep_io_types": True,
            },
        },
        "runtime_compatibility": {
            "verified": ["onnxruntime CPUExecutionProvider"],
            "pending": ["onnxruntime-web WASM", "onnxruntime-web WebGPU"],
        },
        "quantization_size_comparison": {
            "embedding_and_matmul": {
                "artifact": "onnx/model_quantized.onnx",
                "description": (
                    "Dynamic QUInt8 weight quantization of the embedding Gather "
                    "and MatMul operators."
                ),
                "bytes": quantized_bytes,
                "embedding_fp32_bytes": embedding_fp32_bytes,
                "embedding_uint8_storage_bytes": embedding_fp32_bytes // 4,
            },
            "matmul_only": {
                "status": "comparison_only",
                "artifact": "artifacts/benchmarks/model_matmul_only.onnx",
                "description": (
                    "The same quantizer with op_types_to_quantize=[MatMul]; "
                    "this comparison artifact is not distributed."
                ),
                "bytes": matmul_only_bytes,
                "embedding_fp32_bytes": embedding_fp32_bytes,
            },
        },
        "platform": platform.platform(),
        "artifacts": artifacts,
    }
    destination = output_dir / "manifest.json"
    destination.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return destination


def _package_version(name: str) -> str:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return "unknown"


def command_line() -> int:
    _ensure_utf8_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command", choices=["download", "reference", "export", "convert", "manifest"]
    )
    parser.add_argument("--text", default="これはテストです。")
    args = parser.parse_args()
    if args.command == "download":
        download_upstream()
    elif args.command == "reference":
        print(json.dumps(reference_infer(args.text), ensure_ascii=False, indent=2))
    elif args.command == "export":
        print(export_onnx())
    elif args.command == "convert":
        fp32 = CONVERTED_ROOT / "onnx" / "model.onnx"
        print(quantize_int8(fp32))
        print(convert_fp16(fp32))
    else:
        print(write_manifest())
    return 0


if __name__ == "__main__":
    raise SystemExit(command_line())
