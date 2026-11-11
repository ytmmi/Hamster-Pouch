/**
 * 视觉一致性门禁：`dom` vs `canvas2d`（RFC 0013 §11）。
 *
 * 做法：用 `tsc` CLI（TypeScript 7 原生版没有 `transpileModule` 之类的 JS API）把 `tools/render-harness.ts` 及其依赖编成模块图，
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng, fixtureRgba, ssim, toGray } from "./png-codec.mjs";
import {
  compileGraph,
  connectCdp,
  sleep,
  startStaticServer,
  waitFor,
} from "./lib/render-bundle.mjs";

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
      void server?.close();
    } catch {
      /* 已关闭 */
    }
  };
  process.on("exit", cleanup);

  try {
    const graph = await compileGraph(join(HERE, "render-harness.ts"), { root: ROOT, desktop: DESKTOP });
    const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style>
</head><body><script type="module" src="/m/${graph.entryId}"></script></body></html>`;
    server = await startStaticServer({ port: PORT, graph, html });
    const pageUrl = `http://127.0.0.1:${PORT}/harness.html`;
    console.log(`[视觉] 夹具模块 ${graph.modules.size} 个 · ${pageUrl}`);
    edge = await startEdge(edgePath, pageUrl);
    console.log(`[视觉] Edge ${edgePath} · ${edge.wsUrl}`);
    cdp = await connectCdp(edge.wsUrl);
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
