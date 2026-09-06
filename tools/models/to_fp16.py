"""Converts the de-censoring detector to fp16, halving 243 MB to 122 MB.

    python tools/models/to_fp16.py <source-bundle-dir> [<output-bundle-dir>]

The source is an Aletheia-Lens `_internal/models` directory. Only `mrcnn/weights.onnx`
is converted; the other three files are copied. The two DeepCreamPy inpainters are
left in float32 deliberately — upstream already pins them to CPU because they
produce non-finite values under CUDA 12 / cuDNN 9, which is not a graph to go
reducing the precision of on a hunch — and ESRGAN is 2.5 MB of graph beside its
external weights, so there is nothing to gain there either.

Two things about `onnxconverter-common` this works around, both of which produce a
model that loads nowhere:

1. With shape inference disabled it does not insert the casts at the boundaries of
   the ops it keeps in float32, and the graph comes out with a `Mul` whose two
   inputs disagree. Shape inference is therefore left on, and any node that still
   ends up mixed is added to the block list and the conversion retried — 18 nodes
   need it here, all of them around the ROI / NMS / TopK / GatherND path.
2. It appends its boundary `Cast` nodes to the end of the node list, which leaves
   the graph unsorted; ONNX requires every input to be produced before it is read.
   Sorting has to account for a `Loop` body reading a value from the parent graph
   without that value appearing among the `Loop` node's own inputs, or the producer
   is happily placed after the consumer.

Requires `onnx` and `onnxconverter-common`. The result is verified by
`the_fp16_detector_agrees_with_the_float32_one` in `src-tauri/src/inference/detect.rs`.
"""

from __future__ import annotations

import os
import re
import shutil
import sys

import onnx
from onnxconverter_common import float16

COPIED = [
    ("deepcreampy", "bar.onnx"),
    ("deepcreampy", "mosaic.onnx"),
    ("esrgan", "4x-Fatal-Pixels.onnx"),
    # ESRGAN keeps its weights beside the graph; a session cannot open without it.
    ("esrgan", "4x-Fatal-Pixels.onnx.data"),
]
NODE_NAME = re.compile(r"node name: ([^)]+)\)")
MAX_ATTEMPTS = 80


def subgraphs_of(node):
    for attribute in node.attribute:
        if attribute.HasField("g"):
            yield attribute.g
        for sub in attribute.graphs:
            yield sub


def outer_references(graph) -> set[str]:
    """Names a subgraph reads from the enclosing scope."""
    produced = {name for node in graph.node for name in node.output}
    produced.update(i.name for i in graph.input)
    produced.update(t.name for t in graph.initializer)
    referenced: set[str] = set()
    for node in graph.node:
        referenced.update(name for name in node.input if name)
        for sub in subgraphs_of(node):
            referenced.update(outer_references(sub))
    return referenced - produced


def dependencies(node) -> set[str]:
    deps = {name for name in node.input if name}
    for sub in subgraphs_of(node):
        deps.update(outer_references(sub))
    return deps


def sort_graph(graph, outer_available: set[str]) -> None:
    available = set(outer_available)
    available.update(i.name for i in graph.input)
    available.update(t.name for t in graph.initializer)
    available.update(v.name for v in graph.sparse_initializer)

    pending = list(graph.node)
    ordered = []
    progressed = True
    while pending and progressed:
        progressed = False
        still = []
        for node in pending:
            if dependencies(node) <= available:
                ordered.append(node)
                available.update(node.output)
                progressed = True
            else:
                still.append(node)
        pending = still
    if pending:
        missing = sorted(dependencies(pending[0]) - available)[:4]
        raise RuntimeError(f"{len(pending)} nodes unordered; {pending[0].name} wants {missing}")

    del graph.node[:]
    graph.node.extend(ordered)
    for node in graph.node:
        for sub in subgraphs_of(node):
            sort_graph(sub, available)


def convert(source: str, destination: str) -> None:
    detector_in = os.path.join(source, "mrcnn", "weights.onnx")
    detector_out = os.path.join(destination, "mrcnn", "weights.onnx")
    os.makedirs(os.path.dirname(detector_out), exist_ok=True)

    original = onnx.load(detector_in)
    blocked: list[str] = []
    for attempt in range(MAX_ATTEMPTS):
        model = onnx.ModelProto()
        model.CopyFrom(original)
        # `keep_io_types` keeps the three inputs and every output float32, so the
        # result is a drop-in replacement for a caller that feeds f32 NHWC.
        converted = float16.convert_float_to_float16(
            model, keep_io_types=True, node_block_list=list(blocked) or None,
        )
        sort_graph(converted.graph, set())
        try:
            onnx.checker.check_model(converted, full_check=True)
        except Exception as error:  # noqa: BLE001 - the message is the signal
            found = NODE_NAME.search(str(error))
            if not found or found.group(1) in blocked:
                raise SystemExit(f"conversion stuck after {attempt} attempts: {error}") from error
            blocked.append(found.group(1))
            continue
        onnx.save(converted, detector_out)
        print(f"converted after {attempt} attempts, {len(blocked)} nodes kept in float32")
        for name in blocked:
            print(f"  keep f32: {name}")
        break
    else:
        raise SystemExit(f"gave up after {MAX_ATTEMPTS} attempts")

    for parts in COPIED:
        target = os.path.join(destination, *parts)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(source, *parts), target)

    before = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(source) for f in fs)
    after = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(destination) for f in fs)
    print(f"bundle {before / 1048576:.1f} MB -> {after / 1048576:.1f} MB at {destination}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    convert(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else sys.argv[1] + "-fp16")
