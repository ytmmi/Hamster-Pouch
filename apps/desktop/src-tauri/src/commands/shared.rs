//! 命令桥接层共享工具与类型（供各 `*_commands` 模块复用）。

use std::path::PathBuf;

use hp_core::{FileIndexRow, HpError, HpResult};
use hp_store::{GlobalDb, RepoDb};
use serde::Serialize;

use crate::AppState;

/// **D76 迁移已完成（2026-09）**：桥接层不再需要"把领域错误压成 String"的转换函数。
///
/// 历史上这里是 `hp_err_to_string(e)`，D76 让每条命令都返回 `{ ok, data?, error? }`
/// 并携带 `HpError::code()` 的闭集错误码，因此该函数在 2026-09 最后一批
/// （`repo` / `layout` / `debug.log`）迁移完成后**已无调用方**并删除。
/// 新增命令一律走 [`api_from_hp`] / [`api_async`]；错误文案由前端按 `code` 走 i18n（D27）。

/// **D76 统一响应包装**：`{ ok, data?, error? }`（`docs/spec/commands-events.md` 第 2 节）。
///
/// 全部命令**必须**用这个形状（2026-09 起已全量迁移，无一例外）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

/// **D76 结构化错误**。
///
/// `code` 取闭集 `validation` / `not_found` / `permission` / `plugin` / `io` / `conflict`
/// （来源是 `HpError::code()`）。`message` **仅作诊断**：前端不得直接显示，
/// 必须按 `code` 渲染 i18n 文案（D27：三套语言）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ApiError {
    /// 直接以码 + 诊断串构造（用于**不是** `HpError` 来源的失败，例如桥接层的
    /// 前置条件检查；领域错误一律走 [`ApiError::from_hp`]）。
    #[allow(dead_code)]
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// 领域错误 → 结构化错误（`code` 由 `HpError::code()` 统一给出）。
    pub(crate) fn from_hp(e: HpError) -> Self {
        Self {
            code: e.code().to_string(),
            message: e.to_string(),
            details: None,
        }
    }
}

/// 成功响应。
pub(crate) fn api_ok<T>(data: T) -> ApiResponse<T> {
    ApiResponse {
        ok: true,
        data: Some(data),
        error: None,
    }
}

/// 失败响应。
pub(crate) fn api_err<T>(error: ApiError) -> ApiResponse<T> {
    ApiResponse {
        ok: false,
        data: None,
        error: Some(error),
    }
}

/// `HpResult<T>` → 统一响应包装。
pub(crate) fn api_from_hp<T>(result: HpResult<T>) -> ApiResponse<T> {
    match result {
        Ok(value) => api_ok(value),
        Err(e) => api_err(ApiError::from_hp(e)),
    }
}

/// **异步命令**的返回包装。
///
/// Tauri 的 `#[tauri::command]` 对**含引用的 `async` 命令**（例如带 `State<'_, T>`）
/// 强制要求返回 `Result`（tauri-macros 的 `AsyncCommandMustReturnResult`）。
///
/// 但 D76 的包装必须落在**成功值**里：失败也是"已解析的响应"，而不是 IPC 层拒绝——
/// 这样前端只需一套 `unwrapApi`，错误码（`validation`/`not_found`/…）不会在
/// IPC 边界被压成字符串。因此本类型**恒为 `Ok(..)`**，失败信息放在
/// `ApiResponse.error` 里（`Err` 分支仅为满足宏约束而存在，不被构造）。
pub(crate) type ApiAsync<T> = Result<ApiResponse<T>, ApiResponse<T>>;

/// 把统一响应装进异步命令的返回类型（见 [`ApiAsync`]）。
pub(crate) fn api_async<T>(response: ApiResponse<T>) -> ApiAsync<T> {
    Ok(response)
}

/// 应用数据根目录（便携布局）：可执行文件同目录下的 `data` 子文件夹。
///
/// 全部数据集中在这里，按三类区分（2026-09 用户裁定）：
/// - **系统数据库**：`data\system\`——全局配置库（`hamster-pouch-global.sqlite3`）与内置
///   tag 库（RFC 0008 四库，内置基底 `data\system\tag_lib_base.sqlite3`，
///   完整词库为按需安装的 `plugins-dist/taglib-*` 扩展包）；
///   应用自身数据，随版本/可重建。
/// - **用户数据库**：`data\user\repos\`——每仓库一个库，用户 tag / 评分 / 相册等，需备份。
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
/// 细分扩展包（`taglib-pixiv` / `taglib-danbooru`）。
pub(crate) fn tag_lib_base_path() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("system");
    Ok(dir.join("tag_lib_base.sqlite3"))
}

