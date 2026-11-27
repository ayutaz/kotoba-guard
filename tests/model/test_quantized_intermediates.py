import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper

from scripts.diagnose_quantized_intermediates import (
    BLOCK_BOUNDARY_OUTPUTS,
    INTERMEDIATE_OUTPUTS,
    DiagnosticError,
    _array_summary,
    _optimization_level,
    _profile_expected_names,
    _profile_output_names,
    _run_session,
    _select_first_failed_row,
    augment_intermediate_outputs,
    build_parser,
    run_cpu_diagnostic,
    sha256_file,
)


def _tiny_graph(path: Path, *, include_all: bool = True) -> None:
    x = helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 2])
    logits = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2])
    nodes = [helper.make_node("Identity", ["x"], ["logits"], name="logits")]
    if include_all:
        nodes.extend(
            helper.make_node("Identity", ["x"], [name], name=f"node_{index}")
            for index, name in enumerate(INTERMEDIATE_OUTPUTS)
        )
    graph = helper.make_graph(nodes, "tiny", [x], [logits])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    onnx.save(model, str(path))


def _profile_graph() -> SimpleNamespace:
    nodes = []
    values = []
    for index in range(42):
        source = f"source_{index}"
        quantized = f"source_{index}_quantized"
        scale = f"source_{index}_scale"
        zero_point = f"source_{index}_zero_point"
        integer = f"linear_{index}_output_quantized"
        cast = f"linear_{index}_output_quantized_cast_output"
        combined = f"node_linear_{index}_quant_scales_mul:0"
        linear = f"linear_{index}"
        nodes.extend(
            [
                SimpleNamespace(
                    op_type="DynamicQuantizeLinear",
                    input=[source],
                    output=[quantized, scale, zero_point],
                ),
                SimpleNamespace(op_type="Mul", input=[scale, f"weight_{index}"], output=[combined]),
                SimpleNamespace(
                    op_type="MatMulInteger",
                    input=[quantized, f"weight_{index}", zero_point, f"weight_zp_{index}"],
                    output=[integer],
                ),
                SimpleNamespace(
                    op_type="Cast",
                    input=[integer],
                    output=[cast],
                    attribute=[SimpleNamespace(name="to", i=1)],
                ),
                SimpleNamespace(op_type="Mul", input=[cast, combined], output=[linear]),
            ]
        )
        values.extend([source, quantized, scale, zero_point, integer, cast, combined, linear])
    for boundary in BLOCK_BOUNDARY_OUTPUTS:
        boundary_index = int(boundary.removeprefix("add_"))
        nodes.append(
            SimpleNamespace(
                op_type="Add",
                input=[
                    f"add_{boundary_index - 1}",
                    f"linear_{boundary_index - 4}",
                ],
                output=[boundary],
            )
        )
        values.append(boundary)
    initializers = [SimpleNamespace(name=f"weight_{index}", data_type=2) for index in range(42)] + [
        SimpleNamespace(name=f"weight_zp_{index}", data_type=2) for index in range(42)
    ]
    return SimpleNamespace(
        graph=SimpleNamespace(
            node=nodes,
            value_info=[SimpleNamespace(name=name) for name in set(values)],
            input=[],
            output=[],
            initializer=initializers,
        )
    )


