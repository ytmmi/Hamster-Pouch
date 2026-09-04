//! 仓鼠颊 Tauri 入口：M1 仓库命令桥接。
//!
//! 职责边界（docs/spec/module-boundaries.md）：只做参数校验、状态装配、
//! 调用 hp-store；业务规则在 crate 层。

use std::path::PathBuf;
use std::sync::Mutex;

use hp_core::{HpError, HpResult, RepoId};
use hp_store::{GlobalDb, RepoDb};
use serde::Serialize;
use tauri::{Manager, State};

/// 应用级共享状态。
struct AppState {
    global_db: Mutex<Option<GlobalDb>>,
    open_repo: Mutex<Option<RepoDb>>,
}

#[derive(Serialize)]
struct RepoSummary {
    id: String,
    name: String,
    schema_version: i64,
}

#[derive(Serialize)]
struct RepoListItem {
    id: String,
    name: String,
    repo_db_path: String,
    created_at: String,
    last_opened_at: Option<String>,
}

fn hp_err_to_string(e: HpError) -> String {
    e.to_string()
}

fn global_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    Ok(dir.join("hamster-pouch-global.sqlite3"))
}

fn default_repo_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("repos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    Ok(dir)
}

/// 懒加载全局配置库。
fn ensure_global(state: &AppState, app: &tauri::AppHandle) -> HpResult<()> {
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

/// repo.create：创建仓库库并注册到全局库。
#[tauri::command]
fn repo_create(
    name: String,
    db_path: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<RepoSummary, String> {
    if name.trim().is_empty() {
        return Err("仓库名不能为空".into());
    }
    let repo_path = match db_path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = default_repo_dir(&app)?;
            dir.join(format!("{}.sqlite3", RepoId::generate()))
        }
    };

    let repo = RepoDb::create(&repo_path, &name).map_err(hp_err_to_string)?;
    repo.close().map_err(hp_err_to_string)?;

    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().expect("ensure_global 已初始化");
    let row = g
        .register_repo(&name, repo_path.to_str().expect("路径非 UTF-8"))
        .map_err(hp_err_to_string)?;

    let opened = RepoDb::open(repo_path).map_err(hp_err_to_string)?;
    let version = opened.schema_version().map_err(hp_err_to_string)?;

    let mut open_guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    *open_guard = Some(opened);

    Ok(RepoSummary {
        id: row.id,
        name: row.name,
        schema_version: version,
    })
}

/// repo.open：打开已注册仓库。
#[tauri::command]
fn repo_open(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<RepoSummary, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let row = {
        let guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_ref().expect("ensure_global 已初始化");
        g.get_repo(&repo_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("仓库不存在: {repo_id}"))?
    };

    let repo = RepoDb::open(&row.repo_db_path).map_err(hp_err_to_string)?;
    let version = repo.schema_version().map_err(hp_err_to_string)?;

    {
        let mut guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_mut().expect("ensure_global 已初始化");
        g.touch_repo(&repo_id).map_err(hp_err_to_string)?;
    }

    let mut open_guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    *open_guard = Some(repo);

    Ok(RepoSummary {
        id: repo_id,
        name: row.name,
        schema_version: version,
    })
}

/// repo.close：关闭当前打开的仓库。
#[tauri::command]
fn repo_close(state: State<AppState>) -> Result<(), String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    if let Some(repo) = guard.take() {
        repo.close().map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// repo.list：列出全部已注册仓库。
#[tauri::command]
fn repo_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<RepoListItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    let rows = g.list_repos().map_err(hp_err_to_string)?;
    Ok(rows
        .into_iter()
        .map(|r| RepoListItem {
            id: r.id,
            name: r.name,
            repo_db_path: r.repo_db_path,
            created_at: r.created_at,
            last_opened_at: r.last_opened_at,
        })
        .collect())
}

/// setting.get / setting.set：应用设置读写。
#[tauri::command]
fn setting_get(
    key: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    g.get_setting(&key).map_err(hp_err_to_string)
}

#[tauri::command]
fn setting_set(
    key: String,
    value: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    g.set_setting(&key, &value).map_err(hp_err_to_string)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            global_db: Mutex::new(None),
            open_repo: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            repo_create,
            repo_open,
            repo_close,
            repo_list,
            setting_get,
            setting_set
        ])
        .run(tauri::generate_context!())
        .expect("仓鼠颊启动失败");
}
