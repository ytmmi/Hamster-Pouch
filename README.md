# 仓鼠颊（Hamster Pouch）

> 本地资源管理软件 —— 将图片、视频、音频、文本与绿色版程序统一入库、索引、打标与检索。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

仓鼠颊（Hamster Pouch）是一款面向 Windows 的本地资源管理软件。它以「仓库 / 媒体源 / 相册」为组织模型：把本地文件夹作为媒体源扫描入库，支持虚拟相册、内容去重与变更检测、AI 辅助打标、插件扩展与事件蓝图自动化，帮助你在本地管理大规模图片、视频、音频、文本与绿色版程序。

## 功能特性

- **资源管理**：图片 / 视频 / 音频 / 文本 / 绿色版程序（非安装程序）的统一入库与管理
- **仓库与媒体源**：多仓库、多媒体源扫描、变更检测与索引任务；媒体类型判定（扩展名优先 + 内容兜底）
- **哈希与去重**：BLAKE3 内容哈希 + dHash 感知哈希，支持去重、变更识别与哈希算法版本记录
- **相册**：固定相册、跟随源同步规则、成员维护
- **标签与评分**：仓库内 tag / 评分体系，来源、置信度与生成时间可追溯
- **AI 打标**：可插拔的 AI 打标提供方、任务队列与结果回写；高置信度覆盖用户 tag 时生成撤销记录
- **媒体能力**：ffprobe 元数据探测、ffmpeg 抽帧缩略图与缓存、媒体预览与播放器面板
- **图书预览**：文本类文件（epub / txt / md）入库（算内容哈希、不产出视觉派生）与图书预览面板（卡片 / 列表 / 封面三视图；EPUB 作者 / 简介 / 内嵌封面经 `book.meta` 解析；封面可右键换成指定颜色或自定义图片）
- **正文查看**：查看器可直接阅读 txt / md / epub 的开头内容（txt 自动判定 GBK / UTF-8 编码；**md 渲染成排版正文**——完整 CommonMark + GFM 语法，标题 / 列表 / 引用 / 代码块 / 表格 / 任务列表 / 脚注 / 定义列表；epub 含章节文字与插图；两者按面板宽度自适应单栏 / 双栏），滚动时按需取下一页
- **文件操作**：源间复制 / 剪切 / 移动并生成操作记录；内容哈希一致时保留 tag、评分与相册成员关系
- **插件系统**：插件包发现、安装、信任与能力校验（`hp-plugin-host`）；内置 system 插件与示例
- **事件蓝图**：以控件事件为蓝图事件源的自动化框架
- **多语言 UI**：简体中文（默认）/ 繁體中文 / English；dockview 可停靠面板布局

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust），应用标识 `dev.hamsterpouch.desktop` |
| 前端 | React 18 + TypeScript + Vite 5 + dockview（面板布局） |
| 后端 | Cargo workspace（Rust，edition 2021） |
| 数据 | SQLite（仓库库 / 全局库 / 词库边界） |
| 包管理 | pnpm workspace（`apps/*`、`packages/*`）+ Cargo |

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `apps/desktop` | Tauri 桌面应用（前端 `src/` + 宿主 `src-tauri/`） |
| `packages/` | 前端共享包：`config`、`ui`、`shared-types` |
| `crates/` | Rust 核心库（见下表） |
| `plugins/` | 插件：`system/`（palette、python-core）、`examples/` |
| `external-cli/` | 外部 CLI：ffmpeg 随仓库分发；mpv 需自行下载（可选） |
| `tools/` | 门禁与数据管线脚本（`check-*.mjs`、`tagdict/` 等） |
| `docs/` | 规范（`spec/`）、决策记录（`rfc/`）、架构文档（`architecture/`） |

Rust crates：

| crate | 职责 |
| --- | --- |
| `hp-core` | 领域模型（仓库、媒体源、虚拟相册、图像、tag、评分、封面覆盖），纯净无外部依赖 |
| `hp-store` | SQLite 访问、迁移、事务，仓库库 / 全局库 / 词库边界（仓库库当前版本 9） |
| `hp-scanner` | 媒体源扫描、变更检测、索引任务，媒体类型判定 |
| `hp-hash` | BLAKE3 内容哈希、dHash 感知哈希、算法版本记录 |
| `hp-album` | 相册同步规则与成员维护 |
| `hp-fsops` | 源间复制 / 剪切 / 移动，操作记录与元数据保留 |
| `hp-media` | 媒体子进程管理、播放控制、ffprobe 元数据、ffmpeg 抽帧 |
| `hp-book` | 电子书解析：EPUB 元数据 / 内嵌封面（自实现最小 ZIP + flate2，不引入 `zip` crate）；正文读取（txt 编码判定与分页、EPUB 章节 XHTML → 类型化块、**Markdown → 同一套类型化块**） |
| `hp-ai` | AI 打标提供方抽象、任务队列与结果回写 |
| `hp-plugin-host` | 插件发现、安装、信任与能力校验、生命周期框架 |
| `hp-dto` | 跨层 DTO 单一事实来源（前端 `shared-types` 由其生成） |

