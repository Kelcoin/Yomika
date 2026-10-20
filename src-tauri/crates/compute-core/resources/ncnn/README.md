# Android Vulkan 模型变体

这三份资源由现有 ONNX 原文件转换，按 `models.json` 中的 SHA-256 选择，不能按显示名称猜测模型。只支持对应指纹的 x2 模型；自定义或更新后的 ONNX 继续使用 ORT。权重保持 float32，输入为 RGB NCHW [0,1]，固定 128×128。Rust 的共用分块管线负责边缘复制、重叠裁剪、alpha、取消、进度和预算。

转换使用 onnxsim 0.8.1 固定输入形状并验证图，再交给官方 ncnn 20240410 onnx2ncnn。旧转换器需要显式卷积 kernel_shape；ReduceMean/Slice 的常量输入先转成旧属性，避免被当成额外动态张量。Real-CUGAN 的末尾 Mul/Round/Div 由共用 RGBA 写回的 8 位取整完成，浮点输出比对允许半个灰阶，最终字节允许 1 的差异。

重新转换（需要 onnx、onnxsim 和官方转换器）：

```powershell
python .github/scripts/convert-mobile-ncnn.py waifu2x-upconv7 src-tauri/resources/models/waifu2x-upconv7/model.onnx --converter <onnx2ncnn.exe>
python .github/scripts/convert-mobile-ncnn.py realcugan-2x-denoise3x <realcugan-2x-denoise3x-dml1.onnx> --converter <onnx2ncnn.exe>
python .github/scripts/convert-mobile-ncnn.py realcugan-2x-conservative <realcugan-2x-conservative-dml1.onnx> --converter <onnx2ncnn.exe>
```

脚本同时校验源模型和生成物指纹。资源随 Android 原生库嵌入，不需要运行时下载、写模型副本或请求共享存储权限。上游权重分别来自 nihui/waifu2x-ncnn-vulkan 的 upconv_7_anime_style_art_rgb 和 bilibili/ailab 的 Real-CUGAN；原项目 ONNX 的导出记录见各模型包 provenance。许可见同目录 LICENSE 文件；ncnn/glslang 许可见 native/ncnn，合并的 NOTICES 随关于页开源协议展示。
