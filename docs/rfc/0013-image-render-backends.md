# RFC 0013：图像渲染后端与逐表面回退（WebGPU / Canvas2D / DOM）

状态：正式草案。本文落实用户 2026-11-11 的两轮口径（先问「本项目的渲染 API 是什么」，再要求「继续细化 WebGPU 及其回退方案」），**只定义设计，不含实现**；在实现落地前，图像查看器继续走 `<img>` + CSS `transform`，现行行为、缺陷 0028 的处置与全部门禁都不变。

用户已表达的口径：

1. 要弄清的是**图像这条路径**能不能上 GPU，不是把整个界面 GPU 化。
2. 方案必须**带回退**，而且回退不能是「整个应用降级」——一块画不出来，只该那一块退化。
3. 不为了「用上新技术」而引入第三方渲染库：仓库现有依赖里没有任何图形库（`apps/desktop/package.json`），这条边界保持不变。

## 1. 现状（实现前的事实基线）

| 事项 | 事实 | 锚点 |
| --- | --- | --- |
| 图像显示 | DOM `<img>` + CSS `transform`（`translate(calc(-50% + offset.x), …) scale(zoom)`），缩放平移**不重采样位图**，交给合成器 | `apps/desktop/src/app_ui/panels/imageviewer/ViewerStage.tsx:162-170`、`:184-208` |
| 换图语义 | 面板**先解码**再同批换 `url` 与尺寸，且 `key={url}` 强制换元素——缺陷 0028 的修法，不能回退 | `apps/desktop/src/app_ui/panels/imageviewer/viewerDecode.ts:32`、`ViewerStage.tsx:186-190` |
| 坐标契约 | `zoom` = 1 图像像素对应多少 CSS 像素；`offset` = 舞台正中相对居中的位移；纯函数、无框架依赖，门禁可直接 import | `apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts:4-11`、`:14-15`、`:57-72` |
| 大图规模 | 数万张，含大量 9000×9000 以上，常规 1536²–3096² | `docs/issues/0018-large-image-scan-and-display-scale.md` |
| 单张成本 | 9000²：解码 168 ms、dHash 813 ms、缩略图 405 ms；**重采样不是免费操作** | 同 0018 的实测表 |
| 已有按需分辨率 | 缩略图档梯 `320 / 480 / 640 / 960 / 1280`（向上吸附），缓存键 `fileId@bucket`，前端按视图几何 × DPR 算需求 | `docs/architecture/decision-checklist.md:1069`（D159） |
| 全分辨率素材 | 查看器走 `preview.get` 全分辨率 JPEG（102 MP 0.81 s）；大图不缩放 | `docs/issues/0019-avif-heic-decode-support.md` |
| PDF | Rust 侧 CPU 光栅化（非 GPU），结果当图片显示 | `crates/hp-pdf/src/lib.rs:41` |
| 图形 API | 全仓无 WebGPU / WebGL / `<canvas>` / 任何图形库；宿主也没设 `--disable-gpu` / `--use-angle` 之类的启动参数 | 本轮调查结论（无对应源码锚点） |
| 设置注册表 | 单一事实来源 `SETTING_KEYS` + `SYSTEM_SETTING_DECLS`，须与 Rust `setting_types.rs` 逐项镜像，三套 i18n 键齐备 | `packages/config/src/settings.ts:23-46`、`:297` |
| 门禁可 import TS | 门禁脚本用自定义 loader 动态 import `.ts`（纯模块先例：`viewerZoom.ts`、`settings.ts`） | `tools/blueprint-check-register.mjs`、`tools/check-settings.mjs:32-34` |
| 无头验证 | 现有截图/CDP 工具跑本机 Edge；其中两支显式 `--disable-gpu`，且 headless 默认不提供 WebGPU | `tools/reader-paper-screenshots.mjs:129` |

## 2. 决策

| # | 决策 | 为什么 |
| --- | --- | --- |
| 1 | **只换显示器，不换界面**：DOM 仍是布局与文本的底座，GPU 只接管「一张图/一页 PDF 的像素」 | 无障碍、文本选择、dockview 停靠、门禁断言全建在 DOM 上；迁移没有收益只有风险 |
| 2 | **后端是档位，不是实现份数**：`webgpu` 与 `webgpu-compat` 共用同一份 `surfaceWebGpu.ts`（只差 `requestAdapter` 参数与 limits），WGSL 只有一份 | 复制一份后端只为改三行参数，是维护负担 |
| 3 | **回退粒度 = 表面（surface）**：每个表面独立构造、独立失败、独立降级；只有「同一档位在本次会话内连续失败」才记忆成全局跳过 | 一块画不出来不该拖垮另一块；但反复重试同一个坏适配器也没意义 |
| 4 | **两级素材，先粗后细，且只对大图启用**：原图长边 > **4096** 时 LOD0 先出已有 **1280 档缩略图**（WebP，`thumb.get`），LOD1 = 全分辨率 `preview.get` 按 1024² 分块；≤ 4096 的小图**不启用 LOD0**，等全分辨率一次出图（与今天等价） | 9000² 全分辨率解码 168 ms、上传 324 MB；1280 档约 100–300 KB、解码个位数毫秒——**首帧从「秒级」降到「十几毫秒」**。小图等全分辨率只需几十毫秒，为它引入一次清晰度跳变不值 |
| 5 | **不新建中间档**（2048 / 4096 金字塔）：先测，LOD0 → 全分辨率之间出现可见跳变或抖动，才在 Rust 侧补档（复用 D159 的档梯与缓存键约定） | 每加一档就是磁盘 × N 与缓存清理问题；D159 已证明「档梯向上吸附」够用 |
| 6 | **颜色直通，不做 sRGB 转换**：纹理用 `rgba8unorm`、画布用 `getPreferredCanvasFormat()` 的非 sRGB 形态 | 一次多余转换就会让照片发灰；`<img>` 今天的行为就是直通 |
| 7 | **不做 WebGL2 后端** | 双份 shader + 双份设备丢失处理，换来的只是「比 canvas2d 更可控」；老硬件由 compat 模式覆盖 |
| 8 | **不引入第三方渲染库** | 一个 quad + 一张纹理，WGSL 约 25 行；引库等于把包体和升级风险一起引进来 |
| 9 | **默认档位可配置，默认 `auto`** | 用户机器差异大（本机就有 4 个显示适配器），`auto` 允许按实测降级；`dom` 是随时可回的一档 |

