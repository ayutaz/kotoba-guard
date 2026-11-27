"""CLI entry point for the pinned FP32 ONNX export."""

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.model_pipeline import export_onnx

if __name__ == "__main__":
    print(export_onnx())
