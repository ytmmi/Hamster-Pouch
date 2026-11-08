/**
 * 图像查看器胶片栏**自适应视图真机验证**（无头 Edge + 真实 styles.css）。
 *
 * ## 为什么要真机量（缺陷 0041 / D147）
 *
 * D146 把胶片栏改成"绝对定位 + 纯几何下发尺寸"，但纯函数算的是**理想盒模型**：
 * 浏览器里滚动条是**经典占位滚动条**（全局 `::-webkit-scrollbar { width: 6px }`），
 * 出现时会从客户区扣掉一条——几何模块不知道这件事，单元交叉轴按"无滚动条"
 * 下发就会**溢出轨道、被 `overflow: auto` 裁掉一条边**，还会凭空多出一条
 * 交叉轴滚动条。这类"公式对、浏览器不对"只有量了才知道（0027 同款教训）。
 *
 * ## 怎么量
 *
 * 无头 Edge 加载本仓库**真实的** `styles.css`，按 `ViewerFilmstrip` 的 DOM 结构
 * 拼同构静态夹具（`.iv-film` → `.iv-film-track` → `.iv-film-cell` → `.iv-film-thumb`），
 * 单元两轴尺寸/偏移按 `viewerFilmstripLayout.ts` 的公式独立复算后内联下发
 * （与组件同构；公式手抄一份，正是为了和浏览器真实盒模型对账）。
 * 断言按**行为**判定：单元完整落在客户区内、无交叉轴滚动条、单元外框比例 ≈
 * 图像宽高比（对齐 76e073a 原视图的 border-box aspect-ratio 语义）、
 * 滚动到深处窗口仍成立。缺省即修复后口径；回退即红对照：
 * `HP_FILM_CROSS_MODE=formula`（旧交叉轴厚度推算）与
 * `HP_FILM_EXTENT_MODE=legacy`（旧主轴公式）各自复现修复前的红。
 *
 * 用法：
 * ```bash
 * node tools/filmstrip-layout-verify.mjs
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

/** 极简 CDP 客户端（与 tools/reader-layout-verify.mjs 同款，不新增依赖）。 */
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
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
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
 * 夹具页：真实 styles.css + 与 ViewerFilmstrip 同构的容器骨架。
 * 单元由浏览器侧脚本按几何公式生成（见 measure 内注入的 build 函数）。
 * 注意：本模板内不得出现反引号（会提前终止外层 JS 模板字符串）。
 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="styles.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { display: flex; }
  .panel { flex: 1; min-width: 0; min-height: 0; display: flex; }
</style>
</head>
<body class="app-root">
  <div id="panel" class="panel iv-panel"></div>