用户 2026-11-11 裁决（四条，落地按此执行；明细见 §15）：

1. `ui.imageBackend` 出厂默认 **`auto`**。
2. LOD0 **只对大图启用**：长边 > 4096 才先出 1280 档；≤ 4096 直接等全分辨率（不引入清晰度跳变）。
3. 投入范围 **S1 + S2**，按 §12 的 go/no-go 止损；S3 的中间档不投，除非实测出跳变。
4. LOD1 常驻上限 **256 MB**、每帧上传预算 **32 MiB**，不按适配器自适应。

## 3. 契约

新增目录 `apps/desktop/src/app_ui/render/`（与 `panels/` 平级：这是跨面板的显示设施，不属于某个面板）。

```ts
// render/surface.ts —— 契约与错误（纯类型 + 纯函数，可被门禁 import）

/** 档位：一条降级链上的取值，不是四份实现。 */
export type Backend = "webgpu" | "webgpu-compat" | "canvas2d" | "dom";

export type SurfaceErrorCode =
  | "no-api"            // 没有 navigator.gpu
  | "no-adapter"        // requestAdapter 返回 null / 超时
  | "software-adapter"  // 回退适配器且未允许
  | "canary-failed"     // 画不出正确像素（虚拟显示适配器、坏驱动）
  | "device-lost"       // 运行期丢失（TDR / 驱动重置）
  | "context-lost"      // canvas2d 丢失
  | "texture-alloc"     // 纹理分配失败（显存不足 / 超尺寸）
  | "upload-failed"
  | "decode-failed";

export interface SurfaceError {
  code: SurfaceErrorCode;
  /** 可重试 = 值得在同一档位重建一次；不可重试 = 直接降到下一档。 */
  retryable: boolean;
  detail?: string;
}

export type SurfaceResult = { ok: true } | { ok: false; error: SurfaceError };

/** 一次要显示的东西。`natural` 是**图像原始像素**尺寸，不是解码后位图的尺寸。 */
export type ImageSource =
  | { kind: "url"; url: string; natural: Size }        // dom 后端用
  | { kind: "bitmap"; bitmap: ImageBitmap; natural: Size } // canvas2d / webgpu 用
  | { kind: "element"; el: HTMLImageElement; natural: Size };

export interface SurfaceStats {
  readonly backend: Backend;
  uploads: number;
  uploadedBytes: number;
  /** 最近一帧的 CPU 侧耗时（不含 GPU 完成时间）。 */
  lastFrameMs: number;
  /** 当前常驻的 LOD1 分块数（dom / canvas2d 恒 0）。 */
  residentTiles: number;
}

export interface ImageSurface {
  readonly backend: Backend;
  /** 把自建节点挂进宿主；宿主尺寸由 CSS 决定（`position:absolute; inset:0`）。 */
  mount(host: HTMLElement): void;
  /** 换图。返回 `ok:false` 表示这一档救不了，调用方降级；**不得**在失败后继续 draw 旧源。 */
  setSource(source: ImageSource): Promise<SurfaceResult>;
  /** 同步标记「该画一帧」，实际绘制由共享 rAF 调度器合并（每帧至多一次）。 */
  setView(view: ViewTransform, viewport: Size, dpr: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  readonly stats: SurfaceStats;
}

export interface SurfaceDeps {
  readonly canvasFormat: GPUTextureFormat;
  readonly background: string;
  readonly uploadBudgetBytes: number;
  readonly tilePx: number;
  readonly tileCacheBytes: number;
}
```

约束（写进实现注释，也写进门禁）：

- `setView` 幂等且**同步返回**；同一帧内多次调用只保留最后一次。
- `setSource` 之后必须有一次 `setView` 才出画；实现方不得自行改 `ViewTransform`。
- `dispose` 之后再调用任何方法都是 no-op（不抛），便于 React 卸载竞态。
- 契约里没有「读回像素」：验收靠截图与 `stats`，不靠运行时读回（读回会改变被测对象的性能）。

## 4. 探测与阶梯

### 4.1 探测报告（可注入、可单测）

```ts
// render/capabilities.ts
export interface AdapterReport {
  ok: boolean;
  reason?: SurfaceErrorCode;
  info?: { vendor: string; architecture: string; device: string; description: string; fallback: boolean };
  maxTexture2D?: number;         // 决定 tilePx
  maxBufferSize?: number;
}

export interface CapabilityReport {
  hasGpu: boolean;
  core: AdapterReport;           // requestAdapter({ powerPreference: "high-performance" })
  compat: AdapterReport;         // requestAdapter({ featureLevel: "compatibility" })
  canary: "pass" | "fail" | "skip";
  slow: boolean;                 // 微基准超阈值
  probedAt: number;
}
```

