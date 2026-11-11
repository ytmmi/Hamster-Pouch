/**
 * 图像显示表面的**契约**（RFC 0013 §3）。
 *
 * 为什么单独成文件、且只有类型与纯函数：这份契约同时被三门禁（`check:render` 的阶梯/分块
 * 断言）与四个实现（dom / canvas2d / webgpu / webgpu-compat）共用。形状一旦漂移，
 * 「同一张图换后端后位置变了」这类缺陷只会在真机上被看见，所以在编译期先钉死。
 *
 * 几何类型（`Size` / `ViewTransform`）**在这里重新声明**而不是 import
 * `panels/imageviewer/viewerZoom.ts`：`render/` 是与 `panels/` 平级的跨面板设施，
 * 反向依赖某个具体面板会让「渲染设施」和「某一个查看器」绑死。两处形状结构相同，
 * TypeScript 的结构类型让调用方直接互传，不需要转换。
 */

/** 档位：一条降级链上的取值，不是四份实现（webgpu-compat 与 webgpu 共用一份代码）。 */
export type Backend = "webgpu" | "webgpu-compat" | "canvas2d" | "dom";

/** 失败原因。`retryable` 只在同一档位内有意义（见 `SurfaceError`）。 */
export type SurfaceErrorCode =
  | "no-api" // 没有 navigator.gpu
  | "no-adapter" // requestAdapter 返回 null / 超时
  | "software-adapter" // 回退适配器且未允许
  | "canary-failed" // 画不出正确像素（虚拟显示适配器、坏驱动）
  | "device-lost" // 运行期丢失（TDR / 驱动重置）
  | "context-lost" // canvas2d 丢失
  | "texture-alloc" // 纹理分配失败（显存不足 / 超尺寸）
  | "upload-failed"
  | "decode-failed";

export interface SurfaceError {
  code: SurfaceErrorCode;
  /** 可重试 = 值得在同一档位重建一次；不可重试 = 直接降到下一档。 */
  retryable: boolean;
  detail?: string;
}

export type SurfaceResult = { ok: true } | { ok: false; error: SurfaceError };

/** 像素尺寸（CSS 像素或图像像素，由函数名/参数名区分）。 */
export interface Size {
  width: number;
  height: number;
}

/** 视图平移量（CSS 像素，相对舞台中心）。 */
export interface Offset {
  x: number;
  y: number;
}

/**
 * 视图变换：`zoom` = 1 个图像像素对应多少 CSS 像素（与 `viewerZoom.ts` 同口径）。
 *
 * 表面**只读**它：不得自行夹紧、不得自行改 `offset`（否则滚轮手感会按后端分叉）。
 */
export interface ViewTransform {
  zoom: number;
  offset: Offset;
}

/**
 * 一次要显示的东西。`natural` 是**图像原始像素**尺寸，不是解码后位图的尺寸。
 *
 * `natural` 允许是 `0×0`：表示「原图尺寸尚未知」（预解码失败/超时的兜底路径）。
 * 这条兜底必须保留——旧实现靠 `.iv-image-pending` 按「适应窗口」的同一几何先画，
 * 尺寸回来后再换成实尺寸；`dom` 表面用同一套类名复现，`canvas2d` 则用元素自身尺寸。
 */
export type ImageSource =
  | { kind: "url"; url: string; natural: Size } // dom 后端用
  | { kind: "bitmap"; bitmap: ImageBitmap; natural: Size } // canvas2d / webgpu 用
  | { kind: "element"; el: HTMLImageElement; natural: Size };

export interface SurfaceStats {
  readonly backend: Backend;
  uploads: number;
  uploadedBytes: number;
  /** 最近一帧的 CPU 侧耗时（不含 GPU 完成时间；读回会污染性能，所以不测 GPU 侧）。 */
  lastFrameMs: number;
  /** 当前常驻的 LOD1 分块数（dom / canvas2d 恒 0）。 */
  residentTiles: number;
}

export interface ImageSurface {
  readonly backend: Backend;
  /** 把自建节点挂进宿主；宿主尺寸由 CSS 决定（`position:absolute; inset:0`）。 */
  mount(host: HTMLElement): void;
  /** 换图。`ok:false` = 这一档救不了，调用方降级；失败后**不得**继续画旧源。 */
  setSource(source: ImageSource): Promise<SurfaceResult>;
  /** 同步标记「该画一帧」，实际绘制由共享 rAF 调度器合并（每帧至多一次）。 */
  setView(view: ViewTransform, viewport: Size, dpr: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  readonly stats: SurfaceStats;
}

export interface SurfaceDeps {
  /** 画布首选格式（`navigator.gpu.getPreferredCanvasFormat()`；无 GPU 时为空串）。 */
  readonly canvasFormat: string;
  readonly background: string;
  readonly uploadBudgetBytes: number;
  readonly tilePx: number;
  readonly tileCacheBytes: number;
}

/**
 * 契约之外的**回调槽**：契约里没有回调（表面不该关心 React），
 * 但「原图尺寸未知」的兜底路径必须把解码出来的尺寸交回面板，
 * 否则 `.iv-image-pending` 会一直停在待解码形态。所以允许实现方接收这一小组可选回调，
 * 它们不改变任何绘制行为。
 */
export interface SurfaceHooks {
  /** 元素解码完成后报告原图尺寸（仅兜底路径需要）。 */
  onNatural?: (natural: Size) => void;
  /** 这一档救不了（解码失败、元素加载失败）。调用方据此走预览兜底。 */
  onFailed?: (error: SurfaceError) => void;
  /** `dom` 表面写在 `<img alt>` 上；其余后端忽略。 */
  alt?: string;
}

/** 成功的统一返回值（避免四处手写对象字面量）。 */
export const SURFACE_OK: SurfaceResult = { ok: true };

export function surfaceFail(
  code: SurfaceErrorCode,
  retryable: boolean,
  detail?: string,
): SurfaceResult {
  return { ok: false, error: detail === undefined ? { code, retryable } : { code, retryable, detail } };
}

/** 尺寸是否可用（正的整数像素）。`0×0` 是「未知」，不是可用尺寸。 */
export function isKnownSize(size: Size | null | undefined): size is Size {
  return (
    !!size &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}