/// 装配 `plugins-dist/` 下已安装的 tag 词典扩展包（RFC 0008 / D36 第二层）。
///
/// 每个扩展包是一个目录，内含 `data/tag_lib.sqlite`（四库同构 schema）。
/// 以**只读**方式逐个打开并加入聚合层；顺序为目录名的字典序，即同层内的优先级。
/// 单个包损坏/缺失数据文件时**跳过该包**并继续（不因一个坏包让整个词库不可用）。
///
/// 返回成功装配的扩展包数量。
pub(crate) fn attach_tag_lib_extensions(set: &mut hp_store::TagLibSet) -> usize {
    let Ok(root) = tag_lib_extension_root() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return 0;
    };

    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    let mut attached = 0usize;
    for dir in dirs {
        let db_path = dir.join("data").join("tag_lib.sqlite");
        if !db_path.is_file() {
            continue;
        }
        match hp_store::TagLibDb::open_readonly(&db_path, hp_core::LibLayer::Extension) {
            Ok(db) => {
                set.add(db);
                attached += 1;
            }
            Err(e) => {
                eprintln!(
                    "[taglib] 跳过扩展包 {}（打开失败）: {e}",
                    dir.display()
                );
            }
        }
    }
    attached
}

/// tag 词典扩展包的存放根目录（`<exe 同目录>\plugins-dist\`）。
///
/// 与开发期仓库根的 `plugins-dist/` 同名：开发包把它放在 exe 同级，
/// 因此这里只需在 exe 目录下找；找不到时回退向上查找（`tauri dev` 场景）。
fn tag_lib_extension_root() -> Result<PathBuf, String> {
    if let Ok(dir) = app_data_root() {
        if let Some(exe_dir) = dir.parent() {
            let candidate = exe_dir.join("plugins-dist");
            if candidate.is_dir() {
                return Ok(candidate);
            }
        }
    }
    // 开发期：从 exe 目录向上找仓库根的 plugins-dist/
    find_upwards_matching("plugins-dist", |p| p.is_dir())
        .ok_or_else(|| "未找到 plugins-dist 目录".to_string())
}

/// 用户数据库：默认仓库库目录（`<exe 同目录>\data\user\repos\`）。
pub(crate) fn default_repo_dir() -> Result<PathBuf, String> {
    let dir = app_data_root()?.join("user").join("repos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    Ok(dir)
}

/// 从工作目录与可执行文件目录出发，逐级向上查找仓库内相对路径（如 `external-cli/...`）。
///
/// 为什么必须向上找：开发期 `tauri dev` 以 `apps/desktop/src-tauri` 为工作目录运行二进制，
/// 打包后通常以 exe 所在目录为工作目录，而 `external-cli/` 位于仓库根 / exe 同级。
/// 只按 cwd 拼一次相对路径会让两种布局**都**解析失败（表现为「未找到 mpv 可执行文件」）。
fn find_upwards(relative: &str) -> Option<PathBuf> {
    find_upwards_matching(relative, |p| p.is_file())
}

/// 同 [`find_upwards`]，但判据是**目录**（随包插件是目录，用文件判据永远找不到）。
fn find_upwards_dir(relative: &str) -> Option<PathBuf> {
    find_upwards_matching(relative, |p| p.is_dir())
}

/// 逐级向上查找的公共实现：`roots` 依次为工作目录与可执行文件目录，各自向上遍历祖先。
fn find_upwards_matching(
    relative: &str,
    matches: impl Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
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

/// 懒加载全局配置库。
pub(crate) fn ensure_global(state: &AppState, _app: &tauri::AppHandle) -> HpResult<()> {
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    if guard.is_none() {
        let path = global_db_path().map_err(HpError::Io)?;
        *guard = Some(GlobalDb::open(&path)?);
    }
    Ok(())
}

/// 锁住全局库（毒锁 → `Store`）。调用前先 `ensure_global`。
pub(crate) fn lock_global(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<GlobalDb>>> {
    state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))
}

/// 取全局库（未初始化 → `not_found`：全局库还没打开）。
pub(crate) fn global<'g, 'a>(
    guard: &'g std::sync::MutexGuard<'a, Option<GlobalDb>>,
) -> HpResult<&'g GlobalDb> {
    guard
        .as_ref()
        .ok_or_else(|| HpError::NotFound("全局库未初始化".into()))
}

/// 同 [`global`]，可变借用（写操作）。
pub(crate) fn global_mut<'g, 'a>(
    guard: &'g mut std::sync::MutexGuard<'a, Option<GlobalDb>>,
) -> HpResult<&'g mut GlobalDb> {
    guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("全局库未初始化".into()))
}

/// 解析文件绝对路径：源本地路径 + 相对路径。
pub(crate) fn resolve_file_path(db: &RepoDb, file: &FileIndexRow) -> HpResult<PathBuf> {
    let source = db
        .get_source(file.source_id.as_str())?
        .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {}", file.source_id.as_str())))?;
    Ok(PathBuf::from(source.local_path).join(&file.relative_path))
}

// ===== 打开的仓库库：批次迁移共用的取用/加锁助手（D76）=====

/// 未打开仓库 → `HpError::NotFound`（"目标上下文不存在"）。
///
/// `HpError::code()` 的闭集里没有"前置条件"这一类，最贴近的是 `not_found`：
/// 请求要作用的仓库上下文不存在。**不要**把它写成 `Store`/`Io`——那会把
/// "用户还没打开仓库"误报成读写故障。
pub(crate) fn open_repo<'g, 'a>(
    guard: &'g std::sync::MutexGuard<'a, Option<RepoDb>>,
) -> HpResult<&'g RepoDb> {
    guard
        .as_ref()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}

