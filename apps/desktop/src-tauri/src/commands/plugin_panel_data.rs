//! 面板 `bind` 的**受控取数通道**（`docs/spec/control-standard.md` 第 5 节）。
//!
//! 从 `commands/plugin.rs` 拆出：该文件已接近 1200 行的文件规则上限
//! （`tools/check-line-count.mjs`），而取数通道是与 schema 通道**并列**的一块独立职责
//! ——请求名、请求参数、fail-closed 校验与结果解析都自成一体，拆开后两边都更好读。

use hp_core::{HpError, HpResult, RuntimeKind, CONTROL_API_VERSION};
use hp_plugin_host::{
    ExternalProcessQuery, PanelOwner, PanelQueryParams, PanelQuerySpec, PanelSelectionContext,
    QUERY_MAX_BYTES, QUERY_TIMEOUT,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::plugin::{emit_plugin_error, panel_owner_enabled, supervised_call};
use crate::commands::shared::{api_from_hp, ensure_global, ApiResponse};
use crate::AppState;

// ===== 控件受控取数通道（`docs/spec/control-standard.md` 第 5 节 / 第 4 轮）=====

/// `plugin.panelData` 的一条 `bind` 入参（前端按已解析的 schema 收集后传入）。
#[derive(Deserialize, Clone)]
pub(crate) struct PanelDataBind {
    /// `panel` / `selection`（控件标准第 5 节第一版开放的两种）。
    kind: String,
    /// 查询名；必须在插件 manifest 的 `data_queries` 里声明过。
    name: String,
    /// 可选**标量**参数。
    #[serde(default)]
    args: Option<serde_json::Value>,
}

/// `plugin.panelData` 的返回项。
///
/// `results` 的键是**宿主构造**的快照键 `"{kind}:{name}"`，与前端
/// `makeControlDataSnapshot` 的查键口径逐字一致——前端拿到即可直接交给渲染层。
#[derive(Serialize, Debug)]
pub(crate) struct PanelDataItem {
    panel_id: String,
    plugin_id: String,
    plugin_version: String,
    /// 快照键 → 查询结果（**原样**来自插件，宿主不替插件做业务解释）。
    results: serde_json::Map<String, serde_json::Value>,
    /// 插件**未返回**的键：宿主按"空结果"渲染空态，**不是错误**（诊断用）。
    missing: Vec<String>,
}

/// 解析插件返回的 `{ "results": { "<key>": <结果> } }`。
///
/// 只做**协议形状**校验（`results` 必须是对象）；单条结果的领域形状由前端解析层校验
/// （控件标准第 7 节）。**缺键不是错误**——插件可以对某个查询名明确"没有数据"。
fn parse_panel_data_results(text: &str) -> HpResult<serde_json::Map<String, serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| HpError::Plugin(format!("插件取数结果不是合法 JSON: {e}")))?;
    match value.get("results") {
        Some(serde_json::Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(HpError::Plugin("插件取数结果的 results 必须是对象".into())),
        None => Err(HpError::Plugin("插件取数结果缺少 results 字段".into())),
    }
}

