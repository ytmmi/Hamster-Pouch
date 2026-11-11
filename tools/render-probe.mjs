/**
 * S0 探针：**在真实打包 app 的 WebView2 里**逐项测量 WebGPU 能力（RFC 0013 §4.1 / §6.8）。
 *
 * ## 为什么必须连打包 app 而不是 headless 浏览器
 *
 * headless Chromium 默认**不提供** WebGPU（仓内两支既有工具还显式 `--disable-gpu`），
 * 因此「这台机器的显示适配器到底能不能画对像素」只能在真实 WebView2 里问。
 * 驱动方式沿用 `tools/real-machine-verify.mjs`：给 app 进程设
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`，
 * WebView2 就会开一个 DevTools 端点，之后用 Node 自带的 `WebSocket` 说 CDP
 * （不装 playwright，D20）。
 *
 * ## 量什么（RFC §6.8 的表就是它的输出）
 *
 * 1. 每个请求档（独显 / 省电 / 回退 / compatibility）的 `adapter.info`；
 * 2. **canary**：8×8 纹理填四个已知色块 → 采样 → `copyTextureToBuffer` 读回，
 *    每通道容差 ±2。这一步专挡「适配器在、画面全黑/全白」的虚拟显示驱动；
 * 3. `device.limits.maxTextureDimension2D`（决定 `tilePx`）；
 * 4. 2048² 上传 4 次耗时（`queue.onSubmittedWorkDone()` 计时）；
 * 5. 空绘制 30 帧耗时。
 *
 * 读回只发生在 canary 这一次（RFC §14：不做运行时读回做自检——那会污染性能测量）。
 *
 * ## 用法
 *
 * ```bash
 * pnpm app:build                                        # 产物在 target/release/release/
 * node tools/render-probe.mjs --port=9333
 * node tools/render-probe.mjs --out=apps/desktop/perf/results/render-probe.json
 * ```
 *
 * 退出码：0 = 探针跑完（canary 是否通过看输出）；2 = 找不到 app；3 = CDP 连不上。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}

/** 打包产物目录（`pnpm app:build` 的固定落点，D153 ⑩）。 */
const APP_DIR = resolve(
  ROOT,
  args.get("app") ?? "apps/desktop/src-tauri/target/release/release",
);
const EXE = join(APP_DIR, "hamster-pouch-desktop.exe");
const PORT = Number(args.get("port") ?? 9333);
const OUT = args.get("out") ?? null;
const LAUNCH_TIMEOUT = Number(args.get("timeout") ?? 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端（与 `perf/run.mjs` / `real-machine-verify.mjs` 同款，避免新增依赖）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve_, reject) => {
      this.pending.set(id, { resolve: resolve_, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 180000);
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "页面求值失败",
      );
    }
    return res.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 页面侧探针（整段在 WebView2 里跑）。
 *
 * 用一个字符串而不是 import 一个 `.ts`：这段代码只能在 WebView 里执行，
 * 放成独立模块反而要再走一遍打包。所有异常都在内部收敛成字段，避免一条失败
 * 让整张表缺失（"探测失败"本身也是要记录的事实）。
 */
