/**
 * 媒体预览面板：**选中集与鼠标手势到蓝图事件的翻译**。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 本文件只做一件事——维护面板的选中集（单选 / Shift 范围 / Ctrl 切换 / 全选 / 清空），
 * 并把选中变化、单击、双击翻译成蓝图引擎的 `selection_change` / `click` / `double_click`
 * 事件源（RFC 0007 实现期开放点）。条目容器与缩略图单元的渲染不在这里。
 *
 * 选中集本身存在 `AppContext`（跨面板共享），本文件只负责"怎么改它"与"改完上报什么"。
 * 右键菜单的开关在 `mediaPreviewMenu.tsx`，四类文件操作在 `mediaPreviewActions.ts`。
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DragEvent } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { FileItem } from "../shared/types";
import type { MediaPreviewItem, MediaTypeFilter } from "./mediaPreviewData";

/** 点击时按下的修饰键：Shift = 从锚点到当前项的连续范围；Ctrl/Cmd = 切换单项。 */
export interface SelectModifiers {
  shift: boolean;
  ctrl: boolean;
}

/** 面板选中集的读入口与改动入口（工具条计数、条目渲染、容器快捷键都从这里取）。 */
export interface MediaSelection {
  /** 当前页中被选中的条目数。 */
  selectedCount: number;
  /**
   * 点击选择：
   * - 无修饰：单选（清空其余）；
   * - Shift+左键：从锚点到当前项的连续范围多选（类似资源管理器）；
   * - Ctrl/Cmd+左键：切换单项选中。
   */
  select: (file: FileItem, mods: SelectModifiers) => void;
  /** 双击上报（默认蓝图据此切换查看器 / 播放器）。 */
  doubleClick: (file: FileItem) => void;
  /**
   * 拖拽起始：若拖拽项不在当前选中集合内，先单选它，
   * 再将选中集序列化为 dataTransfer 载荷。
   */
  dragStart: (file: FileItem, e: DragEvent) => void;
  /**
   * 右键菜单前的选中口径：未选中项先单选，已选中则保持多选。
   * 打开菜单本身由 `mediaPreviewMenu.tsx` 负责。
   */
  ensureSelected: (file: FileItem) => void;
  /** 全选当前页条目（条目容器的 Ctrl+A）。 */
  selectAll: () => void;
  /** 清空选中集（Esc 与点空白处）。 */
  clear: () => void;
}

/** 读取并按交互改动面板选中集（含选中变化 / 单击 / 双击的蓝图事件上报）。 */
export function useMediaSelection(
  items: MediaPreviewItem[],
  typeFilter: MediaTypeFilter,
): MediaSelection {
  const app = useApp();
  // Shift 范围选择的锚点（上一次点击项，随面板实例保存）。
  const anchorRef = useRef<string | null>(null);
  // selection_change 异步取 context 的过期令牌：只让最后一次选中上报生效。
  const selectionTokenRef = useRef(0);

  // 切换仓库或筛选（列表内容变化）时清空多选，避免残留失效选择。
  useEffect(() => {
    app.setSelectedIds(new Set());
    anchorRef.current = null;
  }, [app.repoId, typeFilter, app.setSelectedIds]);

  /**
   * 选中变化上报蓝图引擎（RFC 0007 实现期开放点）：`selection_change` 事件源，
   * 并携带 `rating >=` / `has_tag ==` 条件求值所需的运行时 context（评分 + 人工/自动 tag 名）。
   * context 是异步取的，故用令牌丢弃过期响应，避免快速切换选中时旧结果误触发规则。
   */
  const dispatchSelectionChange = useCallback(
    (file: FileItem) => {
      if (!app.repoId) {
        return;
      }
      const token = ++selectionTokenRef.current;
      const currentRepo = app.repoId;
      void (async () => {
        let rating: number | undefined;
        let tags: string[] | undefined;
        try {
          const [r, tagResult] = await Promise.all([
            api.ratingGet({ repoId: currentRepo, fileId: file.id }),
            api.tagForFile({ repoId: currentRepo, fileId: file.id }),
          ]);
          rating = r ?? undefined;
          tags = [...tagResult.manual, ...tagResult.auto].map((t) => t.name);
        } catch {
          // context 取不到时按缺失处理（rating/has_tag 条件求值为 false，不阻塞选中上报）。
        }
        if (token !== selectionTokenRef.current) {
          return;
        }
        app.dispatch({
          trigger: "selection_change",
          target: { mediaType: file.media_type, fileId: file.id },
          context: { rating, tags },
        });
      })();
    },
    [app],
  );

  const select = useCallback(
    (file: FileItem, mods: SelectModifiers) => {
      const next = new Set(app.selectedIds);
      // 锚点缺失（如面板重建）时回退到全局主选中项。
      const anchor = anchorRef.current ?? app.selectedFile?.id ?? null;
      if (mods.shift && anchor) {
        const from = items.findIndex((it) => it.file.id === anchor);
        const to = items.findIndex((it) => it.file.id === file.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          next.clear();
          for (let i = start; i <= end; i += 1) {
            next.add(items[i].file.id);
          }
          app.setSelectedIds(next);
          app.setSelectedFile(file);
          dispatchSelectionChange(file);
          return;
        }
      }
      if (mods.ctrl) {
        if (next.has(file.id)) {
          next.delete(file.id);
        } else {
          next.add(file.id);
        }
        anchorRef.current = file.id;
        app.setSelectedIds(next);
        app.setSelectedFile(file);
        dispatchSelectionChange(file);
        return;
      }
      anchorRef.current = file.id;
      app.setSelectedIds(new Set([file.id]));
      app.setSelectedFile(file);
      dispatchSelectionChange(file);
      // 单击事件上报蓝图引擎（默认蓝图无单击规则，行为不变；用户蓝图可响应）。
      app.dispatch({
        trigger: "click",
        target: { mediaType: file.media_type, fileId: file.id },
      });
    },
    [app, items, dispatchSelectionChange],
  );

  /** 双击上报（默认蓝图据此切换查看器 / 播放器）。 */
  const doubleClick = useCallback(
    (file: FileItem) => {
      app.dispatch({
        trigger: "double_click",
        target: { mediaType: file.media_type, fileId: file.id },
      });
    },
    [app],
  );

  const dragStart = useCallback(
    (file: FileItem, e: DragEvent) => {
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
      // 载荷 = 拖拽后的选中集（单选时为 [file.id]，否则为现有选中集）
      const payload = app.selectedIds.has(file.id) ? [...app.selectedIds] : [file.id];
      e.dataTransfer.setData("application/x-hp-files", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    },
    [app],
  );

  const ensureSelected = useCallback(
    (file: FileItem) => {
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
    },
    [app],
  );

  const selectAll = useCallback(() => {
    app.setSelectedIds(new Set(items.map((it) => it.file.id)));
  }, [app, items]);

  const clear = useCallback(() => {
    app.setSelectedIds(new Set());
  }, [app]);

  const selectedCount = useMemo(
    () => items.reduce((n, it) => (app.selectedIds.has(it.file.id) ? n + 1 : n), 0),
    [items, app.selectedIds],
  );

  return { selectedCount, select, doubleClick, dragStart, ensureSelected, selectAll, clear };
}
