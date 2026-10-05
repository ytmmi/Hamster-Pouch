/**
 * 媒体预览面板：**视图模式 / 排序的取值域与纯函数**。
 *
 * 本文件**无框架依赖**（不 import React / Tauri），因此：
 *
 * 1. 面板只消费这里的判定、排序与列分配函数，不自己写散落的 `if (key === "name")` 分支；
 * 2. 门禁 `pnpm check:panels` 可**直接导入**它，断言面板注册表里的 `select` 候选、
 *    四种排序键的行为与瀑布流列分配（声明与实现漂移会被当场拦下）。
 *
 * 取值域与 `packages/config/src/panels.ts` 的 `media.settings` 一一对应，
 * 也镜像到 `crates/hp-core/src/setting_registry.rs` 的 `PANEL_SETTING_DECLS`。
 */

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；也是面板设置的命名空间）。 */
export const MEDIA_PANEL_ID = "media";

/**
 * 「预览图」模式下的**视图**（面板右上角下拉切换；仅在该模式下有效）：
 *
 * - `tile`（平铺）：单元格宽度**固定**（由图片尺寸控制），缩略图统一**方形并裁剪填满**
 *   （`cover`），排成整齐网格；
 * - `adaptive`（自适应，缺省）：**逐行两端对齐**——一行内各格**等高**，高度由该行图片的
 *   宽高比之和反推（宽度按宽高比分配，行满即左右边缘都顶到面板两边），**不同行的高度
 *   不必相同**；
 * - `masonry`（瀑布流）：**列宽固定**（与平铺同宽）、**行高随图像宽高比**变化，列内纵向堆叠。
 *
 * 三者的**图片尺寸**是同一个值（CSS 变量 `--mp-image-size`）：平铺 / 瀑布流落在**宽度**上
 * （两者因此永远同宽、列数也一致），自适应落在**目标行高**上。取值域见 `MEDIA_IMAGE_SIZE_*`。
 *
 * 与图像查看器胶片栏的 `filmstripView` 同口径：`tile` = 统一方形 + 裁剪填满；
 * `adaptive` = 按图像自身宽高比完整显示（胶片栏固定的是**厚度**，这里由每行反推高度）。
 */
export const MEDIA_VIEW_MODES = ["tile", "adaptive", "masonry"] as const;
export type MediaViewMode = (typeof MEDIA_VIEW_MODES)[number];

/** 排序键（面板右上角「排序」下拉）：名称 / 时间 / 大小 / 类型。 */
export const MEDIA_SORT_KEYS = ["name", "time", "size", "type"] as const;
export type MediaSortKey = (typeof MEDIA_SORT_KEYS)[number];

/** 排序方向（下拉里由一条横线与排序键分隔）：正序（缺省）/ 倒序。 */
export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export function isMediaViewMode(value: unknown): value is MediaViewMode {
  return typeof value === "string" && (MEDIA_VIEW_MODES as readonly string[]).includes(value);
}

export function isMediaSortKey(value: unknown): value is MediaSortKey {
  return typeof value === "string" && (MEDIA_SORT_KEYS as readonly string[]).includes(value);
}

