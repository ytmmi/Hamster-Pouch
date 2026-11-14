/**
 * **面板激活 / 可见性变化的唯一订阅口**（dockview 的 `onDidActiveChange` + `onDidVisibilityChange`）。
 *
 * ## 为什么要一处
 *
 * 「面板回到前台时补做一次」是六处共有的需求：设置热加载（`shared/settingValue.ts`）、
 * 查看器设置（`panels/imageviewer/useViewerSettings.ts`）、查看器取焦点、调色板补读、
 * 两个播放器的切标签自动暂停（媒体 / 音乐）。此前每处各抄一遍「两个订阅 + 首次 `sync()`
 * + 逐个 `dispose()`」，于是**语义各自漂移**：有的判 `isVisible && isActive`，有的只看
 * `isVisible`，首次同步有无、退订有无都不一致。
 *
 * ## `isVisible` 与 `isActive` 是两件事（踩过的坑，别再回去）
 *
 * dockview 8.3.1 里 `isVisible` = 本面板是**组内激活标签**；`isActive` 还要求**该组本身
 * 是激活组**。用户点另一个组（媒体源 / 相册）时，本面板的 `isActive` 立刻变 false，但它
 * 仍稳稳显示在自己组里——判「回到前台」用 `isActive` 会漏掉这一场景（实测缺陷，见
 * `shared/panelForeground.ts` 的长注释）。
 *
 * 因此本钩子**只负责如实回调两个状态**，判据留给调用方：
 * - 「回到前台补一次」用 `isVisible`（切回本组标签即生效，与焦点无关）；
 * - 「用户此刻正看着、可以抢键盘」用 `isVisible && isActive`。
 *
 * ## 合同
 *
 * - 挂载时**立即回调一次**当前状态（读的是 dockview 的实时 getter，不是事件载荷），
 *   因此订阅晚于事件也不会错过；
 * - 每次激活/可见变化各回调一次（同一次切换可能触发两次，回调必须幂等——现有调用方的
 *   `sync()` 都是「读当前态 → 决定做什么」，天然幂等）；
 * - 卸载时退订；`panelApi` 缺省（测试 / 非 dockview 宿主）时什么也不做；
 * - 回调经 ref 转发：调用方可以内联箭头函数，不会因为每次渲染换身份而反复重订阅。
 */

import { useEffect, useRef } from "react";

import type { PanelRenderCtx } from "../core/panelRegistry";

/** 面板此刻的激活 / 可见状态（两个维度分开给，判据由调用方决定）。 */
export interface PanelActivity {
  isVisible: boolean;
  isActive: boolean;
}

/**
 * 订阅面板的激活与可见变化；`onChange` 在挂载首帧与每次变化时被调用。
 */
export function usePanelActivity(
  panelApi: PanelRenderCtx["api"] | undefined,
  onChange: (state: PanelActivity) => void,
): void {
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    if (!panelApi) return;
    const sync = () => {
      callback.current({
        isVisible: Boolean(panelApi.isVisible),
        isActive: Boolean(panelApi.isActive),
      });
    };
    const disposables = [panelApi.onDidActiveChange(sync), panelApi.onDidVisibilityChange(sync)];
    sync();
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [panelApi]);
}
