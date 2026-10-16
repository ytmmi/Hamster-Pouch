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
- **图书预览**：**"书"**（epub / txt / md / **pdf**）入库（算内容哈希、不产出视觉派生）与图书预览面板（卡片 / 列表 / 封面三视图；EPUB 作者 / 简介 / 内嵌封面、**PDF 封面 = 第一页**经 `book.meta` 解析；封面可右键换成指定颜色或自定义图片；**标记**可右键增删——标记是**可多值、与类目正交**的维度，如 `book` / `manga`）
- **正文查看**：查看器可直接阅读 txt / md / epub / **pdf** 的开头内容（txt 自动判定 GBK / UTF-8 编码；**md 渲染成排版正文**——完整 CommonMark + GFM 语法，标题 / 列表 / 引用 / 代码块 / 表格 / 任务列表 / 脚注 / 定义列表；epub 含章节文字与插图；**pdf 逐页栅格化为整页图片**，版式（分栏 / 表格 / 乐谱）所见即原貌；文本类按面板宽度自适应单栏 / 双栏，**PDF 恒单栏**），滚动时按需取下一页
- **图书阅读器**：**完整阅读**一本"书"（txt / md / epub / pdf）——**目录跳转**（EPUB 取 nav / NCX，**txt 按内置小说章节规则识别**，md 取标题）、**12 项阅读选项**（翻页方式 / 背景与文字配色 / 字号 / 行距 / 页边距 / 页宽 / 字间距 / 段间距 / 亮度 / 字体 / 对齐，落库到面板设置）、三种翻页方式（滚动 / 单页 / 双页）、底部进度（当前进度 / 页数 / 章节数）；右上角**「更多」矢量图标**展开内置面板（目录 / 书签 / 笔记 / 高亮 / 阅读选项）。**书签 / 笔记 / 高亮落库**（仓库库 `reader_annotations` 表，迁移 0011），点一条即跳回那一处
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
| `hp-store` | SQLite 访问、迁移、事务，仓库库 / 全局库 / 词库边界（仓库库当前版本 11） |
| `hp-scanner` | 媒体源扫描、变更检测、索引任务，媒体类型判定 |
| `hp-hash` | BLAKE3 内容哈希、dHash 感知哈希、算法版本记录 |
| `hp-album` | 相册同步规则与成员维护 |
| `hp-fsops` | 源间复制 / 剪切 / 移动，操作记录与元数据保留 |
| `hp-media` | 媒体子进程管理、播放控制、ffprobe 元数据、ffmpeg 抽帧 |
| `hp-book` | 电子书解析：EPUB 元数据 / 内嵌封面（自实现最小 ZIP + flate2，不引入 `zip` crate）；正文读取（txt 编码判定与分页、EPUB 章节 XHTML → 类型化块、**Markdown → 同一套类型化块**）；**目录解析**（EPUB 的 nav / NCX、**txt 小说章节规则**、Markdown 标题） |
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

打包产物（都在 `apps/desktop/src-tauri/target/release/` 下）都是**自包含文件夹**：

```text
dev\dev-<时间戳>\   exe + data\（含用户数据）+ external-cli\ + plugins\system\ + plugins-dist\
release\            exe + data\system\（系统库）+ data\plugins\（系统插件）+ external-cli\ + plugins\system\
                    （不含用户数据）
```

- **随包运行时资产**：`external-cli\`（ffmpeg 运行时子集，约 168 MB）与 `plugins\system\`
  都放在 **exe 同级**，与仓库内布局同构 ⇒ 运行时从 exe 目录**第一跳**即命中，
  **整夹搬走仍可用**（D14 的"随应用捆绑发布"）。dev 包用 NTFS 硬链接（零额外磁盘占用），
  release 包真实复制。回归门禁：`pnpm check:bundled-runtime`。
- ffmpeg 只带**运行时子集**：`bin\` 下两个 exe + 全部 DLL + `LICENSE.txt`；
  `ffplay.exe`、`doc\`、`include\`、`lib\`、`presets\` 不带（省约 31 MB）。
  **`bin\` 下的 DLL 一个都不能省**（两个 exe 静态绑定全部 av* DLL）。
- **mpv 是可选资产**（约 119 MB）：**存在则入包、缺失则跳过并说明**。
  因为 `external-cli/mpv/` **不入 git 库**，新克隆里必然没有它——做成硬失败会让
  `pnpm app:build` 在新克隆上直接断掉。**"不入库"与"能否进构建包"是两件事**：
  打包脚本从本地磁盘复制、不读 git，所以本机有 mpv 时它就会进包。

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
- `check:bundled-runtime` —— 随应用捆绑的 ffmpeg 运行时子集与 `plugins/system` 真的进包（D14）
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

- **ffmpeg**：`external-cli/ffmpeg/` 随仓库分发，无需额外下载；打包时复制到产物内
  **exe 同级**（运行时子集，见「构建与打包」），因此打包产物不依赖仓库目录、可整夹搬走
- **mpv**（可选）：libmpv 播放路径需要 mpv Windows 构建（约 100MB+），请自行下载并放入 `external-cli/mpv/mpv.exe`，或通过环境变量 `HP_MPV_BIN` 指定路径；缺失 mpv 不影响现有播放功能。
  **本目录不入 git 库**（100 MB+ 二进制不进版本库），但**只要本机存在就会随包分发**——
  打包脚本从本地磁盘复制，与入库与否无关（见「构建与打包」）。
  注：播放器面板已改 DOM `<video>`、libmpv 路径休眠（`docs/rfc/0005-media-capabilities.md`），
  当前产品界面不调用 mpv。

## 贡献

欢迎提交 Issue 与 Pull Request。请遵守以下约定：

- 文本文件一律 **UTF-8 无 BOM、LF 行尾**（`.gitattributes` + `pnpm check:encoding` 门禁）
- `Cargo.lock` / `pnpm-lock.yaml` 随仓库提交
- 提交前运行 `pnpm typecheck` 与相关 `pnpm check:*` 门禁

## 许可证

[GNU General Public License v3.0](LICENSE)
