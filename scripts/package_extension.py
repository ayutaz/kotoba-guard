"""Create a deterministic local ZIP; never publish anything."""

import hashlib
import json
import zipfile
from pathlib import Path

try:
    from scripts.verify_package import verify_directory
except ModuleNotFoundError:
    from verify_package import verify_directory


def create_zip(root: Path, output: Path) -> None:
    verify_directory(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    verify_zip(output)


def verify_zip(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        entries = archive.namelist()
        inventory = json.loads(archive.read("distribution-manifest.json"))["files"]
        if len(entries) != len(set(entries)) or set(entries) != set(inventory) | {
            "distribution-manifest.json"
        }:
            raise ValueError("ZIP inventory mismatch")
        for name, metadata in inventory.items():
            content = archive.read(name)
            if (
                len(content) != metadata["bytes"]
                or hashlib.sha256(content).hexdigest() != metadata["sha256"]
            ):
                raise ValueError(f"ZIP content mismatch: {name}")
    return {"ok": True, "files": len(entries)}


def main() -> None:
    output = Path("artifacts/kotoba-guard.zip")
    create_zip(Path("dist/extension"), output)
    with output.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{checksum}  {output.name}\n", encoding="utf-8")
    print(json.dumps({"zip": str(output), "bytes": output.stat().st_size, "sha256": checksum}))


if __name__ == "__main__":
    main()
