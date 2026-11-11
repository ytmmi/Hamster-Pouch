/**
 * S1 真机首帧探针：在**打包 app 的 WebView2** 里量"换图到首帧"的耗时。
 *
 * 为什么不在无头浏览器里量：无头 Edge 与 WebView2 的合成/解码路径不同，
 * 而 S1 的验收线（大图换图首帧 ≤ 120 ms）是给真实用户环境定的。
 *
 * 量的到底是什么（务必如实引用）：页面里没有应用模块可用（打包产物没有
 * `window` 上的模块出口），所以这里复刻 `useImageSurface` 的三步——
 * 解码 → 挂载 → 一次 `setView` → 等到下一帧画完——用的是真实 app 页里
 * **应用自己的 `.iv-image` 样式**。它量的是"媒体路径在 WebView2 里的耗时"，
 * 不是"点开图片后的端到端点击链路"（后者要真人点，见报告里的说明）。
 *
 * 工序：
 * 1. 用零依赖 PNG 编码器造两张夹具：原图 6000×4000（长边 > 4096）、LOD0 档 1280×853；
 * 2. 起一个只发这两张图的小 HTTP 服务（带 CORS，canvas2d 分支要 `createImageBitmap`）；
 * 3. 起打包 app（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`），CDP 连上；
 * 4. 页面内对 `dom` / `canvas2d` × `LOD0` / `原图` 四种组合各跑 3 次，取中位数。
 *
 * 用法：
 *   node tools/render-swap-probe.mjs [--port=9334] [--out=apps/desktop/perf/results/render-swap.json]
 * 退出码：0 跑完、2 找不到 exe、3 CDP 连不上。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng, fixtureRgba } from "./png-codec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP_DIR = join(ROOT, "apps/desktop/src-tauri/target/release/release");
const EXE = join(APP_DIR, "hamster-pouch-desktop.exe");

const argv = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, value = "true"] = raw.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const PORT = Number(argv.get("port") ?? 9334);
const IMG_PORT = PORT + 1;
const OUT = argv.get("out") ?? "apps/desktop/perf/results/render-swap.json";

const FULL = { width: 6000, height: 4000 };
const LOD0 = { width: 1280, height: 853 };
const VIEWPORT = { width: 900, height: 700 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 120000);
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
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "求值失败",
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

/** 页面内测量脚本：复刻媒路径三步，返回每种组合的样本（毫秒）。 */
const PROBE = String.raw`
(async () => {
  const VIEWPORT = { width: ${VIEWPORT.width}, height: ${VIEWPORT.height} };
  const FIXTURES = ${JSON.stringify({
    full: `http://127.0.0.1:${IMG_PORT}/full.png`,
    lod0: `http://127.0.0.1:${IMG_PORT}/lod0.png`,
  })};
  const SIZES = ${JSON.stringify({ full: FULL, lod0: LOD0 })};

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:" + VIEWPORT.width + "px;height:" +
    VIEWPORT.height + "px;overflow:hidden;background:#000";
  document.body.appendChild(host);

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const paint = async () => { await nextFrame(); await nextFrame(); };

  const decodeImg = async (url) => {
    const img = new Image();
    img.decoding = "sync";
    img.className = "iv-image";
    img.src = url;
    await img.decode();
    return img;
  };

  // dom 分支：与 surfaceDom 相同的几何写法
  async function domSwap(size, url, zoom) {
    const t0 = performance.now();
    const img = await decodeImg(url);
    const tDecode = performance.now();
    img.style.width = size.width + "px";
    img.style.height = size.height + "px";
    img.style.transform =
      "translate(calc(-50% + 0px), calc(-50% + 0px)) scale(" + zoom + ")";
    host.replaceChildren(img);
    const tMount = performance.now();
    await paint();
    const tPaint = performance.now();
    img.remove();
    return { decode: tDecode - t0, mount: tMount - tDecode, paint: tPaint - tMount, total: tPaint - t0 };
  }

  // canvas2d 分支：与 surfaceCanvas2d 相同的取图与变换
  async function canvasSwap(size, url, zoom) {
    const t0 = performance.now();
    const res = await fetch(url);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const tDecode = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = VIEWPORT.width;
    canvas.height = VIEWPORT.height;
    canvas.style.cssText = "position:absolute;left:0;top:0;display:block";
    host.replaceChildren(canvas);
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, VIEWPORT.width, VIEWPORT.height);
    ctx.imageSmoothingQuality = zoom < 1 ? "high" : "low";
    ctx.translate(VIEWPORT.width / 2, VIEWPORT.height / 2);
    ctx.scale(zoom, zoom);
    ctx.drawImage(bitmap, -size.width / 2, -size.height / 2, size.width, size.height);
    const tMount = performance.now();
    await paint();
    const tPaint = performance.now();
    bitmap.close();
    canvas.remove();
    return { decode: tDecode - t0, mount: tMount - tDecode, paint: tPaint - tMount, total: tPaint - t0 };
  }

  const SAMPLES = 3;
  const out = {};
  for (const backend of ["dom", "canvas2d"]) {
    for (const tier of ["lod0", "full"]) {
      const zoom = Math.min(VIEWPORT.width / SIZES[tier].width, VIEWPORT.height / SIZES[tier].height);
      const runs = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await paint();
        runs.push(
          backend === "dom"
            ? await domSwap(SIZES[tier], FIXTURES[tier], zoom)
            : await canvasSwap(SIZES[tier], FIXTURES[tier], zoom),
        );
      }
      out[backend + "-" + tier] = { zoom, runs };
    }
  }
  host.remove();
  return { ua: navigator.userAgent, out };
})()
`;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function toMarkdown(report) {
  const rows = [
    "| 后端 | 档位 | zoom | 解码 | 挂载 | 首帧等待 | 合计（中位数） |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [key, value] of Object.entries(report.out)) {
    const pick = (field) => median(value.runs.map((run) => run[field]));
    const [backend, tier] = key.split("-");
    rows.push(
      `| ${backend} | ${tier} | ${value.zoom.toFixed(4)} | ${pick("decode").toFixed(1)} ms | ${pick(
        "mount",
      ).toFixed(1)} ms | ${pick("paint").toFixed(1)} ms | **${pick("total").toFixed(1)} ms** |`,
    );
  }
  return rows.join("\n");
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到打包产物：${EXE}（先跑 pnpm app:build）`);
    process.exit(2);
  }

  console.log("[首帧] 生成夹具…");
  const fullPng = encodePng(FULL.width, FULL.height, fixtureRgba(FULL.width, FULL.height));
  const lod0Png = encodePng(LOD0.width, LOD0.height, fixtureRgba(LOD0.width, LOD0.height));
  const server = createServer((req, res) => {
    const body = req.url?.startsWith("/full.png") ? fullPng : req.url?.startsWith("/lod0.png") ? lod0Png : null;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": body.length,
      // canvas2d 分支用 fetch + createImageBitmap，跨源必须放开
      "access-control-allow-origin": "*",
    });
    res.end(body);
  });
  await new Promise((done) => server.listen(IMG_PORT, "127.0.0.1", done));
  console.log(`[首帧] 夹具服务 http://127.0.0.1:${IMG_PORT}（full ${Math.round(fullPng.length / 1024)} KiB）`);

  const app = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 150; i += 1) {
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) }).then(
          (r) => r.json(),
        );
        target = list.find((t) => t.type === "page");
        if (target) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(200);
    }
    if (!target) {
      console.error("[首帧] CDP 未就绪（app 可能已在运行？先关掉实例）");
      process.exit(3);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.addEventListener("open", done, { once: true });
      ws.addEventListener("error", fail, { once: true });
    });
    cdp = new Cdp(ws);

    for (let i = 0; i < 100; i += 1) {
      const ready = await cdp.eval("document.body && document.body.children.length > 0");
      if (ready) break;
      await sleep(200);
    }

    const report = await cdp.eval(PROBE);
    console.log(`\n[首帧] WebView2 · ${report.ua}\n`);
    console.log(toMarkdown(report));
    console.log(`\n机型：视口 ${VIEWPORT.width}×${VIEWPORT.height}，原图 ${FULL.width}×${FULL.height}，LOD0 ${LOD0.width}×${LOD0.height}`);

    const payload = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      full: FULL,
      lod0: LOD0,
      ua: report.ua,
      results: report.out,
    };
    const outPath = resolve(ROOT, OUT);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`结果已写入 ${OUT}`);
  } finally {
    cdp?.close();
    app.kill();
    server.close();
  }
}

main().catch((error) => {
  console.error(`首帧探针失败：${error?.message ?? error}`);
  process.exit(1);
});
