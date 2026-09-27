//! M1：仓库与设置命令桥接。

use std::path::PathBuf;

use hp_core::{
    registry_decl_for_storage_key, scoped_storage_key, validate_setting_value, Capability,
    HpError, HpResult, RepoId, SettingScope,
};
use hp_plugin_host::PluginHost;
use hp_store::RepoDb;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::{
    api_from_hp, default_repo_dir, ensure_global, global, global_mut, lock_global, lock_repo,
    ApiResponse,
};
use crate::AppState;

/// `app_settings` 的一行（`setting.list` 的 `items` 元素）。
#[derive(Serialize)]
pub(crate) struct SettingRowDto {
    key: String,
    value: serde_json::Value,
}

/// `setting.list` 响应（`docs/spec/commands-events.md` 3.13：`{ items }`）。
#[derive(Serialize)]
pub(crate) struct SettingListResult {
    items: Vec<SettingRowDto>,
}

/// `setting.get` 响应：标量值或 `null`（未设置）。
#[derive(Serialize)]
pub(crate) struct SettingValueResult {
    value: Option<serde_json::Value>,
}

/// `setting.set` / `setting.reset` 响应。
#[derive(Serialize)]
pub(crate) struct SettingOkResult {
    ok: bool,
}

/// 值的**存储编码**：`app_settings` 是 TEXT 表，标量按最小形式落库
/// （`true`/`false`、十进制数字、原文）。
///
/// 读回时的类型由**设置注册表的 `kind`** 决定（前端 `decodeSettingValue`），
/// 因此这里的推断只是"未指定 kind 时的保守兜底"，不会篡改字符串设置。
fn encode_setting_value(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Bool(b) => Ok(if *b { "true".into() } else { "false".into() }),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::String(s) => Ok(s.clone()),
        // 值一律是标量：嵌套对象/数组/null 一律拒绝（同 D32 口径）。
        _ => Err("设置值必须是标量（string / number / bool）".into()),
    }
}

/// 由存储文本推断标量形态（保守：只有能精确往返的才当数字）。
fn decode_setting_value(raw: &str) -> serde_json::Value {
    match raw {
        "true" => return serde_json::Value::Bool(true),
        "false" => return serde_json::Value::Bool(false),
        _ => {}
    }
    if let Ok(int) = raw.parse::<i64>() {
        if int.to_string() == raw {
            return serde_json::Value::from(int);
        }
    }
    if let Ok(float) = raw.parse::<f64>() {
        if float.to_string() == raw {
            return serde_json::Value::from(float);
        }
    }
    serde_json::Value::String(raw.to_string())
}

/// `scope = "repo"` 的设置项按仓库隔离，键为 `{key}.{repoId}`
/// （`docs/spec/commands-events.md` 3.13 规则 4）。
///
/// 规则本身在 `hp_core::scoped_storage_key`（纯函数 + 单测）：
/// **只有** `scope = "repo"` 的项才拼 `repoId`，其余项忽略传入的 `repoId`。

/// 一个设置键解析出的**校验事实**：宿主/面板项来自注册表镜像，插件项来自 manifest。
enum SettingTarget {
    /// 宿主项 / 面板项（`hp_core::setting_registry` 的镜像）。
    Mirror(&'static hp_core::SettingDeclFact),
    /// 插件项（随插件包存在，运行时反查）。
    Plugin {
        plugin_id: String,
        decl: hp_core::PanelSettingDecl,
        storage_key: String,
    },
}

impl SettingTarget {
    /// 基础落库键（不含 `repoId` 后缀）。
    fn base_key(&self) -> String {
        match self {
            SettingTarget::Mirror(fact) => fact.storage_key(),
            SettingTarget::Plugin { storage_key, .. } => storage_key.clone(),
        }
    }

    fn scope(&self) -> SettingScope {
        match self {
            SettingTarget::Mirror(fact) => fact.scope,
            SettingTarget::Plugin { decl, .. } => match decl.scope.as_deref() {
                Some("repo") => SettingScope::Repo,
                _ => SettingScope::App,
            },
        }
    }

