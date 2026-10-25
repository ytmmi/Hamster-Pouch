/**
 * 图书阅读器：左栏**栏头**（封面 / 书名 / 作者 / 已读时长）。
 *
 * ## 与用户参考图的对应
 *
 * 参考图左栏的最上面是「封面 + 书名 + 作者：… + 已读：N min」，再下面是
 * 目录 / 书签 / 笔记 / 高亮四个标签条与章节列表。本组件就是那一块。
 *
 * ## 为什么封面**复用图书预览的 `BookCoverArt`**
 *
 * 同一本书在两个面板里必须是**同一张封面**：`BookCoverArt` 已经收敛了
 * "文字封面打底 + 封面图盖上"、封面覆盖（用户自选的颜色 / 图片）的优先级、
 * 以及图片加载失败的回落。这里再写一套封面渲染，迟早会出现
 * "图书预览里换了封面、阅读器里还是旧的"或"一边有投影一边没有"。
 *
 * 取数侧同理（`useReaderBookIdentity`）：`txt` / `md` 一次 IPC 都不发
 * （它们本来就没有内嵌封面，栏头直接用文字封面）。
 *
 * ## 「已读 N 分钟」是**本次会话**的计时
 *
 * 与顶栏的「本次阅读时间 N 分钟」是**同一个计数器**（面板持有会话起点、换书归零）：
 * 顶栏在两条栏收起时也看得到，栏头这一处是参考图的位置。它不是"累计阅读时长"
 * ——项目里没有那种记录（`reader_annotations` 存的是批注，不是进度历史），
 * 编一个假的累计值比不显示更糟。
 *
 * ## 缺作者时显示 `—`
 *
 * 与图书预览的信息栏同一条口径（`BookRowInfo` 的 `MISSING`）：`txt` / `md` 与
 * 一部分 PDF 本来就没有作者字段，省略整行会让"没有作者"与"面板坏了"看起来一样。
 */

import type { JSX } from "react";
import type { Translate } from "../../i18n";
import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "../bookpreview/BookCoverArt";
import { bookDisplayName } from "../bookpreview/bookPreviewView";
import type { BookCoverOverride } from "../bookpreview/bookCoverCache";

export interface ReaderBookHeaderProps {
  /** 当前阅读的文件；`null` = 没有选中（栏头整块不渲染，由调用方决定）。 */
  file: FileItem;
  /** 作者（EPUB `<dc:creator>` / PDF `/Author`）；`null` = 没有或读不出。 */
  author: string | null;
  /** 内嵌 / 渲染出来的封面 URL；`null` = 这本书没有封面（用文字封面）。 */
  coverUrl: string | null;
  /** 用户自设的封面覆盖；`null` = 没有覆盖。 */
  override: BookCoverOverride | null;
  /** 本次会话已读的分钟数（与顶栏同一个计数器）。 */
  readMinutes: number;
  t: Translate;
}

export function ReaderBookHeader({
  file,
  author,
  coverUrl,
  override,
  readMinutes,
  t,
}: ReaderBookHeaderProps): JSX.Element {
  // 书名 = 去目录去扩展名的文件名（与图书预览**同一条**规则；内嵌标题不可靠）。
  const name = bookDisplayName(file.relative_path);
  return (
    <div className="br-book-head">
      <div className="br-book-cover">
        <BookCoverArt name={name} coverUrl={coverUrl} override={override} />
      </div>
      <div className="br-book-meta">
        <span className="br-book-title" title={file.relative_path}>
          {name}
        </span>
        <span className="br-book-author" title={author ?? undefined}>
          {`${t("book.authorLabel")}${author ?? t("bookreader.unknown")}`}
        </span>
        <span className="br-book-read">{t("bookreader.headReadTime", { min: readMinutes })}</span>
      </div>
    </div>
  );
}
