/**
 * test_ui M2：媒体源命令封装。
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
  return invoke<SourceItem>("source_mount", {
    repoId: args.repoId,
    localPath: args.localPath,
    alias: args.alias,
    parentSourceId: args.parentSourceId,
  });
}

/** 卸载媒体源 */
export function sourceUnmount(args: SourceUnmountArgs): Promise<void> {
  return invoke<void>("source_unmount", {
    repoId: args.repoId,
    sourceId: args.sourceId,
  });
}

/** 重命名媒体源别名 */
export function sourceRename(args: SourceRenameArgs): Promise<void> {
  return invoke<void>("source_rename", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    alias: args.alias,
  });
}

/** 列出仓库下全部媒体源 */
export function sourceList(args: SourceListArgs): Promise<SourceItem[]> {
  return invoke<SourceItem[]>("source_list", { repoId: args.repoId });
}

/** 扫描媒体源（后台执行，返回 taskId） */
export function sourceScan(args: SourceScanArgs): Promise<string> {
  return invoke<string>("source_scan", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    full: args.full,
  });
}

/** 取消当前后台任务 */
export function taskCancel(): Promise<void> {
  return invoke<void>("task_cancel");
}
