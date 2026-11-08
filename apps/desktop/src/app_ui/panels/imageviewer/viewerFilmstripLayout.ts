/**
 * 图像查看器胶片栏的**窗口与定位纯几何**（无框架依赖，门禁直接 import 断言）。
 *
 * ## 为什么窗口必须有界（缺陷 0018 余留项 / D146）
 *
 * 序列上限取消后来源可达数万张。旧胶片栏是"**只追加、不回收**"的窗口
 * （`[0, end)`，滚近末端 +80）：键盘导航到第 5 万张要把前 5 万个单元全部挂进
 * DOM，滚回开头也不卸载——上限取消后这条路径就是新的性能悬崖。
 * 改为**以视口为中心的对称窗口**（媒体预览虚拟化的同一取向）：
 * 只渲染滚动位置附近的几十个单元，前后各留同样的余量，滚出去的单元卸载、
 * 滚回来再挂载。窗口滑动不改变单元的绝对定位，滚动锚点不跳。
 *
 * ## 为什么定位可以纯计算
 *
 * 单元主轴尺寸 = 交叉轴外框 × 主轴比例（横栏 ×r、竖栏 ÷r，见
 * `filmstripCellExtent`；观感基准 = 76e073a 原视图的 border-box
 * `aspect-ratio`），未解码的单元按 1:1 占位——与旧实现"未解码先按方形"
 * 同一占位口径，解码后从共享宽高比缓存取真值。于是"当前项居中"不再需要查询 DOM
 * （旧实现要求当前项已挂载才能 `querySelector`，窗口有界后深处当前项
 * 根本不在 DOM 里），直接按几何算出滚动目标。
 */

/** 胶片栏单元间距（px，几何公式的单元间留白；由绝对定位的偏移承担）。 */
export const FILMSTRIP_GAP = 4;
/** 容器内边距（px，与 `.iv-film` 的 `padding` 同值；两侧各一份）。 */
export const FILMSTRIP_PADDING = 4;
/** 容器边框（px，与 `.iv-film` 的 `border` 同值；两侧各一份）。 */
export const FILMSTRIP_BORDER = 1;
/**
 * 单元盒在主轴上的固定开销（px）：`border-box` 下 = 内边距 2×2 + 边框 1×2。
 * 与 styles.css `.iv-film-cell` 同值（门禁对样式表逐项对账）。
 */
export const FILMSTRIP_CELL_CHROME = 6;
/**
 * 窗口余量：视口两侧各多渲染约 3 个单元位（按占位比例 1:1 估）。
 * 对称是硬要求——只向下预渲染就是缺陷 0025 的"向上不预加载"形态。
 */
export const FILMSTRIP_WINDOW_MARGIN = 3;
/**
 * 单次渲染的单元数上限（异常输入护栏：视口尺寸读错时不至于挂出几千个单元）。
 * 正常量级：400px 厚度 + 1:1 占位 ≈ 十几个单元，远够不到它。
 */
export const FILMSTRIP_WINDOW_MAX = 200;
/** 宽高比缓存上限（LRU 淘汰；5 万条 × 一个 number 也只有几 MB，这是防御性的）。 */
export const FILMSTRIP_RATIO_CACHE_MAX = 20000;

/** 渲染窗口（半开区间 `[start, end)`，已夹紧到 `[0, total]`）。 */
export interface FilmstripWindow {
  start: number;
  end: number;
  /** `start` 单元的主轴起点偏移（px）：消费方从这里续算，不必再从 0 扫。 */
  startOffset: number;
  /**
   * 内容总主轴长度（px，含首尾内边距）：全部占位 + 已缓存修正一次算出
   * （`FilmstripDeltaIndex.deltaBefore(total)`），滚动帧里不做全量遍历。
   * 未解码单元按 1:1 占位，因此是估计值、随浏览收敛（与媒体预览同一口径）。
   */
  totalExtent: number;
}

/**
 * 单元的**主轴占位比例**：平铺恒为方形；自适应取缓存宽高比，未解码按 1:1。
 * 非法值（0 / 负 / NaN / Infinity）一律回落 1——占位可以不准，不能塌成 0。
 */
export function filmstripCellRatio(
  view: "adaptive" | "tile",
  cachedRatio: number | undefined,
): number {
  if (view === "tile") return 1;
  if (typeof cachedRatio !== "number" || !Number.isFinite(cachedRatio) || cachedRatio <= 0) {
    return 1;
  }
  return cachedRatio;
}

