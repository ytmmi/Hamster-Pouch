/**
 * `canvas2d` 后端（RFC §7）：CPU 合成的兜底档，也是 WebGPU 的降级终点。
 *
 * 它必须**看起来和 dom 档一样**（§11 要 dom↔canvas2d 三档 SSIM ≥ 0.99），所以这里不引入
 * 任何"更聪明"的采样或裁剪：同一套 `zoom`/`offset` 语义、同一个 `natural` 尺寸、同一个
 * 背景色，只是把 CSS transform 换成 `setTransform` + `drawImage`。
 *
 * 三处刻意的取舍：
 * - 位图走 `fetch → blob → createImageBitmap`，而不是直接喂 `<img>`：asset 协议与页面不同源，
 *   不带 CORS 的 `<img>` 会把画布标脏，而 `drawImage` 之后的任何像素操作都会抛。
 * - 新图解码完成前**不清屏**：旧帧留着，才不会在换图时闪一帧背景色（缺陷 0028）。
 * - `imageSmoothingQuality` 只在缩小（`zoom < 1`）时开 `high`：放大时高质量插值会把原始像素
 *   抹成糊的，而查看器放大要看的正是像素本身。
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

export function createCanvas2dSurface(
  deps: SurfaceDeps,
  hooks: SurfaceHooks = {},
): ImageSurface {
  let host: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let bitmap: ImageBitmap | null = null;
  let natural: Size = { width: 0, height: 0 };
  let view: ViewTransform = { zoom: 1, offset: { x: 0, y: 0 } };
  let viewport: Size = { width: 0, height: 0 };
  let dpr = 1;
  let visible = true;
  let disposed = false;
  let contextLosses = 0;
  let generation = 0;

  const stats: SurfaceStats = {
    backend: "canvas2d",
    uploads: 0,
    uploadedBytes: 0,
    lastFrameMs: 0,
    residentTiles: 0,
  };

  function resizeBackingStore(): void {
    if (!canvas) return;
    const w = Math.max(1, Math.round(viewport.width * dpr));
    const h = Math.max(1, Math.round(viewport.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
  }

  function draw(): void {
    if (!canvas || !ctx) return;
    const started = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 背景色与 `.iv-stage` 的 `--media-bg` 取同一来源（deps.background），否则 dom↔canvas2d 的
    // SSIM 会在透明区域直接掉下来。
    ctx.fillStyle = deps.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!bitmap || !isKnownSize(natural) || viewport.width <= 0 || viewport.height <= 0) {
      stats.lastFrameMs = performance.now() - started;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = view.zoom < 1 ? "high" : "low";
    ctx.translate(viewport.width / 2 + view.offset.x, viewport.height / 2 + view.offset.y);
    ctx.scale(view.zoom, view.zoom);
    ctx.drawImage(bitmap, -natural.width / 2, -natural.height / 2, natural.width, natural.height);
    stats.lastFrameMs = performance.now() - started;
  }

  function requestDraw(): void {
    scheduleFrame(() => {
      if (disposed || !visible) return;
      draw();
    });
  }

  function onContextLost(event: Event): void {
    // 必须 preventDefault，否则浏览器不会让我们重建上下文（Chromium 的 canvas 2d 也是这样）。
    event.preventDefault();
    contextLosses += 1;
    ctx = null;
    if (disposed) return;
    if (contextLosses > 1) {
      // 第二次丢：不再陪着重试，交给上层按阶梯降到 dom（RFC §7）。
      hooks.onFailed?.({ code: "context-lost", retryable: true });
      return;
    }
    rebuildContext();
    requestDraw();
  }

  function rebuildContext(): void {
    if (!canvas) return;
    ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) {
      hooks.onFailed?.({ code: "context-lost", retryable: false });
      return;
    }
    // 重建上下文会把画布清空，这里立刻按当前状态补一帧，避免白板。
    draw();
  }

  function attachCanvas(): void {
    if (!host || canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "iv-surface-canvas";
    canvas.addEventListener("contextlost", onContextLost);
    host.appendChild(canvas);
    ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) hooks.onFailed?.({ code: "context-lost", retryable: false });
    resizeBackingStore();
  }

  async function loadBitmap(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  return {
    backend: "canvas2d",
    mount(nextHost: HTMLElement): void {
      if (disposed) return;
      host = nextHost;
      attachCanvas();
      requestDraw();
    },
    async setSource(source: ImageSource): Promise<SurfaceResult> {
      if (disposed) return surfaceFail("decode-failed", false, "surface disposed");
      if (source.kind !== "url") {
        // S1 只有 url 源（LOD0/LOD1 都从 asset URL 取）；bitmap/element 留给 S2 之后再开。
        return surfaceFail("decode-failed", false, "canvas2d 暂只接受 URL 源");
      }
      const gen = ++generation;
      let next: ImageBitmap;
      try {
        next = await loadBitmap(source.url);
      } catch (error) {
        if (gen === generation) {
          hooks.onFailed?.({
            code: "decode-failed",
            retryable: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        return surfaceFail("decode-failed", false, source.url);
      }
      if (disposed || gen !== generation) {
        next.close();
        return SURFACE_OK;
      }
      const previous = bitmap;
      bitmap = next;
      if (isKnownSize(source.natural)) {
        natural = source.natural;
      } else if (next.width > 0 && next.height > 0) {
        natural = { width: next.width, height: next.height };
        hooks.onNatural?.(natural);
      }
      previous?.close();
      stats.uploads += 1;
      stats.uploadedBytes += next.width * next.height * 4;
      requestDraw();
      return SURFACE_OK;
    },
    setView(nextView: ViewTransform, nextViewport: Size, nextDpr: number): void {
      if (disposed) return;
      view = nextView;
      const sizeChanged =
        viewport.width !== nextViewport.width || viewport.height !== nextViewport.height;
      viewport = nextViewport;
      dpr = nextDpr > 0 ? nextDpr : 1;
      if (sizeChanged) resizeBackingStore();
      requestDraw();
    },
    setVisible(nextVisible: boolean): void {
      if (disposed) return;
      visible = nextVisible;
      if (canvas) canvas.style.visibility = visible ? "" : "hidden";
      if (visible) requestDraw();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (canvas) {
        canvas.removeEventListener("contextlost", onContextLost);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
      bitmap?.close();
      bitmap = null;
      ctx = null;
      canvas = null;
      host = null;
    },
    stats,
  };
}
