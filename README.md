# Yomika

Yomika 是面向 LANraragi 与 E-Hentai 用户的本地优先跨平台阅读与档案管理客户端。

项目目标：使用 Tauri 2 覆盖 Windows、iOS、Android；以 SQLite 与本地文件缓存作为事实主库；以端到端加密的 WebDAV 增量同步实现多设备延续；以统一原生推理服务承载这三个维护平台的图片超分与后续硬件加速。macOS 与 Linux 不属于项目维护和发布范围。

## 文档

完整迁移开发文档位于本地 `docs/`。根据项目约定，`docs/` 已加入 `.gitignore`，不会上传至远端仓库。仓库只保留本 README、源码和项目运行所需资产。

开发计划、调研记录与进度日志统一维护在 `docs/task_plan.md`、`docs/findings.md` 和 `docs/progress.md`，根目录不创建同类工作文件。

## 品牌资产

- `yomika-logo.svg`：Yomika 主 Logo，适用于应用内、桌面与移动端图标生成。
- `yomika-mark.svg`：仅图形标记。

## 设计基线

- 详情页与阅读页分离。
- 详情页使用纵向信息流，评论保持上下滚动。
- 阅读页只保留滑动翻页；点击画面呼出标题/返回/工具菜单。
- 本地存储优先，网络同步异步化。
- 原图先显示，原生超分结果就绪后无闪烁替换。

## 本地开发

```bash
npm install
npm run dev
```

前端基础库按需使用 Radix（无障碍交互）、Motion（状态与页面动效）、TanStack Virtual（大列表虚拟化）和 React Resizable Panels（桌面分栏）。这些库不替换 Yomika 自有视觉 token；安装或升级依赖后运行 `npm audit`、`npm test`、`npm run typecheck` 和 `npm run build`。
