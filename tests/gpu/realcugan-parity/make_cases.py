"""Tiny synthetic graphs that isolate what DirectML gets wrong.

The walk over the instrumented Real-CUGAN graph showed two separate things:

  * every `Conv` / `ConvTranspose` output comes back from DirectML as an
    OrtValue with no type info (28 of them), so those tensors cannot be read
    through a graph output at all;
  * the first *readable* divergence is `node_pad_1` — a `Pad` with
    `mode="constant"` whose pads are computed by the shape subgraph — while the
    reflect-mode `Pad` right before it, the `LeakyRelu` after it and the shape
    arithmetic itself all agree.

These models take the graph apart so the defect can be attributed to one node
instead of guessed at from the whole network. Each is single-input,
single-output, 3x64x72, and is compared CPU vs DirectML by the Rust probe.
"""

import argparse

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

N, C, H, W = 1, 3, 64, 72


def pattern(shape, scale=0.05):
    """Deterministic non-zero weights so a wrong kernel changes the numbers."""
    total = 1
    for dim in shape:
        total *= dim
    return (np.arange(total, dtype=np.float32).reshape(shape) % 7) * scale


def initializer(name, array):
    return numpy_helper.from_array(array, name)


def graph(nodes, inputs, outputs, initializers):
    return helper.make_graph(nodes, "probe", inputs, outputs, initializers)


def input_value():
    return helper.make_tensor_value_info("input", TensorProto.FLOAT, [N, C, "h", "w"])


def output_value(name):
    return helper.make_tensor_value_info(name, TensorProto.FLOAT, None)


def pad_constant_static():
    pads = initializer("pads", np.array([0, 0, 1, 2, 0, 0, 2, 1], dtype=np.int64))
    node = helper.make_node("Pad", ["input", "pads"], ["out"], mode="constant")
    return graph([node], [input_value()], [output_value("out")], [pads])


def pad_reflect_static():
    pads = initializer("pads", np.array([0, 0, 1, 2, 0, 0, 2, 1], dtype=np.int64))
    node = helper.make_node("Pad", ["input", "pads"], ["out"], mode="reflect")
    return graph([node], [input_value()], [output_value("out")], [pads])


def pad_edge_static():
    pads = initializer("pads", np.array([0, 0, 1, 2, 0, 0, 2, 1], dtype=np.int64))
    node = helper.make_node("Pad", ["input", "pads"], ["out"], mode="edge")
    return graph([node], [input_value()], [output_value("out")], [pads])


def pad_negative_static():
    # Negative pads crop, which is how Real-CUGAN trims the skip path.
    pads = initializer("pads", np.array([0, 0, -2, -2, 0, 0, -2, -2], dtype=np.int64))
    node = helper.make_node("Pad", ["input", "pads"], ["out"], mode="constant")
    return graph([node], [input_value()], [output_value("out")], [pads])


def pad_dynamic_pads():
    """The real shape: pads are computed from `Shape(input)` at run time.

    `Mul` by zero keeps the values coming from the graph without changing them,
    which is how the exported Real-CUGAN graph builds `val_14`, so the pads stay
    dynamic as long as the input dims do.
    """
    nodes = [
        helper.make_node("Shape", ["input"], ["shape"]),
        helper.make_node("Gather", ["shape", "idx_h"], ["h"], axis=0),
        helper.make_node("Mul", ["h", "zero1"], ["h0"]),
        helper.make_node("Add", ["h0", "one"], ["one_dyn"]),
        helper.make_node("Add", ["one_dyn", "one"], ["two_dyn"]),
        helper.make_node("Concat", ["zero2", "one_dyn", "two_dyn"], ["begin"], axis=0),
        helper.make_node("Concat", ["zero2", "two_dyn", "one_dyn"], ["end"], axis=0),
        helper.make_node("Concat", ["begin", "end"], ["pads"], axis=0),
        helper.make_node("Pad", ["input", "pads"], ["out"], mode="constant"),
    ]
    initializers = [
        initializer("idx_h", np.array([2], dtype=np.int64)),
        initializer("zero1", np.array([0], dtype=np.int64)),
        initializer("one", np.array([1], dtype=np.int64)),
        initializer("zero2", np.array([0, 0], dtype=np.int64)),
    ]
    return graph(nodes, [input_value()], [output_value("out")], initializers)


def conv_only():
    weights = initializer("weights", pattern((4, C, 3, 3)))
    node = helper.make_node("Conv", ["input", "weights"], ["out"], pads=[1, 1, 1, 1])
    return graph([node], [input_value()], [output_value("out")], [weights])


def conv_leaky():
    weights = initializer("weights", pattern((4, C, 3, 3)))
    conv = helper.make_node("Conv", ["input", "weights"], ["conv"], pads=[1, 1, 1, 1])
    leaky = helper.make_node("LeakyRelu", ["conv"], ["out"], alpha=0.1)
    return graph([conv, leaky], [input_value()], [output_value("out")], [weights])


def conv_transpose_only():
    weights = initializer("weights", pattern((C, 4, 3, 3)))
    node = helper.make_node(
        "ConvTranspose", ["input", "weights"], ["out"], strides=[2, 2], pads=[1, 1, 1, 1]
    )
    return graph([node], [input_value()], [output_value("out")], [weights])


MODELS = {
    "pad-constant-static": pad_constant_static,
    "pad-reflect-static": pad_reflect_static,
    "pad-edge-static": pad_edge_static,
    "pad-negative-static": pad_negative_static,
    "pad-dynamic-pads": pad_dynamic_pads,
    "conv-only": conv_only,
    "conv-leaky": conv_leaky,
    "convtranspose-only": conv_transpose_only,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    for name, build in MODELS.items():
        model = helper.make_model(
            build(), opset_imports=[helper.make_opsetid("", 18)], ir_version=10
        )
        model = onnx.shape_inference.infer_shapes(model)
        onnx.checker.check_model(model)
        path = f"{args.out_dir}\\case-{name}.onnx"
        onnx.save(model, path)
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
