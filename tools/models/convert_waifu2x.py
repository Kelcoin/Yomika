"""Convert Mihon's NCNN UpConv7 weights and verify against the NCNN runtime.

Requires numpy, onnx, onnxruntime and ncnn. No training or weight approximation.
Usage: python tools/models/convert_waifu2x.py SOURCE_PREFIX OUTPUT_DIRECTORY
SOURCE_PREFIX names scale2.0x_model without its .param/.bin suffix.
"""
from pathlib import Path
import argparse
import hashlib
import json
import struct

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def convert(source: Path, destination: Path):
    binary = Path(str(source) + '.bin')
    param = Path(str(source) + '.param')
    lines = param.read_text().splitlines()
    if lines[:2] != ['7767517', '8 8']:
        raise ValueError('Expected the eight-layer NCNN UpConv7 graph')
    nodes, initializers = [], []
    def constant(name, value):
        initializers.append(numpy_helper.from_array(np.asarray(value), name))
        return name
    pads = constant('border', np.array([0, 0, 7, 7, 0, 0, 7, 7], dtype=np.int64))
    nodes.append(helper.make_node('Pad', ['input', pads], ['padded'], mode='edge'))
    previous, inputs = 'padded', 3
    with binary.open('rb') as weights:
        for index, line in enumerate(lines[3:]):
            fields = line.split()
            operation = fields[0]
            attributes = dict(field.split('=', 1) for field in fields[6:])
            outputs, kernel, count = (int(attributes[key]) for key in ('0', '1', '6'))
            expected = 'Deconvolution' if index == 6 else 'Convolution'
            if operation != expected or attributes.get('5') != '1' or count != outputs * inputs * kernel * kernel:
                raise ValueError(f'Unsupported layer: {line}')
            if index < 6 and (kernel != 3 or attributes.get('9') != '2' or attributes.get('-23310') != '1,0.100000'):
                raise ValueError(f'Unexpected convolution: {line}')
            if index == 6 and (outputs, kernel, attributes.get('3'), attributes.get('4')) != (3, 4, '2', '3'):
                raise ValueError(f'Unexpected deconvolution: {line}')
            tag, = struct.unpack('<I', weights.read(4))
            if tag != 0x01306B47:
                raise ValueError(f'Expected NCNN float16 weights, got {tag:#x}')
            size = count * 2
            data = np.frombuffer(weights.read(size), dtype='<f2').astype(np.float32)
            weights.read((-size) % 4)
            bias = np.frombuffer(weights.read(outputs * 4), dtype='<f4').copy()
            data = data.reshape(outputs, inputs, kernel, kernel)
            name = f'layer{index}'
            if index == 6:
                data = data.transpose(1, 0, 2, 3).copy()
            weight_name = constant(name + '_weights', data)
            bias_name = constant(name + '_bias', bias)
            nodes.append(helper.make_node('ConvTranspose' if index == 6 else 'Conv',
                [previous, weight_name, bias_name], [name],
                strides=[2, 2] if index == 6 else [1, 1],
                pads=[3, 3, 3, 3] if index == 6 else [0, 0, 0, 0]))
            previous = name
            if index < 6:
                previous = name + '_relu'
                nodes.append(helper.make_node('LeakyRelu', [name], [previous], alpha=0.1))
            inputs = outputs
        if weights.read(1):
            raise ValueError('Unexpected trailing weights')
    nodes.append(helper.make_node('Identity', [previous], ['output']))
    graph = helper.make_graph(nodes, 'waifu2x-upconv7',
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
        [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'height2', 'width2'])], initializers)
    model = helper.make_model(graph, producer_name='Yomika waifu2x converter', opset_imports=[helper.make_opsetid('', 13)])
    model.ir_version = 10
    onnx.checker.check_model(model)
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / 'model.onnx'
    onnx.save(model, output)
    report = verify(source, output)
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = dict(id='waifu2x-upconv7', version='1', format='onnx', scale=2,
        maxPixels=64000000, sha256=digest(output), supportedBackends=['cpu'])
    (destination / 'yomika-model.json').write_text(json.dumps(manifest, indent=2) + '\n')
    provenance = dict(source='Mihon waifu2x-models-upconv7/scale2.0x_model',
        paramSha256=digest(param), weightsSha256=digest(binary), onnxSha256=digest(output),
        upstream='https://github.com/nihui/waifu2x-ncnn-vulkan/tree/master/models/models-upconv_7_anime_style_art_rgb',
        conversion='float16 weights expanded exactly to float32; upstream RGB channels and 7px replicated border',
        verification=report)
    (destination / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(provenance, indent=2))


def verify(source, output):
    import ncnn
    import onnxruntime as ort
    net = ncnn.Net()
    net.opt.use_vulkan_compute = False
    net.opt.use_fp16_storage = False
    net.opt.use_fp16_arithmetic = False
    net.opt.num_threads = 2
    assert net.load_param(str(source) + '.param') == 0
    assert net.load_model(str(source) + '.bin') == 0
    session = ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
    rng = np.random.default_rng(42)
    report = []
    for height, width in [(1, 1), (17, 23), (64, 64)]:
        pixels = rng.random((1, 3, height, width), dtype=np.float32)
        padded = np.pad(pixels[0], ((0, 0), (7, 7), (7, 7)), mode='edge').copy()
        with net.create_extractor() as extractor:
            assert extractor.input('Input1', ncnn.Mat(padded)) == 0
            code, result = extractor.extract('Eltwise4')
            assert code == 0
            reference = np.array(result).copy()[None]
        actual = session.run(None, {'input': pixels})[0]
        assert actual.shape == (1, 3, height * 2, width * 2)
        np.testing.assert_allclose(actual, reference, rtol=0.0005, atol=0.00005)
        report.append(dict(width=width, height=height, maxAbsoluteError=float(np.max(np.abs(actual-reference)))))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    convert(args.source, args.destination)
