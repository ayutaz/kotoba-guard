"""Validate ONNX structure and CPU Runtime loading for converted artifacts."""

from __future__ import annotations

import argparse
from pathlib import Path

import onnx
import onnxruntime as ort


def validate(path: Path) -> dict[str, object]:
    # Passing the path lets ONNX resolve the adjacent external-data file.
    onnx.checker.check_model(str(path))
    model = onnx.load_model(str(path), load_external_data=False)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return {
        "path": path.as_posix(),
        "inputs": [value.name for value in session.get_inputs()],
        "outputs": [value.name for value in session.get_outputs()],
        "nodes": len(model.graph.node),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    print(validate(args.path))
