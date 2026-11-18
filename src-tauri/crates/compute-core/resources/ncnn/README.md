# Android Vulkan 模型变体

`models.json` 按源 ONNX 的 SHA-256 和倍率匹配 Vulkan 变体。当前包含内置 `waifu2x-upconv7` 和模型目录的 `realcugan-2x-conservative`、`realcugan-2x-denoise3x`。Real-CUGAN 的原版 ONNX 仍按需安装。对应 Vulkan 权重约为每档 4.9 MiB，随 Android 安装包分发。未匹配到指纹的模型继续使用现有 ONNX 后端。

Waifu2x 走固定 128×128 的重叠分块。Real-CUGAN 的全局均值参与每次推理，走现有预算内的整图路径。转换器用 128×128 样例降低内部算子，原生运行时根据实际图像尺寸执行 ONNX 的动态镜像填充和输出裁剪。Rust 共用的 RGBA 写回负责 8 位量化和 alpha 保留。

使用 `onnxsim` 0.8.1 和 ncnn 20240410 的 `onnx2ncnn` 重建资源。例如：

```powershell
python .github/scripts/convert-mobile-ncnn.py realcugan-2x-conservative docs/models/realcugan-2x-conservative-dml1.onnx --converter <onnx2ncnn.exe>
```

脚本验证源模型及生成产物的指纹。两档 Real-CUGAN 的许可证和来源记录见 `realcugan-LICENSE.txt` 及 `NOTICES.txt`。
