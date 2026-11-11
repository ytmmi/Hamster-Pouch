/**
 * 能力探测与**降级阶梯**（RFC 0013 §4）。
 *
 * 两件事被刻意分开：
 * 1. `decideBackends` 是纯函数——给定探测报告与用户偏好，返回一条后端链。门禁逐条断言它，
 *    因为它决定了用户看到的到底是哪一档，出错时表现为"机器明明支持却总在用画布"。
 * 2. `probeCapability` 只做测量——真机上跑一次、记进内存、之后读缓存（驱动升级后陈旧判定
 *    比重复探测更贵，所以不落 sessionStorage，也不持久化）。
 *
 * 探测**不阻塞首屏**：`primeCapabilityProbe()` 在首个 `requestIdleCallback` 里跑；
 * 表面层在报告就绪前先用 `dom` 画（与今天的 `<img>` 逐像素等价），拿到报告后再升级。
 */

import { surfaceFail, type Backend, type SurfaceErrorCode } from "./surface";
import {
  gpuOf,
  isFallbackAdapter,
  type GpuAdapterLike,
  type GpuDeviceLike,
  type GpuLike,
} from "./webgpu";

/** 用户偏好（设置项 `ui.imageBackend` 的取值域）。 */
export type Preference = "auto" | "webgpu" | "canvas2d" | "dom";

/** 单个探测步骤的上限（RFC §4.1）。 */
export const PROBE_STEP_TIMEOUT_MS = 800;
/** 整次探测的上限；超时按"没有任何 GPU 证据"处理，阶梯退回画布。 */
export const PROBE_TOTAL_TIMEOUT_MS = 2000;
/** 微基准耗时超过它 → `slow = true`（`auto` 因此不选 core 档）。 */
export const SLOW_THRESHOLD_MS = 250;
/** canary 读回的每通道容差。 */
export const CANARY_TOLERANCE = 2;

export interface AdapterReport {
  ok: boolean;
  reason?: SurfaceErrorCode;
  info?: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    fallback: boolean;
  };
  maxTexture2D?: number;
  maxBufferSize?: number;
}

export interface CapabilityReport {
  hasGpu: boolean;
  core: AdapterReport;
  compat: AdapterReport;
  canary: "pass" | "fail" | "skip";
  /** 微基准超阈值（仍可用，只是 `auto` 不选它）。 */
  slow: boolean;
  probedAt: number;
}

const NO_ADAPTER: AdapterReport = { ok: false, reason: "no-adapter" };

/** 阶梯决策（RFC §4.2 的表；门禁断言 8 组输入）。 */
export function decideBackends(report: CapabilityReport, preference: Preference): Backend[] {
  if (preference === "dom") return ["dom"];
  if (preference === "canvas2d") return ["canvas2d", "dom"];
  if (preference === "webgpu") {
    // 显式强制：fallback 适配器与 canary 失败都**照样允许**（排障要看失败现场），
    // 只有"根本构造不出来"（无 GPU / 无适配器）才跳过。
    const forced: Backend[] = [];
    if (report.hasGpu && report.core.ok) forced.push("webgpu");
    if (report.hasGpu && report.compat.ok) forced.push("webgpu-compat");
    forced.push("canvas2d", "dom");
    return forced;
  }
  const auto: Backend[] = [];
  if (report.hasGpu && report.core.ok && report.canary === "pass" && !report.slow) {
    auto.push("webgpu");
  } else if (report.hasGpu && report.compat.ok && report.canary !== "fail") {
    // compat 走 GLES/D3D11，是另一条路径，因此不受 `slow`（D3D12 微基准）限制。
    auto.push("webgpu-compat");
  }
  auto.push("canvas2d", "dom");
  return auto;
}

/** 探测结果缓存（模块内存，不落盘）。 */
let cached: CapabilityReport | null = null;
let inflight: Promise<CapabilityReport> | null = null;

export function cachedCapabilityReport(): CapabilityReport | null {
  return cached;
}