    /// 按注册表 `kind` 校验值（规则 2）。
    fn validate(&self, value: &serde_json::Value) -> HpResult<()> {
        match self {
            SettingTarget::Mirror(fact) => {
                let options: Vec<String> = fact.options.iter().map(|o| (*o).to_string()).collect();
                validate_setting_value(fact.kind, value, &options).map_err(HpError::InvalidArgument)
            }
            SettingTarget::Plugin { decl, .. } => {
                // 插件 `select` 的 `options` 尚未在 manifest 侧解析（见设置标准第 5 节缺口），
                // 因此这里对 select 只能校验"是字符串"——**不假装**校验了枚举归属。
                validate_setting_value(&decl.kind, value, &[])
                    .map_err(HpError::InvalidArgument)
                    .map_err(|e| match (decl.kind.as_str(), e) {
                        ("select", HpError::InvalidArgument(_)) => HpError::InvalidArgument(
                            "插件 select 设置项的值必须是字符串（manifest 尚未声明 options）".into(),
                        ),
                        (_, e) => e,
                    })
            }
        }
    }
}

/// 解析设置键 → 校验事实；**未知键即硬错误**（规则 1）。
fn resolve_setting_target(state: &AppState, key: &str) -> HpResult<SettingTarget> {
    if let Some(fact) = registry_decl_for_storage_key(key) {
        return Ok(SettingTarget::Mirror(fact));
    }
    // 宿主内部键（不经注册表、也不允许经 `setting.*` 读写）：明确报错，避免被当成"任意键值存储"。
    let guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    let db = guard
        .as_ref()
        .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
    if let Some((plugin_id, decl)) = PluginHost.find_setting_decl(db, key)? {
        return Ok(SettingTarget::Plugin {
            plugin_id,
            storage_key: key.to_string(),
            decl,
        });
    }
    Err(HpError::InvalidArgument(format!(
        "未知设置键: {key}（设置项必须先在设置注册表里声明）"
    )))
}

/// 规则 3：插件项若声明了 `requires_capability`，必须在该仓库已获授权，否则 `permission`。
///
/// 失败关闭：拿不到 `repoId` 就无法判定授权，因此**同样返回 `permission`**，
/// 而不是放行或降级成校验错误。
fn ensure_setting_capability(
    state: &AppState,
    target: &SettingTarget,
    repo_id: Option<&str>,
) -> HpResult<()> {
    let SettingTarget::Plugin { plugin_id, decl, .. } = target else {
        return Ok(());
    };
    let Some(raw) = decl.requires_capability.as_deref() else {
        return Ok(());
    };
    let capability = Capability::from_str(raw)
        .ok_or_else(|| HpError::InvalidArgument(format!("插件声明了未知能力: {raw}")))?;
    let repo = repo_id
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .ok_or_else(|| {
            HpError::Permission(format!(
                "设置项需要能力 {raw}：必须带 repoId 才能校验插件在该仓库的授权"
            ))
        })?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    let db = guard
        .as_ref()
        .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
    PluginHost.check_capability(db, plugin_id, repo, capability)
}

/// 解析出**实际落库键**（规则 4）+ 校验值（规则 2）+ 校验授权（规则 3）。
fn prepare_setting_write(
    state: &AppState,
    key: &str,
    value: &serde_json::Value,
    repo_id: Option<&str>,
) -> HpResult<String> {
    let target = resolve_setting_target(state, key)?;
    target.validate(value)?;
    ensure_setting_capability(state, &target, repo_id)?;
    scoped_storage_key(&target.base_key(), target.scope(), repo_id)
        .map_err(HpError::InvalidArgument)
}

/// 广播设置变更（`setting.changed`）：前端据此刷新受影响的面板/界面。
///
/// 设置变更**不广播**仓库级事件（不触发蓝图/布局对账，3.13 规则）；
/// 注册表本身**不落库**（随插件包存在），因此事件只带"哪个键变了"。
fn emit_setting_changed(app: &tauri::AppHandle, key: &str) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SettingChanged {
        key: String,
    }
    let _ = app.emit(
        "setting.changed",
        SettingChanged {
            key: key.to_string(),
        },
    );
}

