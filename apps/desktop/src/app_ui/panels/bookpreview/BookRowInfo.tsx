/**
 * **列表 / 封面模式共用的信息栏**：文件名 / 作者 / 简介三行。
 *
 * 用户 2026-10-09 口径的展示规则（列表与封面两模式一致）：
 * - 作者行前面加 **「作者：」**（i18n 键 `book.authorLabel`，不硬编码中文）；
 * - 简介**单独一行**、行首加 **「简介：」**（`book.descLabel`）；
 * - 简介的溢出标准 = **和封面图片底部齐平**（截断行数由 `bookDescLineCount` 按封面
 *   尺寸算好、经 `--bp-desc-lines` 下发，不再固定 3 行）。
 *
 * 缺值一律渲染 `—`（沿用旧口径，不省略该行）：省略会让"这本书没有作者信息"
 * 与"面板坏了"看起来一模一样。
 */

import { useApp } from "../../core/AppContext";

export interface BookRowInfoProps {
  /** 作品名（= 去目录去扩展名的文件名）。 */
  name: string;
  /** EPUB 内嵌作者；`null` = 无。 */
  author: string | null;
  /** EPUB 内嵌简介；`null` = 无。 */
  description: string | null;
  /** 相对路径（文件名行的悬停提示用）。 */
  relativePath: string;
}

/** 缺值占位符（与元数据面板同款；符号不是文案，不进 i18n）。 */
const MISSING = "—";

/**
 * 三行信息。**刻意不 memo**：它消费 `useApp` 的语言上下文，语言切换时必须重渲
 * （父单元 memo 只挡 props 不变的重渲，挡不住 context 更新）。
 */
export function BookRowInfo({ name, author, description, relativePath }: BookRowInfoProps): JSX.Element {
  const app = useApp();
  return (
    <>
      <span className="bp-row-name" title={relativePath}>
        {name}
      </span>
      <span className="bp-row-author" title={author ?? undefined}>
        {`${app.t("book.authorLabel")}${author ?? MISSING}`}
      </span>
      <span className="bp-row-desc">{`${app.t("book.descLabel")}${description ?? MISSING}`}</span>
    </>
  );
}