/// 同 [`open_repo`]，可变借用（写操作）。
pub(crate) fn open_repo_mut<'g, 'a>(
    guard: &'g mut std::sync::MutexGuard<'a, Option<RepoDb>>,
) -> HpResult<&'g mut RepoDb> {
    guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}

/// 锁住 `open_repo`（毒锁 → `Store`）。
pub(crate) fn lock_repo(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<RepoDb>>> {
    state
        .open_repo
        .lock()
        .map_err(|_| HpError::Store("仓库锁中毒".into()))
}

/// 相册成员 / 文件查询返回项。
#[derive(Serialize)]
pub(crate) struct AlbumFileItem {
    pub(crate) id: String,
    pub(crate) source_id: String,
    pub(crate) relative_path: String,
    pub(crate) media_type: String,
    pub(crate) size: i64,
    pub(crate) mtime: String,
}

/// 文件索引行 → 返回项。
pub(crate) fn file_to_item(f: FileIndexRow) -> AlbumFileItem {
    AlbumFileItem {
        id: f.id.as_str().to_string(),
        source_id: f.source_id.as_str().to_string(),
        relative_path: f.relative_path,
        media_type: f.media_type.as_str().to_string(),
        size: f.size,
        mtime: f.mtime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开发期的工作目录就是本 crate（`cargo test` 与 `tauri dev` 都是
    /// `apps/desktop/src-tauri`）——正是旧实现只按 cwd 拼相对路径时解析失败的目录。
    ///
    /// **缺失即跳过**：`external-cli/mpv/` 因体积过大**不入库**（见根 `README.md`
    /// 「外部依赖」），因此全新克隆上该文件必然不存在——此处不能硬断言。
    /// 判据与 `crates/hp-media/tests/player_lifecycle.rs` 同口径（缺失时打印跳过）。
    /// 查找逻辑本身的覆盖不依赖本用例：同模块的 `find_upwards_finds_ffmpeg` 用
    /// **随仓库分发**的 ffmpeg 覆盖同一条代码路径。
    #[test]
    fn find_upwards_finds_repo_relative_mpv() {
        let Some(found) = find_upwards("external-cli/mpv/mpv.exe") else {
            eprintln!("跳过：未找到 external-cli/mpv/mpv.exe（该目录不入库，见根 README「外部依赖」）");
            return;
        };
        assert!(found.is_file());
        let normalized = found.to_string_lossy().replace('\\', "/");
        assert!(
            normalized.ends_with("external-cli/mpv/mpv.exe"),
            "意外路径: {normalized}"
        );
    }

    /// 同一套查找也要能命中 ffmpeg/ffprobe（旧实现同样只按 cwd 拼相对路径）。
    #[test]
    fn find_upwards_finds_ffmpeg() {
        let found = find_upwards("external-cli/ffmpeg/bin/ffmpeg.exe")
            .expect("应从祖先目录找到 external-cli/ffmpeg/bin/ffmpeg.exe");
        assert!(found.is_file());
    }

    #[test]
    fn find_upwards_returns_none_for_unknown_relative_path() {
        assert!(find_upwards("external-cli/definitely-missing/nope.exe").is_none());
    }

    /// 随包插件根是**目录**：必须用目录判据，文件判据永远找不到它。
    #[test]
    fn find_upwards_dir_finds_the_bundled_plugin_root() {
        let found =
            find_upwards_dir("plugins/system").expect("应从祖先目录找到仓库内的 plugins/system");
        assert!(found.is_dir());
        assert!(found.join("palette").join("plugin.manifest").is_file());
        let normalized = found.to_string_lossy().replace('\\', "/");
        assert!(
            normalized.ends_with("plugins/system"),
            "意外路径: {normalized}"
        );
    }

    /// 同一条相对路径上，文件判据与目录判据结论相反——这正是"随包插件用错判据"的形态。
    #[test]
    fn file_and_dir_lookups_disagree_on_a_directory() {
        assert!(find_upwards("plugins/system").is_none());
        assert!(find_upwards_dir("plugins/system").is_some());
    }

    /// 显式环境变量覆盖优先于自动查找（且不做存在性回退）。
    #[test]
    fn env_override_wins_over_lookup() {
        let key = "HP_TEST_EXTERNAL_BIN_OVERRIDE";
        std::env::set_var(key, "Z:/explicit/override.exe");
        let got = external_bin_path(key, "external-cli/ffmpeg/bin/ffmpeg.exe");
        std::env::remove_var(key);
        assert_eq!(got, Some(PathBuf::from("Z:/explicit/override.exe")));
    }

    /// 随包插件根同样支持环境变量覆盖，且同样是"设置了就原样采信"。
    #[test]
    fn bundled_plugins_dir_honours_env_override() {
        let key = "HP_BUNDLED_PLUGINS_DIR";
        std::env::set_var(key, "Z:/explicit/bundled");
        let got = bundled_plugins_dir();
        std::env::remove_var(key);
        assert_eq!(got, Some(PathBuf::from("Z:/explicit/bundled")));
    }
}
