/**
 * 图书（"书"类文件）类型：`book.meta` 与 `book.content` 的参数与返回体。
 *
 * `book.meta` 服务**图书预览面板**（EPUB 的作者 / 简介 / 内嵌封面；
 * **PDF 的作者 / 主题 / 第一页封面**），`book.content` 服务**查看器**
 * （txt / md / epub 的正文开头；PDF 的**逐页栅格化**）。
 * 两者都**不进索引**——封面是二进制、简介与正文是长文本，塞进 `files` 行会让
 * 每次文件查询都背上几十 KB 的负载，而列表只用得到"有没有封面"。
 */

/** `book.meta` 命令参数。 */
export interface BookMetaArgs {
  repoId: string;
  fileId: string;
}

/** `book.meta` 返回体（三项都可为 `null`）。 */
export interface BookMetaResult {
  /** EPUB `<dc:creator>` / PDF `/Author`；无则 `null`。 */
  author: string | null;
  /** EPUB `<dc:description>` / PDF `/Subject`；无则 `null`。 */
  description: string | null;
  /**
   * **已落盘**的封面绝对路径（供 `convertFileSrc`）；无封面则 `null`。
   *
   * - EPUB：内嵌封面，**原格式不转码**；
   * - **PDF：第一页栅格化后的 JPEG**（`hp-pdf`，`ext` 恒为 `jpg`）——
   *   两者落到**同一个**缓存路径，因此前端只有一条渲染路径。
   *
   * `null` 不是错误：`txt` / `md` 本来就没有封面，打不开的 PDF 也没有，
   * 面板用文件名渲染文字封面。
   */
  cover_path: string | null;
}

/** `book.content` 命令参数（`cursor` 缺省 = 第一页）。 */
export interface BookContentArgs {
  repoId: string;
  fileId: string;
  /** 游标：纯文本是**字符偏移**、epub / pdf 是**序号**（章节 / 页码）；缺省 `undefined` = 从头。 */
  cursor?: string | null;
}

/**
 * 一段**行内内容**（**不是 HTML**）。
 *
 * EPUB 的正文是 XHTML、Markdown 可以内嵌 HTML，渲染它们要么走
 * `dangerouslySetInnerHTML`（本项目不接受），要么做一遍受控白名单——后端把白名单
 * **做在解析侧**，前端只拿到这样的纯数据并渲染 React 元素，
 * 因此前端**没有**可注入 HTML 的入口。
 */
export interface BookSpanItem {
  /** 文字内容（图片片段里是 **alt 文本**）。 */
  text: string;
  /**
   * 叠加的行内样式（`emphasis` / `strong` / `strikethrough` / `code` /
   * `superscript` / `subscript` / `math` / `footnote` / `highlight` /
   * `underline` / `small_caps`；后端已归一化成固定次序）。
   */
  styles: string[];
  /** 链接目标；`null` = 不是链接。 */
  href: string | null;
  /** 图片的**已落盘绝对路径**（供 `convertFileSrc`）；`null` = 不是图片。 */
  image: string | null;
  /** 书自带的**文字颜色**（CSS 颜色值）；`null` = 未声明。 */
  color: string | null;
  /** 书自带的**文字底色**（CSS 颜色值）；`null` = 未声明。 */
  bg: string | null;
  /**
   * 书自带的**字号倍数**（em）；`null` = 未声明。
   *
   * **与 `crates/hp-dto` 的 `BookSpanItem` 逐字对应**（`size_em: Option<f32>`）：
   * 本文件是**手写副本**，不是生成产物——两边的字段必须一起改，否则它读到的
   * 是旧契据，而前端只会在运行时静默拿到 `undefined`。
   */
  size_em: number | null;
}

/** 一个列表项（GFM 任务列表的勾选态 + 项内的块）。 */
export interface BookListItem {
  /** `true` / `false` = 已勾选 / 未勾选；`null` = 不是任务项。 */
  checked: boolean | null;
  /** 项内的块（列表项可以含多段、嵌套列表、代码块）。 */
  blocks: BookBlockItem[];
}

/** 表格的一行。 */
export interface BookTableRowItem {
  /** 各单元格（每个单元格是一组行内片段）。 */
  cells: BookSpanItem[][];
}

/** 定义列表的一项（术语 + 若干条释义）。 */
export interface BookDefinitionItem {
  /** 术语（行内内容）。 */
  term: BookSpanItem[];
  /** 释义（每条释义是一组块）。 */
  definitions: BookBlockItem[][];
}

