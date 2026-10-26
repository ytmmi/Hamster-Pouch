/**
 * 垂直「界面页」标签条的页面组持久化封装（D124）。
 *
 * **D76 迁移状态：已包装**——两条命令都返回 `{ ok, data?, error? }`，这里经
 * [`unwrapApi`] 解包；失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
 *
 * 载荷是一份**不透明 JSON 字符串**：解析/序列化/容错全部在
 * `shared/interfacePages.ts`，本层只负责搬运。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "./response";

/** 读取某仓库的界面页分组 JSON；未设置返回 `null`。 */
export function interfacePagesGet(repoId: string): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("interface_pages_get", { repoId }).then(unwrapApi);
}

/** 覆盖写入某仓库的界面页分组 JSON（空串 = 清空）。 */
export function interfacePagesSet(repoId: string, pagesJson: string): Promise<void> {
  return invoke<ApiResponse<void>>("interface_pages_set", { repoId, pagesJson }).then(unwrapApi);
}
