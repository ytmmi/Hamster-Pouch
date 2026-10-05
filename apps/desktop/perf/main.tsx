/**
 * 性能夹具入口：**原样渲染真实面板**，并把测量接口挂到 `window`。
 *
 * ## 为什么不是"另写一个简化版网格"
 *
 * 本条的收益是"DOM 单元数与条目总数脱钩"，只有**真实面板**（含虚拟化、观察器、
 * `content-visibility`、`ratioCache` 重排）才测得出。因此这里只做三件事：
 * 1. 用 Vite alias 把 `@tauri-apps/*` 换成本地桩（见 `vite.perf.config.ts`）；
 * 2. 提供 `AppContext`（`PerfAppProvider`）；
 * 3. 导入生产样式表（`app_ui/shared/styles.css`）与面板本体。
 *
 * ## 测量接口
 *
 * CDP 驱动通过 `window.__perf` 读取。**只读**——切换视图走真实的面板设置写入路径
 * （`settingOverrides` + `setting_get`），不直接操纵 React 内部状态。
 */

import { createRoot } from "react-dom/client";

import { MediaPreviewPanel } from "../src/app_ui/panels/MediaPreviewPanel";
import "../src/app_ui/shared/styles.css";
import { PerfAppProvider, type PerfContextHandle } from "./PerfApp";
import {
  ITEM_COUNT,
  PAGE_DELAY,
  PAGE_SIZE,
  perfState,
  settingOverrides,
} from "./stubs/tauri-core";
import { writePanelSetting } from "./settings";

const handle: PerfContextHandle = { statuses: [], dispatches: 0, selectedCount: 0 };

