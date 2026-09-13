/**
 * 右键上下文菜单容器。
 *
 * - 定位到鼠标坐标 (x, y)，靠近窗口右/下边缘时自动向内收，避免被截断；
 * - 监听内容尺寸变化（如展开子菜单后变长）：先尝试整体上移，
 *   若仍放不下则限制最大高度并启用纵向滚动，保证菜单始终可用。
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

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
  const [style, setStyle] = useState<CSSProperties>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const update = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 4;
      const width = el.offsetWidth;
      // 内容完整高度（不受 maxHeight 限制，避免测量循环）。
      const contentHeight = el.scrollHeight;
      let left = x;
      let top = y;

      // 水平越界 → 向内收。
      if (left + width > vw - margin) {
        left = Math.max(margin, vw - width - margin);
      }

      // 垂直越界 → 先整体上移贴底；仍放不下则限制高度并滚动。
      let maxHeight: number | undefined;
      if (top + contentHeight > vh - margin) {
        top = Math.max(margin, vh - contentHeight - margin);
        if (top + contentHeight > vh - margin) {
          maxHeight = vh - top - margin;
        }
      }

      setStyle({
        left,
        top,
        ...(maxHeight ? { maxHeight, overflowY: "auto" as const } : {}),
      });
    };

    update();
    // 内容变化（展开/收起子菜单、项增减）时重新校正。
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
