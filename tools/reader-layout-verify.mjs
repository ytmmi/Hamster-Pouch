/**
 * 图书阅读器**纸张布局真机验证**（无头 Edge + 真实 `styles.css`）。
 *
 * ## 为什么必须真机量，而不是只靠纯函数断言
 *
 * 本轮（D116）改的是**CSS 布局**：纸张居中、双页相贴、纸页与正文栏对齐、
 * 卡片跟随面板自适应。这些量的正确性取决于**浏览器真实的分栏与盒模型**——
 * 纯函数只能算出"应该多宽"，而"浏览器实际排出来是不是这么宽"只有量了才知道
 * （项目已记过同类教训：缺陷 0027 的几何口径与真实绘制不一致）。
 *
 * ## 怎么量
 *
 * 无头 Edge 直接加载本仓库**真实的** `apps/desktop/src/app_ui/shared/styles.css`，
 * 再按 `ReaderStage` 的 DOM 结构拼一份同构静态夹具（`.br-stage` → `.br-paper` →
 * `.br-face-layer` → `.br-flow` → `.br-content`），用 `getBoundingClientRect`
 * 逐项量出几何。**夹具同构**是前提：结构与类名必须与组件逐字一致，
 * 否则量的是另一个页面（本文件底部的 `assertStructure` 会核对关键类名）。
 *
 * 用法：
 * ```bash
 * node tools/reader-layout-verify.mjs
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 极简 CDP 客户端（与 `tools/real-machine-verify.mjs` 同款，不新增依赖）。 */
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

/**
 * 夹具 HTML：**真实 styles.css** + 与 `ReaderStage` 同构的 DOM。
 *
 * 页面宽高由外部用 CDP 设成目标面板尺寸（`Emulation.setDeviceMetricsOverride`），
 * 因此"面板变宽 ⇒ 纸张变宽"这条可以直接量。
 */
