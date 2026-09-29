# 仓鼠颊（Hamster Pouch）

仓鼠颊是一个**本地资源管理软件**（Windows 平台）：对图片、视频、音频、文本、绿色版程序等本地资源进行入库、索引、标签、评分、播放与管理。

以「仓库 / 媒体源 / 相册」为组织模型：把本地文件夹作为媒体源扫描入库，支持虚拟相册、内容去重与变更检测、AI 辅助打标、插件扩展与事件蓝图自动化。

## 功能特性

- **资源管理**：图片 / 视频 / 音频 / 文本 / 绿色版程序（非安装程序）的统一入库与管理
- **仓库与媒体源**：多仓库、多媒体源扫描、变更检测与索引任务；媒体类型判定（扩展名优先 + 内容兜底）
- **哈希与去重**：BLAKE3 内容哈希 + dHash 感知哈希（`hp-hash`），支持去重、变更识别与哈希算法版本记录
- **相册**：固定相册、跟随源同步规则、成员维护（`hp-album`）
- **标签与评分**：仓库内 tag / 评分体系，来源、置信度与生成时间可追溯
- **AI 打标**：可插拔的 AI 打标提供方、任务队列与结果回写（`hp-ai`）；高置信度覆盖用户 tag 时生成撤销记录
- **媒体能力**：ffprobe 元数据探测、ffmpeg 抽帧缩略图与缓存、媒体预览与播放器面板
- **文件操作**：源间复制 / 剪切 / 移动并生成操作记录；内容哈希一致时保留 tag、评分、相册成员关系（`hp-fsops`）
- **插件系统**：插件包发现、安装、信任与能力校验（`hp-plugin-host`，RFC 0004）；内置 system 插件与示例
- **事件蓝图**：控件事件作为蓝图事件源的自动化框架（含独立检查工具链）
- **多语言 UI**：简体中文（默认）/ 繁體中文 / English，dockview 可停靠面板布局

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust），应用标识 `dev.hamsterpouch.desktop` |
| 前端 | React 18 + TypeScript + Vite 5 + dockview（面板布局） |
| 后端 | Cargo workspace（10 个 crate，edition 2021） |
| 数据 | SQLite（`hp-store`：访问、迁移、事务、仓库库 / 全局库 / 词库边界） |
| 包管理 | pnpm workspace（`apps/*`、`packages/*`）+ Cargo |

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `apps/desktop` | Tauri 桌面应用（前端 `src/` + 宿主 `src-tauri/`） |
| `apps/desktop/src/app_ui` | 正式生产 UI（默认），dockview 面板系统 |
| `apps/desktop/src/test_ui` | 命令/事件测试用 UI |
| `apps/desktop/src/dev_ui` | 开发调试 UI（预留占位） |
| `packages/` | 前端共享包：`config`、`ui`、`shared-types` |
| `crates/` | Rust 核心库（见下表） |
| `plugins/` | 插件：`system/`（palette、python-core）、`examples/` |
| `external-cli/` | 外部 CLI：ffmpeg 随仓库分发；mpv 需自行下载（见下） |
| `tools/` | 门禁与数据管线脚本（`check-*.mjs`、`tagdict/` 等） |
| `docs/` | 本地规划资料（RFC / spec / roadmap / issues，**不入库**，见 `.gitignore`） |

Rust crates：

| crate | 职责 |
| --- | --- |
| `hp-core` | 领域模型（仓库、媒体源、虚拟相册、图像、tag、评分），纯净无外部依赖 |
| `hp-store` | SQLite 访问、迁移、事务，仓库库 / 全局库 / 词库边界 |
| `hp-scanner` | 媒体源扫描、变更检测、索引任务，媒体类型判定 |
| `hp-hash` | BLAKE3 内容哈希、dHash 感知哈希、算法版本记录 |
| `hp-album` | 相册同步规则与成员维护 |
| `hp-fsops` | 源间复制 / 剪切 / 移动，操作记录与元数据保留 |
| `hp-media` | 媒体子进程管理（libmpv）、播放控制、ffprobe 元数据、ffmpeg 抽帧 |
| `hp-ai` | AI 打标提供方抽象、任务队列与结果回写 |
| `hp-plugin-host` | 插件发现、安装、信任与能力校验、生命周期框架 |
| `hp-dto` | 跨层 DTO 单一事实来源（前端 `shared-types` 由其生成） |

## 环境要求

