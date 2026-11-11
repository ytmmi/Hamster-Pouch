/**
 * 视觉门禁的页面侧夹具（只给 `tools/viewer-render-verify.mjs` 用，不进构建、不进安装包）。
 *
 * 把两个真实后端挂在同一个 640×480 宿主里，由 Node 侧用同一条 CDP 会话截图对比。
 * 这里**不画任何像素**：夹具图由 Node 用 PNG 编码器生成后以 data URL 传入，宿主尺寸固定，
 * 这样截图裁切范围只由 `show()` 返回的 rect 决定。
 *
 * 之所以搬出 html：`<script type="module">` 里的 import 需要 Vite 才能解析 TS，
 * 而 Vite dev server 在本机（Node 26）会"占着端口但不回话"，把门禁挂死。
 * 现在由门禁脚本自己用 TypeScript 的 `transpileModule` 编出模块图，再用一个静态
 * HTTP 服务发出去——依赖只剩 typescript 本身。
 */

import type { ImageSurface, SurfaceDeps, SurfaceStats } from "../apps/desktop/src/app_ui/render/surface";
import { createCanvas2dSurface } from "../apps/desktop/src/app_ui/render/surfaceCanvas2d";
import { createDomSurface } from "../apps/desktop/src/app_ui/render/surfaceDom";

const HOST = { width: 640, height: 480 };
const MiB = 1024 * 1024;

const DEPS: SurfaceDeps = {
  canvasFormat: "bgra8unorm",
  background: "#000000",
  uploadBudgetBytes: 32 * MiB,
  tilePx: 1024,
  tileCacheBytes: 256 * MiB,
};

type Backend = "dom" | "canvas2d";

interface ShowOptions {
  backend: Backend;
  url: string;
  width: number;
  height: number;
  zoom: number;
}

interface ShowResult {
  ok: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  stats?: SurfaceStats;
  error?: { code: string; detail?: string };
}

let surface: ImageSurface | null = null;
let host: HTMLDivElement | null = null;

function hostElement(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.id = "host";
    host.style.cssText = `position:fixed;left:0;top:0;width:${HOST.width}px;height:${HOST.height}px;background:#000;overflow:hidden`;
    document.body.appendChild(host);
  }
  return host;
}

function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

function dispose(): void {
  surface?.dispose();
  surface = null;
  host?.replaceChildren();
}

async function show(options: ShowOptions): Promise<ShowResult> {
  dispose();
  const target = hostElement();
  surface =
    options.backend === "dom" ? createDomSurface(DEPS) : createCanvas2dSurface(DEPS);
  surface.mount(target);

  const source = await surface.setSource({
    kind: "url",
    url: options.url,
    natural: { width: options.width, height: options.height },
  });
  if (!source.ok) return { ok: false, error: source.error };

  surface.setVisible(true);
  // 契约要求 setSource 之后必须给一次 setView 才出画；这里只给一次。
  surface.setView({ zoom: options.zoom, offset: { x: 0, y: 0 } }, HOST, 1);
  await frames(4);

  const rect = target.getBoundingClientRect();
  return {
    ok: true,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    stats: { ...surface.stats },
  };
}

declare global {
  interface Window {
    __renderHarness?: {
      ready: true;
      host: typeof HOST;
      show: typeof show;
      dispose: typeof dispose;
    };
  }
}

window.__renderHarness = { ready: true, host: HOST, show, dispose };