/** 取报告：已有缓存直接返回，否则跑一次（并发调用共享同一次探测）。 */
export function ensureCapabilityReport(): Promise<CapabilityReport> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = probeCapability()
      .then((report) => {
        cached = report;
        return report;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 在首个空闲帧里预探测（不阻塞首屏；重复调用无副作用）。 */
export function primeCapabilityProbe(): void {
  const run = (): void => {
    void ensureCapabilityReport();
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === "function") idle(run);
  else globalThis.setTimeout(run, 0);
}

/** 清空缓存（单测 / 设置页"重新探测"用）。 */
export function resetCapabilityCache(): void {
  cached = null;
  inflight = null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

interface Abort {
  aborted: boolean;
}

/** 探测一个适配器档位并（可选）在同一个设备上跑 canary。 */
async function probeAdapter(
  gpu: GpuLike,
  options: unknown,
  abort: Abort,
): Promise<{ report: AdapterReport; device?: GpuDeviceLike; canary?: "pass" | "fail" }> {
  const adapter = await withTimeout<GpuAdapterLike | null>(
    Promise.resolve().then(() => gpu.requestAdapter(options)),
    PROBE_STEP_TIMEOUT_MS,
    null,
  );
  if (!adapter) return { report: NO_ADAPTER };
  if (abort.aborted) return { report: NO_ADAPTER };
  const info = {
    vendor: adapter.info?.vendor ?? "",
    architecture: adapter.info?.architecture ?? "",
    device: adapter.info?.device ?? "",
    description: adapter.info?.description ?? "",
    fallback: isFallbackAdapter(adapter),
  };
  let device: GpuDeviceLike | null = null;
  try {
    device = await withTimeout(
      adapter.requestDevice({
        requiredFeatures: [],
        // 只要求 4096：兼容档的硬上限就是它；真正的上限从 device.limits 读。
        requiredLimits: { maxTextureDimension2D: 4096 },
      }),
      PROBE_STEP_TIMEOUT_MS,
      null,
    );
  } catch {
    device = null;
  }
  if (!device) return { report: { ...NO_ADAPTER, info } };
  const limits = device.limits;
  const base: AdapterReport = {
    ok: true,
    info,
    maxTexture2D: limits?.maxTextureDimension2D ?? 0,
    maxBufferSize: limits?.maxBufferSize ?? 0,
  };
  const canaryResult = await withTimeout(runCanary(device), PROBE_STEP_TIMEOUT_MS, "fail" as const);
  if (canaryResult !== "pass") {
    device.destroy();
    return { report: { ...base, ok: false, reason: "canary-failed" }, canary: "fail" };
  }
  return { report: base, device, canary: "pass" };
}

/** 微基准：2048² 连续上传 4 次 + 空绘制 30 帧（RFC §4.1 第 5 条）。 */
async function runMicroBench(device: GpuDeviceLike): Promise<number> {
  const side = 2048;
  const bytes = new Uint8Array(side * side * 4);
  const texture = device.createTexture({
    size: { width: side, height: side },
    format: "rgba8unorm",
    usage: 0x02 | 0x10, // COPY_DST | RENDER_ATTACHMENT
  });
  const started = performance.now();
  for (let i = 0; i < 4; i += 1) {
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: side * 4, rowsPerImage: side },
      { width: side, height: side },
    );
  }
  for (let i = 0; i < 30; i += 1) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  const elapsed = performance.now() - started;
  texture.destroy();
  return elapsed;
}

/**
 * canary：2×2 已知色块 → 全屏三角形画到 8×8 `rgba8unorm` 目标 → 读回抽样 4 点。
 *
 * 为什么不用画布做目标：画布是 `bgra8unorm`，一条管线同时服务两种附件格式会直接触发
 * validation error 让整条 command buffer 作废（S0 踩过，读回全零会误判成硬件坏）。
 * 这里只测"纹理 → 采样器 → 管线 → 拷贝 → 映射"这条搬运链。
 */
async function runCanary(device: GpuDeviceLike): Promise<"pass" | "fail"> {
  const size = 8;
  const source = device.createTexture({
    size: { width: 2, height: 2 },
    format: "rgba8unorm",
    usage: 0x02 | 0x04, // COPY_DST | TEXTURE_BINDING
  });
  const pixels = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, // 第一行：红、绿
    0, 0, 255, 255, 255, 255, 255, 255, // 第二行：蓝、白
  ]);
  device.queue.writeTexture(
    { texture: source },
    pixels,
    { bytesPerRow: 8, rowsPerImage: 2 },
    { width: 2, height: 2 },
  );
  const target = device.createTexture({
    size: { width: size, height: size },
    format: "rgba8unorm",
    usage: 0x10 | 0x01, // RENDER_ATTACHMENT | COPY_SRC
  });
  const module = device.createShaderModule({ code: CANARY_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: source.createView() },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: target.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  const readback = device.createBuffer({
    size: 256 * size,
    usage: 0x01 | 0x08, // MAP_READ | COPY_DST
  });
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow: 256 },
    { width: size, height: size },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(1);
  const bytes = new Uint8Array(readback.getMappedRange());
  const expected = [
    [255, 0, 0, 255], // 左上 ← 纹理 (0,0) 红
    [0, 255, 0, 255], // 右上 ← (1,0) 绿
    [0, 0, 255, 255], // 左下 ← (0,1) 蓝
    [255, 255, 255, 255], // 右下 ← (1,1) 白
  ];
  const points = [
    [2, 2],
    [5, 2],
    [2, 5],
    [5, 5],
  ];
  let ok = true;
  for (let i = 0; i < points.length; i += 1) {
    const [px, py] = points[i];
    const at = py * 256 + px * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(bytes[at + channel] - expected[i][channel]) > CANARY_TOLERANCE) ok = false;
    }
  }
  readback.unmap();
  readback.destroy();
  source.destroy();
  target.destroy();
  return ok ? "pass" : "fail";
}