- Windows 10/11（含 WebView2 运行时）
- Rust 工具链（edition 2021）
- Node.js + pnpm
- 外部 CLI：
  - `external-cli/ffmpeg/` —— 随仓库分发，无需额外下载
  - **mpv —— 需自行下载**（见「外部依赖」）

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
pnpm build            # vite build
pnpm typecheck        # tsc --noEmit
pnpm tauri build      # 打包桌面应用
```

Rust 侧（workspace 根目录）：

```powershell
cargo build
cargo test
```

> 行尾规范：文本文件一律 LF、不带 BOM（`.gitattributes` + `tools/check-encoding.mjs` 门禁）；
> `Cargo.lock` / `pnpm-lock.yaml` 随仓库提交。
>
> **⚠️ 改了 `crates/**` 必须重启 `pnpm tauri dev`**：dev 进程只监听
> `apps/desktop/src-tauri`（启动日志里的 `Watching …src-tauri for changes`），
> `crates/**` 的改动**不会**触发 Rust 重编。设置声明、命令、DTO 等的宿主侧镜像都在
> `crates/` 里，只热更新前端会出现一种假象——**界面已经有新设置项，写进去却被后端按
> "未知设置键"拒掉**（开关弹回去、下拉改不动），看起来像前端 bug，其实是后端二进制还是旧的。

## 外部依赖：mpv（需自行下载）

> **⚠️ 只有休眠的 libmpv 路径需要 mpv —— 日常使用不需要。**
> 自 2026-09 起播放器面板改走 **DOM `<video>`**（缺陷 `docs/issues/0001` 的修复），
> `media.*` 这组命令在正式界面 `apps/desktop/src/app_ui` 里**没有任何调用方**
> （唯一调用方是 dev harness `apps/desktop/src/test_ui`）。本节记录的是**已休眠**的
> libmpv 原生窗口路径，供将来复活时参考；**缺失 mpv 不影响现有播放功能**。

libmpv 路径需要 **mpv Windows 构建**（`mpv.exe` 及配套 DLL，约 100MB+）。因其体积过大无法随仓库上传，
`external-cli/mpv/` 已被 `.gitignore` 排除，**不会随代码仓库分发**，需要自行下载。

1. 从 mpv 官网安装说明页获取 Windows 构建：<https://mpv.io/installation/>
   （常见社区构建：[mpv-player-windows](https://sourceforge.net/projects/mpv-player-windows/files/)、
   [mpv-winbuild-cmake 构建](https://github.com/shinchiro/mpv-winbuild-cmake/releases)），选择 **x86_64 Windows** 版。
2. 解压后把 `mpv.exe`（以及构建附带的 `d3dcompiler_43.dll` 等文件）放入：

   ```
   external-cli/mpv/mpv.exe
   ```

3. 程序会在工作目录、各级父目录与可执行文件所在目录逐级向上查找 `external-cli/mpv/mpv.exe`
   （`tauri dev` 与打包后的布局都能命中）。

备选：设置环境变量 `HP_MPV_BIN` 直接指定 mpv 可执行文件路径（优先级最高）：

```
set HP_MPV_BIN=D:\path\to\mpv.exe
```

两者都未提供时，`media.*` 命令会返回「未找到 mpv 可执行文件」的错误提示
（正式界面不调用这些命令，因此**不影响**现有播放功能）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `VITE_HP_UI` | 前端 UI 变体：`app_ui`（默认）/ `test_ui` / `dev_ui`（占位） |
| `HP_MPV_BIN` | mpv 可执行文件路径（优先于 `external-cli/mpv/`） |
| `HP_MPV_EMBED` | 设为 `1` 时启用主窗口级 mpv 渲染嵌入（仅诊断用） |
| `HP_TEST_VIDEO` | 媒体测试用的视频文件路径 |

## 质量门禁

`tools/` 下提供一系列门禁脚本（`node tools/<脚本>.mjs`），部分已被 `pnpm check:*` 引用：

- `check-encoding.mjs` —— 文本文件必须 UTF-8 无 BOM、统一 LF（回退即红）
- `check-commands.mjs` —— 命令 / 事件契约双向守护（前端封装与后端命令一致性）
- `check-dormant-media.mjs` —— `media.*`（libmpv）休眠断言守护：保证休眠标注自洽且**正式界面 0 处调用**
- `check-doc-status.mjs`、`check-status.mjs` —— 文档与实现状态对账
- `check-line-count.mjs`、`check-panels.mjs`、`check-settings.mjs` —— 结构与门禁完整性
- `blueprint-*.mjs` —— 事件蓝图引擎各维度的行为检查
- `tools/tagdict/` —— tag 词库数据管线（对照表缓存与生成产物不入库）

## 文档与规范

`docs/` 为本地规划资料，按 `.gitignore` **不入库**，包括：

- `docs/spec/` —— 各域规范（含 `shared-types.md`，与 `crates/hp-dto` 对应的跨层类型事实源）
- `docs/rfc/`、`docs/architecture/` —— 决策记录与架构口径
- `docs/roadmap/`、`docs/issues/` —— 路线图与缺陷登记（登记规范见 `docs/issues/README.md`）
