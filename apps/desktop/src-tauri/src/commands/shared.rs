//! 命令桥接层共享工具与类型（供各 `*_commands` 模块复用）。

use std::path::PathBuf;

use hp_core::{FileIndexRow, HpError, HpResult};
use hp_store::{GlobalDb, RepoDb};
use serde::Serialize;
use tauri::Manager;

use crate::AppState;

/// 统一把领域错误转为前端可见字符串。
pub(crate) fn hp_err_to_string(e: HpError) -> String {
    e.to_string()
}

/// 开发期诊断日志：追加一行到应用数据目录 `debug.log`。
///
/// 用途：在**打包运行**（无 devtools）时定位前端链路问题；文件位置固定、可直接查看，
/// 不属于业务数据。仅诊断场景由前端调用。
#[tauri::command]
pub(crate) fn debug_log(message: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::io::Write;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("debug.log"))
        .map_err(|e| format!("打开诊断日志失败: {e}"))?;
    writeln!(file, "{message}").map_err(|e| format!("写入诊断日志失败: {e}"))
}

/// 全局配置库文件路径（应用数据目录下）。
pub(crate) fn global_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    Ok(dir.join("hamster-pouch-global.sqlite3"))
}

/// 默认仓库库目录（应用数据目录下 `repos/`）。
pub(crate) fn default_repo_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("repos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    Ok(dir)
}

/// 从工作目录与可执行文件目录出发，逐级向上查找仓库内相对路径（如 `external-cli/...`）。
///
/// 为什么必须向上找：开发期 `tauri dev` 以 `apps/desktop/src-tauri` 为工作目录运行二进制，
/// 打包后通常以 exe 所在目录为工作目录，而 `external-cli/` 位于仓库根 / exe 同级。
/// 只按 cwd 拼一次相对路径会让两种布局**都**解析失败（表现为「未找到 mpv 可执行文件」）。
fn find_upwards(relative: &str) -> Option<PathBuf> {
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
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
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
pub(crate) fn ensure_global(state: &AppState, app: &tauri::AppHandle) -> HpResult<()> {
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    if guard.is_none() {
        let path = global_db_path(app).map_err(HpError::Io)?;
        *guard = Some(GlobalDb::open(&path)?);
    }
    Ok(())
}

/// 解析文件绝对路径：源本地路径 + 相对路径。
pub(crate) fn resolve_file_path(db: &RepoDb, file: &FileIndexRow) -> HpResult<PathBuf> {
    let source = db
        .get_source(file.source_id.as_str())?
        .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {}", file.source_id.as_str())))?;
    Ok(PathBuf::from(source.local_path).join(&file.relative_path))
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
    #[test]
    fn find_upwards_finds_repo_relative_mpv() {
        let found = find_upwards("external-cli/mpv/mpv.exe")
            .expect("应从祖先目录找到仓库内的 external-cli/mpv/mpv.exe");
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

    /// 显式环境变量覆盖优先于自动查找（且不做存在性回退）。
    #[test]
    fn env_override_wins_over_lookup() {
        let key = "HP_TEST_EXTERNAL_BIN_OVERRIDE";
        std::env::set_var(key, "Z:/explicit/override.exe");
        let got = external_bin_path(key, "external-cli/ffmpeg/bin/ffmpeg.exe");
        std::env::remove_var(key);
        assert_eq!(got, Some(PathBuf::from("Z:/explicit/override.exe")));
    }
}
