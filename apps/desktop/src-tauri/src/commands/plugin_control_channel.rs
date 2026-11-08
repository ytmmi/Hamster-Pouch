//! 控件的 **schema 运行时通道**命令桥接（`docs/spec/control-standard.md` 第 2/7 节，
//! D61/D62）：`plugin.panelSchema` 与 `plugin.validateControl`，以及两者共用的
//! **面板归属校验**与**受监督调用**地基（控件事件回传链 `plugin_control_event.rs` 也用）。
//!
//! 通道语义：持有库锁期间**只做纯查询**，跨进程等待一律不持锁（D61 默认 2s 超时）。
//! 失败即广播 `plugin.error`，由前端把**该面板**降级为错误态，其它面板不受影响。

use hp_core::{
    CONTROL_API_VERSION, ControlSchema, ControlValidateCtx, ControlValidateResult, HpError,
    HpResult, RuntimeKind,
};
use hp_plugin_host::{
    ExternalProcessQuery, PanelOwner, PanelSchemaKey, PanelSchemaParams, PluginHost,
    SCHEMA_MAX_BYTES, SCHEMA_QUERY_TIMEOUT, SupervisionStatus,
};
use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::commands::shared::{
    ApiResponse, EmitHp, api_from_hp, ensure_global, global, lock_global,
};