/**
 * 单元在**主轴**上的外尺寸（px，border-box，不含间距）。
 *
 * **观感基准 = 76e073a 的原视图**（用户口径，缺陷 0041 / D147）：原实现是
 * flex stretch 撑满交叉轴 + 内联 `aspect-ratio: r`（作用于 **border-box**），
 * 主轴由外框比例推出。本函数复刻同一几何：
 * - 横栏（主轴 = 宽）：`crossSize × r`；
 * - 竖栏（主轴 = 高）：`crossSize / r`（主轴是高，宽高比要取倒数——
 *   D146 的窗口化实现恒乘 r，把竖栏的横图变高格、竖图变扁格）。
 * **不加/减单元盒开销**：原视图的 `aspect-ratio` 就作用于外框，内容盒
 * 因 padding/border 产生的轻微 contain 留边是原观感的一部分，不是缺陷。
 * 极小值夹紧到单元盒开销（外框不能塌得比 padding+border 还小）。
 *
 * **`crossSize` 必须是容器实测客户区减两侧内边距**（`clientWidth`/`clientHeight`
 * − `FILMSTRIP_PADDING × 2`），**不是**厚度设置 `size` 推算（缺陷 0041）：
 * 全局滚动条是经典占位滚动条（`::-webkit-scrollbar` 6px），出现时从客户区
 * 扣掉一条；边框又被"贴面板边"规则去掉一侧。原视图靠 flex stretch **自动**
 * 跟随客户区收窄，窗口化后改由本函数的实测入参承接同一行为——按 `size`
 * 推算会让单元交叉轴溢出轨道被裁、还凭空多出一条交叉轴滚动条。
 */
export function filmstripCellExtent(
  crossSize: number,
  ratio: number,
  vertical: boolean,
): number {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const mainRatio = vertical ? 1 / safeRatio : safeRatio;
  const safeCross = Number.isFinite(crossSize) ? Math.max(0, crossSize) : 0;
  return Math.max(FILMSTRIP_CELL_CHROME, safeCross * mainRatio);
}

/**
 * 从容器**厚度设置**推算交叉轴内容区尺寸（px）——**仅供首帧/未测量时占位**。
 * 布局完成后必须换成实测口径（`clientWidth`/`clientHeight` − padding×2），
 * 否则滚动条一出现就回到缺陷 0041 的形态。此函数把"理想盒"的推算收敛在
 * 一处：厚度 − 两侧内边距 − 两侧边框（实际边框可能被贴边规则去掉一侧、
 * 滚动条可能再扣 6px，理想值只是占位，不是事实）。
 */
export function filmstripCrossSizeFallback(size: number): number {
  return Math.max(0, size - FILMSTRIP_PADDING * 2 - FILMSTRIP_BORDER * 2);
}

/**
 * 窗口几何的**已缓存修正**（前缀和，Fenwick 树）：`delta(i) = 真实外尺寸 −
 * 占位外尺寸`，只对已解码过的单元非零。窗口/居中公式按"全部占位 + 前缀修正"
 * 计算，于是滚动帧里不必逐项查 5 万次缓存（实测 9ms/帧 → <0.1ms/帧）。
 *
 * 树按**序列下标**建（换序列即重建，O(n) 一次）；缓存写入经 `update`
 * 增量维护 O(log n)。比例缓存本体按 fileId 存（跨序列保留），两者经
 * `bindSequence` 对齐——同一个事实（比例）仍只有一处存储，树只是它的索引。
 */
export class FilmstripDeltaIndex {
  private tree: number[] = [0];
  private n = 0;
  private crossSize = 0;
  private vertical = false;
  private idToIndex = new Map<string, number>();
  private applied: number[] = [];

  /** 绑定序列（换来源/排序重排/实测交叉轴变化/换边即调）：按缓存现值重建前缀修正。 */
  bindSequence(ids: readonly string[], crossSize: number, vertical: boolean): void {
    this.crossSize = crossSize;
    this.vertical = vertical;
    this.n = ids.length;
    this.tree = new Array(this.n + 1).fill(0);
    this.applied = new Array(this.n).fill(0);
    this.idToIndex = new Map();
    const placeholder = filmstripCellExtent(crossSize, 1, vertical);
    for (let i = 0; i < this.n; i++) {
      const id = ids[i] as string;
      this.idToIndex.set(id, i);
      const ratio = getCachedFilmstripRatio(id);
      if (ratio === undefined) continue;
      const delta = filmstripCellExtent(crossSize, ratio, vertical) - placeholder;
      this.applied[i] = delta;
      this.add(i + 1, delta);
    }
  }

