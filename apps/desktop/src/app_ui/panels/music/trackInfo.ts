/**
 * 音乐播放器的**曲目文字**（标题 / 艺人）——纯格式化，无 React / Tauri 依赖。
 *
 * **为什么从文件名推**：索引里只有 `relative_path`（`FileItem` 没有 title / artist
 * 字段），而"读音频标签"这件事尚未排期（D115 ⑫ 的"标签"一项）。参考图里那行
 * "スリーズブーケ (Cerise Bouquet) — 素顔" 是**艺人 — 曲名**的书写习惯，文件名
 * 恰好也是这个习惯（`白上吹雪 - Say!ファンファーレ!.mp3`），因此按第一个
 * `" - "` 切开：左边当艺人、右边当曲名。切不出来就整串当曲名、不编造艺人。
 *
 * 输出是**数据**不是界面文案，因此不走 i18n。
 */

/** 取路径最后一段（文件名）。 */
export function baseNameOf(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** 去掉最后一个扩展名（`a.b.flac` → `a.b`；无点则原样）。 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 曲名（缺省 = 文件名去扩展名）。 */
export function trackTitleOf(path: string | null | undefined): string {
  const stem = stripExtension(baseNameOf(path));
  const split = splitArtist(stem);
  return split.title || stem;
}

/** 艺人（文件名里没有 `" - "` 时 `null`，界面就不显示那一行）。 */
export function trackArtistOf(path: string | null | undefined): string | null {
  const split = splitArtist(stripExtension(baseNameOf(path)));
  return split.artist;
}

/** `艺人 - 曲名` → 两段；切不出来时整串是曲名。 */
function splitArtist(stem: string): { artist: string | null; title: string } {
  const separator = " - ";
  const at = stem.indexOf(separator);
  if (at <= 0) return { artist: null, title: stem };
  const artist = stem.slice(0, at).trim();
  const title = stem.slice(at + separator.length).trim();
  if (!artist || !title) return { artist: null, title: stem };
  return { artist, title };
}
