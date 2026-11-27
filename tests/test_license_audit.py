"""Node-only image dependencies require evidence that no code is bundled."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "sources,accepted",
    [
        (None, False),
        ([], False),
        (["../node_modules/sharp/lib/index.js"], False),
        (["../node_modules/@img/sharp-linux-x64/lib/index.js"], False),
        (["../node_modules/@huggingface/transformers/src/tokenizers.js"], True),
    ],
)
def test_native_image_exclusion_requires_clean_bundle_map(sources, accepted):
    code = (
        "import { nativeImageExclusion } from './scripts/licenses.mjs';"
        "try {"
        f"const reason=nativeImageExclusion('@img/sharp-libvips-linux-x64', {json.dumps(sources)});"
        "if (!reason) process.exit(2);"
        "} catch(error) {"
        "if (!error.message.startsWith('Native image bundle audit')) throw error;"
        "process.exit(42); }"
    )
    result = subprocess.run(
        [shutil.which("node"), "--input-type=module", "-e", code],
        capture_output=True,
        check=False,
    )
    assert result.returncode == (0 if accepted else 42), result.stderr.decode(errors="replace")


def _license_fixture(root, installed, sources=None, *, browser_license=True):
    """Run the real collector with two OS-specific installed dependency trees."""
    packages = {
        "node_modules/browser-helper": {"version": "1.0.0", "license": "MIT"},
        "node_modules/sharp": {"version": "0.35.5", "license": "Apache-2.0"},
        **{
            f"node_modules/@img/{name}": {
                "version": "0.35.5",
                "license": "Apache-2.0",
                "optional": True,
            }
            for name in ("sharp-win32-x64", "sharp-linux-x64", "sharp-linuxmusl-x64")
        },
    }
    root.mkdir()
    (root / "package-lock.json").write_text(json.dumps({"packages": packages}))
    provenance = root / "third_party/onnxruntime"
    provenance.mkdir(parents=True)
    (provenance / "sources.json").write_text(
        json.dumps({"resolvedPackages": [{"version": "1.0.0"}], "files": []})
    )
    runtime = root / "node_modules/onnxruntime-web/dist"
    runtime.mkdir(parents=True)
    (runtime / "ort.webgpu.min.mjs.map").write_text(json.dumps({"sources": ["ort.ts"]}))
    for name in ["browser-helper", "sharp", *installed]:
        relative = f"node_modules/{name}"
        directory = root / relative
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"name": name, **packages[relative]}))
        if name != "browser-helper" or browser_license:
            (directory / "LICENSE").write_text(f"License for {name}\n")
    target = root / "output"
    target.mkdir()
    collector = (Path(__file__).resolve().parents[1] / "scripts/licenses.mjs").as_uri()
    audit = {"sha256": "fixture-map", "sources": sources if sources is not None else ["browser.ts"]}
    code = (
        f"import {{writeLicenses}} from {json.dumps(collector)};"
        f"await writeLicenses({json.dumps(str(target))},{json.dumps(audit)});"
    )
    process = subprocess.run(
        [shutil.which("node"), "--input-type=module", "-e", code],
        cwd=root,
        capture_output=True,
        check=False,
    )
    inventory = {
        p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob("*") if p.is_file()
    }
    return process, inventory


def test_license_distribution_independent_of_installed_native_platform(tmp_path):
    windows, win_files = _license_fixture(tmp_path / "windows", ["@img/sharp-win32-x64"])
    linux, linux_files = _license_fixture(
        tmp_path / "linux", ["@img/sharp-linux-x64", "@img/sharp-linuxmusl-x64"]
    )
    assert windows.returncode == linux.returncode == 0, (windows.stderr, linux.stderr)
    assert win_files == linux_files
    assert set(win_files) == {
        "dependency-licenses.json",
        "bundled-runtime-audit.json",
        "licenses/browser-helper@1.0.0/LICENSE",
    }
    records = json.loads(win_files["dependency-licenses.json"])
    excluded = [record for record in records if record.get("notBundledReason")]
    assert len(excluded) == 4
    assert all(record["files"] == [] and record["version"] == "0.35.5" for record in excluded)
    assert {record["name"] for record in excluded} == {
        "sharp",
        "@img/sharp-win32-x64",
        "@img/sharp-linux-x64",
        "@img/sharp-linuxmusl-x64",
    }


def test_absent_native_package_still_requires_bundle_exclusion_proof(tmp_path):
    process, _ = _license_fixture(
        tmp_path / "unsafe", [], sources=["../node_modules/@img/sharp-linux-x64/index.js"]
    )
    assert process.returncode != 0
    assert b"Native image bundle audit requires" in process.stderr


def test_distributed_browser_code_still_requires_license_text(tmp_path):
    process, _ = _license_fixture(tmp_path / "missing", [], browser_license=False)
    assert process.returncode != 0
    assert b"Missing license text: browser-helper" in process.stderr
