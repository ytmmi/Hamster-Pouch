//! D76 统一响应包装 { ok, data?, error? } 与错误码映射。

use super::prelude::*;

/// **D76 迁移已完成（2026-09）**：桥接层不再需要"把领域错误压成 String"的转换函数。
///
/// 历史上这里是 `hp_err_to_string(e)`，D76 让每条命令都返回 `{ ok, data?, error? }`
/// 并携带 `HpError::code()` 的闭集错误码，因此该函数在 2026-09 最后一批
/// （`repo` / `layout` / `debug.log`）迁移完成后**已无调用方**并删除。
/// 新增命令一律走 [`api_from_hp`] / [`api_async`]；错误文案由前端按 `code` 走 i18n（D27）。
/// **D76 统一响应包装**：`{ ok, data?, error? }`（`docs/spec/commands-events.md` 第 2 节）。
///
/// 全部命令**必须**用这个形状（2026-09 起已全量迁移，无一例外）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

/// **D76 结构化错误**。
///
/// `code` 取闭集 `validation` / `not_found` / `permission` / `plugin` / `io` / `conflict`
/// （来源是 `HpError::code()`）。`message` **仅作诊断**：前端不得直接显示，
/// 必须按 `code` 渲染 i18n 文案（D27：三套语言）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ApiError {
    /// 直接以码 + 诊断串构造（用于**不是** `HpError` 来源的失败，例如桥接层的
    /// 前置条件检查；领域错误一律走 [`ApiError::from_hp`]）。
    #[allow(dead_code)]
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// 领域错误 → 结构化错误（`code` 由 `HpError::code()` 统一给出）。
    pub(crate) fn from_hp(e: HpError) -> Self {
        Self {
            code: e.code().to_string(),
            message: e.to_string(),
            details: None,
        }
    }
}

/// 成功响应。
pub(crate) fn api_ok<T>(data: T) -> ApiResponse<T> {
    ApiResponse {
        ok: true,
        data: Some(data),
        error: None,
    }
}

/// 失败响应。
pub(crate) fn api_err<T>(error: ApiError) -> ApiResponse<T> {
    ApiResponse {
        ok: false,
        data: None,
        error: Some(error),
    }
}

/// `HpResult<T>` → 统一响应包装。
pub(crate) fn api_from_hp<T>(result: HpResult<T>) -> ApiResponse<T> {
    match result {
        Ok(value) => api_ok(value),
        Err(e) => api_err(ApiError::from_hp(e)),
    }
}

/// **异步命令**的返回包装。
///
/// Tauri 的 `#[tauri::command]` 对**含引用的 `async` 命令**（例如带 `State<'_, T>`）
/// 强制要求返回 `Result`（tauri-macros 的 `AsyncCommandMustReturnResult`）。
///
/// 但 D76 的包装必须落在**成功值**里：失败也是"已解析的响应"，而不是 IPC 层拒绝——
/// 这样前端只需一套 `unwrapApi`，错误码（`validation`/`not_found`/…）不会在
/// IPC 边界被压成字符串。因此本类型**恒为 `Ok(..)`**，失败信息放在
/// `ApiResponse.error` 里（`Err` 分支仅为满足宏约束而存在，不被构造）。
/// **`Err` 分支装箱**（2026-10-25，D120-R4）。
///
/// 该分支**永不构造**（见上文），但它与 `Ok` 同型，会让 `Result` 的尺寸按
/// `ApiResponse<T>` 的较大者算两遍——大 DTO（`BookContentResult` 等）下
/// `Result<ApiResponse<T>, ApiResponse<T>>` 可达 **248 字节**，触发
/// `clippy::result_large_err`。装箱后尺寸按 `Box` 走（8 字节），
/// 且因为该分支不被构造，**零运行时代价**。
pub(crate) type ApiAsync<T> = Result<ApiResponse<T>, Box<ApiResponse<T>>>;

/// 把统一响应装进异步命令的返回类型（见 [`ApiAsync`]）。
pub(crate) fn api_async<T>(response: ApiResponse<T>) -> ApiAsync<T> {
    Ok(response)
}
