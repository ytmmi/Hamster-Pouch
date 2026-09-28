/**
 * test_ui M2：媒体源命令封装。
 *
 * **D76**：媒体源命令已改返回 `{ ok, data?, error? }`（批次 `source`，2026-09），
 * 因此这里复用 `app_ui` 的**统一解包层**（`apps/desktop/src/app_ui/shared/api/response.ts`）
 * 而不是再写一份信封逻辑——信封只有一处实现，两个前端都按同一个 `code` 走 i18n。
 *
 * 注：test_ui 不在 vite 的构建入口里（只有 `index.html` / `popout.html`），
 * 但 `pnpm typecheck` 覆盖它；这里的解包口径必须与主界面一致，否则将来启用它就会立刻坏掉。
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { unwrapApi, type ApiResponse } from "../../app_ui/shared/api/response";

import type {
  SourceItem,
  SourceListArgs,
  SourceMountArgs,
  SourceRenameArgs,
  SourceScanArgs,
  SourceUnmountArgs,
} from "../types";

/**
 * 选取媒体源文件夹（原生对话框）；取消返回 `null`。
 * 同时去掉 Windows 扩展长度路径前缀（`\\?\`），避免同一文件夹被当成两个源。
 */
export async function pickSourceFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string" || !picked) {
    return null;
  }
  return picked.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
}

/** 挂载媒体源 */
export function sourceMount(args: SourceMountArgs): Promise<SourceItem> {
  return invoke<ApiResponse<SourceItem>>("source_mount", {
    repoId: args.repoId,
    localPath: args.localPath,
    alias: args.alias,
    parentSourceId: args.parentSourceId,
  }).then(unwrapApi);
}

/** 卸载媒体源（后台任务，返回 taskId） */
export function sourceUnmount(args: SourceUnmountArgs): Promise<string> {
  return invoke<ApiResponse<string>>("source_unmount", {
    repoId: args.repoId,
    sourceId: args.sourceId,
  }).then(unwrapApi);
}

/** 重命名媒体源别名 */
export function sourceRename(args: SourceRenameArgs): Promise<void> {
  return invoke<ApiResponse<void>>("source_rename", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    alias: args.alias,
  }).then(unwrapApi);
}

/** 列出仓库下全部媒体源 */
export function sourceList(args: SourceListArgs): Promise<SourceItem[]> {
  return invoke<ApiResponse<SourceItem[]>>("source_list", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 扫描媒体源（后台执行，返回 taskId） */
export function sourceScan(args: SourceScanArgs): Promise<string> {
  return invoke<ApiResponse<string>>("source_scan", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    full: args.full,
  }).then(unwrapApi);
}

/**
 * 取消**指定**后台长任务（缺陷 0003：必须带 `taskId`）。
 * `cancelled: false` = 该任务已结束，不是错误。
 */
export function taskCancel(taskId: string): Promise<{ cancelled: boolean }> {
  return invoke<ApiResponse<{ cancelled: boolean }>>("task_cancel", { taskId }).then(unwrapApi);
}
