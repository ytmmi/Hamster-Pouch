/**
 * 图像查看器：**舞台**（图像显示区 + 滚轮缩放 + 拖动平移 + 浮层挂载点）。
 *
 * 为什么舞台自己持有 DOM 事件而不是全交给面板：
 * - 缩放的锚点必须由**实测**的舞台矩形换算（指针舞台坐标），面板拿不到；
 * - 滚轮必须用**非 passive** 的原生监听器才能 `preventDefault()`（React 的 `onWheel`
 *   是 root 上的 passive 监听，调 `preventDefault` 既无效又会告警）；
 * - 舞台尺寸变化（面板拖拽改大小）只有本组件知道，用 `ResizeObserver` 如实上报。
 *
 * 几何计算**不在这里**：本组件只上报"倍率 + 指针 + 舞台尺寸"，换算全在
 * `viewerZoom.ts` 的纯函数里（面板据此应用"以指针为中心"或"以中心为中心"）。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

import {
  clampOffset,
  scaledSize,
  wheelZoomFactor,
  type Offset,
  type Size,
  type ViewTransform,
} from "./viewerZoom";

export interface ViewerStageProps {
  /** 图像 URL（`convertFileSrc` 后的 asset URL）。 */
  url: string;
  /** 无障碍替代文本（由面板传 `t(...)` 文案，不在本组件内联文字）。 */
  alt: string;
  /** 原图尺寸；`null` = 尚未解码（此时按 contain 兜底显示）。 */
  natural: Size | null;
  transform: ViewTransform;
  /** 滚轮缩放：倍率 + 指针舞台坐标 + 实测舞台尺寸。 */
  onWheelZoom: (factor: number, pointer: Offset, viewport: Size) => void;
  /** 图像解码完成（原图尺寸）。 */
  onNatural: (size: Size) => void;
  /** 图像加载失败。 */
  onFailed: () => void;
  /** 舞台尺寸变化（面板用于夹紧平移、绘制视口框）。 */
  onViewport: (size: Size) => void;
  /** 拖动平移中（已夹紧的新变换）。 */
  onTransform: (next: ViewTransform) => void;
  /** 是否允许拖动平移（图像已超出舞台）。 */
  pannable: boolean;
  /** 图像不可用时的占位内容（文案由面板给）。 */
  placeholder?: ReactNode;
  /** 舞台内的浮层（导航器）：必须随舞台尺寸定位，因此挂在这里而不是面板外层。 */
  overlay?: ReactNode;
}

/** 舞台（含滚轮缩放、拖动平移与浮层槽位）。 */
export function ViewerStage({
  url,
  alt,
  natural,
  transform,
  onWheelZoom,
  onNatural,
  onFailed,
  onViewport,
  onTransform,
  pannable,
  placeholder,
  overlay,
}: ViewerStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  /** 拖动中的起点（指针舞台坐标 + 起始平移）；`null` = 未在拖动。 */
  const dragRef = useRef<{ pointer: Offset; offset: Offset } | null>(null);
  /** 最近一次变换（原生监听器里读取，避免闭包过期）。 */
  const latestRef = useRef({ transform, natural, pannable });
  latestRef.current = { transform, natural, pannable };
  const [dragging, setDragging] = useState(false);

  const measure = useCallback((): Size => {
    const el = stageRef.current;
    if (!el) return { width: 0, height: 0 };
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, []);

  /** 舞台尺寸上报（面板需要它做缩放/夹紧/视口框）。 */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const report = () => onViewport(measure());
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, onViewport]);

  /** 滚轮缩放：非 passive 原生监听（可 `preventDefault`，不触发页面/浏览器缩放）。 */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const current = latestRef.current;
      if (!current.natural) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      onWheelZoom(
        wheelZoomFactor(event.deltaY),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheelZoom]);

  /** 拖动平移（仅在图像超出舞台时生效）。 */
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const current = latestRef.current;
    if (!current.pannable || !current.natural || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointer: { x: event.clientX, y: event.clientY },
      offset: { ...current.transform.offset },
    };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const current = latestRef.current;
    if (!drag || !current.natural) return;
    const viewport = measure();
    const scaled = scaledSize(current.natural, current.transform.zoom);
    onTransform({
      zoom: current.transform.zoom,
      offset: clampOffset(
        {
          x: drag.offset.x + (event.clientX - drag.pointer.x),
          y: drag.offset.y + (event.clientY - drag.pointer.y),
        },
        scaled,
        viewport,
      ),
    });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /** 图像样式：装饰性变换**只改 transform**（GPU 缩放，不重新布局/重采样位图）。 */
  const imageStyle: CSSProperties = natural
    ? {
        width: `${natural.width}px`,
        height: `${natural.height}px`,
        transform:
          `translate(calc(-50% + ${transform.offset.x}px), calc(-50% + ${transform.offset.y}px)) ` +
          `scale(${transform.zoom})`,
      }
    : {};

  return (
    <div
      ref={stageRef}
      className={`iv-stage${pannable ? " iv-stage-pannable" : ""}${dragging ? " iv-stage-dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => event.preventDefault()}
    >
      {!url && placeholder}
      {url && (
        <img
          className={`iv-image${natural ? "" : " iv-image-pending"}`}
          src={url}
          alt={alt}
          draggable={false}
          style={imageStyle}
          onLoad={(event) =>
            onNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={onFailed}
        />
      )}
      {overlay}
    </div>
  );
}
