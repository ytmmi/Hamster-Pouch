//! MCP 协议层：把 JSON-RPC 方法名分发到具体处理，并给出 `initialize` 的协商结果。
//!
//! 只实现本服务需要的子集（MCP 规范允许服务端只声明自己支持的能力）：
//!
//! - `initialize` / `notifications/initialized`：握手；
//! - `ping`：保活；
//! - `tools/list` / `tools/call`：工具能力（[`crate::mcp::tools`]）；
//! - `notifications/cancelled`：客户端取消，本服务同步执行、无需中断，直接接受；
//! - 其余方法一律 `METHOD_NOT_FOUND`，让客户端知道"这里没有这个能力"，
//!   而不是假装成功。
//!
//! **没有**声明 `resources`、`prompts`、`sampling`、`roots`——本服务的定位是
//! 让外部模型读写仓鼠颊里的数据，不需要反向索取宿主上下文。

use serde_json::{Value, json};

use super::jsonrpc::{
    INTERNAL_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, Request, Response, RpcError,
};
use super::tools;

/// 本服务实现的协议版本。
///
/// MCP 的版本协商规则是"客户端提，服务端答自己支持的那个"；只答一个版本
/// 就意味着不兼容的客户端会看到明确的版本号而不是诡异的行为差异。
pub(crate) const PROTOCOL_VERSION: &str = "2025-06-18";

/// 服务名（出现在 `initialize` 结果的 `serverInfo` 里）。
pub(crate) const SERVER_NAME: &str = "hamster-pouch";

/// 处理一条请求，返回应当回给客户端的响应；通知返回 `None`。
pub(crate) fn dispatch(
    app: &tauri::AppHandle,
    allow_write: bool,
    request: &Request,
) -> Option<Response> {
    if !request.is_valid() {
        let id = request.id.clone().unwrap_or(Value::Null);
        return Some(Response::err(
            id,
            RpcError::new(INVALID_REQUEST, "不是合法的 JSON-RPC 2.0 请求"),
        ));
    }

    // 通知（无 id）不回包。
    if request.is_notification() {
        return None;
    }
    let id = request.id.clone().unwrap_or(Value::Null);

    let result = match request.method.as_str() {
        "initialize" => Ok(initialize_result()),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list_result()),
        "tools/call" => call_tool(app, allow_write, request.params_object()),
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("本服务未实现方法: {other}"),
        )),
    };

    Some(match result {
        Ok(value) => Response::ok(id, value),
        Err(error) => Response::err(id, error),
    })
}

/// `tools/list` 的返回体：工具表 + 读写标注。
///
/// `annotations` 让客户端能区分"只读"与"会改数据"，不必靠工具名的语感判断。
fn tools_list_result() -> Value {
    json!({
        "tools": tools::list()
            .into_iter()
            .map(|spec| json!({
                "name": spec.name,
                "title": spec.title,
                "description": spec.description,
                "inputSchema": spec.schema,
                "annotations": {
                    "readOnlyHint": !spec.write,
                    "destructiveHint": spec.write,
                },
            }))
            .collect::<Vec<_>>(),
    })
}

/// `initialize` 的返回体：能力声明 + 服务信息 + 使用提示。
fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            // 只有工具能力；`listChanged: false` 表示工具表在运行期不变
            // （开关只影响工具能否执行，不增删工具）。
            "tools": { "listChanged": false },
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "title": "仓鼠颊 Hamster Pouch",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "仓鼠颊是本机资源管理软件。这里的工具作用在「当前在应用里打开的仓库」上：\
    先用 repo_current 确认仓库，再用 file_query / source_tree / tag_tree 了解内容。\
    写操作（重命名、移入回收站、复制、移动、打标、评分、相册增删）需要用户在设置里打开「允许写操作」。\
    文件用 fileId（稳定 ID）标识，不是路径；需要绝对路径时用 file_path。",
    })
}

/// `tools/call`：取 `name` 与 `arguments`，交给工具层执行。
fn call_tool(app: &tauri::AppHandle, allow_write: bool, params: &Value) -> Result<Value, RpcError> {
    let (name, arguments) = validate_tool_call(params)?;
    // 工具层的 RpcError 直接透传（未知工具 / 参数形状不对）。
    tools::call(app, allow_write, &name, &arguments)
}

/// `tools/call` 的参数校验（**不碰 `AppState`**，因此可独立测试）。
///
/// 返回 `(工具名, 参数对象)`；参数缺省按空对象处理。
fn validate_tool_call(params: &Value) -> Result<(String, Value), RpcError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(super::jsonrpc::INVALID_PARAMS, "缺少参数 name（工具名）"))?
        .to_string();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() && !arguments.is_null() {
        return Err(RpcError::new(
            super::jsonrpc::INVALID_PARAMS,
            "参数 arguments 必须是对象",
        ));
    }
    Ok((name, arguments))
}

/// 供 HTTP 层在请求体无法解析成 [`Request`] 时构造错误响应。
pub(crate) fn parse_error_response(id: Value) -> Response {
    Response::err(
        id,
        RpcError::new(super::jsonrpc::PARSE_ERROR, "请求体不是合法 JSON"),
    )
}

