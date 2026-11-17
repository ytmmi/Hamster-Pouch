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
- **关于与更新**：「全部设置 → 关于」展示版本、构建时间与许可证；更新检查读 GitHub Releases，非最新时跳转 Release 页
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
| `external-cli/` | 随仓库分发的 FFmpeg（mpv 已于 2026-11 移出，见[第三方组件](#第三方组件)） |
| `tools/` | 门禁脚本与数据管线（`check-*.mjs`、`tagdict/`） |
| `.github/` | CI 与手动发布 workflow |
| `docs/` | 规范、决策记录、架构与路线图 |

| crate | 职责 |
| --- | --- |
| `hp-core` | 领域模型（仓库、媒体源、相册、图像、标签、评分），无外部依赖 |
| `hp-db` / `hp-repo` / `hp-global` / `hp-dict` | SQLite 连接骨架 / 仓库库 / 全局配置库 / tag 词库 |
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
| `HP_TEST_VIDEO` | 媒体测试用视频路径 |

## 构建与发布

编译分成**两条互不相干的管线**（D230）。区别只有两点：版本号形状，以及产物落在哪个目录。
一次构建只走一条管线，**不会顺手改另一条的版本号**。

| 管线 | 版本形状 | 命令 | 产物 |
| --- | --- | --- | --- |
| 开发 | 四段 `X.Y.Z.A-Alpha` | `pnpm app:build` | `target/release/dev/dev-<时间戳>/` |
| 发布 | 三段 `X.Y.Z` 或 `X.Y.Z-beta` | `pnpm app:release`（默认不改号） | `target/release/release/` |

- 开发管线的 `A` 是开发迭代号：`0.1.1.1-Alpha` → 下一次构建 `0.1.1.2-Alpha`，`X.Y.Z` 不动。`-Alpha` 是开发管线**独占**后缀，发布管线写 `-Alpha` 会被直接拒绝。
- 两条管线的 `X.Y.Z` 必须相同：开发包是"当前发布版本"的开发快照，`A` 只在本地两次构建之间区分先后。发一次发布会把发布版本的 `Z` +1，此时开发包的 `X.Y.Z` **落后一个 patch**，属正常偏差；构建脚本算出差值的绝对值 ≤1 时只打一行说明，**>1 或 major/minor 不同则打印警告**（不阻断构建，提示可能漏过了发布构建或版本被手工改过）。开发管线自动推导时会把三段重新对齐到当前发布版本，两条管线不会越差越远。
- **发布构建默认不改版本号**（D232）：`pnpm app:release` 沿用 `tools/versions.json` 里的当前发布版本，重打同一个版本（补资产、重跑流水线）不会被莫名抬号；要发新号就显式加 `--bump`（`Z` 段 +1、后缀原样保留），或用 `--version <版本>` / `HP_VERSION` 直接指定。开发管线相反，默认 `A` 段 +1——迭代密，每次构建都该有个新号。
- **版本号只在真实编译构建时变更**：`app:build` / `app:release` 只有真的跑了 cargo/tauri 编译才把新版本写进 `tools/versions.json`；`--dry-run` 与 `HP_SKIP_TAURI_BUILD=1`（只打包）一律不改版本号，只提交代码更不会改（pre-commit 只跑 `check:*`）。编译失败会把版本号回滚到编译前的值，不留"版本升了、产物却没出来"的悬空版本。
- **发布构建要开发者点头**：`pnpm app:release` 在编译前打印当前/本次发布版本并要求确认（`yes` 继续、回车取消、直接输入另一个版本号则改用它）；CI（`CI=true`）与 `--yes` 跳过。开发管线不问。
- 其余命令：`pnpm app:package` / `app:package:release` 用现有编译产物单独打包（不重新编译，也不改版本号）；`pnpm clean` 清理编译产物（保留活动数据与依赖）。
- 产物是自包含文件夹（`apps/desktop/src-tauri/target/release/`），整夹搬走仍可运行：exe + `external-cli\`（[FFmpeg](https://ffmpeg.org/) 运行时子集）+ `plugins\system\` + 基底词库。开发包用 NTFS 硬链接，发布包为真实复制。mpv 已于 2026-11 移出仓库（libmpv 通道退役，缺陷 0047），**发布包不再包含它**；本机自备 `external-cli/mpv/` 时本地打包仍会带上（见下节第三方组件）。
- 扩展插件以独立压缩包分发（`plugins-dist/*.zip`），解压后从「扩展」菜单安装，不与主程序合包。
- 发布走手动流程：`Actions → Release Package → Run workflow`，输入 `version`（**留空则沿用当前发布版本号、不打号**——想让流水线自动 +1 就在这里显式填 `next`，或填形如 `0.1.2-beta` 的具体版本原样使用）、`publish`（是否创建 GitHub Release）、`notes`。同一版本重跑会覆盖资产。
- 版本事实在 `tools/versions.json` 的 `release` / `dev` 两个字段里，由 `node tools/version.mjs` 统一读写（`--pipeline dev|release` 选管线，默认 `release`）：`--current` 显示、`--next` 预览 +1（开发加 `A`、发布加 `Z`）、`--write <v>` 指定、`--apply` 按 `HP_VERSION` 或 +1 落盘、`--verify` 校验三处发布副本与 `versions.json` 一致。
- 发布版本另有三处派生副本（`tauri.conf.json` / 桥接 crate 的 `Cargo.toml` / `apps/desktop/package.json`），由 `version.mjs` 同步；**开发版本不进这三处**——cargo 只认三段 semver，四段版本由 `build.rs` 以 `HP_APP_VERSION` 环境变量烙进二进制（见 `apps/desktop/src-tauri/src/version.rs`）。
- 「全部设置 → 关于」页展示的版本 / 构建时间 / 提交哈希来自构建期注入（`build.rs` 的 `cargo:rustc-env`），其中版本号与管线名（`dev` / `release`）来自 `HP_APP_VERSION` / `HP_APP_PIPELINE`；更新检查读 GitHub Releases 的 `v<version>` 标签，只比较前三段。

## 持续集成

`.github/workflows/ci.yml` 在 Windows runner 上跑三个作业：`gate`（全部 `pnpm check:*` 文本与结构门禁 + `typecheck` + `build`）、`clippy`、`test`（workspace 与桥接层 `cargo test --all-targets`）。提交前的本地钩子由 `pnpm install` 安装，`--no-verify` 能跳过，CI 不能。

## 第三方组件

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| [FFmpeg](https://ffmpeg.org/) | N-125157（2026-06-22） | GPL-3.0（`--enable-gpl --enable-version3`） | 元数据探测、缩略图、音频波形；`external-cli/ffmpeg/` 随包分发 |
| [mpv](https://mpv.io/) | v0.41.0-1023-g69e63f425 | GPL-2.0-or-later | **曾随仓库分发，已于 2026-11 移出**（D162 / 缺陷 0047）；其休眠代码随后整体删除（D163）。当前播放器面板使用 DOM `<video>`，**不依赖 mpv** |
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

[GNU General Public License v3.0](LICENSE)（GPL-3.0）。随包分发的 FFmpeg 为 GPL 构建，再分发时须一并遵守其许可；mpv（GPL-2.0-or-later）自 2026-11 起已不随仓库与发布包分发，若在本机构建时自行带入，则由构建者自行遵守其许可。
