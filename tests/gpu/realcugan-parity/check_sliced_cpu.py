r"""The Slice rewrite must be CPU-equivalent, or it is not a fix, it is a new model.

Compares the original graph and the negative-pad-rewritten graph on the CPU
execution provider with the product's 72x64 probe input. Byte-identical CPU
outputs mean the rewrite only changes how the crop is expressed, not what the
crop means — which is what makes it safe to ship.

  scripts\compute\realcugan-parity.ps1

Exits non-zero when the two graphs disagree, so the wrapper can gate a release
on it instead of on reading the numbers.
"""

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort

ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
FIXTURES = os.path.join(ROOT, "debug_outputs", "task1-gpu")
WIDTH, HEIGHT = 72, 64


def probe_input():
    values = np.zeros((1, 3, HEIGHT, WIDTH), dtype=np.float32)
    values[0, 0] = np.linspace(0, 1, WIDTH, dtype=np.float32)[None, :]
    values[0, 1] = np.linspace(0, 1, HEIGHT, dtype=np.float32)[:, None]
    values[0, 2] = 0.5
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--original",
        default=os.path.join(ROOT, "docs", "models", "realcugan-2x-conservative.onnx"),
    )
    parser.add_argument(
        "--rewritten",
        default=os.path.join(FIXTURES, "realcugan-2x-conservative-sliced.onnx"),
    )
    args = parser.parse_args()
    for path in (args.original, args.rewritten):
        if not os.path.exists(path):
            print(f"missing graph: {path}")
            return 2
    values = probe_input()
    outputs = {}
    for label, path in (("original", args.original), ("rewritten", args.rewritten)):
        session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        outputs[label] = session.run(None, {"input": values})[0]
    a, b = outputs["original"], outputs["rewritten"]
    difference = np.abs(a - b)
    print(f"shapes {a.shape} vs {b.shape}")
    print(
        f"CPU original vs rewritten: mean={difference.mean():.9f} "
        f"max={difference.max():.9f} identical={np.array_equal(a, b)}"
    )
    if a.shape != b.shape or difference.max() > 0.0:
        print("FAIL: the rewrite changes what the CPU computes")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
