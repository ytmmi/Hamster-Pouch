/**
 * 位置探测**经验实验**：分页模式下 probeX 应以**纸张**为基准，而不是被平移的内容框。
 *
 * ## 为什么单独做这个实验
 *
 * `reportPosition` 用 `elementFromPoint(probeX, probeY)` 找出"当前屏左缘是哪一个
 * `.br-page`"，`visibleIndex` 由它决定（章节数 / 章节标题 / 目录高亮全读它）。
 * 而分页模式的**平移就挂在 `.br-flow` 上**（`translateX(-page · pitch)`），
 * 于是 `flowRect.left` 随翻页一直往左跑。
 *
 * 这带来一个只能实测回答的问题：**当 page > 0 时，以 `flowRect.left` 取的探测点
 * 会不会跑出纸张（甚至跑出视口）**，从而 `elementFromPoint` 返回 null /
 * 返回纸张本身，`closest("[data-page-index]")` 得到 null、`visibleIndex` 退成 -1？
 *
 * 纯推理容易搞错（`getBoundingClientRect` 对**跨栏元素**返回的是所有碎片的并集盒，
 * 而并集盒的左缘正是被平移的那一端）。因此这里在**真实 styles.css + 真实多栏排版**
 * 上把两种探测基准都跑一遍，用数据说话。
 *
 * 用法：node tools/reader-probe-experiment.mjs
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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) return;
      const e = this.pending.get(msg.id);
      if (!e) return;
      this.pending.delete(msg.id);
      if (msg.error) e.reject(new Error(JSON.stringify(msg.error)));
      else e.resolve(msg.result);
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
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "求值失败");
    }
    return res.result.value;
  }
  close() {
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

/** 夹具：**多个** `.br-page`（每个都是长段落），复现"一屏里可能跨多个内容项"。 */
function fixtureHtml() {
  const items = Array.from({ length: 8 }, (_, i) =>
    `<div class="br-page" data-page-index="${i}"><p class="vr-text">第${i + 1}项。${"文字内容。".repeat(400)}</p></div>`,
  ).join("\n");
  // 注意：模板内不得出现反引号。
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="styles.css">
<style>
  html, body { margin: 0; padding: 0; }
  body { display: flex; }
  .br-root { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .br-body { flex: 1; min-height: 0; position: relative; display: flex; align-items: stretch; }
</style>
</head>
<body class="app-root">
  <div class="br-root"><div class="br-body">
    <div id="stage" class="br-stage br-stage-paged br-simulated br-spread br-bg-paper br-text-auto br-font-system br-align-default" tabindex="0">
      <div class="br-paper" id="paper">
        <div class="br-face-layer" aria-hidden="true"><div class="br-face"></div><div class="br-face"></div></div>
        <div class="br-flow" id="flow">
          <div class="vr-content br-content">
${items}
          </div>
        </div>
      </div>
    </div>
  </div></div>
</body></html>`;
}

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    console.error("找不到 Edge");
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), "hp-probe-"));
  writeFileSync(join(work, "styles.css"), readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css")));
  writeFileSync(join(work, "probe.html"), fixtureHtml(), "utf8");

  const PORT = 9352;
  const proc = spawn(
    edge,
    ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "p")}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const cleanup = () => {
    try { proc.kill(); } catch { /* 已退出 */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };
  process.on("exit", cleanup);

  let wsUrl = null;
  const deadline = Date.now() + 40000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) { cleanup(); console.error("Edge 未就绪"); process.exit(3); }
    await sleep(200);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `file:///${join(work, "probe.html").replace(/\\/g, "/")}` });
  await sleep(500);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(200);

  const out = await cdp.eval(`(() => {
    /*
     * 与当前几何对齐（2026-10-18 / D116-R2）：
     * 纸宽 = 可用宽；「页边距」是**纸张内部**的 padding（MARGIN）；
     * 栏间距 = 书脊缝 = 2×页边距；纸页宽 = 纸宽 / 栏数（等分铺满）。
     *
     * 探测点以**纸张**为基准、再往里一个「页边距」——正是 ReaderStage 的算法
     * （basis.left + pagedLayout.margin + 4）。旧夹具用的是上一版的 --br-page-inset，
     * 与现在的实现不对应，会让探测点落在纸边（命中 br-paper 而不是正文）。
     */
    const MARGIN = 24, COLS = 2;
    const stage = document.getElementById('stage');
    const paper = document.getElementById('paper');
    const flow = document.getElementById('flow');
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const availW = stage.clientWidth - padX;
    const paperW = Math.floor(availW);
    const GAP = MARGIN * 2;
    stage.style.setProperty('--br-columns', String(COLS));
    stage.style.setProperty('--br-column-gap', GAP + 'px');
    stage.style.setProperty('--br-page-margin', MARGIN + 'px');
    stage.style.setProperty('--br-paper-w', paperW + 'px');
    stage.style.setProperty('--br-paper-h', Math.max(1, Math.floor(availH())) + 'px');
    stage.style.setProperty('--br-face-w', (paperW / COLS) + 'px');
    function availH() { return stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); }
    // 一次翻页推进**一张纸**（= 纸内正文宽 + 栏间距 = 纸宽）。
    const screenPitch = paperW - MARGIN * 2 + GAP;
    // 关掉过渡：否则设完 transform 立刻读矩形读到的是**动画起点**。
    // （分页模式的过渡现在本就为 none，这里显式设置是为了不依赖样式表。）
    flow.style.transition = 'none';
    const rows = [];
    for (let page = 0; page < 3; page += 1) {
      flow.style.transform = 'translateX(-' + (page * screenPitch) + 'px)';
      // 强制同步布局，确保读到的是**稳态**几何。
      void flow.offsetWidth;
      const flowRect = flow.getBoundingClientRect();
      const paperRect = paper.getBoundingClientRect();
      const hostRect = stage.getBoundingClientRect();
      const clientLeft = stage.clientLeft;

      // (a) 旧基准：以**内容框**（被平移）取点。
      const oldX = flowRect.left + Math.min(flowRect.width / 2, 40);
      const oldY = Math.min(Math.max(hostRect.top + 2, flowRect.top + 2), Math.min(hostRect.bottom, flowRect.bottom) - 2);
      const oldEl = document.elementFromPoint(oldX, oldY);
      const oldPage = oldEl && oldEl.closest ? oldEl.closest('[data-page-index]') : null;

      // (b) 新基准：以**纸张**为基准 + 一个「页边距」（= 正文可见区左缘）。
      const newX = paperRect.left + MARGIN + 4;
      const newY = paperRect.top + MARGIN + 4;
      const newEl = document.elementFromPoint(newX, newY);
      const newPage = newEl && newEl.closest ? newEl.closest('[data-page-index]') : null;
      // 参考真相：这一屏左缘落在哪个项里（用 Range 取逐项碎片，避开跨栏并集盒）。
      const probeX = newX;
      const probeY = newY;
      let truth = -1;
      for (const el of document.querySelectorAll('[data-page-index]')) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects());
        if (rects.some((q) => probeX >= q.left && probeX <= q.right && probeY >= q.top && probeY <= q.bottom)) {
          truth = Number(el.dataset.pageIndex);
          break;
        }
      }
      /*
       * 页内比例的**两种候选口径**——这一段是为"该用哪个分母"做的测量，不是猜。
       *
       * 消费方 readerPositionFromPage(index, offset, cursors) 算的是
       * item.start + offset × item.span，span = **这一项的字符总量**。
       * 因此 offset 的正确语义是：**这一项（.br-page）被读了多少（0–1）**。
       *
       * 关键事实：.br-page 是内容流里的**普通块**，一项若长到跨栏，它的并集盒
       * （getBoundingClientRect）就横跨**该项目的全部栏**——所以
       * pageRect.width 正是"这一项的总内容宽"，可以当分母。
       *
       * unionForm：(视口内容左缘 - 项左缘) / 项宽 —— 语义 = "这一项读了百分之多少"。
       * screenForm：把同一个差值按"屏内栏数 ÷ 屏宽"换算 —— 语义 = "读到屏内第几栏"，
       *   一旦该项跨栏数超过屏内栏数就**饱和到 1**（位置直接跳到项尾），因此是错的。
       */
      const vpLeft = paperRect.left + MARGIN;
      const itemRect = newPage ? newPage.getBoundingClientRect() : null;
      const diff = itemRect ? vpLeft - itemRect.left : null;
      // 候选 B 的分母用"纸内正文宽"（= 纸宽 - 2×页边距），与实现无关的独立量。
      const contentW = paperW - MARGIN * 2;
      rows.push({
        page,
        oldX: Math.round(oldX), oldY: Math.round(oldY),
        oldHit: oldEl ? (oldEl.className || oldEl.tagName) : null,
        oldPage: oldPage ? Number(oldPage.dataset.pageIndex) : null,
        newX: Math.round(newX), newY: Math.round(newY),
        newHit: newEl ? (newEl.className || newEl.tagName) : null,
        newPage: newPage ? Number(newPage.dataset.pageIndex) : null,
        truth,
        flowRectLeft: Math.round(flowRect.left),
        paperRectLeft: Math.round(paperRect.left),
        inViewport: oldX >= 0 && oldX <= innerWidth,
        diff: diff === null ? null : Math.round(diff),
        itemWidth: itemRect ? Math.round(itemRect.width) : null,
        // 候选 A（正确语义）：这一项读了百分之多少。
        unionForm: itemRect && itemRect.width > 0 ? diff / itemRect.width : null,
        // 候选 B（会饱和的那版）：读到"屏内第几栏"——跨栏项会 > 1。
        screenForm: diff === null ? null : (diff * COLS) / contentW,
        // 参考：本屏在内容流里的推进量（page × 一张纸）。
        screenOffset: Math.round(page * screenPitch),
      });
    }
    return rows;
  })()`);

  console.log("page | 旧基准(flow)                 | 新基准(paper)                | 真相");
  console.log("-----+-------------------------------+------------------------------+-----");
  for (const r of out) {
    console.log(
      `${r.page}    | x=${String(r.oldX).padStart(5)} hit=${String(r.oldHit).padEnd(10)} idx=${String(r.oldPage).padEnd(4)} | ` +
        `x=${String(r.newX).padStart(5)} hit=${String(r.newHit).padEnd(10)} idx=${String(r.newPage).padEnd(4)} | ${r.truth}`,
    );
  }
  console.log("\nflowRect.left 随翻页左移：", out.map((r) => r.flowRectLeft).join(" → "));
  console.log("paperRect.left（视口基准）恒为：", out.map((r) => r.paperRectLeft).join(" → "));
  console.log("\n页内比例：候选 A（项内比例，正确语义） vs 候选 B（屏内栏比例，会饱和）");
  for (const r of out) {
    const f = (v) => (v === null ? "null" : v.toFixed(3));
    console.log(
      `  page=${r.page} 项=${r.newPage} 项宽=${r.itemWidth} 差值=${r.diff}px  ` +
        `A=${f(r.unionForm)}  B=${f(r.screenForm)}`,
    );
  }

  /*
   * 断言：这两条正是修复所依赖的事实，也是"为什么必须改基准"的证据。
   *
   * 判据一：**旧基准在翻页后失效**（第 1 屏起命中 null）——若哪天它又能命中，
   *   说明"内容框带平移"这个前提变了（例如有人把 transform 挪到别的元素上），
   *   那时注释里的推理就过时了，必须重看。
   * 判据二：**新基准三屏都稳定命中同一项**——这是修复成立的直接证据。
   */
  const results = [];
  const check = (label, ok, detail = "") => {
    results.push({ label, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  check(
    "复现缺陷：以被平移的内容框为基准时，**第 1 屏起探测点跑出视口**（命中 null）",
    out.slice(1).every((r) => r.oldPage === null),
    out.map((r) => `p${r.page}:x=${r.oldX}→${r.oldPage}`).join(" "),
  );
  check(
    "修复成立：以**纸张（视口）**为基准时，**每一屏都命中正文**（不再因平移跑出视口）",
    // 注意**不能**要求"三屏命中同一项"：夹具有多项，翻页本来就会跨到下一项
    // （实测 p0/p1→项 0、p2→项 1 是**正确**的）。要钉的是"命中，且不为 null"。
    out.every((r) => r.newPage !== null && Number.isFinite(r.newPage)),
    out.map((r) => `p${r.page}→idx=${r.newPage}`).join(" "),
  );
  check(
    "修复成立：纸张基准命中的项**单调不减**（翻页只会前进，不会倒退）",
    out.every((r, i) => i === 0 || r.newPage >= out[i - 1].newPage),
    out.map((r) => `p${r.page}→idx=${r.newPage}`).join(" "),
  );
  check(
    "平移确实作用在内容框上（而不是纸张上）：flowRect.left 随翻页递减、paperRect.left 恒定",
    out[0].flowRectLeft > out[out.length - 1].flowRectLeft &&
      new Set(out.map((r) => r.paperRectLeft)).size === 1,
    `flow=${out.map((r) => r.flowRectLeft).join("→")} paper=${out.map((r) => r.paperRectLeft).join("→")}`,
  );

  /*
   * 页内比例的**分母**必须有确定答案——这条是实测踩出来的回归。
   *
   * 正确口径（候选 A）是"**这一项**读了百分之多少"：**永远落在 [0,1]**
   * （项的并集盒横跨它自己的全部栏，视口推进多少，它就占多少），
   * 因此消费方的 `clamp01` 是恒等变换、不会截断。
   *
   * 错误口径（候选 B，"读到屏内第几栏"）在项跨栏时**> 1**：实测 2.115 / 2.115，
   * 被 `clamp01` 压成 1 ⇒ **翻一页进度就跳到项尾**。
   *
   * **注意**：候选 A 不会跨屏单调递增——翻到**下一项**时它本来就是从 0 附近重新开始
   * （实测 p1=0.692 → p2 换项后 0.514）。因此这里钉的是"**恒在 [0,1]**"
   * 与"**同项内单调**"，不是"三屏一路递增"（旧断言正是错在这里）。
   */
  const withinRange = out.every(
    (r) => r.unionForm !== null && r.unionForm >= 0 && r.unionForm <= 1,
  );
  const monotoneWithinItem = out.every(
    (r, i) => i === 0 || r.newPage !== out[i - 1].newPage || r.unionForm >= out[i - 1].unionForm,
  );
  const screenSaturates = out.some((r) => r.screenForm !== null && r.screenForm > 1);
  check(
    "页内比例的**正确分母 = 这一项的宽**：结果**恒在 [0,1]**（`clamp01` 是恒等变换）",
    withinRange && monotoneWithinItem,
    out.map((r) => `p${r.page}:项${r.newPage} A=${r.unionForm?.toFixed(3)}`).join(" "),
  );
  check(
    "反向证据：**换成「屏内第几栏」的分母会饱和**（> 1，被 clamp01 压成 1 ⇒ 进度跳到项尾）",
    screenSaturates,
    out.map((r) => `p${r.page}:B=${r.screenForm?.toFixed(3)}`).join(" "),
  );

  cdp.close();
  cleanup();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("实验失败:", e);
  process.exit(1);
});