/**
 * 正文的**块**（**不是 HTML**）。
 *
 * EPUB 与 Markdown 产出的是**同一套块**（后端 `hp_book::block`），
 * 因此前端**只有一份渲染器**，两种格式的观感不会各自漂移。
 */
export interface BookBlockItem {
  /**
   * `heading` / `paragraph` / `image` / `code_block` / `blockquote` /
   * `list` / `rule` / `table` / `footnote` / `definition_list` /
   * **`figure`** / **`comment`** / **`page_break`**。
   */
  kind: string;
  /** `heading` 的层级 1–6；其余块为 `null`。 */
  level: number | null;
  /** 行内内容（`heading` / `paragraph`）；其余块为 `null`。 */
  spans: BookSpanItem[] | null;
  /** `image` 的已落盘绝对路径（供 `convertFileSrc`）；其余为 `null`。 */
  path: string | null;
  /** `code_block` 的语言标记；其余为 `null`。 */
  lang: string | null;
  /** `code_block` 的代码原文（**保留缩进**）；其余为 `null`。 */
  text: string | null;
  /** `blockquote` / `footnote` 内的块；其余为 `null`。 */
  blocks: BookBlockItem[] | null;
  /** GFM 告示种类（`note` / `tip` …）；其余为 `null`。 */
  quote_kind: string | null;
  /** `list` 是否有序；其余为 `null`。 */
  ordered: boolean | null;
  /** `list` 的起始序号；其余为 `null`。 */
  start: number | null;
  /** `list` 的项；其余为 `null`。 */
  list_items: BookListItem[] | null;
  /** `table` 的每列对齐（`none` / `left` / `center` / `right`）；其余为 `null`。 */
  align: string[] | null;
  /** `table` 的表头单元格；其余为 `null`。 */
  head: BookSpanItem[][] | null;
  /** `table` 的表体行；其余为 `null`。 */
  rows: BookTableRowItem[] | null;
  /** `footnote` 的标签；其余为 `null`。 */
  label: string | null;
  /** `definition_list` 的各项；其余为 `null`。 */
  definitions: BookDefinitionItem[] | null;
  /**
   * **`figure`** 的图片块本体（`kind = "image"`）；其余为 `null`。
   *
   * 图与图注是一个整体（EPUB 的 `<figure>` + `<figcaption>`），必须整组不被拆页。
   */
  figure: BookBlockItem | null;
  /** **`figure`** 的图注；其余为 `null`。 */
  caption: BookSpanItem[] | null;
  /**
   * **`figure` / `image`** 是否要求**独占一页**；其余为 `null`（`null` = 不要求）。
   *
   * 判据在后端解析侧（EPUB 的 `epub:type="pagebreak"`、单图 `<section>`、封面页）。
   */
  full_page: boolean | null;
}

/** `book.content` 返回体：查看器要显示的正文**一页**。 */
export interface BookContentResult {
  /**
   * 书的格式：`text`（纯文本）/ `markdown`（渲染后的 md）/ `epub` / **`pdf`**
   * （一页 = 一张整页位图）；空串 = 不是可看的"书"。
   */
  format: string;
  /** 纯文本的**编码名**（`UTF-8` / `GBK` / …）；epub / pdf 为 `null`。 */
  encoding: string | null;
  /** 纯文本页的内容；epub / pdf 为 `null`。 */
  text: string | null;
  /** epub 章节的块 / **pdf 整页位图的块**；纯文本为 `null`。 */
  blocks: BookBlockItem[] | null;
  /** 下一页游标；`null` = 没有更多（**到末尾不是错误**）。 */
  next_cursor: string | null;
  /** 本页序号（0 起；纯文本恒为 0，epub 是章节序号，**pdf 是页码**）。 */
  section: number;
  /** epub 的章节总数 / **pdf 的页数**；纯文本与 markdown 为 `null`。 */
  section_count: number | null;
  /** 本页标题（epub 的章节标题；纯文本 / pdf 为 `null`）。 */
  title: string | null;
  /**
   * 本页是否**另起一页**（epub：`section > 0`；其余格式恒 `false`）。
   *
   * 用户口径（需求 4）："每个章节应该是全新的一页，而不是接在上一章后面"。
   * 由**后端**给出而不是前端按 `section > 0` 算：PDF 的 `section` 是页码、
   * 纯文本恒为 0——三种格式语义不同，只有后端知道"这一页是不是新章"。
   */
  page_break_before: boolean;
  /** 内容是否因**上限**被截断（面板据此提示"仅显示开头"）。 */
  capped: boolean;
}