#[derive(Serialize)]
pub(crate) struct RepoSummary {
    id: String,
    name: String,
    schema_version: i64,
}

#[derive(Serialize)]
pub(crate) struct RepoListItem {
    id: String,
    name: String,
    repo_db_path: String,
    created_at: String,
    last_opened_at: Option<String>,
}

/// repo.create：创建仓库库并注册到全局库。
#[tauri::command]
pub(crate) fn repo_create(
    name: String,
    db_path: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<RepoSummary> {
    let outcome = (|| -> HpResult<RepoSummary> {
        if name.trim().is_empty() {
            return Err(HpError::InvalidArgument("仓库名不能为空".into()));
        }
        let repo_path = match db_path {
            Some(p) => PathBuf::from(p),
            None => {
                let dir = default_repo_dir(&app).map_err(HpError::Io)?;
                dir.join(format!("{}.sqlite3", RepoId::generate()))
            }
        };

        let repo = RepoDb::create(&repo_path, &name)?;
        repo.close()?;

        ensure_global(&state, &app)?;
        let row = {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            let path_str = repo_path
                .to_str()
                .ok_or_else(|| HpError::InvalidArgument("仓库库路径不是合法 UTF-8".into()))?;
            g.register_repo(&name, path_str)?
        };

        let opened = RepoDb::open(&repo_path)?;
        let version = opened.schema_version()?;

        let mut open_guard = lock_repo(&state)?;
        *open_guard = Some(opened);
        if let Ok(mut cur) = state.current_repo_id.lock() {
            *cur = Some(row.id.clone());
        }
        if let Ok(mut path) = state.current_repo_path.lock() {
            *path = Some(PathBuf::from(&row.repo_db_path));
        }

        Ok(RepoSummary {
            id: row.id,
            name: row.name,
            schema_version: version,
        })
    })();
    api_from_hp(outcome)
}

/// repo.open：打开已注册仓库。
#[tauri::command]
pub(crate) fn repo_open(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<RepoSummary> {
    let outcome = (|| -> HpResult<RepoSummary> {
        ensure_global(&state, &app)?;
        let row = {
            let guard = lock_global(&state)?;
            let g = global(&guard)?;
            g.get_repo(&repo_id)?
                .ok_or_else(|| HpError::NotFound(format!("仓库不存在: {repo_id}")))?
        };

        let repo = RepoDb::open(&row.repo_db_path)?;
        let version = repo.schema_version()?;

        {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            g.touch_repo(&repo_id)?;
        }

        let mut open_guard = lock_repo(&state)?;
        *open_guard = Some(repo);
        if let Ok(mut cur) = state.current_repo_id.lock() {
            *cur = Some(repo_id.clone());
        }
        if let Ok(mut path) = state.current_repo_path.lock() {
            *path = Some(PathBuf::from(&row.repo_db_path));
        }

        Ok(RepoSummary {
            id: repo_id,
            name: row.name,
            schema_version: version,
        })
    })();
    api_from_hp(outcome)
}

/// repo.close：关闭当前打开的仓库。
#[tauri::command]
pub(crate) fn repo_close(state: State<AppState>) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        if let Some(repo) = guard.take() {
            repo.close()?;
        }
        if let Ok(mut cur) = state.current_repo_id.lock() {
            *cur = None;
        }
        if let Ok(mut path) = state.current_repo_path.lock() {
            *path = None;
        }
        Ok(())
    })();
    api_from_hp(outcome)
}

/// repo.list：列出全部已注册仓库。
#[tauri::command]
pub(crate) fn repo_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<RepoListItem>> {
    let outcome = (|| -> HpResult<Vec<RepoListItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let rows = g.list_repos()?;
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
    })();
    api_from_hp(outcome)
}

