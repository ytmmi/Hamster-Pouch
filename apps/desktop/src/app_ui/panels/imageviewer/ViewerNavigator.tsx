/**
 * 图像查看器：**导航器**（右下角等四角的缩略全景 + 视口框）。
 *
 * 只在图像**已超出舞台**（`isOverflowing`）且设置里启用时由面板挂载（`overlay` 槽位）：
 * 没超出就没有"不可见的区域"需要导航，硬显示一个占满画布的框只是噪声。
 *
 * 交互：在缩略全景上按下/拖动 → 把该点移到舞台正中（`centerOn`）。
 * 指针事件一律 `stopPropagation`，否则会同时触发舞台的拖动平移（两套拖动互相打架）。
 */

import { useCallback, useEffect, useRef, type PointerEvent } from "react";

import { visibleRect, type Size, type ViewTransform } from "./viewerZoom";
import { navigatorCornerClass, type NavigatorCorner } from "./viewerPlacement";

export interface ViewerNavigatorProps {
  /** 图像 URL（与舞台同源，浏览器复用同一份解码结果）。 */
  url: string;
  natural: Size;
  viewport: Size;
  transform: ViewTransform;
  corner: NavigatorCorner;
  /** 把图像上的归一化点 `(u, v)`（`0..1`）移到舞台正中。 */
  onCenter: (u: number, v: number) => void;
}

/** 导航器外框最大尺寸（px）：够看清全景，又不遮挡图像主体。 */
const NAV_MAX = { width: 176, height: 124 } as const;

/** 导航器（缩略全景 + 视口框）。 */
export function ViewerNavigator({
  url,
  natural,
  viewport,
  transform,
  corner,
  onCenter,
}: ViewerNavigatorProps): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  /** 是否正在拖动视口（`pointermove` 只在捕获期间生效）。 */
  const draggingRef = useRef(false);

  // 导航器上的滚轮不应缩放图像：原生监听器阻断冒泡（舞台的 wheel 在原生阶段冒泡）。
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const stop = (event: WheelEvent) => event.stopPropagation();
    el.addEventListener("wheel", stop);
    return () => el.removeEventListener("wheel", stop);
  }, []);

  /** 指针位置 → 图像归一化坐标（夹紧到 `0..1`）。 */
  const normalizedAt = useCallback((clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    return {
      u: clamp01((clientX - rect.left) / rect.width),
      v: clamp01((clientY - rect.top) / rect.height),
    };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const point = normalizedAt(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    onCenter(point.u, point.v);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.stopPropagation();
    const point = normalizedAt(event.clientX, event.clientY);
    if (point) onCenter(point.u, point.v);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // 缩略全景的尺寸：严格保持图像宽高比 → 指针坐标可线性映射回图像坐标。
  const ratio = natural.height > 0 ? natural.height / natural.width : 1;
  const frameWidth = Math.max(1, Math.min(NAV_MAX.width, NAV_MAX.height / Math.max(ratio, 1e-6)));
  const frameHeight = Math.max(1, frameWidth * ratio);
  const rect = visibleRect(transform, natural, viewport);

  return (
    <div className={`iv-nav ${navigatorCornerClass(corner)}`}>
      <div
        ref={frameRef}
        className="iv-nav-frame"
        style={{ width: `${frameWidth}px`, height: `${frameHeight}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img className="iv-nav-image" src={url} alt="" draggable={false} />
        <div
          className="iv-nav-view"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
          }}
        />
      </div>
    </div>
  );
}
