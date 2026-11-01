/**
 * 源面板 / 相册面板「添加标记」的持久化封装（D134）。
 *
 * **D76 迁移状态：已包装**——两条命令都返回 `{ ok, data?, error? }`，这里经
 * [`unwrapApi`] 解包；失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
 *
 * 载荷是一份**不透明 JSON 字符串**：状态模型、解析/序列化/容错全部在
 * `shared/panelMarks.ts`，本层只负责搬运（桥接层同样不解析内容）。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "./response";

/** 读取某仓库的面板标记 JSON；未设置返回 `null`。 */
export function panelMarksGet(repoId: string): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("panel_marks_get", { repoId }).then(unwrapApi);
}

/** 覆盖写入某仓库的面板标记 JSON（空串 = 清空）。 */
export function panelMarksSet(repoId: string, marksJson: string): Promise<void> {
  return invoke<ApiResponse<void>>("panel_marks_set", { repoId, marksJson }).then(unwrapApi);
}
