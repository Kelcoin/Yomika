# Bundled waifu2x

Yomika includes the lightweight UpConv7 2x anime/art model, converted from the
NCNN assets in Mihon's `waifu2x-models-upconv7/scale2.0x_model`.

The original weights exactly match
https://github.com/nihui/waifu2x-ncnn-vulkan/tree/master/models/models-upconv_7_anime_style_art_rgb
(SHA256 `27d880903ff81390a3b4a900b67af3381c465279e34297546c9a58781855f7ef`).
MIT notices are shipped with the model. The graph, source hashes and numerical
verification are in `src-tauri/resources/models/waifu2x-upconv7`.

## Conversion

Install `numpy`, `onnx`, `onnxruntime` and `ncnn`, then run:

```powershell
python tools/models/convert_waifu2x.py docs/mihon_img_upscale-master/app/src/main/assets/waifu2x-models-upconv7/scale2.0x_model src-tauri/resources/models/waifu2x-upconv7
```

The converter expands FP16 weights exactly to FP32, transposes deconvolution
weights to ONNX layout, and pads by seven replicated pixels on each edge so
arbitrary input dimensions produce exactly twice the width and height.
It uses the original model's RGB convention; Mihon's extra R/B swap is not part
of the model. NCNN and ONNX outputs are compared on three input dimensions.
No model training, approximate conversion or synthetic substitute is used.

The model is embedded in the executable and released once into
`data/models/waifu2x-upconv7/1` on Windows, or the app data directory on mobile.
Existing files are not overwritten or rehashed at startup. The native test
checks manifest hash, inference, alpha preservation and tiled/whole-page parity.

CPU sample on this development machine: warmed 64x64 tile, two threads, median
of five runs: UpConv7 2x 8.75ms; Real-ESRGAN general x4v3 4x 21.09ms.
This compares actual option costs, not equal output scale or equivalent quality.
