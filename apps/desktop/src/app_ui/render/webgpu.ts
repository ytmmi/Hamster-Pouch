/**
 * WebGPU 的**最小结构化类型**（仓内没有 `@webgpu/types`，也不打算为类型引依赖）。
 *
 * 为什么自己声明而不装 `@webgpu/types`：那是一个纯类型包，但它会把「WebGPU 可用性」
 * 从运行期事实变成编译期期望——本仓的取向是「编译期只知道要用哪几个成员，
 * 能不能用由 `capabilities.ts` 在真机上探」。缺哪个成员就补哪个接口，保持窄。
 *
 * 命名带 `Gpu` 前缀，避免将来 TS 内置 `GPUDevice` 等全局类型时撞名。
 */

export interface GpuAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  /** Chromium 157 起回退标记搬到了这里（`adapter.isFallbackAdapter` 变成 undefined）。 */
  isFallbackAdapter?: boolean;
}

export interface GpuLimitsLike {
  maxTextureDimension2D: number;
  maxBufferSize: number;
}

export interface GpuAdapterLike {
  info?: GpuAdapterInfoLike;
  /** 旧版 Chromium 的位置（157 起为 undefined）；两处都要读，见 §6.8 实测。 */
  isFallbackAdapter?: boolean;
  limits: GpuLimitsLike;
  features?: { has?: (name: string) => boolean };
  requestDevice(desc?: unknown): Promise<GpuDeviceLike>;
}

export interface GpuTextureViewLike {
  readonly __kind?: "texture-view";
}

export interface GpuTextureLike {
  createView(desc?: unknown): GpuTextureViewLike;
  destroy(): void;
}

export interface GpuBufferLike {
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface GpuQueueLike {
  writeTexture(destination: unknown, data: ArrayBufferView, dataLayout: unknown, size: unknown): void;
  writeBuffer(buffer: GpuBufferLike, offset: number, data: ArrayBufferView): void;
  copyExternalImageToTexture(source: unknown, destination: unknown, size: unknown): void;
  submit(buffers: unknown[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

export interface GpuRenderPassLike {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  setVertexBuffer(slot: number, buffer: GpuBufferLike): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void;
  end(): void;
}

/** 管线（`layout: "auto"` 时用它取自动布局建 bind group）。 */
export interface GpuRenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}

export interface GpuCommandEncoderLike {
  beginRenderPass(desc: unknown): GpuRenderPassLike;
  copyTextureToBuffer(source: unknown, destination: unknown, size: unknown): void;
  finish(): unknown;
}

export interface GpuDeviceLostInfoLike {
  reason?: "destroyed" | "unknown" | string;
  message?: string;
}

export interface GpuDeviceLike {
  readonly limits: GpuLimitsLike;
  readonly queue: GpuQueueLike;
  /** 设备丢失时 resolve（`reason === "destroyed"` 表示自己调的销毁）。 */
  readonly lost: Promise<GpuDeviceLostInfoLike>;
  createTexture(desc: unknown): GpuTextureLike;
  createBuffer(desc: unknown): GpuBufferLike;
  createShaderModule(desc: unknown): unknown;
  createRenderPipeline(desc: unknown): GpuRenderPipelineLike;
  createBindGroupLayout(desc: unknown): unknown;
  createPipelineLayout(desc: unknown): unknown;
  createBindGroup(desc: unknown): unknown;
  createSampler(desc: unknown): unknown;
  createCommandEncoder(desc?: unknown): GpuCommandEncoderLike;
  destroy(): void;
}

export interface GpuLike {
  requestAdapter(options?: unknown): Promise<GpuAdapterLike | null>;
  getPreferredCanvasFormat(): string;
}

/** 取 `navigator.gpu`（没有就返回 undefined，不抛）。 */
export function gpuOf(target: unknown): GpuLike | undefined {
  const nav = target as { gpu?: GpuLike } | null | undefined;
  return nav?.gpu ?? undefined;
}

/** 回退适配器判定：新旧两处都读（Chromium 157 把标记搬进了 `adapter.info`）。 */
export function isFallbackAdapter(adapter: GpuAdapterLike): boolean {
  return adapter.info?.isFallbackAdapter === true || adapter.isFallbackAdapter === true;
}

/** 适配器摘要（写进设置页只读行与 `console.warn`）；字段缺失时给空串。 */
export function adapterLabel(adapter: GpuAdapterLike | null | undefined): string {
  const info = adapter?.info;
  const parts = [info?.vendor, info?.architecture, info?.device, info?.description]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return parts.join(" ");
}
