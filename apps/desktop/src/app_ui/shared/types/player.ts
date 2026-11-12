/**
 * 播放器面板的类型（`player.media` 的旁挂取料）。
 *
 * 播放本身不经过后端：`file.path` + DOM `<video>`（D163）。这里只有"播放器要显示、
 * 但文件系统里没有现成路径"的两样东西——封面与歌词。
 */

/** `player.media` 命令参数。 */
export interface PlayerMediaArgs {
  repoId: string;
  fileId: string;
}

/** `player.media` 返回体（字段蛇形，serde 默认序列化）。 */
export interface PlayerMediaResult {
  /**
   * **可直接 `convertFileSrc` 的封面绝对路径**；无封面则 `null`。
   *
   * 回退顺序（后端定）：内嵌封面 → 同目录同名图片 → `null`。
   * `null` 不是错误：面板据此画**兜底晕染**，不画假封面。
   */
  cover_path: string | null;
  /**
   * **已解码**的歌词正文（LRC 原文，`[mm:ss.xx]` 切分与当前行高亮在前端）；
   * 无同名 `.lrc` / 文件为空则 `null`，面板不显示歌词区。
   */
  lyrics_text: string | null;
  /**
   * 封面主色（`#rrggbb`，按占比降序）；空数组 = 没有封面 / 取色失败。
   *
   * **必须由后端给**：封面经 `convertFileSrc` 是跨源资源，前端 canvas 读像素会被
   * taint（`getImageData` 直接抛安全错误），所以色晕的取色只能在后端做
   * （`hp_media::extract_palette`，与色彩参考面板同一份算法）。
   */
  haze_colors: string[];
}
