r"""Which installed graphs pool over space — and so cannot be tiled exactly?

Real-CUGAN's graphs carry four `ReduceMean` nodes whose axes are the *spatial*
ones: the channel attention pools each tile's own feature map. A tiled run is
therefore not a slower spelling of the whole-page run — a tile's answer depends on
how large the tile is and what is inside it, and no finite margin can undo that
(measured: docs/89). Fortune favours the conv-only graphs: waifu2x has no pooling
at all, so its tiles agree with the whole page except for a few edge pixels.

This is the structural half of the tiling question; docs/89 has the numeric half
(a 1024x768 page, whole page against tile 128 / 256 / 512 / 768). Read this scan
before changing a tile size or a cache revision, to know which of the installed
graphs the change can even touch.

The scan is deliberately narrow — `Global*Pool` and `Reduce*` over the last two
axes of an NCHW value. A spatial `Softmax` or an attention matmul would be
non-local too, and this file would not see it; it prints the pool-node count of
every graph so "clean" is distinguishable from "nothing was looked for".

  scripts\compute\realcugan-parity.ps1 -ScanTiling
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
    # 改写过的图（负垫边换成 Slice）也在这里；改写不动池化，所以它们应当同判。
    os.path.join(ROOT, "debug_outputs", "task1-gpu"),
]

GLOBAL_POOL = {"GlobalAveragePool", "GlobalMaxPool", "GlobalLpPool"}
REDUCE_POOL = {
    "ReduceMean",
    "ReduceSum",
    "ReduceSumSquare",
    "ReduceMax",
    "ReduceMin",
    "ReduceProd",
    "ReduceL1",
    "ReduceL2",
    "ReduceLogSum",
    "ReduceLogSumExp",
}


def reduce_axes(node, initializers):
    """`Reduce*` 的轴：opset 18 起是第二个输入（常量），之前是属性。

    两样都读不出来时返回 None——「没写就是全部轴」在 opset 18 之前是对的，
    但我宁可在报告里写「说不清」也不要猜一个轴出来。
    """
    if len(node.input) >= 2:
        pads = initializers.get(node.input[1])
        if pads is None:
            return None, False
        return [int(value) for value in np.atleast_1d(pads).tolist()], True
    for attribute in node.attribute:
        if attribute.name == "axes":
            return [int(value) for value in attribute.ints], True
    return None, False


def inferred_ranks(model):
    """每个张量的秩，能推出来的部分（推不出来就按图输入的秩当参照）。"""
    try:
        inferred = onnx.shape_inference.infer_shapes(model)
    except Exception:  # noqa: BLE001 - 推不出来不影响判断，退到图输入
        return {}
    ranks = {}
    for value in (
        list(inferred.graph.value_info)
        + list(inferred.graph.output)
        + list(inferred.graph.input)
    ):
        dims = value.type.tensor_type.shape.dim
        if len(dims) > 0:
            ranks[value.name] = len(dims)
    return ranks


def graph_rank(model):
    for value in model.graph.input:
        dims = value.type.tensor_type.shape.dim
        if len(dims) > 1:
            return len(dims)
    return 0


def scan(path):
    model = onnx.load(path)
    initializers = {tensor.name: numpy_helper.to_array(tensor) for tensor in model.graph.initializer}
    ranks = inferred_ranks(model)
    fallback_rank = graph_rank(model)
    found = []
    pooled = 0
    for index, node in enumerate(model.graph.node):
        pools = node.op_type in GLOBAL_POOL
        if node.op_type in REDUCE_POOL:
            axes, known = reduce_axes(node, initializers)
            if not known:
                found.append((index, node.op_type, "axes unresolved", None))
                continue
            rank = ranks.get(node.input[0], fallback_rank)
            resolved = [axis + rank if axis < 0 <= rank else axis for axis in axes]
            # NCHW 的最后两维是空间；秩推不出来时按 4 维算（这些图都是）。
            edge = (rank or 4) - 2
            spatial = [axis for axis in resolved if axis >= edge]
            pooled += 1
            found.append(
                (index, node.op_type, f"axes={resolved}", bool(spatial))
            )
            continue
        if pools:
            pooled += 1
            found.append((index, node.op_type, "all axes spatial", True))
    return found, pooled


def main():
    affected = []
    scanned = 0
    for root in ROOTS:
        for path in sorted(glob.glob(os.path.join(root, "**", "*.onnx"), recursive=True)):
            # 夹具目录里还住着一个 python venv（别人做对照实验时建的），它自己带的
            # 示例图不是产品图，扫进来只会让「39 张里 19 张受影响」这种数字失真。
            if "site-packages" in path or f"{os.sep}Lib{os.sep}" in path:
                continue
            label = os.path.relpath(path, ROOT)
            scanned += 1
            try:
                found, pooled = scan(path)
            except Exception as error:  # noqa: BLE001 - report and keep scanning
                print(f"{label:62} unreadable: {error}")
                continue
            spatial = [row for row in found if row[3] is True]
            unknown = [row for row in found if row[3] is None]
            if spatial:
                verdict = "SPATIAL POOLING: a tile cannot equal the whole page"
                affected.append(label)
            elif unknown:
                verdict = "pool axes unresolved — treat as tiling-sensitive"
                affected.append(label)
            else:
                verdict = "clean (nothing pools over space)"
            print(f"{label:62} pool nodes {pooled:>3}  {verdict}")
            # 每一处都印，并标明它算不算空间：只印空间的那些会让人以为「池化节点数
            # 是 5，却只列了 2 处通道的」是漏报，反过来只印通道的更是把结论藏了。
            for index, op, axes, spatial_hit in found:
                mark = "  <- spatial" if spatial_hit is True else ("  (channel only)" if spatial_hit is False else "  (unresolved)")
                print(f"    node {index:>4} {op:<18} {axes}{mark}")
    print(f"\n{len(affected)} of {scanned} graphs pool over space; see docs/89 for what that costs.")
    for label in affected:
        print(f"  {label}")


if __name__ == "__main__":
    main()
