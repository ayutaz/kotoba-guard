"""Distribution must fail closed when inference assets or policies are missing."""

import hashlib
import json
import zipfile

import pytest

from scripts.model_pipeline import EXPECTED_REVISION, MODEL_ID
from scripts.package_extension import create_zip, verify_zip
from scripts.verify_package import verify_directory


def inventory(root):
    files = {
        path.relative_to(root).as_posix(): {
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in root.rglob("*")
        if path.is_file() and path.name != "distribution-manifest.json"
    }
    (root / "distribution-manifest.json").write_text(json.dumps({"files": files}))


def fixture(tmp_path):
    (tmp_path / "models").mkdir(parents=True)
    (tmp_path / "wasm").mkdir()
    (tmp_path / "wasm/runtime.wasm").write_bytes(b"wasm-fixture")
    model = b"onnx-fixture"
    (tmp_path / "models/model_quantized.onnx").write_bytes(model)
    for name in ["config.json", "tokenizer.json", "tokenizer_config.json"]:
        (tmp_path / "models" / name).write_text("{}")
    (tmp_path / "models/LICENSE").write_text("upstream license")
    (tmp_path / "models/manifest.json").write_text(
        json.dumps(
            {
                "model_id": MODEL_ID,
                "revision": EXPECTED_REVISION,
                "source_license": "mit",
                "files": [
                    {
                        "path": "model_quantized.onnx",
                        "size": len(model),
                        "sha256": hashlib.sha256(model).hexdigest(),
                    }
                ],
            }
        )
    )
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "manifest_version": 3,
                "permissions": ["activeTab", "scripting", "storage", "offscreen"],
                "content_security_policy": {
                    "extension_pages": (
                        "script-src 'self' 'wasm-unsafe-eval'; "
                        "object-src 'self'; connect-src 'self'"
                    )
                },
            }
        )
    )
    inventory(tmp_path)
    return tmp_path


def test_missing_assets_refuse_release(tmp_path):
    with pytest.raises(ValueError, match="manifest"):
        verify_directory(tmp_path)


@pytest.mark.parametrize(
    "markup",
    [
        '<link rel="stylesheet" href="popup.css">',
        '<script src="popup.js"></script>',
        '<link rel="stylesheet" href="https://example.invalid/style.css">',
        '<script src="../outside.js"></script>',
    ],
)
def test_html_resource_must_exist_inside_distribution(tmp_path, markup):
    root = fixture(tmp_path)
    (root / "popup.html").write_text(markup)
    inventory(root)
    with pytest.raises(ValueError, match="resource|external"):
        verify_directory(root)


def test_existing_local_html_resources_are_accepted(tmp_path):
    root = fixture(tmp_path)
    (root / "popup.html").write_text(
        '<link rel="stylesheet" href="/popup.css?v=1#main">'
        '<script src="./popup.js"></script>'
        '<a href="https://example.invalid">project</a>'
    )
    (root / "popup.css").write_text("body { color: black; }")
    (root / "popup.js").write_text("export {};")
    inventory(root)
    assert verify_directory(root)["ok"]


def test_reject_default_all_site_access(tmp_path):
    root = fixture(tmp_path)
    path = root / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["host_permissions"] = ["<all_urls>"]
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="host"):
        verify_directory(root)


def test_tampered_model_rejected(tmp_path):
    root = fixture(tmp_path)
    (root / "models/model_quantized.onnx").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="hash|size"):
        verify_directory(root)


def test_private_path_in_model_is_rejected_even_with_matching_hashes(tmp_path):
    root = fixture(tmp_path)
    content = b"ONNX debug at C:/Users/example/source.py"
    (root / "models/model_quantized.onnx").write_bytes(content)
    path = root / "models/manifest.json"
    metadata = json.loads(path.read_text())
    metadata["files"][0].update(size=len(content), sha256=hashlib.sha256(content).hexdigest())
    path.write_text(json.dumps(metadata))
    inventory(root)
    with pytest.raises(ValueError, match="private filesystem"):
        verify_directory(root)


def test_traversal_manifest_rejected(tmp_path):
    root = fixture(tmp_path)
    (root / "models/manifest.json").write_text(
        json.dumps({"files": [{"path": "../manifest.json", "size": 0, "sha256": "0" * 64}]})
    )
    with pytest.raises(ValueError, match="path"):
        verify_directory(root)


def test_model_assets_are_not_web_accessible(tmp_path):
    root = fixture(tmp_path)
    path = root / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["web_accessible_resources"] = [{"resources": ["models/*"], "matches": ["<all_urls>"]}]
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="web accessible"):
        verify_directory(root)


def test_remote_script_rejected(tmp_path):
    root = fixture(tmp_path)
    (root / "popup.html").write_text('<script src="https://example.com/code.js"></script>')
    with pytest.raises(ValueError, match="external script"):
        verify_directory(root)


def test_deterministic_zip(tmp_path):
    root = fixture(tmp_path / "extension")
    first, second = tmp_path / "a.zip", tmp_path / "b.zip"
    create_zip(root, first)
    create_zip(root, second)
    assert first.read_bytes() == second.read_bytes()
    with zipfile.ZipFile(first) as archive:
        assert "manifest.json" in archive.namelist()
    assert verify_zip(first)["ok"]


def test_zip_content_is_verified_after_packaging(tmp_path):
    root = fixture(tmp_path / "extension")
    target = tmp_path / "bad.zip"
    with zipfile.ZipFile(target, "w") as archive:
        for path in root.rglob("*"):
            if path.is_file():
                content = b"changed" if path.name == "runtime.wasm" else path.read_bytes()
                archive.writestr(path.relative_to(root).as_posix(), content)
    with pytest.raises(ValueError, match="ZIP.*mismatch"):
        verify_zip(target)


def test_modified_runtime_is_rejected(tmp_path):
    root = fixture(tmp_path)
    (root / "wasm/runtime.wasm").write_bytes(b"altered-runtime")
    with pytest.raises(ValueError, match="distribution.*mismatch"):
        verify_directory(root)


def test_uninventoried_script_is_rejected(tmp_path):
    root = fixture(tmp_path)
    (root / "extra.js").write_text("console.log('unexpected')")
    with pytest.raises(ValueError, match="inventory"):
        verify_directory(root)


def test_distribution_path_traversal_is_rejected(tmp_path):
    root = fixture(tmp_path)
    (root / "distribution-manifest.json").write_text(
        json.dumps({"files": {"../outside.js": {"bytes": 0, "sha256": ""}}})
    )
    with pytest.raises(ValueError, match="distribution path"):
        verify_directory(root)


@pytest.mark.parametrize(
    "field,value",
    [("revision", "main"), ("model_id", "unknown/model"), ("source_license", "unknown")],
)
def test_unpinned_provenance_is_rejected(tmp_path, field, value):
    root = fixture(tmp_path)
    manifest = root / "models/manifest.json"
    metadata = json.loads(manifest.read_text())
    metadata[field] = value
    manifest.write_text(json.dumps(metadata))
    inventory(root)
    with pytest.raises(ValueError, match="provenance"):
        verify_directory(root)


@pytest.mark.parametrize(
    "code",
    [
        'fetch("https://example.invalid/input")',
        'import("https://example.invalid/runtime.js")',
        'new WebSocket("wss://example.invalid/stream")',
        'import {run} from "https://example.invalid/runtime.js"',
    ],
)
def test_literal_remote_execution_and_communication_are_rejected(tmp_path, code):
    root = fixture(tmp_path)
    (root / "content.js").write_text(code)
    inventory(root)
    with pytest.raises(ValueError, match="remote"):
        verify_directory(root)
