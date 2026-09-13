/**
 * M2：图像源命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  SourceItem,
  SourceListArgs,
  SourceMountArgs,
  SourceRenameArgs,
  SourceScanArgs,
  SourceTreeNode,
  SourceUnmountArgs,
} from "../types";

/** 挂载图像源 */
export function sourceMount(args: SourceMountArgs): Promise<SourceItem> {
  return invoke<SourceItem>("source_mount", {
    repoId: args.repoId,
    localPath: args.localPath,
    alias: args.alias,
    parentSourceId: args.parentSourceId,
  });
}

/** 卸载图像源 */
export function sourceUnmount(args: SourceUnmountArgs): Promise<void> {
  return invoke<void>("source_unmount", {
    repoId: args.repoId,
    sourceId: args.sourceId,
  });
}

/** 重命名图像源别名 */
export function sourceRename(args: SourceRenameArgs): Promise<void> {
  return invoke<void>("source_rename", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    alias: args.alias,
  });
}

/** 列出仓库下全部图像源 */
export function sourceList(args: SourceListArgs): Promise<SourceItem[]> {
  return invoke<SourceItem[]>("source_list", { repoId: args.repoId });
}

/** 列出仓库下图像源目录树（含子文件夹与递归文件数） */
export function sourceTree(args: SourceListArgs): Promise<SourceTreeNode[]> {
  return invoke<SourceTreeNode[]>("source_tree", { repoId: args.repoId });
}

/** 扫描图像源（后台执行，返回 taskId） */
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