/// 取面板的 `bind` 数据（控件标准第 5 节）。
///
/// **一次问完**：全部 `bind`（含 `visible_when` 引用的查询名）装在**同一次**插件请求里
/// ——`external-process` 每次调用都要起一个进程，进程启动是主要成本。
/// **不缓存**：数据随时会变，每次面板挂载 / `refreshKey` 变化都重查；schema 仍按
/// `(plugin_id, panel_id, plugin_version)` 缓存（两者的陈旧风险不同）。
///
/// **fail-closed 校验**（宿主侧，不靠前端自证）：`bind.name` 必须在插件的
/// `data_queries` 里声明过（未声明即硬错误）；`bind.kind` 只能是 `panel` / `selection`。
///
/// **范围边界（本轮有意不做）**：不校验单条结果与 manifest `returns`
/// （rows/object/scalar）的匹配——`PanelOwner` 目前只带查询**名**，不带 `returns`，
/// 扩它属于另一处改动；留待需要时一并做。
fn fetch_panel_data(
    state: &AppState,
    owner: &PanelOwner,
    panel_id: &str,
    selected_file_id: Option<&str>,
    binds: &[PanelDataBind],
) -> HpResult<PanelDataItem> {
    for b in binds {
        if b.kind != "panel" && b.kind != "selection" {
            return Err(HpError::InvalidArgument(format!(
                "面板 {panel_id} 的 bind.kind 非法: {}（允许 panel / selection）",
                b.kind
            )));
        }
        if !owner.declared_queries.iter().any(|q| q == &b.name) {
            return Err(HpError::InvalidArgument(format!(
                "面板 {panel_id} 的 bind.name「{}」未在插件的 data_queries 中声明",
                b.name
            )));
        }
    }

    // 没有 bind 就不起进程：省掉一次必然无用的插件启动。
    if binds.is_empty() {
        return Ok(PanelDataItem {
            panel_id: panel_id.to_string(),
            plugin_id: owner.plugin_id.clone(),
            plugin_version: owner.plugin_version.clone(),
            results: serde_json::Map::new(),
            missing: Vec::new(),
        });
    }

    // 三种运行形态共用同一请求名；本轮先落地 `external-process`（与 schema 通道同口径）。
    if owner.runtime_kind != RuntimeKind::ExternalProcess {
        return Err(HpError::Plugin(format!(
            "运行形态 {} 的取数通道尚未接入（当前只支持 external-process）",
            owner.runtime_kind.as_str()
        )));
    }
    let entry = owner.entry_path.clone().ok_or_else(|| {
        HpError::Plugin("注册表缺少插件安装目录（source_ref），无法定位入口".into())
    })?;
    if !entry.is_file() {
        return Err(HpError::Plugin(format!("插件入口不存在: {}", entry.display())));
    }

    let specs: Vec<PanelQuerySpec> = binds
        .iter()
        .map(|b| PanelQuerySpec::new(b.kind.clone(), b.name.clone(), b.args.clone()))
        .collect();
    let request = PanelQueryParams::new(
        panel_id,
        CONTROL_API_VERSION,
        selected_file_id.map(PanelSelectionContext::new),
        specs.clone(),
    );

    // 查询期间**不持任何锁**：这里可能阻塞到超时（与 schema 通道同口径 2s）。
    let plugin_id = owner.plugin_id.clone();
    let entry_clone = entry.clone();
    let request_clone = request.clone();
    let text = supervised_call(state, plugin_id, move || {
        ExternalProcessQuery::for_entry(entry_clone).query_panel_data(
            &request_clone,
            QUERY_TIMEOUT,
            QUERY_MAX_BYTES,
        )
    })?;
    let results = parse_panel_data_results(&text)?;
    let missing = specs
        .iter()
        .map(|s| s.key.clone())
        .filter(|k| !results.contains_key(k))
        .collect();
    Ok(PanelDataItem {
        panel_id: panel_id.to_string(),
        plugin_id: owner.plugin_id.clone(),
        plugin_version: owner.plugin_version.clone(),
        results,
        missing,
    })
}

