/**
 * 媒体预览面板：**游标翻页的纯逻辑**（无框架依赖、无 Tauri 依赖）。
 *
 * 从 `mediaPreviewData.ts` 拆出来（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 面板要把**整个来源**翻完（而不是只取第一页），这件事本身与 React / Tauri 无关，
 * 因此单独放这里——`pnpm check:panels` 可以**直接 import** 它并按行为断言
 * （与 `mediaPreviewView.ts` 同一口径：能被门禁加载的纯函数才守得住）。
 *
 * ## 为什么必须翻完
 *
 * 缺陷 0018 之前面板写死 `limit: 300` 且没有续页入口，第 301 张之后永远看不到。
 * 现在条目容器虚拟化（只渲染视口内的几十个单元），"装不下"不再是约束，
 * 于是取数目标从"装得下的有界一页"变成"**整个来源**"。
 *
 * ## 为什么是"后台翻完"而不是"滚到底再续页"
 *
 * 面板的排序是**前端**的，而后端 `file.query` 的排序键固定为
 * `(relative_path, source_id, id)` 升序（D78 键集游标，**没有排序参数**）。
 * 若边滚边取，则"按大小倒序"只能看到"已加载部分里最大的"，**排序结果会随滚动变化**。
 * 因此取数必须**先于**排序完成：首屏先把第一页交给界面（立即出图），
 * 其余页在后台继续翻，翻完后排序才代表全库。
 */

/**
 * 一页里的文件。
 *
 * 用结构类型而不是 `shared/types` 的 `FileItem`：本文件要能被门禁直接 import，
 * 少一层依赖就少一处"门禁加载不到"的可能，而这里的逻辑只关心 `id`。
 */
export interface MediaPreviewPageItem {
  id: string;
}

/** `file.query` 与 `album.members` 的**同形**返回体（D78 先例）。 */
export interface MediaPreviewPage<T extends MediaPreviewPageItem> {
  items: T[];
  /** `null` = 已到末页。 */
  nextCursor: string | null;
}

/** 取一页：`cursor` 为 `null` 表示取第一页；实现由调用方按数据来源注入。 */
export type MediaPreviewPageFetcher<T extends MediaPreviewPageItem> = (
  cursor: string | null,
) => Promise<MediaPreviewPage<T>>;

/**
 * 面板**一次请求**的页大小。
 *
 * 缺陷 0018 之前这里是写死的 `300`，而且**没有任何续页入口**。现在按游标翻到末页，
 * 页大小只影响往返次数（500 是后端 `album.members` 的默认值，`file.query` 缺省也是 500）。
 */
export const MEDIA_PREVIEW_PAGE_LIMIT = 500;

/**
 * 翻页的循环安全上限（**防御性**，不是产品上限）。
 *
 * 取数上限已放开为"整个来源"，所以这里**不能**用"条目数上限"兜底——那正是要取消的东西。
 * 但一个不透明的 `nextCursor` 若被后端写错（永远返回非 `null`），`while` 就会**永远翻下去**。
 * 两道闸门：① 同一个游标出现两次即停（游标必须**严格前进**）；② 页数上限。
 * 触顶时返回已取到的部分，不抛错——宁可少显示，也不要卡死或崩掉面板。
 */
export const MEDIA_PREVIEW_MAX_PAGES = 2000;

/**
 * 按 `id` 去重（保序：保留首次出现的那个）。
 *
 * 用 `Set` 而不是"逐项扫已累计数组"：5 万张时后者是 O(n²)（12.5 亿次比较），
 * 会把"翻页"变成比渲染更贵的事。
 */
export function dedupeById<T extends MediaPreviewPageItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** 翻页回调与取消判据。 */
export interface DrainPagesOptions<T extends MediaPreviewPageItem> {
  /**
   * 每取到一页就回调一次（首屏**立即**拿到第一页，不必等全部翻完）。
   * 参数是本页新增的条目与"目前累计到的全部条目"。
   */
  onPage?: (pageItems: T[], accumulated: T[]) => void;
  /** 取消判据：面板被卸载 / 来源切换 / 筛选变化时返回 `true`，翻页立即停止。 */
  isCancelled?: () => boolean;
}

/**
 * 把一个来源**按游标翻到末页**，返回全部条目（已按 `id` 去重）。
 *
 * 行为约定（`pnpm check:panels` 按此断言）：
 * - 第一页的 `cursor` 是 `null`，之后一律用上一页的 `nextCursor` 续页；
 * - `nextCursor === null` 即末页，停止；
 * - **游标必须严格前进**：同一个游标再次出现（后端写坏）即停，不无限翻；
 * - 页数触顶 [`MEDIA_PREVIEW_MAX_PAGES`] 即停（返回已取到的部分，不抛错）；
 * - `isCancelled()` 在**每页前后**各判一次：翻页途中取消不会再多发一次请求，
 *   也不会把已取消的一页交给界面。
 */
export async function drainPages<T extends MediaPreviewPageItem>(
  fetchPage: MediaPreviewPageFetcher<T>,
  options: DrainPagesOptions<T> = {},
): Promise<T[]> {
  const { onPage, isCancelled } = options;
  const accumulated: T[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < MEDIA_PREVIEW_MAX_PAGES; pageIndex++) {
    if (isCancelled?.()) break;

    const page = await fetchPage(cursor);

    // 去重后再累计：键集游标本不该重复，但库内容在翻页途中变动时这是廉价的保险。
    const added = page.items.filter((item) => !seenIds.has(item.id));
    for (const item of added) {
      seenIds.add(item.id);
      accumulated.push(item);
    }
    if (added.length > 0) {
      onPage?.(added, accumulated);
    }

    if (isCancelled?.()) break;

    const next = page.nextCursor;
    if (!next) break;
    // 游标必须严格前进：重复游标 = 后端异常，立即停手（否则是死循环）。
    if (seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return accumulated;
}