const PROBE_SCRIPT = String.raw`(async () => {
  const out = {
    ua: navigator.userAgent,
    hasGpu: typeof navigator !== "undefined" && !!navigator.gpu,
    preferredFormat: null,
    adapters: [],
  };
  if (!out.hasGpu) return out;
  out.preferredFormat = navigator.gpu.getPreferredCanvasFormat
    ? navigator.gpu.getPreferredCanvasFormat()
    : null;

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout" + ms)), ms)),
    ]);

  const WGSL = [
    "struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };",
    "@vertex fn vs(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {",
    "  var o: VsOut; o.pos = vec4<f32>(pos, 0.0, 1.0); o.uv = uv; return o;",
    "}",
    "@group(0) @binding(0) var samp: sampler;",
    "@group(0) @binding(1) var tex: texture_2d<f32>;",
    "@fragment fn fs(i: VsOut) -> @location(0) vec4<f32> { return textureSample(tex, samp, i.uv); }",
  ].join("\n");

  const QUAD = new Float32Array([
    -1, -1, 0, 1,
     1, -1, 1, 1,
     1,  1, 1, 0,
    -1, -1, 0, 1,
     1,  1, 1, 0,
    -1,  1, 0, 0,
  ]);

  /** 8×8 四色块：左上红 / 右上绿 / 左下蓝 / 右下白（直通 rgba8unorm，不转 sRGB）。 */
  function canaryPixels() {
    const W = 8, H = 8;
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (y * W + x) * 4;
        const top = y < 4, left = x < 4;
        const rgb = top && left ? [255, 0, 0] : top ? [0, 255, 0] : left ? [0, 0, 255] : [255, 255, 255];
        data[at] = rgb[0]; data[at + 1] = rgb[1]; data[at + 2] = rgb[2]; data[at + 3] = 255;
      }
    }
    return data;
  }

  /**
   * 只做一次 clear 再读回。与四色块 canary 分开跑，是为了**区分**两种失败：
   * 这一段全零 = 纹理↔缓冲↔map 这条搬运链坏了（探针自身问题）；
   * 这一段正常而四色块全零 = 管线/采样/呈现坏了（真正要挡的驱动问题）。
   * 把两者混在一个结果里会得出错误结论（曾把探针 bug 误判成驱动 canary 失败）。
   */
  async function clearOnly(device) {
    const W = 4, H = 4, bytesPerRow = 256;
    const tex = device.createTexture({
      size: [W, H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: tex.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 10 / 255, g: 20 / 255, b: 30 / 255, a: 1 } }],
    });
    pass.end();
    const buf = device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const v = new Uint8Array(buf.getMappedRange());
    const got = [v[0], v[1], v[2], v[3]];
    buf.unmap();
    const expect = [10, 20, 30, 255];
    const delta = Math.max(...got.map((g, i) => Math.abs(g - expect[i])));
    return { result: delta <= 2 ? "pass" : "fail", delta, got };
  }

  async function canary(device, format) {
    const W = 8, H = 8;
    const clear = await clearOnly(device);
    // 包一层 validation 错误作用域：管线/拷贝被校验拒绝时，读回值会"合理地"全零，
    // 没有错误文本就分不清是驱动不画还是我们画错。
    device.pushErrorScope("validation");
    const src = device.createTexture({
      size: [W, H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    device.queue.writeTexture(
      { texture: src },
      canaryPixels(),
      { bytesPerRow: W * 4, rowsPerImage: H },
      { width: W, height: H },
    );
    const target = device.createTexture({
      size: [W, H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const module = device.createShaderModule({ code: WGSL });
    const vbuf = device.createBuffer({ size: QUAD.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbuf, 0, QUAD);
    // 管线绑定的是**目标格式**：canvas 用首选格式（本机 bgra8unorm），自有纹理用
    // rgba8unorm。用一条管线打两种格式会被校验拒绝，而且拒绝会让**整个**命令缓冲
    // 一起作废——读回全零，看起来就像驱动不画（这正是第一版探针的假阴性）。
    const pipelineFor = (targetFormat) => {
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vs",
          buffers: [{ arrayStride: 16, attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
          ] }],
        },
        fragment: { module, entryPoint: "fs", targets: [{ format: targetFormat }] },
        primitive: { topology: "triangle-list" },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: src.createView() },
        ],
      });
      return { pipeline, bind };
    };
    const own = pipelineFor("rgba8unorm");

    // 第一遍：画进自有纹理（可 COPY_SRC，读回只靠它）。
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(own.pipeline);
    pass.setBindGroup(0, own.bind);
    pass.setVertexBuffer(0, vbuf);
    pass.draw(6);
    pass.end();
    // 第二遍：再画进 canvas —— 顺带验证「configure + 呈现」这条链没坏。
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("webgpu");
    let canvasError = null;
    if (!ctx) {
      canvasError = "no-canvas-context";
    } else {
      try {
        ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT });
        const shown = pipelineFor(format);
        const pass2 = enc.beginRenderPass({
          colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        pass2.setPipeline(shown.pipeline);
        pass2.setBindGroup(0, shown.bind);
        pass2.setVertexBuffer(0, vbuf);
        pass2.draw(6);
        pass2.end();
      } catch (e) {
        canvasError = String((e && e.message) || e);
      }
    }

    const bytesPerRow = 256; // 8 * 4 = 32，按 256 对齐
    const readback = device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([enc.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const view = new Uint8Array(readback.getMappedRange());
    const at = (x, y) => {
      const o = y * bytesPerRow + x * 4;
      return [view[o], view[o + 1], view[o + 2], view[o + 3]];
    };
    // 取四个色块的中心（(2,2)/(6,2)/(2,6)/(6,6)）。
    const samples = [
      { name: "red", expect: [255, 0, 0, 255], got: at(2, 2) },
      { name: "green", expect: [0, 255, 0, 255], got: at(6, 2) },
      { name: "blue", expect: [0, 0, 255, 255], got: at(2, 6) },
      { name: "white", expect: [255, 255, 255, 255], got: at(6, 6) },
    ];
    readback.unmap();
    const validation = await device.popErrorScope();
    let maxDelta = 0;
    for (const s of samples) {
      for (let i = 0; i < 4; i++) maxDelta = Math.max(maxDelta, Math.abs(s.got[i] - s.expect[i]));
    }
    // 判定必须同时满足「管线没被校验拒绝」与「像素对得上」：只对容差会让
    // 「全零读回 + 一条 validation error」被误读成驱动不画。
    const ok = maxDelta <= 2 && !validation;
    return {
      result: ok ? "pass" : "fail",
      maxDelta,
      samples,
      canvasError,
      validationError: validation ? String(validation.message || validation) : null,
      clearOnly: clear,
    };
  }

  async function micro(device) {
    // 2048² 上传 4 次（16 MiB/次；同一块复用，避免把分配算进上传）。
    const px = new Uint8Array(2048 * 2048 * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 1] = 120; px[i + 2] = 60; px[i + 3] = 255; }
    const big = device.createTexture({
      size: [2048, 2048],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const t0 = performance.now();
    for (let i = 0; i < 4; i++) {
      device.queue.writeTexture({ texture: big }, px, { bytesPerRow: 2048 * 4, rowsPerImage: 2048 }, { width: 2048, height: 2048 });
    }
    await device.queue.onSubmittedWorkDone();
    const uploadMs = performance.now() - t0;

    // 空绘制 30 帧：每帧一次 clear pass，只等最后一次完成。
    const small = device.createTexture({
      size: [64, 64],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const view = small.createView();
    const t1 = performance.now();
    for (let i = 0; i < 30; i++) {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    const drawMs = performance.now() - t1;
    big.destroy();
    small.destroy();
    return {
      upload2048x4Ms: Math.round(uploadMs * 10) / 10,
      upload2048PerMs: Math.round((uploadMs / 4) * 10) / 10,
      emptyDraw30Ms: Math.round(drawMs * 10) / 10,
      emptyDrawPerFrameMs: Math.round((drawMs / 30) * 100) / 100,
    };
  }

  const REQUESTS = [
    ["core", { powerPreference: "high-performance" }],
    ["low-power", { powerPreference: "low-power" }],
    ["fallback", { forceFallbackAdapter: true }],
    ["compat", { featureLevel: "compatibility" }],
  ];

  for (const [name, opts] of REQUESTS) {
    const row = { request: name, ok: false };
    try {
      const adapter = await withTimeout(navigator.gpu.requestAdapter(opts), 800);
      if (!adapter) {
        row.ok = false;
        row.reason = "no-adapter";
      } else {
        row.ok = true;
        const i = adapter.info || {};
        row.info = {
          vendor: i.vendor || "",
          architecture: i.architecture || "",
          device: i.device || "",
          description: i.description || "",
          isFallbackAdapter: adapter.isFallbackAdapter === undefined ? null : adapter.isFallbackAdapter,
          infoIsFallbackAdapter: i.isFallbackAdapter === undefined ? null : i.isFallbackAdapter,
        };
        row.adapterMaxTexture2D = adapter.limits ? adapter.limits.maxTextureDimension2D : null;
        try {
          const device = await withTimeout(
            adapter.requestDevice({ requiredFeatures: [], requiredLimits: { maxTextureDimension2D: 4096 } }),
            800,
          );
          row.maxTextureDimension2D = device.limits.maxTextureDimension2D;
          row.maxBufferSize = device.limits.maxBufferSize;
          row.canary = await canary(device, out.preferredFormat || "bgra8unorm");
          row.micro = await micro(device);
          device.destroy();
        } catch (e) {
          row.reason = "device-error";
          row.detail = String((e && e.message) || e);
        }
      }
    } catch (e) {
      row.reason = "adapter-error";
      row.detail = String((e && e.message) || e);
    }
    out.adapters.push(row);
  }
  return out;
})()`;

