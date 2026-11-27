"""Fail closed on incomplete or unsafe extension distribution assets."""

import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

try:
    from scripts.model_pipeline import EXPECTED_REVISION, MODEL_ID
except ModuleNotFoundError:
    from model_pipeline import EXPECTED_REVISION, MODEL_ID


class ScriptAudit(HTMLParser):
    def __init__(self, root: Path, html: Path):
        super().__init__()
        self.root = root.resolve()
        self.html = html

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "script":
            source = attributes.get("src", "") or ""
        elif tag == "link" and "stylesheet" in (attributes.get("rel", "") or "").lower().split():
            source = attributes.get("href", "") or ""
        else:
            return
        if not source:
            return
        url = urlsplit(source)
        if url.scheme or url.netloc or "\\" in source:
            kind = "script" if tag == "script" else "resource"
            raise ValueError(f"external {kind} in extension HTML")
        relative = unquote(url.path)
        path = (
            self.root / relative.lstrip("/")
            if relative.startswith("/")
            else self.html.parent / relative
        ).resolve()
        if not path.is_relative_to(self.root) or not path.is_file():
            raise ValueError("missing or invalid local HTML resource")


def verify_directory(root: Path) -> dict:
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError("extension manifest missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError("Manifest V3 required")
    if manifest.get("host_permissions") or manifest.get("content_scripts"):
        raise ValueError("default host access is forbidden")
    if manifest.get("web_accessible_resources"):
        raise ValueError("web accessible resources require a reviewed exception")
    for optional in manifest.get("optional_host_permissions", []):
        if optional not in {"http://*/*", "https://*/*"}:
            raise ValueError("unexpected optional host permission")
    for html in root.rglob("*.html"):
        ScriptAudit(root, html).feed(html.read_text(encoding="utf-8"))
    # This intentionally narrow static scan complements offline execution and
    # traffic monitoring; it is not a general JavaScript data-flow proof.
    remote_calls = re.compile(
        r"(?:\b(?:fetch|import|WebSocket|Worker|SharedWorker|sendBeacon)\s*\(\s*"
        r"|\bfrom\s*)[\"'`](?:https?:|wss?:|//)",
    )
    for pattern in ("*.js", "*.mjs"):
        for script in root.rglob(pattern):
            if remote_calls.search(script.read_text(encoding="utf-8")):
                raise ValueError(f"literal remote execution or communication: {script.name}")
    allowed = {"activeTab", "scripting", "storage", "offscreen"}
    if not set(manifest.get("permissions", [])).issubset(allowed):
        raise ValueError("unexpected extension permission")
    csp = manifest.get("content_security_policy", {}).get("extension_pages", "")
    if "connect-src 'self'" not in csp or "'wasm-unsafe-eval'" not in csp:
        raise ValueError("local WASM CSP missing")
    for forbidden in ["https:", "http:", "'unsafe-eval'", "'unsafe-inline'"]:
        if forbidden in csp:
            raise ValueError("unsafe CSP")
    models = root / "models"
    for name in [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "LICENSE",
        "manifest.json",
    ]:
        if not (models / name).is_file():
            raise ValueError(f"missing bundled model asset: {name}")
    if not list((root / "wasm").glob("*.wasm")):
        raise ValueError("bundled WASM missing")
    assets = json.loads((models / "manifest.json").read_text(encoding="utf-8"))
    entries = assets.get("files")
    if isinstance(entries, dict):
        entries = [{"path": name, **values} for name, values in entries.items()]
    if not isinstance(entries, list) or not entries:
        raise ValueError("model manifest inventory missing")
    has_quantized = False
    for entry in entries:
        relative = entry["path"]
        path = (models / relative).resolve()
        if not path.is_relative_to(models.resolve()) or Path(relative).is_absolute():
            raise ValueError("invalid model path")
        if not path.is_file():
            raise ValueError(f"missing model file: {relative}")
        expected_size = entry.get("size", entry.get("bytes"))
        if expected_size != path.stat().st_size:
            raise ValueError(f"model size mismatch: {relative}")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != entry["sha256"]:
            raise ValueError(f"model hash mismatch: {relative}")
        if relative.endswith(".onnx") and re.search(
            rb"(?:[a-z]:[\\/]users[\\/]|/(?:home|users)/)", path.read_bytes(), re.IGNORECASE
        ):
            raise ValueError("private filesystem path in distributed model")
        has_quantized |= relative.endswith("model_quantized.onnx")
    if not has_quantized:
        raise ValueError("quantized model not present in inventory")
    if (
        assets.get("model_id") != MODEL_ID
        or assets.get("revision") != EXPECTED_REVISION
        or assets.get("source_license") != "mit"
    ):
        raise ValueError("model provenance does not match pinned source")
    distribution_path = root / "distribution-manifest.json"
    if not distribution_path.is_file():
        raise ValueError("distribution inventory missing")
    distribution = json.loads(distribution_path.read_text(encoding="utf-8")).get("files")
    if not isinstance(distribution, dict) or not distribution:
        raise ValueError("distribution inventory empty")
    for relative, metadata in distribution.items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or Path(relative).is_absolute():
            raise ValueError("invalid distribution path")
        if not path.is_file() or path.stat().st_size != metadata["bytes"]:
            raise ValueError(f"distribution size mismatch: {relative}")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != metadata["sha256"]:
            raise ValueError(f"distribution hash mismatch: {relative}")
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path != distribution_path
    }
    if set(distribution) != actual:
        raise ValueError("distribution inventory differs from package contents")
    return {"ok": True, "modelFiles": len(entries), "distributionFiles": len(actual)}


if __name__ == "__main__":
    print(json.dumps(verify_directory(Path("dist/extension")), indent=2))