## 环境要求

- Windows 10/11（含 WebView2 运行时）
- Rust 工具链（edition 2021）
- Node.js ≥ 22 + pnpm ≥ 11
- 可选：vcpkg + libheif（`hp-media` 的 `libheif` 特性**默认开启**，用于 HEIC/HEIF/AVIF 进程内解码）：

  ```powershell
  git clone --depth 1 https://github.com/microsoft/vcpkg D:\vcpkg
  D:\vcpkg\bootstrap-vcpkg.bat -disableMetrics
  $env:VCPKG_ROOT = "D:\vcpkg"   # 建议写入用户环境变量
  vcpkg install "libheif[aom]:x64-windows-static-md"
  ```

  > 注意：libheif 端口的默认特性含 **x265（GPL-2.0 编码器，静态链入）**，发布许可需自行评估；解码用不到它。没有 vcpkg 的环境可用 `--no-default-features` 构建 `hp-media`，退回捆绑的 ffmpeg 兜底（功能不受影响）。
  >
  > `hp-media` 的 `libwebp` 特性（**默认开启**，D91）用于图片缩略图的**进程内 WebP 编码**：libwebp 的 C 源码**随 `libwebp-sys` crate vendored**（MIT），构建期由 `cc` 静态编译，**不联网、不依赖系统库**（C 工具链本就随 Rust MSVC 工具链提供）。关掉后自动退回 ffmpeg 子进程编码，结果**逐字节相同**、只是每张多一次进程开销。

## 快速开始

```powershell
# 1. 安装前端依赖
pnpm install

# 2. 开发运行（Tauri，自动启动 Vite）
cd apps/desktop
pnpm tauri dev

# 仅启动前端（http://localhost:5173）
pnpm dev

# 3. 构建与类型检查
pnpm build        # vite build
pnpm typecheck    # tsc --noEmit
pnpm tauri build  # 打包桌面应用
```

Rust 侧（workspace 根目录）：

```powershell
cargo build
cargo test
```

## 构建与打包

| 命令 | 作用 |
| --- | --- |
| `pnpm app:build` | 编译 + 自动打包（生成开发包与发布包） |
| `pnpm app:package` | 只打包不编译（使用现有编译产物） |
| `pnpm clean` | 清理编译中间产物与最终产物（保留活动数据与依赖目录） |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `VITE_HP_UI` | 前端 UI 变体：`app_ui`（默认）/ `test_ui` / `dev_ui`（占位） |
| `HP_MPV_BIN` | mpv 可执行文件路径（优先于 `external-cli/mpv/`） |
| `HP_MPV_EMBED` | 设为 `1` 时启用主窗口级 mpv 渲染嵌入（仅诊断用） |
| `HP_TEST_VIDEO` | 媒体测试用的视频文件路径 |

## 质量门禁

`tools/` 下提供一系列门禁脚本（`node tools/<脚本>.mjs`），大部分已接入 `pnpm check:*`：

- `check:encoding` —— 文本文件必须 UTF-8 无 BOM、统一 LF
- `check:commands` —— 命令 / 事件契约双向守护（前端封装与后端命令一致性）
- `check:hidden-console` —— 外部子进程不得新建控制台窗口（GUI 桌面壳下的 cmd 弹窗，缺陷 0020）
- `check:event-names` —— 事件名唯一收发口：逻辑名点分、线上名冒号分（Tauri 2 不接受点号，缺陷 0022）
- `check:types` —— `hp-dto` 生成类型与 `packages/shared-types` 一致性
- `check:panels` / `check:settings` / `check:layouts` —— 面板、设置项与布局结构完整性
- `check:blueprint-*` / `check:controls` —— 事件蓝图引擎各维度行为检查
- `check:line-count` / `check:status` / `check:doc-status` —— 结构与文档状态对账
- `tools/tagdict/` —— tag 词库数据管线

## 文档

- `docs/spec/` —— 各域规范（含 `shared-types.md`，跨层类型事实源）
- `docs/rfc/` —— 已确认的决策记录
- `docs/architecture/` —— 架构入口文档（`overview.md`、`decision-checklist.md`、`file-structure.md`）
- `docs/图片管理.md` —— 产品定位简述

## 外部依赖

- **ffmpeg**：`external-cli/ffmpeg/` 随仓库分发，无需额外下载
- **mpv**（可选）：libmpv 播放路径需要 mpv Windows 构建（约 100MB+），请自行下载并放入 `external-cli/mpv/mpv.exe`，或通过环境变量 `HP_MPV_BIN` 指定路径；缺失 mpv 不影响现有播放功能

## 贡献

欢迎提交 Issue 与 Pull Request。请遵守以下约定：

- 文本文件一律 **UTF-8 无 BOM、LF 行尾**（`.gitattributes` + `pnpm check:encoding` 门禁）
- `Cargo.lock` / `pnpm-lock.yaml` 随仓库提交
- 提交前运行 `pnpm typecheck` 与相关 `pnpm check:*` 门禁

## 许可证

[GNU General Public License v3.0](LICENSE)
