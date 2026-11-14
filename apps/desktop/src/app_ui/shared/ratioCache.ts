/**
 * 单元宽高比（`fileId → 宽 / 高`）的**唯一**缓存与通知口（D206）。
 *
 * ## 为什么只有一份
 *
 * 同一个事实曾被两处各存一份：媒体预览的平铺/自适应/瀑布流（`panels/mediaPreviewCell.tsx`）
 * 与图像查看器的胶片栏（`panels/imageviewer/viewerFilmstripLayout.ts`）。两边都是
 * 「`<img>` 解码后量一次 `naturalWidth / naturalHeight`，模块级存起来跨卸载复用」，
 * 于是同一张图在两个面板各解码一次、各存一份，切过去还要再等一次解码。
 * 现在读写都走这里：谁先量到，另一边立刻受益；口径（校验、LRU、版本号、通知）
 * 也只在一处定义。
 *
 * ## 三条纪律（原实现各占一条，合并后都要遵守）
 *
 * 1. **写入只有 `setCachedRatio`**：校验（有限正数）、同值不写、LRU 淘汰到上限、
 *    推进版本号、通知订阅者（携带 `fileId`）。绕过它直接写 Map 会让版本号与通知脱节。
 * 2. **批量播种静默**（`seedCachedRatios`）：索引里的 `files.width/height` 一次可能
 *    灌两万条，逐条通知就是两万次布局重算；调用方自己触发一次重算。
 * 3. **通知不合并**：一次滚动可能解码几十张，而消费方的成本口径不同（媒体预览按帧
 *    合并成一次重算，胶片栏逐条更新自己那一格）。合并属于知道成本的一侧。
 */

/** 缓存上限（LRU 淘汰；5 万条 × 一个 number 也只有几 MB，这是防御性的）。 */
export const RATIO_CACHE_MAX = 20000;

const ratios = new Map<string, number>();
/** 订阅表：写入即通知，携带写入的 `fileId`。 */
const listeners = new Set<(fileId: string) => void>();
/** 写入计数：面板把它放进 `useMemo` 依赖，量到新比例就重算行/列偏移。 */
let version = 0;

/**
 * 读缓存（**只读，不动 LRU 热度**）：读路径必须免写——早期版本读也刷新热度
 * （delete+set），窗口几何高频取比例时那是实测数毫秒/帧的纯浪费。
 * 热度由写入与单元挂载时的显式 `touchCachedRatio` 维护。
 */
export function getCachedRatio(fileId: string): number | undefined {
  return ratios.get(fileId);
}

/** 刷新热度（单元挂载时调用一次，标记"最近在用"；不通知订阅者）。 */
export function touchCachedRatio(fileId: string): void {
  const ratio = ratios.get(fileId);
  if (ratio === undefined) return;
  ratios.delete(fileId);
  ratios.set(fileId, ratio);
}

/** 写入（**唯一入口**）：非法值/同值忽略；超上限淘汰最旧；有效写入即通知。 */
export function setCachedRatio(fileId: string, ratio: number): boolean {
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  if (ratios.get(fileId) === ratio) return false;
  ratios.delete(fileId);
  ratios.set(fileId, ratio);
  trim();
  version += 1;
  for (const listener of [...listeners]) listener(fileId);
  return true;
}

/**
 * 批量播种（**静默**：不通知、不推进版本号）：把索引里已知的宽高比一次性写进缓存。
 *
 * 三条纪律：①**已有值不覆盖**（解码后量到的是这一张的真值，索引只是近似）；
 * ②不通知（一次 2 万条会打出 2 万条通知，调用方自己 `setState` 触发一次重算）；
 * ③仍走同一个 LRU 上限，避免批量写入把缓存撑爆。
 */
export function seedCachedRatios(entries: Iterable<readonly [string, number]>): number {
  let seeded = 0;
  for (const [fileId, ratio] of entries) {
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    if (ratios.has(fileId)) continue;
    ratios.set(fileId, ratio);
    seeded += 1;
  }
  trim();
  return seeded;
}

/** 清空（仓库切换后旧 fileId 恒失效；与 `thumbUrl` 缓存同一口径）。 */
export function clearCachedRatios(): void {
  ratios.clear();
  version += 1;
}

/** 当前版本号（面板放进依赖数组用）。 */
export function ratioCacheVersion(): number {
  return version;
}

/**
 * 订阅宽高比写入（返回退订函数）。通知可能高频，**消费方自行合帧**——
 * 媒体预览按帧合并成一次重算，胶片栏逐条更新。
 */
export function subscribeRatioChange(listener: (fileId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function trim(): void {
  while (ratios.size > RATIO_CACHE_MAX) {
    const oldest = ratios.keys().next().value;
    if (oldest === undefined) break;
    ratios.delete(oldest);
  }
}
