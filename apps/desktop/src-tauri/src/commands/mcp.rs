//! MCP 服务相关的 Tauri 命令（D119）。
//!
//! 只暴露"看状态 / 看接入信息 / 重启"三件事——启停本身由设置项
//! `mcp.enabled` 驱动（`setting.set` 写入后自动应用），不给命令开第二个开关，
//! 避免"设置里是关的、命令却能开"这种双真相。
//!
//! 形状遵循 **D76**（`{ ok, data?, error? }`，全部**已包装**）。

use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_ok};
use crate::mcp;

/// MCP 服务当前状态。
#[derive(serde::Serialize)]
pub(crate) struct McpStatusResult {
    /// 是否正在运行（= 端口已绑定、可接受连接）。
    running: bool,
    /// 监听端口；未运行时是设置项里的目标端口。
    port: u16,
    /// 写操作是否允许。
    allow_write: bool,
    /// 完整端点地址（客户端配置里填这个）。
    endpoint: String,
    /// 鉴权 token（客户端配置里的 `Authorization: Bearer`）。
    token: String,
    /// 工具总数与其中的写工具数。
    tool_count: usize,
    write_tool_count: usize,
}

/// mcp.status：查询内置 MCP 服务的运行状态与接入信息。
///
/// 返回 token 是有意的：这是**本机**应用，用户需要把它复制到 MCP 客户端配置里。
/// 真正的边界是"服务默认关闭 + 只绑回环 + 需要 token"，
/// 而不是"把 token 藏起来不给自己看"。
#[tauri::command]
pub(crate) fn mcp_status(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<McpStatusResult> {
    let cfg = mcp::read_config(&app);
    let running = state.mcp.status();
    let port = running.map(|(port, _)| port).unwrap_or(cfg.port);
    let allow_write = running.map(|(_, allow)| allow).unwrap_or(cfg.allow_write);
    let tools = mcp::tools::list();
    api_ok(McpStatusResult {
        running: running.is_some(),
        port,
        allow_write,
        endpoint: format!("http://127.0.0.1:{port}/mcp"),
        token: state.mcp.token_for_client(),
        tool_count: tools.len(),
        write_tool_count: tools.iter().filter(|tool| tool.write).count(),
    })
}

/// mcp.reload：按当前设置项重新应用服务状态（供界面"立即生效"用）。
///
/// 正常情况下不需要调——`setting.set` 写入 `mcp.*` 后会自动应用；
/// 这条命令留给"端口被别的程序占了、改完想再试一次"的场景。
#[tauri::command]
pub(crate) fn mcp_reload(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<McpStatusResult> {
    state.mcp.apply(&app);
    mcp_status(state, app)
}
