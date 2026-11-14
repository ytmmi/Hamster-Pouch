/**
 * M5：源间复制/剪切/移动命令封装（fsops.*，RFC 0001）。
 *
 * **D76 迁移状态：已包装**（批次 `fsops`，2026-09）。两条命令返回
 * `{ ok, data?, error? }`，这里经 [`invokeApi`] 解包。
 */

import { invokeApi } from "./call";

import type { FsOpsResult } from "@hamster-pouch/shared-types";

/** 源间复制（真实复制 + 继承解释数据） */
export function fsopsCopy(
  repoId: string,
  fileIds: string[],
  targetSourceId: string,
  targetPath?: string,
): Promise<FsOpsResult> {
  return invokeApi<FsOpsResult>("fsops_copy", {
    repoId,
    fileIds,
    targetSourceId,
    targetPath,
  });
}

/** 源间剪切/移动（真实移动 + 保留解释数据） */
export function fsopsMove(
  repoId: string,
  fileIds: string[],
  targetSourceId: string,
  targetPath?: string,
): Promise<FsOpsResult> {
  return invokeApi<FsOpsResult>("fsops_move", {
    repoId,
    fileIds,
    targetSourceId,
    targetPath,
  });
}
