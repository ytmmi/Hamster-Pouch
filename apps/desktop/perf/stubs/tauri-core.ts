/**
 * 性能夹具的 **Tauri 桩**：把 `@tauri-apps/api/*` 与 `plugin-dialog` 换成本地实现。
 *
 * 夹具用 Vite 的 `resolve.alias` 把这三个模块指到这里，因此**生产代码一行都不用改**
 * ——这是"测的是真面板"的前提：`MediaPreviewPanel` 及其全部子模块都是原样的。
 *
 * ## 语料与分页
 *
 * `file_query` 按 `(relative_path, source_id, id)` 升序的**游标**语义翻页（D78）：
 * 桩用序号当游标，返回与真实命令同形的 `{ items, nextCursor }`。
 * `?n=` 控制条目总数、`?page=` 控制页大小、`?delay=` 控制每页的人工延迟
 * （模拟 IPC 往返，用来复现"后台翻页途中"的时序）。
 *
 * ## 缩略图
 *
 * `thumb_get` 返回一个**标记路径**（`perf-thumb://<档位>`），由 `convertFileSrc`
 * 解析成对应的 SVG data URL。于是浏览器只需解码 7 张图（每档一张），
 * 测到的差异来自 **DOM 与布局**，而不是"解码 5 万张图"。
 */

import { bucketOf, makeItem, thumbDataUrl } from "../corpus";

const params = new URLSearchParams(window.location.search);

/** 合成条目总数（默认 5 万）。 */
export const ITEM_COUNT = Number(params.get("n") ?? 50000);
/** 页大小（与面板 `MEDIA_PREVIEW_PAGE_LIMIT` 无关，桩自己定）。 */
export const PAGE_SIZE = Number(params.get("page") ?? 500);
/** 每页人工延迟（ms），用来复现"后台还在翻页"的状态。 */
export const PAGE_DELAY = Number(params.get("delay") ?? 0);

export const PERF_REPO_ID = "perf-repo";
const PERF_SOURCE_ID = "perf-source";

/** 夹具暴露给 CDP 驱动的状态。 */
export interface PerfState {
  /** `file_query` 已发出的请求数。 */
  pageRequests: number;
  /** 已返回给前端的条目总数。 */
  delivered: number;
  /** 语料总数。 */
  total: number;
  /** 取数是否已翻完。 */
  drained: boolean;
}

export const perfState: PerfState = {
  pageRequests: 0,
  delivered: 0,
  total: ITEM_COUNT,
  drained: false,
};

/** 测试可覆盖的设置值（`setting_get` 从这里读）。 */
export const settingOverrides = new Map<string, unknown>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `invoke` 的桩：只实现夹具真正会走到的命令。 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "source_list":
      return {
        ok: true,
        data: [
          {
            id: PERF_SOURCE_ID,
            repo_id: PERF_REPO_ID,
            local_path: "E:\\perf",
            alias: null,
            parent_source_id: null,
            mounted: true,
            mounted_at: "2026-01-01T00:00:00Z",
          },
        ],
      } as T;

    case "file_query": {
      const cursor = (args?.cursor as string | null) ?? null;
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(ITEM_COUNT, start + PAGE_SIZE);
      perfState.pageRequests += 1;
      if (PAGE_DELAY > 0) await sleep(PAGE_DELAY);
      const items = [];
      for (let i = start; i < end; i++) items.push(makeItem(i, PERF_SOURCE_ID));
      perfState.delivered = end;
      const nextCursor = end < ITEM_COUNT ? String(end) : null;
      if (nextCursor === null) perfState.drained = true;
      return { ok: true, data: { items, nextCursor } } as T;
    }

    case "thumb_get": {
      const fileId = String(args?.fileId ?? "");
      const index = Number(fileId.replace(/^f/, ""));
      return { ok: true, data: `perf-thumb://${bucketOf(index)}` } as T;
    }

    case "setting_get": {
      const key = String(args?.key ?? "");
      return { ok: true, data: { value: settingOverrides.get(key) ?? null } } as T;
    }

    // 设置写入、任务控制等：夹具里一律当成功（面板不会因为桩而报错）。
    default:
      return { ok: true, data: null } as T;
  }
}

/** `convertFileSrc` 的桩：把标记路径解析成该档位的 SVG data URL。 */
export function convertFileSrc(path: string): string {
  const match = /^perf-thumb:\/\/(\d+)$/.exec(path);
  if (match) return thumbDataUrl(Number(match[1]));
  // 条目自身的绝对路径（`mediaPreviewData` 拼出来的）：夹具不用于 <img>。
  return path;
}