/// 广播 `plugin.error`：某个面板的 schema 查询失败。
///
/// 语义（控件标准第 2 节）：**该面板**渲染错误态，**不阻塞其它面板**。
/// `error` 是诊断串（不面向用户显示）；界面文案由前端按结构化 `code` 走 i18n（D27）。
pub(crate) fn emit_plugin_error(
    app: &tauri::AppHandle,
    repo_id: &str,
    plugin_id: &str,
    error: &str,
) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PluginError {
        plugin_id: String,
        repo_id: String,
        error: String,
    }
    app.emit_hp(
        "plugin.error",
        PluginError {
            plugin_id: plugin_id.to_string(),
            repo_id: repo_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// 面板 schema 查询结果（`plugin.panelSchema`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelSchemaItem {
    panel_id: String,
    plugin_id: String,
    plugin_version: String,
    api_version: u32,
    /// 插件返回的 schema 文本：**原样**带回，解析层校验在前端（控件标准第 7 节）。
    schema_json: String,
    /// 本次是否命中 `(plugin_id, panel_id, plugin_version)` 缓存（诊断用）。
    cached: bool,
}

/// 反查面板归属并校验可用性（持库锁期间只做纯查询，绝不跨进程等待）。
pub(crate) fn panel_owner_enabled(
    state: &AppState,
    repo_id: &str,
    panel_id: &str,
) -> HpResult<PanelOwner> {
    let guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    let db = guard
        .as_ref()
        .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
    // 归属由**注册表反查**决定，不靠 panel_id 字符串切分（plugin_id 自身含点）。
    let owner = PluginHost
        .find_panel_owner(db, panel_id)?
        .ok_or_else(|| HpError::NotFound(format!("没有已安装插件声明该面板: {panel_id}")))?;
    // 可用性：插件必须在该仓库已启用且已获 `ui.panel`（RFC 0004；panel-standard 第 6 节）。
    PluginHost.check_capability(db, &owner.plugin_id, repo_id, hp_core::Capability::UiPanel)?;
    Ok(owner)
}

/// 执行一次受监督的插件外部进程查询。
///
/// 1. 检查监督状态（退避中 / 不健康 → 拒绝）
/// 2. 执行查询（不持任何锁）
/// 3. 记录 success / failure
pub(crate) fn supervised_call(
    state: &AppState,
    plugin_id: String,
    run: impl FnOnce() -> HpResult<String>,
) -> HpResult<String> {
    // 步骤 1：监督检查
    {
        let mut guard = state
            .supervision
            .lock()
            .map_err(|_| HpError::Store("监督注册表锁中毒".into()))?;
        // 自动注册监督器（首次调用某插件时）
        if guard.get_mut(&plugin_id).is_none() {
            guard.register(&plugin_id);
        }
        let sup = guard.get_mut(&plugin_id);
        if let Some(s) = sup {
            match s.status() {
                SupervisionStatus::Unhealthy { .. } => {
                    return Err(HpError::Plugin(format!(
                        "插件 {plugin_id} 已被标记为不健康（连续失败），请重新启用后重试"
                    )));
                }
                _ => {
                    if let Err(remaining) = s.on_call_start() {
                        return Err(HpError::Plugin(format!(
                            "插件 {plugin_id} 退避中，还需等待 {}ms 才能重试",
                            remaining.as_millis()
                        )));
                    }
                }
            }
        } // 未注册监督器的插件（非 external-process）不检查
    }

    // 步骤 2：执行查询
    let result = run();

    // 步骤 3：记录结果
    {
        let mut guard = state
            .supervision
            .lock()
            .map_err(|_| HpError::Store("监督注册表锁中毒".into()))?;
        if let Some(s) = guard.get_mut(&plugin_id) {
            match &result {
                Ok(_) => s.on_success(),
                Err(_) => {
                    s.on_failure();
                }
            }
        }
    }

    result
}

/// 解析本次调用要执行的**宿主命令**（只在解析阶段短暂持锁）。
///
/// - `external-process`：执行插件自己的入口（`owner.entry_path`）。
/// - `python`：执行 **Python 核心**的启动器 `python-core.exe --run <脚本>`。宿主刻意
///   **不**直连 `runtime/python.exe`——解释器由 Python 核心自行解析，否则它只是个空壳；
///   拉起的职责归 Python 核心（RFC 0004「Python 核心」）。
///
/// 其余运行形态（`dynamic-library` / `wasm`）仍返回「尚未接入」错。
///
/// 为什么单独成一步：查询本身可能阻塞到超时（D61 默认 2s），跨进程等待一律不持锁，
/// 所以这里只解析路径、返回命令，执行交给 [`supervised_call`] 的闭包。
pub(crate) fn resolve_plugin_query(
    state: &AppState,
    owner: &PanelOwner,
) -> HpResult<ExternalProcessQuery> {
    let guard = lock_global(state)?;
    let db = global(&guard)?;
    hp_plugin_host::query_for_owner(db, owner)
}

/// 取（或查询并缓存）面板 schema。
fn fetch_panel_schema(
    state: &AppState,
    owner: &PanelOwner,
    panel_id: &str,
) -> HpResult<PanelSchemaItem> {
    let key = PanelSchemaKey::new(&owner.plugin_id, panel_id, &owner.plugin_version);
    {
        let cache = state
            .panel_schema_cache
            .lock()
            .map_err(|_| HpError::Store("schema 缓存锁中毒".into()))?;
        if let Some(schema_json) = cache.get(&key) {
            return Ok(PanelSchemaItem {
                panel_id: panel_id.to_string(),
                plugin_id: owner.plugin_id.clone(),
                plugin_version: owner.plugin_version.clone(),
                api_version: CONTROL_API_VERSION,
                schema_json,
                cached: true,
            });
        }
    }

    // StaticData 形态无可执行入口，不需起进程
    if owner.runtime_kind == RuntimeKind::StaticData {
        return Ok(PanelSchemaItem {
            panel_id: panel_id.to_string(),
            plugin_id: owner.plugin_id.clone(),
            plugin_version: owner.plugin_version.clone(),
            api_version: CONTROL_API_VERSION,
            schema_json: "[]".to_string(),
            cached: false,
        });
    }

    // 三种运行形态共用同一请求名；本轮落地 `external-process` 与 `python`
    // （`python` 形态的入口是 `.py` 源码，由 Python 核心 system 插件拉起）。
    let mut query = resolve_plugin_query(state, owner)?;

    // 查询期间**不持任何锁**：这里可能阻塞到超时（D61 默认 2s）。
    let plugin_id_for_run = owner.plugin_id.clone();
    let panel_id_clone = panel_id.to_string();
    let schema_json = supervised_call(state, plugin_id_for_run, move || {
        query.query(
            &PanelSchemaParams::new(&panel_id_clone, CONTROL_API_VERSION),
            SCHEMA_QUERY_TIMEOUT,
            SCHEMA_MAX_BYTES,
        )
    })?;

    // 只缓存成功结果：失败必须能在下次重开面板时重试。
    if let Ok(mut cache) = state.panel_schema_cache.lock() {
        cache.put(key, schema_json.clone());
    }
    Ok(PanelSchemaItem {
        panel_id: panel_id.to_string(),
        plugin_id: owner.plugin_id.clone(),
        plugin_version: owner.plugin_version.clone(),
        api_version: CONTROL_API_VERSION,
        schema_json,
        cached: false,
    })
}

/// plugin.panelSchema：向插件查询面板控件 schema（请求名 `ui.panel.schema`，D61）。
///
/// 失败语义：命令本身失败 + 广播 `plugin.error`，由前端把**该面板**降级为错误态；
/// 其它面板不受影响。形状遵循 D76（`{ ok, data?, error? }`）。
#[tauri::command]
pub(crate) fn plugin_panel_schema(
    repo_id: String,
    panel_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PanelSchemaItem> {
    let outcome = (|| -> HpResult<PanelSchemaItem> {
        ensure_global(&state, &app)?;
        let owner = panel_owner_enabled(&state, &repo_id, &panel_id)?;
        let result = fetch_panel_schema(&state, &owner, &panel_id);
        if let Err(e) = &result {
            emit_plugin_error(&app, &repo_id, &owner.plugin_id, &e.to_string());
        }
        result
    })();
    api_from_hp(outcome)
}

/// plugin.validateControl：业务级控件校验（控件标准第 7 节 / D62）。
///
/// 返回 `{ errors, warnings }`：**解析层问题也在这里复算**（JSON 不可解析时以
/// `errors` 返回，而不是命令级失败），因此前端拿到的永远是同一形状的判定结果。
/// 面板不由任何已安装插件声明时，声明表为空——任何 `bind` / `on` 都会成为硬错误，
/// 这是 fail-closed 的有意选择（宿主是最终裁决者）。
#[tauri::command]
pub(crate) fn plugin_validate_control(
    panel_id: String,
    schema_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<ControlValidateResult> {
    let outcome = (|| -> HpResult<ControlValidateResult> {
        ensure_global(&state, &app)?;
        let (declared_queries, declared_events) = {
            let guard = state
                .global_db
                .lock()
                .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
            let db = guard
                .as_ref()
                .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
            match PluginHost.find_panel_owner(db, &panel_id)? {
                Some(owner) => (owner.declared_queries, owner.declared_events),
                None => (Vec::new(), Vec::new()),
            }
        };
        let ctx = ControlValidateCtx {
            expected_panel_id: Some(panel_id),
            declared_queries,
            declared_events,
        };
        let schema = match ControlSchema::from_json(&schema_json) {
            Ok(schema) => schema,
            Err(message) => {
                return Ok(ControlValidateResult {
                    errors: vec![message],
                    warnings: Vec::new(),
                });
            }
        };
        Ok(schema.validate(&ctx))
    })();
    api_from_hp(outcome)
}
