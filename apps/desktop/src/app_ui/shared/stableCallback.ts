/**
 * 把"每帧都会换身份"的回调收敛为**恒定引用**，好让条目单元的 `memo` 真正生效。
 *
 * 为什么需要它：`app` 上下文对象在**每次选中变化**时都会换身份，于是依赖 `app` 的
 * `useCallback` 也全部换身份——一屏几百个单元的 props 逐个"变了"，`memo` 形同虚设。
 * 这里把最新实现放进 ref、对外只暴露一个恒定引用；单元只在 `selected` 真的变化时重渲。
 * 语义与直接传原函数**完全一致**（调用时读的是最新实现，不存在闭包过期）。
 *
 * 消费方是**两个面板**：媒体预览（`panels/MediaPreviewPanel.tsx`，缩略图单元）与
 * 图书预览（`panels/bookpreview/BookPreviewPanel.tsx`，三种视图的图书单元）。
 * 同一件事只有这一份实现——两处各写一套的话，"恒定引用"这个前提迟早有一边失效，
 * 而失效的表现只是"面板变卡"，不会被任何断言直接抓到。
 */

import { useCallback, useRef } from "react";

/** 返回一个恒定引用的代理：调用时转调**最新**的 `fn`。 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
