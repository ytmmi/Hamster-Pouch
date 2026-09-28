/**
 * 右键上下文菜单容器。
 *
 * - **渲染到 `document.body`（portal）**——这不是风格选择，是修一个真实缺陷，见下；
 * - 定位到鼠标坐标 (x, y)，靠近窗口右/下边缘时**翻到光标另一侧**，放不下才贴边内收；
 * - 监听内容尺寸变化（如展开子菜单后变长）：先尝试整体上移，
 *   若仍放不下则限制最大高度并启用纵向滚动，保证菜单始终可用。
 *
 * ## 为什么必须 portal（2026-09 修复）
 *
 * dockview 在**布局动画期**给面板内容的直接父元素加 transform：
 *
 * ```css
 * .dv-pane-container.dv-animated .dv-view { will-change: transform; transform: …; }
 * .dv-split-view-container.dv-animation .dv-view { will-change: transform; …; }
 * ```
 * （两条都来自 dockview 自带的 dockview.css。**注意**：这里不能在块注释里写
 * 行内的 CSS 注释记号——内层那个「星号斜杠」会提前**关闭**本段注释。）
 *
 * `transform` / `will-change: transform` 会让该元素成为 **`position: fixed` 的包含块**
 * （CSS 规范），于是本组件里的 `left: clientX`（**视口**坐标）被当成**相对面板**的坐标解释，
 * 菜单就跑到面板右下角、离光标很远；而 `.dv-groupview { overflow: hidden }` 再把它
 * **按面板边缘裁掉**。两个现象同源。
 *
 * 顶层菜单栏（`MenuBar.tsx`）不在 `.dv-view` 里，所以它一直正常——这也是当初没被发现的原因。
 * portal 到 `body` 后 `position: fixed` 重新相对视口，且逃出面板的裁剪。
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** 菜单与视口边缘的最小间距。 */
const MARGIN = 4;

export function ContextMenu({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // 先隐藏，量完再显示：避免首帧闪在未校正的位置。
  const [style, setStyle] = useState<CSSProperties>({
    left: x,
    top: y,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const update = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = el.offsetWidth;
      // 内容完整高度（不受 maxHeight 限制，避免测量循环）。
      const contentHeight = el.scrollHeight;
      let left = x;
      let top = y;

      // 水平：右越界 → 翻到光标左侧；左侧也放不下才贴右边内收。
      if (left + width > vw - MARGIN) {
        const flipped = x - width;
        left = flipped >= MARGIN ? flipped : Math.max(MARGIN, vw - width - MARGIN);
      }

      // 垂直：下越界 → 翻到光标上方；上方也放不下才贴底内收并滚动。
      let maxHeight: number | undefined;
      if (top + contentHeight > vh - MARGIN) {
        const flipped = y - contentHeight;
        if (flipped >= MARGIN) {
          top = flipped;
        } else {
          top = Math.max(MARGIN, vh - contentHeight - MARGIN);
          if (top + contentHeight > vh - MARGIN) {
            maxHeight = vh - top - MARGIN;
          }
        }
      }

      setStyle({
        left,
        top,
        visibility: "visible",
        ...(maxHeight ? { maxHeight, overflowY: "auto" as const } : {}),
      });
    };

    update();
    // 内容变化（展开/收起子菜单、项增减）时重新校正。
    const observer = new ResizeObserver(update);
    observer.observe(el);
    // 窗口尺寸变化也要重算，否则缩放后菜单会越界。
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [x, y]);

  // 事件经 React 树冒泡（portal 不改变 React 的事件语义），因此下面这行仍然
  // 能挡住 `document` 上的"点击外部即关闭"监听。
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
