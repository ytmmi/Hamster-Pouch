/**
 * **文字封面**：把作品名渲染成一张"书皮"（无内嵌封面时的兜底）。
 *
 * 用在哪：`txt` / `md` 从来没有封面；`epub` 也可能没有（包里确实存在不带封面的书），
 * 或者封面图 `convertFileSrc` 后加载失败。这三种情况都落到这里，
 * **不是错误态**——用户看到的是一本"素色书"，而不是一个坏图占位符。
 *
 * 底色由 [`textCoverHue`] 从作品名派生：同名恒同色（跨会话稳定），
 * 因此同一本书每次打开长得一样，不同书之间又能一眼区分。
 */

import { textCoverHue, wrapCoverName } from "./bookPreviewView";

export interface BookTextCoverProps {
  /** 作品名（已去目录与扩展名）。 */
  name: string;
}

/** 文字封面的断行参数：每行 6 字、最多 4 行（超出即省略号）。 */
const COVER_NAME_CHARS_PER_LINE = 6;
const COVER_NAME_MAX_LINES = 4;

export function BookTextCover({ name }: BookTextCoverProps): JSX.Element {
  const hue = textCoverHue(name);
  const lines = wrapCoverName(name, COVER_NAME_CHARS_PER_LINE, COVER_NAME_MAX_LINES);
  return (
    <div
      className="bp-textcover"
      style={{
        // 两种色相同一个色系：斜向渐变让"素色书"看起来像装帧而不是加载占位。
        background: `linear-gradient(155deg, hsl(${hue} 32% 34%), hsl(${(hue + 26) % 360} 40% 17%))`,
      }}
    >
      <span className="bp-textcover-name">{lines.join("\n")}</span>
    </div>
  );
}
