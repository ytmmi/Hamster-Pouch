/**
 * 歌词的**排版量**（纯逻辑、零依赖：门禁直接 import 驱动）。
 *
 * 参考图的样式 1 里，非当前行不是"一列直线"，而是**一级级往右下错开**；错位量的
 * 单位是 `cqw`（面板宽度的百分之一）而不是像素——固定像素在宽面板上看不出错位、
 * 在窄面板上又会把行推出可视区。
 *
 * 放进独立文件的原因和 `queueView` / `lrc` 一样：`MusicStage.tsx` 是 JSX 组件，
 * Node 剥不了 JSX，门禁 import 不了；排版规则是真逻辑，值得被断言。
 */

/**
 * 非当前行的**错位量**（参考图的歌词是一级级往右下错开的，不是一列直线）。
 *
 * `distance` = 与当前行的行号差（当前行为 0，之前的行也算 0——参考图里唱过的行
 * 停在原位不动）。错位量随距离增长，再叠一点按行号取的抖动，避免每行都等距、
 * 看起来像表格。纯函数，门禁可直接断言。
 */
export function lyricIndent(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  // 单位是 **cqw**（面板宽度的百分之一）：参考图的错位就是"每行往右挪百分之几
  // 的宽度"，固定像素会让宽面板看不出来、窄面板错成一团。
  const step = Math.min(distance, 5) * 2.9;
  const jitter = ((Math.max(1, Math.round(distance)) * 29) % 23) / 8;
  return Math.round((step + jitter) * 100) / 100;
}

/**
 * 歌词切换的**提前量**（毫秒，用户 2026-11-13 D171：「切换歌词时提前一点，使动画
 * 结束刚好切换到正在唱的歌词」）。
 *
 * 行的淡入/放大过渡约 0.5s（见 `styles.css` 的 `.player-lyric`），所以把判定时刻
 * 提前一个过渡时长，动画收尾的那一刻正好是新的一行开始唱。
 */
export const LYRIC_LEAD_MS = 480;

/**
 * 把行内进度换成 CSS 百分比字符串（给 `clip-path` / 渐变用）。
 *
 * 单独成一个函数是为了让"边界值"有唯一出处：进度 0 必须给 `0%`、进度 1 必须给 `100%`，
 * 否则 `calc(100% - 100%)` 与 `calc(100% - 100.0001%)` 在亚像素上会各差一点点。
 */
export function lyricFillPercent(progress: number): string {
  if (!Number.isFinite(progress) || progress <= 0) return "0%";
  if (progress >= 1) return "100%";
  return `${(Math.round(progress * 10000) / 100).toFixed(2)}%`;
}

/** 末行没有"下一行"时的兜底时长（否则最后一句的进度条永远停在 0%）。 */
export const DEFAULT_LINE_MS = 4000;

/** 一句歌词折行后**每条视觉行**在元素内占的矩形（px，左上角为元素左上角）。 */
export type LyricBand = { left: number; top: number; width: number; height: number };

/** 柔边宽度（占该行宽度的百分比）——与 `styles.css` 里单行渐变的 ±6% 同一口径。 */
export const LYRIC_BAND_SOFT = 6;

/** 矩形的四边（`Range.getClientRects()` 那一套，单位 px，已换算到元素坐标）。 */
export type BoxRect = { left: number; top: number; right: number; bottom: number };

/**
 * 把量到的矩形收成**每行一个矩形**（折行时 N 行就是 N 个）。
 *
 * 归并判据是**纵向重叠**而不是"top 相等"：同一行里可能有好几个文本节点（`<ruby>` 的底字、
 * 注音两侧的普通字），它们在同一行箱里、纵向几乎完全重叠；不同行的行箱是上下排开的，
 * 互不重叠。这样既不用猜行高，也不会把注音（`<rt>`）算成独立的一行——调用方本来就不把
 * `rt` 里的文本交进来（注音是贴着底字画的小字，跟着基线走，不该参与"读到哪儿"的计算）。
 */
