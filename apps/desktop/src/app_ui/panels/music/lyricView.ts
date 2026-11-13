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
