/**
 * 播放器队列的**纯逻辑**（零依赖，门禁直接 import 驱动）。
 *
 * 与 `usePlayerQueue.ts` 的分工：这里只回答"哪些文件可播、同类前后一步走到哪"，
 * 取数与排序（`file.query` / `album.members` / `drainPages` / `sortFiles`）在钩子里。
 * 分开的理由是可测——"上一首/下一首只在同类里走、端点循环"是产品口径，不是
 * 渲染细节，必须由 `pnpm check:panels` 按行为钉住，而不是靠读源码相信它。
 *
 * 用户 2026-11-13 口径：上一首/下一首的范围 = 同相册或同源的音频队列；同一批
 * 还要求"播放器能像图像查看器那样切换视频"。两件事共用一条队列（`audio` +
 * `video` 的保序子序列），步进时**只在同类里走**：听歌不该跳到 `pv.mp4`，
 * 看视频也不该跳到 mp3。
 */

/** 队列里"能播"的媒体类型（也是 `player.media` 接受的类型）。 */
export type PlayableKind = "audio" | "video";

/** 该文件是否可播（音频/视频）。 */
export function isPlayable(file: { media_type: string } | null): boolean {
  return file?.media_type === "audio" || file?.media_type === "video";
}

/** 媒体类型 → 步进用的同类键（非音频/视频 → `null`）。 */
export function playableKindOf(file: { media_type: string } | null): PlayableKind | null {
  if (file?.media_type === "audio") return "audio";
  if (file?.media_type === "video") return "video";
  return null;
}

/** 过滤出可播项（队列只收音频/视频；相册成员里还混着图片与文档）。 */
export function playableFiles<T extends { media_type: string }>(files: readonly T[]): T[] {
  return files.filter((file) => isPlayable(file));
}

/**
 * 在**同类**里前后走 `delta` 步（`±1`），到端点循环。
 *
 * 边界（`delta = 0`、单个文件、不在队列内、同类为空）都返回原下标或 `-1`，
 * 由调用方决定"不动"——这里不猜产品语义。循环（而非停住）：音乐队列走到末尾
 * 回到第一首，是播放器该有的行为；单曲队列就是原地重播。
 */
export function stepPlayable<T extends { media_type: string }>(
  files: readonly T[],
  index: number,
  delta: number,
  kind: PlayableKind,
): number {
  const peers: number[] = [];
  for (let i = 0; i < files.length; i += 1) {
    if (playableKindOf(files[i]) === kind) peers.push(i);
  }
  if (peers.length === 0) return -1;
  if (delta === 0 || index < 0 || !peers.includes(index)) return index;
  const at = peers.indexOf(index);
  const next = (at + (delta > 0 ? 1 : -1) + peers.length) % peers.length;
  return peers[next];
}