/** 把探针结果排成 RFC §6.8 用的 Markdown 表（人眼可贴）。 */
function toMarkdown(result) {
  const lines = [];
  lines.push(`| 请求档 | 适配器 | 回退适配器 | maxTexture2D | canary | 2048²×4 上传 | 空绘制 30 帧 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const a of result.adapters) {
    const name = a.info
      ? [a.info.vendor, a.info.architecture, a.info.device].filter(Boolean).join(" / ") ||
        a.info.description ||
        "(无名)"
      : "—";
    const fallback =
      a.info == null ? "—" : a.info.isFallbackAdapter === null ? "—" : String(a.info.isFallbackAdapter);
    const canary = a.canary
      ? `${a.canary.result}（Δ${a.canary.maxDelta}，clear-only ${a.canary.clearOnly ? a.canary.clearOnly.result : "未测"}）`
      : a.reason ?? "未测";
    const upload = a.micro ? `${a.micro.upload2048x4Ms} ms` : "未测";
    const draw = a.micro ? `${a.micro.emptyDraw30Ms} ms（${a.micro.emptyDrawPerFrameMs} ms/帧）` : "未测";
    lines.push(
      `| ${a.request} | ${name} | ${fallback} | ${a.maxTextureDimension2D ?? "—"} | ${canary} | ${upload} | ${draw} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到 app：${EXE}\n先跑 pnpm app:build`);
    process.exit(2);
  }

  console.log(`[S0] 启动 ${EXE}`);
  const app = spawn(EXE, [], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // 让 WebView2 开一个 DevTools 端点（与 real-machine-verify.mjs 同款）。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
  let appLog = "";
  app.stdout.on("data", (d) => (appLog += d.toString()));
  app.stderr.on("data", (d) => (appLog += d.toString()));

  const cleanup = () => {
    try {
      app.kill();
    } catch {
      /* 已退出 */
    }
  };
  process.on("exit", cleanup);

  // 等 DevTools 端点起来并拿到真实页面的 ws 地址。
  const deadline = Date.now() + LAUNCH_TIMEOUT;
  let page = null;
  while (!page) {
    if (Date.now() > deadline) {
      cleanup();
      console.error(`WebView2 未在 ${LAUNCH_TIMEOUT} ms 内给出调试端点。app 日志：\n${appLog}`);
      process.exit(3);
    }
    if (app.exitCode !== null) {
      console.error(`app 已退出（code=${app.exitCode}）。日志：\n${appLog}`);
      process.exit(3);
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
    } catch {
      /* 还没起来 */
    }
    if (!page) await sleep(300);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");

  // 页面可能还在加载：等到 React 挂载完（`document.body` 有子节点）再问，纯粹为了稳定。
  for (let i = 0; i < 100; i++) {
    if (await cdp.eval("!!(document.body && document.body.children.length > 0)")) break;
    await sleep(200);
  }

  console.log("[S0] 页面已连上，开始探测…");
  const result = await cdp.eval(PROBE_SCRIPT);
  result.probedAt = new Date().toISOString();
  result.app = EXE;

  const text = JSON.stringify(result, null, 2);
  console.log("\n" + toMarkdown(result) + "\n");
  console.log(text);
  if (OUT) {
    const file = resolve(ROOT, OUT);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text + "\n", "utf8");
    console.log(`[S0] 明细已写入 ${file}`);
  }

  cdp.close();
  cleanup();
}

main().catch((e) => {
  console.error("探针失败:", e);
  process.exit(1);
});
