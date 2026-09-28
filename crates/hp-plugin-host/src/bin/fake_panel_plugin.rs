//! **测试夹具**：模拟 `external-process` 插件对 `ui.panel.schema` 与 `ui.panel.query` 的应答。
//!
//! 这**不是产品二进制**——它是 `tests/` 里控件 schema / 取数通道用例的被测对端，
//! 靠 `HP_SCHEMA_FIXTURE_MODE` 选择行为，让"超时/超限/协议错/进程异常"这些
//! **边界路径**都能用真子进程确定性地复现（而不是只测一个 mock）。
//!
//! 协议：从 stdin 读**一行** JSON-RPC 请求，向 stdout 写**一行**响应。
//! 夹具按请求里的 `method` 分派：`ui.panel.schema` 走 schema 分支，
//! `ui.panel.query` 走取数分支（**两者共用同一套超时/字节上限口径**）。
//!
//! | `HP_SCHEMA_FIXTURE_MODE` | 行为 |
//! | --- | --- |
//! | `ok`（默认） | schema：返回 `api_version = 1` 的最小合法 schema（`result` 为对象）；取数：每个请求键回一个行集 |
//! | `string_result` | 同上，但 `result` 是**包含 JSON 的字符串**（另一种合法形态） |
//! | `echo_params` | 把请求 `params` 原样作为 `result` 回显（用于断言请求形状） |
//! | `rpc_error` | 返回 JSON-RPC `error` |
//! | `huge` | 返回超过 256 KiB 的 `result`（触发输出上限） |
//! | `slow` | 睡 5s 再返回（触发 2s 超时） |
//! | `garbage` | 输出一行非 JSON 文本 |
//! | `silent` | 不输出任何内容并退出（stdout 直接关闭） |
//! | `data_partial` | 取数：**故意漏掉**第一个请求键（宿主应按空结果处理，不报错） |
//! | `data_empty` | 取数：`results` 为空对象（同样是"没数据"，不是错误） |

use std::io::{BufRead, Write};

use serde_json::{json, Map, Value};

fn main() {
    let mode = std::env::var("HP_SCHEMA_FIXTURE_MODE").unwrap_or_else(|_| "ok".to_string());

    let mut request = String::new();
    let read = std::io::stdin().lock().read_line(&mut request).is_ok();
    let parsed = serde_json::from_str::<Value>(request.trim()).ok();
    let method = parsed
        .as_ref()
        .and_then(|v| v.get("method"))
        .and_then(Value::as_str)
        .unwrap_or("ui.panel.schema")
        .to_string();
    let params = parsed
        .as_ref()
        .and_then(|v| v.get("params").cloned())
        .unwrap_or(Value::Null);
    let panel_id = params
        .get("panel_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown.panel")
        .to_string();

    // ── 取数分支（`ui.panel.query`）──
    if method == "ui.panel.query" {
        match mode.as_str() {
            "silent" => return,
            "garbage" => {
                emit_line("这不是 JSON-RPC");
                return;
            }
            "slow" => {
                std::thread::sleep(std::time::Duration::from_secs(5));
                emit_json(&json!({ "jsonrpc": "2.0", "id": 1, "result": { "results": {} } }));
                return;
            }
            "rpc_error" => {
                emit_json(&json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": { "code": -32601, "message": "夹具：插件未实现 ui.panel.query" },
                }));
                return;
            }
            "huge" => {
                let blob = "x".repeat(300 * 1024);
                emit_json(&json!({ "jsonrpc": "2.0", "id": 1, "result": { "results": { "panel:x": { "kind": "scalar", "value": blob } } } }));
                return;
            }
            "echo_params" => {
                emit_json(&json!({ "jsonrpc": "2.0", "id": 1, "result": params }));
                return;
            }
            "data_empty" => {
                emit_json(&json!({ "jsonrpc": "2.0", "id": 1, "result": { "results": {} } }));
                return;
            }
            _ => {
                emit_json(&json!({ "jsonrpc": "2.0", "id": 1, "result": { "results": data_results(&mode, &params) } }));
                return;
            }
        }
    }

    // ── schema 分支（`ui.panel.schema`，原有行为）──
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

/// 按请求里的 `queries` 逐键回填结果（夹具的"正常"行为）。
///
/// `panel` 类回行集、`selection` 类回对象（并回显宿主给的 `selection.file_id`，
/// 便于用例断言"选中上下文确实过到了插件"）。
fn data_results(mode: &str, params: &Value) -> Value {
    let queries = params
        .get("queries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = params
        .get("selection")
        .and_then(|s| s.get("file_id"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut results = Map::new();
    for (index, q) in queries.iter().enumerate() {
        // `data_partial`：故意漏掉第一个键——宿主应把它当"空结果"，而不是失败。
        if mode == "data_partial" && index == 0 {
            continue;
        }
        let key = q.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        let kind = q.get("kind").and_then(Value::as_str).unwrap_or("panel");
        let value = if kind == "selection" {
            json!({
                "kind": "object",
                "entries": [
                    { "key": "file_id", "value": selected.clone().unwrap_or_else(|| "none".into()) }
                ]
            })
        } else {
            json!({ "kind": "rows", "rows": [{ "id": "row-1", "text": key }] })
        };
        results.insert(key, value);
    }
    Value::Object(results)
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
