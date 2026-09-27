//! 控件 schema 的**运行时通道**（`docs/spec/control-standard.md` 第 2 节 / D61）。
//!
//! 控件树**不落库、也不写在 manifest 里**：宿主在需要渲染时向插件查询一次
//! （请求名 [`PANEL_SCHEMA_REQUEST`]）。三种运行形态共用同一请求名，本模块先落地
//! `external-process`（示例与系统插件的运行形态）：
//!
//! ```text
//! 宿主 ── 写一行 JSON-RPC 请求 ──▶ 插件子进程 stdin
//! 宿主 ◀── 读一行 JSON-RPC 响应 ── 插件子进程 stdout
//! ```
//!
//! 宿主侧约束（D61，全部为**硬约束**，不靠插件自觉）：
//! - 单次查询超时 [`SCHEMA_QUERY_TIMEOUT`]（2s）：超时即杀掉子进程并判失败；
//! - 单次查询输出字节上限 [`SCHEMA_MAX_BYTES`]（256 KiB）：超限即判失败；
//! - 失败由**调用方**降级为错误态控件并广播 `plugin.error`（本模块只如实报错）；
//! - 查询结果按 `(plugin_id, panel_id, plugin_version)` 缓存（[`PanelSchemaCache`]），
//!   插件重载或版本变化即失效。
//!
//! 一次一问一答：每次查询起一个子进程，收到第一行非空输出后立即收尾（杀掉并回收），
//! 因此不存在跨查询的进程状态、也不会因为面板多开而泄漏句柄。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use hp_core::{HpError, HpResult};
use serde::Serialize;
use serde_json::{json, Value};

/// 三种运行形态统一的请求名（D61 / 控件标准第 2 节）。
pub const PANEL_SCHEMA_REQUEST: &str = "ui.panel.schema";

/// 单次面板 schema 查询的超时（D61 默认 2s）。
pub const SCHEMA_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// 单次面板 schema 查询的输出字节上限（D61 默认 256 KiB）。
pub const SCHEMA_MAX_BYTES: usize = 256 * 1024;

/// `ui.panel.schema` 的请求参数（控件标准第 2 节）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PanelSchemaParams {
    pub panel_id: String,
    pub api_version: u32,
}

impl PanelSchemaParams {
    pub fn new(panel_id: impl Into<String>, api_version: u32) -> Self {
        Self {
            panel_id: panel_id.into(),
            api_version,
        }
    }
}

/// schema 缓存的键：`(plugin_id, panel_id, plugin_version)`（D61）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PanelSchemaKey {
    pub plugin_id: String,
    pub panel_id: String,
    pub plugin_version: String,
}

impl PanelSchemaKey {
    pub fn new(
        plugin_id: impl Into<String>,
        panel_id: impl Into<String>,
        plugin_version: impl Into<String>,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            panel_id: panel_id.into(),
            plugin_version: plugin_version.into(),
        }
    }
}

/// 面板 schema 查询结果缓存（D61）。
///
/// **只缓存成功**：失败（超时/超限/协议错）不写缓存，否则一次瞬时故障会被
/// 永久钉住，用户重开面板也拿不到第二次机会。缓存的失效由键本身保证——
/// 键含 `plugin_version`，插件升级即自然失效；插件重载/禁用时调用
/// [`PanelSchemaCache::invalidate_plugin`] 主动清空。
#[derive(Debug, Default)]
pub struct PanelSchemaCache {
    entries: HashMap<PanelSchemaKey, String>,
}

