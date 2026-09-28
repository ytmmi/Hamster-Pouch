/**
 * 浮层**容器**的宿主渲染（RFC 0007 浮层节点 / D50；`docs/spec/control-standard.md` 第 8 节末）。
 *
 * 分工：蓝图引擎把浮层 `contains` 的**内容面板**按 `size` 以浮动方式显示（`showOverlayPanel`），
 * 并把「容器期望可见态 + 外观档位」交给宿主；**本模块负责容器本身**——圆角 / 阴影 /
 * 组件标签隐藏 / 叠放层级。外观只取 `packages/ui` 的设计 token 档位，**不写死像素**
 * （浅色/深色由 token 的 alpha 自动适配）。
 *
 * 落点是 dockview 为浮动组渲染的**窗口元素**（不改 dockview 的 DOM 结构，只在其上设内联
 * 样式与 CSS 变量，因此不新增样式表规则）：
 *
 * ```text
 * .dv-floating-overlay-host
 *   > .dv-resize-container[.dv-resize-container-with-titlebar]   ← 容器（圆角/阴影/叠放）
 *       > .dv-floating-titlebar                                   ← 组件标签（hide_label 隐藏）
 *       > .dv-grid-view > .dv-groupview                            ← group.element（内容面板所在组）
 * ```
 *
 * CSS 契约依赖（dockview 8.3.1，实测）：
 * - `.dv-resize-container` 的 `border: var(--dv-floating-border)`、
 *   `box-shadow: var(--dv-floating-box-shadow)`、`z-index: calc(var(--dv-overlay-z-index) - 2)`，
 *   而**基础样式不设圆角**，所以圆角由本模块给出（并与 `overflow: hidden` 一起生效）。
 * - `floatingGroupDragHandle` 未配置时 dockview 默认渲染**独立标题栏**（`"titlebar"`），
 *   且它同时是拖拽手柄——因此 `hide_label` 会一并隐藏该浮动窗口的拖拽手柄。
 *   浮层位置本就由蓝图的锚点/偏移决定（不是让用户拖），这是有意取舍。
 */

import type { OverlayAppearance, TokenLevel } from "@hamster-pouch/config";
import { RADIUS, SHADOW, type ThemeName } from "@hamster-pouch/ui";
import type { DockviewApi } from "dockview-react";

/** 被装饰过的浮动窗口上的标记属性，值 = 浮层节点 key（供自检与诊断观察）。 */
export const OVERLAY_CHROME_ATTR = "data-hp-overlay";

/** dockview 浮动窗口的窗口元素选择器（容器渲染落点）。 */
export const FLOATING_WINDOW_SELECTOR = ".dv-resize-container";
/** 浮动窗口的标题栏选择器（= 「组件标签」，`hide_label` 的目标）。 */
export const FLOATING_TITLEBAR_SELECTOR = ".dv-floating-titlebar";

/**
 * dockview 浮动窗口的叠放基准：其 CSS 里 `--dv-overlay-z-index` 的默认值
 * （`.dv-resize-container` 自身用 `calc(var(--dv-overlay-z-index) - 2)`，手柄用原值）。
 */
export const OVERLAY_Z_BASE = 999;

/** 圆角档位 → 像素（取 `packages/ui` 的 `RADIUS`；`none` = 0 = 直角）。 */
export function overlayRadiusPx(level: TokenLevel): number {
  switch (level) {
    case "sm":
      return RADIUS.sm;
    case "lg":
      return RADIUS.lg;
    case "none":
      return 0;
    case "md":
    default:
      return RADIUS.md;
  }
}

/** 阴影档位 → CSS 阴影值（取 `packages/ui` 的 `SHADOW`，不透明度随主题）。 */
export function overlayShadowCss(level: TokenLevel, theme: ThemeName): string {
  const token = SHADOW[level] ?? SHADOW.md;
  const alpha = token.alpha[theme];
  return token.blur === 0 && alpha === 0
    ? "none"
    : `0 ${token.y}px ${token.blur}px rgba(0, 0, 0, ${alpha})`;
}

