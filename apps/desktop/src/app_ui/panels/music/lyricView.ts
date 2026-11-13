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
