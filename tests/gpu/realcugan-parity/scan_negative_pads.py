r"""Which installed graphs would DirectML get wrong?

DirectML mishandles `Pad` with negative pads (a crop) — the isolated case is
wrong by mean 0.5 while every other Pad mode and Conv/ConvTranspose agree. The
ONNX `Pad` schema documentation never defines negative pads, so a graph that
uses them is relying on the CPU kernel's extension, and the portable spelling is
`Slice`. This scans every graph the product can install, so the matrix knows
which of them are affected before anyone switches a backend.

  scripts\compute\realcugan-parity.ps1 -Scan
"""

import glob
import os

import numpy as np
import onnx
from onnx import numpy_helper

ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
ROOTS = [
    os.path.join(ROOT, "docs", "models"),
    os.path.join(ROOT, "src-tauri", "resources", "models"),
    os.path.join(ROOT, "src-tauri", "target", "release", "data", "models"),
    os.path.join(ROOT, "src-tauri", "target", "release", "data", "models-fp16"),
]


def scan(path):
    model = onnx.load(path)
    initializers = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
    found = []
    for index, node in enumerate(model.graph.node):
        if node.op_type != "Pad" or len(node.input) < 2:
            continue
        pads = initializers.get(node.input[1])
        if pads is None:
            continue
        values = pads.tolist()
        if any(value < 0 for value in values):
            mode = "constant"
            for attribute in node.attribute:
                if attribute.name == "mode":
                    mode = attribute.s.decode()
            found.append((index, node.name or "?", values, mode))
    ops = {}
    for node in model.graph.node:
        ops[node.op_type] = ops.get(node.op_type, 0) + 1
    return found, ops


def main():
    for root in ROOTS:
        for path in sorted(glob.glob(os.path.join(root, "**", "*.onnx"), recursive=True)):
            label = os.path.relpath(path, ROOT)
            size = os.path.getsize(path)
            try:
                found, ops = scan(path)
            except Exception as error:  # noqa: BLE001 - report and keep scanning
                print(f"{label:70} {size:>10,}  unreadable: {error}")
                continue
            verdict = "NEGATIVE PADS" if found else "clean"
            print(f"{label:70} {size:>10,}  {verdict}")
            for index, name, values, mode in found:
                print(f"    node {index} {name} mode={mode} pads={values}")
            top = sorted(ops.items(), key=lambda item: -item[1])[:6]
            print(f"    ops: {top}")


if __name__ == "__main__":
    main()
