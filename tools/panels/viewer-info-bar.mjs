/**
 * 面板门禁分节 · 查看器顶部基础信息栏（原第 3 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, stripComments } from "./harness.mjs";
import {
  BOOK_BRIDGE_SRC, ROOT, config, format, registrySource, repoDisplay,
  scroll, settingValueSrc, stylesSource, viewerPanelSrc, viewerReaderSrc,
} from "./shared.mjs";
export default async function run() {
// ==================== 查看器（`panel.viewer`）的顶部基础信息栏设置 ====================
//
// 防的是"设置加了但没人用"。一段面板设置要成立，四段必须都在：
// **声明**（注册表）↔ **归一化**（非法取值回落缺省）↔ **面板消费**（真的条件渲染）↔
// **热加载**（四条独立触发源）。缺任何一段的表现都一样：改了设置没反应。

const viewerSpec = config.panelSpec("viewer");
const viewerInfoBarDecl = viewerSpec?.settings?.find((s) => s.key === "infoBarEnabled");
check(
  "查看器声明了「显示基础信息栏」设置（switch，缺省显示 = 零视觉变化）",
  (viewerSpec?.settings ?? []).length === 1 &&
    viewerInfoBarDecl?.kind === "switch" &&
    viewerInfoBarDecl?.title_key === "viewer.settings.infoBarEnabled" &&
    viewerInfoBarDecl?.default === true,
  `decls=${(viewerSpec?.settings ?? []).map((s) => s.key).join(",") || "（无）"} ` +
    `default=${viewerInfoBarDecl?.default}`,
);
check(
  "面板设置值按声明归一化：非法取值回落缺省（失败关闭）、缺省可解析、未注册面板为 undefined",
  config.normalizePanelSettingValue("viewer", "infoBarEnabled", false) === false &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", "false") === false &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", "yes") === true &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", 1) === true &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", null) === true &&
    config.normalizePanelSettingValue("imageviewer", "filmstripSize", "bad") === 76 &&
    config.normalizePanelSettingValue("imageviewer", "zoomAnchor", "middle") === "pointer" &&
    config.normalizePanelSettingValue("imageviewer", "zoomAnchor", "center") === "center" &&
    config.normalizePanelSettingValue("ghost", "infoBarEnabled", true) === undefined,
);
check(
  "面板设置热加载走多条独立触发源（共享钩子：本地广播 + 后端事件 + 焦点 + 面板激活）",
  /subscribeSettingChanged\(/.test(settingValueSrc) &&
    /listenHp\("setting\.changed"/.test(settingValueSrc) &&
    /window\.addEventListener\("focus"/.test(settingValueSrc) &&
    /onDidActiveChange/.test(settingValueSrc) &&
    /onDidVisibilityChange/.test(settingValueSrc),
);
check(
  "查看器面板真的按该设置条件渲染顶部基础信息栏",
  /usePanelSwitch\(VIEWER_PANEL_ID, "infoBarEnabled"/.test(viewerPanelSrc) &&
    /showInfoBar &&/.test(viewerPanelSrc) &&
    /className="viewer-info"/.test(viewerPanelSrc),
);
check(
  "viewer 面板拿到 dockview 面板 API（第 4 条触发源「面板激活」才可达）",
  /^ {2}viewer: \(ctx\) => <ViewerPanel api=\{ctx\.api\} \/>,$/m.test(
    registrySource,
  ),
);

// ---- 查看器正文阅读区（txt / md / epub，2026-10-09 用户口径）----
//
// 用户原话："查看器面板新增 2 个文件的查看：1、txt，显示文本开头的内容，范围为查看器面板
// 大小。2、epub，显示开头内容，包含文本和图像，根据查看器自适应展示单栏或双栏，
// 默认为单栏，显示范围为查看器面板大小。"
// 追问后两项裁定：**分栏不做设置项、纯自动**；**固定上限 + 面板内滚动看更多、
// 字符缓存不需要大、滚动时按需缓存**。
//
// 这一段的守护重点是四件**看不见就必然是缺陷**的事：
// 1. **正文不是 HTML**（安全边界）——前端不得有 `dangerouslySetInnerHTML` 入口；
// 2. **判据用 media_type** 而不是在面板里再列一遍扩展名（第二份口径必然漂移）；
// 3. **分栏只由面板宽度决定**，且**窄面板恒单栏**（"默认为单栏"的落点）；
// 4. **按需取下一页**（不是打开就把整本取回来），且**没有下一页时不发请求**。
const viewerReaderViewSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/viewer/viewerReaderView.ts"),
  "utf8",
);
const viewerBlocksSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/viewer/BookBlocks.tsx"),
  "utf8",
);
// Markdown 解析侧（后端；2026-10-10）——门禁也读它，守住"同一套块模型"这条不变量。
const markdownParserSrc = readFileSync(
  join(ROOT, "crates/hp-book/src/markdown.rs"),
  "utf8",
);
const markdownBlockSrc = readFileSync(
  join(ROOT, "crates/hp-book/src/block.rs"),
  "utf8",
);
const viewerContentSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/viewer/useViewerBookContent.ts"),
  "utf8",
);
// 分页状态机在共享钩子里（D209）：查看器与阅读器共用一份，内部断言读它。
const bookPagesSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/useBookPages.ts"),
  "utf8",
);
const viewerReaderView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/viewer/viewerReaderView.ts")).href
);
// 正文阅读区家族：反面断言读整个家族（拆分不得成为逃离断言的后门）。
const viewerReaderFamilySrc = [
  viewerPanelSrc,
  viewerReaderSrc,
  viewerBlocksSrc,
  viewerContentSrc,
  viewerReaderViewSrc,
].join("\n");

check(
  "纯逻辑模块零依赖（无 React / Tauri，门禁可直接 import）",
  !/from\s+"react"/.test(viewerReaderViewSrc) &&
    !/@tauri-apps/.test(viewerReaderViewSrc) &&
    !/^\s*import\s/m.test(viewerReaderViewSrc),
);

// ---- 分栏：纯自动、只由面板宽度决定（用户裁定"不做设置项"）----
check(
  "readerColumns：窄面板**恒单栏**（「默认为单栏」的落点），够宽才两栏",
  viewerReaderView.readerColumns(400) === 1 &&
    viewerReaderView.readerColumns(900) === 1 &&
    viewerReaderView.readerColumns(1200) === 2 &&
    viewerReaderView.readerColumns(2000) === 2 &&
    // 判据用**扣掉左右内边距**后的可用宽度：否则"面板刚好等于阈值但内边距占掉一截"
    // 时会分成两栏、每栏比单栏还窄。
    viewerReaderView.readerColumns(
      viewerReaderView.READER_TWO_COLUMN_MIN_WIDTH +
        viewerReaderView.READER_HORIZONTAL_PADDING,
    ) === 2 &&
    viewerReaderView.readerColumns(
      viewerReaderView.READER_TWO_COLUMN_MIN_WIDTH +
        viewerReaderView.READER_HORIZONTAL_PADDING -
        1,
    ) === 1,
  `900=>${viewerReaderView.readerColumns(900)} 1200=>${viewerReaderView.readerColumns(1200)}`,
);
check(
  "firstColumnEnd：单栏为 0；双栏给出「第一栏读完」的滚动位置",
  viewerReaderView.firstColumnEnd(3000, 600, 1) === 0 &&
    viewerReaderView.firstColumnEnd(3000, 600, 2) === 1200 &&
    // 内容不足一屏时没有可滚动的量，不该给出负数。
    viewerReaderView.firstColumnEnd(400, 600, 2) === 0,
);
check(
  "shouldLoadMore：接近底部才取下一页；**没有下一页时不发请求**（否则到底会反复请求空页）",
  viewerReaderView.shouldLoadMore(0, 3000, 600, true) === false &&
    viewerReaderView.shouldLoadMore(2000, 3000, 600, true) === true &&
    // 没有更多内容：再怎么滚都不该发请求。
    viewerReaderView.shouldLoadMore(9999, 3000, 600, false) === false,
);
check(
  "readerFontSize 随面板宽度给一档（与分栏同一口径：都是「根据查看器自适应」）",
  viewerReaderView.readerFontSize(400) < viewerReaderView.readerFontSize(1200) &&
    viewerReaderView.readerFontSize(1200) >= 12,
);
check(
  "isImageOnly：整页只有图片（epub 封面 / 彩页）要能被识别（居中而不是左对齐）",
  viewerReaderView.isImageOnly([{ kind: "image" }, { kind: "image" }]) === true &&
    viewerReaderView.isImageOnly([{ kind: "image" }, { kind: "paragraph" }]) === false &&
    viewerReaderView.isImageOnly([]) === false,
);
check(
  "面板**没有**为分栏新增设置项（用户裁定「不做设置项，纯自动（无 UI）」）",
  (viewerSpec?.settings ?? []).length === 1 &&
    (viewerSpec?.settings ?? []).every((s) => s.key === "infoBarEnabled"),
  `decls=${(viewerSpec?.settings ?? []).map((s) => s.key).join(",")}`,
);

// ---- 面板接线 ----
check(
  "「书」走正文阅读区：判据用**媒体类型**（text / pdf，**不按扩展名**，免得与扫描器两份口径）",
  /media_type === "text" \|\| file\?\.media_type === "pdf"/.test(viewerPanelSrc) &&
    /isBookMedia\(file\)/.test(viewerPanelSrc) &&
    /<ViewerReader \/>/.test(viewerPanelSrc) &&
    // 反向：面板里不得再列一遍书的扩展名（第二份口径必然与 hp-scanner 漂移）。
    !/\.(epub|txt|markdown|pdf)\b/.test(viewerPanelSrc.replace(/^[\s\S]*?\*\//, "")),
);
check(
  "「书」**不取** file.path / preview.get（正文由 book.content 提供，取图那一步是白跑）",
  // 守卫在取 URL 之前：书由 `book.content` 提供正文，走取图路径就是白发一次 IPC。
  /const repoId = app\.repoId;/.test(viewerPanelSrc) &&
    /if \(!repoId \|\| !selected \|\| isBookMedia\(selected\)\) return;/.test(viewerPanelSrc),
);
check(
  "阅读区按宽度下发分栏与字号（CSS 变量），且**自己滚**（范围为查看器面板大小）",
  /readerColumns\(width\)/.test(viewerReaderSrc) &&
    /readerFontSize\(width\)/.test(viewerReaderSrc) &&
    /"--vr-columns":\s*String\(columns\)/.test(viewerReaderSrc) &&
    /"--vr-font-size":/.test(viewerReaderSrc) &&
    /className="vr-scroll"/.test(viewerReaderSrc) &&
    /onScroll=\{handleScroll\}/.test(viewerReaderSrc) &&
    /\.vr-scroll\s*\{[^}]*overflow:\s*auto/.test(stylesSource) &&
    /\.vr-content\s*\{[^}]*column-count:\s*var\(--vr-columns/.test(stylesSource),
);
check(
  "按需取下一页：滚动到底部附近才取（用户口径「滚动时按需缓存」）",
  /shouldLoadMore\(/.test(viewerReaderSrc) &&
    /loadMore\(\)/.test(viewerReaderSrc) &&
    // 取数走 book.content，且游标是**返回值里的 next_cursor**（不是前端自己算）。
    /api\.bookContent\(\{ repoId, fileId, cursor: from \}\)/.test(bookPagesSrc) &&
    /last\.next_cursor/.test(bookPagesSrc) &&
    // 首屏只取第一页（`null` 游标）。
    /void fetchPage\(null,/.test(bookPagesSrc) &&
    // 反向：不得"打开就全取回来"（那正是用户明确否掉的形态）。
    !/while\s*\(.*next_cursor/.test(bookPagesSrc) &&
    // 反向：查看器自己不再持有这份状态机（D209 收成一份）。
    !/generationRef|api\.bookContent\(|setPages\(/.test(viewerContentSrc),
);
check(
  "切书即丢掉已取的页（否则会把上一本的正文显示在下一本上）",
  /generationRef\.current \+= 1/.test(bookPagesSrc) &&
    /setPages\(\[\]\)/.test(bookPagesSrc),
);

// ---- 安全边界：正文不是 HTML ----
// 反面断言先剥注释：文件头会**引用** `dangerouslySetInnerHTML` 说明"为什么不用它"
// （与 `repoDisplay` 那条同一处置——禁止的是"渲染进节点"的形态，不是这个词本身）。
const viewerReaderFamilyCode = stripComments(viewerReaderFamilySrc);
check(
  "正文**不是 HTML**：全家族不得出现 dangerouslySetInnerHTML（白名单做在后端解析侧）",
  !/dangerouslySetInnerHTML/.test(viewerReaderFamilyCode) &&
    // 正向：块用 React 元素渲染（`<p>` / `<img>` / `<pre>` / `<table>` /
    // `createElement('hN')`）。注意不再断言 `<p key={index} …>` 这种字面形态——
    // 渲染器已拆成 `Block` 递归组件（列表项 / 引用 / 脚注内部都要复用），
    // key 落在 `Blocks` 的 map 上。断言"渲染了什么元素"比断言"key 写在哪"更本质。
    /<p className="vr-paragraph">/.test(viewerBlocksSrc) &&
    /className="vr-image"/.test(viewerBlocksSrc) &&
    /<pre className="vr-code">/.test(viewerBlocksSrc) &&
    /<table className="vr-table">/.test(viewerBlocksSrc) &&
    /createElement\(/.test(viewerBlocksSrc),
);
check(
  "桥接层与 DTO 只给**类型化块**（前端没有 HTML 可注入的入口）",
  /BookBlockItem/.test(
    readFileSync(join(ROOT, "crates/hp-dto/src/lib.rs"), "utf8"),
  ) &&
    /BookContentResult/.test(readFileSync(join(ROOT, "crates/hp-dto/src/lib.rs"), "utf8")),
);

// ---- Markdown 渲染（2026-10-10，用户口径"渲染 + 完整 Markdown 语法覆盖"）----
//
// 这一段的守护重点是四件**看不见就必然是缺陷**的事：
// 1. **正文不是 HTML**（安全边界）——Markdown 可以内嵌 HTML，解析侧必须过白名单，
//    `<script>` 内容不得进入正文；前端不得有 `dangerouslySetInnerHTML` 入口。
//    实测抓到过一个真洞：pulldown 把 `<script>alert()</script>` 拆成
//    `InlineHtml + Text + InlineHtml`，只过滤 HTML 事件会漏掉正中间那段代码，
//    因此"丢弃深度"必须**跨事件**存活（见 `markdown.rs` 的 `html_skip_depth`）。
// 2. **两种格式共用一套块模型**——否则前端会各自长出一个渲染器、观感必然漂移；
// 3. **图片只给能渲染的绝对路径**——解析侧确认文件在盘上，破图在结构上不出现；
// 4. **`.md` 仍按 `media_type === "text"` 分流**，不在前端再列一遍扩展名。
check(
  "Markdown 解析侧丢弃 `<script>`/`<style>` 内容，且丢弃深度**跨事件**存活（实测抓到的洞）",
  /DROPPED_HTML_TAGS/.test(markdownParserSrc) &&
    /html_skip_depth/.test(markdownParserSrc) &&
    // 正向锚点：文字事件也要看丢弃深度（只过滤 HTML 事件会漏掉中间那段代码）。
    /html_skip_depth > 0 \{\s*return;/.test(markdownParserSrc.replace(/\s+/g, " ")),
);
check(
  "Markdown 与 EPUB **共用同一套块模型**（前端只有一份渲染器的前提）",
  /use crate::block::\{/.test(markdownParserSrc) &&
    /BookBlock::Paragraph/.test(markdownParserSrc) &&
    /pub enum BookBlock/.test(markdownBlockSrc) &&
    // 反向：Markdown 侧不得自建第二套块类型。
    !/pub enum MarkdownBlock/.test(markdownParserSrc),
);
check(
  "Markdown 图片只给**真的在盘上**的绝对路径（破图在结构上不出现）",
  /fn resolve_image/.test(markdownParserSrc) &&
    /is_file\(\)/.test(markdownParserSrc) &&
    // 远程图片与 data URI 不落成 img（前端拿不到、也没必要）。
    /http:\/\//.test(markdownParserSrc) &&
    /data:/.test(markdownParserSrc),
);
check(
  "Markdown 覆盖完整语法（表格 / 任务列表 / 脚注 / 定义列表 / 数学 / 上下标）",
  // 只看 `options()` 的函数体：这些常量名在文档注释里也会被提到，
  // 全文匹配会让"关掉某个开关"的变异**仍然通过**（空洞断言）。
  (() => {
    const body = markdownParserSrc.slice(
      markdownParserSrc.indexOf("fn options() -> Options"),
    );
    const flags = [
      "ENABLE_TABLES",
      "ENABLE_TASKLISTS",
      "ENABLE_FOOTNOTES",
      "ENABLE_DEFINITION_LIST",
      "ENABLE_MATH",
      "ENABLE_SUPERSCRIPT",
      "ENABLE_SUBSCRIPT",
    ];
    return flags.every((flag) => body.includes(flag));
  })(),
);
check(
  "前端渲染 Markdown 的新块种类（代码块 / 引用 / 列表 / 表格 / 分隔线）",
  ["code_block", "blockquote", "list", "table", "rule"].every((kind) =>
    viewerBlocksSrc.includes(`case "${kind}"`),
  ) &&
    // 行内样式按**固定顺序**套元素（同一组样式 → 同一棵元素树）。
    /STYLE_ORDER/.test(viewerBlocksSrc) &&
    /vr-code-inline/.test(viewerBlocksSrc),
);
check(
  "阅读区按 `format` 分流：纯文本走 `<p>`，markdown / epub 走块渲染器",
  /page\.format === "text"/.test(viewerReaderSrc) &&
    /isBlocked/.test(viewerReaderSrc) &&
    /format === "markdown"/.test(viewerReaderSrc),
);
check(
  "桥接层按扩展名分流到 Markdown 渲染，且游标是**块序号**（不是字符偏移）",
  (() => {
    const bridge = BOOK_BRIDGE_SRC;
    return (
      /"md" \| "markdown" => read_markdown_page/.test(bridge) &&
        /format: "markdown"/.test(bridge) &&
        /MARKDOWN_PAGE_BLOCKS/.test(bridge)
    );
  })(),
);


}
