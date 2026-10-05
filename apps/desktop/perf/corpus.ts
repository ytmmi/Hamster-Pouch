/**
 * 性能测量夹具：**合成语料**（缺陷 0018 P1-A 的端到端验证）。
 *
 * ## 为什么要合成语料
 *
 * 真实图库（`F:\billfish资源库\图片`，4717 张可解码）规模不够"数万张"，而本条的
 * 结论恰恰是"**DOM 单元数与条目总数脱钩**"——条目总数必须能拉到 5 万量级才测得出差别。
 * 合成语料只控制**条目数与宽高比分布**，不假装能替代真实解码成本：
 *
 * - 宽高比分布取自真实照片的常见档位（16:9 / 3:2 / 4:3 / 1:1 / 3:4 / 2:3 / 9:16），
 *   因为自适应视图的**断行**完全由宽高比驱动；
 * - 缩略图用 **8 个共享的 SVG data URL**（每档一个）：浏览器只解码 8 张、其余命中缓存，
 *   于是测到的差异来自 **DOM 与布局**，而不是"解码 5 万张图"——这正是本条要量化的部分。
 */

/** 宽高比档位（宽 / 高）：覆盖真实照片的主流比例。 */
export const RATIO_BUCKETS = [16 / 9, 3 / 2, 4 / 3, 1, 3 / 4, 2 / 3, 9 / 16] as const;

/** 一档宽高比对应的缩略图（SVG data URL，内在尺寸即该档比例）。 */
export function thumbDataUrl(bucket: number): string {
  const ratio = RATIO_BUCKETS[bucket % RATIO_BUCKETS.length];
  // 基准 100px：SVG 的内在宽高决定 `<img>` 的 naturalWidth/naturalHeight，
  // 也就是 `ratioCache` 量到并喂给自适应布局的那个值。
  const w = Math.round(100 * Math.max(1, ratio));
  const h = Math.round(100 * Math.max(1, 1 / ratio));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" fill="#3a6ea5"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 合成一条文件条目（形状与 `file.query` 返回的 `FileItem` 一致）。 */
export function makeItem(index: number, sourceId: string) {
  // 宽高比按序号轮转（确定性：同一 index 永远同一档，便于 A/B 对比）。
  const bucket = index % RATIO_BUCKETS.length;
  return {
    id: `f${String(index).padStart(6, "0")}`,
    source_id: sourceId,
    relative_path: `album/${String(bucket)}/photo_${String(index).padStart(6, "0")}.jpg`,
    media_type: "image",
    size: 1_000_000 + (index % 997) * 1000,
    mtime: "2026-01-01T00:00:00Z",
  };
}

/** 该条目使用的缩略图档位（与 `makeItem` 的轮转一致）。 */
export function bucketOf(index: number): number {
  return index % RATIO_BUCKETS.length;
}
