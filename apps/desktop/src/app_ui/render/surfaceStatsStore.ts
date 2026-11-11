/**
 * 「当前图像后端」的**只读**数据源（RFC §9）。
 *
 * 为什么是模块级 store 而不是 props 一路传：设置页与图像查看器在 dockview 里是两棵互不相邻的
 * 组件树，后者每次换档、每次换源都产生新事实，而前者只需要"最近一次的事实"。
 * 走 store 既避免把 `ImageSurface` 往上提，也避免设置页去轮询。
 *
 * 这里**不写库**：后端是运行时决定的，不是用户设置值——把它写进 `app_settings` 会让
 * "我明明是自动档，怎么被记成了 dom"这种假象出现在下一次启动。
 */

import { useSyncExternalStore } from "react";
import type { Backend, SurfaceStats } from "./surface";

export interface SurfaceStatsSnapshot {
  backend: Backend;
  uploads: number;
  uploadedBytes: number;
  lastFrameMs: number;
  residentTiles: number;
}

let snapshot: SurfaceStatsSnapshot | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 表面的 stats 是可变对象，这里拷一份快照：React 只比较引用，不能让它看到原地变化。 */
export function publishSurfaceStats(stats: SurfaceStats | null): void {
  if (!stats) {
    if (snapshot === null) return;
    snapshot = null;
    emit();
    return;
  }
  const next: SurfaceStatsSnapshot = {
    backend: stats.backend,
    uploads: stats.uploads,
    uploadedBytes: stats.uploadedBytes,
    lastFrameMs: stats.lastFrameMs,
    residentTiles: stats.residentTiles,
  };
  const previous = snapshot;
  if (
    previous &&
    previous.backend === next.backend &&
    previous.uploads === next.uploads &&
    previous.uploadedBytes === next.uploadedBytes &&
    previous.lastFrameMs === next.lastFrameMs &&
    previous.residentTiles === next.residentTiles
  ) {
    return;
  }
  snapshot = next;
  emit();
}

export function readSurfaceStatsSnapshot(): SurfaceStatsSnapshot | null {
  return snapshot;
}

export function subscribeSurfaceStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSurfaceStats(): SurfaceStatsSnapshot | null {
  return useSyncExternalStore(subscribeSurfaceStats, readSurfaceStatsSnapshot, () => null);
}
