import onnx
import pytest
from onnx import TensorProto, helper

from scripts.sanitize_model import sanitize_model


def fixture_model():
    node = helper.make_node("Identity", ["x"], ["y"])
    graph = helper.make_graph(
        [node],
        "test",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1])],
    )
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])


def test_strip_private_debug_metadata_without_mutating_source_or_semantics():
    model = fixture_model()
    model.graph.node[0].doc_string = "trace at C:/Users/example/project/source.py"
    model.graph.node[0].metadata_props.add(key="stack_trace", value="/home/example/source.py")
    model.metadata_props.add(key="license", value="MIT")
    sanitized, removed = sanitize_model(model)
    assert removed == 2
    assert sanitized.graph.node[0].doc_string == ""
    assert len(sanitized.graph.node[0].metadata_props) == 0
    assert sanitized.metadata_props[0].value == "MIT"
    assert model.graph.node[0].doc_string
    assert sanitized.graph.node[0].input == model.graph.node[0].input
    assert sanitized.graph.node[0].output == model.graph.node[0].output
    assert sanitized.graph.node[0].op_type == "Identity"
    onnx.checker.check_model(sanitized)


def test_semantic_name_with_private_path_fails_instead_of_changing_bindings():
    model = fixture_model()
    model.graph.name = "C:/Users/example/model"
    with pytest.raises(ValueError, match="semantic"):
        sanitize_model(model)


def test_safe_model_is_byte_identical():
    model = fixture_model()
    sanitized, removed = sanitize_model(model)
    assert removed == 0
    assert sanitized.SerializeToString() == model.SerializeToString()