判定顺序（全部带超时，**800 ms** 单个上限，总上限 2 s）：

1. `navigator.gpu` 不存在 → `hasGpu=false`，阶梯只剩 canvas2d / dom。
2. `requestAdapter({ powerPreference: "high-performance" })`；`adapter.info.isFallbackAdapter` 为真且未允许软件适配器 → `software-adapter`。
3. `requestDevice({ requiredFeatures: [], requiredLimits: { maxTextureDimension2D: 4096 } })`（只要 4096，能开即开；真正的上限从 `device.limits.maxTextureDimension2D` 读）。
4. **canary**：8×8 纹理填入 4 个已知色块 → 画到 8×8 canvas → `copyTextureToBuffer` + `mapAsync` 读回 → 抽样 4 点，每通道容差 ±2。失败即 `canary-failed`，**整档跳过**。这一步专门挡「适配器在、画面全黑/全白」的虚拟显示驱动。
5. 微基准：2048² 纹理连续上传 4 次 + 空绘制 30 帧，`queue.onSubmittedWorkDone()` 计时。`> 250 ms` 记 `slow=true`（仍允许，只是 `auto` 不选它）。
6. compat 档：`requestAdapter({ featureLevel: "compatibility" })`（Chromium 146+ 才有该选项；旧版直接抛/忽略 → 记为不可用）。compat 档的 `requiredLimits` 只留 `maxTextureDimension2D`，**不请求** storage texture / 多采样。

探测结果在**模块内存**里缓存一次（不落 `sessionStorage`：驱动升级后陈旧判定比重复探测更贵）。启动后在首个 `requestIdleCallback` 里跑，不阻塞首屏。

### 4.2 阶梯（纯函数，门禁逐条断言）

```ts
export type Preference = "auto" | "webgpu" | "canvas2d" | "dom";
export function decideBackends(r: CapabilityReport, p: Preference): Backend[];
```

| 配置 | 阶梯 |
| --- | --- |
| `dom` | `["dom"]` |
| `canvas2d` | `["canvas2d", "dom"]` |
| `webgpu`（显式强制） | 跳过硬性拒绝项（fallback 适配器、canary 失败仍**允许**，供排障）：`["webgpu", "webgpu-compat", "canvas2d", "dom"]` 中可构造者 |
| `auto` | `core.ok && canary==="pass" && !slow` → `webgpu`；否则 `compat.ok && canary!=="fail"` → `webgpu-compat`；`canvas2d` 恒可用；末位 `dom` |

`auto` 永不选 `slow` 的 core 档，但 `webgpu-compat` 不受 `slow` 限制（compat 走 GLES/D3D11，测的是另一条路径）。

### 4.3 会话级记忆

`render/registry.ts` 维护 `Map<Backend, { failures: number; disabledUntilReload: boolean }>`：同一档位在**同一会话**内构造失败 2 次 → 该档禁用，后续表面直接从下一档起。显式强制（`ui.imageBackend=webgpu`）不受记忆影响（否则排障时永远看不到失败现场）。

## 5. 状态机

```
                 ┌──────── probe 未完成 ────────┐
                 ▼                              │
idle ──mount──► acquiring ──ok──► ready ──setView──► drawing
                   │  │                              │
      no-adapter   │  └─device-lost(retryable, ≤2)───┘
      canary-fail  ▼
                 failed ──► degrade(next) ──► acquiring(下一档)
                                              │
                                     无下一档 ▼
                                            dom（构造必定成功）
```

规则：

- `device-lost`：`reason === "destroyed"`（自己调的）不重建；其余重建 ≤ 2 次，重建后**重传可见分块**；第 3 次 → `degrade("canvas2d")`。
- 降级时 `degrade` 必须**先**把旧表面 `dispose`，再把 `natural`/`view` 交给新表面，避免两套节点同时画（截图验收会看到双影）。
- 任何 `failed` 都要 `console.warn` 一行（带 backend + code + detail），但**不弹窗**：图像显示失败已经是可见的，再弹一个对话框只是噪音。降级结果体现在设置页的「当前图像后端」一行。

## 6. WebGPU 后端

### 6.1 素材模型

| 层 | 来源 | 解码方 | 常驻 | 用途 |
| --- | --- | --- | --- | --- |
| LOD0 | `thumb.get(fileId, size=1280)`（WebP） | Chromium（小图，个位数 ms） | 1 张纹理 1280² + 完整 mip 链 | **仅长边 > 4096 的大图**：先出图；缩小显示时只用它 |
| LOD1 | `preview.get(fileId)`（全分辨率 JPEG） | Chromium（按需，`createImageBitmap` 裁块） | 视口内 + 半屏外扩的 1024² 分块，LRU 上限 256 MiB | `zoom × dpr` 超过 LOD0 密度时叠加 |
| 小图快路径 | `preview.get`（长边 ≤ 4096） | Chromium（一次解码） | 单张整纹理（≤ 4096² = 64 MiB），不分块 | 唯一路径，等价于今天的 `<img>` |

**小图不走 LOD0**（用户 2026-11-11 裁决）：长边 ≤ 4096 的全分辨率解码在几十毫秒量级（0021 实测 2048² 18 ms、3096² 32 ms），一次出图即可；为它引入两级 LOD 只会换来看得见的一次清晰度跳变。因此分块与大图 LOD 只对大图存在，`shouldPrefetchLowRes()` 是唯一判定入口（见 §6.2）。