/**
 * 叠放高度参数（1–10）→ `z-index`。
 *
 * RFC 0007：浮层**整体在布局块之上**，`height` 只在浮层之间比较（值大者在上），
 * 因此这里以 dockview 的浮动基准为底数直接相加。
 */
export function overlayZIndex(height: number): number {
  return OVERLAY_Z_BASE + height;
}

/**
 * 把浮层容器的外观档位应用到浮动窗口元素上（**幂等**：同一元素重复应用结果一致）。
 *
 * 只用 `style.setProperty` / `removeProperty`，因此对"假元素"也能自检
 * （见 `tools/blueprint-engine-check.mjs` 的宿主渲染段）。
 */
export function applyOverlayChrome(
  el: HTMLElement,
  input: { key: string; appearance: OverlayAppearance; theme: ThemeName },
): void {
  const { key, appearance, theme } = input;
  const radius = overlayRadiusPx(appearance.radius);
  el.setAttribute(OVERLAY_CHROME_ATTR, key);
  el.style.setProperty("border-radius", `${radius}px`);
  if (radius > 0) {
    // 圆角必须与裁剪同时生效：否则子元素（`.dv-grid-view`）的直角会从圆角外露出来
    // （`.dv-resize-container` 自带背景色，圆角外会露出方形底）。
    //
    // **有意取舍**：dockview 的缩放手柄以 −2px 内缩（`.dv-resize-handle-top { top: -2px }` 等），
    // 而 `.dv-resize-container` 是 `position: absolute`（正是手柄的包含块），所以 `overflow: hidden`
    // 会削掉手柄朝外的一半，命中区由 4px 变 2px。可以接受：浮层尺寸由蓝图 `size` 决定、
    // 位置由九宫格锚点 + 偏移决定，使用者本就不需要拖拽/缩放它；而 `radius = none` 时
    // **不做裁剪**，手柄完全不受影响。
    el.style.setProperty("overflow", "hidden");
  }
  el.style.setProperty("--dv-floating-box-shadow", overlayShadowCss(appearance.shadow, theme));
  el.style.setProperty("--dv-overlay-z-index", String(overlayZIndex(appearance.height)));
  const titlebar = el.querySelector<HTMLElement>(FLOATING_TITLEBAR_SELECTOR);
  if (titlebar) {
    // `hide_label` 隐藏组件标签。注意：dockview 在未配置 `floatingGroupDragHandle` 时
    // 默认渲染独立标题栏（`"titlebar"`），它同时是拖拽手柄——因此隐藏标签即隐藏拖拽手柄。
    // 浮层位置由蓝图的锚点/偏移决定，这是有意的取舍。
    titlebar.style.setProperty("display", appearance.hideLabel ? "none" : "");
  }
}

/** 撤销容器渲染（浮层隐藏、内容面板不再浮动、或布局重建后调用）；与 apply 严格对称。 */
export function clearOverlayChrome(el: HTMLElement): void {
  el.removeAttribute(OVERLAY_CHROME_ATTR);
  el.style.removeProperty("border-radius");
  el.style.removeProperty("overflow");
  el.style.removeProperty("--dv-floating-box-shadow");
  el.style.removeProperty("--dv-overlay-z-index");
  const titlebar = el.querySelector<HTMLElement>(FLOATING_TITLEBAR_SELECTOR);
  if (titlebar) {
    titlebar.style.removeProperty("display");
  }
}

/**
 * 内容面板所在 **dockview 浮动窗口**的容器元素。
 *
 * 只有**浮动**组才是浮层的容器（停靠组不是浮层）；面板不存在、不同组、或组未浮动时返回
 * `null`——调用方跳过并记诊断，**不抛错**（浮层渲染失败不得影响布局）。
 */
export function floatingWindowOf(dv: DockviewApi, panelId: string): HTMLElement | null {
  const group = dv.getPanel(panelId)?.api.group;
  if (!group || group.api.location.type !== "floating") {
    return null;
  }
  return group.element.closest<HTMLElement>(FLOATING_WINDOW_SELECTOR);
}
