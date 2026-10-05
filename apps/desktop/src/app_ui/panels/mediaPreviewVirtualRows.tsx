/**
 * 媒体预览面板：**行虚拟化的共享钩子**（三种条目容器 + 列表共用一套）。
 *
 * 与 `mediaPreviewVirtual.ts`（**纯函数**，无框架依赖、门禁可直接 import）分工：
 * 那里是"行怎么切、行高怎么算、窗口边界怎么夹"，这里是"把它接到 React 与滚动容器上"。
 *
 * ## 为什么用 `@tanstack/react-virtual`
 *
 * 窗口化本身不难，难的是**滚动事件、容器尺寸变化、重挂载恢复滚动位置**三件事都要与
 * 虚拟窗口保持一致；手写容易漏掉其中之一，而这三件事恰好是本面板历史缺陷的来源
 * （滚动条抖动、位置漂移、空白面板）。`useVirtualizer` 只回答"给定行数与行高，
 * 现在该渲染哪几行"，**不接管布局**——DOM 仍由面板自己写，因此样式表与门禁断言的
 * 口径都不变。
 *
 * ## 与既有滚动恢复的关系
 *
 * 面板本来就把 `scrollTop` 存在模块级变量里（`savedThumbScroll` / `savedNameScroll`）
 * 并在挂载后写回容器。虚拟化**不改这条**：滚动容器仍是同一个 `<div>`，
 * 只是它内部的行改由窗口决定。
 */

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** 窗口两侧各多渲染几行（滚动时下一行已在 DOM 里，不会出现"滚到才渲染"的白边）。 */
export const MEDIA_PREVIEW_OVERSCAN = 4;

/** 虚拟化出来的一行。 */
export interface VirtualRow {
  /** 行号（从 0 开始）。 */
  index: number;
  /** 距内容顶部的像素偏移（由虚拟化库给出）。 */
  start: number;
  /** 行高（px）。 */
  size: number;
}

/** 虚拟化窗口的当前状态。 */
export interface VirtualRows {
  /** 要渲染的行（只含视口内 + overscan）。 */
  rows: VirtualRow[];
  /** 内容总高度（px）——滚动条长度由它决定，必须稳定，否则滚动条抖动。 */
  totalSize: number;
}

/**
 * 按**固定行高**虚拟化 `rowCount` 行。
 *
 * 只适用于行高一致的容器（平铺 / 列表）：`estimateSize` 是常量，因此
 * 内容总高度 = `rowCount × 行高`，不依赖任何测量，滚动条不会随滚动变化。
 *
 * `scrollRef` 必须是**滚动容器**本身（`overflow: auto` 的那个），不是内部的行包裹层。
 */
export function useFixedRowVirtualizer(
  scrollRef: React.RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
  /** 容器挂载/切换的信号：容器从无到有时 `useRef` 不会触发重渲，靠它重跑一次。 */
  containerVersion: number,
  /** 行间距（px）：**只有这里加**，行盒高度里不含它（否则间距翻倍）。 */
  gap = 0,
): VirtualRows {
  const virtualizer = useVirtualizer({
    count: Math.max(0, rowCount),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: MEDIA_PREVIEW_OVERSCAN,
    gap,
  });

  // 行高变化（图片尺寸滑条 / 显示文件名开关）或容器换了一个之后必须重新测量：
  // 否则窗口仍按旧行高算，表现为"改了尺寸后只渲染屏幕中间一条"。
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight, containerVersion, gap]);

  const items = virtualizer.getVirtualItems();
  const rows: VirtualRow[] = items.map((item) => ({
    index: item.index,
    start: item.start,
    size: item.size,
  }));

  return {
    rows,
    totalSize: virtualizer.getTotalSize(),
  };
}

/**
 * 按**测量到的真实行高**虚拟化 `rowCount` 行。
 *
 * 用于行高由文字度量决定的容器（文件名列表）：`estimateSize` 只是首帧的估计值，
 * 渲染后由 `measureElement` 量回真实高度。这样**不必把字体行高猜死**——猜错会让
 * "行号 × 行高"与浏览器实际布局逐渐错位（越滚越偏），而字体度量随语言/缩放变化。
 *
 * **用法（缺一不可）**：把 `measureRef` 挂到每一行的**外层元素**上，并给该元素加
 * `data-index={行号}`。库靠 `data-index` 把 DOM 节点反查回行号；少了它测量会被
 * **整条跳过**（`indexFromElement` 返回 -1 → `isIndexInRange(-1)` 为假），
 * 行高永远停在首帧估计值。这是实测确认过的（见缺陷 0018 的记录）。
 */
export function useMeasuredRowVirtualizer(
  scrollRef: React.RefObject<HTMLElement | null>,
  rowCount: number,
  estimatedRowHeight: number,
  containerVersion: number,
  /** 行间距（px）：**只有这里加**，行盒高度里不含它（否则间距翻倍）。 */
  gap = 0,
): VirtualRows & { measureRef: (node: HTMLElement | null) => void } {
  const virtualizer = useVirtualizer({
    count: Math.max(0, rowCount),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: MEDIA_PREVIEW_OVERSCAN,
    gap,
  });

  // 容器换了一个（条件渲染重建）后必须重新测量。
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, containerVersion, gap]);

  const items = virtualizer.getVirtualItems();
  const rows: VirtualRow[] = items.map((item) => ({
    index: item.index,
    start: item.start,
    size: item.size,
  }));

  return {
    rows,
    totalSize: virtualizer.getTotalSize(),
    measureRef: virtualizer.measureElement,
  };
}

/**
 * 滚动容器的 **callback ref + 版本号**。
 *
 * 面板的三个容器是**条件渲染**的（`viewMode` / `view` / `foreground`），挂载顺序与
 * 时机都不同；`useRef` 本身不会触发重渲，于是"容器从无到有"对虚拟化库与滚动恢复
 * 都是不可见的。callback ref 每次挂载/卸载都会调用，借此把"容器已就绪"变成可依赖的信号。
 */
export function useContainerRef(): {
  ref: (node: HTMLDivElement | null) => void;
  elementRef: React.RefObject<HTMLDivElement | null>;
  version: number;
} {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [version, setVersion] = useState(0);
  // `useRef` 的 `.current` 是只读的（React 类型如此），因此回调本身也放进 ref 的
  // **外层**（用 `useState` 的惰性初始化拿一个恒定引用），而不是改写 `.current`。
  const [ref] = useState(() => (node: HTMLDivElement | null) => {
    elementRef.current = node;
    setVersion((v) => v + 1);
  });
  return { ref, elementRef, version };
}