  /** 缓存写入后增量更新（fileId 不在当前序列里则忽略）。 */
  update(fileId: string): void {
    const i = this.idToIndex.get(fileId);
    if (i === undefined) return;
    const ratio = getCachedFilmstripRatio(fileId);
    if (ratio === undefined) return;
    const delta =
      filmstripCellExtent(this.crossSize, ratio, this.vertical) -
      filmstripCellExtent(this.crossSize, 1, this.vertical);
    const prev = this.applied[i] as number;
    if (delta === prev) return;
    this.applied[i] = delta;
    this.add(i + 1, delta - prev);
  }

  /** 下标 < index 的累计修正（O(log n)）。 */
  deltaBefore(index: number): number {
    let sum = 0;
    for (let i = Math.min(index, this.n); i > 0; i -= i & -i) sum += this.tree[i] as number;
    return sum;
  }

  private add(i: number, delta: number): void {
    for (; i <= this.n; i += i & -i) this.tree[i] = (this.tree[i] as number) + delta;
  }
}

/**
 * 以视口为中心的对称渲染窗口 + 内容总长。
 *
 * `scroll` 是主轴滚动偏移，`viewport` 是容器主轴客户区尺寸，`crossSize` 是
 * **交叉轴内容区实测尺寸**（见 `filmstripCellExtent`；未测量时可用
 * `filmstripCrossSizeFallback` 占位）。窗口覆盖
 * `[center − margin, center + margin]`，margin = 半视口 + N 个占位单元
 * （**两侧同一个数**，对称是硬要求）。`viewport <= 0`（首帧尚未布局）时
 * 退化为"从头渲染一个有界窗口"，等布局完成后由 ResizeObserver 重算。
 * 单元数封顶 `FILMSTRIP_WINDOW_MAX`（异常输入护栏）。
 *
 * **成本口径（实测驱动）**：逐单元比例查询只做窗口内那几十个单元——
 * 窗口外的偏移/总长按"占位聚合 + 已缓存修正"计算（`cachedDeltaBefore` =
 * 已缓存单元真实外尺寸与占位的累计差，由 `FilmstripDeltaIndex` 维护）。
 * 5 万项全量逐项 Map 查询实测 ~9ms/帧，跳过后 <0.1ms/帧。
 * 总长仍是估计值口径（未解码单元按 1:1，与媒体预览一致，随浏览收敛）。
 *
 * `cachedDeltaBefore(index)`：下标 < index 的已缓存单元的 Σ(真实外尺寸 −
 * 占位外尺寸)。缺省恒 0（全部按占位）——纯函数不读缓存，修正由调用方注入。
 */
export function filmstripWindow(
  total: number,
  scroll: number,
  viewport: number,
  crossSize: number,
  vertical: boolean,
  ratioAt: (index: number) => number,
  cachedDeltaBefore: (index: number) => number = () => 0,
): FilmstripWindow {
  if (total <= 0) return { start: 0, end: 0, startOffset: FILMSTRIP_PADDING, totalExtent: 0 };
  const vp = Math.max(0, viewport);
  const center = Math.max(0, scroll) + vp / 2;
  // 占位单元的外尺寸（1:1）：余量按它估，保证上下对称。
  const placeholder = filmstripCellExtent(crossSize, 1, vertical) + FILMSTRIP_GAP;
  const margin = vp / 2 + FILMSTRIP_WINDOW_MARGIN * placeholder;
  const from = center - margin;
  const until = center + margin;
  // 窗口起点：先用"占位 + 全序列已缓存修正上界"估一个不会偏大的下界，
  // 再逐项前推校正（只有起点附近的几十个单元逐项查比例；前推每步的偏移
  // 用占位 + 该单元之前的已缓存修正，与真实布局一致）。
  let start = Math.min(
    total - 1,
    Math.max(0, Math.floor((from - FILMSTRIP_PADDING - cachedDeltaBefore(total)) / placeholder)),
  );
  const offsetOf = (i: number) =>
    FILMSTRIP_PADDING + i * placeholder + cachedDeltaBefore(i);
  // 估计偏大（起点前一单元的底边已越过上沿）→ 回退。cachedDeltaBefore 单调
  // 不减且非负时估计只会偏小，本循环常态零次；留作修正口径变化的兜底。
  while (
    start > 0 &&
    offsetOf(start - 1) +
      filmstripCellExtent(crossSize, ratioAt(start - 1), vertical) +
      FILMSTRIP_GAP >
      from
  ) {
    start--;
  }
  // 估计偏小 → 前推到第一个"底边越过上沿"的单元。
  while (
    start < total - 1 &&
    offsetOf(start) + filmstripCellExtent(crossSize, ratioAt(start), vertical) + FILMSTRIP_GAP <=
    from
  ) {
    start++;
  }
  const startOffset = offsetOf(start);
  // 窗口内单元逐个定位：起点偏移 + 窗口内已扫单元的真实外尺寸累计
  //（cachedDeltaBefore 只覆盖"下标之前"，窗口内部的修正必须自己累加）。
  let offset = startOffset;
  let end = start;
  for (let i = start; i < total && i - start < FILMSTRIP_WINDOW_MAX; i++) {
    if (offset > until) break;
    end = i + 1;
    offset += filmstripCellExtent(crossSize, ratioAt(i), vertical) + FILMSTRIP_GAP;
  }
  if (end <= start) end = Math.min(start + 1, total);
  // 总长 = 全部按占位 + 已缓存单元的累计修正（一次 O(1) 读取）。
  const totalExtent =
    FILMSTRIP_PADDING + total * placeholder - FILMSTRIP_GAP + cachedDeltaBefore(total) + FILMSTRIP_PADDING;
  return { start, end, startOffset, totalExtent };
}

