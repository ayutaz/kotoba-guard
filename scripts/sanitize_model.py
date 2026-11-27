"""Remove private filesystem paths from ONNX debug metadata, preserving graph semantics."""

import argparse
import hashlib
import json
import re
from pathlib import Path

import onnx
from google.protobuf.descriptor import FieldDescriptor
from google.protobuf.message import Message

PRIVATE_PATH = re.compile(r"(?:[a-z]:[\\/]users[\\/]|/(?:home|users)/)", re.IGNORECASE)


def sanitize_model(source: onnx.ModelProto) -> tuple[onnx.ModelProto, int]:
    model = onnx.ModelProto()
    model.CopyFrom(source)

    def walk(message: Message) -> int:
        removed = 0
        for field, value in list(message.ListFields()):
            if field.name == "doc_string" and PRIVATE_PATH.search(value):
                message.ClearField(field.name)
                removed += 1
                continue
            if field.name == "metadata_props":
                for index in range(len(value) - 1, -1, -1):
                    if PRIVATE_PATH.search(value[index].key) or PRIVATE_PATH.search(
                        value[index].value
                    ):
                        del value[index]
                        removed += 1
            if field.type == FieldDescriptor.TYPE_MESSAGE:
                for child in value if field.is_repeated else [value]:
                    removed += walk(child)
            elif field.type == FieldDescriptor.TYPE_STRING:
                for text in value if field.is_repeated else [value]:
                    if PRIVATE_PATH.search(text):
                        raise ValueError(
                            "private path in semantic field; manual conversion review required"
                        )
        return removed

    return model, walk(model)


def verify_parity(source: Path, target: Path) -> None:
    import numpy as np
    import onnxruntime as ort

    original = ort.InferenceSession(str(source), providers=["CPUExecutionProvider"])
    sanitized = ort.InferenceSession(str(target), providers=["CPUExecutionProvider"])
    for length in (8, 32, 128):
        feeds = {}
        for item in original.get_inputs():
            if item.name == "input_ids":
                feeds[item.name] = np.arange(length, dtype=np.int64).reshape(1, length)
            elif item.name == "attention_mask":
                feeds[item.name] = np.ones((1, length), dtype=np.int64)
            else:
                raise ValueError("unrecognized model input")
        for before, after in zip(
            original.run(None, feeds), sanitized.run(None, feeds), strict=True
        ):
            if not np.array_equal(before, after):
                raise ValueError("sanitized graph changed inference outputs")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.source.resolve() == args.target.resolve():
        raise ValueError("source and sanitized output must be separate")
    model, removed = sanitize_model(onnx.load(args.source, load_external_data=False))
    args.target.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, args.target)
    onnx.checker.check_model(str(args.target))
    if args.verify:
        verify_parity(args.source, args.target)
    content = args.target.read_bytes()
    print(
        json.dumps(
            {
                "removedDebugFields": removed,
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "inferenceParity": "exact at 8,32,128 tokens" if args.verify else "not run",
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"model-sanitization-failed: {type(error).__name__}") from None