/** 夹具容器：给面板一个固定尺寸的宿主（模拟 dockview 面板）。 */
function PerfHarness(): JSX.Element {
  return (
    <PerfAppProvider handle={handle}>
      <div
        id="perf-host"
        style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}
      >
        <MediaPreviewPanel />
      </div>
    </PerfAppProvider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");
createRoot(container).render(<PerfHarness />);

/**
 * 测量接口（CDP 驱动用 `Runtime.evaluate` 读）。
 *
 * 全部是**即时计算**的只读量，不缓存：虚拟化的收益正体现在这些数随渲染变化。
 */
interface PerfApi {
  readonly itemCount: number;
  readonly pageSize: number;
  readonly pageDelay: number;
  /** 已发出的分页请求数 / 已交付条目 / 是否翻完。 */
  readonly paging: { requests: number; delivered: number; total: number; drained: boolean };
  /** 面板上报的状态文案（错误会出现在这里）。 */
  readonly statuses: string[];
  /** 切换视图（走真实设置写入路径）。 */
  setView(view: "tile" | "adaptive" | "masonry"): void;
  setImageSize(size: number): void;
  setShowFileName(on: boolean): void;
  /** 切成"文件名列表"模式 / 切回"预览图"模式。 */
  setMode(mode: "thumb" | "name"): void;
  /** 当前渲染出的 `.mp-cell` 数量（**本条的核心指标**）。 */
  cellCount(): number;
  /** 当前渲染出的行容器数量。 */
  rowCount(): number;
  /** 滚动容器。 */
  scroller(): HTMLElement | null;
  /** 滚动到某个比例（0..1）。 */
  scrollToFraction(fraction: number): void;
  /** 强制同步布局并返回耗时（ms）——量"布局对象还在不在"的代价。 */
  layoutCost(): number;
  /** 内容总高度（px）。 */
  contentHeight(): number;
  /** 偏移保真度：预测偏移 vs 实际布局位置。 */
  offsetFidelity(): { samples: number; maxDelta: number; worst: unknown };
  /** 盒模型保真度（只统计已解码单元）。 */
  cellHeightFidelity(): {
    pairs: number;
    decodedPairs: number;
    minGap: number | null;
    maxGap: number | null;
    maxHeightDelta: number;
    pending: number;
    worst: unknown;
  };
  /** 盒模型总账：下发的列高 vs 实际列高（要求全部渲染且全部解码时才能判定）。 */
  masonryTotalCheck(): unknown;
  /** 逐槽位诊断（预测高度 vs 实际高度 + 图片解码状态）。 */
  cellDiagnostics(): unknown[];
  /** 瀑布流每列：面板下发的高度 vs 列内已渲染内容的下界。 */
  columnFidelity(): { declared: number; renderedBottom: number; delta: number }[];
  /** 面板可见区域的 DOM 节点总数。 */
  domNodes(): number;
}

declare global {
  interface Window {
    __perf: PerfApi;
  }
}

const host = () => document.getElementById("perf-host");

function findScroller(): HTMLElement | null {
  return host()?.querySelector<HTMLElement>(".mp-grid, .mp-masonry, .mp-list") ?? null;
}

window.__perf = {
  itemCount: ITEM_COUNT,
  pageSize: PAGE_SIZE,
  pageDelay: PAGE_DELAY,
  get paging() {
    return {
      requests: perfState.pageRequests,
      delivered: perfState.delivered,
      total: perfState.total,
      drained: perfState.drained,
    };
  },
  statuses: handle.statuses,
  setView(view) {
    writePanelSetting("view", view);
  },
  setImageSize(size) {
    writePanelSetting("imageSize", size);
  },
  setShowFileName(on) {
    writePanelSetting("showFileName", on);
  },
  setMode(mode) {
    // 「预览图 / 文件名」是**面板内部 state**（`viewMode`），不是设置项；
    // 夹具通过点击工具条的对应按钮切换，走真实交互路径。
    const buttons = Array.from(host()?.querySelectorAll<HTMLButtonElement>(".mp-toggle button") ?? []);
    const target = buttons.find((b) => {
      const label = b.textContent ?? "";
      return mode === "name" ? label.includes("文件名") : label.includes("预览");
    });
    target?.click();
  },
  cellCount: () => host()?.querySelectorAll(".mp-cell").length ?? 0,
  rowCount: () => host()?.querySelectorAll(".mp-virtual-row").length ?? 0,
  /**
   * **偏移保真度**：面板算出的偏移 vs 浏览器实际布局位置。
   *
   * 这是虚拟化正确性的关键探针——"预测的位置"与"实际渲染的位置"必须一致，
   * 否则表现为单元错位/重叠/留白（而 DOM 数与耗时指标**完全看不出**这类错误）。
   *
   * 做法：每个槽位用 `getBoundingClientRect().top` 减容器的 `rect.top` 再加
   * `scrollTop`，得到它相对内容顶部的真实偏移，与 `transform` 里的预测值比较。
   */
  offsetFidelity() {
    const scroller = findScroller();
    if (!scroller) return { samples: 0, maxDelta: 0, worst: null };
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const slots = Array.from(scroller.querySelectorAll<HTMLElement>(".mp-masonry-slot"));
    let maxDelta = 0;
    let worst = null;
    for (const slot of slots) {
      // 预测值：`transform: translateY(<n>px)`。
      const m = /translateY\((-?[\d.]+)px\)/.exec(slot.style.transform);
      if (!m) continue;
      const predicted = Number(m[1]);
      const actual = slot.getBoundingClientRect().top - base;
      const delta = Math.abs(actual - predicted);
      if (delta > maxDelta) {
        maxDelta = delta;
        worst = { predicted, actual, delta };
      }
    }
    return { samples: slots.length, maxDelta, worst };
  },
  /**
   * **单元高度预测误差**：用"相邻槽位的实际视觉间距"反推。
   *
   * 绝对定位下每个槽位的顶边永远精确落在预测偏移上，因此**预测高度猜错不会体现在
   * 位置上**——只会让实际间距偏离预期的 `MEDIA_MASONRY_GAP`（8px）：
   * `实际间距 = 预测高度 + 8 − 实际高度`。间距 < 8 说明预测**偏大**（会重叠），
   * 间距 > 8 说明预测**偏小**（会留白）。
   *
   * 这比"拿槽位高度和自己比"有意义得多（后者恒为 0，什么也证明不了）。
   */
  /**
   * **盒模型保真度**：槽位预测高度 vs 已解码单元的实际高度，以及单元之间的真实间距。
   *
   * 必须只统计**图片已解码**（`img.complete && naturalWidth > 0`）的单元：
   * - 缩略图是 `loading="lazy"`，滚动时新进视口的图**尚未解码**，此时单元里是占位符
   *   （很矮）而槽位已按预测高度占位——量出来的"间距"很大，但那是**解码延迟**，
   *   不是布局错误；
   * - 只有解码完成后，单元高度才反映盒模型算得准不准。这才是能判定对错的量。
   *
   * 返回值同时给出两类信息，便于区分"布局错"与"还没解码"：
   * - `decoded*`：只含已解码单元（**判据**，期望间距 == gap、高度差 ≈ 0）；
   * - `pending`：当前未解码的单元数（诊断用）。
   */
  cellHeightFidelity() {
    const scroller = findScroller();
    const empty = {
      pairs: 0,
      decodedPairs: 0,
      minGap: null,
      maxGap: null,
      maxHeightDelta: 0,
      pending: 0,
      worst: null,
    };
    if (!scroller) return empty;

    let minGap = Infinity;
    let maxGap = -Infinity;
    let maxHeightDelta = 0;
    let decodedPairs = 0;
    let pending = 0;
    let worst = null;

    for (const col of Array.from(scroller.querySelectorAll<HTMLElement>(".mp-masonry-col"))) {
      const slots = Array.from(col.querySelectorAll<HTMLElement>(".mp-masonry-slot"));
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const img = slot.querySelector<HTMLImageElement>("img");
        const decoded = Boolean(img && img.complete && img.naturalWidth > 0);
        if (!decoded) {
          pending += 1;
          continue;
        }
        // 预测高度 vs 实际单元高度：盒模型算错就会在这里露出来。
        const cell = slot.querySelector<HTMLElement>(".mp-cell") ?? slot;
        const delta = Math.abs(slot.getBoundingClientRect().height - cell.getBoundingClientRect().height);
        if (delta > maxHeightDelta) {
          maxHeightDelta = delta;
          worst = {
            i,
            slotH: Number(slot.getBoundingClientRect().height.toFixed(1)),
            cellH: Number(cell.getBoundingClientRect().height.toFixed(1)),
            natural: `${img?.naturalWidth}x${img?.naturalHeight}`,
          };
        }
        // 相邻两个**都已解码**的单元之间的实际间距（期望 == MEDIA_MASONRY_GAP）。
        const next = slots[i + 1];
        const nextImg = next?.querySelector<HTMLImageElement>("img");
        const nextDecoded = Boolean(nextImg && nextImg.complete && nextImg.naturalWidth > 0);
        if (next && nextDecoded) {
          const gap = next.getBoundingClientRect().top - cell.getBoundingClientRect().bottom;
          decodedPairs += 1;
          if (gap < minGap) minGap = gap;
          if (gap > maxGap) maxGap = gap;
        }
      }
    }

    return {
      pairs: scroller.querySelectorAll(".mp-masonry-slot").length,
      decodedPairs,
      minGap: Number.isFinite(minGap) ? Number(minGap.toFixed(2)) : null,
      maxGap: Number.isFinite(maxGap) ? Number(maxGap.toFixed(2)) : null,
      maxHeightDelta: Number(maxHeightDelta.toFixed(2)),
      pending,
      worst,
    };
  },
  /**
   * **盒模型总账**：面板下发的列高（预测）vs 浏览器实际布局出的容器高度。
   *
   * 这是判定盒模型对不对的**决定性**探针，且不依赖"相邻两格都已解码"这种脆弱条件：
   * 只要把条目数压到**全部渲染且全部解码**（n 小、等足够久），列内就再没有估算成分——
   * 此时"预测的列高"与"浏览器排出来的列高"必须一致。不一致就是盒模型错了，
   * 且差值直接给出**系统性偏差**（每格差多少 × 每列多少格）。
   */
  masonryTotalCheck() {
    const scroller = findScroller();
    if (!scroller) return null;
    const cols = Array.from(scroller.querySelectorAll<HTMLElement>(".mp-masonry-col"));
    const declared = cols.map((c) => parseFloat(c.style.height) || 0);
    const actual = cols.map((c) => c.getBoundingClientRect().height);
    const imgs = Array.from(scroller.querySelectorAll<HTMLImageElement>("img"));
    return {
      columns: cols.length,
      slots: scroller.querySelectorAll(".mp-masonry-slot").length,
      imgs: imgs.length,
      imgsDecoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      maxDeclared: declared.length ? Math.max(...declared) : 0,
      maxActual: actual.length ? Math.max(...actual) : 0,
      scrollHeight: scroller.scrollHeight,
      declaredTotal: declared.reduce((a, b) => a + b, 0),
      actualTotal: Number(actual.reduce((a, b) => a + b, 0).toFixed(1)),
    };
  },
  /** 逐槽位诊断：预测高度 vs 实际高度 + 图片是否已解码。 */
  cellDiagnostics() {
    const scroller = findScroller();
    if (!scroller) return [];
    const out = [];
    const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    for (const col of Array.from(scroller.querySelectorAll<HTMLElement>(".mp-masonry-col"))) {
      const slots = Array.from(col.querySelectorAll<HTMLElement>(".mp-masonry-slot"));
      for (let i = 0; i < slots.length && out.length < 8; i++) {
        const slot = slots[i];
        const cell = slot.querySelector<HTMLElement>(".mp-cell");
        const thumb = slot.querySelector<HTMLElement>(".mp-thumb");
        const img = slot.querySelector<HTMLImageElement>("img");
        const sr = slot.getBoundingClientRect();
        const cr = r(cell);
        const tr = r(thumb);
        const ir = r(img);
        const prev = i > 0 ? slots[i - 1].getBoundingClientRect() : null;
        out.push({
          ratio: img && img.naturalHeight ? Number((img.naturalWidth / img.naturalHeight).toFixed(3)) : null,
          colW: Number(col.getBoundingClientRect().width.toFixed(1)),
          slotW: Number(sr.width.toFixed(1)),
          slotH: Number(sr.height.toFixed(1)),
          cellH: cr ? Number(cr.height.toFixed(1)) : null,
          thumbW: tr ? Number(tr.width.toFixed(1)) : null,
          thumbH: tr ? Number(tr.height.toFixed(1)) : null,
          imgW: ir ? Number(ir.width.toFixed(1)) : null,
          imgH: ir ? Number(ir.height.toFixed(1)) : null,
          nameH: (() => {
            const n = r(slot.querySelector(".mp-name"));
            return n ? Number(n.height.toFixed(1)) : 0;
          })(),
          gap: prev ? Number((sr.top - prev.bottom).toFixed(1)) : null,
        });
      }
    }
    return out;
  },
  /** 瀑布流每列：面板**下发的高度** vs 该列**全部条目的预测高度**。 */
  columnFidelity() {
    const scroller = findScroller();
    if (!scroller) return [];
    return Array.from(scroller.querySelectorAll<HTMLElement>(".mp-masonry-col")).map((col) => {
      const declared = parseFloat(col.style.height) || 0;
      // 列内已渲染槽位的最大偏移 + 该槽位高度 = 窗口内可见的下界（仅作诊断）。
      let renderedBottom = 0;
      for (const slot of Array.from(col.querySelectorAll<HTMLElement>(".mp-masonry-slot"))) {
        const m = /translateY\((-?[\d.]+)px\)/.exec(slot.style.transform);
        const top = m ? Number(m[1]) : 0;
        renderedBottom = Math.max(renderedBottom, top + slot.getBoundingClientRect().height);
      }
      return { declared, renderedBottom, delta: 0 };
    });
  },
  scroller: findScroller,
  scrollToFraction(fraction) {
    const el = findScroller();
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = max * Math.min(1, Math.max(0, fraction));
  },
  /**
   * **强制整棵子树重新布局**的耗时（ms）——本条"布局对象还在不在"的直接代价。
   *
   * 直接读 `offsetHeight` 在布局干净时是**免费**的（实测返回 0），量不到任何东西。
   * 必须先**弄脏布局**再强制刷新：这里改一下滚动容器的 `padding-left`（影响全子树
   * 的可用宽度 → 所有行都要重排），读 `offsetHeight` 逼浏览器同步算完，再还原。
   *
   * 于是这个数正比于"DOM 里有多少个需要参与布局的单元"：
   * 虚拟化之后只剩视口内几十个，未虚拟化则是全部条目。
   */
  layoutCost() {
    const scroller = findScroller();
    if (!scroller) return 0;
    const before = scroller.style.paddingLeft;
    const t0 = performance.now();
    scroller.style.paddingLeft = "1px";
    void scroller.offsetHeight; // 逼同步布局
    const t1 = performance.now();
    scroller.style.paddingLeft = before;
    void scroller.offsetHeight; // 还原并重新算净，避免污染后续测量
    return t1 - t0;
  },
  /** 内容总高度（px）——虚拟化下由占位层撑起，用来核对"滚动条长度是否稳定"。 */
  contentHeight: () => {
    const el = findScroller();
    return el ? el.scrollHeight : 0;
  },
  domNodes: () => host()?.querySelectorAll("*").length ?? 0,
};