/**
 * 把第 `index` 项居中所需的滚动偏移（容器内手算，不用 scrollIntoView——
 * 后者会连带滚动祖先）。结果未夹紧：浏览器赋值时自动夹到 `[0, max]`。
 *
 * 只在**换图 / 改尺寸 / 比例收敛**时调用（不在滚动帧里）。与窗口同一
 * 成本口径：起点之前的已缓存修正经 `cachedDeltaBefore` 一次读取，
 * 不再 O(index) 逐项扫（5 万项深处实测 2.7ms/次 → <0.1ms）。
 */
export function filmstripCenterScroll(
  index: number,
  viewport: number,
  crossSize: number,
  vertical: boolean,
  ratioAt: (index: number) => number,
  cachedDeltaBefore: (index: number) => number = () => 0,
): number {
  const placeholder = filmstripCellExtent(crossSize, 1, vertical) + FILMSTRIP_GAP;
  const offset = FILMSTRIP_PADDING + index * placeholder + cachedDeltaBefore(index);
  const extent = filmstripCellExtent(crossSize, ratioAt(index), vertical);
  return offset + extent / 2 - viewport / 2;
}

/* ---- 宽高比共享缓存（模块级；单元卸载不丢，滚回来免重量） ---- */

const ratioCache = new Map<string, number>();
/** 订阅表：写入即通知（消费方按帧合并，见 ViewerFilmstrip），携带写入的 fileId。 */
const ratioListeners = new Set<(fileId: string) => void>();

/** 订阅宽高比写入（返回退订函数）。通知可能高频，消费方必须自行合帧。 */
export function subscribeFilmstripRatios(listener: (fileId: string) => void): () => void {
  ratioListeners.add(listener);
  return () => {
    ratioListeners.delete(listener);
  };
}

/**
 * 读缓存（**只读，不动 LRU 热度**）：读路径必须免写——早期版本读也刷新
 * 热度（delete+set），窗口几何高频取比例时那是实测数毫秒/帧的纯浪费。
 * 热度由写入与单元挂载时的显式 touch 维护。
 */
export function getCachedFilmstripRatio(fileId: string): number | undefined {
  return ratioCache.get(fileId);
}

/** 刷新热度（单元挂载时调用一次，标记"最近在用"；不通知订阅者）。 */
export function touchCachedFilmstripRatio(fileId: string): void {
  const ratio = ratioCache.get(fileId);
  if (ratio === undefined) return;
  ratioCache.delete(fileId);
  ratioCache.set(fileId, ratio);
}

/** 写入缓存（唯一入口）：非法值/同值忽略；超上限淘汰最旧；有效写入即通知。 */
export function setCachedFilmstripRatio(fileId: string, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  if (ratioCache.get(fileId) === ratio) return;
  ratioCache.delete(fileId);
  ratioCache.set(fileId, ratio);
  while (ratioCache.size > FILMSTRIP_RATIO_CACHE_MAX) {
    const oldest = ratioCache.keys().next().value;
    if (oldest === undefined) break;
    ratioCache.delete(oldest);
  }
  for (const listener of ratioListeners) listener(fileId);
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；与 thumbUrl 缓存同一口径）。 */
export function clearFilmstripRatioCache(): void {
  ratioCache.clear();
}