/// setting.get：读取单个设置值（`{ value | null }`，标量）。
///
/// 契约 3.13 四条规则见 `resolve_setting_target` / `scoped_storage_key`：
/// 未知键拒绝、`scope = "repo"` 项才拼 `{key}.{repoId}`（缺 `repoId` 即硬错误）。
/// 形状遵循 **D76**（`{ ok, data?, error? }`；`data = { value }`）。
#[tauri::command]
pub(crate) fn setting_get(
    key: String,
    repo_id: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<SettingValueResult> {
    let outcome = (|| -> HpResult<SettingValueResult> {
        ensure_global(&state, &app)?;
        let target = resolve_setting_target(&state, &key)?;
        ensure_setting_capability(&state, &target, repo_id.as_deref())?;
        let storage_key = scoped_storage_key(&target.base_key(), target.scope(), repo_id.as_deref())
            .map_err(HpError::InvalidArgument)?;
        let guard = state
            .global_db
            .lock()
            .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
        let g = guard
            .as_ref()
            .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
        let stored = g.get_setting(&storage_key)?;
        Ok(SettingValueResult {
            value: stored.as_deref().map(decode_setting_value),
        })
    })();
    api_from_hp(outcome)
}

/// setting.set：写入单个设置值（**标量**；并广播 `setting.changed`）。
///
/// 契约 3.13 的四条规则都在这里执行（未知键拒绝 / 按 `kind` 校验 /
/// 插件项不满能力返回 `permission` / 仅 `scope = "repo"` 项拼 `repoId`）。
/// 形状遵循 **D76**（`{ ok, data?, error? }`；`data = { ok: true }`）。
#[tauri::command]
pub(crate) fn setting_set(
    key: String,
    value: serde_json::Value,
    repo_id: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<SettingOkResult> {
    let outcome = (|| -> HpResult<SettingOkResult> {
        ensure_global(&state, &app)?;
        let storage_key = prepare_setting_write(&state, &key, &value, repo_id.as_deref())?;
        let encoded = encode_setting_value(&value).map_err(HpError::InvalidArgument)?;
        {
            let guard = state
                .global_db
                .lock()
                .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
            let g = guard
                .as_ref()
                .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
            g.set_setting(&storage_key, &encoded)?;
        }
        emit_setting_changed(&app, &key);
        Ok(SettingOkResult { ok: true })
    })();
    api_from_hp(outcome)
}

/// setting.list：列出全部设置值（`{ items: [{ key, value }] }`；**不新增库表**）。
///
/// 这是 `app_settings` 的**原始转储**（含宿主内部键如 `repo.default`），不做注册表过滤：
/// 界面按注册表挑选自己要用的行，过滤反而会让"未设置 vs 设成缺省"无法区分。
/// 形状遵循 **D76**。
#[tauri::command]
pub(crate) fn setting_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<SettingListResult> {
    let outcome = (|| -> HpResult<SettingListResult> {
        ensure_global(&state, &app)?;
        let guard = state
            .global_db
            .lock()
            .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
        let g = guard
            .as_ref()
            .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
        let rows = g.list_settings()?;
        Ok(SettingListResult {
            items: rows
                .into_iter()
                .map(|(key, value)| SettingRowDto {
                    key,
                    value: decode_setting_value(&value),
                })
                .collect(),
        })
    })();
    api_from_hp(outcome)
}

/// setting.reset：把某项设置恢复为声明缺省值（删除该键；并广播 `setting.changed`）。
///
/// **注册表不落库**：缺省值来自设置注册表的声明，因此这里只删键、不写值——
/// "未设置"与"设成缺省值"是两个可区分的状态（设置标准第 5 节）。
/// 未知键与 `scope` 口径与 `setting.set` 完全一致。形状遵循 **D76**。
#[tauri::command]
pub(crate) fn setting_reset(
    key: String,
    repo_id: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<SettingOkResult> {
    let outcome = (|| -> HpResult<SettingOkResult> {
        ensure_global(&state, &app)?;
        let target = resolve_setting_target(&state, &key)?;
        ensure_setting_capability(&state, &target, repo_id.as_deref())?;
        let storage_key = scoped_storage_key(&target.base_key(), target.scope(), repo_id.as_deref())
            .map_err(HpError::InvalidArgument)?;
        {
            let guard = state
                .global_db
                .lock()
                .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
            let g = guard
                .as_ref()
                .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
            g.delete_setting(&storage_key)?;
        }
        emit_setting_changed(&app, &key);
        Ok(SettingOkResult { ok: true })
    })();
    api_from_hp(outcome)
}

/// repo.backup：把仓库库文件复制到目标路径；返回备份 ID。
#[tauri::command]
pub(crate) fn repo_backup(
    repo_id: String,
    dest_path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<String> {
    let outcome = (|| -> HpResult<String> {
        if dest_path.trim().is_empty() {
            return Err(HpError::InvalidArgument("备份目标路径不能为空".into()));
        }
        ensure_global(&state, &app)?;
        let row = {
            let guard = lock_global(&state)?;
            let g = global(&guard)?;
            g.get_repo(&repo_id)?
                .ok_or_else(|| HpError::NotFound(format!("仓库不存在: {repo_id}")))?
        };

        let dest = PathBuf::from(&dest_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| HpError::Io(format!("创建备份目录失败: {e}")))?;
        }
        std::fs::copy(&row.repo_db_path, &dest)
            .map_err(|e| HpError::Io(format!("备份仓库库失败: {e}")))?;
        Ok(uuid::Uuid::new_v4().to_string())
    })();
    api_from_hp(outcome)
}

/// repo.rename：重命名仓库（全局注册表 + 若打开则同步仓库库 meta）。
#[tauri::command]
pub(crate) fn repo_rename(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(HpError::InvalidArgument("仓库名不能为空".into()));
        }
        ensure_global(&state, &app)?;
        {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            g.rename_repo(&repo_id, trimmed)?;
        }
        let is_current = state
            .current_repo_id
            .lock()
            .map(|c| c.as_deref() == Some(repo_id.as_str()))
            .unwrap_or(false);
        if is_current {
            let mut open = lock_repo(&state)?;
            if let Some(db) = open.as_mut() {
                db.set_repo_name(trimmed)?;
            }
        }
        Ok(())
    })();
    api_from_hp(outcome)
}

