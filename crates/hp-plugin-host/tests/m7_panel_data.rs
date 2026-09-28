//! 面板**取数**通道（`ui.panel.query`，控件标准第 5 节）的边界用例。
//!
//! 与 `m6_control_channel.rs` 同口径：全部走**真子进程**夹具
//! （`src/bin/fake_panel_plugin.rs`），因此超时/超限/协议错是**真的**发生了，
//! 而不是 mock 假装。
//!
//! 这一层只验**协议与宿主侧约束**；"声明校验 / 快照装配 / 前端渲染"在桥接层与前端。

use std::process::Command;
use std::time::Duration;

use hp_core::HpError;
use hp_plugin_host::{
    ExternalProcessQuery, PanelQueryParams, PanelQuerySpec, PanelSelectionContext,
    PANEL_QUERY_REQUEST, QUERY_MAX_BYTES, QUERY_TIMEOUT,
};

/// 按夹具模式构造一条取数命令。
fn fixture(mode: &str) -> ExternalProcessQuery {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fake_panel_plugin"));
    command.env("HP_SCHEMA_FIXTURE_MODE", mode);
    ExternalProcessQuery::for_test_command(command)
}

/// 一个含两种 `kind` 的典型请求：`panel` 行集 + `selection` 对象，另带标量参数。
fn params(selected: Option<&str>) -> PanelQueryParams {
    PanelQueryParams::new(
        "plugin.dev.hamsterpouch.system.palette.palette.panel",
        1,
        selected.map(PanelSelectionContext::new),
        vec![
            PanelQuerySpec::new("panel", "colors", Some(serde_json::json!({ "max": 12 }))),
            PanelQuerySpec::new("selection", "current", None),
        ],
    )
}

fn query(mode: &str, selected: Option<&str>, timeout: Duration) -> Result<String, HpError> {
    fixture(mode)
        .query_panel_data(&params(selected), timeout, QUERY_MAX_BYTES)
}

#[test]
fn request_name_and_limits_are_the_spec_constants() {
    assert_eq!(PANEL_QUERY_REQUEST, "ui.panel.query");
    // 与 schema 同口径：2s / 256 KiB（控件标准第 5 节的降级口径）。
    assert_eq!(QUERY_TIMEOUT, Duration::from_secs(2));
    assert_eq!(QUERY_MAX_BYTES, 256 * 1024);
    assert_eq!(QUERY_TIMEOUT, hp_plugin_host::SCHEMA_QUERY_TIMEOUT);
    assert_eq!(QUERY_MAX_BYTES, hp_plugin_host::SCHEMA_MAX_BYTES);
}

#[test]
fn one_request_carries_every_bind_with_host_built_snapshot_keys() {
    // "一次问完"：两个 bind 必须在**同一个**请求里，且 key 是宿主构造的 `kind:name`。
    let text = query("echo_params", Some("file-42"), QUERY_TIMEOUT).expect("夹具应回显参数");
    assert!(text.contains("\"key\":\"panel:colors\""), "缺 panel:colors 键: {text}");
    assert!(text.contains("\"key\":\"selection:current\""), "缺 selection:current 键: {text}");
    assert!(text.contains("\"panel_id\""), "缺 panel_id: {text}");
    assert!(text.contains("\"api_version\":1"), "缺 api_version: {text}");
    // 标量 args 原样透传。
    assert!(text.contains("\"max\":12"), "缺 bind args: {text}");
}

#[test]
fn selection_context_reaches_the_plugin() {
    let text = query("echo_params", Some("file-42"), QUERY_TIMEOUT).expect("回显失败");
    assert!(
        text.contains("\"selection\":{\"file_id\":\"file-42\"}"),
        "选中上下文应过到插件: {text}"
    );
}

#[test]
fn no_selection_is_omitted_rather_than_sent_as_empty_object() {
    let text = query("echo_params", None, QUERY_TIMEOUT).expect("回显失败");
    // 注意判据是**字段**而不是子串：`queries` 里本来就有 `"selection:current"` 键与
    // `"kind":"selection"`，只搜 "selection" 会恒真。
    assert!(
        !text.contains("\"selection\":{"),
        "未选中时不应出现 selection 字段（插件据此区分「没选中」）: {text}"
    );
}

#[test]
fn results_come_back_keyed_by_the_host_snapshot_key() {
    let text = query("ok", Some("file-42"), QUERY_TIMEOUT).expect("夹具应返回结果");
    // `panel` 类 → 行集；`selection` 类 → 对象（并回显 file_id）。
    assert!(text.contains("\"panel:colors\""), "缺结果键: {text}");
    assert!(text.contains("\"selection:current\""), "缺结果键: {text}");
    assert!(text.contains("\"kind\":\"rows\""), "panel 类应为行集: {text}");
    assert!(text.contains("file-42"), "selection 类应看到选中文件: {text}");
}

