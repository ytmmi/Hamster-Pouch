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
 * 按**字素**切分歌词。
 *
 * 逐字填充必须按"用户眼里的一个字"切：`split("")` 会把 surrogate pair 劈开，
 * `Array.from` 也只到**码位**——`👩‍🎤` 这种 ZWJ 组合会被拆成 4 个 span。有
 * `Intl.Segmenter` 就用它，没有才退回码位切分（老引擎上最多把 emoji 拆开，
 * 中文歌词不受影响）。
 */
export function lyricChars(text: string): string[] {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: "grapheme" },
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Segmenter) return Array.from(text);
  const segmenter = new Segmenter("zh-Hans", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * 当前行**已唱到第几个字**（逐字从左到右填充，用户 2026-11-13 D171 选定）。
 *
 * `progress` 是这一行的时间进度（0–1，见 `lineProgress`）。向下取整而不是四舍五入：
 * 唱到 60% 时第 6 个字不该提前亮——用户看到的是"唱到哪儿、亮到哪儿"。
 */
export function sungCharCount(length: number, progress: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return Math.min(length, Math.floor(length * Math.min(progress, 1)));
}

/**
 * 一行歌词的时间进度（0–1）。
 *
 * 终点取**下一行的起始时刻**；最后一行没有下一行时给 `DEFAULT_LINE_MS` 的兜底
 * 时长（否则最后一句会永远停在 0%，整句都不亮）。
 */
export const DEFAULT_LINE_MS = 4000;

export function lineProgress(startMs: number, endMs: number | null, positionMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(positionMs)) return 0;
  const end = endMs !== null && Number.isFinite(endMs) && endMs > startMs
    ? endMs
    : startMs + DEFAULT_LINE_MS;
  if (positionMs <= startMs) return 0;
  return Math.min(1, (positionMs - startMs) / (end - startMs));
}
