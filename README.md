<p align="center">
  <img src="src-tauri/icons/app-icon.svg" width="112" alt="Yomika" />
</p>

<h1 align="center">Yomika</h1>

<p align="center">面向 LANraragi 与 E-Hentai 的本地优先阅读与档案管理客户端。</p>

把 LANraragi 档案库变成随手可读的书架：搜索、整理、收藏与阅读集中在一个应用中，支持图像增强和加密的多设备同步。主要面向 Windows 与 Android，基于 Tauri 2、React 和 Rust 构建。

[获取应用](#获取应用) · [首次使用](#首次使用) · [功能](#功能) · [数据与迁移](#数据与迁移) · [开发与构建](#开发与构建) · [MIT 许可证](LICENSE)

## 获取应用

可用安装包见 [Releases](https://github.com/Kelcoin/Yomika/releases)。仓库或发布页尚未开放、尚无可用包时，请使用下方的源码构建方式。

| 平台 | 分发形式 | 说明 |
| --- | --- | --- |
| Windows x64 | 便携 ZIP | 解压运行 `yomika.exe`；包含 DirectML 运行库与随包模型，需要 WebView2 运行时 |
| Android arm64 | APK | 使用签名版本安装；与桌面端共用书架、阅读进度和同步协议。安装包内带 ONNX Runtime 与 ncnn 运行库，体积约 85 MB |
| iOS arm64 | 未签名 IPA | 仅提供构建产物，需要自行签名，尚未提供完整维护的使用体验 |

macOS 与 Linux 暂不在维护范围内。

[Build Packages and Releases](.github/workflows/build-packages.yml) 工作流支持手动构建，也会响应 `app-v*` 标签。配置发布标签后，安装包与配套清单发布到 Release assets；文件名包含版本与提交号，例如 `yomika-<version>-<commit>-windows-x64.zip` 和 `yomika-<version>-<commit>-android-arm64-v8a.apk`。

## 首次使用

Yomika 不包含 LANraragi 服务端。使用服务器档案库前，请准备好 [LANraragi](https://github.com/Difegue/LANraragi) 实例及其 API Key；E-Hentai 账户为可选项。

1. **连接档案库**：在「设置 → 通用 → 服务器」填写 LANraragi 地址与 API Key。支持保存多台服务器并切换当前连接。
2. **载入档案**：打开档案库，等待索引与封面加载。之后服务器暂时不可达时，仍可查看已有的本地索引。
3. **开始阅读**：点击档案卡片打开阅读器，阅读进度自动记录，并更新首页「继续阅读」与历史记录。
4. **按需配置增强**：在「设置 → 高级」选择增强方式，下载或导入模型、DLSSNR DLL；也可连接另一台设备的算力中心。
5. **按需连接服务**：配置 E-Hentai Cookie 以使用评论、收藏等功能；配置 WebDAV 或 S3 兼容存储以同步多设备数据。

> [!NOTE]
> 离线阅读依赖仍在缓存中的页面或已下载的内容。图片缓存会按设置的空间上限清理，曾经阅读过不代表整本档案永久可离线使用。

## 功能

### 档案库与书架

- **首页**：继续阅读、待看与随机漫游，可调整组件，也可将档案库设为启动页。
- **检索**：支持 LANraragi 搜索语法、分类筛选、排序与检索预设；列表按行虚拟化并分批加载。
- **浏览与整理**：列表、缩略图两种卡片布局，显示标签、页数与阅读进度；详情面板提供按命名空间分组的标签、简介和操作入口，支持编辑元数据并写回服务器。
- **批量操作**：右键或触屏长按打开操作菜单，多选后批量加入待看、收藏或删除。

三种书架各有用途：

| 书架 | 数据来源与行为 |
| --- | --- |
| 历史 | 本地阅读记录，按时间查看，可移除记录或导出迁移 |
| 收藏夹 | LANraragi 的 **`🔖 Favorites` 分类**；收藏操作写回该分类，列表读取该分类下的档案 |
| 待看（Watchlist） | 独立于 LANraragi 分类的本地清单，可通过 Yomika 同步；阅读进度**超过 90%** 时自动移出 |

### 阅读器

- 自动、单页、双页与连续滚动版式，支持从左到右或从右到左阅读。
- 键盘方向键、`PageUp` / `PageDown`、空格翻页；鼠标拖拽、触屏滑动、双击放大和双指缩放。
- 页码指示器、独立显隐的顶栏与底栏，以及可直接跳页的缩略图面板；Android 阅读时随顶栏显隐切换状态栏。
- 可配置页面预取；原图先显示，超分或 DLSSNR 产物就绪后替换。图片加载失败时可点击重试。
- 恢复阅读页与分页 / 连续阅读状态，阅读方向以当前全局设置为准；隐身模式不记录阅读进度。

### 图像增强与算力中心

- **Anime4K**：内置着色器链，桌面端通过 GPU 计算后端（wgpu）执行，显卡不可用时回退到 CPU；Android 端同一档模型改走 ncnn（Vulkan）。
- **超分模型**：随包提供 waifu2x-upconv7，也可安装 Real-CUGAN 2x 等支持的模型及 DirectML 变体。
- **DLSSNR**：使用 NVIDIA DLSS 光线重建片段（`nvngx_dlssnr.dll`）。可选官方原版、社区 Lecram 版与 SF 版三档（各自支持的显卡代次不同，见设置内说明），已安装的多份片段可以共存并随时切换；也允许导入本地片段，应用只按 PE 结构与必需导出判断能否加载，不要求 NVIDIA 签名。导入与首次启用都在独立计算进程里验证当前环境是否可用，失败会写清片段名、字节数与选中的显示适配器。
- **移动端本地计算**：Android 走 NNAPI 或 ncnn（Vulkan），iOS 走 CoreML；计算进程内嵌在应用里，因此移动端安装包比桌面端大得多。
- **资源调度**：根据可用资源调整分块和处理规模。可用能力受显卡、驱动、模型、DLL 版本与页面尺寸共同影响，可通过内置诊断检查。
- **自动超分**：平均每页体积**低于**设定阈值，并满足配置的标签规则时自动开启；无法确定有效体积时不自动启用。
- **远端计算**：桌面端可开启算力中心，手机或其他客户端配对后，将需要处理的页面交给该设备计算。

模型与 DLL 下载清单来自 [Yomika-Models](https://github.com/Kelcoin/Yomika-Models)，下载时校验 SHA256。不同 DLSSNR 版本的硬件支持范围不同，请以导入验证和当前设备诊断结果为准。增强结果使用会话缓存，退出阅读后清理，也可在高级设置中手动清除。

### E-Hentai、查重与任务

- **E-Hentai**：多账户 Cookie 登录、账户健康检查、画廊评论、收藏同步与「我的标签」；删除档案时可选择同时移除对应的 E-Hentai 收藏。
- **查重工作台**：结合封面与文件名检测重复档案，查看重复组及关联链，人工复核或智能选择保留项，再确认删除。支持保存扫描结果、标记非重复关系并重新载入处理。
- **上传与下载**：批量选择或拖入压缩包，也可提交下载链接给 LANraragi；档案下载与其他后台任务统一显示进度、状态和失败原因。

### 外观与诊断

- 浅色、深色与跟随系统主题，多套基础配色（默认、青瓷、黛蓝、紫檀、绯樱、琥珀、子夜、深林、天青）、自定义 CSS，以及可配置的详情页操作按钮。
- SFW 封面模糊，桌面侧边栏折叠，移动端悬浮底栏与导航项目配置。
- 「设置 → 高级」查看封面、缩略图、阅读页及增强缓存占用，设置空间上限或手动清理。
- 「设置 → 关于 → 错误日志」查看、导出本次及上次运行的脱敏诊断记录；预期的取消与队列退让不会作为故障堆积。

## 数据与迁移

索引、阅读记录、设置与缓存保存在本机；凭据的存储方式随平台而异：

| 平台 | 应用数据 | LANraragi API Key、E-Hentai Cookie 等凭据 |
| --- | --- | --- |
| Windows | `yomika.exe` 同级的 `data/` 目录 | Windows 系统凭据库 |
| Android / iOS | 系统分配的应用数据目录 | 应用私有目录内的 `secrets.json`，内容为明文 |

Windows 迁移时可复制程序与 `data/`，但系统凭据不会随目录复制，换设备后需要重新填写。阅读历史与待看也可单独导出、导入 JSON，导出内容不包含服务器凭据。本地数据库与缓存不等同于加密备份。

**多设备同步**支持 WebDAV 与 S3 兼容对象存储（如 Cloudflare R2、MinIO）。同步文档端到端加密，包含阅读进度、历史、待看、检索预设与非重复标记；服务器配置、E-Hentai 账户配置和应用设置可按需选择，API Key 与 Cookie 不进入同步文档。

联网操作会访问你配置的 LANraragi、E-Hentai、同步存储，以及标签翻译、模型和更新下载源。启用远端算力时，需要处理的页面会发送给配对的算力中心。

## 开发与构建

### 环境准备

- Node.js **22.12+**、npm 与 Rust stable。
- Windows：MSVC C++ Build Tools、Windows SDK、WebView2，以及执行构建脚本所需的 PowerShell 7。
- Android：额外准备 **JDK 21**（Zulu 21 实测可用；JDK 25 在配置 `:buildSrc` 时就会失败）、Android SDK 36、NDK `28.2.13676358`，配置 `ANDROID_HOME`，并安装 Rust 目标 `aarch64-linux-android`。首次构建移动端还需要 Python、Git、CMake、Ninja 与 Python 的 `numpy`、`packaging`：构建脚本会用它们现场编译并暂存 ONNX Runtime（NNAPI）与 ncnn（Vulkan）运行库。

原生工具链安装方法见 [Tauri 环境准备文档](https://v2.tauri.app/start/prerequisites/)。以下命令均在仓库根目录执行。

### 本地运行与检查

```powershell
npm ci
npm run tauri dev    # 启动带原生后端的桌面应用
```

```powershell
npm run dev          # 仅启动前端，默认端口 27790
npm run typecheck    # TypeScript 项目检查
npm test             # Vitest 测试
npm run build        # 检查类型并生成前端生产资源
cargo test --manifest-path src-tauri/Cargo.toml
```

浏览器里的前端开发服务没有 Tauri 原生后端，档案、文件与计算等原生功能需要在应用内验证。`npm run build` 只构建前端资源，不生成可运行的安装包。

### 打包

Windows 使用已安装在本机的工具链构建，再生成便携包和清单：

```powershell
pwsh -File .github/scripts/build-windows.ps1 -Release -UseHostTools
pwsh -File .github/scripts/package-windows.ps1 -ColdStart
```

`-UseHostTools` 让脚本使用系统工具链；省略时会查找本地便携工具目录。构建脚本会准备计算进程、DirectML 和随包模型，打包脚本的 `-ColdStart` 会执行冷启动与旧数据库迁移冒烟检查。

Android 默认生成可安装的调试 APK：

```powershell
pwsh -File .github/scripts/build-android.ps1
```

发布构建加 `-Release`，并按 [Android 构建脚本](.github/scripts/build-android.ps1) 配置签名文件与 `ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。缺少签名配置时生成的未签名发布 APK 不能直接安装。

移动端第一次构建会先准备 ONNX Runtime（NNAPI）与 ncnn（Vulkan）两份运行库，明显慢于之后（`--reuse-if-valid` 会复用已有产物）。构建收尾会自动跑 [verify-mobile-runtime.py](.github/scripts/verify-mobile-runtime.py) 检查 APK 里主库的依赖闭包：缺运行库时构建直接失败，而不是装到手机上才报错。

Windows 计算链路的整轮验证包含硬件与运行环境检查，需要相应 GPU、驱动和 DLL：

```powershell
pwsh -File .github/scripts/verify-round.ps1 -RepoRoot (Get-Location).Path
```

### 代码导航

| 路径 | 职责 |
| --- | --- |
| [src](src) | React 界面、阅读交互与前端数据访问 |
| [src-tauri/src](src-tauri/src) | Tauri 命令、数据库、LANraragi 集成、同步与任务管理 |
| [src-tauri/worker](src-tauri/worker) | 独立计算进程，承载 ONNX / DirectML / NGX 推理 |
| [src-tauri/crates](src-tauri/crates) | 共享 Rust 模块：与平台无关的计算核心（分块、Anime4K 着色器链、ONNX 与 ncnn 后端）与 worker 协议 |
| [tests](tests) | 前端与契约测试 |
| [.github/scripts](.github/scripts) | 构建、打包、冒烟检查与发布脚本 |

## 第三方资源

- 标签翻译来自 [EhTagTranslation](https://github.com/EhTagTranslation/Database)，运行时从其 DatabaseReleases 发布源获取。
- Anime4K 着色器来自 [bloc97/Anime4K](https://github.com/bloc97/Anime4K)（MIT），资源保留原许可信息。
- 随包 waifu2x-upconv7 模型源自 [nihui/waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan)，许可与来源记录见 [模型目录](src-tauri/resources/models/waifu2x-upconv7)。
- 可选超分模型与 NVIDIA DLSSNR DLL 按各自附带的许可证使用。

## 许可证

Yomika 以 [MIT 许可证](LICENSE)发布，版权归 Yomika contributors 所有。上面「第三方资源」里列出的
模型、着色器、社区数据与 DLL 各有自己的许可，随对应资源一并生效。