function fixtureHtml(theme) {
  // 注意：本模板内**不得出现反引号**——它会提前终止 JS 模板字符串
  // （第一次写就踩了这个坑：CSS 注释里包了一个类名，于是整段被解析成 JS）。
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="styles.css">
<style>
  html, body { margin: 0; padding: 0; }
  /* br-root 是面板根（flex 列）；这里只放阅读区，以便整页就是"面板主体"。 */
  body { display: flex; }
  .br-root { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .br-body { flex: 1; min-height: 0; position: relative; display: flex; align-items: stretch; }
</style>
</head>
<body class="app-root ${theme}">
  <div class="br-root">
    <div class="br-body">
      <div id="stage" class="br-stage br-stage-paged br-bg-paper br-text-auto br-font-system br-align-default" tabindex="0">
        <div class="br-paper">
          <div class="br-face-layer" aria-hidden="true">
            <div class="br-face"></div>
            <div class="br-face"></div>
          </div>
          <div class="br-flow" id="flow">
            <div class="vr-content br-content">
              <div class="br-page" data-page-index="0"><p class="vr-text">${"正文段落。".repeat(400)}</p></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
}

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    console.error("找不到 Edge，无法做真机布局验证");
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), "hp-reader-verify-"));
  const profile = join(work, "profile");
  // 真实样式表：直接复制本仓库的 `styles.css`（不是另写一份——那样量的是另一个页面）。
  const stylesSource = readFileSync(
    join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
    "utf8",
  );
  writeFileSync(join(work, "styles.css"), stylesSource);
  writeFileSync(join(work, "dark.html"), fixtureHtml("theme-dark"), "utf8");
  writeFileSync(join(work, "light.html"), fixtureHtml(""), "utf8");

  const PORT = 9331;
  const proc = spawn(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      /* 已退出 */
    }
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  };
  process.on("exit", cleanup);

  // 等 CDP 端点就绪。
  let ws_url = null;
  const deadline = Date.now() + 40000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) {
        ws_url = t.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      cleanup();
      console.error("无头 Edge 未在 40s 内给出调试端点");
      process.exit(3);
    }
    await sleep(200);
  }

  const ws = new WebSocket(ws_url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  /**
   * 量一组尺寸：把视口设成"面板主体"大小，再按给定设置写 CSS 变量。
   *
   * 几何数值**与 `readerView.ts` 的 `readerPagedLayout` 一致地重算**——
   * 但这里刻意**手动写一遍**（不复用 TS 函数）：验证的意义正是"独立的第二套算法
   * 与浏览器实际排出来的结果是否相符"。若两边都来自同一个函数，就只是在自证。
   *
   * 参数经 `JSON.stringify` 注入（**不做模板插值**）：插值会把算式写进模板字符串，
   * 可读性差且极易被 `${` 咬到——这里只把参数对象传进去，算式留在浏览器侧。
   */
  async function measure({
    width,
    height,
    theme = "light",
    columns = 2,
    simulated = true,
    pageWidthPercent = 100,
    pageMargin = 24,
    fullscreen = false,
  }) {
    const file = theme === "dark" ? "dark.html" : "light.html";
    await cdp.send("Page.navigate", { url: `file:///${join(work, file).replace(/\\/g, "/")}` });
    await sleep(400);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(120);
    return await cdp.eval(`(() => {
      const PARAMS = ${JSON.stringify({ columns, simulated, pageWidthPercent, pageMargin, fullscreen })};
      const stage = document.getElementById('stage');
      const paper = stage.querySelector('.br-paper');
      const layer = stage.querySelector('.br-face-layer');
      const flow = document.getElementById('flow');
      const content = flow.querySelector('.br-content');

      // 与面板侧同一口径：可用宽 / 高 = 内容区（扣掉**桌面留白**内边距）。
      //
      // **顺序要紧**：纵向桌面留白（--br-desk-y）在全屏时为 0，而它正是
      // .br-stage 的 padding——必须先把它设好、再读 clientHeight。
      // 先读后设会读到**旧内边距**下的高度（初始量出来是 16px 的差，
      // 与真实组件的行为不符：组件那边 ResizeObserver 会在类生效后重测）。
      const setVars = (obj) => { for (const [k, v] of Object.entries(obj)) stage.style.setProperty(k, v); };
      // 纵向桌面留白与 ReaderStage 同一算式：全屏 0 / 窗口 8。
      setVars({ '--br-desk-y': PARAMS.fullscreen ? '0px' : '8px' });
      void stage.clientHeight; // 强制同步布局，让新 padding 生效后再量。
      const cs = getComputedStyle(stage);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const availW = stage.clientWidth - padX;
      const availH = stage.clientHeight - padY;

      /*
       * 与 ReaderStage 的 style 逐项对应（数值由下面**独立的算术**给出）。
       *
       * 独立重算这几条：纸宽 = 可用宽 × 百分比；页边距按**每张纸至少留够一栏**夹紧；
       * 正文宽 = 纸宽 - 2×页边距；栏间距 = 2×页边距（书脊缝）；
       * 纸页宽 = 纸宽 / 栏数（等分铺满）。
       */
      const cols = PARAMS.columns;
      const paperW = Math.floor(Math.min(availW, (availW * PARAMS.pageWidthPercent) / 100));
      // 夹紧上限 = (faceWidth - 48)/2（由恒等式 columnWidth = faceWidth - 2·margin 解出）。
      const marginLimit = Math.max(0, (paperW / cols - 48) / 2);
      const margin = Math.max(0, Math.min(PARAMS.pageMargin, marginLimit));
      const contentW = Math.max(1, paperW - margin * 2);
      const gap = margin * 2;
      setVars({
        '--br-page-margin': margin + 'px',
        '--br-desk-x': '8px',
        '--br-columns': String(cols),
        '--br-column-gap': gap + 'px',
        '--br-spine': '12px',
        '--br-paper-w': paperW + 'px',
        '--br-paper-h': Math.max(1, Math.floor(availH)) + 'px',
        '--br-face-w': (paperW / cols) + 'px',
        '--br-para-indent': '2em',
      });
      stage.classList.toggle('br-simulated', PARAMS.simulated);
      stage.classList.toggle('br-spread', cols === 2);
      // 双页时纸页层要有两张，单页一张。
      layer.innerHTML = '';
      for (let i = 0; i < cols; i++) {
        const f = document.createElement('div');
        f.className = 'br-face';
        layer.appendChild(f);
      }

      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
      const faces = Array.from(layer.querySelectorAll('.br-face')).map(r);
      const stageR = r(stage);
      const paperR = r(paper);
      const flowR = r(flow);
      const contentR = r(content);

      /*
       * 正文的**真实栏几何**——不用 getComputedStyle。
       *
       * getComputedStyle(content).columnWidth 在 column-count 布局下返回的是
       * **"auto"**（那是**指定值**，不是**used value**）。而本轮最需要验证的恰恰是
       * "浏览器真的把宽度等分了、且栏与纸页对齐"。
       *
       * 因此改用**文本行的绘制矩形**：getClientRects() 对块级元素按**行盒**返回矩形，
       * 多栏排版下同一栏的各行 x 相同、不同栏的 x 递增。于是：
       * - **栏起点** = 按 x 去重后的不同值（容差 2px，避免亚像素抖动拆成两组）；
       * - **栏宽** = 该栏里**最宽的行**（两端对齐时每行都等于栏宽；栏末行较短，
       *   取 max 才不会被末行带偏）。
       * 这就是浏览器实际排出来的栏边界，与面板侧的算术相互独立。
       */
      const text = content.querySelector('.vr-text');
      const lineRects = text
        ? Array.from(text.getClientRects()).filter((b) => b.width > 1)
        : [];
      const colStarts = [];
      for (const b of lineRects) {
        if (!colStarts.some((x) => Math.abs(x - b.x) <= 2)) colStarts.push(b.x);
      }
      const realCols = colStarts
        .sort((a, b) => a - b)
        .map((x) => ({
          x,
          w: Math.max(...lineRects.filter((b) => Math.abs(b.x - x) <= 2).map((b) => b.width)),
        }));

      return {
        availW, availH, paperW: Math.round(paperR.w), paperH: Math.round(paperR.h),
        stagePadLeft: parseFloat(cs.paddingLeft),
        paperLeftGap: Math.round(paperR.x - stageR.x - parseFloat(cs.paddingLeft)),
        paperRightGap: Math.round(stageR.right - parseFloat(cs.paddingRight) - paperR.right),
        // 纵向桌面留白（I9：全屏应为 0 ⇒ 纸张铺满上下）。
        //
        // 注意量的是"纸张与**阅读区内容边界**的距离"——.br-stage 的 padding 就是桌面，
        // 因此纸张相对 **border box** 的偏移才是桌面留白；相对内容边界则恒为 0
        // （纸张宽 = 可用宽、高 = 可用高）。这里量 border box 侧。
        paperTopGap: Math.round(paperR.y - stageR.y),
        paperBottomGap: Math.round(stageR.bottom - paperR.bottom),
        flowR, paperR: { x: paperR.x, w: paperR.w },
        faceCount: faces.length,
        faces,
        // 真实栏：每个不同 x 的起点与该栏最宽的行宽。
        realColumnWidth: realCols.length ? realCols[0].w : null,
        realColumnStarts: realCols.map((c) => c.x),
        realColumnWidths: realCols.map((c) => c.w),
        realColumnCount: realCols.length,
        contentScrollWidth: content.scrollWidth,
        flowScrollWidth: flow.scrollWidth,
        flowClientWidth: flow.clientWidth,
        simClass: stage.classList.contains('br-simulated'),
        spreadClass: stage.classList.contains('br-spread'),
        layerDisplay: getComputedStyle(layer).display,
        // 分页模式的平移**过渡**（I3：必须为 none ⇒ 刷新换屏而不是滑动）。
        flowTransition: getComputedStyle(flow).transition,
        // 投影必须画在**纸张**上（纸页的投影会被纸张的 overflow:hidden 裁掉）。
        paperShadow: getComputedStyle(paper).boxShadow,
        faceShadow: faces.length ? getComputedStyle(layer.firstElementChild).boxShadow : '',
        paperBg: getComputedStyle(paper).backgroundColor,
        stageBg: cs.backgroundColor,
      };
    })()`);
  }

  // ==================== 单页（100% 页面宽度） ====================
  const single = await measure({ width: 900, height: 620, columns: 1 });

  check(
    "单页：纸张**居中**（左右留白相等，且都在阅读区内）",
    Math.abs(single.paperLeftGap - single.paperRightGap) <= 1 &&
      single.paperLeftGap >= 0 &&
      single.paperRightGap >= 0,
    `left=${single.paperLeftGap} right=${single.paperRightGap}`,
  );
  check(
    "单页：纸张宽 = 阅读区可用宽（页面宽度 100% = 铺满）",
    Math.abs(single.paperW - single.availW) <= 1,
    `paper=${single.paperW} avail=${single.availW}`,
  );
  check(
    "单页：纸页数 = 1（单页只有一张纸）",
    single.faceCount === 1 && !single.spreadClass,
    `faces=${single.faceCount} spreadClass=${single.spreadClass}`,
  );

  // ==================== 双页 ====================
  const spread = await measure({ width: 900, height: 620, columns: 2 });
  /** 同一面板宽度、**页边距 60**：用于验证"页边距只作用于纸张内部"。 */
  const spreadMargin60 = await measure({ width: 900, height: 620, columns: 2, pageMargin: 60 });
  /** 窄面板 + 页边距 80：用于验证页边距被夹紧（栏宽不至于被挤到 0）。 */
  const tinyPanel = await measure({ width: 520, height: 400, columns: 2, pageMargin: 80 });
  const gapBetween = Math.round(spread.faces[1].x - spread.faces[0].right);
  check(
    "双页：一对纸页**相贴**（两张之间无缝——书脊处相邻，不是两张分离的卡片）",
    Math.abs(gapBetween) <= 1,
    `缝隙=${gapBetween}px face0.right=${spread.faces[0].right} face1.x=${spread.faces[1].x}`,
  );
  check(
    "双页：两张纸**铺满**纸张宽（逐像素无缝，无露底）",
    Math.abs(spread.faces[0].w + spread.faces[1].w - spread.paperW) <= 1.5,
    `faces=${spread.faces[0].w}+${spread.faces[1].w} paper=${spread.paperW}`,
  );
  check(
    "双页：纸张**居中**（左右留白相等）",
    Math.abs(spread.paperLeftGap - spread.paperRightGap) <= 1,
    `left=${spread.paperLeftGap} right=${spread.paperRightGap}`,
  );
  check(
    "双页：浏览器实际栏宽 = 面板算出的栏宽（分栏等分，翻页步进才不会错位）",
    // 纸内正文宽 = 纸宽 - 2×页边距（24）；再扣掉一个栏间距（= 2×页边距 48）后二等分。
    spread.realColumnWidth !== null &&
      Math.abs(spread.realColumnWidth - (spread.paperW - 24 * 2 - 48) / 2) <= 1.5,
    `realColumnWidth=${spread.realColumnWidth} 期望≈${((spread.paperW - 48 - 48) / 2).toFixed(1)}（(纸宽-2×24-48)/2）`,
  );
  check(
    "双页：两张纸与两条正文栏**逐一对齐**（纸在字下面、字在纸中间，不是错位的两层）",
    (() => {
      if (spread.realColumnStarts.length < 2) return false;
      // 书脊缝 = 2×页边距，因此每栏**恰好居中**在它自己的纸上（见 readerView 的推导）。
      // 容差 2px：栏宽与纸宽可能有亚像素取整差，且**行盒的可视宽度**受
      // `text-align: justify` 与末行影响（末行短，起点仍精确）。
      const faceCenters = spread.faces.map((f) => f.x + f.w / 2);
      const colCenters = spread.realColumnStarts
        .slice(0, 2)
        .map((x, i) => x + spread.realColumnWidths[i] / 2);
      return faceCenters.every((c, i) => Math.abs(c - colCenters[i]) <= 2);
    })(),
    `faces=${spread.faces.map((f) => Math.round(f.x + f.w / 2)).join(",")} cols=${spread.realColumnStarts.slice(0, 2).map((x, i) => Math.round(x + spread.realColumnWidths[i] / 2)).join(",")} colW=${spread.realColumnWidths.map((w) => w.toFixed(1)).join("/")}`,
  );
  check(
    "正文离纸边 = **「页边距」设置**（2026-10-18：正文和纸边太近 ⇒ 拉开）",
    (() => {
      // 第 1 栏的起点应当比第 1 张纸的起点右移**一个页边距**（24px）。
      const offset = spread.realColumnStarts[0] - spread.faces[0].x;
      return offset >= 20 && offset <= 28;
    })(),
    `colStart-faceStart=${(spread.realColumnStarts[0] - spread.faces[0].x).toFixed(1)}（期望 ≈ 页边距 24）`,
  );
  check(
    "页边距**可见地拉开**：正文栏宽 + 2×页边距 + 栏间距 = 纸宽（几何自洽）",
    spread.realColumnWidth !== null &&
      Math.abs(spread.realColumnWidth * 2 + 24 * 2 + 48 - spread.paperW) <= 2,
    `2×colW(${(spread.realColumnWidth * 2).toFixed(0)}) + 2×24 + 48 = ${(spread.realColumnWidth * 2 + 48 + 48).toFixed(0)} vs paper=${spread.paperW}`,
  );

  // ==================== 跟随自适应大小 ====================
  const wide = await measure({ width: 1200, height: 800, columns: 2 });
  const narrow = await measure({ width: 520, height: 400, columns: 2 });
  check(
    "跟随自适应大小：面板变宽 ⇒ 纸张变宽、栏宽变大（正文按新栏宽重排，不是缩放变换）",
    wide.paperW > spread.paperW &&
      spread.paperW > narrow.paperW &&
      wide.realColumnWidth > spread.realColumnWidth &&
      spread.realColumnWidth > narrow.realColumnWidth,
    `paper 1200→${wide.paperW} 900→${spread.paperW} 520→${narrow.paperW} colW ${wide.realColumnWidth?.toFixed(1)}/${spread.realColumnWidth?.toFixed(1)}/${narrow.realColumnWidth?.toFixed(1)}`,
  );
  check(
    "跟随自适应大小：纸张高 = 可用高（分栏高度来自纸张高）",
    Math.abs(np(wide.paperH) - np(wide.availH)) <= 1 &&
      Math.abs(np(narrow.paperH) - np(narrow.availH)) <= 1,
    `1200x800 paperH=${wide.paperH}/${wide.availH} 520x400 paperH=${narrow.paperH}/${narrow.availH}`,
  );
  check(
    "窄面板：纸张不超出可用区（不顶出阅读区）",
    narrow.paperW <= narrow.availW + 1 && narrow.faces[0].x >= narrow.paperR.x - 1,
    `paper=${narrow.paperW} avail=${narrow.availW}`,
  );

  // ============ 2026-10-18 用户口径："书页大一点，桌面露出少一点"（I1）============
  check(
    "【I1】纸张铺满可用区 ⇒ **桌面只占固定小留白**（不再是「页边距」那种一圈大留白）",
    (() => {
      // 100% 页面宽度时纸张 = 可用宽；四周只剩 `--br-desk-*` 的固定留白（8px）。
      // 旧实现这里等于「页边距」（默认 24px），纸张比可用区小 48px。
      const deskX = single.availW - single.paperW;
      return deskX >= 0 && deskX <= 2;
    })(),
    `单页：paper=${single.paperW} avail=${single.availW} 桌面占比=${(((single.availW - single.paperW) / single.availW) * 100).toFixed(1)}%`,
  );
  check(
    "【I1】桌面留白来自 `--br-desk-*`（**与「页边距」互不联动**：改页边距不动纸张）",
    (() => {
      // 同一面板宽度下，把「页边距」从 24 拉到 60：纸张宽必须**不变**
      // （页边距现在作用于纸张**内部**，不再缩小纸张）。
      const a = spread;
      const b = spreadMargin60;
      return Math.abs(a.paperW - b.paperW) <= 1 && b.realColumnWidth < a.realColumnWidth;
    })(),
    `paper 24→${spread.paperW} / 60→${spreadMargin60.paperW}；栏宽 ${spread.realColumnWidth?.toFixed(0)}→${spreadMargin60.realColumnWidth?.toFixed(0)}`,
  );
  check(
    "【I2】「页边距」= 正文到纸边的距离，**且随设置变大**（正文离纸边更远）",
    (() => {
      const off24 = spread.realColumnStarts[0] - spread.faces[0].x;
      const off60 = spreadMargin60.realColumnStarts[0] - spreadMargin60.faces[0].x;
      return off60 > off24 + 20;
    })(),
    `正文离纸边：24px 设置 → ${(spread.realColumnStarts[0] - spread.faces[0].x).toFixed(0)}px；60px 设置 → ${(spreadMargin60.realColumnStarts[0] - spreadMargin60.faces[0].x).toFixed(0)}px`,
  );
  check(
    "【I2】页边距**按可读性夹紧**：窄面板下不许把栏宽挤到 0（夹紧后仍 ≥ 48px）",
    (() => {
      const tiny = tinyPanel;
      return tiny.realColumnWidth === null || tiny.realColumnWidth >= 40;
    })(),
    `520×400 双页 / 页边距 80 → 真实栏宽=${tinyPanel.realColumnWidth}`,
  );

  // ============ 2026-10-18 用户口径："翻页是刷新不是滑动"（I3）============
  check(
    "【I3】分页模式的平移**没有过渡**（翻页 = 直接换屏，不是横向滑动）",
    (() => {
      const flowTransition = spread.flowTransition;
      return flowTransition === "none" || flowTransition === "all 0s ease 0s" || flowTransition === "";
    })(),
    `transition=${JSON.stringify(spread.flowTransition)}`,
  );
  check(
    "【I3】反向：CSS 里那条 0.18s 的 `transition: transform` **已不在分页模式生效**",
    (() => {
      // 旧写法是 `.br-flow { transition: transform 0.18s ease }`（对两种模式都生效）。
      // 现在它必须只可能出现在滚动模式，或干脆没有。
      const m = /\.br-flow\s*\{[^}]*transition:\s*transform/.test(stylesSource);
      const pagedNone = /\.br-stage-paged\s+\.br-flow\s*\{[^}]*transition:\s*none/.test(
        stylesSource,
      );
      return !m && pagedNone;
    })(),
  );

  // ============ 2026-10-18："上下两栏自然融入背景"（I6）============
  check(
    "【I6】顶栏 / 底栏**透明背景、无横线**（自然融入阅读区底色，如参考图 1）",
    (() => {
      const top = stylesSource.match(/\.br-top\s*\{[^}]*\}/)?.[0] ?? "";
      const footer = stylesSource.match(/\.br-footer\s*\{[^}]*\}/)?.[0] ?? "";
      return (
        /background:\s*transparent/.test(top) &&
        /background:\s*transparent/.test(footer) &&
        !/border-bottom/.test(top) &&
        !/border-top/.test(footer)
      );
    })(),
    `top=${stylesSource.match(/\.br-top\s*\{[^}]*\}/)?.[0]?.slice(0, 60)}`,
  );

  // ============ 2026-10-18："取消右下角悬浮计数"（I7）============
  check(
    "【I7】右下角悬浮翻页器已删除（面板不再渲染 `.br-pager`，CSS 也不再有它）",
    (() => {
      const stageSrc = readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
        "utf8",
      );
      return !/className="br-pager"/.test(stageSrc) && !/^\.br-pager\s*\{/m.test(stylesSource);
    })(),
  );
  check(
    "【I7】反向：翻页动作仍可由**键盘 / 滚轮**完成（删的是浮层，不是翻页能力）",
    (() => {
      const stageSrc = readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
        "utf8",
      );
      return (
        /ArrowRight/.test(stageSrc) &&
        /accumulateWheelStep/.test(stageSrc) &&
        /addEventListener\("wheel",\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/.test(stageSrc)
      );
    })(),
  );

  // ============ 2026-10-18："删除退出阅读按钮，全屏放入更多选项"（I8）============
  check(
    "【I8】顶栏不再有「退出阅读」/「全屏模式」按钮，全屏动作搬进「阅读选项」栏",
    (() => {
      const panelSrc = readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/BookReaderPanel.tsx"),
        "utf8",
      );
      const railSrc = readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderOptionsRail.tsx"),
        "utf8",
      );
      return (
        // 顶栏里不再渲染这两个按钮。
        !/onClick=\{exitReading\}/.test(panelSrc) &&
        !/onClick=\{toggleFullscreen\}/.test(panelSrc) &&
        // 但全屏能力留给右栏（能力不能随入口一起消失）。
        /onToggleFullscreen/.test(panelSrc) &&
        /onClick=\{onToggleFullscreen\}/.test(railSrc) &&
        /bookreader\.fullscreen/.test(railSrc) &&
        // 全屏状态仍然被阅读区消费（纸张纵向铺满）。
        /fullscreen=\{fullscreen\}/.test(panelSrc) &&
        /fullscreen\?: boolean/.test(
          readFileSync(
            join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
            "utf8",
          ),
        )
      );
    })(),
  );
  check(
    "【I9】全屏时纸张**铺满上下**（纵向桌面 = 0；横向仍留薄桌面）",
    (() => {
      const stageSrc = readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
        "utf8",
      );
      const code = stageSrc.replace(/\/\*[\s\S]*?\*\//g, "");
      return (
        /fullscreen \? READER_DESK_PADDING_FULLSCREEN_Y : READER_DESK_PADDING/.test(code) &&
        /READER_DESK_PADDING_FULLSCREEN_Y = 0/.test(
          readFileSync(
            join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/readerView.ts"),
            "utf8",
          ),
        )
      );
    })(),
  );

  // ============ 2026-10-18 用户口径："全屏时纸张铺满上下"（I9 / 裁决 B）============
  // 全屏时纵向桌面留白 = 0（纸张上下贴到阅读区边），横向仍留薄桌面。
  // 夹具是**静态**的（没有 React），因此这里直接按 `ReaderStage` 的算式写 CSS 变量：
  //   --br-desk-y = 全屏 ? READER_DESK_PADDING_FULLSCREEN_Y(0) : READER_DESK_PADDING(8)
  // 再量纸张上下与阅读区边界的距离。
  const fsWindow = await measure({ width: 900, height: 620, columns: 2, fullscreen: false });
  const fsFull = await measure({ width: 900, height: 620, columns: 2, fullscreen: true });
  check(
    "【I9】全屏：纸张**铺满上下**（纵向桌面留白 0，纸张高 = 可用高）；窗口模式留 8px 桌面",
    Math.abs(fsFull.paperTopGap) <= 1 &&
      Math.abs(fsFull.paperBottomGap) <= 1 &&
      fsWindow.paperTopGap >= 6 &&
      fsWindow.paperTopGap <= 10,
    `窗口 top=${fsWindow.paperTopGap} bottom=${fsWindow.paperBottomGap}；全屏 top=${fsFull.paperTopGap} bottom=${fsFull.paperBottomGap}`,
  );
  check(
    "【I9】全屏只改**纵向**：横向桌面留白不变（左右仍是 8px）",
    Math.abs(fsFull.paperLeftGap - fsWindow.paperLeftGap) <= 1 &&
      Math.abs(fsFull.paperRightGap - fsWindow.paperRightGap) <= 1,
    `横向 窗口 ${fsWindow.paperLeftGap}/${fsWindow.paperRightGap}；全屏 ${fsFull.paperLeftGap}/${fsFull.paperRightGap}`,
  );

  // ==================== 仿真背景开关 ====================
  const on = spread;
  const off = await measure({ width: 900, height: 620, columns: 2, simulated: false });
  check(
    "仿真背景**开**：桌面底色 + 纸页层可见 + 纸张有投影",
    on.simClass &&
      on.layerDisplay !== "none" &&
      on.paperShadow !== "none" &&
      on.paperShadow.length > 0 &&
      on.paperShadow.includes("rgba(0, 0, 0, 0.2)"),
    `display=${on.layerDisplay} paperShadow=${on.paperShadow.slice(0, 48)}…`,
  );
  check(
    "图书阴影画在**纸张**上（画在纸页上会被纸张的 `overflow: hidden` 裁掉 ⇒ 看不见）",
    // 纸页层是纸张的子元素，纸张又是分页的裁剪视口；实测过：把投影挂到 `.br-face` 时
    // 单页模式（纸页宽 = 纸张宽）投影**一点都看不见**。因此这里反向钉住"纸页不得带外投影"，
    // 并正向钉住"纸张有外投影（两段）"。
    !on.faceShadow.includes("rgba(0, 0, 0, 0.2)") &&
      on.paperShadow.includes("0px 1px 2px") &&
      on.paperShadow.includes("0px 4px 12px"),
    `faceShadow=${on.faceShadow.slice(0, 40)} paperShadow=${on.paperShadow.slice(0, 48)}`,
  );
  check(
    "书脊缝用 `inset`（画在纸页**内部**，因此不受纸张裁剪）且**仅双页**",
    spread.faces.length === 2 &&
      spread.faceShadow.includes("inset") &&
      // 单页没有书脊（只有一张纸）。
      !single.faceShadow.includes("inset"),
    `spread=${spread.faceShadow.slice(0, 40)} single=${single.faceShadow.slice(0, 40)}`,
  );
  check(
    "仿真背景**关**：纸页层整层不显示（没有纸、没有影、没有桌面）",
    !off.simClass && off.layerDisplay === "none",
    `simClass=${off.simClass} display=${off.layerDisplay}`,
  );
  check(
    "仿真背景关掉后**正文与纸张几何不变**（开关只影响纸的装饰，不改变分栏）",
    Math.abs(off.paperW - on.paperW) <= 1 &&
      Math.abs(off.realColumnWidth - on.realColumnWidth) <= 0.5 &&
      off.faces.length === on.faces.length,
    `paper on=${on.paperW} off=${off.paperW} colW on=${on.realColumnWidth} off=${off.realColumnWidth}`,
  );

  // ==================== 深色主题 ====================
  const dark = await measure({ width: 900, height: 620, columns: 2, theme: "dark" });
  check(
    "深色主题：纸张/书脊投影**加粗**（同 alpha 在深底上几乎看不见）",
    dark.paperShadow !== spread.paperShadow &&
      dark.paperShadow.includes("0.5") &&
      dark.faceShadow.includes("0.5"),
    `light=${spread.paperShadow.slice(0, 30)}… dark=${dark.paperShadow.slice(0, 30)}…`,
  );

  // ==================== 结构同构（夹具 ↔ 组件） ====================
  const stageSrc = readFileSync(
    join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
    "utf8",
  );
  check(
    "夹具与组件**同构**：类名逐一核对（否则量的是另一个页面）",
    /className="br-paper"/.test(stageSrc) &&
      /className="br-face-layer"/.test(stageSrc) &&
      /className="br-face"/.test(stageSrc) &&
      /className="br-flow"/.test(stageSrc) &&
      /className="vr-content br-content"/.test(stageSrc) &&
      /className="br-page"/.test(stageSrc),
  );

  cdp.close();
  cleanup();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

function np(v) {
  return typeof v === "number" ? v : parseFloat(v);
}

main().catch((e) => {
  console.error("布局验证失败:", e);
  process.exit(1);
});
