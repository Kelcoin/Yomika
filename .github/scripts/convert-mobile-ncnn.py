#!/usr/bin/env python3
"""Recreate a pinned Vulkan variant from its original ONNX (onnxsim 0.8.1).

Install onnx/onnxsim, then pass the official ncnn 20240410 onnx2ncnn executable.
The legacy syntax below is converter input only; it is never executed by ORT.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import onnx
from onnx import helper, numpy_helper
from onnxsim import simplify

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT / 'src-tauri/crates/compute-core/resources/ncnn'


def convert(model_id, source, converter, output):
    records = json.loads((DESTINATION / 'models.json').read_text(encoding='utf-8'))
    record = next(m for m in records if m['id'] == model_id)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != record['onnxSha256']:
        raise ValueError('Source ONNX fingerprint does not match the verified model')
    model, valid = simplify(onnx.load(source), overwrite_input_shapes={'input': [1, 3, 128, 128]})
    if not valid:
        raise ValueError('Fixed-shape ONNX simplification did not preserve outputs')
    values = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
    unnamed = 0
    for node in model.graph.node:
        if not node.name:
            node.name = f'{node.op_type}_{unnamed}'
            unnamed += 1
        if node.op_type in ('Conv', 'ConvTranspose') and not any(a.name == 'kernel_shape' for a in node.attribute):
            node.attribute.append(helper.make_attribute('kernel_shape', list(values[node.input[1]].shape[2:])))
        if node.op_type == 'ReduceMean' and len(node.input) > 1:
            node.attribute.append(helper.make_attribute('axes', values[node.input[1]].tolist()))
            del node.input[1:]
        if node.op_type == 'Slice' and len(node.input) > 1:
            for key, value in zip(('starts', 'ends', 'axes', 'steps'), node.input[1:]):
                node.attribute.append(helper.make_attribute(key, values[value].tolist()))
            del node.input[1:]
    # CUGAN's final integer rounding is performed by Rust's shared RGBA writer.
    if model_id.startswith('realcugan'):
        tail = list(model.graph.node)[-3:]
        if [n.op_type for n in tail] != ['Mul', 'Round', 'Div']:
            raise ValueError('Unexpected CUGAN quantization tail')
        output_name = tail[-1].output[0]
        source_name = tail[0].input[0]
        del model.graph.node[-3:]
        for node in model.graph.node:
            for i, name in enumerate(node.output):
                if name == source_name:
                    node.output[i] = output_name
    used = {i for n in model.graph.node for i in n.input}
    weights = [t for t in model.graph.initializer if t.name in used]
    del model.graph.initializer[:]
    model.graph.initializer.extend(weights)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        converted = Path(temporary) / 'legacy.onnx'
        onnx.save(model, converted)
        subprocess.run([str(converter), str(converted), str(output / f'{model_id}.param'), str(output / f'{model_id}.bin')], check=True)
    if model_id.startswith('realcugan'):
        # The runtime reproduces the dynamic ONNX border and final crop. The
        # converter uses an even 128px example only to lower internal operators.
        param = output / f'{model_id}.param'
        lines = param.read_text(encoding='utf-8').splitlines()
        if (lines[1] != '86 94'
            or lines[3].split()[:6] != ['Padding', 'node_pad', '1', '1', 'input', 'pad']
            or lines[4].split()[4:6] != ['pad', 'conv2d']
            or lines[-2].split()[:6] != ['Crop', 'Slice_0', '1', '1', 'add_375', '_v_204']
            or lines[-1].split()[4:6] != ['_v_204', 'output']):
            raise ValueError('Unexpected converted CUGAN graph boundaries')
        lines[1] = '84 92'
        lines[4] = lines[4].replace(' pad conv2d', ' input conv2d', 1)
        lines[-1] = lines[-1].replace(' _v_204 output', ' add_375 output', 1)
        del lines[-2]
        del lines[3]
        param.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    for key, extension in [('paramSha256', 'param'), ('weightsSha256', 'bin')]:
        actual = hashlib.sha256((output / f'{model_id}.{extension}').read_bytes()).hexdigest()
        if actual != record[key]:
            raise ValueError(f'Converted {extension} fingerprint mismatch: {actual}')
    print(f'{model_id}: source and converted assets match pinned fingerprints')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('id')
    parser.add_argument('source', type=Path)
    parser.add_argument('--converter', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=DESTINATION)
    args = parser.parse_args()
    convert(args.id, args.source, args.converter, args.output)
