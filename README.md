# 仓鼠颊（Hamster Pouch）

> Windows 本地资源管理器：把图片、视频、音频、文本与绿色版程序统一入库、索引、打标与检索。

[![CI](https://github.com/ytmmi/Hamster-Pouch/actions/workflows/ci.yml/badge.svg)](https://github.com/ytmmi/Hamster-Pouch/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-lightgrey.svg)](#环境要求)

## 简介

仓鼠颊是一款基于 [Tauri](https://tauri.app/) 的 Windows 桌面应用。它以「仓库 / 媒体源 / 相册」组织本地文件：把文件夹扫描入库后做内容去重、标签与评分、AI 打标、插件扩展与界面自动化。数据全部保存在本机（SQLite 数据库 + 原始文件），不依赖云端。

## 功能

- **统一入库**：图片、视频、音频、文本与图书（txt / md / epub / pdf）、绿色版程序（非安装程序）
- **仓库与媒体源**：多仓库隔离；媒体源扫描、变更检测；扩展名优先 + 内容兜底判定类型
- **去重与变更**：BLAKE3 内容哈希 + dHash 感知哈希；复制 / 移动后保留标签、评分与相册成员
- **相册与标签**：固定相册与跟随源同步的相册；人工 / 自动标签分组、评分
- **AI 打标**：可插拔的提供方、任务队列与结果回写
- **预览与播放**：ffprobe 元数据、ffmpeg 缩略图与音频波形图、图片查看器、视频 / 音频播放器
- **图书**：图书预览面板与完整阅读器（目录、阅读选项、书签 / 笔记 / 高亮）
- **插件与自动化**：插件安装、信任与能力校验；事件蓝图驱动界面自动化
- **内置 MCP 服务**：可选开启的本机 MCP 端点，供外部 AI 客户端按标准协议读写仓库数据
- **界面**：dockview 可停靠面板布局；简体中文 / 繁體中文 / English

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust），应用标识 `dev.hamsterpouch.desktop` |
| 前端 | React 19 · TypeScript · Vite 8 · dockview |
| 后端 | Cargo workspace（Rust，edition 2024，多 crate） |
| 数据 | SQLite（仓库库 / 全局库 / 词库分离） |
| 包管理 | pnpm workspace + Cargo |

## 环境要求

- Windows 10 / 11（含 WebView2 运行时）
- Node.js ≥ 22.16、pnpm ≥ 12（版本真相是 `package.json#packageManager`，pnpm 会自我对齐到它；若在 corepack 拉起的 shell 里报版本不符，用 `env -u COREPACK_ROOT pnpm …`）
- Rust 工具链（edition 2024，版本见 `rust-toolchain.toml`）

`hp-media` 默认启用 `libheif` 特性（HEIC / HEIF / AVIF 解码），构建前需安装 vcpkg 与 libheif：

```powershell
git clone --depth 1 https://github.com/microsoft/vcpkg D:\vcpkg
D:\vcpkg\bootstrap-vcpkg.bat -disableMetrics
$env:VCPKG_ROOT = "D:\vcpkg"
vcpkg install "libheif[aom]:x64-windows-static-md"
```

## 快速开始

```powershell
pnpm install          # 安装前端依赖（同时安装 git 钩子）
cd apps/desktop
pnpm tauri dev        # 开发运行，自动启动 Vite
```

仅启动前端：`pnpm dev`（http://localhost:5173）。

```powershell
pnpm typecheck    # tsc --noEmit
pnpm build        # vite build
cargo build       # Rust workspace
cargo test        # Rust 测试
pnpm app:build    # 编译并打出便携发布包
```

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/desktop` | Tauri 桌面应用（前端 `src/`、宿主 `src-tauri/`） |
| `packages/` | 前端共享包：`config`、`ui`、`shared-types` |
| `crates/` | Rust 核心库（见下表） |
| `plugins/` | 插件：`system/`（palette、python-core）、`examples/` |
| `external-cli/` | 随仓库分发的 ffmpeg 与 mpv |
| `tools/` | 门禁脚本与数据管线（`check-*.mjs`、`tagdict/`） |
| `.github/` | CI 与手动发布 workflow |
| `docs/` | 规范、决策记录、架构与路线图 |

| crate | 职责 |
| --- | --- |
| `hp-core` | 领域模型（仓库、媒体源、相册、图像、标签、评分），无外部依赖 |
| `hp-store` | SQLite 访问、迁移与事务 |
| `hp-scanner` | 媒体源扫描、变更检测、类型判定 |
| `hp-hash` | BLAKE3 内容哈希与 dHash 感知哈希 |
| `hp-album` | 相册同步规则与成员维护 |
| `hp-fsops` | 源间复制 / 剪切 / 移动与操作记录 |
| `hp-media` | 媒体子进程、ffprobe 元数据、ffmpeg 抽帧与波形图 |
| `hp-book` | EPUB / Markdown / TXT / PDF 解析、正文与目录 |
| `hp-ai` | AI 打标提供方抽象、任务队列与结果回写 |
| `hp-plugin-host` | 插件发现、安装、信任与能力校验 |
| `hp-dto` | 跨层 DTO 单一事实来源（生成 `packages/shared-types`） |

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `VITE_HP_UI` | 前端 UI 变体：`app_ui`（默认）/ `test_ui` / `dev_ui` |
| `HP_MPV_BIN` | mpv 可执行文件路径（优先于 `external-cli/mpv/`） |
| `HP_MPV_EMBED` | 设为 `1` 时启用主窗口级 mpv 渲染嵌入（仅诊断） |
| `HP_TEST_VIDEO` | 媒体测试用视频路径 |

## 构建与发布

| 命令 | 作用 |
| --- | --- |
| `pnpm app:build` | 编译并生成开发包与发布包 |
| `pnpm app:package` | 用现有编译产物打包 |
| `pnpm clean` | 清理编译产物（保留活动数据与依赖） |

- 产物是自包含文件夹（`apps/desktop/src-tauri/target/release/`），整夹搬走仍可运行：exe + `external-cli\`（[FFmpeg](https://ffmpeg.org/) 运行时子集、[mpv](https://mpv.io/)）+ `plugins\system\` + 基底词库。开发包用 NTFS 硬链接，发布包为真实复制。
- 扩展插件以独立压缩包分发（`plugins-dist/*.zip`），解压后从「扩展」菜单安装，不与主程序合包。
- 发布走手动流程：`Actions → Release Package → Run workflow`，输入 `version`（留空取 `tauri.conf.json`）、`publish`（是否创建 GitHub Release）、`notes`。同一版本重跑会覆盖资产。

## 持续集成

`.github/workflows/ci.yml` 在 Windows runner 上跑三个作业：`gate`（全部 `pnpm check:*` 文本与结构门禁 + `typecheck` + `build`）、`clippy`、`test`（workspace 与桥接层 `cargo test --all-targets`）。提交前的本地钩子由 `pnpm install` 安装，`--no-verify` 能跳过，CI 不能。

## 第三方组件

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| [FFmpeg](https://ffmpeg.org/) | N-125157（2026-06-22） | GPL-3.0（`--enable-gpl --enable-version3`） | 元数据探测、缩略图、音频波形；`external-cli/ffmpeg/` 随包分发 |
| [mpv](https://mpv.io/) | v0.41.0-1023-g69e63f425 | GPL-2.0-or-later | 随仓库分发（`mpv.exe` 走 Git LFS）；当前播放器面板使用 DOM `<video>`，libmpv 通道休眠 |
| [libheif](https://github.com/strukturag/libheif) | 1.23.x（vcpkg） | LGPL-3.0 | HEIC / HEIF / AVIF 进程内解码 |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) | 随 `libwebp-sys` vendored | BSD-3-Clause | 缩略图进程内 WebP 编码 |
| [SQLite](https://sqlite.org/) | 3.x（rusqlite） | Public Domain | 仓库库 / 全局库 / 词库 |
| [Tauri](https://tauri.app/) · [React](https://react.dev/) · [dockview](https://dockview.dev/) | 见 `package.json` / `Cargo.toml` | MIT / Apache-2.0 | 桌面壳、界面与面板布局 |

EPUB 排印规则参考了 [Readium CSS](https://github.com/readium/css) 与 [foliate-js](https://github.com/johnfactotum/foliate-js) 的公开实现。

## 文档

- `docs/architecture/` —— 架构总览、决策清单、文件结构
- `docs/spec/` —— 各域规范（含 README 写作规范 `readme-standard.md`）
- `docs/rfc/` —— 已确认的决策记录
- `docs/roadmap/` —— 路线图与阶段计划

## 贡献

欢迎提交 Issue 与 Pull Request。文本文件一律 UTF-8 无 BOM、LF 行尾（由 `pnpm check:encoding` 与 git 钩子守护）；提交前请跑 `pnpm typecheck` 与相关 `pnpm check:*` 门禁。

## 许可证

[GNU General Public License v3.0](LICENSE)（GPL-3.0）。随包分发的 FFmpeg 与 mpv 均为 GPL 构建，再分发时须一并遵守其许可。