export function lyricBands(rects: readonly BoxRect[]): LyricBand[] {
  const boxes = rects
    .filter(
      (rect) =>
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        rect.right - rect.left > 0.5 &&
        rect.bottom - rect.top > 0.5,
    )
    .map((rect) => ({ ...rect }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const merged: BoxRect[] = [];
  for (const box of boxes) {
    const last = merged[merged.length - 1];
    if (last) {
      const overlap = Math.min(last.bottom, box.bottom) - Math.max(last.top, box.top);
      const shorter = Math.min(last.bottom - last.top, box.bottom - box.top);
      if (overlap > shorter * 0.5) {
        last.left = Math.min(last.left, box.left);
        last.right = Math.max(last.right, box.right);
        last.top = Math.min(last.top, box.top);
        last.bottom = Math.max(last.bottom, box.bottom);
        continue;
      }
    }
    merged.push({ ...box });
  }

  return merged.map((box) => ({
    left: box.left,
    top: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
  }));
}

/**
 * 整句的进度（0–1）折成**每一行自己的进度**。
 *
 * 按行宽切分（行宽 ∝ 字数）：于是文字以恒定的速度从左往右刷过去，第一行刷满才轮到第二行
 * —— 这才是"读"的顺序。早先折行用一条纵向渐变，边界是一条横扫整个块的水平线，字是从
 * 上往下被"帘子"盖住的（用户 2026-11-14：「遇到一句歌词但是换行时，填充顺序变为了从上到下」）。
 */
export function lyricBandProgress(bands: readonly LyricBand[], progress: number): number[] {
  const total = bands.reduce((sum, band) => sum + band.width, 0);
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  if (!(total > 0)) return bands.map(() => clamped);
  const cursor = clamped * total;
  let walked = 0;
  return bands.map((band) => {
    const local = (cursor - walked) / band.width;
    walked += band.width;
    return Math.min(1, Math.max(0, local));
  });
}

/** 一行的填充渐变（柔边在进度两侧各留 `LYRIC_BAND_SOFT`%）。 */
function bandGradient(local: number): string {
  const sung = "var(--player-lyric-sung)";
  const unsung = "var(--player-lyric-unsung)";
  if (local <= 0) return `linear-gradient(to right, ${unsung} 0%, ${unsung} 100%)`;
  if (local >= 1) return `linear-gradient(to right, ${sung} 0%, ${sung} 100%)`;
  const pct = local * 100;
  const from = Math.max(0, pct - LYRIC_BAND_SOFT).toFixed(2);
  const to = Math.min(100, pct + LYRIC_BAND_SOFT).toFixed(2);
  return `linear-gradient(to right, ${sung} 0%, ${sung} ${from}%, ${unsung} ${to}%, ${unsung} 100%)`;
}

/** 上下各留一点余量，免得字形超出量到的行箱时被"没有背景"吃掉一笔（descender / 注音）。 */
const BAND_BLEED_PX = 4;

/**
 * 折行时的填充：**每行一层**横向渐变，层的位置/尺寸就是那一行的矩形。
 *
 * 为什么不是一条纵向渐变：纵向渐变的等值线是水平线，两行是被同一道帘子自上而下盖住的，
 * 字形在行内被垂直切开。每行一层之后，边界是每一行自己的竖直边，阅读顺序 = 填充顺序。
 * 单行的情况仍走 `styles.css` 里那条静态渐变（一次 `setProperty` 就够，不必每帧拼字符串）。
 */
export function lyricBandFill(
  bands: readonly LyricBand[],
  progress: number,
): { image: string; size: string; position: string } {
  const locals = lyricBandProgress(bands, progress);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    image: bands.map((_, index) => bandGradient(locals[index])).join(", "),
    size: bands.map((band) => `${round(band.width)}px ${round(band.height + BAND_BLEED_PX * 2)}px`).join(", "),
    position: bands
      .map((band) => `${round(band.left)}px ${round(band.top - BAND_BLEED_PX)}px`)
      .join(", "),
  };
}

/**
 * 一行歌词的**时间进度**（0–1）——当前句的填充条就按它推进。
 *
 * 终点取**下一行的起始时刻**（不是"这一行的字符数"）：LRC 只给每句的开始时间，句长
 * 只能由下一句反推。`positionMs` 传进来的必须是**同一个时钟**（`MusicStage` 传的是
 * `positionMs + LYRIC_LEAD_MS`，与判定当前行的时钟一致）——两个时钟不一致就会出现
 * "高亮比声音慢半拍、末尾两个字还没亮就换句"（用户 2026-11-13 报的正是这个）。
 */
export function lineProgress(startMs: number, endMs: number | null, positionMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(positionMs)) return 0;
  const end =
    endMs !== null && Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + DEFAULT_LINE_MS;
  if (positionMs <= startMs) return 0;
  return Math.min(1, (positionMs - startMs) / (end - startMs));
}
