/**
 * 歌词里的「注音」（振り仮名）解析。
 *
 * 数据来源是音频标签里那种**行内写法**：汉字后面跟一个全角括号，括号里是假名。
 * 例如 `心拍数（はーとびーと）`、`君（きみ）の隣（となり）でさ`。这不是我们发明的
 * 格式，是这类歌词文件（以及不少 LRC 站点的日文歌词）的通行写法，所以只在**括号里
 * 全是假名**时才当成注音，其余括号（`(weiyun)`、`（Cover）`）原样保留。
 *
 * 用户 2026-11-14：「音乐播放器实现日语假名注音显示功能，数据以 <某个 .flac> 所示」，
 * 参考图是汉字上方一行小号假名。
 */

/** 一段歌词：普通文字，或「底字 + 注音」。 */
export interface RubySegment {
  /** 底字（注音挂在它上面）；普通段落就是原文。 */
  text: string;
  /** 注音；没有就是普通段落。 */
  ruby?: string;
}

/** 全角括号包着的假名（平假名 / 片假名 / 长音符 / 中点），允许中间有空格。 */
const RUBY_PATTERN = /([\u3005-\u3007\u3400-\u9fff\uf900-\ufaff]+)（([\u3041-\u3096\u30a1-\u30fa\u30fc\u30fb\s]+)）/g;

/** 是否含可以用注音标注的汉字（快速判定，避免每帧跑正则）。 */
export function hasRuby(text: string): boolean {
  return text.includes("（");
}

/**
 * 把一行歌词切成「底字 + 注音」片段。
 *
 * - 只有**底字是汉字**、**括号里全是假名**才算注音；`(weiyun)` 这类会被原样保留；
 * - 括号里的空白会被去掉（排版时行内换行留下的空格没有意义）；
 * - 没有任何注音时返回单个片段，调用方可以照常渲染纯文本。
 */
export function parseRuby(text: string): RubySegment[] {
  if (!text.includes("（")) {
    return [{ text }];
  }
  const segments: RubySegment[] = [];
  let cursor = 0;
  RUBY_PATTERN.lastIndex = 0;
  for (let match = RUBY_PATTERN.exec(text); match !== null; match = RUBY_PATTERN.exec(text)) {
    const [whole, base, reading] = match;
    const at = match.index;
    if (at > cursor) {
      segments.push({ text: text.slice(cursor, at) });
    }
    segments.push({ text: base, ruby: reading.replace(/\s+/g, "") });
    cursor = at + whole.length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ text }];
}
