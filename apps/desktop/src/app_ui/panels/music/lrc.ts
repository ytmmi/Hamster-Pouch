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
 * - 时间精确到 1–6 位小数（6 位微秒的 `[01:32.869995]` 只取前 3 位），乃至只有整秒
 *   `[00:12]`；
 * - `[offset:+500]` 整体偏移（正数 = 歌词提前，LRC 口径）；
 * - `[ar:]` / `[ti:]` / `[al:]` / `[by:]` / `[re:]` / `[ve:]` 等元数据标签忽略；
 * - **没有时间轴**的纯文本歌词：整份按行给出（`synced: false`），界面照常显示、
 *   只是不做当前行高亮——"歌词文件里就是没有时间"不该变成"没有歌词"；
 * - 有双语时译文行常被放在同一时刻（见 `pairLrcLines`）；`//`、`曲：…` 这类噪声行
 *   在配对时剔除，但它们仍然是"文件里的行"，`parseLrc` 不做删改。
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

/**
 * `[mm:ss]` / `[mm:ss.xx]` / `[mm:ss:xxx]`；分钟位允许三位（超长纯音乐）。
 *
 * 小数位收 1–6 位：标签里确实有 6 位微秒的写法（`[01:32.869995]`，见深海少女那份
 * `.flac`）。只认 3 位时这类标签**整条匹配失败**，那行歌词既不进时间轴也不进
 * `plain`，等于凭空少一句。
 */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,6}))?\]/g;

/** `[offset:±ms]`（整份歌词的整体平移）。 */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/** 单个时间标签 → 毫秒。 */
function timeTagToMs(minutes: string, seconds: string, fraction: string | undefined): number {
  // 超过 3 位的小数只取前 3 位（`869995` → `869`），不足 3 位的右补零（`5` → `500`）。
  const frac = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
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

/**
 * 一行歌词**成对**之后的形态：原文 + 译文。
 *
 * 参考图里每句歌词都是"原文一行大字 + 译文一行小字"（用户 2026-11-13 指着参考图
 * 要求照做）。双语 `.lrc` 的通行写法是**同一时刻两个时间标签**（原文一行、译文一行），
 * 所以这里按"相邻两行时间几乎相同"来配对，而不是去猜哪种语言是译文。
 */
export interface LrcItem {
  timeMs: number;
  main: string;
  /** 译文；`null` = 这句只有原文。 */
  sub: string | null;
}

/** 视为"同一时刻"的容差：双语 LRC 的译文常在原文后几十毫秒，超过这个就不配对。 */
export const LRC_PAIR_GAP_MS = 120;

/** 假名（平假名 / 片假名，含长音符与中点）。日文原文行就是靠它认出来的。 */
const KANA_PATTERN = /[\u3040-\u30ff]/;

/** `曲：ゆうゆ` / `作词 : 某某` / `編曲：…` 这类制作信息行（冒号前可能带空格）。 */
const CREDIT_PREFIX =
  /^(?:作词|作詞|作曲|编曲|編曲|混音|母带|母帶|製作|制作|演唱|歌手|专辑|專輯|發行|发行|出品|策划|企划|歌词|歌詞|翻译|翻譯|原曲|本家|曲|词|詞)\s*[:：]/;

/** 版权 / 来源声明行（`腾讯享有本翻译作品的著作权`）。 */
const CREDIT_NOTICE = /(著作权|著作權|版权|版權|仅供|僅供)/;

/** 纯符号行：`//`、`***`、`——` 之类，常被拿来当"间奏占位"。 */
const SYMBOL_ONLY = /^[\s/\\|~_\-—–=*·．.、。,…]+$/;

/**
 * 一行是否**不是歌词**：空行、`//` 占位、制作信息、版权声明。
 *
 * 只在**配对阶段**剔除（见 `pairLrcLines`）。没有时间轴的纯文本歌词照旧原样显示——
 * 那种文件里 `//` 可能真的是作者写下的分隔，剔掉会凭空少一行。
 */
export function isNoiseLrcLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (SYMBOL_ONLY.test(trimmed)) return true;
  if (CREDIT_PREFIX.test(trimmed)) return true;
  if (CREDIT_NOTICE.test(trimmed)) return true;
  return false;
}

/**
 * 把逐行歌词配成"原文 + 译文"。
 *
 * 规则：先剔掉噪声行（`isNoiseLrcLine`），再按时间顺序扫——下一行与当前行时间差
 * ≤ `maxGapMs` 就并进来（时间取靠前的那句），否则译文为 `null`。纯文本歌词
 * （`timeMs === -1`）不配对：没有时间就无从判断谁是谁的译文。
 *
 * **谁在上面**由文字本身决定，不由行序决定：同一时刻里含假名的那行是日文原文（主），
 * 另一行是译文（副）。双语 `.lrc` 的行序并不统一——深海少女那份是"先译文后原文"，
 * 只按行序贴会把中文顶到大字行上（用户 2026-11-14 报的就是这个）。
 */
export function pairLrcLines(
  lines: readonly LrcLine[],
  maxGapMs: number = LRC_PAIR_GAP_MS,
): LrcItem[] {
  const items: LrcItem[] = [];
  const gap = Number.isFinite(maxGapMs) ? Math.max(0, maxGapMs) : LRC_PAIR_GAP_MS;
  const kept = lines.filter((line) => !isNoiseLrcLine(line.text));
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i];
    const next = kept[i + 1];
    const pairable =
      next !== undefined &&
      line.timeMs >= 0 &&
      next.timeMs >= 0 &&
      next.timeMs - line.timeMs <= gap &&
      next.text.trim() !== line.text.trim();
    if (pairable) {
      const swap = !KANA_PATTERN.test(line.text) && KANA_PATTERN.test(next.text);
      items.push({
        timeMs: line.timeMs,
        main: swap ? next.text : line.text,
        sub: swap ? line.text : next.text,
      });
      i += 1;
      continue;
    }
    items.push({ timeMs: line.timeMs, main: line.text, sub: null });
  }
  return items;
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
export function activeLrcIndex(
  lines: readonly { timeMs: number }[],
  positionMs: number,
): number {
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
