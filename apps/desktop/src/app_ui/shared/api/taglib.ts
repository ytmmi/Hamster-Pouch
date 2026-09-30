/**
 * tag 库（RFC 0008 四库）命令封装。
 *
 * **D76 迁移状态：已包装**——命令返回 `{ ok, data?, error? }`，经 [`unwrapApi`] 解包。
 *
 * 词库是**应用级共享参考数据**（D34/D36）：装配来源为内置基底库 + 已安装扩展包，
 * 与仓库无关；因此本域命令不带 `repoId`。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "./response";

/** tag 库装配状态（`taglib.status`）。 */
export interface TagLibStatus {
  /** 是否已装配（无内置基底库时为 false）。 */
  loaded: boolean;
  /** 已装配的层数（内置基底 + 各扩展包）。 */
  layers: number;
  /** 归并后的概念总数（跨扩展去重后）。 */
  conceptCount: number;
  /** 因跨扩展重复而被归并掉的概念数。 */
  duplicateCount: number;
}

/**
 * 词库装配状态：界面用它展示「共多少个 tag」与「合并了多少条重复」。
 *
 * 装配在**插件安装/启用/禁用后**会重做，因此调用方应在这些操作后重新查询。
 */
export function taglibStatus(): Promise<TagLibStatus> {
  return invoke<ApiResponse<TagLibStatus>>("taglib_status").then(unwrapApi);
}