显存数量级（RGBA8，1024² 分块 = 4 MiB）：LOD0 = 6.25 MiB，mip 链合计 8.3 MiB；一块 9000² 的图全图分块 = 81 块 = 324 MiB，**永不全部常驻**——1280×800 视口在 1:1 下只需约 6 块（24 MiB）。LOD1 是「随视口移动的窗口」，不是「整图的副本」。

### 6.2 分块几何（纯函数）

```ts
// render/tiles.ts
export interface TileGrid { tile: number; cols: number; rows: number; }
export function tileGrid(natural: Size, tilePx: number): TileGrid;      // cols = ceil(w / tilePx)
export function tileImageRect(g: TileGrid, i: number): Rect;            // 图像像素，最后一行/列可能更小
/** 视口反算到图像坐标：sx = vw/2 + offset.x + (ix - natural.w/2) * zoom */
export function viewportImageRect(natural: Size, view: ViewTransform, viewport: Size): Rect;
/** 需要画的分块：与视口矩形（外扩 margin 屏）相交者，按到视口中心的切比雪夫距离升序。 */
export function visibleTiles(g: TileGrid, natural: Size, view: ViewTransform, viewport: Size, margin: number): number[];

/** 大图阈值：长边**严格大于**它才启用 LOD0 与分块（4096 本身走小图快路径）。 */
export const LOD0_MIN_LONG_SIDE = 4096;
export function shouldPrefetchLowRes(natural: Size): boolean;   // Math.max(w, h) > LOD0_MIN_LONG_SIDE
```

反算公式（实现与门禁共用，**不得**各自推导）：

```
ix = natural.w / 2 + (sx - viewport.w / 2 - view.offset.x) / view.zoom
```

`tilePx` 取值：`min(1024, floor(device.limits.maxTextureDimension2D / 2))`——留 2 的余量给「块 + 2 px 边框」与将来可能的 mip。8192 上限的 D3D12 tier 1 机器上仍是 1024。

### 6.3 上传调度

- 预算：`ui.imageUploadBudgetMB`，出厂 **32 MiB**（用户 2026-11-11 裁决，不按适配器自适应）→ 每帧最多 8 块 1024²。
- 优先级：视口内（由中心向外）→ 半屏外扩 → 视口外。**同一次 `setSource` 的块共享一个 `generation` 计数**；换图后旧 generation 的排队项全部丢弃（防止「旧图的分块在新图上闪现」）。
- 每帧至多一次 `writeBuffer` + 一次 `copyExternalImageToTexture` 批次；批次超过预算就留到下一帧，**不阻塞 `draw`**。
- 预算只约束 **LOD1 分块流**：小图快路径的整张上传是一次性事件（≤ 64 MiB），不受 32 MiB/帧 约束，否则 4096² 的图会被自己的预算挡住。
- `setVisible(false)`（面板被冻结/切走）暂停上传队列，只保留已常驻块。

裁块而不是留全图：`createImageBitmap(imgEl, sx, sy, sw, sh)` 只取「块 + 2 px 边框」（边框是为了线性过滤在块边界处有真实相邻像素，否则 1:1 上放大时会出现发丝缝）。**不**在 JS 里长期持有全分辨率 `ImageBitmap`（9000² = 324 MB 的 JS 侧副本）。

### 6.4 绘制数学

CPU 侧把每块算成 6 个 NDC 顶点，GPU 只做「采样 + 输出」，**没有矩阵 uniform**：

```
sx = vw/2 + offset.x + (ix - natural.w/2) * zoom        // 舞台 px
sy = vh/2 + offset.y + (iy - natural.h/2) * zoom
ndcX = sx / vw * 2 - 1
ndcY = 1 - sy / vh * 2
```

顶点缓冲：每顶点 `pos.xy + uv.xy`（16 B），每块 6 顶点 = 96 B；一帧 ≤ 64 块（超过就只画 LOD0，避免顶点缓冲与绑定组数量失控）。UV 内缩 `gutter / tileSize`（gutter = 2 px）。

LOD1 开关带**滞回**：`zoom × dpr > lod0Density × 1.15` 才画分块，`< lod0Density × 0.85` 收掉——避免在临界倍率上每帧来回切。

### 6.5 着色器（单文件，约 25 行）

```wgsl
// render/shaderQuad.wgsl
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
  var out: VsOut;
  out.pos = vec4<f32>(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv);
}
```

采样器：`magFilter: "linear"`、`minFilter: "linear"`、`mipmapFilter: "linear"`、`addressModeU/V: "clamp-to-edge"`。**没有各向异性过滤**——所以缩小显示必须靠 LOD0 的 mip 链（每级 `generateMipmap` 手写一遍 downsample pass，1280 档 11 级约 0.2 ms）。

### 6.6 画布与颜色

- 画布：`canvas.getContext("webgpu")` → `configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque", usage: RENDER_ATTACHMENT })`。
- 纹理格式一律 `rgba8unorm`（**不是** `-srgb`）。理由是两侧都直通：照片字节写进纹理、采样原样写进画布，等价于 `<img>` 今天的输出；任何一侧按 sRGB 解释都会得到「发灰/发暗」。
- `loadOp: "clear"` 的清除色取宿主 `getComputedStyle(host).backgroundColor`（与面板背景一致），在 `mount` 与主题变化时刷新；不用硬编码色值（否则浅色主题下图像外面一圈深灰）。
- DPR：`ResizeObserver` 的 `devicePixelContentBoxSize` 优先（整数设备像素），退回 `contentBoxSize × devicePixelRatio` 再 `round`；画布 `width/height` = 设备像素，CSS 尺寸 = 内容盒。用 CSS 尺寸 × DPR 会在 125%/150% 下与 DOM 差 1 px，表现为图像边缘一条细缝。

