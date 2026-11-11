/**
 * `dom` 后端（RFC §8）：今天的 `<img>` 实现，包成 `ImageSurface`。
 *
 * 它是**最终兜底**，也是 A/B 基线：任何「GPU 版更快」的结论都必须与这一档同机同图对比。
 * 因此这里刻意不加任何新机制——类名、`will-change`、`image-rendering`、待解码兜底
 * （`.iv-image-pending`）全部沿用 CSS 既有规则，视觉结果与改造前逐像素一致。
 *
 * 缺陷 0028 的不变量在这里的落法：`setSource` **新建**一个 `<img>` 节点，等它解码完成
 * 再把旧节点移出 DOM。既不复用节点换 `src`，也不在解码期间留下空白帧。
 */

import { scheduleFrame } from "./frameScheduler";
import {
  SURFACE_OK,
  isKnownSize,
  surfaceFail,
  type ImageSurface,
  type ImageSource,
  type Size,
  type SurfaceDeps,
  type SurfaceHooks,
  type SurfaceResult,
  type SurfaceStats,
  type ViewTransform,
} from "./surface";

/** 与 `ViewerStage.tsx` 原实现逐字一致的几何字符串（改这里等于改 A/B 基线）。 */
function styleTransform(view: ViewTransform): string {
  const x = view.offset.x;
  const y = view.offset.y;
  return `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${view.zoom})`;
}

export function createDomSurface(
  _deps: SurfaceDeps,
  hooks: SurfaceHooks = {},
): ImageSurface {
  let host: HTMLElement | null = null;
  let node: HTMLImageElement | null = null;
  let view: ViewTransform = { zoom: 1, offset: { x: 0, y: 0 } };
  let natural: Size = { width: 0, height: 0 };
  let visible = true;
  let disposed = false;
  /** 换图代次：迟到的 `decode()` 回来时据此判断要不要上屏（缺陷 0028 的同一个判据）。 */
  let generation = 0;

  const stats: SurfaceStats = {
    backend: "dom",
    uploads: 0,
    uploadedBytes: 0,
    lastFrameMs: 0,
    residentTiles: 0,
  };

  function applyGeometry(el: HTMLImageElement): void {
    if (isKnownSize(natural)) {
      el.style.width = `${natural.width}px`;
      el.style.height = `${natural.height}px`;
      el.classList.remove("iv-image-pending");
    } else {
      // 尺寸未知：交给 `.iv-image-pending` 按「适应窗口」的同一几何先画（缺陷 0027）。
      el.style.width = "";
      el.style.height = "";
      el.classList.add("iv-image-pending");
    }
    el.style.transform = isKnownSize(natural) ? styleTransform(view) : "none";
    el.style.display = visible ? "" : "none";
  }

  function detach(el: HTMLImageElement | null): void {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    backend: "dom",
    mount(nextHost: HTMLElement): void {
      if (disposed) return;
      host = nextHost;
    },
    async setSource(source: ImageSource): Promise<SurfaceResult> {
      if (disposed) return surfaceFail("decode-failed", false, "surface disposed");
      const url = source.kind === "url" ? source.url : source.kind === "element" ? source.el.src : "";
      if (!url) return surfaceFail("decode-failed", false, "dom 后端只接受 URL / 元素源");
      const gen = ++generation;
      const el = document.createElement("img");
      el.className = "iv-image";
      el.alt = hooks.alt ?? "";
      el.draggable = false;
      el.decoding = "sync";
      natural = source.natural;
      applyGeometry(el);
      el.style.opacity = "0";
      // 先挂上（隐藏）再加载：`decode()` 对脱离文档的图片在部分 Chromium 版本上不解码，
      // 而这一档的全部意义就是"新帧就绪才替换"。
      el.src = url;
      host?.appendChild(el);
      try {
        await el.decode();
      } catch {
        detach(el);
        if (gen === generation) hooks.onFailed?.({ code: "decode-failed", retryable: false, detail: url });
        return surfaceFail("decode-failed", false, url);
      }
      if (disposed || gen !== generation) {
        detach(el);
        return SURFACE_OK;
      }
      if (!isKnownSize(natural) && el.naturalWidth > 0 && el.naturalHeight > 0) {
        natural = { width: el.naturalWidth, height: el.naturalHeight };
        applyGeometry(el);
        hooks.onNatural?.(natural);
      }
      el.style.opacity = "";
      const previous = node;
      node = el;
      // 新节点就位后再摘旧节点：中间没有一帧是空舞台（不闪白）。
      detach(previous);
      return SURFACE_OK;
    },
    setView(nextView: ViewTransform, _viewport: Size, _dpr: number): void {
      if (disposed) return;
      view = nextView;
      const target = node;
      if (!target) return;
      // 复用共享调度器：同一帧内多次滚轮只写一次样式（写样式本身很便宜，但读-写交错会掉帧）。
      scheduleFrame(() => {
        if (disposed || !target.isConnected) return;
        applyGeometry(target);
      });
    },
    setVisible(nextVisible: boolean): void {
      if (disposed) return;
      visible = nextVisible;
      if (node) node.style.display = visible ? "" : "none";
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      detach(node);
      node = null;
      host = null;
    },
    stats,
  };
}
