//! **测试夹具**：模拟 `external-process` 插件对 `ui.panel.schema` 的应答。
//!
//! 这**不是产品二进制**——它是 `tests/` 里控件 schema 运行时通道用例的被测对端，
//! 靠 `HP_SCHEMA_FIXTURE_MODE` 选择行为，让"超时/超限/协议错/进程异常"这些
//! **边界路径**都能用真子进程确定性地复现（而不是只测一个 mock）。
//!
//! 协议：从 stdin 读**一行** JSON-RPC 请求，向 stdout 写**一行**响应。
//!
//! | `HP_SCHEMA_FIXTURE_MODE` | 行为 |
//! | --- | --- |
//! | `ok`（默认） | 返回 `api_version = 1` 的最小合法 schema（`result` 为对象） |
//! | `string_result` | 同上，但 `result` 是**包含 JSON 的字符串**（另一种合法形态） |
//! | `echo_params` | 把请求 `params` 原样作为 `result` 回显（用于断言请求形状） |
//! | `rpc_error` | 返回 JSON-RPC `error` |
//! | `huge` | 返回超过 256 KiB 的 `result`（触发输出上限） |
//! | `slow` | 睡 5s 再返回（触发 2s 超时） |
//! | `garbage` | 输出一行非 JSON 文本 |
//! | `silent` | 不输出任何内容并退出（stdout 直接关闭） |

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn main() {
    let mode = std::env::var("HP_SCHEMA_FIXTURE_MODE").unwrap_or_else(|_| "ok".to_string());

    let mut request = String::new();
    let read = std::io::stdin().lock().read_line(&mut request).is_ok();
    let params = serde_json::from_str::<Value>(request.trim())
        .ok()
        .and_then(|v| v.get("params").cloned())
        .unwrap_or(Value::Null);
    let panel_id = params
        .get("panel_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown.panel")
        .to_string();

    match mode.as_str() {
        "silent" => return,
        "garbage" => {
            emit_line("这不是 JSON-RPC");
            return;
        }
        "slow" => {
            std::thread::sleep(std::time::Duration::from_secs(5));
            emit_json(&ok_response(&panel_id, Some(Value::String(schema_text(&panel_id)))));
            return;
        }
        "rpc_error" => {
            emit_json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "error": { "code": -32601, "message": "夹具：插件未实现 ui.panel.schema" },
            }));
            return;
        }
        "huge" => {
            // 超过 256 KiB 的输出：宿主必须判失败，而不是把巨量数据带进渲染层。
            let blob = "x".repeat(300 * 1024);
            emit_json(&ok_response(&panel_id, Some(Value::String(blob))));
            return;
        }
        "echo_params" => {
            if !read {
                emit_json(&json!({ "jsonrpc": "2.0", "id": 1, "result": Value::Null }));
                return;
            }
            emit_json(&ok_response(&panel_id, Some(params)));
            return;
        }
        "string_result" => {
            emit_json(&ok_response(
                &panel_id,
                Some(Value::String(schema_text(&panel_id))),
            ));
            return;
        }
        _ => {
            // `ok`：`result` 直接是 schema 对象。
            emit_json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "api_version": 1,
                    "panel_id": panel_id,
                    "root": {
                        "id": "root",
                        "kind": "column",
                        "children": [
                            { "id": "title", "kind": "text", "text_key": "fixture.title" }
                        ]
                    }
                }
            }));
        }
    }
}

/// 最小合法 schema 的 JSON 文本（`result` 为字符串时使用）。
fn schema_text(panel_id: &str) -> String {
    json!({
        "api_version": 1,
        "panel_id": panel_id,
        "root": {
            "id": "root",
            "kind": "column",
            "children": [{ "id": "title", "kind": "text", "text_key": "fixture.title" }]
        }
    })
    .to_string()
}

fn ok_response(panel_id: &str, result: Option<Value>) -> Value {
    let result = result.unwrap_or_else(|| Value::String(schema_text(panel_id)));
    json!({ "jsonrpc": "2.0", "id": 1, "result": result })
}

fn emit_json(value: &Value) {
    emit_line(&value.to_string());
}

fn emit_line(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}
