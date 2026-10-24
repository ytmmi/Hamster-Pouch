/**
 * MCP 服务（内置模型上下文协议服务，D119）：状态与接入信息。
 *
 * 字段是后端返回体的**蛇形**形状（`docs/spec/shared-types.md` 的跨层口径）。
 */

export interface McpStatus {
  /** 是否正在运行（端口已绑定、可接受连接）。 */
  running: boolean;
  /** 监听端口；未运行时是设置项里的目标端口。 */
  port: number;
  /** 写操作是否允许。 */
  allow_write: boolean;
  /** 完整端点地址（MCP 客户端配置里填这个）。 */
  endpoint: string;
  /** 鉴权 token（客户端配置里的 `Authorization: Bearer`）。 */
  token: string;
  /** 工具总数。 */
  tool_count: number;
  /** 其中的写工具数。 */
  write_tool_count: number;
}
