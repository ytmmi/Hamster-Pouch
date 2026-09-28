/**
 * M2：媒体源命令封装。
 *
 * **D76 迁移状态：已包装**（批次 `source`，2026-09）。全部命令返回
 * `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包：调用方拿到的仍是原来的领域值，
 * 失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  SourceItem,
  SourceListArgs,
  SourceMountArgs,
  SourceRenameArgs,
  SourceScanArgs,
  SourceTreeNode,
  SourceUnmountArgs,
  SourceUnmountPreview,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/**
 * 去掉 Windows 扩展长度路径前缀（原生对话框可能返回 `\\?\E:\Media`）。
 * 去掉后与用户手工输入的路径同形，避免同一文件夹被当成两个媒体源。
 */
function normalizePickedPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
}

/**
 * 选取文件夹（原生系统对话框）。用户取消时返回 `null`。
 * 「添加媒体源」的入口：源路径只能选取，不再手工输入。
 * `title` 由调用方传入已翻译文字（系统文字必须走 i18n）。
 */
export async function pickFolder(title?: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  if (typeof picked !== "string" || !picked) {
    return null;
  }
  return normalizePickedPath(picked);
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

/**
 * 卸载媒体源（后台任务，返回 taskId）。
 *
 * 后台会：**不可恢复地**删除该源在本仓库的全部数据（文件索引、tag 关联、评分、
 * 色彩参考、相册成员、跟随规则），**磁盘上的真实文件一律不动**（D26）。
 * 进度与结果通过 `source.unmount.progress|completed|error` 事件上报。
 */
export function sourceUnmount(args: SourceUnmountArgs): Promise<string> {
  return invoke<ApiResponse<string>>("source_unmount", {
    repoId: args.repoId,
    sourceId: args.sourceId,
  }).then(unwrapApi);
}

/** 卸载影响预估（只读）：文件数 / 受影响相册与成员数，供卸载前警告弹窗使用。 */
export function sourceUnmountPreview(args: SourceUnmountArgs): Promise<SourceUnmountPreview> {
  return invoke<ApiResponse<SourceUnmountPreview>>("source_unmount_preview", {
    repoId: args.repoId,
    sourceId: args.sourceId,
  }).then(unwrapApi);
}

/** 重命名媒体源别名（仅已添加的媒体源可改名） */
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

/** 列出仓库下媒体源目录树（含子文件夹与递归文件数） */
export function sourceTree(args: SourceListArgs): Promise<SourceTreeNode[]> {
  return invoke<ApiResponse<SourceTreeNode[]>>("source_tree", {
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
 * 取消**指定**后台长任务（扫描 / 卸载）。
 *
 * `cancelled: false` 表示该任务已不是当前任务（已结束或从未存在）——**不是错误**：
 * 进度浮窗的取消按钮处在竞态窗口里，任务恰好收尾时不应弹错误提示（缺陷 0003）。
 */
export function taskCancel(taskId: string): Promise<{ cancelled: boolean }> {
  return invoke<ApiResponse<{ cancelled: boolean }>>("task_cancel", { taskId }).then(unwrapApi);
}

/**
 * 暂停**指定**扫描任务（下一个文件处理前生效）。
 *
 * 只有扫描可以暂停；卸载的清理循环没有暂停点，此时 `accepted: false`（不报错）。
 */
export function taskPause(taskId: string): Promise<TaskPauseResult> {
  return invoke<ApiResponse<TaskPauseResult>>("task_pause", { taskId }).then(unwrapApi);
}

/** 恢复**指定**已暂停的扫描任务。 */
export function taskResume(taskId: string): Promise<TaskPauseResult> {
  return invoke<ApiResponse<TaskPauseResult>>("task_resume", { taskId }).then(unwrapApi);
}

/** 暂停/恢复结果：`accepted` = 请求是否命中当前可暂停任务；`paused` = 调用后的挂起状态。 */
export interface TaskPauseResult {
  accepted: boolean;
  paused: boolean;
}

/** 长任务快照（进度浮窗与后端对账用，防止终止事件丢失后永远转圈）。 */
export interface TaskStatusSnapshot {
  busy: boolean;
  /** 当前任务 ID；无任务为 `null`。 */
  taskId: string | null;
  /** `scan` / `unmount`；无任务为 `null`。 */
  kind: string | null;
  /** 是否处于挂起状态；只有扫描任务有值。 */
  paused: boolean | null;
}

/** 长任务是否仍在进行，以及当前是哪一条（`task.*` 控制命令都要 `taskId`）。 */
export function taskStatus(): Promise<TaskStatusSnapshot> {
  return invoke<ApiResponse<TaskStatusSnapshot>>("task_status").then(unwrapApi);
}
