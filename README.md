<p align="center">
  <img src="assets/yomika-mark-print.svg" width="96" alt="Yomika" />
</p>

<h1 align="center">Yomika</h1>

<p align="center">
  <a href="https://github.com/Kelcoin/Yomika/actions/workflows/ci.yml"><img src="https://github.com/Kelcoin/Yomika/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/Kelcoin/Yomika/actions/workflows/build-packages.yml"><img src="https://github.com/Kelcoin/Yomika/actions/workflows/build-packages.yml/badge.svg" alt="Build Packages" /></a>
</p>

<p align="center">面向 LANraragi 与 E-Hentai 的本地优先阅读与档案管理客户端。</p>

Yomika 用 Tauri 2 把远程内容源、一个可靠的本地阅读库和可恢复的多设备同步组织成一致体验：SQLite 与本地文件缓存是事实主库，WebDAV 承载端到端加密的增量同步，统一的原生推理服务承载图片超分与去码。它不包含 LANraragi 服务端，也不替代 E-Hentai 站点。

## 功能

- **档案库与浏览** — 多服务器配置与健康检查、搜索/分类/排序、离线快照、虚拟化大列表、宽行与缩略卡双模式。
- **阅读器** — 单页/双页/条漫与自动版式、左右方向、翻页预取、隐身模式、阅读进度落库。
- **书架** — 历史、收藏夹（LANraragi 🔖 Favorites 分类）、待看档案；时间线分组与多选批量操作。
- **E-Hentai** — 多账户 Cookie 登录与健康检查、评论、收藏、删除同步开关、「我的标签」优先显示并使用账户预设底色。
- **同步** — 端到端加密的 WebDAV 增量同步：阅读进度、历史、待看、偏好与设备，冲突可解释、可重放。
- **工具** — 重复档案查重工作台、上传队列、下载任务中心。
- **图像增强** — 原生推理服务承载 waifu2x 超分与去码模型，原图先显示、结果就绪后无闪烁替换。
- **外观** — 亮/暗主题、预设与自定义配色方案、Material 3 令牌体系、移动端自适应布局。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 · TypeScript 5.9 · Vite 8 · Zod |
| 桌面/移动壳 | Tauri 2（Windows 现役；iOS/Android 目标平台） |
| 原生核心 | Rust · SQLite（rusqlite）· keyring · reqwest |
| 推理 | onnxruntime（ort）· waifu2x / 去码模型管线 |
| 交互/可视化 | Radix · Motion · TanStack Virtual · React Resizable Panels |
| 测试 | Vitest 4 · cargo test |

## 架构

```text
┌──────────────────────────────────────────────────────────────┐
│ React + TypeScript UI                                         │
│ 路由 / 组件 / 领域模型 / 阅读器状态 / 查询缓存                 │
└──────────────────────────────┬───────────────────────────────┘
                               │ typed invoke / events
┌──────────────────────────────▼───────────────────────────────┐
│ Tauri Bridge                                                   │
│ 命令：存储、文件、密钥、同步、推理、系统                        │
│ 事件：任务、同步、下载、阅读器、诊断                            │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Rust 原生核心                                                  │
│ 领域 / 仓储 / 任务运行时 / 网络 / 同步引擎                      │
│ SQLite · 文件缓存 · 系统密钥链 · 原生推理协调                   │
└──────────────┬────────────────┬───────────────────┬───────────┘
               │                │                   │
        LANraragi API     WebDAV 加密同步      原生平台推理
        E-Hentai 网关                          WinML / CoreML / NNAPI
```

## 快速开始

前置要求：Node.js 20+、npm、Rust stable；面向 Windows 构建还需 Visual Studio Build Tools、Windows SDK 与 WebView2 Runtime。运行时需要自备 LANraragi 实例（URL + API Key）；E-Hentai 功能需自备账户 Cookie。

```bash
npm install

# 前端开发服务器（无原生桥，端口 27790）
npm run dev

# 完整应用开发模式
npm run tauri dev

# 生产构建
npm run build
npm run tauri build
```

> [!NOTE]
> 本仓库的 Windows 便携构建走内部本地工具链（`tools/windows/build.ps1`，不入库）；仓库对外以 CI 产出为准，打 `app-v*` 标签或手动触发「Build Packages and Releases」即可在 Actions 产物中取得 Windows 便携包。

## 目录结构

```text
src/                 React 前端（app / components / domain / repositories / services / lib / styles）
src-tauri/           Rust 壳与原生核心（commands / db / domain / inference / network / cache）
src-tauri/migrations SQLite 迁移
tests/               Vitest 组件、领域与契约测试
tools/models/        模型转换与发布脚本
assets/              品牌资产（SVG）
.github/workflows/   CI 与打包流水线
```

## 测试与质量门禁

```bash
npm run typecheck   # tsc -b（比 --noEmit 更严格）
npm test            # Vitest：组件 / 领域 / 契约测试
cargo test          # Rust：src-tauri 下的单元与集成测试
```

三个门禁全部通过是合入与发布的前提；设计系统契约测试（`tests/design-system-contract.test.ts`）把 token、组件形态与布局约束固定为可执行断言。

> [!IMPORTANT]
> macOS 与 Linux 不在项目维护与发布范围内。构建产物为便携式应用，运行数据由 Tauri 放在用户数据目录。

## 文档

设计与开发基线（产品范围、信息架构、视觉系统、系统架构、数据与缓存、同步协议、推理服务、E-Hentai 模块等）维护在本地 `docs/`（编号 00–19），按仓库约定不入库；仓库内保留 [docs/20 跨平台 UI 与操作逻辑规范](docs/20-cross-platform-ui-logic-standards.md) 与 [docs/progress.md](docs/progress.md) 进度日志。

## 第三方

- 标签翻译数据来自 [EhTagTranslation](https://github.com/EhTagTranslation/Database) 社区数据库，运行时从其 DatabaseReleases 发布源获取。
- 内置的 waifu2x-upconv7 模型源自 nihui/waifu2x-ncnn-vulkan（MIT，许可文本随模型安装到数据目录）；Anime4K 着色器取自 bloc97/Anime4K（MIT，文件头随资源保留）。
- 去码模型包（Aletheia-Lens，GPL-3.0）不内嵌于应用，以独立 Release 分发并随包附带其许可证文本。
- JHenTai（Apache-2.0）、LANreader（MIT）、ComicReadScript（AGPL-3.0）、imsearch（GPL-3.0）等仅作为本地行为参考，未复制源码、资源或文案。