### 6.7 设备丢失

`device.lost` 是**常规事件**（TDR、驱动重置、笔记本切换独显）而不是异常：重建 device、重跑 canary、重传可见块，期间保留最后一帧的画布内容（不要清成背景色，否则用户看到闪黑）。重建 2 次仍失败 → 降 canvas2d。

### 6.8 真机实测（S0，2026-11-11）

**测法**：`node tools/render-probe.mjs`（CDP 连打包 app 的 WebView2，不经过 headless）。每个请求档各建一个
device，在同一台机器上连跑 4 次；每档分别测：`adapter.info`、canary（8×8 四色块 → 采样 → `copyTextureToBuffer`
读回，每通道容差 ±2）、`device.limits.maxTextureDimension2D`、2048² 纹理上传 4 次、空绘制 30 帧（均以
`queue.onSubmittedWorkDone()` 收尾计时）。表里取 4 次的**中位数**，括号内是全 4 次的取值范围——单帧级操作的
方差很大（同一条路径可以差 50%），不要拿单次数字做结论。

**机器**：Windows 11 家庭版 10.0.26300 · i5-13500H · Iris Xe（驱动 32.0.101.7088）+ RTX 4060 Laptop
（驱动 32.0.16.1692）+ 两个虚拟显示适配器（GameViewer / MuMu）· WebView2（Chrome/157.0.0.0）· 2560×1600。

| 请求档 | WebGPU 返回的适配器 | 回退适配器 | maxTexture2D | canary | 2048²×4 上传 | 空绘制 30 帧 |
| --- | --- | --- | --- | --- | --- | --- |
| `high-performance`（core） | intel / gen-12lp | false | 8192 | **pass**（Δ0） | 103.2 ms（74.7–127.6） | 6.4 ms（5.3–15.4） |
| `low-power` | intel / gen-12lp | false | 8192 | **pass**（Δ0） | 32.1 ms（29.7–69.0） | 6.1 ms（5.1–7.8） |
| `forceFallbackAdapter` | — | — | — | no-adapter | 未测 | 未测 |
| `featureLevel: compatibility` | intel / gen-12lp | false | 4096 | **pass**（Δ0） | 34.5 ms（25.5–45.7） | 6.6 ms（5.4–7.3） |

单次上传（16 MiB）≈ 8.6 ms（low-power 中位）、空绘制 ≈ 0.2 ms/帧；两者合计远低于 §4.1 的 250 ms
`slow` 阈值，因此本机 `slow=false`。

**实测得到的三条事实**（都影响实现，不只是记录）：

1. **本机装了 4 个显示适配器，WebGPU 只枚举出 1 个**：三种请求（含 `powerPreference: "high-performance"`）
   全部返回 Intel Iris Xe，RTX 4060 与两个虚拟显示适配器都不可见；`forceFallbackAdapter` 直接 `no-adapter`
   （即没有 WARP 这类软件回退档）。原因是 WebView2 的 GPU 进程绑在核显上，进程内看不到独显。
   因此**独显路径在本机无法验证**——S2 的 go/no-go 只能代表核显，写进 S2 报告时不要外推到独显。
2. **canary 在三个可用档上都是 Δ0**，S0 的止损条件（独显与核显都失败）不成立，按 §12 继续 S1/S2。
3. **`maxTextureDimension2D` 实测 8192（core）/ 4096（compat）**，而 `adapter.limits` 报 16384；
   按 §6.2 的 `tilePx = min(1024, floor(limit / 2))` 两档都取 **1024**，分块尺寸不受影响。
   另：Chrome 157 已把「回退适配器」标志从 `adapter.isFallbackAdapter` 移到 `adapter.info.isFallbackAdapter`
   （后者在本机为 `false`，前者为 `undefined`）——实现两处都要读。

**探针自身踩到的坑（写下来防止 S2 重犯）**：管线创建时声明的 fragment target 格式**必须**与该 render pass
的附件格式一致。第一版探针用一条 `rgba8unorm` 管线同时画自有纹理与 canvas（canvas 是 `bgra8unorm`），
校验拒绝会让**整个** command buffer 作废，读回全零——看起来就像「驱动画不出像素」，几乎把 canary 判成硬件
故障。所以：S2 的绘制管线按**画布格式**建；LOD0 的 mip 生成另建一条 `rgba8unorm` 管线（目标是自己持有的纹理）；
真机表格必须同时给出 clear-only 读回（只测纹理→缓冲→map 这条搬运链）与四色块结果，两者才能区分「搬运坏」
与「管线坏」。

## 7. Canvas2D 后端

- `<canvas>` + `getContext("2d", { alpha: false, desynchronized: true })`。
- 每帧：`clearRect` → `drawImage(lod0Bitmap, 0, 0, vw, vh)` 的等价变换（用 `setTransform` 做缩放平移），LOD1 就绪后按块 `drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh)` 覆盖。
- `imageSmoothingQuality = "high"`，仅在**缩小**时开（`zoom < 1`）；放大时开会让 1:1 变糊。
- 价值不在性能（Chromium 的 Canvas2D 本身就是 Skia GPU 光栅），而在**它是 WebGPU 失败后的第一落点**，且与 WebGPU 共用 `ImageSource` / LOD0 / 分块几何——两条路只差「提交方式」。
- `contextlost` 事件 → 重建一次；再丢 → 降 dom。

