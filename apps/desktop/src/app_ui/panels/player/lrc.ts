/**
 * LRC 歌词解析（**纯逻辑**，无 React / Tauri 依赖，门禁可直接 import 驱动）。
 *
 * 后端只给"已解码的文本"（`player.media` 的 `lyrics_text`，UTF-8 / GBK 已由
 * `hp_book` 判过），时间轴的切分与"当前唱到哪一句"在这里做——它们属于**渲染策略**，
 * 不该进命令契约。
 *
 * 支持的形态（按真实 .lrc 语料归纳，不是完整 LRC 规范）：
 * - 一行多个时间标签 `[00:12.34][00:15.00]同一句` → 拆成多行；
 * - 毫秒分隔符 `.` 与 `:` 都认（`[00:12:34]` 是老工具的输出）；
 * - 时间精确到 2–3 位、1 位、乃至只有整秒 `[00:12]`；
 * - `[offset:+500]` 整体偏移（正数 = 歌词提前，LRC 口径）；
 * - `[ar:]` / `[ti:]` / `[al:]` / `[by:]` / `[re:]` / `[ve:]` 等元数据标签忽略；
 * - **没有时间轴**的纯文本歌词：整份按行给出（`synced: false`），界面照常显示、
 *   只是不做当前行高亮——"歌词文件里就是没有时间"不该变成"没有歌词"。
 */

/** 一行歌词（`timeMs` 已含 offset；无时间轴时为 `-1`）。 */
export interface LrcLine {
  timeMs: number;
  text: string;
}

/** 解析结果。 */
export interface LrcDoc {
  lines: LrcLine[];
  /** 是否带时间轴（`false` = 纯文本歌词，不做当前行高亮）。 */
  synced: boolean;
}

/** `[mm:ss]` / `[mm:ss.xx]` / `[mm:ss:xxx]`；分钟位允许三位（超长纯音乐）。 */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** `[offset:±ms]`（整份歌词的整体平移）。 */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/** 单个时间标签 → 毫秒。 */
function timeTagToMs(minutes: string, seconds: string, fraction: string | undefined): number {
  const frac = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  return Number(minutes) * 60_000 + Number(seconds) * 1000 + frac;
}

/**
 * 解析 LRC 文本。
 *
 * 输出**按时间升序**（同一时刻保持原顺序：一行多标签拆出来的几句按标签先后）。
 * 空白歌词行保留（它们常被用来分段），行内首尾空白剪掉。
 */
export function parseLrc(text: string): LrcDoc {
  const rawLines = text.split(/\r?\n/);
  const offsetMs = readOffset(rawLines);
  const lines: LrcLine[] = [];
  // 没有时间标签的行先收着：整份都没有时间轴时它们就是歌词本身。
  const plain: string[] = [];

  for (const raw of rawLines) {
    let rest = raw;
    const firstTagIndex = lines.length;
    for (const tag of raw.matchAll(TIME_TAG)) {
      lines.push({
        timeMs: timeTagToMs(tag[1], tag[2], tag[3]) - offsetMs,
        text: "",
      });
      rest = rest.replace(tag[0], "");
    }
    if (lines.length > firstTagIndex) {
      // 同一行的所有时间标签共用这一句歌词（按行内标签顺序逐个填）。
      const body = rest.trim();
      for (let i = firstTagIndex; i < lines.length; i += 1) {
        lines[i].text = body;
      }
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === "" || OFFSET_TAG.test(trimmed) || isMetaTag(trimmed)) {
      continue;
    }
    plain.push(trimmed);
  }

  if (lines.length === 0) {
    return { lines: plain.map((text) => ({ timeMs: -1, text })), synced: false };
  }
  // 稳定排序：`sort` 在 V8 上已稳定，但显式按原序兜一层更直白。
  const indexed = lines.map((line, index) => ({ line, index }));
  indexed.sort((a, b) => a.line.timeMs - b.line.timeMs || a.index - b.index);
  return { lines: indexed.map((item) => item.line), synced: true };
}

/** 读 `[offset:…]`；没有则该 0。 */
function readOffset(rawLines: readonly string[]): number {
  for (const line of rawLines) {
    const match = OFFSET_TAG.exec(line);
    if (match) return Number(match[1]) || 0;
  }
  return 0;
}

/** `[ar:xxx]` 这类元数据标签（不是歌词）。 */
function isMetaTag(line: string): boolean {
  return /^\[[a-zA-Z]{2,}:[^\]]*\]$/.test(line);
}

/**
 * 当前唱到第几行：最后一个 `timeMs <= positionMs` 的下标；还没到第一句时 `-1`。
 *
 * 二分查找：一首歌几百行、`timeupdate` 每秒几次，线性扫没有性能问题，但这是
 * 纯函数里最容易写错的一处（`-1` / 空数组 / 乱序输入），用二分把边界写死。
 * 输入必须已按时间升序（[`parseLrc`] 的返回值满足）。
 */
export function activeLrcIndex(lines: readonly LrcLine[], positionMs: number): number {
  if (lines.length === 0 || !Number.isFinite(positionMs)) return -1;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 取当前行前后各 `radius` 行的窗口（长歌词只渲染这段，DOM 数不随歌词长度增长）。
 *
 * 返回闭区间 `[start, end)`。窗口在两端夹紧（不出现负下标），且**不改变行号**——
 * 界面仍按绝对下标高亮当前行。
 */
export function lrcWindow(
  length: number,
  index: number,
  radius: number,
): { start: number; end: number } {
  if (length <= 0) return { start: 0, end: 0 };
  const r = Math.max(0, Math.floor(radius));
  const center = Math.max(0, Math.min(index, length - 1));
  const start = Math.max(0, center - r);
  const end = Math.min(length, center + r + 1);
  return { start, end };
}
