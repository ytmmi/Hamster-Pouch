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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type JSX,
} from "react";

import { useImageSurface } from "../../render/useImageSurface";
import type { Preference } from "../../render/capabilities";
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
  /** 渲染后端偏好（`ui.imageBackend` 的落地值，RFC 0013）。 */
  backend: Preference;
  /**
   * LOD0 低清档 URL（原图长边 > 4096 时才有）：先上它对位，再切全分辨率。
   * `null` = 小图走"单张整纹理"快路径，与改造前的 `<img>` 行为等价。
   */
  lowResUrl?: string | null;
  /** 每帧 LOD1 分块上传预算（字节）；只约束大图分块流，小图整张上传不计入。 */
  uploadBudgetBytes?: number;
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
  backend,
  lowResUrl,
  uploadBudgetBytes,
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

  /**
   * 表面控制器（RFC 0013 §10）：舞台只负责"给一块铺满的宿主 + 上报变换"，
   * 真正画像素的是 `render/` 里的某一档后端。`alt` 与两个回调原样透传，
   * 面板看到的 `onNatural` / `onFailed` 时序与改造前完全一致。
   */
  const surface = useImageSurface(transform, {
    preference: backend,
    alt,
    uploadBudgetBytes,
    onNatural,
    onFailed,
  });

  useEffect(() => {
    if (!url) {
      surface.clearSource();
      return;
    }
    // `natural === null` 表示"原图尺寸还没解出来"，按 0×0 交给表面走待解码兜底
    // （与 `.iv-image-pending` 的 contain 几何同口径）。
    surface.showSource(url, natural ?? { width: 0, height: 0 }, lowResUrl ?? null);
  }, [surface, url, natural, lowResUrl]);

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
      {/*
        图像的绘制节点由表面自己创建（`<img>` / `<canvas>`），舞台只提供这块铺满的宿主。
        缺陷 0028 的"不得复用同一个 `<img>` 换 src"由 dom 表面在 `setSource` 里执行
        （每次新建元素、解码完成才摘旧元素），舞台这一层不再持有任何图像元素。
      */}
      <div
        ref={surface.hostRef}
        className="iv-surface"
        role={url ? "img" : undefined}
        aria-label={url ? alt : undefined}
        data-backend={surface.backend ?? undefined}
      />
      {overlay}
    </div>
  );
}
