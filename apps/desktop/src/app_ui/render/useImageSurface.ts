/**
 * 把「后端阶梯 + 表面生命周期」收进一个 hook（RFC §4.2 / §5 / §10）。
 *
 * 这里有三个不显眼但必须成立的性质：
 *
 * 1. **首帧不等探测**。能力探测最坏要 2 s，而开图是用户点一下就发生的事。所以先按 `dom`
 *    起一个表面（它与改造前的 `<img>` 逐像素等价，永远可用），探测结果回来后如果阶梯首档
 *    不是 `dom`，再整体换档并**重灌同一个源**。用户不会看到白屏，只会看到「本来就是这张图」。
 * 2. **降级先拆后建**。换档必须 `dispose()` 旧表面再挂新表面：两个表面同时持有 DOM 会让
 *    dom 档的 `<img>` 和 canvas 叠在一起各画各的（RFC §5 的硬要求）。
 * 3. **换源用代次而不是布尔**。`setSource` 是异步的，连续换图时旧源的 `decode()` 可能后到；
 *    代次不匹配就直接丢弃，这就是缺陷 0028 的判据在表面层的落点。
 *
 * 阶梯/降级/换源写成模块级函数而不是闭包，是因为三者互相调用（降级要换源、换源失败要降级），
 * 写成 `useCallback` 会绕成一团 use-before-define；状态本来就全在 ref 里，抽出去反而更直白。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cachedCapabilityReport,
  decideBackends,
  ensureCapabilityReport,
  type Preference,
} from "./capabilities";
import { isBackendDisabled, noteBackendFailure, noteBackendReady } from "./registry";
import { createCanvas2dSurface } from "./surfaceCanvas2d";
import { createDomSurface } from "./surfaceDom";
import { publishSurfaceStats } from "./surfaceStatsStore";
import type {
  Backend,
  ImageSurface,
  Size,
  SurfaceDeps,
  SurfaceError,
  SurfaceHooks,
  ViewTransform,
} from "./surface";

/** 与 `--media-bg` 一致；canvas2d 档必须自己填背景（CSS 背景不会透过 `alpha:false`）。 */
const DEFAULT_BACKGROUND = "var(--media-bg)";
const DEFAULT_UPLOAD_BUDGET_BYTES = 32 * 1024 * 1024;
const DEFAULT_TILE_PX = 1024;
const DEFAULT_TILE_CACHE_BYTES = 256 * 1024 * 1024;

export interface UseImageSurfaceOptions {
  preference: Preference;
  background?: string;
  uploadBudgetBytes?: number;
  tilePx?: number;
  tileCacheBytes?: number;
  alt?: string;
  onNatural?: (natural: Size) => void;
  onFailed?: (error: SurfaceError) => void;
}

export interface ImageSurfaceController {
  /** 挂到舞台里的 `<div className="iv-surface">` 上。 */
  hostRef: React.RefObject<HTMLDivElement | null>;
  /** 当前真正在画的档（探测未完成时是 `dom`）。 */
  backend: Backend | null;
  /**
   * 换源。`lowResUrl` 只在「原图长边 > 4096」时给：先上低清档占位，再切全分辨率。
   * 同一个 URL 重复调用是幂等的（URL + 尺寸三重判重）。
   */
  showSource(url: string, natural: Size, lowResUrl?: string | null): void;
  /** 清空（换仓库、文件被删、预览兜底失败时）。 */
  clearSource(): void;
}

interface SurfaceSource {
  url: string;
  natural: Size;
  lowResUrl: string | null;
}

interface Runtime {
  host: () => HTMLDivElement | null;
  options: () => UseImageSurfaceOptions;
  view: () => ViewTransform;
  setBackend: (backend: Backend | null) => void;
  state: {
    surface: ImageSurface | null;
    backend: Backend | null;
    ladder: Backend[];
    mounted: boolean;
    source: SurfaceSource | null;
    request: number;
  };
}

