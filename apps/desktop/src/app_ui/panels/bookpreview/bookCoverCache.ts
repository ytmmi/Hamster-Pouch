/**
 * 图书封面的**覆盖**缓存与读取（用户自设的颜色 / 图片）。
 *
 * 用户口径（2026-10-09）："txt 右键可以更换封面颜色或自定义图片"。
 *
 * ## 为什么是批量取 + 模块级缓存
 *
 * 面板一页可能列几百本，逐本发一次 IPC 就是几百次往返。因此：
 * - 面板在**取完数之后**按这一页的 id 批量取一次（`loadBookCovers`）；
 * - 结果放模块级缓存，单元渲染时同步读（`coverOverrideOf`），不再各发一次请求。
 *
 * ## 改完之后怎么立刻生效
 *
 * 设置/清除封面后调用 `invalidateBookCovers(repoId)` 清掉该仓库的缓存，
 * 面板随即重新批量拉一次——**不做乐观更新**：落盘与落库都可能失败
 * （图片格式不认、文件被占用），乐观更新会让失败时界面与库不一致。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../../shared/api";

/** 一个文件的封面覆盖（已转成可直接渲染的形式）。 */
export interface BookCoverOverride {
  /** `color` 时是 `#rrggbb`；`image` 时是可直接放进 `<img src>` 的 asset URL。 */
  value: string;
  kind: "color" | "image";
}

/** `repoId → (fileId → 覆盖)`。按仓库分开存：不同仓库的 fileId 不互通。 */
const coverCache = new Map<string, Map<string, BookCoverOverride>>();
/**
 * `repoId → 已经**请求过**的 fileId 集合`。
 *
 * 为什么不能只用"一个 in-flight Promise"去重：面板是**翻页**取数的，
 * `items` 会一轮轮变长，于是 `loadBookCovers` 会被反复调用且**每次带的 id 更多**。
 * 若按仓库整体去重，第二次调用会直接返回上一次的 pending，**新一页的封面永远取不到**
 * （表现为"往下翻，新出现的书封面都是默认的"）。因此这里按 **id 粒度**记账：
 * 只请求"还没请求过"的那些，已请求过的直接跳过。
 *
 * 失败时把这一批 id **从记账里移除**，让下次调用能重试（否则一次抖动会把那批书
 * 永久钉在"没有封面"上）。
 */
const requestedIds = new Map<string, Set<string>>();

/**
 * 缓存**版本号**：每次批量拉取落地（或失效）就自增。
 *
 * 为什么需要它：单元渲染时是**同步**读 `coverOverrideOf` 的，而批量拉取是**异步**的
 * ——拉回来的那一刻没有任何东西会让已经渲染的单元重画。面板把这个版本号读进 state
 * 并放进依赖，拉完就重渲一次（与媒体预览的 `ratioCache` 版本号同一手法：
 * 面板是唯一消费方，一个数字足够，且能被门禁按行为断言）。
 */
let coverCacheVersion = 0;
const listeners = new Set<() => void>();

/** 当前版本号（面板放进依赖数组用）。 */
export function getBookCoverVersion(): number {
  return coverCacheVersion;
}

/** 订阅封面缓存变化；返回退订函数。 */
export function subscribeBookCovers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 推进版本号并通知订阅者（缓存写入 / 失效的唯一出口）。 */
function bumpVersion(): void {
  coverCacheVersion += 1;
  for (const listener of [...listeners]) listener();
}

/** 同步读某本书的封面覆盖；没有（或还没拉到）返回 `null`。 */
export function coverOverrideOf(repoId: string | null, fileId: string): BookCoverOverride | null {
  if (!repoId) return null;
  return coverCache.get(repoId)?.get(fileId) ?? null;
}

/**
 * 批量拉取一组文件的封面覆盖（带缓存与 in-flight 去重）。
 *
 * **结果按 `fileId` 合并进该仓库的映射**，而不是整表替换：面板是**翻页**取数的
 * （`file.query` 游标），第二次批量请求只带新一页的 id——整表替换会把上一页已经
 * 拉到的封面全丢掉，表现为"往下翻一点，上面的书封面又变回默认了"。
 *
 * 失败**降级为空**（当作都没有覆盖）：封面读不到不该让面板进错误态，
 * 回落默认封面即可——与 `book.meta` 的"坏书降级"同一口径。
 */
export function loadBookCovers(repoId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return Promise.resolve();
  const done = requestedIds.get(repoId) ?? new Set<string>();
  // 只请求"还没请求过"的 id（见 `requestedIds` 的说明：翻页时每次带的 id 更多）。
  const fresh = fileIds.filter((id) => !done.has(id));
  if (fresh.length === 0) return Promise.resolve();
  for (const id of fresh) done.add(id);
  requestedIds.set(repoId, done);

  return api
    .bookCovers(repoId, fresh)
    .then((items) => {
      const map = coverCache.get(repoId) ?? new Map<string, BookCoverOverride>();
      for (const item of items) {
        // 图片的 `value` 是后端给的**绝对路径**，这里转一次 asset URL；
        // 颜色原样使用（`#rrggbb` 本身就是合法 CSS 颜色）。
        map.set(item.file_id, {
          kind: item.kind === "image" ? "image" : "color",
          value: item.kind === "image" ? convertFileSrc(item.value) : item.value,
        });
      }
      coverCache.set(repoId, map);
      bumpVersion();
    })
    .catch(() => {
      // 失败：把这一批 id 从记账里摘掉，让下次调用能重试
      // （否则一次抖动会把那批书永久钉在"没有封面"上）。
      const current = requestedIds.get(repoId);
      if (current) {
        for (const id of fresh) current.delete(id);
      }
    });
}

/** 清掉某仓库的封面缓存（设置 / 清除封面之后调用，强制下次重新拉取）。 */
export function invalidateBookCovers(repoId: string): void {
  coverCache.delete(repoId);
  // 记账也要清：改完封面必须能重新问一次后端（否则那一本被记为"已请求过"）。
  requestedIds.delete(repoId);
  bumpVersion();
}

/** 清空全部缓存（仓库切换 / 诊断用）。 */
export function clearBookCoverCache(): void {
  coverCache.clear();
  requestedIds.clear();
  bumpVersion();
}