/// repo.delete：删除仓库（注册行 + 仓库库文件；不删除真实媒体源文件）。
#[tauri::command]
pub(crate) fn repo_delete(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;

        // 若删除的是当前打开仓库，先关闭以释放文件句柄。
        let is_current = state
            .current_repo_id
            .lock()
            .map(|c| c.as_deref() == Some(repo_id.as_str()))
            .unwrap_or(false);
        if is_current {
            let mut guard = lock_repo(&state)?;
            if let Some(repo) = guard.take() {
                repo.close()?;
            }
            if let Ok(mut cur) = state.current_repo_id.lock() {
                *cur = None;
            }
            if let Ok(mut path) = state.current_repo_path.lock() {
                *path = None;
            }
        }

        let repo_path = {
            let guard = lock_global(&state)?;
            let g = global(&guard)?;
            g.get_repo(&repo_id)?
                .ok_or_else(|| HpError::NotFound(format!("仓库不存在: {repo_id}")))?
                .repo_db_path
        };

        {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            g.delete_repo(&repo_id)?;
            // 清理默认仓库标记。
            if g.get_setting("repo.default")?.as_deref() == Some(repo_id.as_str()) {
                g.set_setting("repo.default", "")?;
            }
        }

        // 删除仓库库文件（含 WAL / SHM 附属文件）。
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{repo_path}{suffix}"));
        }
        Ok(())
    })();
    api_from_hp(outcome)
}

/// repo.setDefault：把某仓库设为默认仓库（启动时自动打开）。
#[tauri::command]
pub(crate) fn repo_set_default(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        g.set_setting("repo.default", &repo_id)
    })();
    api_from_hp(outcome)
}

/// repo.getDefault：读取默认仓库 ID；未设置返回 `None`。
#[tauri::command]
pub(crate) fn repo_get_default(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let value = g.get_setting("repo.default")?;
        Ok(value.filter(|v| !v.is_empty()))
    })();
    api_from_hp(outcome)
}
