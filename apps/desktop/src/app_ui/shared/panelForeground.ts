/**
 * 面板内容是否**正在显示**——「后台标签**冻结**」的依据。
 *
 * ## 判据只看 `isVisible`，**绝不能**加 `isActive`（踩过的坑，别再回去）
 *
 * dockview 8.3.1 的面板级语义（`DockviewPanel.updateParentGroup` / `runEvents`）是：
 *
 * ```js
 * const isPanelVisible = this._group.model.isPanelActive(this);   // 本面板是**组内激活标签**
 * const isActive       = this.group.api.isActive && isPanelVisible; // 还要求**该组是激活组**
 * ```
 *
 * 也就是说 `isActive` 表示"**这个组**也是当前聚焦的组"。用户点另一个面板（比如媒体源 /
 * 相册）时，**那个组**成为激活组，本面板的 `isActive` 立刻变 false——但本面板仍稳稳地
 * 显示在自己组里。用 `isVisible && isActive` 当冻结判据，就会出现"点了源/相册，媒体预览
 * 不刷新，非得再点一下媒体预览才显示"（实测缺陷）：数据早就在后台加载好了，只是容器被
 * 冻结没渲染，而"点一下"恰好把本组变回激活组。
 *
 * 因此：`isVisible === false`（本面板不是所在组的激活标签 → 内容被别的标签盖住、
 * 或整组被漂浮/弹出窗口收起）才冻结；**在前台但没焦点**的面板照常更新。
 *
 * ## 为什么需要冻结
 *
 * dockview 会把非激活标签的组件**留在 DOM 里**（媒体预览还被 `MenuBar` 显式设成
 * `renderer: "always"`，为的是同组 tab 切换不丢滚动位置）。于是被盖住的面板会继续：
 *
 * - 参与**每一次选中变更**的渲染（一屏 300 个单元逐个 reconcile）；
 * - 为离屏单元请求缩略图、解码音频波形（`decodeAudioData` 是实打实的 CPU）；
 * - 跟随面板尺寸做瀑布流列数测量。
 *
 * 这些工作用户**根本看不到**。冻结的做法不是"少渲染一点"，而是**不显示就不渲染条目容器**：
 * 成本降到工具栏那一行，切回该标签时再渲染（缩略图 URL 与波形都有共享缓存，
 * 重新渲染只是重建 DOM），滚动位置由各面板自己的模块级变量恢复。
 */

import { useEffect, useState } from "react";

import type { PanelRenderCtx } from "../core/panelRegistry";

export function usePanelForeground(panelApi?: PanelRenderCtx["api"]): boolean {
  /**
   * 首帧**乐观地**当作在显示，挂载后立刻由 `sync()` 校正（dockview 自己的 `_isVisible`
   * 初值也是 `true`，两者一致）。
   *
   * 方向性是刻意的：判断"不在显示"而误**会造成面板一片空白**（用户看不到内容），
   * 而判断"在显示"而误只是**多渲染一次**。因此失败方向选"先渲染"。
   * `sync()` 读的是 dockview 的**实时 getter**（不是事件载荷），所以即使订阅晚于事件，
   * 也能立刻拿到正确值。
   */
  const [foreground, setForeground] = useState(true);

  useEffect(() => {
    if (!panelApi) return;
    const sync = () => setForeground(Boolean(panelApi.isVisible));
    const disposables = [panelApi.onDidVisibilityChange(sync)];
    sync();
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [panelApi]);

  return foreground;
}
