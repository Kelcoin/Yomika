# NGX 的静态库与垫片

这个目录里是 DLSS5（`nvngx_dlssnr.dll`）路径要用到的两样东西，外加一条编译期约定。

## 文件

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `nvsdk_ngx_s.lib` | NVIDIA/DLSS 仓库的 SDK（`lib/Windows_x86_64/x64/nvsdk_ngx_s.lib`） | NGX 的客户端核心：初始化、分配参数表、创建/评估特性都从这里进 |
| `NVIDIA-DLSS-LICENSE.txt` | 同上 | NVIDIA 的许可原文；分发这份 `.lib` 时随附 |
| `ngx_shim.c` | 本项目 | 垫片：把上面那份 `.lib` 的调用包成几个 C 导出，编成 `yomika_ngx.dll` |

## 为什么要垫片

`nvsdk_ngx_s.lib` 是 `/MT`（静态 CRT）编的，而 Rust 的 MSVC 目标默认 `/MD`（动态 CRT）。
直接把 `.lib` 链进 crate 会被链接器按 `LNK2038`（RuntimeLibrary 不匹配）挡下来。

于是 `src-tauri/build.rs` 用 `cl.exe` 把 `ngx_shim.c` 编成一个**小的垫片 DLL**
（`/LD /O2 /MT /utf-8`），把 SDK 的静态库用 `/WHOLEARCHIVE:` 整个拉进去：

- 不加 `/WHOLEARCHIVE:` 的话，SDK 里那些 C++ 全局对象的初始化会被链接器丢掉，
  运行期调用会跳到空指针——症状是「初始化时直接 AV，位置看起来毫无道理」。
- 另外要带上 `advapi32.lib`（SDK 内部用注册表/凭据 API）与 `user32.lib`。
- `build.rs` 会把这次编译的**完整命令行与 stderr** 打进 cargo 的 warning：垫片编不成
  就是「这个构建没有 NGX 核心」，设置页那一组会显示对应原因。

垫片导出（`ngx_shim.c`）：

```
yomika_ngx_init / allocate / destroy / create_feature / evaluate_feature / release_feature
```

Rust 侧的加载顺序是 `YOMIKA_NGX_SHIM` 环境变量 → exe 同目录 → `OUT_DIR`（测试里直接从
构建产物加载）。

## 刷新这份 `.lib`

1. 从 NVIDIA 的 DLSS 仓库取对应版本的 SDK（`lib/Windows_x86_64/x64/nvsdk_ngx_s.lib`），
   覆盖这里的同名文件；`NVIDIA-DLSS-LICENSE.txt` 一并更新。
2. `cargo test --lib dlssnr::` —— 里面有几条会**实测**参数表的槽位顺序
   （`ngx.rs::probe_parameter_slots`，需要 `YOMIKA_NGX_SLOTS=1` 且本机有支持的 N 卡 +
   `docs/DLSSNR-DLL-Options-310.8.0.0` 里那份片段 DLL）。槽位一旦变了，断言会先炸，
   而不是等到阅读器里出一张怪图。
3. 新版本的 NGX 若换了参数名或新增参数，先看 `docs/31-dlss5-and-compute-center.md`
   里那张槽位表与排查用的日志开关。

## 许可

`nvsdk_ngx_s.lib` 与 `NVIDIA-DLSS-LICENSE.txt` 归 NVIDIA（见许可原文）；`ngx_shim.c`
是本项目的一部分，随本项目的许可发布。