function readViewport(runtime: Runtime): Size {
  const host = runtime.host();
  if (!host) return { width: 0, height: 0 };
  // 用宿主自身而不是舞台的 `getBoundingClientRect`：舞台有 1 px 边框，两者原点差 1 px，
  // 会让 canvas2d 与 dom 的图形错开一格（§11 的「1:1 无 1 px 偏移」查的就是这个）。
  const rect = host.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function pushView(runtime: Runtime): void {
  const surface = runtime.state.surface;
  if (!surface) return;
  surface.setView(runtime.view(), readViewport(runtime), window.devicePixelRatio || 1);
}

function depsOf(runtime: Runtime): SurfaceDeps {
  const options = runtime.options();
  return {
    // 画布首选格式由 WebGPU 表面自己在 S2 里取；这里留空串给它一个默认值。
    canvasFormat: "",
    background: options.background ?? DEFAULT_BACKGROUND,
    uploadBudgetBytes: options.uploadBudgetBytes ?? DEFAULT_UPLOAD_BUDGET_BYTES,
    tilePx: options.tilePx ?? DEFAULT_TILE_PX,
    tileCacheBytes: options.tileCacheBytes ?? DEFAULT_TILE_CACHE_BYTES,
  };
}

function constructBackend(backend: Backend, deps: SurfaceDeps, hooks: SurfaceHooks): ImageSurface | null {
  if (backend === "dom") return createDomSurface(deps, hooks);
  if (backend === "canvas2d") return createCanvas2dSurface(deps, hooks);
  // webgpu / webgpu-compat 在 S2 才落实现；S1 阶段返回 null，让阶梯继续往下走。
  return null;
}

function activate(runtime: Runtime, ladder: Backend[]): void {
  const state = runtime.state;
  const host = runtime.host();
  state.ladder = ladder;
  if (!host) return;
  const forced = runtime.options().preference !== "auto";
  let chosen: { backend: Backend; surface: ImageSurface } | null = null;
  for (const backend of ladder) {
    // 显式强制档不受失败记忆影响：排障时用户就是要它再试一次（RFC §4.3）。
    if (!forced && backend !== "dom" && isBackendDisabled(backend)) continue;
    const surface = constructBackend(backend, depsOf(runtime), {
      alt: runtime.options().alt,
      onNatural: (natural) => runtime.options().onNatural?.(natural),
      onFailed: (error) => degrade(runtime, error),
    });
    if (surface) {
      chosen = { backend, surface };
      break;
    }
  }
  if (!chosen) return;
  state.surface?.dispose();
  state.surface = chosen.surface;
  state.backend = chosen.backend;
  runtime.setBackend(chosen.backend);
  chosen.surface.mount(host);
  pushView(runtime);
  publishSurfaceStats(chosen.surface.stats);
  noteBackendReady(chosen.backend);
  if (state.source) {
    const request = ++state.request;
    void applySource(runtime, chosen.surface, state.source, request);
  }
}

function degrade(runtime: Runtime, error: SurfaceError): void {
  const state = runtime.state;
  const current = state.backend;
  if (!current) return;
  const onFailed = runtime.options().onFailed;
  // 解码失败不是后端能力问题：交给面板走预览兜底，别让阶梯白降一次。
  if (error.code === "decode-failed" && onFailed) {
    onFailed(error);
    return;
  }
  noteBackendFailure(current);
  const index = state.ladder.indexOf(current);
  activate(runtime, state.ladder.slice(index + 1));
}

async function applySource(
  runtime: Runtime,
  surface: ImageSurface,
  source: SurfaceSource,
  request: number,
): Promise<void> {
  const state = runtime.state;
  const stale = () => state.request !== request || state.surface !== surface;
  if (source.lowResUrl && source.lowResUrl !== source.url) {
    // 低清档先上屏：1280 的 WebP 从缩略图缓存来，通常几十毫秒就能画出来。
    await surface.setSource({ kind: "url", url: source.lowResUrl, natural: source.natural });
    if (stale()) return;
  }
  const result = await surface.setSource({ kind: "url", url: source.url, natural: source.natural });
  if (stale()) return;
  if (!result.ok) degrade(runtime, result.error);
}

export function useImageSurface(
  view: ViewTransform,
  options: UseImageSurfaceOptions,
): ImageSurfaceController {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const viewRef = useRef(view);
  viewRef.current = view;
  const runtimeRef = useRef<Runtime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = {
      host: () => hostRef.current,
      options: () => optionsRef.current,
      view: () => viewRef.current,
      setBackend,
      state: { surface: null, backend: null, ladder: [], mounted: false, source: null, request: 0 },
    };
  }
  const runtime = runtimeRef.current;

  // 阶梯：偏好 = dom/canvas2d 时根本不探测 GPU（省掉最长 2 s 的无谓等待）。
  const preference = options.preference;
  useEffect(() => {
    let cancelled = false;
    if (preference === "dom") {
      runtime.state.ladder = ["dom"];
      return;
    }
    if (preference === "canvas2d") {
      runtime.state.ladder = ["canvas2d", "dom"];
      return;
    }
    const known = cachedCapabilityReport();
    if (known) {
      runtime.state.ladder = decideBackends(known, preference);
      return;
    }
    runtime.state.ladder = ["dom"];
    void ensureCapabilityReport().then((report) => {
      if (cancelled) return;
      const ladder = decideBackends(report, preference);
      runtime.state.ladder = ladder;
      if (ladder[0] !== runtime.state.backend) activate(runtime, ladder);
    });
    return () => {
      cancelled = true;
    };
  }, [preference, runtime]);

  // 首次挂载 + 尺寸变化。ResizeObserver 盯宿主本身，尺寸一变就补一帧。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!runtime.state.mounted) {
      runtime.state.mounted = true;
      activate(runtime, runtime.state.ladder.length ? runtime.state.ladder : ["dom"]);
    }
    const observer = new ResizeObserver(() => pushView(runtime));
    observer.observe(host);
    return () => observer.disconnect();
  }, [runtime]);

  // 视图变化只同步给表面；表面自己合并进共享 rAF，不在这里节流。
  useEffect(() => {
    pushView(runtime);
  }, [runtime, view.zoom, view.offset.x, view.offset.y]);

  // 可见性：不可见就停绘制（RFC §6.3 的 `setVisible(false)` 暂停上传）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      runtime.state.surface?.setVisible(!!entry?.isIntersecting);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [runtime]);

  useEffect(
    () => () => {
      runtime.state.request += 1;
      runtime.state.surface?.dispose();
      runtime.state.surface = null;
      runtime.state.backend = null;
      publishSurfaceStats(null);
    },
    [runtime],
  );

  const showSource = useCallback(
    (url: string, natural: Size, lowResUrl?: string | null) => {
      const source: SurfaceSource = { url, natural, lowResUrl: lowResUrl ?? null };
      const previous = runtime.state.source;
      if (previous && previous.url === url && previous.lowResUrl === source.lowResUrl) {
        // 同一张图（含 LOD0 → 全分辨率是同一个 URL 的情形）：只把后到的真实尺寸补上，
        // **不重灌**。重灌会让 dom 档新建一次 `<img>`，等于白闪一帧。
        if (natural.width > 0 && natural.height > 0) previous.natural = natural;
        return;
      }
      runtime.state.source = source;
      const surface = runtime.state.surface;
      if (!surface) return;
      const request = ++runtime.state.request;
      void applySource(runtime, surface, source, request);
    },
    [runtime],
  );

  const clearSource = useCallback(() => {
    runtime.state.source = null;
    runtime.state.request += 1;
  }, [runtime]);

  return { hostRef, backend, showSource, clearSource };
}
