//! JSON-RPC 2.0 消息类型与错误码（MCP 传输层的唯一编解码处）。
//!
//! 只做**结构**与**错误码**，不含任何业务分发——分发在 [`crate::mcp::protocol`]。
//! 这样传输层（[`crate::mcp::http`]）与协议层可以各自独立测试。

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// JSON 解析失败（不是合法 JSON）。
pub(crate) const PARSE_ERROR: i64 = -32700;
/// JSON 合法但不是合法 JSON-RPC 请求。
pub(crate) const INVALID_REQUEST: i64 = -32600;
/// 方法不存在。
pub(crate) const METHOD_NOT_FOUND: i64 = -32601;
/// 参数不合法。
pub(crate) const INVALID_PARAMS: i64 = -32602;
/// 服务端内部错误。
pub(crate) const INTERNAL_ERROR: i64 = -32603;

/// 单条 JSON-RPC 请求 / 通知。
///
/// `id` 缺省即**通知**（服务端不得回包）；`params` 允许缺省。
#[derive(Debug, Deserialize)]
pub(crate) struct Request {
    /// 协议版本，MCP 客户端一律发 `"2.0"`；这里不强制校验（宽容解析，
    /// 非法值由 [`Request::is_valid`] 判为 `INVALID_REQUEST`）。
    #[serde(default)]
    pub(crate) jsonrpc: Option<String>,
    /// 请求 id；`null` 与缺省都视为通知。
    #[serde(default)]
    pub(crate) id: Option<Value>,
    /// 方法名。
    pub(crate) method: String,
    /// 参数对象。
    #[serde(default)]
    pub(crate) params: Option<Value>,
}

impl Request {
    /// 是否满足 JSON-RPC 2.0 的最低要求（`jsonrpc` 缺省时按 2.0 宽容处理）。
    pub(crate) fn is_valid(&self) -> bool {
        match self.jsonrpc.as_deref() {
            None | Some("2.0") => !self.method.is_empty(),
            Some(_) => false,
        }
    }

    /// 是否为通知（无 `id`）。
    pub(crate) fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    /// 取参数对象；缺省按空对象处理。
    pub(crate) fn params_object(&self) -> &Value {
        static EMPTY: Value = Value::Null;
        self.params.as_ref().unwrap_or(&EMPTY)
    }
}

/// JSON-RPC 错误体。
#[derive(Debug, Serialize)]
pub(crate) struct RpcError {
    /// 错误码（见本模块常量）。
    pub(crate) code: i64,
    /// 错误说明。
    pub(crate) message: String,
    /// 附加数据（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) data: Option<Value>,
}

impl RpcError {
    /// 构造错误体。
    pub(crate) fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// JSON-RPC 响应。
///
/// `result` 与 `error` 互斥：成功只带 `result`，失败只带 `error`。
#[derive(Debug, Serialize)]
pub(crate) struct Response {
    /// 恒为 `"2.0"`。
    pub(crate) jsonrpc: &'static str,
    /// 回显请求 id。
    pub(crate) id: Value,
    /// 成功结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<Value>,
    /// 失败原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<RpcError>,
}

impl Response {
    /// 成功响应。
    pub(crate) fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    /// 失败响应。
    pub(crate) fn err(id: Value, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(error),
        }
    }
}
