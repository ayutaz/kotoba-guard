"""Generate the code-native Kotoba Guard icon without third-party packages."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "extension" / "public" / "icons"
SIZES = (16, 32, 48, 128)
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"
  role="img" aria-label="Kotoba Guard">
  <title>Kotoba Guard</title>
  <path fill="#0b1f3a" stroke="#2dd4bf" stroke-width="8" stroke-linejoin="round"
    d="M128 18 218 52v64c0 58-37 103-90 122-53-19-90-64-90-122V52z"/>
  <path fill="none" stroke="#f8fafc" stroke-width="18"
    stroke-linecap="round" stroke-linejoin="round"
    d="M86 88h84v78H86"/>
</svg>
"""

SHIELD = (
    (128, 18),
    (218, 52),
    (218, 116),
    (211, 148),
    (196, 179),
    (174, 204),
    (128, 238),
    (82, 204),
    (60, 179),
    (45, 148),
    (38, 116),
    (38, 52),
)
GLYPH = (((86, 88), (170, 88)), ((170, 88), (170, 166)), ((170, 166), (86, 166)))


def point_in_polygon(x: float, y: float, polygon: tuple[tuple[float, float], ...]) -> bool:
    inside = False
    previous = polygon[-1]
    for current in polygon:
        if (current[1] > y) != (previous[1] > y):
            crossing = (previous[0] - current[0]) * (y - current[1]) / (
                previous[1] - current[1]
            ) + current[0]
            if x < crossing:
                inside = not inside
        previous = current
    return inside


def distance_to_segment(
    x: float, y: float, start: tuple[float, float], end: tuple[float, float]
) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return ((x - start[0]) ** 2 + (y - start[1]) ** 2) ** 0.5
    projection = max(0.0, min(1.0, ((x - start[0]) * dx + (y - start[1]) * dy) / length_squared))
    nearest_x = start[0] + projection * dx
    nearest_y = start[1] + projection * dy
    return ((x - nearest_x) ** 2 + (y - nearest_y) ** 2) ** 0.5


def on_segments(
    x: float,
    y: float,
    segments: tuple[tuple[tuple[float, float], tuple[float, float]], ...],
    width: float,
) -> bool:
    return any(distance_to_segment(x, y, start, end) <= width / 2 for start, end in segments)


def rgba_for_sample(x: float, y: float) -> tuple[int, int, int, int]:
    if not point_in_polygon(x, y, SHIELD):
        return (0, 0, 0, 0)
    if on_segments(x, y, tuple(zip(SHIELD, SHIELD[1:] + SHIELD[:1], strict=True)), 8):
        return (45, 212, 191, 255)
    if on_segments(x, y, GLYPH, 18):
        return (248, 250, 252, 255)
    return (11, 31, 58, 255)


def render(size: int, supersample: int = 4) -> bytes:
    rows = bytearray()
    for pixel_y in range(size):
        rows.append(0)
        for pixel_x in range(size):
            totals = [0, 0, 0, 0]
            for sub_y in range(supersample):
                for sub_x in range(supersample):
                    x = (pixel_x + (sub_x + 0.5) / supersample) * 256 / size
                    y = (pixel_y + (sub_y + 0.5) / supersample) * 256 / size
                    sample = rgba_for_sample(x, y)
                    for channel, value in enumerate(sample):
                        totals[channel] += value
            count = supersample * supersample
            rows.extend(value // count for value in totals)
    return bytes(rows)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    checksum = struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return struct.pack(">I", len(data)) + kind + data + checksum


def write_png(path: Path, size: int) -> None:
    raw = render(size)
    payload = PNG_SIGNATURE + png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    payload += png_chunk(b"IDAT", zlib.compress(raw, 9)) + png_chunk(b"IEND", b"")
    path.write_bytes(payload)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / "icon.svg").open("w", encoding="utf-8", newline="\n") as file:
        file.write(SVG)
    for size in SIZES:
        write_png(OUTPUT / f"icon{size}.png", size)


if __name__ == "__main__":
    main()