## 8. DOM 后端

即今天的实现，逐条保持：

- `mount` 往宿主塞一个 `<img>`；`setSource({kind:"url"})` 时**换元素**（`key` 语义），不复用节点换 `src`（缺陷 0028）。
- 缩放平移仍用 `translate(...) scale(...)`，`will-change: transform` 由 CSS 现有规则给。
- `setVisible(false)` → `img.loading`、`decoding` 不动，只置 `display:none`（合成器会回收图层）。
- 它是**最终兜底**，也是 A/B 基线：任何「GPU 版更快」的结论都必须与这一档同机同图对比。

## 9. 设置

两个键（不新增大类；`category: "interface"` + 新分节 `settings.section.performance`）：

| 键 | kind | 默认 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `ui.imageBackend` | select | `auto` | `auto` / `webgpu` / `canvas2d` / `dom` | 图像显示后端；`auto` 按探测降级，其余为**强制**（排障用） |
| `ui.imageUploadBudgetMB` | numberInput | `32` | 4–256（读取处夹紧） | 每帧纹理上传预算；低于 4 等于关掉 LOD1 预取 |

落地清单（漏一处门禁就红）：

1. `packages/config/src/settings.ts`：`SETTING_KEYS` 两条 + `SYSTEM_SETTING_DECLS` 两条 + `DEFAULT_IMAGE_BACKEND` / `DEFAULT_IMAGE_UPLOAD_BUDGET_MB` + `isImageBackend()` 取值域函数。
2. `crates/hp-core/src/setting_types.rs`：镜像同两条（键 / kind / 默认值 / 选项集）。
3. `apps/desktop/src/app_ui/i18n/{zh-CN,zh-TW,en}.ts`：`settings.interface.imageBackend`（含四个选项）、`settings.interface.imageUploadBudgetMB`、`settings.section.performance`。
4. `pnpm check:settings` 复绿（三套 i18n 键一致、TS ↔ Rust 逐项一致）。

「当前图像后端」只读一行（`webgpu · NVIDIA RTX 4060 Laptop · 7 块 / 34 MB`）放在同一分节，用于支持排障；它读 `stats`，不写库。

## 10. 接入点

只改两处，其余一行不动：

**A. `ViewerStage.tsx`**（图像舞台）

- 新增 prop `backend: Backend`（来自设置解析结果），内部 `useImageSurface()`。
- 把 `<img>` 换成 `<div ref={hostRef} className="iv-surface" />`；`mount` 后由后端自己塞 `<img>` 或 `<canvas>`。
- **不改**：非 passive wheel、`setPointerCapture` 拖动、`clampOffset`、`overlay` 槽、`iv-stage-*` 类名。几何仍全部走 `viewerZoom.ts`。
- `url` 变化时按 `shouldPrefetchLowRes(natural)` 分两支。**大图**（长边 > 4096）：先 `setSource({kind:"url"})` 出 LOD0，同时在后台请求 `preview.get`；全分辨率到位后 `setSource({kind:"element"})` 升级 LOD1（**同一 URL 不算换图**，不清空已有帧）。**小图**（≤ 4096）：只有一次 `setSource`，等全分辨率就绪再换（与今天同路径，无跳变）；`natural` 未知时按大图处理（先出低清总比白屏好）。
- 缺陷 0028 的不变量由 `generation` 承接：旧源的迟到回调一律丢弃，新源就绪前画布保持上一帧（不闪白）。

**B. `ViewerFilmstrip.tsx`**（胶片栏）：S3 才动；先只把缩略图换成同一个 `useImageSurface`（每格一个极小表面不值当），S3 的图集合批（见 §12）留给「滚动明显掉帧」被实测确认之后。

## 11. 门禁与测试

| 层 | 手段 | 断言 |
| --- | --- | --- |
| 纯逻辑 | 新增 `tools/check-render.mjs`（`pnpm check:render`），用 `blueprint-check-register.mjs` 同款 loader 直接 import `.ts` | ①阶梯决策表 8 组输入→输出逐条；②`tileGrid` 边界（9000/1024 → 9×9；1023 → 1×1；0 → 0）；③`viewportImageRect` 在 4 组 zoom/offset 下与手算一致；④`visibleTiles` 排序稳定且不重复；⑤滞回阈值方向（1.15 进 / 0.85 出）；⑥上传预算换算（32 MB / 4 MiB = 8 块）；⑦`check:settings` 已覆盖设置键与 i18n，不重复；⑧**唯一绘图入口**：`<canvas>` / `getContext("2d"` / `getContext("webgpu"` 只允许出现在 `app_ui/render/`；⑨`apps/desktop/package.json` 依赖里不得出现 three/pixi/regl/babylon；⑩`surfaceWebGpu.ts` 必须含 `device.lost` 与重试上限常量；⑪降级链顺序：`decideBackends` 的返回值必须以 `"dom"` 结尾；⑫`shouldPrefetchLowRes` 在 4096 / 4097 两侧取值相反（`false` / `true`），且 9000×6000 与 6000×9000 同为 `true` |
| 视觉 | 新增 `tools/viewer-render-verify.mjs`（headless Edge，`--headless=new`，**不加** `--disable-gpu`） | `dom` vs `canvas2d` 在 fit / 1:1 / 4× 三档的截图 SSIM ≥ 0.99（同图同窗口）；1:1 时边缘无 1 px 偏移 |
| 真机 | 新增 `tools/render-probe.mjs`（CDP 连打包 app，源自 `tools/real-machine-verify.mjs`） | 输出 `adapter.info`、canary 结果、4 次 2048² 上传耗时、30 帧空绘制耗时、`maxTextureDimension2D`；表直接贴回本文 §6.8 |
| 性能 | 扩展 `apps/desktop/perf/run.mjs`：`--scenario=viewer-zoom` | `p50 / p95` 帧时间、长帧（> 50 ms）计数、每帧上传 MB；三个后端各跑一遍 |

