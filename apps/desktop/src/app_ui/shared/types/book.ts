/**
 * 图书（文本类文件）类型：`book.meta` 的参数与返回体。
 *
 * `book.meta` 只服务**图书预览面板**：EPUB 的作者 / 简介 / 内嵌封面。
 * 它**不进索引**——封面是二进制、简介是长文本，塞进 `files` 行会让每次文件查询
 * 都背上几十 KB 的负载，而列表只用得到"有没有封面"。
 */

/** `book.meta` 命令参数。 */
export interface BookMetaArgs {
  repoId: string;
  fileId: string;
}

/** `book.meta` 返回体（三项都可为 `null`）。 */
export interface BookMetaResult {
  /** EPUB `<dc:creator>`；无则 `null`。 */
  author: string | null;
  /** EPUB `<dc:description>`；无则 `null`。 */
  description: string | null;
  /**
   * **已落盘**的封面绝对路径（供 `convertFileSrc`）；无封面则 `null`。
   *
   * `null` 不是错误：`txt` / `md` 本来就没有封面，面板用文件名渲染文字封面。
   */
  cover_path: string | null;
}
