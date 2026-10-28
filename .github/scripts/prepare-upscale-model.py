#!/usr/bin/env python3
"""Export/import an upscaler bundle; optional LiteRT export is parity-checked.

Python 3.11: onnx, onnxsim, onnxruntime, numpy, tensorflow==2.19.0.
--nomosuni additionally needs torch and spandrel. No proprietary SDK is required.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
import urllib.request
import zipfile

NOMOS_REVISION = 'ae0e059d6c87be95ddedc3855278410b454a2752'
NOMOS_SHA256 = 'a3d35e01b8b71b4b3041ad1686f8ebd7bc4e1f3a10378319c2ac61c78b67012a'
NOMOS_LICENSE = '''2xNomosUni SPAN multijpg ldl, Copyright Philip Hofmann.
Licensed under Creative Commons Attribution 4.0 International.
https://creativecommons.org/licenses/by/4.0/
https://openmodeldb.info/models/2x-NomosUni-span-multijpg-ldl
https://huggingface.co/Phips/2xNomosUni_span_multijpg_ldl
Converted to RGB NCHW ONNX / optional RGB NHWC LiteRT for Yomika.
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def nomosuni(directory):
    import torch
    from spandrel import ModelLoader
    weights = directory / 'nomosuni.safetensors'
    urllib.request.urlretrieve(f'https://huggingface.co/Phips/2xNomosUni_span_multijpg_ldl/resolve/{NOMOS_REVISION}/2xNomosUni_span_multijpg_ldl.safetensors', weights)
    if digest(weights) != NOMOS_SHA256:
        raise RuntimeError('NomosUni official weights fingerprint mismatch')
    model = ModelLoader().load_from_file(weights)
    if (model.scale, model.input_channels, model.output_channels) != (2, 3, 3):
        raise ValueError('Expected 2x RGB SPAN')

    class Span(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model.model.eval()

        def forward(self, image):
            return self.model(image).clamp(0, 1)

    target = directory / 'model.onnx'
    with torch.inference_mode():
        torch.onnx.export(Span().eval(), torch.zeros(1, 3, 128, 128), target,
                          input_names=['input'], output_names=['output'], opset_version=17,
                          dynamic_axes={'input': {2: 'height', 3: 'width'}, 'output': {2: 'out_height', 3: 'out_width'}},
                          dynamo=False, external_data=False)
    return target


def export_litert(source, target, scale):
    import numpy as np
    import onnxruntime as ort
    import tensorflow as tf
    from onnx_litert_bridge import convert_file
    convert_file(source, target)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(source), options, providers=['CPUExecutionProvider'])
    interpreter = tf.lite.Interpreter(model_path=str(target), num_threads=2)
    interpreter.allocate_tensors()
    info, out = interpreter.get_input_details(), interpreter.get_output_details()
    if len(info) != 1 or len(out) != 1 or info[0]['shape'].tolist() != [1, 256, 256, 3] or out[0]['shape'].tolist() != [1, 256*scale, 256*scale, 3]:
        raise ValueError('Unsupported LiteRT tensor contract')
    worst_mae, worst_psnr = 0, math.inf
    for seed in (4, 19):
        x = np.random.default_rng(seed).random((1, 3, 256, 256), dtype=np.float32)
        expected = session.run(None, {session.get_inputs()[0].name: x})[0].transpose(0, 2, 3, 1)
        interpreter.set_tensor(info[0]['index'], x.transpose(0, 2, 3, 1).copy())
        interpreter.invoke()
        actual = interpreter.get_tensor(out[0]['index'])
        difference = actual.astype(np.float64) - expected
        mae = float(np.abs(difference).mean())
        psnr = -10*math.log10(max(float(np.square(difference).mean()), 1e-16))
        if not np.isfinite(actual).all() or mae > 0.02 or psnr < 30:
            raise ValueError(f'Converted model failed parity: MAE={mae}, PSNR={psnr}')
        worst_mae, worst_psnr = max(worst_mae, mae), min(worst_psnr, psnr)
    return dict(onnxSha256=digest(source), tfliteSha256=digest(target), scale=scale,
                layout='NHWC-RGB-FP32-256', cpuMae=worst_mae, cpuPsnrDb=worst_psnr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--source', type=Path)
    group.add_argument('--nomosuni', action='store_true')
    parser.add_argument('--id', default='span-nomosuni-photo')
    parser.add_argument('--scale', type=int, default=2)
    parser.add_argument('--litert', action='store_true')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not args.id or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in args.id) or args.scale not in (2, 3, 4):
        raise ValueError('Invalid model id or scale')
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        source = nomosuni(directory) if args.nomosuni else args.source.resolve()
        import onnx
        onnx.checker.check_model(onnx.load(source))
        sha = digest(source)
        manifest = dict(id=args.id, version=sha[:12], format='onnx', scale=args.scale,
                        maxPixels=64000000, sha256=sha, supportedBackends=['cpu', 'directml', 'coreml', 'nnapi'])
        companion = directory / 'model.tflite'
        report = export_litert(source, companion, args.scale) if args.litert else None
        if report:
            manifest["version"] += "-" + report["tfliteSha256"][:8]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix('.partial')
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as bundle:
            bundle.write(source, 'model.onnx')
            bundle.writestr('manifest.json', json.dumps(manifest, indent=2))
            if args.nomosuni or args.id == 'span-nomosuni-photo':
                bundle.writestr('LICENSE.txt', NOMOS_LICENSE)
            if report:
                bundle.write(companion, 'model.tflite')
                bundle.writestr('yomika-accelerator.json', json.dumps(report, indent=2))
        temporary.replace(args.output)
        print(f'Import into Yomika: {args.output.resolve()}')
        if report:
            print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
