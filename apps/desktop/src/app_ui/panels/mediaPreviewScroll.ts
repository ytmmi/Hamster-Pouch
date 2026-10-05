/**
 * 媒体预览面板：**滚动位置恢复**的纯逻辑（无框架依赖，`pnpm check:panels` 可直接 import）。
 *
 * ## 为什么需要它（缺陷 0018 P1-A 引入的回归）
 *
 * 面板把滚动位置存在模块级变量里（跨 dockview 卸载重建保留）。P1-A **之前**取数是
 * "一次取回有界的一页"（旧实现写死的条目上限），恢复滚动时**内容已经是全部**，
 * 直接 `scrollTop = 保存值` 就能到位。
 *
 * 改成**后台翻页**之后，"恢复的时机"与"内容的长度"不再同步：
 * 第一页（`MEDIA_PREVIEW_PAGE_LIMIT = 500` 项）到手时 effect 就跑，此时内容只有 500 行高；
 * 若保存的位置来自更深的浏览进度（例如 5 万张时滚到 3 万行），浏览器会把 `scrollTop`
 * **夹到当前内容高度**，位置丢失。
 *
 * ## 更隐蔽的第二次丢失（这才是必须"记住意图"的原因）
 *
 * `scrollTop = 保存值` 会触发一次 `scroll` 事件，而面板的监听器把"当前 scrollTop"
 * （**已被夹住的中间值**）当成新目标写回模块级变量——原始目标就此永久消失。
 * 于是即便后来内容变长、effect 再跑一次，也**已经不知道该恢复到哪里**。
 *
 * 因此修正分两半，缺一不可：
 * 1. 目标位置还到不了时，**不把被夹住的中间值记成目标**（[`onScrollEvent`]）；
 * 2. 翻页让内容变长后**再恢复一次**（面板把内容长度放进 effect 依赖数组）。
 *
 * 这两件事都收敛成本文件的纯函数：`pnpm check:panels` 直接跑真函数断言，
 * 不必启动浏览器。
 */

/**
 * 一条滚动容器的恢复状态。
 *
 * - `target`：**用户意图**——想恢复到的位置。跨挂载保留，只在"用户真的滚了"时改变；
 * - `pending`：非 `null` = 这个目标**现在到不了**，内容变长后要再试一次；
 *   在此期间**不得**让 `scroll` 事件覆盖 `target`。
 */
export interface ScrollSlot {
  target: number;
  pending: number | null;
}

/** 新建一条恢复状态（面板的模块级变量用它初始化）。 */
export function createScrollSlot(): ScrollSlot {
  return { target: 0, pending: null };
}

/** 内容当前**最多能滚到**的位置。容器尚未布局时两者为 0，于是上限为 0。 */
export function maxScrollable(contentHeight: number, viewportHeight: number): number {
  const content = Number.isFinite(contentHeight) ? contentHeight : 0;
  const viewport = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return Math.max(0, content - viewport);
}

/**
 * 目标是否**还不能确认已到位**——即现在设 `scrollTop` 可能被浏览器夹住。
 *
 * 注意判据是"**不能确认**"而不是"内容很短"，这两者在首帧并不等价：
 *
 * - 目标 <= 0 → `false`（本来就没有要恢复的位置）；
 * - `contentHeight <= 0` → **`true`**：容器尚未布局（首帧 `scrollHeight` 为 0），
 *   这不是"内容只有 0 高"，而是"还不知道有多高"。此时设 `scrollTop` 必然被夹成 0，
 *   而那次赋值会触发 `scroll` 事件——若判成"已到位"，[`onScrollEvent`] 就会把 0
 *   当成用户意图记下来，**把保存的位置抹掉**（正是本文件要修的那类回归）；
 * - 否则按可滚上限比较。
 */
export function needsScrollRestore(
  target: number,
  contentHeight: number,
  viewportHeight: number,
): boolean {
  const wanted = Number.isFinite(target) ? target : 0;
  if (wanted <= 0) return false;
  const content = Number.isFinite(contentHeight) ? contentHeight : 0;
  if (content <= 0) return true;
  return wanted > maxScrollable(content, viewportHeight);
}

/**
 * 容器挂载 / 内容变长时：算出**现在该设的 `scrollTop`**，并更新 `slot.pending`。
 *
 * @param contentComplete 取数是否**已翻完**（`!loading`）。翻完后内容不再变长，
 *   此时若目标仍到不了（例如条目被删掉了），就把它夹到可滚上限并**解除** `pending`
 *   ——否则 `pending` 会永远挂着，用户之后的滚动全都记不进 `target`。
 *
 * **收敛只在容器已布局时做**（`contentHeight > 0`）：首帧 `scrollHeight` 是 0，
 * 那不是"内容很短"而是"还没量出来"，此时夹成 0 会把保存的位置直接抹掉。
 */
export function planScrollApply(
  slot: ScrollSlot,
  contentHeight: number,
  viewportHeight: number,
  contentComplete: boolean,
): number {
  const wanted = Number.isFinite(slot.target) ? Math.max(0, slot.target) : 0;
  const content = Number.isFinite(contentHeight) ? contentHeight : 0;
  if (contentComplete && content > 0 && needsScrollRestore(wanted, content, viewportHeight)) {
    // 内容已经不会再长：目标不可能达成，就地收敛到上限，别把 pending 永久挂住。
    const clamped = maxScrollable(content, viewportHeight);
    slot.target = clamped;
    slot.pending = null;
    return clamped;
  }
  slot.pending = needsScrollRestore(wanted, contentHeight, viewportHeight) ? wanted : null;
  return wanted;
}

/**
 * `scroll` 事件到达时更新 `slot`。
 *
 * 这是回归的第二半：`pending !== null` 期间，容器里的 `scrollTop` 可能是
 * "程序设了目标、被浏览器夹住"的产物，**不能**当成用户意图记下来——否则真正的目标
 * 被覆盖，后面内容变长也恢复不回去。
 *
 * - 还欠恢复、且内容仍装不下 → `target` **不变**（保住意图），`pending` 继续挂着；
 * - 还欠恢复、且内容已装得下 → 这一跳就是恢复本身落地，按目标收口并**解除** `pending`；
 * - 不欠恢复 → 正常记录用户滚动到的位置。
 */
export function onScrollEvent(
  slot: ScrollSlot,
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
): void {
  if (slot.pending !== null && needsScrollRestore(slot.pending, contentHeight, viewportHeight)) {
    return;
  }
  slot.target = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  slot.pending = null;
}