/// 供 HTTP 层在方法分发抛出内部错误时兜底。
#[allow(dead_code)]
pub(crate) fn internal_error_response(id: Value, message: impl Into<String>) -> Response {
    Response::err(id, RpcError::new(INTERNAL_ERROR, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 协议版本是**具体日期串**，不是 `"latest"` 一类模糊值：
    /// 客户端靠它判断能否对接，答模糊值等于没答。
    #[test]
    fn protocol_version_is_a_concrete_dated_revision() {
        assert_eq!(PROTOCOL_VERSION, "2025-06-18");
    }

    /// `initialize` 必须声明工具能力，且**不**声明本服务没有的能力
    /// （`resources` / `prompts` / `sampling` / `roots` 一律不许出现）。
    #[test]
    fn initialize_declares_only_the_tools_capability() {
        let result = initialize_result();
        let capabilities = result
            .get("capabilities")
            .and_then(Value::as_object)
            .expect("initialize 必须给出 capabilities");
        assert!(capabilities.contains_key("tools"), "必须声明 tools 能力");
        for absent in ["resources", "prompts", "sampling", "roots", "logging"] {
            assert!(
                !capabilities.contains_key(absent),
                "不得声明未实现的能力: {absent}"
            );
        }
        // 工具表在运行期不变（开关只影响能否执行，不增删工具）。
        assert_eq!(result["capabilities"]["tools"]["listChanged"], json!(false));
    }

    /// 服务信息三件套齐全，且版本取自 `CARGO_PKG_VERSION`（不手写）。
    #[test]
    fn initialize_reports_server_identity() {
        let result = initialize_result();
        assert_eq!(result["serverInfo"]["name"], json!(SERVER_NAME));
        assert_eq!(
            result["serverInfo"]["version"],
            json!(env!("CARGO_PKG_VERSION"))
        );
        let instructions = result["instructions"]
            .as_str()
            .expect("instructions 必须是字符串");
        // 使用提示要讲清三件容易踩的事：作用在当前仓库、写操作需开关、文件用 ID。
        assert!(instructions.contains("repo_current"), "要提示先确认仓库");
        assert!(instructions.contains("允许写操作"), "要提示写操作开关");
        assert!(instructions.contains("fileId"), "要提示文件用 ID 而非路径");
    }

    /// `tools/list` 的每一项都必须有四个字段，且 `annotations` 与 `write` 反向对应。
    #[test]
    fn tools_list_marks_read_and_write_annotations() {
        let result = tools_list_result();
        let tools = result["tools"].as_array().expect("tools 必须是数组");
        assert_eq!(tools.len(), super::tools::list().len());
        for tool in tools {
            for field in ["name", "title", "description", "inputSchema", "annotations"] {
                assert!(
                    tool.get(field).is_some(),
                    "工具 {:?} 缺少字段 {field}",
                    tool.get("name")
                );
            }
            let write = tool["annotations"]["destructiveHint"] == json!(true);
            assert_eq!(
                tool["annotations"]["readOnlyHint"],
                json!(!write),
                "readOnlyHint 必须与 destructiveHint 互斥"
            );
        }
    }

    // ===== 分发前的参数校验（不依赖 AppState） =====

    /// 构造一条请求。
    fn request(id: Option<Value>, method: &str, params: Option<Value>) -> Request {
        Request {
            jsonrpc: Some("2.0".to_string()),
            id,
            method: method.to_string(),
            params,
        }
    }

    /// 通知（无 `id`）一律不回包——这一判定发生在分发最前面，不需要 AppState。
    #[test]
    fn notifications_are_recognised_before_dispatch() {
        for method in [
            "notifications/initialized",
            "initialize",
            "tools/list",
            "ping",
        ] {
            let req = request(None, method, None);
            assert!(req.is_notification(), "无 id 必须判为通知: {method}");
        }
        assert!(!request(Some(json!(1)), "ping", None).is_notification());
    }

    /// `jsonrpc` 填了非法值 → 必须判为不合法（走 `INVALID_REQUEST`）。
    #[test]
    fn invalid_jsonrpc_versions_are_rejected() {
        let bad = Request {
            jsonrpc: Some("1.0".to_string()),
            id: Some(json!(9)),
            method: "ping".to_string(),
            params: None,
        };
        assert!(!bad.is_valid(), "1.0 不是 JSON-RPC 2.0");
        // 缺省 jsonrpc 按 2.0 宽容处理（有的客户端不发这个字段）。
        assert!(request(Some(json!(1)), "ping", None).is_valid());
        // 空方法名不合法。
        assert!(!request(Some(json!(1)), "", None).is_valid());
    }

    /// `tools/call` 缺 `name` / `arguments` 不是对象 → `-32602`。
    #[test]
    fn tool_call_arguments_are_validated() {
        let err = validate_tool_call(&json!({})).expect_err("缺 name 必须报错");
        assert_eq!(err.code, super::super::jsonrpc::INVALID_PARAMS);

        let err = validate_tool_call(&json!({ "name": "repo_list", "arguments": 3 }))
            .expect_err("arguments 非对象必须报错");
        assert_eq!(err.code, super::super::jsonrpc::INVALID_PARAMS);

        // 参数缺省 → 空对象（工具自己判必填）。
        let (name, args) = validate_tool_call(&json!({ "name": "repo_current" }))
            .expect("缺 arguments 应视为空对象");
        assert_eq!(name, "repo_current");
        assert_eq!(args, json!({}));

        let (_, args) = validate_tool_call(&json!({ "name": "file_query", "arguments": null }))
            .expect("null 也应视为空对象");
        assert_eq!(args, Value::Null);
    }
}