export function isSortDirection(value: unknown): value is SortDirection {
  return typeof value === "string" && (SORT_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * 排序只用到这四个字段。
 *
 * 这里用**结构类型**而不是 `shared/types` 的 `FileItem`：本文件要能被门禁直接 import，
 * 少一层依赖就少一处"门禁加载不到"的可能，且比较函数本来也只关心这四个字段。
 */
export interface SortableFile {
  relative_path: string;
  size: number;
  mtime: string;
  media_type: string;
}

/** 取路径的最后一段（文件名）。面板的条目名与重命名默认值共用这一份。 */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * `mtime` → 可比较的数值。
 *
 * 索引里的 `mtime` 是 **epoch 纳秒十进制字符串**（`hp-scanner` 的 `file_stat`），
 * 这里也接受 `Date.parse` 认得的字符串；解析不出时返回 `0`（不影响排序结果，
 * 也**不抛错**——列出文件不该因为一个坏时间戳而失败）。
 */
export function mtimeValue(raw: string | null | undefined): number {
  const text = String(raw ?? "").trim();
  if (!text) return 0;
  const ms = /^\d+$/.test(text) ? Number(text) / 1e6 : Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
}

/** 名称比较：按**文件名**、数字感知（`img2` < `img10`）、大小写不敏感。 */
function compareByName(a: SortableFile, b: SortableFile): number {
  const nameA = fileName(a.relative_path);
  const nameB = fileName(b.relative_path);
  const byName = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
  if (byName !== 0) return byName;
  // 同名（不同源/目录）时用完整相对路径兜底：**顺序必须确定**，
  // 否则同一次查询的两次渲染可能给出不同次序（列表看起来在抖）。
  return a.relative_path.localeCompare(b.relative_path, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * 四键比较（都是 `asc` 方向；方向由 [`sortFiles`] 取反）。
 *
 * 时间 / 大小 / 类型相同时**再按名称**排：否则组内顺序由查询顺序决定，
 * 表现为"按类型排序后，同类文件之间忽前忽后"。
 */
export function compareFiles(a: SortableFile, b: SortableFile, key: MediaSortKey): number {
  switch (key) {
    case "time": {
      const byTime = mtimeValue(a.mtime) - mtimeValue(b.mtime);
      return byTime !== 0 ? byTime : compareByName(a, b);
    }
    case "size": {
      const bySize = (a.size ?? 0) - (b.size ?? 0);
      return bySize !== 0 ? bySize : compareByName(a, b);
    }
    case "type": {
      const byType = String(a.media_type ?? "").localeCompare(String(b.media_type ?? ""));
      return byType !== 0 ? byType : compareByName(a, b);
    }
    case "name":
    default:
      return compareByName(a, b);
  }
}

/**
 * 排序一份文件列表（**纯函数**：返回新数组，不改动入参，也不改查询顺序的来源）。
 *
 * **作用域口径**：后端的排序键是分页游标的基础（`(relative_path, source_id, id)` 升序，D78），
 * 加排序参数要改命令契约与游标语义，不在本面板的范围内——所以这里是**前端排序**。
 *
 * 因此"排序代表全库"的前提是**取数已翻完全部页**：面板先把来源按游标翻到末页
 * （`mediaPreviewPaging.ts`，首屏第一页即渲染、其余页后台继续），再对**全量**排序。
 * 翻页途中 `files` 只是已取到的部分，此时的顺序只代表这一部分——面板用 `loading` 提示，
 * 不假装它已经是全库顺序。
 */
export function sortFiles<T extends SortableFile>(
  files: readonly T[],
  key: MediaSortKey,
  dir: SortDirection,
): T[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...files].sort((a, b) => sign * compareFiles(a, b, key));
}

/**
 * 图片宽高比（宽 / 高）；尺寸不可用时回落 `fallback`。
 *
 * **为什么必须有个兜底**：自适应视图把宽高比直接喂给 `flex-grow` / `flex-basis`，
 * 一旦算出 `NaN` / `0` / 负数，那一行的宽度分配就整个作废（格塌成 0 宽、行又不齐）。
 * 索引里**没有**图片尺寸（`media_info_json` 只覆盖视频），所以宽高比只能等 `<img>` 解码后
 * 量 `naturalWidth / naturalHeight`——量之前用 `DEFAULT_CELL_RATIO` 占位。
 */
export function imageRatio(
  width: number,
  height: number,
  fallback: number = DEFAULT_CELL_RATIO,
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }
  return width / height;
}

/** 解码前的占位宽高比（1:1）——解码后按真实值重排一次。 */
export const DEFAULT_CELL_RATIO = 1;

/**
 * 音频的卡片宽高比：音频**没有**宽高比可用（缩略图是波形图，尺寸自定），
 * 给它一个 3:2 的卡片形状，免得在自适应视图里变成一张方块。
 */
export const AUDIO_CARD_RATIO = 1.5;

/** 视图的容器修饰类（样式表 `.mp-view-tile` / `.mp-view-adaptive` 与它同名）。 */
export function mediaViewClass(view: MediaViewMode): string {
  return `mp-view-${view}`;
}

/**
 * 「按在别处 → 关掉右上角下拉」的判定：**按钮内**或**弹出层内**都不算"别处"。
 *
 * 两个入参由调用方按 DOM 归属判定（按钮用 `ref.contains`，弹出层用
 * `target.closest(".context-menu")`——`ContextMenu` 是 portal 到 `document.body` 的，
 * 弹出层的 DOM **不在按钮里**）。
 *
 * 为什么把它单独写成函数：这是**修过的缺陷**——只排除按钮时，按在选项上的 `mousedown`
 * 会先把下拉关掉并卸载弹出层，选项的 `click` 根本不会发生，表现为"下拉能开、选了什么
 * 都没反应"。把它收敛成一个可断言的纯函数，`pnpm check:panels` 就能守住
 * `(按钮外, 弹出层内) === 不关闭` 这条不变量，谁也不能"化简"回 `!inButton`。
 */
export function shouldCloseDropdown(inButton: boolean, inPopup: boolean): boolean {
  return !inButton && !inPopup;
}

/** 瀑布流列间距（px；与样式表 `.mp-masonry` / `.mp-masonry-col` 的 `gap` 一致）。 */
export const MASONRY_GAP = 8;

/**
 * 图片尺寸（px）：面板右上角**滑条**与面板设置 `imageSize` 的共用取值域。
 *
 * 语义随视图变化（见 `MEDIA_VIEW_MODES`）：平铺 / 瀑布流 = **单元格宽度**，
 * 自适应 = **行高**。范围由面板夹紧——设置声明只有 `kind` / `default`（没有 min/max），
 * 与 `imageviewer.filmstripSize` 同一处置。
 */
export const MEDIA_IMAGE_SIZE_MIN = 80;
export const MEDIA_IMAGE_SIZE_MAX = 400;
export const MEDIA_IMAGE_SIZE_FALLBACK = 160;
/** 滑条的步进（只是拖动量化；设置里手输的数字不吸附到步进）。 */
export const MEDIA_IMAGE_SIZE_STEP = 8;

/**
 * 夹紧图片尺寸（非数值 / 非正数回落兜底值；四舍五入到整像素）。
 *
 * 与 `viewerPlacement.clampFilmstripSize` 同款：`numberInput` 允许用户输入 0 或 100000，
 * 任由它把布局压塌或撑爆是**面板的责任**，不是声明的责任。
 */
export function clampImageSize(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return MEDIA_IMAGE_SIZE_FALLBACK;
  return Math.min(MEDIA_IMAGE_SIZE_MAX, Math.max(MEDIA_IMAGE_SIZE_MIN, Math.round(num)));
}

/**
 * 瀑布流列数：按容器宽度与单元格宽度算（**至少 1 列**）。
 *
 * 公式与 CSS `repeat(auto-fill, <单元格宽度>)` 的"最多放几列"完全一致
 * （`n * w + (n - 1) * gap <= 容器宽度`），因此**平铺与瀑布流永远得到相同的列数**
 * ——两者单元格同宽是用户明确要求的（此前一个写死 112px、一个写死 180px，看起来差太多）。
 *
 * 宽度不可用（首帧 `clientWidth` 为 0、面板还没测量）时返回 1，
 * 否则会渲染出 0 列——界面一片空白，看起来像"瀑布流坏了"。
 */
export function masonryColumnCount(
  containerWidth: number,
  cellWidth: number = MEDIA_IMAGE_SIZE_FALLBACK,
  gap: number = MASONRY_GAP,
): number {
  const width = Number.isFinite(containerWidth) ? containerWidth : 0;
  if (width <= 0) return 1;
  const cell = Math.max(1, cellWidth);
  const spacing = Math.max(0, gap);
  return Math.max(1, Math.floor((width + spacing) / (cell + spacing)));
}

/**
 * 把条目按**序号**分配到 `columns` 列（第 `i` 项进第 `i % columns` 列）。
 *
 * 为什么按序号，而不是"塞进当前最矮的那列"：后者要先知道每张图的高度，而缩略图是
 * **解码之后**才知道宽高比的，于是每张图加载完成都要重排列、滚动中元素不断跳位。
 * 按序号分配与高度无关：**从左到右、从上到下的阅读顺序**与排序结果一致，
 * 同一次排序渲染出的布局也是稳定的（只随列数变化）。
 *
 * 返回的数组长度**恒等于 `columns`**（空列保留），这样列宽在条目多少时都不变。
 */
export function distributeColumns<T>(items: readonly T[], columns: number): T[][] {
  const count = Math.max(1, Math.floor(columns) || 1);
  const out: T[][] = Array.from({ length: count }, (): T[] => []);
  items.forEach((item, index) => {
    out[index % count].push(item);
  });
  return out;
}
