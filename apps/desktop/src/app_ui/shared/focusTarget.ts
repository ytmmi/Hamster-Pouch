/**
 * **面板激活时该不该把键盘焦点拿到面板根节点**——判据的唯一实现（D220）。
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
 *
 * 刻意是**纯逻辑模块**（无 React / Tauri / DOM 依赖）：门禁直接 `import` 它来驱动判据表，
 * 图像查看器的键位模块也把它按历史名字转出（`viewerKeymap.ts` 的 `shouldTakeViewerFocus`）。
 */

/**
 * 焦点判据看得见的**最小形状**：`document.activeElement`（`Element | null`）
 * 结构性满足它，因此判据不必依赖 DOM 类型即可被门禁驱动。
 */
export interface FocusTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** 面板被激活时**该不该**把键盘焦点拿到面板根节点。判据表见文件头。 */
export function shouldTakePanelFocus(target: FocusTarget | null | undefined): boolean {
  if (!target) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (target.isContentEditable) return false;
  if (typeof target.closest !== "function") return true;
  return !target.closest('[role="dialog"]') && !target.closest('[role="tablist"]');
}
