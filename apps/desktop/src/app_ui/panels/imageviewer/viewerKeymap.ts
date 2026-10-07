/**
 * 图像查看器：**按键映射**与**键盘焦点获取判据**（纯函数，无框架依赖）。
 *
 * 为什么单独成文件（与 `viewerPlacement.ts` / `viewerZoom.ts` 同一条口径）：
 *
 * 1. 「哪个键做什么」只在这里写一次——面板组件消费 `viewerKeyAction`，不自己散落
 *    `case "ArrowLeft"` 之类的分支（散落两处就是漂移源：改一处漏一处）；
 * 2. 门禁 `pnpm check:panels` 可**直接 import** 它，按**行为**断言（左 = 上一张、
 *    右 = 下一张、无关按键不响应），而不是只对源码写正则；
 * 3. 「面板被激活时该不该把键盘焦点拿过来」同样是纯函数：判据与组件分离，
 *    可被断言、可复用，且本文件不 import React / Tauri。
 *
 * **顺序口径**：上一张 / 下一张**就是胶片栏的顺序**——本文件不碰序列，面板只把动作
 * 交给 `stepIndex(sequence.index, sequence.files.length, ±1)`，序列来源见
 * `useViewerSequence.ts`（相册 / 源或子目录 / 全仓库，保序子序列）。
 */

/** 面板对一次按键的响应动作。 */
export type ViewerKeyAction = "prev" | "next" | "fit" | "actual";

/**
 * 按键 → 动作；**不匹配返回 `null`**（调用方据此放行该按键，既不处理也不
 * `preventDefault`，宿主与浮层的快捷键照常冒泡）。
 *
 * - `ArrowLeft` / `ArrowUp` / `PageUp` → **上一张**；
 * - `ArrowRight` / `ArrowDown` / `PageDown` → **下一张**；
 * - `Home` → 适应窗口；`1` → 100%（1:1）。
 *
 * 方向键的**上下**与 `PageUp` / `PageDown` 一并保留：它们自本面板引入起就是同一语义
 * （见 `docs/spec/panel-standard.md` 第 8 节与面板文件头），删掉即是对既有行为的回归；
 * 用户 2026-10-07 要求的左右两键是其中的一个子集。
 */
export function viewerKeyAction(key: string): ViewerKeyAction | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return "prev";
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return "next";
    case "Home":
      return "fit";
    case "1":
      return "actual";
    default:
      return null;
  }
}

/**
 * 焦点判据看得见的**最小形状**：`document.activeElement`（`Element | null`）
 * 结构性满足它，因此判据不必依赖 DOM 类型即可被门禁驱动。
 */
export interface ViewerFocusTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * 面板被激活时**该不该**把键盘焦点拿到面板根节点。
 *
 * 为什么需要这条判据：面板被**程序激活**（蓝图双击图像 → `focusPanel` →
 * `panel.api.setActive()`）时，DOM 焦点还留在原面板上，根节点的 `onKeyDown`
 * 根本收不到方向键——表现为"进来了却按方向键没反应"。取焦点是修法，但**不能无条件抢**。
 *
 * 判据（失败方向刻意选"**不抢**"——抢错的代价是把用户正在打的字打到别处）：
 *
 * | 焦点当前在 | 取？ | 理由 |
 * | --- | --- | --- |
 * | 无 / `<body>` / 普通元素 | ✅ | 这正是"从别的面板进来"的形态 |
 * | `input` / `textarea` / `select` / `contenteditable` | ❌ | 用户正在输入 |
 * | 模态浮层内（`[role="dialog"]`） | ❌ | 全部设置 / 确认弹窗 / 任务浮窗盖在布局之上，键盘属于浮层 |
 * | 标签条内（`[role="tablist"]`） | ❌ | dockview 用方向键在标签间移动焦点（roving tabindex）；抢走即把标签键盘导航废掉 |
 */
export function shouldTakeViewerFocus(target: ViewerFocusTarget | null | undefined): boolean {
  if (!target) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (target.isContentEditable) return false;
  if (typeof target.closest !== "function") return true;
  return !target.closest('[role="dialog"]') && !target.closest('[role="tablist"]');
}