/** `book.cover` / `book.setCover` / `book.clearCover` 返回体。 */
export interface BookCoverResult {
  /** `color` / `image`；`null` = 没有覆盖（按默认封面渲染）。 */
  kind: string | null;
  /** `color` 为 `#rrggbb`；`image` 为**已落盘**的绝对路径；无覆盖为 `null`。 */
  value: string | null;
}

/** `book.setCover` 命令参数。 */
export interface BookSetCoverArgs {
  repoId: string;
  fileId: string;
  /** `color`（`value` = `#rrggbb`）或 `image`（`value` = 源图片绝对路径）。 */
  kind: "color" | "image";
  value: string;
}

/**
 * `book.covers` 批量查询的返回元素（`file_id` → 覆盖）。
 *
 * **批量而不是逐个查**：图书预览一页可能有几百本，逐本一次 IPC 就是几百次往返。
 */
export interface BookCoverItem {
  file_id: string;
  /** `color` / `image`。 */
  kind: string;
  /** `color` 为 `#rrggbb`；`image` 为**已落盘**的绝对路径。 */
  value: string;
}

/** `book.toc` 命令参数。 */
export interface BookTocArgs {
  repoId: string;
  fileId: string;
}

/**
 * `book.toc` 返回元素：目录的**一项**（图书阅读器的目录栏）。
 *
 * `cursor` **就是**随后要传给 `book.content` 的游标——两种格式各自的语义见
 * [`BookContentArgs.cursor`]：epub 是章节序号、txt 是**字符偏移**、md 是顶层块序号。
 * "目录跳转"因此只是"把这一项原样交给 `book.content`"，前端不做任何换算。
 */
export interface BookTocItem {
  /**
   * 章节标题。
   *
   * **可能是空串**：EPUB 缺 `<title>` 或那个 `<title>` 不是章节名时如实留空，
   * 此时界面按 i18n 显示序号（后端不内联用户可见文案）。
   */
  title: string;
  /** 层级（1 = 顶层）；EPUB 取自 nav / NCX 嵌套，Markdown 用标题层级，txt 按「卷」分组。 */
  level: number;
  /** 跳转游标（与 `book.content` 的 `cursor` 同语义）。 */
  cursor: string;
}

/** `book.toc` 返回：一本书的目录。 */
export interface BookTocResult {
  /** `text` / `markdown` / `epub` / `pdf`；空串 = 不是可读的"书"。 */
  format: string;
  /**
   * 目录项（按书内顺序；**可能为空** = 这本书没有目录）。
   *
   * 空数组**不是错误**：PDF 里没有章节语义，损坏的书也读不出目录——
   * 阅读器此时只显示正文，目录栏给空态。
   */
  entries: BookTocItem[];
  /**
   * **全书总单位数**，供阅读器算进度（`当前游标 / total`）。
   *
   * 纯文本 = 字符数、Markdown = 顶层块数；`epub` / `pdf` 为 `null`
   * （它们的进度用 `BookContentResult` 的 `section` / `section_count`）。
   */
  total: number | null;
}

/** 批注种类（书签 / 笔记 / 高亮；三者是同一件事的三种形态）。 */
export type ReaderAnnotationKind = "bookmark" | "note" | "highlight";

/**
 * 一条**阅读批注**（`reader.annotations` 返回元素）。
 *
 * `cursor` 与 `book.content` 的游标**同语义**（epub = 章节序号、纯文本 = 字符偏移、
 * md = 顶层块序号），因此"点批注跳回去"就是把它原样交给 `bookContent`——
 * 前端不做换算（与 `book.toc` 的目录项同一条口径）。
 */
export interface ReaderAnnotationItem {
  /** 主键（UUID；删除时用它）。 */
  id: string;
  kind: ReaderAnnotationKind;
  /** 位置游标（与 `book.content` 同语义）。 */
  cursor: string;
  /** 保存时的阅读进度（0–10000，两位小数百分比）；仅供列表展示。 */
  progress: number;
  /** 位置标题（章节名 / 目录项）；空串 = 取不到标题。 */
  title: string;
  /** 高亮的选中原文**快照**；空串 = 没有（书签 / 笔记）。 */
  excerpt: string;
  /** 读者写的备注 / 笔记正文；空串 = 没有。 */
  note: string;
  /** 创建时间（ISO 8601）。 */
  created_at: string;
}

/** `reader.addAnnotation` 命令参数。 */
export interface ReaderAddAnnotationArgs {
  repoId: string;
  fileId: string;
  kind: ReaderAnnotationKind;
  cursor: string;
  /** 保存时的阅读进度（0–10000）。 */
  progress: number;
  title: string;
  excerpt: string;
  note: string;
}
