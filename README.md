# 仓鼠颊（Hamster Pouch）

本地资源管理软件（Windows）：图片、视频、音频、文本、绿色版程序等本地资源的管理与播放。

- 桌面端：Tauri 2 + React（`apps/desktop`），Rust 后端（`crates/`）
- 平台：Windows

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/desktop` | Tauri 桌面应用（前端 + `src-tauri` 宿主） |
| `crates/` | Rust 核心库（媒体、扫描、存储、标签词库等） |
| `external-cli/` | 外部 CLI 工具（部分随仓库分发，mpv 除外，见下） |
| `plugins/` | 插件系统与示例 |
| `docs/` | 本地规划资料（**不入库**，见 `.gitignore`） |

## 外部依赖：mpv（需自行下载）

`external-cli/mpv/` 存放媒体播放所需的 **mpv Windows 构建**（`mpv.exe` 及配套 DLL，约 100MB+）。
因其体积过大无法随仓库上传，该目录已被 `.gitignore` 排除，**不会随代码仓库分发**，需要自行下载。

### 下载与放置

1. 从 mpv 官网的安装说明页获取 Windows 构建：<https://mpv.io/installation/>
   （常见的社区构建：sourceforge 的 [mpv-player-windows](https://sourceforge.net/projects/mpv-player-windows/files/)、
   [shinchiro 的 mpv-winbuild-cmake 构建](https://github.com/shinchiro/mpv-winbuild-cmake/releases)）。
   请选择 **x86_64 Windows** 版本。
2. 解压后，把 `mpv.exe`（以及构建附带的 `d3dcompiler_43.dll` 等文件）放入：

   ```
   external-cli/mpv/mpv.exe
   ```

3. 完成后即可正常使用媒体播放功能。程序会在工作目录、各级父目录与可执行文件所在目录
   逐级向上查找 `external-cli/mpv/mpv.exe`（`tauri dev` 与打包后的布局都能命中）。

### 备选：环境变量 `HP_MPV_BIN`

不想放到上述目录时，可直接设置环境变量指定 mpv 可执行文件路径（优先级最高）：

```
set HP_MPV_BIN=D:\path\to\mpv.exe
```

若两者都未提供，媒体播放命令会返回「未找到 mpv 可执行文件」的错误提示。

> 注：`external-cli/ffmpeg/`（含 `bin/`、`include/`、`doc/`）体积可控，仍随仓库分发，无需自行下载。
