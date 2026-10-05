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
