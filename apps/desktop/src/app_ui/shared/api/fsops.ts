/**
 * M5：源间复制/剪切/移动命令封装（fsops.*，RFC 0001）。
 *
 * **D76 迁移状态：已包装**（批次 `fsops`，2026-09）。两条命令返回
 * `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包。
 */

import { invoke } from "@tauri-apps/api/core";

import type { FsOpsResult } from "@hamster-pouch/shared-types";

import { unwrapApi, type ApiResponse } from "./response";

/** 源间复制（真实复制 + 继承解释数据） */
export function fsopsCopy(
  repoId: string,
  fileIds: string[],
  targetSourceId: string,
  targetPath?: string,
): Promise<FsOpsResult> {
  return invoke<ApiResponse<FsOpsResult>>("fsops_copy", {
    repoId,
    fileIds,
    targetSourceId,
    targetPath,
  }).then(unwrapApi);
}

/** 源间剪切/移动（真实移动 + 保留解释数据） */
export function fsopsMove(
  repoId: string,
  fileIds: string[],
  targetSourceId: string,
  targetPath?: string,
): Promise<FsOpsResult> {
  return invoke<ApiResponse<FsOpsResult>>("fsops_move", {
    repoId,
    fileIds,
    targetSourceId,
    targetPath,
  }).then(unwrapApi);
}
