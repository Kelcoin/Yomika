# Android Vulkan 模型变体

随包只带一份变体：内置的 `waifu2x-upconv7`。在线模型（`realcugan-2x-conservative` / `realcugan-2x-denoise3x`）的 ncnn 权重单档 5,138,512 B，编进原生库等于让每个 APK 替用户预付一份多数人从没用过的权重，所以它们**不再随包分发**——Android 上下载来的那两份 ONNX 照旧走 ORT（NNAPI/CPU），`NcnnEngine::open` 认不出指纹就返回 `Ok(None)`（`worker/src/upscale.rs`），不会静默换一份别的权重。

`models.json` 里的每一份资源由现有 ONNX 原文件转换，按 SHA-256 选择，不能按显示名称猜测模型。只支持对应指纹的 x2 模型；自定义或更新后的 ONNX 继续使用 ORT。权重保持 float32，输入为 RGB NCHW [0,1]，固定 128×128。Rust 的共用分块管线负责边缘复制、重叠裁剪、alpha、取消、进度和预算。

| 变体 | 源 ONNX | `.param`（字节 / SHA256） | `.bin` 权重（字节 / SHA256） |
|---|---|---|---|
| `waifu2x-upconv7` | 内置 `src-tauri/resources/models/waifu2x-upconv7/model.onnx`（`3bd55b48…`） | 1,477 / `d00c443f…` | 2,209,960 / `63e6d1bc…` |

这条口径由 `ncnn.rs` 里三条用例钉住：`vulkan_variants_are_limited_to_the_bundled_model` 要求 `models.json` 的 id 与 `BUNDLED_VARIANTS` 同序、且指纹就是内置那张图（往回加一档在线模型会转红）；`bundled_vulkan_payload_stays_under_budget` 把 `.param` + `.bin` 的总字节压在 3 MiB 以内；`converted_assets_are_verified` 核逐文件身份。三个 `.bin` / `.onnx` / `.param` 在 `.gitattributes` 里按二进制处理——`core.autocrlf=true` 的机器上 checkout 不会改写 `.param` 的换行，否则指纹对不上、`converted_assets_are_verified` 会在干净检出里假红。

转换使用 onnxsim 0.8.1 固定输入形状并验证图，再交给官方 ncnn 20240410 onnx2ncnn。旧转换器需要显式卷积 kernel_shape；ReduceMean/Slice 的常量输入先转成旧属性，避免被当成额外动态张量。Real-CUGAN 的末尾 Mul/Round/Div 由共用 RGBA 写回的 8 位取整完成（该档现已不随包；要重新随包分发得同时改回 `models.json` 条目、`.param`/`.bin`、`BUNDLED_VARIANTS` 与 3 MiB 预算，四条判据会一起提醒）。

重新转换（需要 onnx、onnxsim 和官方转换器）：

```powershell
python .github/scripts/convert-mobile-ncnn.py waifu2x-upconv7 src-tauri/resources/models/waifu2x-upconv7/model.onnx --converter <onnx2ncnn.exe>
```

脚本同时校验源模型和生成物指纹。资源随 Android 原生库嵌入，不需要运行时下载、写模型副本或请求共享存储权限。上游权重来自 nihui/waifu2x-ncnn-vulkan 的 upconv_7_anime_style_art_rgb；Real-CUGAN 的许可与导出记录仍留在同目录 `realcugan-LICENSE.txt` 与 `NOTICES.txt`（那些模型由用户下载后经 ORT 运行，不随包）。ncnn/glslang 许可见 native/ncnn，合并的 NOTICES 随关于页开源协议展示。
