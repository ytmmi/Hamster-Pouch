//! 应用数据目录、内置资源与外部二进制的定位（含向上查找仓库内布局的启发式）。

use super::prelude::*;
use super::response::{ApiResponse, api_from_hp};

/// 应用数据根目录（便携布局）：可执行文件同目录下的 `data` 子文件夹。
///
/// 全部数据集中在这里，按三类区分（2026-09 用户裁定）：
/// - **系统数据库**：`data\system\`——全局配置库（`hamster-pouch-global.sqlite3`）与内置
///   tag 库（RFC 0008 四库，内置基底 `data\system\tag_lib_base.sqlite3`，
///   完整词库为按需安装的 `plugins-dist/tagdict-*` / `tagrel-*` 扩展包，D36.5）；
///   应用自身数据，随版本/可重建。
/// - **用户数据库**：`data\user\repos\`——每仓库一个库，用户 tag / 评分 / 相册等，需备份。
/// - **用户封面**：`data\user\covers\`——用户自选的自定义封面图片（`book.setCover`，
///   用户口径 2026-10-09）。与仓库库同在 `user\` 下：它是**用户数据**而不是可重建的缓存
///   （放 `thumbnails\` 会被当缓存清掉，放 `system\` 又会进发布包）。文件名是
///   `<file_id>.<ext>`；仓库库里 `file_covers.value` **只存这个裸文件名**，不存绝对路径
///   （位置随安装目录变，存了会在换位置后全失效）。
/// - **插件扩展**：`data\plugins\`——插件包安装目录；插件自持的扩展数据库落在各自
///   `<plugin_id>\` 包目录内，不入全局库/仓库库。
/// - 缓存与日志：`data\thumbnails\`（可重建）、`data\debug.log`。
///
/// **不使用** `%APPDATA%`（Roaming：域/漫游环境会随登录同步，对 WAL SQLite 有损坏风险，
/// 见 `docs/issues/0012`）与 `%LOCALAPPDATA%`；旧位置数据由用户验证后手动处理。
pub(crate) fn app_data_root() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or_else(|| "无法确定可执行文件目录".to_string())?;
    Ok(exe_dir.join("data"))
}

/// 开发期诊断日志：追加一行到 `<exe 同目录>\data\debug.log`。
///
/// 用途：在**打包运行**（无 devtools）时定位前端链路问题；文件位置固定、可直接查看，
/// 不属于业务数据。仅诊断场景由前端调用。
///
/// **D76**：本命令是**新增/新增式**诊断通道，按新口径返回 `{ ok, data?, error? }`
/// （`data` 为 `null`）。它不属于业务命令，不进 `commands-events.md` §3 的业务表。
#[tauri::command]
pub(crate) fn debug_log(message: String) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        use std::io::Write;
        let dir = app_data_root().map_err(HpError::Io)?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| HpError::Io(format!("创建应用数据目录失败: {e}")))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("debug.log"))
            .map_err(|e| HpError::Io(format!("打开诊断日志失败: {e}")))?;
        writeln!(file, "{message}").map_err(|e| HpError::Io(format!("写入诊断日志失败: {e}")))
    })();
    api_from_hp(outcome)
}

/// 系统数据库：全局配置库文件路径（`<exe 同目录>\data\system\` 下）。
pub(crate) fn global_db_path() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("system");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建系统数据库目录失败: {e}"))?;
    Ok(dir.join("hamster-pouch-global.sqlite3"))
}

/// 内置 tag 基底库文件路径（`<exe 同目录>\data\system\` 下）。
///
/// 由 `tools/tagdict/build_base_lib.py` 生成（RFC 0008 / D36 第一层，约 12MB），
/// 随发布包/开发包分发。**完整词库不随应用分发**，按需安装 `plugins-dist/` 下的
/// 细分扩展包（`tagdict-pixiv` / `tagdict-danbooru` / `tagrel-games`）。
pub(crate) fn tag_lib_base_path() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("system");
    Ok(dir.join("tag_lib_base.sqlite3"))
}

