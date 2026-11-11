/**
 * 视觉一致性门禁：`dom` vs `canvas2d`（RFC 0013 §11）。
 *
 * 做法：用 TypeScript 的 `transpileModule` 把 `tools/render-harness.ts` 及其依赖编成模块图，
 * 用一个极小静态服务发出去（**不用 Vite**：本机 Vite dev server 会占着端口不回话，把门禁挂死）
 * → 用 **headless Edge**（`--headless=new`，**不加** `--disable-gpu`）在同一张图、同一个窗口下
 * 分别截图 → 在 Node 侧算 SSIM。
 *
 * 断言：
 * 1. fit / 1:1 / 4× 三档 SSIM ≥ 0.99；
 * 2. 1:1 时把 canvas2d 截图平移 ±1 px 后 SSIM 必须**变差**——即对齐位置就是 0 偏移
 *    （直接量"边缘坐标"会被抗锯齿干扰，用"平移后更差"表达同一件事更稳）。
 *
 * 环境限制（不是漏测）：无头环境**没有 WebGPU**，所以 WebGPU 的正确性只在真机上验
 * （`tools/render-probe.mjs` 与 `apps/desktop/perf/run.mjs`）；这里只验几何与降级链末两档
 * 的像素一致性。
 *
 * 用法：
 *   node tools/viewer-render-verify.mjs             # 默认端口 5199
 *   node tools/viewer-render-verify.mjs --keep      # 保留截图到 apps/desktop/perf/results
 *   node tools/viewer-render-verify.mjs --edge=...  # 换浏览器
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng, fixtureRgba, ssim, toGray } from "./png-codec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DESKTOP = join(ROOT, "apps/desktop");
const RESULTS = join(DESKTOP, "perf/results");

const argv = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, value = "true"] = raw.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const PORT = Number(argv.get("port") ?? 5199);
const KEEP = argv.has("keep");
const OUT = argv.get("out") ?? null;
const SSIM_FLOOR = 0.99;

/** 夹具图：1280×800。宽高比刻意不等于 4:3（宿主是 640×480），fit 档才有留白可验居中。 */
const IMAGE = { width: 1280, height: 800 };
const HOST = { width: 640, height: 480 };

const CASES = [
  { name: "fit", zoom: Math.min(HOST.width / IMAGE.width, HOST.height / IMAGE.height) },
  { name: "1:1", zoom: 1 },
  { name: "4x", zoom: 4 },
];

const EDGE_CANDIDATES = [
  process.env.HP_VERIFY_EDGE,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 60000);
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

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdp.eval(expression)) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）`);
    await sleep(200);
  }
}

/** 端口上有没有东西在监听（不管它回不回话）。 */
function portInUse(port) {
  return new Promise((resolvePort) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolvePort(value);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function toUrlPath(file) {
  return file.split(sep).join("/");
}

/**
 * 把入口 TS 及其相对依赖编成「URL → JS 源码」的图。
 *
 * 用 `tsc` 而不是打包器：门禁只服务 4 个小模块，不该再拖一个构建栈进来。
 * 注意仓库用的是 TypeScript 7（原生实现），**没有** `transpileModule` 这类 JS API，
 * 所以只能走 CLI + 临时 tsconfig。
 */
async function compileGraph(entry) {
  const tscBin = join(DESKTOP, "node_modules/typescript/bin/tsc");
  if (!existsSync(tscBin)) throw new Error(`找不到 tsc：${tscBin}`);
  const outDir = mkdtempSync(join(tmpdir(), "hp-render-build-"));

  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      types: [],
      strict: true,
      skipLibCheck: true,
      noEmitOnError: false,
      declaration: false,
      sourceMap: false,
      rootDir: ROOT,
      outDir,
    },
    files: [entry],
  };
  const configPath = join(outDir, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  const build = spawn(process.execPath, [tscBin, "-p", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  build.stdout.on("data", (d) => (output += d.toString()));
  build.stderr.on("data", (d) => (output += d.toString()));
  const code = await new Promise((done) => build.on("exit", (c) => done(c)));
  const emitted = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js") && full !== configPath) emitted.push(full);
    }
  };
  walk(outDir);
  if (code !== 0 && emitted.length === 0) throw new Error(`tsc 未产出任何文件：\n${output}`);

  const modules = new Map();
  for (const file of emitted) {
    const url = toUrlPath(relative(outDir, file));
    // tsc 保留无扩展名的相对说明符，浏览器必须拿到完整 URL
    const body = readFileSync(file, "utf8").replace(
      /(\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']*?)(\2)/g,
      (match, head, quote, specifier, close) =>
        specifier.endsWith(".js") ? match : `${head}${quote}${specifier}.js${close}`,
    );
    modules.set(url, body);
  }
  const entryId = toUrlPath(relative(ROOT, entry).replace(/\.tsx?$/, ".js"));
  if (!modules.has(entryId)) throw new Error(`入口模块未编出：${entryId}`);
  return { entryId, modules, outDir, output };
}

/** 一个只发内存里那几张 JS + 一张 HTML 的静态服务。 */
async function startServer(graph) {
  if (await portInUse(PORT)) {
    throw new Error(`端口 ${PORT} 已被占用。先结束该进程，或用 --port=<其它端口>。`);
  }
  const stylesPath = join(DESKTOP, "src/app_ui/shared/styles.css");
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style>
</head><body><script type="module" src="/m/${graph.entryId}"></script></body></html>`;

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/" || path === "/harness.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    // `dom` 后端的定位（`.iv-image` 的 `left/top:50%`）来自应用自己的样式表，
    // 夹具页必须带上它，否则比的不是真实渲染路径。
    if (path === "/styles.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(readFileSync(stylesPath));
      return;
    }
    const name = /^\/m\/([\w./-]+\.js)$/.exec(path)?.[1];
    const body = name ? graph.modules.get(name) : undefined;
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(body);
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(PORT, "127.0.0.1", done);
  });
  return { server, url: `http://127.0.0.1:${PORT}/harness.html` };
}

