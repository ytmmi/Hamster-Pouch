/**
 * 长任务进度 store（扫描 / 卸载共用）— 模块级 store + `useSyncExternalStore`。
 *
 * **为什么不放在 AppContext**：进度事件很频繁（扫描按 80 ms 节流，大源上百次；
 * 卸载按相册上报）。若进度存在 context 里，每个事件都会让 `ctxValue` 换新身份，
 * 于是**所有面板**重渲染，而面板普遍写成
 * `const load = useCallback(..., [app]); useEffect(() => { void load(); }, [load, app.refreshKey])`，
 * 结果每次进度都把所有面板的库查询重跑一遍（媒体预览查文件、媒体源面板重建整棵目录树……）。
 * 放进独立 store 后，只有订阅者（进度浮窗、媒体源面板）重渲染。
 *
 * 订阅只在启动时注册一次（`startTaskEvents`），回调通过 `bindTaskActions` 取最新的
 * `status` / `refresh` / `t`，因此切语言、换仓库都不会出现"监听空窗期"。
 */

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import type { Translate, TranslationKey } from "../i18n";
import type {
  ScanCompletedPayload,
  ScanErrorPayload,
  ScanProgressPayload,
  SourceUnmountCompletedPayload,
  SourceUnmountErrorPayload,
  SourceUnmountProgressPayload,
  StatusType,
} from "../shared/types";
import type { TaskProgress } from "./AppContext";

interface TaskActions {
  status: (message: string, type?: StatusType) => void;
  refresh: () => void;
  t: Translate;
}

let current: TaskProgress | null = null;
let actions: TaskActions | null = null;
let started = false;
const listeners = new Set<() => void>();

function emitChange() {
  for (const l of listeners) {
    l();
  }
}

/** 更新任务进度（`null` = 无任务）。 */
export function setTask(next: TaskProgress | null) {
  current = next;
  emitChange();
}

export function getTask(): TaskProgress | null {
  return current;
}

export function subscribeTask(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅任务进度（仅订阅者重渲染）。 */
export function useTask(): TaskProgress | null {
  return useSyncExternalStore(subscribeTask, getTask, getTask);
}

/** 宿主每次渲染后绑定最新的 status / refresh / t（不是订阅，不会触发重渲染）。 */
export function bindTaskActions(next: TaskActions) {
  actions = next;
}

/**
 * 注册长任务事件监听（幂等）。返回卸载函数。
 */
export function startTaskEvents(): () => void {
  if (started) {
    return () => undefined;
  }
  started = true;
  const now = () => Date.now();

  const unlisten = [
    // ── 扫描 ──
    listen<ScanProgressPayload>("scan.progress", (e) => {
      const p = e.payload;
      const walking = p.phase === "walking";
      setTask({
        titleKey: "scan.title",
        taskId: p.taskId,
        sourceId: p.sourceId,
        subtitle: current?.sourceId === p.sourceId ? (current?.subtitle ?? null) : null,
        messageKey: walking ? "scan.walking" : "scan.indexing",
        messageParams: walking
          ? { count: p.processed }
          : { processed: p.processed, total: p.total },
        processed: p.processed,
        total: p.total,
        current: p.current ?? null,
        cancellable: true,
        // 暂停能力由**事件载荷**给出，不在前端写死：整源扫描可暂停/恢复，
        // 单文件「重新分析」没有暂停点（`pausable: false` → 浮窗不显示该按钮）。
        pausable: p.pausable,
        updatedAt: now(),
      });
    }),
    listen<ScanCompletedPayload>("scan.completed", (e) => {
      const p = e.payload;
      setTask(null);
      const a = actions;
      if (!a) return;
      if (p.cancelled) {
        a.status(a.t("scan.cancelled"), "info");
      } else {
        a.status(
          a.t("source.scanCompleted", {
            indexed: p.indexed,
            changed: p.changed,
            missing: p.missing,
          }),
          "ok",
        );
      }
      a.refresh();
    }),
    listen<ScanErrorPayload>("scan.error", (e) => {
      setTask(null);
      const a = actions;
      if (!a) return;
      a.status(a.t("source.scanError", { err: e.payload.error }), "error");
    }),

    // ── 卸载（完全卸载）──
    listen<SourceUnmountProgressPayload>("source.unmount.progress", (e) => {
      const p = e.payload;
      // 阶段 → 文案；total === 0 的阶段（统计 / 删源记录）按不定进度显示
      const messageKey: TranslationKey =
        p.phase === "counting"
          ? "unmount.counting"
          : p.phase === "syncRules"
            ? "unmount.syncRules"
            : p.phase === "children"
              ? "unmount.children"
              : p.phase === "derived"
                ? "unmount.derived"
                : p.phase === "files"
                  ? "unmount.files"
                  : p.phase === "source"
                    ? "unmount.source"
                    : "unmount.preparing";
      setTask({
        titleKey: "unmount.title",
        taskId: p.taskId,
        sourceId: p.sourceId,
        subtitle: current?.sourceId === p.sourceId ? (current?.subtitle ?? null) : null,
        messageKey,
        messageParams: p.total > 0 ? { processed: p.processed, total: p.total } : {},
        processed: p.processed,
        total: p.total,
        current: null,
        cancellable: true,
        // 卸载不可暂停：清理循环在单事务里推进，没有暂停点
        pausable: false,
        updatedAt: now(),
      });
    }),
    listen<SourceUnmountCompletedPayload>("source.unmount.completed", (e) => {
      const p = e.payload;
      setTask(null);
      const a = actions;
      if (!a) return;
      if (p.cancelled) {
        a.status(a.t("unmount.cancelled"), "info");
      } else {
        a.status(
          a.t("unmount.done", {
            files: p.files,
            tags: p.tags,
            ratings: p.ratings,
            members: p.members,
          }),
          "ok",
        );
      }
      a.refresh();
    }),
    listen<SourceUnmountErrorPayload>("source.unmount.error", (e) => {
      setTask(null);
      const a = actions;
      if (!a) return;
      a.status(a.t("source.unmountFailed", { err: e.payload.error }), "error");
      a.refresh();
    }),
  ];

  return () => {
    started = false;
    for (const un of unlisten) {
      void un.then((fn) => fn());
    }
  };
}