#[test]
fn missing_result_key_is_not_an_error() {
    // `data_partial` 漏掉第一个键：宿主层不判错（缺的键按"空结果"渲染空态），
    // 因此这里必须**成功**返回，由调用方决定渲染。
    let text = query("data_partial", Some("file-42"), QUERY_TIMEOUT).expect("漏键不应让协议层失败");
    assert!(!text.contains("panel:colors"), "第一个键本应缺席: {text}");
    assert!(text.contains("selection:current"), "其余键应照常返回: {text}");
}

#[test]
fn empty_results_object_is_not_an_error() {
    let text = query("data_empty", None, QUERY_TIMEOUT).expect("空结果不是错误");
    assert!(text.contains("\"results\":{}"), "意外输出: {text}");
}

#[test]
fn rpc_error_is_a_plugin_error() {
    let err = query("rpc_error", None, QUERY_TIMEOUT).expect_err("JSON-RPC error 应失败");
    assert!(matches!(err, HpError::Plugin(_)), "应为 Plugin 类错误: {err:?}");
    assert_eq!(err.code(), "plugin");
    assert!(err.to_string().contains("未实现"), "应带上插件给的说明: {err}");
}

#[test]
fn output_over_the_byte_cap_is_rejected() {
    let err = query("huge", None, QUERY_TIMEOUT).expect_err("超限输出应失败");
    assert!(matches!(err, HpError::Plugin(_)));
    assert!(err.to_string().contains("上限"), "应说明超限: {err}");
    // 报文里要能看出是**哪条**请求超限（取数与 schema 共用一条通道）。
    assert!(err.to_string().contains("ui.panel.query"), "应标明请求名: {err}");
}

#[test]
fn slow_plugin_hits_the_timeout_and_does_not_hang() {
    // 夹具睡 5s；用 300ms 代表 2s 口径，避免每次测试都真等 2s。
    let started = std::time::Instant::now();
    let err = query("slow", None, Duration::from_millis(300)).expect_err("超时应失败");
    assert!(matches!(err, HpError::Plugin(_)));
    assert!(err.to_string().contains("超时"), "应说明超时: {err}");
    assert!(err.to_string().contains("ui.panel.query"), "应标明请求名: {err}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "超时路径不得把 300ms 拖成更久: {:?}",
        started.elapsed()
    );
}

#[test]
fn silent_plugin_fails_instead_of_hanging() {
    let err = query("silent", None, QUERY_TIMEOUT).expect_err("stdout 关闭应失败");
    assert!(matches!(err, HpError::Plugin(_)));
}

#[test]
fn garbage_output_is_rejected() {
    let err = query("garbage", None, QUERY_TIMEOUT).expect_err("非 JSON 应失败");
    assert!(matches!(err, HpError::Plugin(_)));
}

/// 夹具的默认 schema 也**当示例插件用**（`plugins/examples/control-demo/`）。
/// 这里用 hp-core 的**真**校验器复算一遍：声明名与 schema 里的 `bind` / `visible_when` /
/// `on` 必须完全对得上，否则真机打开面板只会看到一个校验错误态，
/// 而"示例不能用"会被误当成"取数通道坏了"。
#[test]
fn demo_schema_passes_the_real_validator_with_the_demo_manifest_declarations() {
    // 注意：这里要的是 **schema** 请求（`ui.panel.schema`），不是取数请求——
    // 本文件的 `query()` 走的是 `ui.panel.query`，拿不到 schema。
    const PANEL: &str = "plugin.dev.hamsterpouch.system.palette.palette.panel";
    let text = fixture("ok")
        .query(
            &hp_plugin_host::PanelSchemaParams::new(PANEL, 1),
            QUERY_TIMEOUT,
            QUERY_MAX_BYTES,
        )
        .expect("夹具应返回 schema");
    let schema = hp_core::ControlSchema::from_json(&text).expect("示例 schema 应可解析");
    let ctx = hp_core::ControlValidateCtx {
        expected_panel_id: Some(PANEL.into()),
        declared_queries: vec!["items".into(), "summary".into(), "count".into()],
        declared_events: vec!["apply".into(), "pick".into()],
    };
    let result = schema.validate(&ctx);
    assert!(
        result.errors.is_empty(),
        "示例 schema 不该有硬错误（真机上会表现为面板打不开）: {:?}",
        result.errors
    );

    // 三种 returns 各有一个 bind —— 少一种，真机测试就覆盖不到那条形态。
    for name in ["items", "summary", "count"] {
        assert!(
            text.contains(&format!("\"name\":\"{name}\"")),
            "示例 schema 缺少 bind：{name}"
        );
    }
    assert!(text.contains("\"visible_when\""), "示例应带一个 visible_when");
    assert!(text.contains("\"on\""), "示例应带事件映射");
}