无头环境没有 WebGPU（headless 默认关闭，仓内两支工具还显式 `--disable-gpu`），所以 **WebGPU 的正确性只在真机上验**；headless 只验几何、降级决策与 dom/canvas2d 的视觉一致性。这是环境限制，不是偷懒——把它写进门禁注释，免得后人以为漏测。

## 12. 阶段、工时与止损

| 阶段 | 内容 | 工时 | 通过条件 / 止损 |
| --- | --- | --- | --- |
| S0 探测 | `render-probe.mjs` + 本机四个显示适配器逐一出报告 | 0.5–1 d | 产出 §6.8 的实测表；若 canary 在独显/核显上都失败，直接停（说明这台机器上 WebGPU 不可用，方案退化为 canvas2d + LOD0） |
| S1 抽象 + LOD0 | 契约、`surfaceDom`、`surfaceCanvas2d`、`useImageSurface`、设置两键、`check:render` | 2–3 d | **用户可见收益**：大图（长边 > 4096）换图首帧从「全分辨率解码（1648×3664 约 200–400 ms，9000² 更久）」降到「1280 档解码」，**首帧 > 120 ms 即回退本次改动**；小图（≤ 4096）走单纹理快路径，必须与今天的 `<img>` 逐帧等价（无清晰度跳变、无闪白） |
| S2 WebGPU | `surfaceWebGpu` + 分块 + 上传调度 + 设备丢失 + 真机探针 | 3–5 d | **go/no-go**：`--scenario=viewer-zoom` 的长帧数（> 50 ms）相对 S1 的 canvas2d 改善 **< 20%** 即停，保留 S1 成果；`surfaceWebGpu.ts` 整体删除即可回退（无外部引用） |
| S3 补齐 | 中间档（仅在 S2 通过且实测有跳变时）、胶片栏图集、PDF 页面按倍率重栅格 | 2–4 d | 每一项都要有「不回退就掉帧」的实测证据，不做则记为不做 |
| S4 收尾 | 决策登记（`decision-checklist.md` 追加 D160，编号落地时按当时序号取）、`file-structure.md` 增 `render/`、性能基线写进 `apps/desktop/perf/README` | 0.5 d | 全部门禁绿 + 真机验收截图 |

### 12.1 S2 实测与止损结论（2026-11-11）

S2 按 §6 全量实现后（`surfaceWebGpu.ts` 约 640 行、`shaderQuad.wgsl`、1024² 分块 + 2 px 边框、LOD0 mip 链、LOD1 LRU 256 MiB + 每帧 32 MiB 预算、`device.lost` 重建 ≤2 次后降 canvas2d；后端另加 `preview.tile` 命令按块裁剪并缓存），在**打包 app 的同一个 WebView2**里跑缩放场景（triangular 波形 fit→peak→fit，逐帧一次 `setView`，120 帧，预热 12 帧，长帧阈值 > 50 ms）。

机器：Windows 11 家庭版 10.0.26300 · i5-13500H · Iris Xe（`intel / gen-12lp`）· dpr 1.5 · WebView2 157。本机 WebGPU 只枚举到核显（§6.8 已记录），**独显路径未测**。

| 场景 | 图 | 宿主 | peak | canvas2d p50 / p95 / 长帧 | webgpu p50 / p95 / 长帧 | dom p50 / p95 / 长帧 |
| --- | --- | --- | --- | --- | --- | --- |
| 合成夹具 | 6000×4000 | 1280×800 | 4× | 6.1 / 6.8 / 1 | 6.0 / 7.2 / 1 | 6.1 / 7.0 / 1 |
| 合成夹具 · 240 帧 | 6000×4000 | 1280×800 | 4× | 6.1 / 6.9 / 1 | 6.1 / 6.9 / 1 | 6.0 / 6.9 / 1 |
| 真实图 24.0 MP（avif 6000×4000） | 同上 | 1280×800 | 4× | 6.1 / 7.3 / 1 | 6.1 / 7.0 / 1 | 6.1 / 6.8 / 1 |
| 真实图 | 同上 | 1280×800 | 16× | 6.0 / 7.2 / 1 | 6.0 / 6.9 / 1 | 6.1 / 6.7 / 1 |
| 真实图 | 同上 | 2560×1500 | 8× | **9.6 / 20.5 / 1** | **11.5 / 24.6 / 1** | **6.1 / 6.8 / 1** |

三个结论：