/// plugin.panelData：面板 `bind` 的受控取数（控件标准第 5 节 / 请求名 `ui.panel.query`）。
///
/// 失败语义与 `plugin.panelSchema` 同口径：命令本身失败 + 广播 `plugin.error`，
/// 由前端把**该面板**降级为错误态；其它面板不受影响。
#[tauri::command]
pub(crate) fn plugin_panel_data(
    repo_id: String,
    panel_id: String,
    selected_file_id: Option<String>,
    binds: Vec<PanelDataBind>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PanelDataItem> {
    let outcome = (|| -> HpResult<PanelDataItem> {
        ensure_global(&state, &app)?;
        let owner = panel_owner_enabled(&state, &repo_id, &panel_id)?;
        let result = fetch_panel_data(&state, &owner, &panel_id, selected_file_id.as_deref(), &binds);
        if let Err(e) = &result {
            emit_plugin_error(&app, &repo_id, &owner.plugin_id, &e.to_string());
        }
        result
    })();
    api_from_hp(outcome)
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 造一个只用于**宿主侧校验**的 owner（不起进程：入口刻意指向不存在的路径）。
    fn owner_with_queries(queries: &[&str]) -> PanelOwner {
        PanelOwner {
            plugin_id: "dev.hamsterpouch.test".into(),
            plugin_version: "0.1.0".into(),
            runtime_kind: RuntimeKind::ExternalProcess,
            version_dir: None,
            entry_path: Some(PathBuf::from("Z:/definitely/missing/entry.exe")),
            declared_queries: queries.iter().map(|q| (*q).to_string()).collect(),
            declared_events: Vec::new(),
        }
    }

    fn bind(kind: &str, name: &str) -> PanelDataBind {
        PanelDataBind {
            kind: kind.into(),
            name: name.into(),
            args: None,
        }
    }

    /// 取数结果只做**协议形状**校验：`results` 必须是对象，缺字段/非对象即失败。
    #[test]
    fn parse_panel_data_results_requires_an_object_results_field() {
        let ok = parse_panel_data_results(r#"{"results":{"panel:colors":{"kind":"rows"}}}"#)
            .expect("合法形状应通过");
        assert!(ok.contains_key("panel:colors"));

        // 空对象是合法的（"没有数据" ≠ 错误）。
        assert!(parse_panel_data_results(r#"{"results":{}}"#).expect("空结果合法").is_empty());

        assert!(parse_panel_data_results(r#"{"results":[]}"#).is_err(), "数组应被拒绝");
        assert!(parse_panel_data_results(r#"{}"#).is_err(), "缺 results 应被拒绝");
        assert!(parse_panel_data_results("not json").is_err(), "非 JSON 应被拒绝");
    }

    /// 测试用的空 AppState（监督为空不干预，插件未注册监督器时跳过检查）。
    fn test_state() -> AppState {
        use std::sync::{Arc, Mutex};
        use hp_media::ThumbnailCache;
        use hp_ai::AiTaggingService;
        use hp_plugin_host::SupervisionRegistry;
        use hp_scanner::Scanner;
        use crate::tasks::TaskRegistry;
        AppState {
            global_db: Arc::new(Mutex::new(None)),
            open_repo: Arc::new(Mutex::new(None)),
            current_repo_id: Arc::new(Mutex::new(None)),
            current_repo_path: Arc::new(Mutex::new(None)),
            tasks: Arc::new(TaskRegistry::new()),
            scanner: Arc::new(Scanner::new()),
            ffmpeg_bin: Arc::new(None),
            ffprobe_bin: Arc::new(None),
            thumb_cache: Arc::new(ThumbnailCache::new(std::path::PathBuf::from("Z:/none"))),
            media: Arc::new(Mutex::new(None)),
            media_embed: Arc::new(Mutex::new(None)),
            plugin_root: Arc::new(std::path::PathBuf::from("Z:/none")),
            panel_schema_cache: Arc::new(Mutex::new(hp_plugin_host::PanelSchemaCache::new())),
            supervision: Arc::new(Mutex::new(SupervisionRegistry::new())),
            ai: Arc::new(Mutex::new(AiTaggingService::new())),
        }
    }

    /// 未在 manifest `data_queries` 里声明的查询名 = **硬错误**（控件标准第 5 节）。
    #[test]
    fn undeclared_bind_name_is_a_hard_error() {
        let owner = owner_with_queries(&["colors"]);
        let s = test_state();
        let err = fetch_panel_data(&s, &owner, "p.panel", None, &[bind("panel", "ghost")])
            .expect_err("未声明的查询名应失败");
        assert!(matches!(err, HpError::InvalidArgument(_)), "应为参数类错误: {err:?}");
        assert!(err.to_string().contains("ghost"), "应指出是哪个名字: {err}");

        // 声明过的名字通过校验，随后才因**入口不存在**失败（证明失败点在校验之后）。
        let err = fetch_panel_data(&s, &owner, "p.panel", None, &[bind("panel", "colors")])
            .expect_err("入口不存在应失败");
        assert!(err.to_string().contains("入口不存在"), "应是入口问题: {err}");
    }

    /// `bind.kind` 是闭集：`repo` 属规范里的"开放点"，第一版必须拒绝。
    #[test]
    fn bind_kind_is_a_closed_set() {
        let owner = owner_with_queries(&["colors"]);
        let s = test_state();
        let err = fetch_panel_data(&s, &owner, "p.panel", None, &[bind("repo", "colors")])
            .expect_err("repo 类第一版不应开放");
        assert!(matches!(err, HpError::InvalidArgument(_)));
        assert!(err.to_string().contains("bind.kind 非法"), "应指出 kind 问题: {err}");
    }

    /// 没有 `bind` 时**不起进程**：即使入口不存在也必须成功返回空结果。
    #[test]
    fn empty_binds_never_spawn_a_process() {
        let owner = owner_with_queries(&["colors"]);
        let s = test_state();
        let item = fetch_panel_data(&s, &owner, "p.panel", None, &[])
            .expect("无 bind 不该因为入口缺失而失败——它根本不该起进程");
        assert!(item.results.is_empty());
        assert!(item.missing.is_empty());
        assert_eq!(item.plugin_id, "dev.hamsterpouch.test");
    }
}