/** canary 的 WGSL（全屏三角形 + 直通采样；与 §6.5 的四边形着色器不同，这里不需要顶点缓冲）。 */
const CANARY_WGSL = `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var t = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = t[i];
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, uv);
}
`;

/** 完整探测（一次）。任何一步超时都按"没有证据"处理，绝不让探测把首屏拖住。 */
export async function probeCapability(): Promise<CapabilityReport> {
  const probedAt = Date.now();
  const abort: Abort = { aborted: false };
  const gpu = gpuOf(navigator);
  if (!gpu) {
    return {
      hasGpu: false,
      core: { ...NO_ADAPTER, reason: "no-api" },
      compat: { ...NO_ADAPTER, reason: "no-api" },
      canary: "skip",
      slow: false,
      probedAt,
    };
  }
  const run = (async (): Promise<CapabilityReport> => {
    const core = await probeAdapter(gpu, { powerPreference: "high-performance" }, abort);
    const compat = await probeAdapter(gpu, { featureLevel: "compatibility" }, abort);
    let slow = false;
    if (core.device) {
      const micro = await withTimeout(runMicroBench(core.device), PROBE_STEP_TIMEOUT_MS * 4, -1);
      slow = micro > SLOW_THRESHOLD_MS;
    }
    core.device?.destroy();
    compat.device?.destroy();
    return {
      hasGpu: true,
      core: core.report,
      compat: compat.report,
      canary: core.canary ?? compat.canary ?? "skip",
      slow,
      probedAt,
    };
  })();
  const timedOut = await withTimeout(run, PROBE_TOTAL_TIMEOUT_MS, null);
  if (timedOut) return timedOut;
  abort.aborted = true;
  return {
    hasGpu: true,
    core: { ...NO_ADAPTER, reason: "no-adapter" },
    compat: { ...NO_ADAPTER, reason: "no-adapter" },
    canary: "skip",
    slow: true,
    probedAt,
  };
}

/** 适配器摘要（供设置页只读行与日志；探测设备已销毁，这里从报告里取）。 */
export function backendLabel(report: CapabilityReport, backend: Backend): string {
  if (backend === "dom" || backend === "canvas2d") return backend;
  const info = backend === "webgpu" ? report.core.info : report.compat.info;
  const parts = [info?.vendor, info?.architecture, info?.device].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? `${backend} · ${parts.join(" ")}` : backend;
}

/** 探测失败的统一构造（表面层上报时用，避免到处手写 code 打包）。 */
export function capabilityFailure(detail: string) {
  return surfaceFail("no-adapter", false, detail);
}
