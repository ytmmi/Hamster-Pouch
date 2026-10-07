/**
 * 图像查看器：**预加载**的纯逻辑（取哪些邻居、取多少）。
 *
 * 与 `viewerPlacement.ts` / `viewerKeymap.ts` 同一条口径：**无框架依赖**，
 * 因此门禁 `pnpm check:panels` 可直接 import 做**行为**断言，组件不自己写
 * `for (let d = 1; d <= radius; d++)` 这类散落循环。
 *
 * ## 为什么要预加载
 *
 * 上一张 / 下一张的取图链路是「解析路径 →（HEIC/HEIF 还要后端**生成**全分辨率
 * JPEG）→ 浏览器读盘 + 解码」。其中 HEIC 全分辨率生成实测可达 **0.8 s**（102 MP
 * 样本，见缺陷 0019），完全落在用户按下方向键之后——于是每次换图都有可感知的等待。
 * 预加载把这段成本**提前**到用户还在看当前图的时候：
 *
 * 1. 解析并缓存邻居的 asset URL（`shared/imageUrl.ts`），换图时不再走 IPC；
 * 2. 触发后端 `preview.get`，让 HEIC/HEIF 的 JPEG **先生成好**（缓存命中即秒开）；
 * 3. 用 `new Image()` 把邻居的字节读进浏览器缓存，换图时只剩解码。
 *
 * ## 取哪些邻居
 *
 * 以当前项为中心、半径 `radius` 之内的**前/后各若干项**，顺序为
 * **近的优先、同距离时向前的优先**（顺放浏览比回看更常见，先给它带宽）。
 * **越界不环绕**（与 `stepIndex` 的换图口径一致：到头就停），
 * 因此末尾几项只会预加载「前一张」而不会绕回开头。
 *
 * 当前项**不在序列内**（`index < 0`，例如选中的图像不属于当前相册/源）时返回空：
 * 没有「邻居」可言，硬按序列首尾预加载只会加载用户看不到的图。
 */

/** 预加载半径下限：**0 = 关闭预加载**（不是「至少一张」）。 */
export const PRELOAD_RADIUS_MIN = 0;

/**
 * 预加载半径上限（3 → 最多 6 张邻居）。
 *
 * 上限存在的理由与 `scan_pool` 的像素预算同源：一张 100 MP 的图解码后可达数百 MB，
 * 无上限的预加载会把内存吃光。3 是「够快到看不出等待」与「内存可控」之间的取舍。
 */
export const PRELOAD_RADIUS_MAX = 3;

/** 非法/缺省半径的兜底值（缺省只预加载紧邻的前后各一张）。 */
export const PRELOAD_RADIUS_FALLBACK = 1;

/**
 * 夹紧预加载半径。
 *
 * 设置项声明只有 `kind` / `default`（没有 min/max 字段，`docs/spec/panel-standard.md`
 * 第 5.3 节），因此「多大算合法」由**用它的人**夹紧——与 `clampFilmstripSize` 同理。
 * 非数值回落兜底值；`0` 是**合法值**（关闭），不回落。
 */
export function clampPreloadRadius(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return PRELOAD_RADIUS_FALLBACK;
  return Math.min(PRELOAD_RADIUS_MAX, Math.max(PRELOAD_RADIUS_MIN, Math.round(num)));
}

/**
 * 需要预加载的序列下标，按**加载先后**排列。
 *
 * - 近的优先：`d = 1, 2, …` 逐圈向外；
 * - 同距离时**向前优先**：先 `index + d`，再 `index - d`；
 * - **越界不环绕**：`index + d >= total` 或 `index - d < 0` 直接跳过；
 * - `index < 0`（当前项不在序列内）、`total <= 0`、`radius = 0` → 返回空数组。
 */
export function preloadTargets(index: number, total: number, radius: number): number[] {
  if (total <= 0 || index < 0 || index >= total) return [];
  const limit = clampPreloadRadius(radius);
  const targets: number[] = [];
  for (let distance = 1; distance <= limit; distance++) {
    const ahead = index + distance;
    if (ahead < total) targets.push(ahead);
    const behind = index - distance;
    if (behind >= 0) targets.push(behind);
  }
  return targets;
}