/** 起 headless Edge 并直接打开夹具页；`--remote-debugging-port=0` 由浏览器选端口，从 stderr 读回。 */
async function startEdge(edgePath, pageUrl) {
  const profile = mkdtempSync(join(tmpdir(), "hp-render-verify-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${HOST.width + 80},${HOST.height + 120}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // 注意：**不加** `--disable-gpu`（RFC §11）。加了就变成"软件合成的 canvas2d"，
    // 与真实用户路径不是同一件事。
    pageUrl,
  ];
  const child = spawn(edgePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  const browserWs = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Edge 未在 30s 内给出调试端点：\n${err}`)), 30000);
    child.stderr.on("data", (d) => {
      err += d.toString();
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Edge 退出（${code}）：\n${err}`));
    });
  });

  // 从浏览器端点换成**页面**端点：`Page.*` 只对 page target 有效。
  const port = /:(\d+)\//.exec(browserWs)?.[1];
  if (!port) throw new Error(`无法从 ${browserWs} 解析调试端口`);
  for (let i = 0; i < 100; i += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .catch(() => []);
    const page = targets.find((t) => t.type === "page" && String(t.url).includes("harness.html"));
    if (page?.webSocketDebuggerUrl) return { child, profile, wsUrl: page.webSocketDebuggerUrl };
    await sleep(200);
  }
  throw new Error(`Edge 未在 20s 内给出夹具页 target：\n${err}`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  // 没有超时的 open 等待会静默挂死（Edge 已给出端点但 socket 建不起来时），
  // 门禁宁可在 15s 后报错，也不该让 CI 卡到天亮。
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP socket 15s 未打开：${wsUrl}`)), 15000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        res();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (ev) => {
        clearTimeout(timer);
        rej(new Error(`CDP socket 出错：${ev?.message ?? wsUrl}`));
      },
      { once: true },
    );
  });
  return new Cdp(ws);
}

async function screenshot(cdp, clip) {
  const res = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { ...clip, scale: 1 },
  });
  return Buffer.from(res.data, "base64");
}

async function main() {
  const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edgePath) {
    console.error("找不到 Edge（可用 HP_VERIFY_EDGE 指定 msedge.exe 路径）");
    process.exit(2);
  }

  const fixture = encodePng(IMAGE.width, IMAGE.height, fixtureRgba(IMAGE.width, IMAGE.height));
  const dataUrl = `data:image/png;base64,${fixture.toString("base64")}`;
  console.log(`[视觉] 夹具 ${IMAGE.width}×${IMAGE.height}（${Math.round(fixture.length / 1024)} KiB）`);

  let server = null;
  let edge = null;
  let cdp = null;
  const results = [];

  const cleanup = () => {
    try {
      cdp?.close();
    } catch {
      /* 已关闭 */
    }
    try {
      edge?.child.kill();
    } catch {
      /* 已退出 */
    }
    try {
      server?.close();
    } catch {
      /* 已关闭 */
    }
  };
  process.on("exit", cleanup);

  try {
    const graph = await compileGraph(join(HERE, "render-harness.ts"));
    server = await startServer(graph);
    console.log(`[视觉] 夹具模块 ${graph.modules.size} 个 · ${server.url}`);
    edge = await startEdge(edgePath, server.url);
    console.log(`[视觉] Edge ${edgePath} · ${edge.wsUrl}`);
    cdp = await connect(edge.wsUrl);
    console.log("[视觉] CDP 已连接");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await waitFor(cdp, "document.readyState === 'complete' && !!window.__renderHarness", 60000, "夹具页就绪");

    for (const testCase of CASES) {
      const shots = {};
      for (const backend of ["dom", "canvas2d"]) {
        const shown = await cdp.eval(
          `window.__renderHarness.show(${JSON.stringify({
            backend,
            url: dataUrl,
            width: IMAGE.width,
            height: IMAGE.height,
            zoom: testCase.zoom,
          })})`,
        );
        if (!shown?.ok) {
          results.push({
            case: testCase.name,
            backend,
            ok: false,
            detail: `表面报错：${JSON.stringify(shown?.error ?? null)}`,
          });
          continue;
        }
        const png = await screenshot(cdp, shown.rect);
        shots[backend] = { png, rect: shown.rect, stats: shown.stats };
        if (KEEP) {
          mkdirSync(RESULTS, { recursive: true });
          writeFileSync(join(RESULTS, `render-verify-${testCase.name}-${backend}.png`), png);
        }
      }

      const dom = shots.dom && toGray(decodePng(shots.dom.png));
      const canvas = shots.canvas2d && toGray(decodePng(shots.canvas2d.png));
      if (!dom || !canvas) {
        results.push({ case: testCase.name, ok: false, detail: "缺少一侧截图" });
        continue;
      }
      if (dom.width !== canvas.width || dom.height !== canvas.height) {
        results.push({
          case: testCase.name,
          ok: false,
          detail: `截图尺寸不一致 ${dom.width}×${dom.height} vs ${canvas.width}×${canvas.height}`,
        });
        continue;
      }

      const value = ssim(dom, canvas);
      const row = {
        case: testCase.name,
        zoom: Number(testCase.zoom.toFixed(4)),
        size: `${dom.width}×${dom.height}`,
        domBackend: shots.dom.stats.backend,
        canvasBackend: shots.canvas2d.stats.backend,
        canvasUploads: shots.canvas2d.stats.uploads,
        ssim: Number(value.toFixed(5)),
        ok: value >= SSIM_FLOOR,
        detail: `SSIM ${value.toFixed(5)}（下限 ${SSIM_FLOOR}）`,
      };

      // 1:1 的偏移检查：对齐位置必须是"最好的那一个"。
      if (testCase.name === "1:1") {
        let best = { dx: 0, dy: 0, value: -Infinity };
        for (const dy of [-1, 0, 1]) {
          for (const dx of [-1, 0, 1]) {
            const shifted = ssim(dom, canvas, dx, dy);
            if (shifted > best.value) best = { dx, dy, value: shifted };
          }
        }
        row.alignedShift = { dx: best.dx, dy: best.dy };
        row.ok = row.ok && best.dx === 0 && best.dy === 0;
        row.detail += `，最佳平移 (${best.dx},${best.dy})`;
      }
      results.push(row);
    }
  } finally {
    cleanup();
    // Vite 会留下监听端口；等子进程真正退出再删临时 profile（Edge 的锁文件）。
    await sleep(500);
    if (edge?.profile && !KEEP) {
      try {
        rmSync(edge.profile, { recursive: true, force: true });
      } catch {
        /* 文件仍被占用，下次启动会新建 */
      }
    }
  }

  console.log("\n| 档位 | zoom | 截图 | dom | canvas2d | 上传 | SSIM | 结果 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of results) {
    console.log(
      `| ${row.case} | ${row.zoom ?? "—"} | ${row.size ?? "—"} | ${row.domBackend ?? "—"} | ${
        row.canvasBackend ?? "—"
      } | ${row.canvasUploads ?? "—"} | ${row.ssim ?? "—"} | ${row.ok ? "PASS" : "FAIL"} |`,
    );
  }
  for (const row of results.filter((r) => !r.ok)) console.log(`FAIL  ${row.case} — ${row.detail}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);

  if (OUT) {
    writeFileSync(
      resolve(ROOT, OUT),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), image: IMAGE, host: HOST, results },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`结果已写入 ${OUT}`);
  }

  process.exit(passed === results.length && results.length === CASES.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`视觉门禁失败：${error?.message ?? error}`);
  process.exit(3);
});