</body></html>`;

/**
 * 浏览器侧构建函数（字符串注入，独立于产品代码手抄公式）：
 * 按组件同构的方式生成胶片栏 DOM。返回后可用 measureCells 量。
 *
 * 公式与 viewerFilmstripLayout.ts / ViewerFilmstrip.tsx 对应：
 * - crossExtent（交叉轴外尺寸）按组件现行公式 size − padding×2 − border×2 下发；
 * - extent（主轴外尺寸）= (size − padding×2 − border×2 − chrome) × ratio + chrome；
 * - 轨道主轴长度 = 全部单元 extent + gap 累计 + 首尾 padding。
 * 修复若改变组件公式，本函数同步改成"从容器实测客户区推交叉轴"——
 * 那时验证的正是"组件公式与浏览器盒模型一致"。
 */
const BUILD_SCRIPT = `
(() => {
  const PADDING = 4, BORDER = 1, CHROME = 6, GAP = 4;
  window.__build = (opts) => {
    const { edge, size, view, ratios, crossMode } = opts;
    const vertical = edge === "left" || edge === "right";
    const panel = document.getElementById("panel");
    panel.className = "panel iv-panel" + (vertical ? "" : " iv-stack");
    panel.innerHTML = "";
    // 与 ImageViewerPanel 同构：主体在前、胶片栏在后（left/top 由 CSS order:-1 提前）。
    const main = document.createElement("div");
    main.className = "iv-main";
    main.style.flex = "1";
    panel.appendChild(main);
    const film = document.createElement("div");
    film.className = "iv-film iv-film-" + edge + (vertical ? "" : " iv-film-horizontal");
    film.setAttribute("role", "listbox");
    if (vertical) film.style.width = size + "px";
    else film.style.height = size + "px";
    const track = document.createElement("div");
    track.className = "iv-film-track";
    film.appendChild(track);
    panel.appendChild(film);

    // 先挂空轨道量一次客户区（滚动条尚未出现）；单元挂上后如有滚动条会再变。
    if (vertical) { track.style.height = "100000px"; track.style.width = "100%"; }
    else { track.style.width = "100000px"; track.style.height = "100%"; }
    void film.offsetWidth;

    // crossMode: "formula" = 现行组件公式（size 推算）；
    //            "measured" = 从容器实测客户区推（修复后的口径）。
    const crossExtent = crossMode === "measured"
      ? (vertical ? film.clientWidth : film.clientHeight) - PADDING * 2
      : size - PADDING * 2 - BORDER * 2;
    // 观感基准 = 76e073a 原视图：flex stretch 撑满交叉轴 + border-box
    // aspect-ratio: r → 主轴外框 = cross × r（横栏）/ cross ÷ r（竖栏）。
    // HP_FILM_EXTENT_MODE=legacy 时按 D146 旧公式（cross−CHROME）×r+CHROME
    // 且竖栏也恒乘 r（回退即红对照）。
    const extentOf = (r) => {
      const rr = view === "tile" ? 1 : r;
      if (window.__LEGACY_EXTENT) {
        return Math.max(0, crossExtent - CHROME) * rr + CHROME;
      }
      return Math.max(CHROME, (vertical ? crossExtent / rr : crossExtent * rr));
    };

    let offset = PADDING;
    const cells = [];
    for (let i = 0; i < ratios.length; i++) {
      const r = view === "tile" ? 1 : ratios[i];
      const extent = extentOf(r);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "iv-film-cell iv-film-cell-" + view;
      cell.dataset.index = String(i);
      cell.dataset.ratio = String(r);
      if (vertical) {
        cell.style.top = offset + "px";
        cell.style.height = extent + "px";
        cell.style.width = crossExtent + "px";
      } else {
        cell.style.left = offset + "px";
        cell.style.width = extent + "px";
        cell.style.height = crossExtent + "px";
      }
      const img = document.createElement("img");
      img.className = "iv-film-thumb";
      img.alt = "";
      img.draggable = false;
      // 已知宽高比的 SVG 占位图（object-fit 行为与照片一致，无网络依赖）。
      const w = Math.round(1000 * r), h = 1000;
      img.src = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<rect width="100%" height="100%" fill="#8899aa"/></svg>');
      cell.appendChild(img);
      track.appendChild(cell);
      cells.push(cell);
      offset += extent + GAP;
    }
    const total = offset - GAP + PADDING;
    if (vertical) track.style.height = total + "px";
    else track.style.width = total + "px";
    return { count: cells.length, crossExtent, total };
  };

  window.__measure = () => {
    const film = document.querySelector(".iv-film");
    const track = film.querySelector(".iv-film-track");
    const vertical = film.classList.contains("iv-film-left") || film.classList.contains("iv-film-right");
    const cells = Array.from(film.querySelectorAll(".iv-film-cell"));
    const fr = film.getBoundingClientRect();
    const cs = getComputedStyle(film);
    const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
    const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
    const borL = parseFloat(cs.borderLeftWidth), borR = parseFloat(cs.borderRightWidth);
    const borT = parseFloat(cs.borderTopWidth), borB = parseFloat(cs.borderBottomWidth);
    // 内容区（客户区减内边距），换算成视口坐标。
    const contentLeft = fr.left + borL + padL;
    const contentTop = fr.top + borT + padT;
    const contentRight = fr.left + borL + film.clientWidth - padR;
    const contentBottom = fr.top + borT + film.clientHeight - padB;
    const out = cells.map((cell) => {
      const r = cell.getBoundingClientRect();
      const img = cell.querySelector(".iv-film-thumb");
      const ir = img.getBoundingClientRect();
      return {
        index: Number(cell.dataset.index),
        ratio: Number(cell.dataset.ratio),
        crossOverflow: vertical ? Math.max(0, r.right - contentRight, contentLeft - r.left)
                                : Math.max(0, r.bottom - contentBottom, contentTop - r.top),
        imgW: ir.width, imgH: ir.height,
        mainPos: vertical ? r.top : r.left,
        mainExtent: vertical ? r.height : r.width,
      };
    });
    return {
      vertical,
      clientWidth: film.clientWidth,
      clientHeight: film.clientHeight,
      scrollWidth: film.scrollWidth,
      scrollHeight: film.scrollHeight,
      crossScroll: vertical ? film.scrollWidth > film.clientWidth
                            : film.scrollHeight > film.clientHeight,
      mainScrollable: vertical ? film.scrollHeight > film.clientHeight
                               : film.scrollWidth > film.clientWidth,
      trackCross: vertical ? track.getBoundingClientRect().width
                           : track.getBoundingClientRect().height,
      cells: out,
    };
  };
})();
`;

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    console.error("找不到 Edge，无法做真机布局验证");
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), "hp-filmstrip-verify-"));
  const profile = join(work, "profile");
  const stylesSource = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8");
  writeFileSync(join(work, "styles.css"), stylesSource);
  writeFileSync(join(work, "fixture.html"), FIXTURE_HTML, "utf8");

  const PORT = 9337;
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

  let wsUrl = null;
  const deadline = Date.now() + 40000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) {
        wsUrl = t.webSocketDebuggerUrl;
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

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  /** 混合宽高比语料（横/方/竖交替，含极端宽扁）。 */
  const ratios = Array.from({ length: 40 }, (_, i) => [1.5, 1, 0.66, 2.2, 0.8][i % 5]);

  async function measure(opts) {
    await cdp.send("Page.navigate", { url: `file:///${join(work, "fixture.html").replace(/\\/g, "/")}` });
    await sleep(350);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: opts.edge === "left" || opts.edge === "right" ? 900 : 900,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.eval(BUILD_SCRIPT);
    const built = await cdp.eval(
      `window.__LEGACY_EXTENT = ${process.env.HP_FILM_EXTENT_MODE === "legacy"};` +
        `window.__build(${JSON.stringify({ ...opts, ratios })})`,
    );
    // 等占位 SVG 解码（object-fit 需要图像固有尺寸）。
    await sleep(300);
    const m = await cdp.eval("window.__measure()");
    return { built, m };
  }

  // 缺省 = 修复后口径（measured：交叉轴实测客户区）。回退即红对照：
  // HP_FILM_CROSS_MODE=formula 按修复前的厚度推算公式（预期红），
  // HP_FILM_EXTENT_MODE=legacy 按 D146 旧主轴公式（预期红）。
  const crossMode = process.env.HP_FILM_CROSS_MODE === "formula" ? "formula" : "measured";
  console.log(`crossMode=${crossMode}（measured=修复后实测口径；formula=修复前组件公式，回退即红对照）`);

  for (const edge of ["right", "left", "bottom", "top"]) {
    for (const size of [76, 200]) {
      const { m } = await measure({ edge, size, view: "adaptive", crossMode });
      const worst = Math.max(...m.cells.map((c) => c.crossOverflow));
      check(
        `[${edge}/${size}/adaptive] 单元交叉轴不溢出内容区（不被滚动条裁边）`,
        worst < 0.6,
        `最大溢出=${worst.toFixed(2)}px client=${m.vertical ? m.clientWidth : m.clientHeight} trackCross=${m.trackCross.toFixed(2)}`,
      );
      check(
        `[${edge}/${size}/adaptive] 不出现交叉轴滚动条（只有主轴可滚）`,
        !m.crossScroll && m.mainScrollable,
        `crossScroll=${m.crossScroll} mainScrollable=${m.mainScrollable}`,
      );
      // 自适应语义（观感基准 = 76e073a 原视图）：单元**外框**宽高比 ≈ 图像
      // 宽高比（原实现 aspect-ratio 作用于 border-box；内容盒因 6px 盒开销
      // 产生的轻微 contain 留边是原观感的一部分）。竖栏外框 = 宽 cross、
      // 高 cross/r → 宽/高 = r；横栏外框 = 宽 cross×r、高 cross → 同样 = r。
      let worstDev = 0;
      for (const c of m.cells) {
        const outerW = m.vertical ? c.imgW + 6 : c.mainExtent;
        const outerH = m.vertical ? c.mainExtent : c.imgH + 6;
        if (outerW <= 0 || outerH <= 0) continue;
        const dev = Math.abs(outerW / outerH - c.ratio) / c.ratio;
        worstDev = Math.max(worstDev, dev);
      }
      check(
        `[${edge}/${size}/adaptive] 单元外框比例 ≈ 图像比例（对齐 76e073a 原视图）`,
        worstDev < 0.03,
        `最大相对偏差=${(worstDev * 100).toFixed(2)}%`,
      );
    }
  }

  // 平铺回归：方形 + 不溢出（平铺同样吃滚动条亏，修复必须一起生效）。
  {
    const { m } = await measure({ edge: "right", size: 76, view: "tile", crossMode });
    const worst = Math.max(...m.cells.map((c) => c.crossOverflow));
    const allSquare = m.cells.every((c) => Math.abs(c.mainExtent - (m.vertical ? c.imgW + 6 : c.imgH + 6)) < 0.6);
    check(
      "[right/76/tile] 平铺方形且不溢出（回归）",
      worst < 0.6 && !m.crossScroll && allSquare,
      `溢出=${worst.toFixed(2)}px square=${allSquare}`,
    );
  }

  // 滚动到深处：主轴滚动可达、单元定位不重叠（抽 3 个相邻单元间距 = extent + GAP）。
  {
    const { m } = await measure({ edge: "right", size: 76, view: "adaptive", crossMode });
    await cdp.eval(`document.querySelector(".iv-film").scrollTop = 800`);
    await sleep(150);
    const scrolled = await cdp.eval(`document.querySelector(".iv-film").scrollTop`);
    const sorted = [...m.cells].sort((a, b) => a.mainPos - b.mainPos);
    let overlap = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].mainPos < sorted[i - 1].mainPos + sorted[i - 1].mainExtent + 3.4) overlap = true;
    }
    check(
      "[right/76/adaptive] 主轴可滚到深处、相邻单元不重叠（间距≈GAP）",
      scrolled > 700 && !overlap,
      `scrollTop=${scrolled} overlap=${overlap}`,
    );
  }

  cdp.close();
  cleanup();
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failedCount}/${results.length} 通过`);
  process.exit(failedCount ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(4);
});