//! 控件 schema 运行时通道的边界用例（`docs/spec/control-standard.md` 第 2 节 / D61 / 缺陷 0008 同批）。
//!
//! 全部走**真子进程**（`src/bin/fake_panel_plugin.rs` 夹具），因此"超时/输出超限/
//! 协议错/进程静默"这些路径不是靠 mock 假装，而是真的发生了。

use std::process::Command;
use std::time::Duration;

use hp_core::HpError;
use hp_plugin_host::{
    ExternalProcessQuery, PanelSchemaKey, PanelSchemaParams, PANEL_SCHEMA_REQUEST,
    SCHEMA_MAX_BYTES, SCHEMA_QUERY_TIMEOUT,
};

/// 按夹具模式构造一条查询命令。
fn fixture(mode: &str) -> ExternalProcessQuery {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fake_panel_plugin"));
    command.env("HP_SCHEMA_FIXTURE_MODE", mode);
    ExternalProcessQuery::for_test_command(command)
}

fn params() -> PanelSchemaParams {
    PanelSchemaParams::new("plugin.dev.hamsterpouch.example.hello.hello.panel", 1)
}

fn query(mode: &str, timeout: Duration) -> Result<String, HpError> {
    fixture(mode).query(&params(), timeout, SCHEMA_MAX_BYTES)
}

#[test]
fn request_name_timeout_and_byte_cap_follow_the_spec() {
    assert_eq!(PANEL_SCHEMA_REQUEST, "ui.panel.schema");
    assert_eq!(SCHEMA_QUERY_TIMEOUT, Duration::from_secs(2));
    assert_eq!(SCHEMA_MAX_BYTES, 256 * 1024);
}

#[test]
fn external_process_returns_the_panel_schema() {
    let text = query("ok", SCHEMA_QUERY_TIMEOUT).expect("夹具应返回合法 schema");
    assert!(text.contains("\"kind\":\"column\""), "意外输出: {text}");
    assert!(text.contains("hello.hello.panel"), "面板 id 应回显: {text}");
}

#[test]
fn string_result_is_passed_through_verbatim() {
    let text = query("string_result", SCHEMA_QUERY_TIMEOUT).expect("字符串 result 也是合法形态");
    assert!(text.starts_with('{') && text.contains("\"root\""));
}

#[test]
fn request_carries_the_unified_method_and_params() {
    let text = query("echo_params", SCHEMA_QUERY_TIMEOUT).expect("回显失败");
    // 三种运行形态共用同一请求名；参数是 `{ panel_id, api_version }`。
    assert!(text.contains("hello.hello.panel"), "缺 panel_id: {text}");
    assert!(text.contains("\"api_version\":1"), "缺 api_version: {text}");
}

#[test]
fn rpc_error_is_a_plugin_error() {
    let err = query("rpc_error", SCHEMA_QUERY_TIMEOUT).expect_err("JSON-RPC error 应失败");
    assert!(matches!(err, HpError::Plugin(_)), "应为 Plugin 类错误: {err:?}");
    assert_eq!(err.code(), "plugin");
    assert!(err.to_string().contains("未实现"), "应带上插件给的说明: {err}");
}

#[test]
fn output_over_the_byte_cap_is_rejected() {
    // 夹具故意输出 300 KiB（> 256 KiB）：宿主必须判失败，而不是把巨量数据带进渲染层。
    let err = query("huge", SCHEMA_QUERY_TIMEOUT).expect_err("超限输出应失败");
    assert!(matches!(err, HpError::Plugin(_)));
    assert!(err.to_string().contains("上限"), "应说明超限: {err}");
}

#[test]
fn slow_plugin_hits_the_timeout_and_does_not_hang() {
    // 夹具睡 5s；用 300ms 超时代表 2s 口径，避免每次测试都真等 2s。
    let started = std::time::Instant::now();
    let err = query("slow", Duration::from_millis(300)).expect_err("超时应失败");
    assert!(matches!(err, HpError::Plugin(_)));
    assert!(err.to_string().contains("超时"), "应说明超时: {err}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "超时必须按时返回（实际耗时 {:?}）",
        started.elapsed()
    );
}

#[test]
fn silent_or_garbage_output_is_rejected() {
    let silent = query("silent", SCHEMA_QUERY_TIMEOUT).expect_err("无输出应失败");
    assert!(matches!(silent, HpError::Plugin(_)));
    let garbage = query("garbage", SCHEMA_QUERY_TIMEOUT).expect_err("非 JSON 应失败");
    assert!(matches!(garbage, HpError::Plugin(_)));
}

#[test]
fn schema_cache_is_keyed_by_plugin_panel_and_version() {
    let mut cache = hp_plugin_host::PanelSchemaCache::new();
    let key = PanelSchemaKey::new("dev.hamsterpouch.example.hello", "panel.a", "0.1.0");
    assert!(cache.get(&key).is_none(), "未命中应先回源");
    cache.put(key.clone(), "{\"root\":{}}".into());
    assert_eq!(cache.get(&key).as_deref(), Some("{\"root\":{}}"));
    // 版本变化 → 键变化 → 自然失效。
    assert!(cache
        .get(&PanelSchemaKey::new("dev.hamsterpouch.example.hello", "panel.a", "0.2.0"))
        .is_none());
    // 插件重载/禁用 → 主动失效。
    cache.invalidate_plugin("dev.hamsterpouch.example.hello");
    assert!(cache.is_empty());
}
