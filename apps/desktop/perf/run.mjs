/**
 * 性能夹具的 **CDP 驱动**：起 Vite 服务 → 用 Chromium 打开 → 量指标 → 输出 JSON。
 *
 * ## 为什么不装 playwright
 *
 * 本机 `ms-playwright` 缓存里**已有** Chromium 可执行文件，Node 自带 `fetch` 与
 * `WebSocket`，因此直接说 DevTools 协议即可，不必新增依赖（D20：依赖本地化，
 * 少一条依赖就少一处构建链漂移）。
 *
 * ## 量什么（对应缺陷 0018 §3.3 的验证空白）
 *
 * | 指标 | 为什么是它 |
 * | --- | --- |
 * | `cells` | **本条的核心**：DOM 单元数。虚拟化的全部意义就是让它与条目总数脱钩 |
 * | `domNodes` | 面板内节点总数（含行容器、工具条），反映真实 DOM 成本 |
 * | `layoutMs` | 强制同步布局的耗时——"布局对象还在不在"的直接代价 |
 * | `scrollFrames` | 滚动期间的长帧（>50ms）与总时长，量"滚得顺不顺" |
 * | `drainMs` | 后台翻完全库的墙钟耗时 |
 *
 * ## 用法
 *
 * ```bash
 * node apps/desktop/perf/run.mjs --n=50000 --view=adaptive --scenario=scroll
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const ROOT = resolve(DESKTOP, "..", "..");
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- 参数

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}
const N = Number(args.get("n") ?? 50000);
const PAGE = Number(args.get("page") ?? 500);
const DELAY = Number(args.get("delay") ?? 0);
const VIEW = args.get("view") ?? "adaptive";
const MODE = args.get("mode") ?? "thumb";
const SCENARIO = args.get("scenario") ?? "static";
const IMAGE_SIZE = Number(args.get("size") ?? 160);
const SETTLE_MS = Number(args.get("settle") ?? 1200);
const OUT = args.get("out") ?? null;
const HEADFUL = args.get("headful") === "true";

// ------------------------------------------------------- Chromium 定位

/** 在 `ms-playwright` 缓存里找一个可用的 Chromium。 */
function findChromium() {
  const explicit = process.env.HP_PERF_CHROME;
  if (explicit && existsSync(explicit)) return explicit;
  const cache = join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    "AppData",
    "Local",
    "ms-playwright",
  );
  if (!existsSync(cache)) return null;
  // 优先 headless shell（更轻），其次完整 Chromium。
  const candidates = [
    join(cache, "chromium_headless_shell-1234", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    join(cache, "chromium-1234", "chrome-win64", "chrome.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ------------------------------------------------------------- CDP 客户端

/** 极简 CDP 客户端：一个 WebSocket、自增 id、按 id 回收 Promise。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 120000);
    });
  }

  /** 求值一个表达式并返回 JSON 值（异常会带上页面里的 message）。 */
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const text =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        "页面求值失败";
      throw new Error(text);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到表达式为真（或超时）。 */
async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await cdp.eval(expression);
    if (ok) return true;
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）: ${expression}`);
    await sleep(100);
  }
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const chrome = findChromium();
  if (!chrome) {
    console.error(
      "找不到 Chromium。设置 HP_PERF_CHROME=<chrome.exe 路径>，或安装 playwright 的浏览器缓存。",
    );
    process.exit(2);
  }

  // 1) 起 Vite（夹具服务）。用 --port 覆盖，保证与 config 一致。
  const viteBin = join(DESKTOP, "node_modules", "vite", "bin", "vite.js");
  const vite = spawn(
    process.execPath,
    [viteBin, "--config", join(HERE, "vite.perf.config.ts"), "--port", String(PORT), "--strictPort"],
    { cwd: DESKTOP, stdio: ["ignore", "pipe", "pipe"] },
  );
  let viteLog = "";
  vite.stdout.on("data", (d) => (viteLog += d.toString()));
  vite.stderr.on("data", (d) => (viteLog += d.toString()));

  const cleanup = () => {
    try {
      vite.kill();
    } catch {
      /* 已退出 */
    }
  };
  process.on("exit", cleanup);

  // 等服务就绪（轮询 HTTP，不靠日志文案）。
  const url = `${BASE}/perf/index.html?n=${N}&page=${PAGE}&delay=${DELAY}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/perf/index.html`);
      if (res.ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      cleanup();
      console.error("Vite 未在 60s 内就绪。日志：\n" + viteLog);
      process.exit(3);
    }
    await sleep(250);
  }

  // 2) 起 Chromium（远程调试端口 0 → 由浏览器选一个，读 stderr 里的实际端口）。
  const profile = join(HERE, ".chrome-profile");
  mkdirSync(profile, { recursive: true });
  const chromeArgs = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // 固定窗口尺寸：布局指标必须可比。
    "--window-size=1600,1000",
    "about:blank",
  ];
  if (!HEADFUL) chromeArgs.unshift("--headless=new");

  const browser = spawn(chrome, chromeArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let browserErr = "";
  let wsUrl = null;
  browser.stderr.on("data", (d) => {
    const text = d.toString();
    browserErr += text;
    const m = /ws:\/\/[^\s]+/.exec(text);
    if (m && !wsUrl) wsUrl = m[0];
  });

  const browserDeadline = Date.now() + 30000;
  while (!wsUrl) {
    if (Date.now() > browserDeadline) {
      cleanup();
      browser.kill();
      console.error("Chromium 未给出调试地址。stderr：\n" + browserErr);
      process.exit(4);
    }
    await sleep(200);
  }

  // 3) 建一个页面并连上它的 CDP。
  const { webSocketDebuggerUrl } = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("没有可用的页面目标");
    return page;
  })();

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 4) 打开夹具。
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, "typeof window.__perf === 'object'", 60000, "夹具加载");

  // 5) 切到目标视图/模式（走真实设置写入路径）。
  if (MODE === "name") {
    await cdp.eval("window.__perf.setMode('name')");
  } else {
    await cdp.eval(`window.__perf.setImageSize(${IMAGE_SIZE})`);
    await cdp.eval(`window.__perf.setView(${JSON.stringify(VIEW)})`);
  }

  // 6) 等首屏稳定（第一页到手并渲染完）。
  await waitFor(cdp, "window.__perf.cellCount() > 0", 30000, "首屏渲染");
  await sleep(SETTLE_MS);

  const result = {
    config: { n: N, page: PAGE, delay: DELAY, view: VIEW, mode: MODE, scenario: SCENARIO, imageSize: IMAGE_SIZE },
    firstPaint: null,
    drained: null,
    scroll: null,
    errors: [],
  };

  result.firstPaint = await cdp.eval(`(() => {
    const p = window.__perf;
    return {
      cells: p.cellCount(),
      rows: p.rowCount(),
      domNodes: p.domNodes(),
      layoutMs: p.layoutCost(),
      contentHeight: p.contentHeight(),
      paging: p.paging,
      statuses: p.statuses.slice(),
    };
  })()`);

  // 7) 等后台翻完（若 delay=0 且条目不多，通常已经翻完）。
  const drainStart = Date.now();
  await waitFor(cdp, "window.__perf.paging.drained === true", 300000, "全库翻完");
  result.drained = {
    ms: Date.now() - drainStart,
    paging: await cdp.eval("window.__perf.paging"),
  };

  // 8) 翻完后再量一次（此时条目总数才是全库）。
  await sleep(SETTLE_MS);
  result.afterDrain = await cdp.eval(`(() => {
    const p = window.__perf;
    return {
      cells: p.cellCount(),
      rows: p.rowCount(),
      domNodes: p.domNodes(),
      layoutMs: p.layoutCost(),
      contentHeight: p.contentHeight(),
      masonryTotal: p.masonryTotalCheck(),
      paging: p.paging,
    };
  })()`);

  // 9) 滚动场景：量长帧与总时长。
  if (SCENARIO === "scroll") {
    result.scroll = await cdp.eval(`(async () => {
      const p = window.__perf;
      const el = p.scroller();
      if (!el) return { error: '找不到滚动容器' };
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      // 从顶滚到底：20 步，每步等两帧，模拟真实滚动。
      let maxOffsetDelta = 0;
      let worstOffset = null;
      let maxColumnDelta = 0;
      // 内容高度漂移：宽高比是**边滚边解码**的，估算高度随之修正 → 滚动条长度会变。
      // 这是"估计占位"方案的固有代价，必须量出来（而不是声称不存在）。
      const heightStart = p.contentHeight();
      let heightMaxDrift = 0;
      let diag = null;
      let minGap = Infinity;
      let maxGap = -Infinity;
      let maxHeightDelta = 0;
      let maxPending = 0;
      let worstCell = null;
      for (let i = 0; i <= 20; i++) {
        p.scrollToFraction(i / 20);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // **滚到每一处都核对偏移**：虚拟化的错位只在滚动中出现。
        const f = p.offsetFidelity();
        if (f.maxDelta > maxOffsetDelta) {
          maxOffsetDelta = f.maxDelta;
          worstOffset = f.worst;
        }
        for (const c of p.columnFidelity()) {
          if (c.delta > maxColumnDelta) maxColumnDelta = c.delta;
        }
        // 高度猜错不会体现在偏移上（绝对定位），只会改变**相邻单元的视觉间距**
        // ——预期恰好是 MEDIA_MASONRY_GAP（8px）。必须单独量。
        const h = p.cellHeightFidelity();
        if (h.minGap !== null && h.minGap < minGap) minGap = h.minGap;
        if (h.maxGap !== null && h.maxGap > maxGap) maxGap = h.maxGap;
        if (h.maxHeightDelta > maxHeightDelta) maxHeightDelta = h.maxHeightDelta;
        maxPending = Math.max(maxPending, h.pending);
        if (h.worst) worstCell = h.worst;
        heightMaxDrift = Math.max(heightMaxDrift, Math.abs(p.contentHeight() - heightStart));
        if (i === 10) diag = p.cellDiagnostics();
      }
      const totalMs = performance.now() - t0;
      running = false;
      const sorted = frames.slice().sort((a, b) => a - b);
      const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;

      // **稳定态**复测：宽高比是边滚边解码的，解码写入与面板重算偏移之间有一个极短的
      // 窗口（单元已经变高、偏移还是旧的）。第一轮的极值会把这种**瞬态**也算进去。
      // 等解码静默后再扫一遍，才回答"稳态下到底有没有错位"。
      await new Promise((r) => setTimeout(r, 2500));
      let stableMinGap = Infinity, stableMaxGap = -Infinity, stableMaxOffset = 0;
      let stableWorst = null, stableDecodedPairs = 0, stableMaxHeightDelta = 0;
      for (let i = 0; i <= 20; i++) {
        p.scrollToFraction(i / 20);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const f = p.offsetFidelity();
        if (f.maxDelta > stableMaxOffset) stableMaxOffset = f.maxDelta;
        const h = p.cellHeightFidelity();
        if (h.minGap !== null && h.minGap < stableMinGap) stableMinGap = h.minGap;
        if (h.maxGap !== null && h.maxGap > stableMaxGap) stableMaxGap = h.maxGap;
        stableDecodedPairs = h.decodedPairs;
        stableMaxHeightDelta = Math.max(stableMaxHeightDelta, h.maxHeightDelta);
        if (h.worst) stableWorst = h.worst;
      }

      return {
        totalMs,
        frames: frames.length,
        p50: pct(0.5),
        p95: pct(0.95),
        max: sorted.length ? sorted[sorted.length - 1] : 0,
        longFrames: frames.filter((f) => f > 50).length,
        cellsDuringScroll: p.cellCount(),
        domNodesDuringScroll: p.domNodes(),
        // 虚拟化正确性：预测偏移与实际布局的最大偏差（px），以及列高的最大偏差。
        maxOffsetDelta,
        worstOffset,
        maxColumnDelta,
        minGap: Number.isFinite(minGap) ? minGap : null,
        maxGap: Number.isFinite(maxGap) ? maxGap : null,
        maxHeightDelta,
        maxPending,
        worstCell,
        // 稳定态（等解码静默后复扫）：这才是"布局是否正确"的判据；
        // 上面那对极值含"边滚边解码"的瞬态。
        stableMinGap: Number.isFinite(stableMinGap) ? stableMinGap : null,
        stableMaxGap: Number.isFinite(stableMaxGap) ? stableMaxGap : null,
        stableMaxOffsetDelta: stableMaxOffset,
        stableDecodedPairs,
        stableMaxHeightDelta,
        stableWorst,
        heightStart,
        heightEnd: p.contentHeight(),
        heightMaxDrift,
        diag,
      };
    })()`);
  }

  // 10) 收集页面错误（面板把失败写进 status，这里一并取回）。
  result.errors = await cdp.eval("window.__perf.statuses.slice()");

  cdp.close();
  browser.kill();
  cleanup();

  const text = JSON.stringify(result, null, 2);
  if (OUT) {
    mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, OUT), text, "utf8");
  }
  console.log(text);
}

main().catch((e) => {
  console.error("驱动失败:", e);
  process.exit(1);
});
