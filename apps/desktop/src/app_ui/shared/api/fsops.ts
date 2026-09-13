/**
 * M5：源间复制/剪切/移动命令封装（fsops.*，RFC 0001）。
 */

import { invoke } from "@tauri-apps/api/core";

import type { FsOpsResult } from "@hamster-pouch/shared-types";

/** 源间复制（真实复制 + 继承解释数据） */
export function fsopsCopy(
  repoId: string,
  fileIds: string[],
  targetSourceId: string,
  targetPath?: string,
): Promise<FsOpsResult> {
  return invoke<FsOpsResult>("fsops_copy", {
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
  return invoke<FsOpsResult>("fsops_move", {
    repoId,
    fileIds,
    targetSourceId,
    targetPath,
  });
}
