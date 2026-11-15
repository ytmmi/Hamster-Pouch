/**
 * **面板被激活时把键盘焦点交给面板根节点的唯一实现**（D220）。
 *
 * 每个带键盘操作的面板都要这一件事，但"什么时候取、取之前看什么、为什么延后一帧"
 * 三道细节缺一条就"看起来实现了、实际按不动"。曾只有图像查看器一份内联实现，
 * 媒体播放器与音乐播放器都没接——用户点标签切到音乐面板后方向键/空格确实不响应。
 *
 * 三道收敛，缺一不可：
 *
 * 1. **只在"进入"这个转换上取一次**（`enteredRef`）。`panelApi` 在独立单面板窗口里是
 *    每次渲染新建的替身对象，若不加这道判据，重渲染就会反复抢焦点——把用户正在
 *    同一个窗口里用键盘操作的按钮顶掉。
 * 2. **判据在激活的**当帧**读**（`shouldTakePanelFocus(document.activeElement)`），
 *    并且**区分这次激活是鼠标点来的还是键盘按来的**（`pointerRef`，靠 document 上的
 *    capture `pointerdown` 记时间戳）。为什么必须区分：点标签页时，`pointerdown` 那一刻
 *    焦点还在**上一个**标签上（`dv-inactive-tab`），而标签在 `[role="tablist"]` 内——
 *    判据本来该拦下"标签条内不抢"，结果鼠标点进来的面板永远拿不到焦点（用户报的
 *    「音乐面板点标签切进来后方向键/空格不响应」正是这条）。有指针参与时按"用户指着
 *    这个面板"处理，直接取焦点；纯键盘（标签条里按 Enter 激活）仍让路，标签条的
 *    左右键导航得以保留。
 * 3. **取焦点延后一帧**：鼠标点标签页时浏览器会在默认动作里把焦点给**标签元素**
 *    （dockview 的标签是可聚焦的 `div`），同步 `focus()` 会被它覆盖掉，表现为
 *    "点进来了、方向键还是不动"。等默认动作走完再取，面板根节点才真正拿到键盘。
 *    延后期间**不重复判据**——否则又会读到刚被聚焦的标签而放弃。
 *
 * 面板根节点还需要 `tabIndex={0}`（否则 `focus()` 无处可去），根节点上的点击处理器
 * 也**只能聚焦**、不能调 `panel.api.setActive()`：在 `pointerdown` 里同步激活面板会让
 * 面板 DOM 重新挂载/重排，浏览器随即取消 `mousedown` 兼容事件，原生 `<input type=range>`
 * 的拖拽从此永不启动（媒体播放器进度条"按住拖、值不动"就是这么来的，D220 修）。
 */
import { useEffect, useRef, type RefObject } from "react";

import type { PanelRenderCtx } from "../core/panelRegistry";
import { usePanelActivity } from "./panelActivity";
import { shouldTakePanelFocus } from "./focusTarget";

export function usePanelFocusOnActivate(
  panelApi: PanelRenderCtx["api"] | undefined,
  rootRef: RefObject<HTMLElement | null>,
): void {
  const enteredRef = useRef(false);
  const frameRef = useRef(0);
  /** 最近一次指针按下的时刻：用来分辨"鼠标点标签进来"与"键盘在标签条里激活"。 */
  const pointerRef = useRef(0);

  useEffect(() => {
    // capture 阶段，早于 dockview 标签自己的处理器（激活回调就在那次派发里同步触发）。
    const mark = () => {
      pointerRef.current = Date.now();
    };
    document.addEventListener("pointerdown", mark, true);
    return () => document.removeEventListener("pointerdown", mark, true);
  }, []);

  usePanelActivity(panelApi, ({ isVisible, isActive }) => {
    // 闭包里再取一次：参数是可重赋值的绑定，收窄不会跨进 `requestAnimationFrame` 的回调。
    const api = panelApi;
    if (!api) return;
    const active = isVisible && isActive;
    const entered = active && !enteredRef.current;
    enteredRef.current = active;
    if (!entered) return;
    // 指针刚按下（点标签/点面板）→ 按"用户指着这个面板"处理；纯键盘激活才走判据表。
    const byPointer = Date.now() - pointerRef.current < 600;
    if (!byPointer && !shouldTakePanelFocus(document.activeElement)) return;
    // 连续快速切换标签时只保留最后一次待执行的取焦点（不因重渲染丢掉它——
    // 独立单面板窗口的 `panelApi` 每次渲染都换身份，回调本身也随之重跑）。
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      // 帧内**重读激活态**：这一帧里用户可能已经切走了，此时不能再抢焦点。
      // （只重读激活态，不重读焦点判据——那时浏览器已把焦点给到标签元素。）
      if (!api.isVisible || !api.isActive) return;
      rootRef.current?.focus({ preventScroll: true });
    });
  });

  // 卸载时撤掉尚未执行的取焦点（组件已不在，聚焦无处可去）。
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
}