impl PanelSchemaCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取缓存（未命中或上次失败过 → `None`）。
    pub fn get(&self, key: &PanelSchemaKey) -> Option<String> {
        self.entries.get(key).cloned()
    }

    /// 写入成功结果。
    pub fn put(&mut self, key: PanelSchemaKey, schema_json: String) {
        self.entries.insert(key, schema_json);
    }

    /// 清空某插件的全部缓存项（插件重载/禁用/卸载时调用）。
    pub fn invalidate_plugin(&mut self, plugin_id: &str) {
        self.entries.retain(|k, _| k.plugin_id != plugin_id);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// `external-process` 形态的 schema 查询（JSON-RPC over stdio，一次一问一答）。
pub struct ExternalProcessQuery {
    command: Command,
}

impl ExternalProcessQuery {
    /// 按插件入口构造（入口路径由宿主按已安装版本目录解析，不由插件指定）。
    pub fn for_entry(entry: impl Into<PathBuf>) -> Self {
        Self {
            command: Command::new(entry.into()),
        }
    }

    /// 用一条自定义命令构造（**测试夹具用**：模拟插件的应答/超时/超限行为）。
    ///
    /// 生产路径只走 [`ExternalProcessQuery::for_entry`]：入口必须来自宿主解析的
    /// 版本目录，插件无法指定命令行。
    pub fn for_test_command(command: Command) -> Self {
        Self { command }
    }

    /// 发一次查询并读回结果；返回插件给的 schema 文本（字符串或 JSON 文本）。
    ///
    /// 无论成败都会收尾子进程：失败（超时/超限/协议错/进程异常）一律是
    /// [`HpError::Plugin`]，由调用方决定降级方式。
    pub fn query(
        &mut self,
        request: &PanelSchemaParams,
        timeout: Duration,
        max_bytes: usize,
    ) -> HpResult<String> {
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": PANEL_SCHEMA_REQUEST,
            "params": request,
        }))
        .map_err(|e| HpError::Plugin(format!("序列化面板 schema 请求失败: {e}")))?;

        let mut command = &mut self.command;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_console_window(&mut command);

        let mut child = command
            .spawn()
            .map_err(|e| HpError::Plugin(format!("启动插件进程失败: {e}")))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| HpError::Plugin("无法连接插件进程 stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HpError::Plugin("无法连接插件进程 stdout".into()))?;

        // 读线程：std 的管道读没有超时能力，因此把"读"放进独立线程，
        // 主线程用 `recv_timeout` 施加超时；超时后杀掉子进程即可让管道关闭。
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut total = 0usize;
            loop {
                let mut buf = String::new();
                match reader.read_line(&mut buf) {
                    Ok(0) => {
                        let _ = tx.send(Err("插件进程未返回面板 schema（stdout 已关闭）".into()));
                        return;
                    }
                    Ok(n) => {
                        total += n;
                        if total > max_bytes {
                            let _ = tx.send(Err(format!(
                                "面板 schema 输出超过上限 {} KiB",
                                max_bytes / 1024
                            )));
                            return;
                        }
                        let text = buf.trim();
                        if text.is_empty() {
                            continue;
                        }
                        let _ = tx.send(Ok(text.to_string()));
                        return;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("读取插件输出失败: {e}")));
                        return;
                    }
                }
            }
        });

        // 插件若不读 stdin，写失败不应变成"查询失败"：响应才是判据。
        let _ = writeln!(stdin, "{line}");
        let _ = stdin.flush();
        drop(stdin);

        let outcome = match rx.recv_timeout(timeout) {
            Ok(Ok(text)) => decode_response(&text),
            Ok(Err(message)) => Err(HpError::Plugin(message)),
            Err(RecvTimeoutError::Timeout) => Err(HpError::Plugin(format!(
                "面板 schema 查询超时（{} ms）",
                timeout.as_millis()
            ))),
            Err(RecvTimeoutError::Disconnected) => {
                Err(HpError::Plugin("插件输出读取线程异常终止".into()))
            }
        };

        // 一次一问一答：无论成败都收尾（不 join 读线程——子进程被回收后管道即关闭，
        // 它会自行退出；阻塞在此反而可能把超时拖成"卡住"）。
        let _ = child.kill();
        let _ = child.wait();
        drop(reader);
        outcome
    }
}

/// Windows 上以 `CREATE_NO_WINDOW` 启动插件子进程，避免 GUI 程序闪出控制台窗口。
#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

/// 解析一行 JSON-RPC 响应：`result` 是字符串就原样返回，是对象/数组就重新序列化为文本。
///
/// 保持"返回文本"而不是反序列化为结构体：解析层校验在前端（控件标准第 7 节），
/// 宿主只负责把插件给的东西**原样、带边界**地带回来。
fn decode_response(text: &str) -> HpResult<String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| HpError::Plugin(format!("插件返回的不是合法 JSON-RPC: {e}")))?;
    if let Some(error) = value.get("error") {
        if !error.is_null() {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("插件未提供错误说明");
            return Err(HpError::Plugin(format!("插件返回错误: {message}")));
        }
    }
    let result = value
        .get("result")
        .ok_or_else(|| HpError::Plugin("插件响应缺少 result 字段".into()))?;
    match result {
        Value::String(s) => Ok(s.clone()),
        other => Ok(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_accepts_object_and_string_results() {
        assert_eq!(
            decode_response(r#"{"jsonrpc":"2.0","id":1,"result":{"root":{"id":"r"}}}"#).unwrap(),
            r#"{"root":{"id":"r"}}"#
        );
        assert_eq!(
            decode_response(r#"{"jsonrpc":"2.0","id":1,"result":"{\"a\":1}"}"#).unwrap(),
            r#"{"a":1}"#
        );
    }

    #[test]
    fn decode_rejects_rpc_error_and_garbage() {
        let err = decode_response(r#"{"jsonrpc":"2.0","id":1,"error":{"message":"未实现"}}"#)
            .expect_err("JSON-RPC error 应失败");
        assert!(matches!(err, HpError::Plugin(_)));
        assert!(decode_response("not json").is_err());
        assert!(decode_response(r#"{"jsonrpc":"2.0","id":1}"#).is_err());
    }

    #[test]
    fn cache_is_keyed_by_plugin_panel_and_version() {
        let mut cache = PanelSchemaCache::new();
        let key = PanelSchemaKey::new("p1", "panel.a", "0.1.0");
        assert!(cache.get(&key).is_none());
        cache.put(key.clone(), "{}".into());
        assert_eq!(cache.get(&key).as_deref(), Some("{}"));
        // 版本变化即自然失效。
        assert!(cache
            .get(&PanelSchemaKey::new("p1", "panel.a", "0.2.0"))
            .is_none());
        // 插件重载 → 主动失效。
        cache.invalidate_plugin("p1");
        assert!(cache.is_empty());
    }
}
