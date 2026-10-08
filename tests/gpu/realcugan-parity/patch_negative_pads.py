"""Rewrite negative-pad `Pad` nodes as `Slice`, which is the semantics they have.

DirectML answers `Pad` with negative pads (a crop) with the wrong values — the
synthetic cases isolate it (`case-pad-negative-static`: mean 0.5 / max 0.97,
while constant, reflect, edge and dynamic pads are all exact). The hosted
Real-CUGAN graph crops in four places to bring the skip path back to size:

    node_pad_1  val_14 = [0, 0, -4, -4, 0, 0, -4, -4]
    node_pad_2  val_18 = [0, 0, -16, -16, 0, 0, -16, -16]
    node_pad_3  val_14 = [0, 0, -4, -4, 0, 0, -4, -4]
    node_pad_4  val_26 = [0, 0, -20, -20, 0, 0, -20, -20]

`Slice` expresses the same crop and is a different kernel in both execution
providers, so the model still runs on CPU and DirectML identically. Positive
entries on an axis would need a real `Pad` and are carried over as one.
"""

import argparse

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

INT_MAX = np.iinfo(np.int64).max


def pad_parts(pads):
    """Split Pad's [b0..bn, e0..en] into crop starts/ends and leftover padding."""
    half = len(pads) // 2
    begin, end = pads[:half], pads[half:]
    starts, ends, leftover_begin, leftover_end = [], [], [], []
    for index, (b, e) in enumerate(zip(begin, end)):
        starts.append(int(-b) if b < 0 else 0)
        ends.append(int(e) if e < 0 else INT_MAX)
        leftover_begin.append(int(b) if b > 0 else 0)
        leftover_end.append(int(e) if e > 0 else 0)
    return starts, ends, leftover_begin, leftover_end


def rewrite(model):
    initializers = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
    nodes, rewritten = [], []
    for node in model.graph.node:
        if node.op_type != "Pad" or len(node.input) < 2:
            nodes.append(node)
            continue
        pads = initializers.get(node.input[1])
        if pads is None or not np.any(pads < 0):
            nodes.append(node)
            continue

        name = node.name or f"{node.output[0]}_pad"
        starts, ends, leftover_begin, leftover_end = pad_parts(pads.tolist())
        axes = list(range(len(starts)))
        source = node.input[0]
        if len(node.input) > 2:
            nodes.append(node)  # a computed pads value is not statically known
            continue

        values = [
            numpy_helper.from_array(np.array(starts, dtype=np.int64), f"{name}_starts"),
            numpy_helper.from_array(np.array(ends, dtype=np.int64), f"{name}_ends"),
            numpy_helper.from_array(np.array(axes, dtype=np.int64), f"{name}_axes"),
        ]
        model.graph.initializer.extend(values)
        if not any(leftover_begin) and not any(leftover_end):
            nodes.append(
                helper.make_node(
                    "Slice",
                    [source, f"{name}_starts", f"{name}_ends", f"{name}_axes"],
                    [node.output[0]],
                    name=name,
                )
            )
        else:
            # A mixed node: crop first, then pad what is left.
            mid = f"{name}_cropped"
            nodes.append(
                helper.make_node(
                    "Slice",
                    [source, f"{name}_starts", f"{name}_ends", f"{name}_axes"],
                    [mid],
                    name=f"{name}_crop",
                )
            )
            full = leftover_begin + leftover_end
            model.graph.initializer.append(
                numpy_helper.from_array(np.array(full, dtype=np.int64), f"{name}_pads")
            )
            attributes = {"mode": "constant"}
            for attribute in node.attribute:
                if attribute.name in {"mode", "value"}:
                    attributes[attribute.name] = helper.get_attribute_value(attribute)
            nodes.append(
                helper.make_node(
                    "Pad",
                    [mid, f"{name}_pads"],
                    [node.output[0]],
                    name=f"{name}_pad",
                    **attributes,
                )
            )
        rewritten.append(name)

    model.graph.ClearField("node")
    model.graph.node.extend(nodes)
    return rewritten


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    model = onnx.load(args.source)
    rewritten = rewrite(model)
    model = onnx.shape_inference.infer_shapes(model)
    onnx.checker.check_model(model)
    onnx.save(model, args.out)
    print(f"rewrote {len(rewritten)} Pad node(s): {rewritten}")
    print(f"wrote {args.out}")
    pads = [node.name for node in model.graph.node if node.op_type == "Pad"]
    print(f"remaining Pad nodes: {pads}")


if __name__ == "__main__":
    main()