def _pinned_inputs(tmp_path: Path) -> tuple[Path, Path, str, str]:
    fixture = tmp_path / "fixture.json"
    baseline = tmp_path / "baseline.json"
    fixture.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "id": "clean",
                        "text": "secret must not be returned",
                        "expected_input_ids": [1, 2],
                        "expected_attention_mask": [1, 1],
                    },
                    {
                        "id": "failed",
                        "text": "another secret",
                        "expected_input_ids": [3, 4],
                        "expected_attention_mask": [1, 0],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    baseline.write_text(
        json.dumps(
            {
                "rows": [
                    {"id": "clean", "max_abs_logit_delta": 0.001},
                    {"id": "failed", "max_abs_logit_delta": 0.2},
                ]
            }
        ),
        encoding="utf-8",
    )
    from scripts.diagnose_quantized_intermediates import sha256_file

    return fixture, baseline, sha256_file(fixture), sha256_file(baseline)


def test_augment_adds_only_required_outputs_and_preserves_source(tmp_path: Path) -> None:
    source = tmp_path / "source.onnx"
    output = tmp_path / "instrumented.onnx"
    _tiny_graph(source)

    augment_intermediate_outputs(source, output)

    original = onnx.load(str(source), load_external_data=False)
    instrumented = onnx.load(str(output), load_external_data=False)
    assert [item.name for item in original.graph.output] == ["logits"]
    assert [item.name for item in instrumented.graph.output] == [
        "logits",
        *INTERMEDIATE_OUTPUTS,
    ]


def test_capture_profiles_bind_allowlisted_graph_values() -> None:
    model = _profile_graph()
    boundaries = _profile_output_names(model, "block-boundaries")
    assert boundaries == BLOCK_BOUNDARY_OUTPUTS
    block_zero = _profile_output_names(model, "block-0")
    classifier = _profile_output_names(model, "classifier")
    assert len(block_zero) == 32
    assert len(classifier) == 16
    assert len(set(block_zero)) == len(block_zero)
    with pytest.raises(DiagnosticError, match="unsupported capture profile"):
        _profile_output_names(model, "arbitrary")


def test_capture_boundaries_reject_misconnected_residual() -> None:
    model = _profile_graph()
    model.graph.node[-1].input = ["wrong_left", "wrong_right"]
    with pytest.raises(DiagnosticError, match="residual Add"):
        _profile_output_names(model, "block-boundaries")


def test_capture_profile_name_formulas_are_deterministic() -> None:
    assert _profile_expected_names("block-1")[0] == "layer_norm_2"
    assert _profile_expected_names("block-9")[-1] == "linear_39"
    assert _profile_expected_names("classifier")[-4:] == (
        "node_MatMul_1201_quant_scales_mul:0",
        "val_1245_output_quantized",
        "val_1245_output_quantized_cast_output",
        "val_1245",
    )


def test_augment_rejects_missing_intermediate_and_existing_output(tmp_path: Path) -> None:
    source = tmp_path / "source.onnx"
    _tiny_graph(source, include_all=False)
    with pytest.raises(DiagnosticError, match="required intermediate"):
        augment_intermediate_outputs(source, tmp_path / "instrumented.onnx")

    _tiny_graph(source)
    existing = tmp_path / "existing.onnx"
    existing.write_bytes(b"already exists")
    with pytest.raises(DiagnosticError, match="refusing overwrite"):
        augment_intermediate_outputs(source, existing)


def test_selection_uses_first_delta_above_gate_without_returning_text(tmp_path: Path) -> None:
    fixture, baseline, fixture_sha, baseline_sha = _pinned_inputs(tmp_path)

    selected = _select_first_failed_row(
        fixture,
        baseline,
        expected_fixture_sha=fixture_sha,
        expected_baseline_sha=baseline_sha,
    )

    assert selected.index == 1
    assert selected.row_id == "failed"
    assert selected.input_ids == (3, 4)
    assert selected.attention_mask == (1, 0)
    assert not hasattr(selected, "text")


def test_selection_rejects_nonfinite_baseline_delta(tmp_path: Path) -> None:
    fixture, baseline, fixture_sha, _ = _pinned_inputs(tmp_path)
    baseline.write_text(json.dumps({"rows": [{"id": "clean", "max_abs_logit_delta": "nan"}]}))
    from scripts.diagnose_quantized_intermediates import sha256_file

    with pytest.raises(DiagnosticError, match="logit delta"):
        _select_first_failed_row(
            fixture,
            baseline,
            expected_fixture_sha=fixture_sha,
            expected_baseline_sha=sha256_file(baseline),
        )


def test_array_summary_reports_integer_mismatch_and_float_delta() -> None:
    integer = _array_summary(np.array([[1, 2]], dtype=np.uint8), np.array([[1, 4]], dtype=np.uint8))
    assert integer["exact_mismatch_count"] == 1
    assert integer["first_mismatch_index"] == 1

    floating = _array_summary(np.array([1.0, 3.0]), np.array([1.5, 2.0]))
    assert floating["max_abs_delta"] == 1.0
    assert floating["mean_abs_delta"] == 0.75
    dtype_mismatch = _array_summary(np.array([1], dtype=np.uint8), np.array([1], dtype=np.int32))
    assert dtype_mismatch["dtype_match"] is False
    assert dtype_mismatch["exact_mismatch_count"] is None


def test_optimization_level_is_explicit_and_rejects_unknown_value() -> None:
    fake_ort = SimpleNamespace(ORT_ENABLE_ALL=99, ORT_DISABLE_ALL=0)
    assert _optimization_level(fake_ort, "all") == ("ORT_ENABLE_ALL", 99)
    assert _optimization_level(fake_ort, "disabled") == ("ORT_DISABLE_ALL", 0)
    with pytest.raises(DiagnosticError, match="graph optimization"):
        _optimization_level(fake_ort, "basic")


def test_optimization_level_uses_installed_onnxruntime_enum() -> None:
    import onnxruntime as ort

    assert _optimization_level(ort, "all") == (
        "ORT_ENABLE_ALL",
        ort.GraphOptimizationLevel.ORT_ENABLE_ALL,
    )
    assert _optimization_level(ort, "disabled") == (
        "ORT_DISABLE_ALL",
        ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
    )


class _FakeSession:
    def __init__(
        self,
        path: str,
        *,
        nonfinite: bool = False,
        bad_shape: bool = False,
        metadata_bad_dtype: bool = False,
        metadata_bad_shape: bool = False,
    ) -> None:
        self.instrumented = "instrumented" in path
        self.nonfinite = nonfinite
        self.bad_shape = bad_shape
        self.metadata_bad_dtype = metadata_bad_dtype
        self.metadata_bad_shape = metadata_bad_shape

    def get_outputs(self):
        names = ["logits", *INTERMEDIATE_OUTPUTS] if self.instrumented else ["logits"]
        metadata = []
        for name in names:
            if name == "logits":
                shape = [1, 1] if self.bad_shape and self.instrumented else [1, 1, 2]
                metadata.append(SimpleNamespace(name=name, type="tensor(float)", shape=shape))
            elif name in {"layer_norm_quantized", "layer_norm_zero_point"}:
                metadata.append(SimpleNamespace(name=name, type="tensor(uint8)", shape=[1, 1]))
            elif name == "linear_output_quantized":
                metadata.append(SimpleNamespace(name=name, type="tensor(int32)", shape=[1, 1]))
            else:
                dtype = (
                    "tensor(uint8)"
                    if self.metadata_bad_dtype and name == "layer_norm"
                    else "tensor(float)"
                )
                shape = [1, 2] if self.metadata_bad_shape and name == "layer_norm" else [1, 1]
                metadata.append(SimpleNamespace(name=name, type=dtype, shape=shape))
        return metadata

    def run(self, _output_names, _feed):
        logits = np.array([[[1.0, 2.0]]], dtype=np.float32)
        if self.bad_shape and self.instrumented:
            logits = np.array([[1.0]], dtype=np.float32)
        values = [logits]
        for name in INTERMEDIATE_OUTPUTS:
            if name in {"layer_norm_quantized", "layer_norm_zero_point"}:
                values.append(np.array([[1]], dtype=np.uint8))
            elif name == "linear_output_quantized":
                values.append(np.array([[1]], dtype=np.int32))
            else:
                value = np.array([[1.0]], dtype=np.float32)
                if self.nonfinite and name == "layer_norm":
                    value[0, 0] = np.nan
                values.append(value)
        return values if self.instrumented else [logits]


class _FakeOrt:
    __version__ = "fake"
    ORT_ENABLE_ALL = 99
    ORT_DISABLE_ALL = 0

    class SessionOptions:
        intra_op_num_threads = None
        inter_op_num_threads = None
        graph_optimization_level = None

    def __init__(
        self,
        *,
        nonfinite: bool = False,
        bad_shape: bool = False,
        metadata_bad_dtype: bool = False,
        metadata_bad_shape: bool = False,
    ) -> None:
        self.nonfinite = nonfinite
        self.bad_shape = bad_shape
        self.metadata_bad_dtype = metadata_bad_dtype
        self.metadata_bad_shape = metadata_bad_shape

    def InferenceSession(self, path, *, sess_options, providers):
        assert providers == ["CPUExecutionProvider"]
        assert sess_options.intra_op_num_threads == 1
        assert sess_options.inter_op_num_threads == 1
        return _FakeSession(
            path,
            nonfinite=self.nonfinite,
            bad_shape=self.bad_shape,
            metadata_bad_dtype=self.metadata_bad_dtype,
            metadata_bad_shape=self.metadata_bad_shape,
        )


@pytest.mark.parametrize(
    "fake_kwargs", [{"metadata_bad_dtype": True}, {"metadata_bad_shape": True}]
)
def test_runtime_rejects_intermediate_metadata_mismatch(
    tmp_path: Path, fake_kwargs: dict[str, bool]
) -> None:
    source = tmp_path / "source.onnx"
    _tiny_graph(source)
    with pytest.raises(DiagnosticError, match="(dtype|rank|shape)"):
        _run_session(
            tmp_path / "instrumented.onnx",
            (1, 2),
            (1, 1),
            "all",
            ort_module=_FakeOrt(**fake_kwargs),
        )


def test_full_cpu_diagnostic_writes_bound_report_and_npz(tmp_path: Path) -> None:
    source = tmp_path / "source.onnx"
    _tiny_graph(source)
    fixture, baseline, fixture_sha, baseline_sha = _pinned_inputs(tmp_path)
    report = run_cpu_diagnostic(
        source,
        fixture,
        baseline,
        tmp_path / "instrumented.onnx",
        tmp_path / "outputs.npz",
        tmp_path / "report.json",
        expected_model_sha=sha256_file(source),
        expected_fixture_sha=fixture_sha,
        expected_baseline_sha=baseline_sha,
        ort_module=_FakeOrt(),
    )
    assert report["status"] == "passed"
    assert report["instrumented_logits_reproduction"]["max_abs_delta"] == 0.0
    assert report["npz_sha256"]
    assert (tmp_path / "report.json").exists()


@pytest.mark.parametrize(
    "fake_kwargs,expected",
    [
        ({"bad_shape": True}, "shape"),
        ({"nonfinite": True}, "nonfinite"),
    ],
)
def test_full_cpu_diagnostic_fails_closed_for_bad_outputs(
    tmp_path: Path, fake_kwargs: dict[str, bool], expected: str
) -> None:
    source = tmp_path / "source.onnx"
    _tiny_graph(source)
    fixture, baseline, fixture_sha, baseline_sha = _pinned_inputs(tmp_path)
    report = run_cpu_diagnostic(
        source,
        fixture,
        baseline,
        tmp_path / "instrumented.onnx",
        tmp_path / "outputs.npz",
        tmp_path / "report.json",
        expected_model_sha=sha256_file(source),
        expected_fixture_sha=fixture_sha,
        expected_baseline_sha=baseline_sha,
        ort_module=_FakeOrt(**fake_kwargs),
    )
    assert report["status"] == "failed"
    assert any(expected in failure for failure in report["gate"]["failures"])


def test_cli_help_is_available_without_importing_runtime(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args(["--help"])
    assert raised.value.code == 0


def test_cpu_diagnostic_rejects_existing_outputs_and_changed_fixture(tmp_path: Path) -> None:
    source = tmp_path / "source.onnx"
    _tiny_graph(source)
    fixture, baseline, fixture_sha, baseline_sha = _pinned_inputs(tmp_path)
    output_model = tmp_path / "instrumented.onnx"
    output_model.write_bytes(b"existing")
    with pytest.raises(DiagnosticError, match="already exists"):
        run_cpu_diagnostic(
            source,
            fixture,
            baseline,
            output_model,
            tmp_path / "outputs.npz",
            tmp_path / "report.json",
            expected_model_sha=sha256_file(source),
            expected_fixture_sha=fixture_sha,
            expected_baseline_sha=baseline_sha,
            ort_module=_FakeOrt(),
        )
    fixture.write_text(fixture.read_text(encoding="utf-8") + " ", encoding="utf-8")
    with pytest.raises(DiagnosticError, match="SHA-256"):
        _select_first_failed_row(
            fixture,
            baseline,
            expected_fixture_sha=fixture_sha,
            expected_baseline_sha=baseline_sha,
        )
