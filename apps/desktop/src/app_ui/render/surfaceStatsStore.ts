/**
 * 「当前图像后端」的**只读**数据源（RFC §9）。
 *
 * 为什么是模块级 store 而不是 props 一路传：设置页与图像查看器在 dockview 里是两棵互不相邻的
 * 组件树，后者每次换档、每次换源都产生新事实，而前者只需要"最近一次的事实"。
 * 走 store 既避免把 `ImageSurface` 往上提，也避免设置页去轮询。
 *
 * 这里**不写库**：后端是运行时决定的，不是用户设置值——把它写进 `app_settings` 会让
 * "我明明是自动档，怎么被记成了 dom"这种假象出现在下一次启动。
 *
 * 订阅表与「未变化不通知」来自 `../../core/createStore`（D205）；**哪些字段算变化**留在本文件，
 * 因为那取决于 `SurfaceStatsSnapshot` 的字段集——加字段时 `sameStats` 必须同步加比较，
 * 否则就是「后端换了、设置页不动」。
 */

import { useSyncExternalStore } from "react";
import { createStore } from "../core/createStore";
import type { Backend, SurfaceStats } from "./surface";

export interface SurfaceStatsSnapshot {
  backend: Backend;
  uploads: number;
  uploadedBytes: number;
  lastFrameMs: number;
  residentTiles: number;
}

/** 五个字段逐个比较：`SurfaceStats` 是可变对象，React 只比较引用，不能让它看到原地变化。 */
function sameStats(
  previous: SurfaceStatsSnapshot | null,
  next: SurfaceStatsSnapshot | null,
): boolean {
  if (previous === null || next === null) {
    return previous === next;
  }
  return (
    previous.backend === next.backend &&
    previous.uploads === next.uploads &&
    previous.uploadedBytes === next.uploadedBytes &&
    previous.lastFrameMs === next.lastFrameMs &&
    previous.residentTiles === next.residentTiles
  );
}

const store = createStore<SurfaceStatsSnapshot | null>(null, sameStats);

/** 拷一份快照再发布：值没变时 store 不换引用、不通知。 */
export function publishSurfaceStats(stats: SurfaceStats | null): void {
  if (!stats) {
    store.set(null);
    return;
  }
  store.set({
    backend: stats.backend,
    uploads: stats.uploads,
    uploadedBytes: stats.uploadedBytes,
    lastFrameMs: stats.lastFrameMs,
    residentTiles: stats.residentTiles,
  });
}

export function readSurfaceStatsSnapshot(): SurfaceStatsSnapshot | null {
  return store.get();
}

export function subscribeSurfaceStats(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function useSurfaceStats(): SurfaceStatsSnapshot | null {
  return useSyncExternalStore(store.subscribe, store.get, () => null);
}