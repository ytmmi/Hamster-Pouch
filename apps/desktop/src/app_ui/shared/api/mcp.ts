/**
 * MCP 服务命令封装（内置模型上下文协议服务，D119）。
 *
 * **D76 迁移状态：已包装**（`mcp.*` 属契约 §3.16）。
 *
 * 只有"看状态 / 立即重应用"两条：启停本身由设置项 `mcp.*` 驱动，
 * `setting.set` 写入后后端自动应用，不给命令开第二个开关。
 */

import { invoke } from "@tauri-apps/api/core";

import type { McpStatus } from "../types/mcp";
import { unwrapApi, type ApiResponse } from "./response";

/** 查询内置 MCP 服务的运行状态与客户端接入信息。 */
export function mcpStatus(): Promise<McpStatus> {
  return invoke<ApiResponse<McpStatus>>("mcp_status").then(unwrapApi);
}

/** 按当前设置项重新应用服务（供"端口被占、改完再试"）。 */
export function mcpReload(): Promise<McpStatus> {
  return invoke<ApiResponse<McpStatus>>("mcp_reload").then(unwrapApi);
}