1. **长帧改善 0%**（所有组合的长帧计数都是 1，且那 1 帧来自预热残留）。1280×800 宿主上三档全部被 WebView2 的刷新率钉在 ~6.1 ms，测量本身已经没有分辨率。
2. 唯一拉开差距的 2560×1500 宿主上，**WebGPU 比 canvas2d 慢约 20%**（p50 11.5 vs 9.6，p95 24.6 vs 20.5）。原因是收益前提不成立：Chromium 的 canvas2d 本来就由 Skia 走 GPU，`drawImage` 是 GPU 到 GPU；而 WebGPU 路径每帧要 CPU 算 NDC、按块 `writeBuffer`，分块还要 `createImageBitmap` 裁切。§13「收益被高估」那条风险命中了。
3. **DOM 后端最快**（6.1 / 6.8）：CSS transform 由合成器直接做，不重栅格。这解释了为什么今天的 `<img>` 路径在缩放时并不慢——缩放的瓶颈在**换图解码**，不在绘制，而换图解码已由 S1 的 LOD0 解决。

处置（按 §12 的止损条款）：**`surfaceWebGpu.ts` 整体删除即回滚**，同时删除 `shaderQuad.wgsl`、`tileSource.ts`、`preview.tile` 命令与 `hp_media::tile` 分块生成、契约文档里对应行。保留：S1 全部成果（dom / canvas2d 表面、LOD0、契约、设置两键、`check:render`）、`render/webgpu.ts` 的探测类型与 `capabilities.ts` 的探测路径（`auto` 阶梯里 `webgpu`/`webgpu-compat` 两档现在无处可构造，`constructBackend` 返回 `null` 让阶梯继续往下走，落到 canvas2d）。`ui.imageBackend` 的 `webgpu` / `webgpu-compat` 选项**仍在设置里**：它们是排障用的强制档，选到即落 canvas2d，行为可预期。

`--scenario=viewer-zoom` 未加进 `apps/desktop/perf/run.mjs`：回滚之后没有可比的第二个后端，headless 也无 WebGPU；本节的实测来自 `render-zoom-probe.mjs`（临时探针，随 S2 一并删除），数字已记在此处。

## 13. 风险

| 风险 | 触发条件 | 处置 |
| --- | --- | --- |
| TDR / 驱动重置 | 大图连续上传、切换独显 | 已按常规事件处理（§6.7）；上传预算限制单帧占用 |
| 混合显卡 + 虚拟显示适配器 | 本机实测 4 个适配器（RTX 4060 Laptop / Intel Iris Xe / 两个虚拟显示） | canary + `isFallbackAdapter` 双筛；`auto` 不选 `slow`；`Dom` 永远在末位 |
| 8192 纹理上限（D3D12 tier 1） | 老驱动 | 分块上限 `min(1024, floor(max/2))`，永不申请超限纹理 |
| 颜色发灰 | 用了 `-srgb` 纹理格式或让画布做转换 | 契约级固定为直通（§6.6），截图 SSIM 兜底 |
| 125%/150% DPR 细缝 | 用 CSS 尺寸 × DPR 算 backing store | 用 `devicePixelContentBoxSize`（§6.6） |
| WebView2 版本过旧（Evergreen，`bundle: {}`） | 用户机器 < 113 | `navigator.gpu` 缺失 → 直接 canvas2d；不报错不提示 |
| 显存争用（用户同时开游戏/剪辑） | LOD1 常驻 256 MB | LRU 上限 + 面板不可见时暂停上传 + 显存不足时 `texture-alloc` 失败即降 canvas2d |
| 收益被高估 | Chromium 的 `<img>` 本就走 GPU 合成 | S2 设 go/no-go 阈值；S1 的收益（LOD0）与 API 无关，先落地先兑现 |

## 14. 刻意不做

- 不迁移界面、文本、视频、蓝图画布、阅读器到 GPU（各自都有更合适的既有机制）。
- 不做 WebGL2 后端、不改 `--use-angle` / `--disable-gpu` 之类的宿主启动参数（改了就是全应用范围的行为变更，与「逐表面回退」相反）。
- 不做运行时像素读回做自检（读回会污染性能测量）；正确性靠一次性 canary 与真机截图。
- 不引入 `OffscreenCanvas` + Worker 解码（先把主线程这条路做对；Worker 化是下一步的独立议题）。
- 不做 PDF 的 GPU 光栅化（`hp-pdf` 的 CPU 路径与显示后端无关，换后端不改栅格化成本）。

## 15. 裁决记录

用户 2026-11-11 对四个开放点逐条裁决如下（本文其余各节已按此改写；要偏离必须重开本文）：

| # | 问题 | 裁决 | 本文的落点 |
| --- | --- | --- | --- |
| 1 | `ui.imageBackend` 出厂默认 | **`auto`** | §2 决策 9、§4.2、§9 |
| 2 | S1 的「先糊后清」是否可接受 | **只对大图启用**（长边 > 4096）；小图等全分辨率 | §2 决策 4、§6.1、§6.2 的 `LOD0_MIN_LONG_SIDE = 4096`、§10、§12 |
| 3 | 投入范围 | **S1 + S2**，按 §12 的 go/no-go 止损；S3 中间档不投 | §12、§14 |
| 4 | LOD1 常驻上限 / 每帧上传预算 | **256 MiB / 32 MiB**，不按适配器自适应 | §6.1、§6.3、§9 |

裁决 2 的取舍（记下来，避免以后被当成疏漏）：小图等全分辨率只多花几十毫秒，却能保证「小图路径与今天逐像素等价」——把清晰度跳变限制在大图这一小撮、且是真正需要它的场景；`natural` 尚未解码时按大图处理（先出低清好过白屏），这条兜底也一并写进 `useImageSurface`。
