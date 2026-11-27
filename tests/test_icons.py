"""Regression checks for the reproducible Chrome Web Store icon assets."""

from __future__ import annotations

import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "extension" / "public" / "icons"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
EXPECTED_SIZES = (16, 32, 48, 128)


def _png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data.startswith(PNG_SIGNATURE), path
    assert data[12:16] == b"IHDR", path
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def test_manifest_declares_existing_icon_assets() -> None:
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    icons = manifest["icons"]
    action_icons = manifest["action"]["default_icon"]
    for size in EXPECTED_SIZES:
        expected = f"icons/icon{size}.png"
        assert icons[str(size)] == expected
        assert action_icons[str(size)] == expected
        path = ROOT / "extension" / "public" / expected
        assert path.is_file(), path


def test_png_icons_have_expected_dimensions_and_payload() -> None:
    for size in EXPECTED_SIZES:
        path = ICON_DIR / f"icon{size}.png"
        assert _png_dimensions(path) == (size, size)
        assert path.stat().st_size > 100, path


def test_svg_source_and_generator_are_tracked_inputs() -> None:
    svg = (ICON_DIR / "icon.svg").read_text(encoding="utf-8")
    assert '<svg xmlns="http://www.w3.org/2000/svg"' in svg
    assert "Kotoba Guard" in svg
    assert (ROOT / "scripts" / "generate_icons.py").is_file()


def test_generator_reproduces_tracked_assets_byte_for_byte(tmp_path: Path, monkeypatch) -> None:
    from scripts import generate_icons

    monkeypatch.setattr(generate_icons, "OUTPUT", tmp_path)
    generate_icons.main()
    for name in ("icon.svg", *(f"icon{size}.png" for size in EXPECTED_SIZES)):
        assert (tmp_path / name).read_bytes() == (ICON_DIR / name).read_bytes(), name
    assert b"\r\n" not in (tmp_path / "icon.svg").read_bytes()
