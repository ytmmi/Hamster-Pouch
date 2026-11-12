/**
 * 播放队列的**步进规则**（纯逻辑、零依赖：门禁直接 import 驱动）。
 *
 * 队列就是媒体预览里那一串文件（同相册 / 同源），播放器只挑出**同类型**的相邻项
 * 来回走：音频不跳进视频、视频也不跳进音频。随机与循环是播放器收到的新需求
 * （用户 2026-11-13："随机和循环可以做（同相册或源音频队列）"），规则全部收在
 * 这个文件里，界面只负责把结果落到宿主选中上。
 *
 * 三条边界写死在这里，因为它们最容易在界面上表现成"偶尔失灵"：
 *
 * - 端点：`repeat: "off"` 时走到头就停在原地（返回 `-1`，由调用方决定要不要停），
 *   `"all"` / `"one"` 时环绕；
 * - 随机：只在**同类**里抽，且不抽到自己（只有一首时原地不动）；
 * - 当前位置不属于该类：原地不动，不猜语义（例如在视频上按"上一首"）。
 */

export type PlayableKind = "audio" | "video";

/** 循环模式：关 / 列表循环 / 单曲循环。 */
export type RepeatMode = "off" | "all" | "one";

/** 步进选项（都有缺省：`all` + 不随机，等于"按顺序环绕"）。 */
export interface StepOptions {
  /** 随机播放：在同类里随机取一首（不是打乱整个队列的索引）。 */
  shuffle?: boolean;
  /** 循环模式：影响走到端点时是环绕还是停住。 */
  repeat?: RepeatMode;
  /** 随机源（默认 `Math.random`；门禁注入固定值以断言"不抽到自己"）。 */
  random?: () => number;
}

/** 只有音频与视频进队列（图片/文本走各自的面板）。 */
export function isPlayable(file: { media_type: string }): boolean {
  return file.media_type === "audio" || file.media_type === "video";
}

/** 队列项的类别；不可播放时 `null`。 */
export function playableKindOf(file: { media_type: string } | null | undefined): PlayableKind | null {
  if (!file) return null;
  if (file.media_type === "audio") return "audio";
  if (file.media_type === "video") return "video";
  return null;
}

/** 过滤出可播放项（队列 hook 拉完分页后过一遍）。 */
export function playableFiles<T extends { media_type: string }>(files: readonly T[]): T[] {
  return files.filter(isPlayable);
}

/** 同类项在**原数组**里的下标（保持原顺序，就是排队顺序）。 */
function peerIndexes(
  files: readonly { media_type: string }[],
  kind: PlayableKind,
): number[] {
  const peers: number[] = [];
  files.forEach((file, index) => {
    if (file.media_type === kind) peers.push(index);
  });
  return peers;
}

/**
 * 在同类里走 `delta` 步，返回**原数组下标**。
 *
 * 返回 `-1` 只表示"按当前循环设置走不过去了"（端点且 `repeat: "off"`），
 * 其余情况（当前位置不属于该类、`delta === 0`、同类为空）一律原地返回。
 */
export function stepPlayable(
  files: readonly { media_type: string }[],
  index: number,
  delta: number,
  kind: PlayableKind,
  options: StepOptions = {},
): number {
  if (!Number.isFinite(delta) || delta === 0) return index;
  const peers = peerIndexes(files, kind);
  if (peers.length === 0) return -1;
  const pos = peers.indexOf(index);
  // 当前位置不在队列里（选中项被过滤掉 / 还没进队列）：不猜，原地不动。
  if (pos < 0) return index;

  const repeat = options.repeat ?? "all";
  if (options.shuffle) {
    const others = peers.filter((peer) => peer !== index);
    if (others.length === 0) return index;
    const random = options.random ?? Math.random;
    const raw = random();
    const pick = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999_999) : 0;
    return others[Math.floor(pick * others.length)];
  }

  const target = pos + Math.sign(delta);
  if (target >= 0 && target < peers.length) return peers[target];
  if (repeat === "off") return -1;
  // 环绕（`one` 只影响"自动续播"，手动点上一首/下一首照样换曲）。
  return peers[(target + peers.length) % peers.length];
}

/** "还有没有下一首/上一首"（按钮禁用的唯一依据，和步进规则同一份逻辑）。 */
export function canStepPlayable(
  files: readonly { media_type: string }[],
  index: number,
  delta: number,
  kind: PlayableKind,
  options: StepOptions = {},
): boolean {
  const target = stepPlayable(files, index, delta, kind, options);
  return target >= 0 && target !== index;
}