/// 用户数据库：默认仓库库目录（`<exe 同目录>\data\user\repos\`）。
pub(crate) fn default_repo_dir() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("user").join("repos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    Ok(dir)
}

/// 用户**自定义封面**目录（`<exe 同目录>\data\user\covers\`）。
///
/// 为什么放 `user\`：这是**用户数据**（用户自己挑的图片），不是可重建的缓存——
/// 放 `thumbnails\` 会被当缓存清掉，放 `system\` 又会进发布包（那是应用自身数据）。
/// 按 `data\user\` 的既定口径，它随开发包整体带走、**不进发布包**
/// （`tools/package-build.mjs` 排除整个 `user\`）。
pub(crate) fn user_covers_dir() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("user").join("covers");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建封面目录失败: {e}"))?;
    Ok(dir)
}

/// 从工作目录与可执行文件目录出发，逐级向上查找仓库内相对路径（如 `external-cli/...`）。
///
/// 为什么必须向上找：开发期 `tauri dev` 以 `apps/desktop/src-tauri` 为工作目录运行二进制，
/// 打包后通常以 exe 所在目录为工作目录，而 `external-cli/` 位于仓库根 / exe 同级。
/// 只按 cwd 拼一次相对路径会让两种布局**都**解析失败（表现为「未找到 mpv 可执行文件」）。
pub(super) fn find_upwards(relative: &str) -> Option<PathBuf> {
    find_upwards_matching(relative, |p| p.is_file())
}

/// 同 [`find_upwards`]，但判据是**目录**（随包插件是目录，用文件判据永远找不到）。
pub(super) fn find_upwards_dir(relative: &str) -> Option<PathBuf> {
    find_upwards_matching(relative, |p| p.is_dir())
}

/// 逐级向上查找的公共实现：`roots` 依次为工作目录与可执行文件目录，各自向上遍历祖先。
pub(super) fn find_upwards_matching(
    relative: &str,
    matches: impl Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        roots.push(dir.to_path_buf());
    }
    for root in roots {
        for dir in root.ancestors() {
            let candidate = dir.join(relative);
            if matches(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// 随应用分发的 **system 插件包根目录**（仓库内是 `plugins/system`）。
///
/// 解析顺序与 [`external_bin_path`] 一致：环境变量 `HP_BUNDLED_PLUGINS_DIR` 优先
/// （一旦设置即原样采信，不因目录不存在而静默回退——"路径写错"应在使用处如实报错），
/// 否则自工作目录 / 可执行文件目录逐级向上查找。
///
/// **打包边界（本轮未落地）**：`apps/desktop/src-tauri/tauri.conf.json` 目前**没有**
/// `bundle.resources` 声明，打包产物里**不包含** `plugins/system`。因此本函数只解析
/// 开发期/仓库内布局；随包分发需另补 `bundle.resources`，见
/// `docs/spec/commands-events.md` §3.11 `plugin.installBundled` 的备注。
pub(crate) fn bundled_plugins_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HP_BUNDLED_PLUGINS_DIR") {
        return Some(PathBuf::from(p));
    }
    find_upwards_dir("plugins/system")
}

/// 解析随应用发布的外部 CLI 路径：环境变量优先，其次按 `relative` 向上查找。
///
/// 环境变量一旦设置即**原样采信**（不因文件不存在而静默回退），
/// 这样「路径写错」会在使用处如实报错，而不是悄悄换用另一个二进制。
pub(crate) fn external_bin_path(env_key: &str, relative: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(env_key) {
        return Some(PathBuf::from(p));
    }
    find_upwards(relative)
}

/// 解析外部 CLI 可执行文件路径：环境变量优先，其次项目内 `external-cli/`。
pub(crate) fn external_bin(name: &str) -> Option<PathBuf> {
    let env_key = if name == "ffmpeg" {
        "HP_FFMPEG_BIN"
    } else {
        "HP_FFPROBE_BIN"
    };
    external_bin_path(env_key, &format!("external-cli/ffmpeg/bin/{name}.exe"))
}
