/**
 * 媒体预览面板：**四类文件操作动作**（删除选中 / 重命名 / 复制路径 / 重新分析）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 本文件只做一件事——把面板触发的文件操作翻成命令调用、状态栏文案与刷新。
 * 菜单的开关与渲染在 `mediaPreviewMenu.tsx`，选中集口径在 `mediaPreviewSelection.ts`。
 *
 * 动作都以**显式参数**接目标文件（`menu.file` 由菜单传入），因此本文件不持有菜单状态。
 *
 * **两个面板共用这一份实现**（用户 2026-10-09 口径"图书预览用媒体预览同款右键菜单"）：
 * 媒体预览与图书预览的右键菜单是同一套动作，差别只有**删除的相册分流**一条——
 * 由 `MediaFileActionsOptions.albumScoped` 表达，不为图书预览再抄一套动作。
 */

import { useCallback } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import type { FileItem } from "../shared/types";

/** `useMediaFileActions` 的口径选项（面板差异只有下面这一条）。 */
export interface MediaFileActionsOptions {
  /**
   * 删除动作是否按**相册上下文**分流（缺省 `true` = 媒体预览的口径）。
   *
   * 图书预览显式传 `false`：文本类文件**进不了相册成员列表**（相册成员分页与相册属性
   * 只认 image / video / audio），若跟着"当前选中的相册"走，删除就会变成
   * "从相册移出 0 项"的**静默空操作**——文件还在盘上，用户却看到"已移出相册（0）"。
   */
  albumScoped?: boolean;
}

/** 面板可触发的文件操作（右键菜单与条目容器快捷键共用）。 */
export interface MediaFileActions {
  /**
   * 删除选中文件：
   * - 相册上下文 → 移出相册（albumRemoveMember）；
   * - 源/目录上下文 → 移入系统回收站（fileTrash）。
   * 完成后清空选中集并刷新。
   */
  deleteSelected: () => Promise<void>;
  /**
   * 确认内联重命名：名称为空时只报错并返回 `false`（调用方据此**保持输入框**）。
   * 成功后刷新。
   */
  renameFile: (file: FileItem, newName: string) => Promise<boolean>;
  /** 复制单个文件绝对路径到剪贴板。 */
  copyPath: (file: FileItem) => Promise<void>;
  /**
   * 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息 / 调色板）。
   *
   * 这是**后台任务**（用户口径：与「源全量」同款浮窗）：这里只负责发起，
   * 进度浮窗与取消按钮、以及结束后的状态文案与刷新都由 `scan.*` 事件驱动
   * （`core/taskStore.ts`）。因此调用方**不**自己弹 "已重新分析"、也不自己 `refresh()`——
   * 否则会出现"浮窗还没收起、状态栏先说完成了"这类两条真相对撞。
   */
  reanalyze: (file: FileItem) => Promise<void>;
}

/** 面板当前上下文（仓库 / 相册 / 选中集）下的四类文件操作。 */
export function useMediaFileActions({
  albumScoped = true,
}: MediaFileActionsOptions = {}): MediaFileActions {
  const app = useApp();

  const deleteSelected = useCallback(async () => {
    if (!app.repoId || app.selectedIds.size === 0) return;
    const fileIds = [...app.selectedIds];
    try {
      if (albumScoped && app.albumId) {
        const r = await api.albumRemoveMember({
          repoId: app.repoId,
          albumId: app.albumId,
          fileIds,
        });
        app.status(app.t("media.removedFromAlbum", { count: r.removed }), "ok");
      } else {
        const n = await api.fileTrash({ repoId: app.repoId, fileIds });
        app.status(app.t("media.trashed", { count: n }), "ok");
      }
      app.setSelectedIds(new Set());
      app.refresh();
    } catch (e) {
      app.status(app.t("media.deleteFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app, albumScoped]);

  /** 确认内联重命名：调用 `fileRename`，成功后刷新。 */
  const renameFile = useCallback(
    async (file: FileItem, newName: string) => {
      if (!app.repoId) return false;
      const trimmed = newName.trim();
      if (!trimmed) {
        app.status(app.t("media.nameRequired"), "error");
        return false;
      }
      try {
        await api.fileRename({
          repoId: app.repoId,
          fileId: file.id,
          newName: trimmed,
        });
        app.status(app.t("media.renamed"), "ok");
        app.refresh();
      } catch (e) {
        app.status(errorTextOf(app.t, e), "error");
      }
      return true;
    },
    [app],
  );

  /** 复制单个文件绝对路径到剪贴板。 */
  const copyPath = useCallback(
    async (file: FileItem) => {
      if (!app.repoId) return;
      try {
        const path = await api.filePath({
          repoId: app.repoId,
          fileId: file.id,
        });
        await navigator.clipboard.writeText(path);
        app.status(app.t("media.pathCopied"), "ok");
      } catch (e) {
        app.status(app.t("media.pathCopyFailed", { err: errorTextOf(app.t, e) }), "error");
      }
    },
    [app],
  );

  /** 发起单个文件的重新分析后台任务（进度与收尾由 `scan.*` 事件负责）。 */
  const reanalyze = useCallback(
    async (file: FileItem) => {
      if (!app.repoId) return;
      try {
        await api.fileReanalyze({
          repoId: app.repoId,
          fileId: file.id,
        });
      } catch (e) {
        // 任务登记失败（如已有长任务在跑）才在这里报错；任务本身的失败由 scan.error 上报。
        app.status(app.t("media.reanalyzeFailed", { err: errorTextOf(app.t, e) }), "error");
      }
    },
    [app],
  );

  return { deleteSelected, renameFile, copyPath, reanalyze };
}
