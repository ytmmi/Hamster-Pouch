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
 * - 缩略图用 **7 个共享的 SVG data URL**（每档一个）：浏览器只解码 7 张、其余命中缓存，
 *   于是测到的差异来自 **DOM 与布局**，而不是"解码 5 万张图"——这正是本条要量化的部分。
 * - 媒体类型按序号轮转（图像 / 视频 / 音频）：D118 起「显示文件名」按媒体类型分项，
 *   因此**同一行会混着"显示 / 不显示文件名"的条目**，行高必须取行内最大值。
 *   类型周期 3 与宽高比周期 7 互质，任何一行（9 列）都必然三类混合、且类型×比例的组合不重复。
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

/** 媒体类型轮转顺序（媒体预览只认这三类，与 `MEDIA_FILTER_TYPES` 一致）。 */
export const MEDIA_TYPES = ["image", "video", "audio"] as const;

export type CorpusMediaType = (typeof MEDIA_TYPES)[number];

/** 每种媒体类型对应的文件扩展名：探针靠 `<img alt>` 的后缀区分类型，必须真实。 */
const EXTENSIONS: Record<CorpusMediaType, string> = {
  image: "jpg",
  video: "mp4",
  audio: "mp3",
};

/** 该条目使用的媒体类型（周期 3，与宽高比周期 7 互质）。 */
export function mediaTypeOf(index: number): CorpusMediaType {
  return MEDIA_TYPES[index % MEDIA_TYPES.length];
}

/** 合成一条文件条目（形状与 `file.query` 返回的 `FileItem` 一致）。 */
export function makeItem(index: number, sourceId: string) {
  // 宽高比按序号轮转（确定性：同一 index 永远同一档，便于 A/B 对比）。
  const bucket = index % RATIO_BUCKETS.length;
  const mediaType = mediaTypeOf(index);
  const serial = String(index).padStart(6, "0");
  return {
    id: `f${serial}`,
    source_id: sourceId,
    // 三类**共用同一个基名**（只有扩展名不同）：面板按文件名排序（缺省 `sortKey: "name"`），
    // 若把类型写进基名，排序会把同类聚成一段、一屏之内只剩一种类型，"混合类型行高"
    // 就永远测不到。共用基名 + 序号递增 ⇒ 排序结果就是序号顺序 ⇒ 每行必然三类混合。
    relative_path: `album/${String(bucket)}/photo_${serial}.${EXTENSIONS[mediaType]}`,
    media_type: mediaType,
    size: 1_000_000 + (index % 997) * 1000,
    mtime: "2026-01-01T00:00:00Z",
  };
}

/** 该条目使用的缩略图档位（与 `makeItem` 的轮转一致）。 */
export function bucketOf(index: number): number {
  return index % RATIO_BUCKETS.length;
}
