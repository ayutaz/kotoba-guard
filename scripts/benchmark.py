"""Run one transparent CPU smoke benchmark over converted ONNX artifacts."""

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.model_pipeline import CONVERTED_ROOT, onnx_infer

if __name__ == "__main__":
    text = "明日の予定については、来週移行にご連絡します。"
    for name in ("model.onnx", "model_quantized.onnx", "model_fp16.onnx"):
        result = onnx_infer(CONVERTED_ROOT / "onnx" / name, text)
        print(name, result["elapsed_ms"], result["detections"])
