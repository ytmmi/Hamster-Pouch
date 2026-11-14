/**
 * 面板门禁分节 · 图书预览面板 / PDF / 三轴模型（原第 24–27 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList, stripComments } from "./harness.mjs";
import {
  BOOK_BRIDGE_SRC, BOOK_FAMILY_FILES, MEDIA_FAMILY_FILES, ROOT, config, format,
  masonry, mediaActionsSrc, optionValues, registrySource, stylesSource, viewerReaderSrc,
} from "./shared.mjs";
export default async function run() {
// ==================== 图书预览面板（`panel.bookpreview`）====================
//
// 2026-10-08 新增：文本类文件（txt / md / epub）的可视化展览；2026-10-09 用户修订：
// 三种视图（**卡片模式** = 封面在上 + 文件名在下；**列表模式** = 封面在左 +
// 文件名/作者/简介、右栏填充剩余空间，由原「封面模式」改名；**封面模式** = 规则与
// 列表一致、一行多本、右栏固定为封面宽度的 2 倍）。
//
// 这一段的守护重点是三件**看不见就必然是缺陷**的事：
// 1. 声明层的 `view` 候选 ↔ 面板取值域逐项一致（设置界面能选、面板认不出 = "改了没反应"）；
// 2. 文件名滚轮横滚**必须**是原生非被动监听（React 的 `onWheel` 是被动的，
//    `preventDefault()` 会被忽略 → 滚轮同时滚名字与面板）；
// 3. 只有**需要内嵌封面**的书才发 `book.meta`（txt/md 每本发一次 IPC 是纯浪费）。
//
// 反面断言读**整个家族**（`BOOK_FAMILY_FILES`，与 `MEDIA_FAMILY_FILES` 同口径）：
// 日后把面板拆成更多文件时，断言不能因此失效。

const bookFamilySrc = BOOK_FAMILY_FILES.map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");
const bookViewSrc = readFileSync(BOOK_FAMILY_FILES[8], "utf8");
const bookView = await import(pathToFileURL(join(ROOT, BOOK_FAMILY_FILES[8])).href);

const bookSpec = config.panelSpec("bookpreview");
const bookSettingKeys = (bookSpec?.settings ?? []).map((s) => s.key);
check(
  "bookpreview 声明了 2 项面板设置（view / coverSize），且都带 i18n 键",
  Boolean(bookSpec) &&
    eqList(bookSettingKeys, ["view", "coverSize"]) &&
    (bookSpec?.settings ?? []).every((s) => Boolean(s.title_key)),
  `keys=${bookSettingKeys.join(",")}`,
);
check(
  "bookpreview 的 select 候选 ↔ 面板取值域逐项一致（卡片 / 列表 / 封面三种模式）",
  eqList(optionValues("bookpreview", "view"), [...bookView.BOOK_VIEW_MODES]) &&
    eqList([...bookView.BOOK_VIEW_MODES], ["card", "list", "cover"]),
);
check(
  "bookpreview 的 view 缺省 = `card`，且落在取值域内",
  bookSpec?.settings?.find((s) => s.key === "view")?.default === bookView.DEFAULT_BOOK_VIEW &&
    bookView.BOOK_VIEW_MODES.includes(bookView.DEFAULT_BOOK_VIEW),
);
check(
  "coverSize 缺省落在面板自己的夹紧范围内（声明层没有 min/max，范围只能由面板夹紧）",
  bookSpec?.settings?.find((s) => s.key === "coverSize")?.default ===
    bookView.DEFAULT_BOOK_COVER_SIZE &&
    bookView.DEFAULT_BOOK_COVER_SIZE >= bookView.BOOK_COVER_SIZE_MIN &&
    bookView.DEFAULT_BOOK_COVER_SIZE <= bookView.BOOK_COVER_SIZE_MAX,
);

// 纯函数行为（直接 import 驱动，不写正则）。
check(
  "clampCoverSize：越界夹紧；**缺失**回落缺省（不把「没设置」当成「设成了 0」）",
  bookView.clampCoverSize(bookView.BOOK_COVER_SIZE_MIN - 100) === bookView.BOOK_COVER_SIZE_MIN &&
    bookView.clampCoverSize(bookView.BOOK_COVER_SIZE_MAX + 100) === bookView.BOOK_COVER_SIZE_MAX &&
    bookView.clampCoverSize(200) === 200 &&
    bookView.clampCoverSize("240") === 240 &&
    bookView.clampCoverSize("abc") === bookView.DEFAULT_BOOK_COVER_SIZE &&
    bookView.clampCoverSize("") === bookView.DEFAULT_BOOK_COVER_SIZE &&
    bookView.clampCoverSize(null) === bookView.DEFAULT_BOOK_COVER_SIZE &&
    bookView.clampCoverSize(undefined) === bookView.DEFAULT_BOOK_COVER_SIZE,
);
check(
  "bookDescLineCount：简介截断行数由封面高度推得（溢出到封面底部，不再固定 3 行）",
  // 封面高 = 宽 × 3/2；信息列扣掉文件名 19.5 + 作者 18 + 两处间距 8 后，
  // 每行 18px：160 → 10 行、96 → 5 行、400 → 30 行；小到没空间时至少 1 行。
  bookView.bookDescLineCount(160) === 10 &&
    bookView.bookDescLineCount(96) === 5 &&
    bookView.bookDescLineCount(400) === 30 &&
    bookView.bookDescLineCount(1) === 1 &&
    // 行数随封面尺寸单调不减（封面变大、简介能显示更多）。
    bookView.bookDescLineCount(400) > bookView.bookDescLineCount(96) &&
    // 可用高度 = 封面高 − 固定行高（与 styles.css 的 line-height 参数逐项相等）。
    Math.abs(
      bookView.bookDescAvailableHeight(160) -
        (160 * 1.5 - bookView.BOOK_ROW_NAME_LINE_PX - bookView.BOOK_ROW_AUTHOR_LINE_PX - bookView.BOOK_ROW_INFO_GAP_PX),
    ) < 1e-9,
);
check(
  "封面模式右栏 = 封面宽度 × 2（BOOK_COVER_INFO_SCALE），单元格总宽不含拉伸",
  bookView.BOOK_COVER_INFO_SCALE === 2 &&
    bookView.bookCoverCellWidth(160) === 160 * 3 + bookView.BOOK_COVER_ROW_GAP_PX &&
    bookView.bookCoverCellWidth(96) === 96 * 3 + bookView.BOOK_COVER_ROW_GAP_PX,
);
check(
  "封面宽度滑条带步进常量（与媒体预览同口径：有档位感）",
  Number.isInteger(bookView.BOOK_COVER_SIZE_STEP) &&
    bookView.BOOK_COVER_SIZE_STEP > 0 &&
    (bookView.BOOK_COVER_SIZE_MAX - bookView.BOOK_COVER_SIZE_MIN) % bookView.BOOK_COVER_SIZE_STEP === 0,
);
check(
  "resolveBookView：非法取值回落缺省（失败关闭）",
  bookView.resolveBookView("cover") === "cover" &&
    bookView.resolveBookView("list") === "list" &&
    bookView.resolveBookView("card") === "card" &&
    bookView.resolveBookView("masonry") === bookView.DEFAULT_BOOK_VIEW &&
    bookView.resolveBookView(undefined) === bookView.DEFAULT_BOOK_VIEW,
);
check(
  "bookDisplayName：去掉目录与扩展名（作品名 = 文件名），中间的点保留",
  bookView.bookDisplayName("dir/小说.epub") === "小说" &&
    bookView.bookDisplayName("a.b.epub") === "a.b" &&
    bookView.bookDisplayName("无扩展名") === "无扩展名" &&
    bookView.bookDisplayName("dir\\win\\path.txt") === "path" &&
    // 隐藏文件（点开头）不是"扩展名"：`.` 之后的整段就是名字本身。
    bookView.bookDisplayName(".hidden") === ".hidden",
);
check(
  "usesEmbeddedCover：book 标记优先，标记缺失的旧行按扩展名兜底（**epub 与 pdf 都算**）",
  bookView.usesEmbeddedCover({ marks: ["book"], relative_path: "x.txt" }) === true &&
    // 标记是**集合**：带别的标记（如 manga）不等于带 book。
    bookView.usesEmbeddedCover({ marks: ["manga"], relative_path: "x.epub" }) === false &&
    // 迁移 0010 之前的存量行（标记为空）：epub / pdf 仍按"取封面"处理，txt 不走。
    bookView.usesEmbeddedCover({ marks: [], relative_path: "x.epub" }) === true &&
    bookView.usesEmbeddedCover({ marks: [], relative_path: "x.EPUB" }) === true &&
    // **PDF 的封面 = 第一页**（用户口径 2026-10-11）：旧行同样要兜底到"取封面"，
    // 否则存量 PDF 在重扫前会全部退化成文字封面——那正是用户要消除的现象。
    bookView.usesEmbeddedCover({ marks: [], relative_path: "x.pdf" }) === true &&
    bookView.usesEmbeddedCover({ marks: [], relative_path: "x.PDF" }) === true &&
    bookView.usesEmbeddedCover({ marks: ["book"], relative_path: "x.pdf" }) === true &&
    bookView.usesEmbeddedCover({ marks: [], relative_path: "x.txt" }) === false,
);
// ==================== PDF 支持（2026-10-11 用户口径）====================
//
// 用户原话："1、图书预览增加 pdf 支持，封面为 pdf 第一页。2、查看器增加 pdf 支持。"
//
// 这一段的守护重点是四件**看不见就必然是缺陷**的事：
// 1. **PDF 是独立类目**，不是文本类的一种（它是二进制容器，编码判定 / 字符分页
//    那一套对它完全不适用；并进 text 会让那个类目变成一句谎话）；
// 2. **封面 = 第一页**：带 book 标记才去 `book.meta`，后端用 `hp-pdf` 栅格化；
// 3. **PDF 没有子类**（只有一种格式），但**有** book 标记；
// 4. 查看器里 PDF **逐页栅格化**、**恒单栏**（整页位图不该被断成两栏）。
//
// 断言放在**文件末尾**（见「PDF 支持（断言）」段）：那里 `coreSourceSrc` /
// `scannerMediaTypeSrc` 等源码常量已经声明，不会踩 `const` 的 TDZ 陷阱。

// ==================== 三轴模型：类目 / 子类 / 标记（D102）====================
check(
  "类目取值域 9 项（D136 追加 unlimited 顶端 / empty 底端，含 text / pdf / album / source）；子类取值域按类目分域（text → epub / txt / md，其余无子类）",
  eqList(
    [...config.BLUEPRINT_MEDIA_TYPES],
    ["unlimited", "image", "video", "audio", "text", "pdf", "album", "source", "empty"],
  ) &&
    eqList([...config.subclassFormatsFor("text")], ["epub", "txt", "md"]) &&
    // 其余类目类型**没有**子类取值域（该类目下不能建子类）。
    // `pdf` 尤其重要：它只有一种格式，再分一层没有语义（2026-10-11）。
    // `album` / `source`（D135）：它们是面板条目的分类，没有"格式"这一层。
    // `unlimited` / `empty`（D136）：两个极端（匹配一切 / 排除全部），同样没有格式可分。
    config.subclassFormatsFor("image").length === 0 &&
    config.subclassFormatsFor("pdf").length === 0 &&
    config.subclassFormatsFor("album").length === 0 &&
    config.subclassFormatsFor("source").length === 0 &&
    config.subclassFormatsFor("unlimited").length === 0 &&
    config.subclassFormatsFor("empty").length === 0 &&
    config.mediaTypeHasSubclass("text") === true &&
    config.mediaTypeHasSubclass("pdf") === false &&
    config.mediaTypeHasSubclass("album") === false &&
    config.mediaTypeHasSubclass("source") === false &&
    config.mediaTypeHasSubclass("unlimited") === false &&
    config.mediaTypeHasSubclass("empty") === false &&
    config.mediaTypeHasSubclass("image") === false,
);
// 系统标记清单 = **10 项**（D134，2026-11-01）。顺序就是这一份，且是**唯一**顺序：
// 蓝图下拉、面板右键标记树（相册 / 源）都按它排列——三处若各写一份清单，迟早出现
// "菜单里有、蓝图下拉里没有"这种静默漂移。
//
// 树形（`媒体 ⊃ {图像, 视频, 音频 ⊃ {音乐}}`、`文档 ⊃ {文本, 图书, 漫画}`、`程序`）只是
// **UI 呈现**用的嵌套关系，节点模型与存储都是**扁平**的 10 个 id（D134 ②）。
const SYSTEM_MARK_IDS = [
  "media", "image", "video", "audio", "music", "document", "text", "book", "manga", "program",
];
check(
  "标记清单**可注册**：内置 10 项（媒体/图像/视频/音频/音乐/文档/文本/图书/漫画/程序），登记项可加入、可注销、不覆盖内置",
  eqList([...config.BLUEPRINT_BUILTIN_MARKS], SYSTEM_MARK_IDS) &&
    config.isMarkRegistered("book") &&
    config.isMarkRegistered("program") &&
    !config.isMarkRegistered("plugin.demo.extra") &&
    (() => {
      config.registerBlueprintMarks([{ mark: "plugin.demo.extra", origin: "demo" }]);
      const added = config.allMarkKinds().includes("plugin.demo.extra");
      config.unregisterBlueprintMarks("demo");
      return added && !config.isMarkRegistered("plugin.demo.extra");
    })(),
  `实际 ${[...config.BLUEPRINT_BUILTIN_MARKS].join(",")}`,
);

// **两点必须逐项相等且顺序一致**：TS 清单（`packages/config/src/blueprintValues.ts`）与
// Rust 清单（`crates/hp-core/src/blueprint_types.rs` 的 `BUILTIN_MARKS`）。这两份是
// "系统标记有哪些" 的**仅有两处**权威；数量对不上会被 `[&str; N]` 的 N 当场发现，但
// **顺序**对不上只会让两边的下拉顺序悄悄错开（而且谁都不会报错）。
/** 从 Rust 源码按**顺序**取 `const NAME: [&str; N] = [ ... ];`（标识符按同名 `const` 解析成值）。 */
function rustStrArrayOrdered(src, name) {
  // 先剥注释：数组里若写行内注释，注释里的英文单词会被当成标识符。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, " "))
    .join("\n");
  const m = new RegExp(`const ${name}\\s*:[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*;`).exec(code);
  if (!m) return null;
  const tokens = [...m[1].matchAll(/"[a-z0-9]+"|[A-Z][A-Z0-9_]*/g)].map((x) => x[0]);
  const out = [];
  for (const token of tokens) {
    if (token.startsWith('"')) {
      out.push(token.slice(1, -1));
      continue;
    }
    // `BUILTIN_MARKS` 里放的是**常量名**（`MEDIA_MARK` …），值在同文件的 `const` 上。
    const resolved = new RegExp(`const ${token}\\s*:\\s*&str\\s*=\\s*"([a-z0-9]+)"`).exec(code);
    if (!resolved) return null;
    out.push(resolved[1]);
  }
  return out;
}
const blueprintTypesForMarks = readFileSync(
  join(ROOT, "crates/hp-core/src/blueprint_types.rs"),
  "utf8",
);
const rustMarks = rustStrArrayOrdered(blueprintTypesForMarks, "BUILTIN_MARKS");
check(
  "系统标记清单 TS ↔ Rust `BUILTIN_MARKS` 逐项相等（含顺序）",
  rustMarks !== null &&
    eqList(rustMarks, [...config.BLUEPRINT_BUILTIN_MARKS]) &&
    rustMarks.length === SYSTEM_MARK_IDS.length,
  rustMarks === null
    ? "Rust BUILTIN_MARKS 解析失败（常量名解析不出值）"
    : `Rust=${rustMarks.join(",")}`,
);

// 三语字典必须**逐键**齐备：`blueprint.mark.<id>` 是蓝图属性面板与标记树共用的显示名。
// 键集一致性由 TS 类型强制（`const` 字典同形），这里钉住**键真的存在**且**10 个都在**。
check(
  "系统标记的显示名三语齐备（`blueprint.mark.<id>` × 10 × zh-CN / zh-TW / en）",
  (() => {
    const dict = (file) =>
      readFileSync(join(ROOT, `apps/desktop/src/app_ui/i18n/${file}`), "utf8");
    const dicts = [dict("zh-CN.ts"), dict("zh-TW.ts"), dict("en.ts")];
    const missing = [];
    for (const [i, src] of dicts.entries()) {
      const lang = ["zh-CN", "zh-TW", "en"][i];
      for (const id of SYSTEM_MARK_IDS) {
        if (!new RegExp(`"blueprint\\.mark\\.${id}":`).test(src)) missing.push(`${lang}:${id}`);
      }
    }
    if (missing.length > 0) console.log(`  缺失键: ${missing.join(", ")}`);
    return missing.length === 0;
  })(),
);
check(
  "bookpreview 有类目（has_class = true，此前为 false：文本类当时没有类目能表达）",
  config.panelSpec("bookpreview")?.hasClass === true,
);
check(
  "fileFormat：扩展名归一到**子类**取值域（markdown → md），非文本与认不出的为空",
  bookView.fileFormat({ media_type: "text", relative_path: "a.epub" }) === "epub" &&
    bookView.fileFormat({ media_type: "text", relative_path: "a.EPUB" }) === "epub" &&
    bookView.fileFormat({ media_type: "text", relative_path: "a.txt" }) === "txt" &&
    bookView.fileFormat({ media_type: "text", relative_path: "a.md" }) === "md" &&
    bookView.fileFormat({ media_type: "text", relative_path: "a.markdown" }) === "md" &&
    bookView.fileFormat({ media_type: "text", relative_path: "a.mobi" }) === "" &&
    bookView.fileFormat({ media_type: "image", relative_path: "a.png" }) === "",
);
check(
  "fileBookMark / fileMarks：标记是**集合**，与子类正交（同一个 txt 可同时是 txt 与 manga）",
  bookView.fileBookMark({ marks: ["book"], relative_path: "a.txt" }) === true &&
    // 用户口径的"标记可以交叉"：同一个 txt 既有 txt 子类、又带 manga 标记。
    bookView.fileFormat({ media_type: "text", relative_path: "a.txt" }) === "txt" &&
    bookView.fileMarks({ marks: ["manga"] })[0] === "manga" &&
    bookView.fileBookMark({ marks: ["manga"], relative_path: "a.txt" }) === false &&
    // **可多值**：book 与 manga 并存。
    bookView.fileBookMark({ marks: ["book", "manga"], relative_path: "a.txt" }) === true &&
    bookView.fileMarks({ marks: ["book", "manga"] }).length === 2 &&
    // 未标记的 txt 不命中 book；旧行（空集合）按扩展名兜底。
    bookView.fileBookMark({ marks: [], relative_path: "a.txt" }) === false &&
    bookView.fileBookMark({ marks: [], relative_path: "a.epub" }) === true,
);
check(
  "bookDispatchTarget：上报带上**三条轴**（mediaType + format + marks）",
  JSON.stringify(
    bookView.bookDispatchTarget({
      id: "f1",
      media_type: "text",
      marks: ["book", "manga"],
      relative_path: "a.txt",
    }),
  ) ===
    JSON.stringify({
      mediaType: "text",
      fileId: "f1",
      format: "txt",
      marks: ["book", "manga"],
    }),
);
// 类目的缺省字段表必须与 `has_class` 的面板集合一致（两处各写一遍必然漂移）。
const classPanelIds = Object.keys(config.PANEL_CLASS_MEDIA_TYPES ?? {}).sort();
const hasClassIds = config.BUILTIN_PANEL_SPECS.filter((s) => s.hasClass)
  .map((s) => s.id)
  .sort();
check(
  "PANEL_CLASS_MEDIA_TYPES 的面板集合 ↔ has_class=true 的内置面板逐项一致",
  eqList(classPanelIds, hasClassIds),
  `classTypes=${classPanelIds.join(",")} hasClass=${hasClassIds.join(",")}`,
);
check(
  "defaultClassFieldsForPanel：四个有类目的面板缺省值**不随扩项漂移**（media=image、bookpreview=text、albums=album、sources=source，未注册=image）",
  JSON.stringify(config.defaultClassFieldsForPanel("bookpreview")) ===
    JSON.stringify({ media_type: "text" }) &&
    JSON.stringify(config.defaultClassFieldsForPanel("media")) ===
      JSON.stringify({ media_type: "image" }) &&
    // D135：相册 / 源两个面板的类目类型**只能**是本面板分域的值（album / source）。
    JSON.stringify(config.defaultClassFieldsForPanel("albums")) ===
      JSON.stringify({ media_type: "album" }) &&
    JSON.stringify(config.defaultClassFieldsForPanel("sources")) ===
      JSON.stringify({ media_type: "source" }) &&
    // 未注册 / 未知面板：与既有行为一致（image，零回归）。
    JSON.stringify(config.defaultClassFieldsForPanel(undefined)) ===
      JSON.stringify({ media_type: "image" }),
);
// **候选顺序 ≠ 缺省值**（D136 的正确形态，单独钉住）：四个面板的候选**首项**现在都是
// `unlimited`，而缺省值仍是 image / text / album / source。若有人把两张表合并回去（"缺省取
// 分域首项"），新建类目就会默认变成 `unlimited`——那会悄悄改变既有观感，且这条断言会红。
check(
  "D136：四个面板的候选首项是 unlimited，但缺省值与它**不同**（两张表没有被合并）",
  ["media", "bookpreview", "albums", "sources"].every(
    (panelId) => config.classMediaTypesForPanel(panelId)[0] === "unlimited",
  ) &&
    ["media", "bookpreview", "albums", "sources"].every(
      (panelId) => config.defaultClassFieldsForPanel(panelId).media_type !== "unlimited",
    ),
  `首项=${["media", "bookpreview", "albums", "sources"].map((p) => config.classMediaTypesForPanel(p)[0]).join(",")} 缺省=${["media", "bookpreview", "albums", "sources"].map((p) => config.defaultClassFieldsForPanel(p).media_type).join(",")}`,
);
// **类目类型的按面板分域**（D135 引入，D136 扩到 9 项）：全量表回答"哪些取值合法"，分域回答
// "该面板下该出现哪几个"。两个函数（TS `classMediaTypesForPanel` / Rust
// `class_media_types_for_panel`）是**跨语言镜像点**，TS ↔ Rust 的逐项相等由
// `check:blueprint-nodes` 断言；这里钉住 **TS 侧**逐面板的取值本身——只断言"长度对得上"会漏掉
// "把 text 塞进 media 的面板"这种静默串位。
const EXPECTED_CLASS_DOMAIN = {
  media: ["unlimited", "image", "video", "audio", "empty"],
  bookpreview: ["unlimited", "text", "pdf", "empty"],
  albums: ["unlimited", "album", "empty"],
  sources: ["unlimited", "source", "empty"],
};
check(
  "classMediaTypesForPanel：四个已注册面板的分域逐项等于约定值（unlimited 首 / empty 尾），未注册 / 无参返回全量 9 项",
  (() => {
    const drift = [];
    for (const [panelId, expected] of Object.entries(EXPECTED_CLASS_DOMAIN)) {
      const actual = [...config.classMediaTypesForPanel(panelId)];
      if (!eqList(actual, expected)) {
        drift.push(`${panelId}: [${actual.join(",")}] ≠ [${expected.join(",")}]`);
      }
    }
    // 未注册面板**不设限**：插件面板宿主不知道它内部有什么分类，给全量（与"未知面板不拦截"同口径）。
    const full = [...config.BLUEPRINT_MEDIA_TYPES];
    const unknown = [...config.classMediaTypesForPanel(undefined)];
    const unregistered = [...config.classMediaTypesForPanel("plugin.demo.unknown")];
    if (!eqList(unknown, full)) drift.push(`未注册: [${unknown.join(",")}] ≠ 全量 9 项`);
    if (!eqList(unregistered, full)) drift.push(`plugin.demo.unknown: [${unregistered.join(",")}] ≠ 全量 9 项`);
    // 分域必须**是**全量表的子集：越域取值一定也被"取值域非法"那条硬错误拦住。
    for (const [panelId, list] of Object.entries(EXPECTED_CLASS_DOMAIN)) {
      for (const value of list) {
        if (!full.includes(value)) drift.push(`${panelId} 的分域含全量表外的取值 ${value}`);
      }
    }
    return drift.length === 0;
  })(),
  `实际 media=[${[...config.classMediaTypesForPanel("media")]}] bookpreview=[${[...config.classMediaTypesForPanel("bookpreview")]}] albums=[${[...config.classMediaTypesForPanel("albums")]}] sources=[${[...config.classMediaTypesForPanel("sources")]}] 全量=${[...config.BLUEPRINT_MEDIA_TYPES].join(",")}`,
);
// `PANEL_CLASS_MEDIA_TYPE_DEFAULTS` 是**缺省值的权威表**（D136）；旧导出
// `PANEL_CLASS_MEDIA_TYPES` 仍存在但**直接指向它**（同一对象 / 同值），供既有消费方无痛迁移。
// 这条断言钉住"缺省表本身"的内容——它是"候选顺序与缺省值分离"里**缺省**那一半的真相。
check(
  "D136：`PANEL_CLASS_MEDIA_TYPE_DEFAULTS` 四面板缺省逐项正确，旧导出 PANEL_CLASS_MEDIA_TYPES 指向同一份缺省",
  JSON.stringify(config.PANEL_CLASS_MEDIA_TYPE_DEFAULTS) ===
    JSON.stringify({
      media: "image",
      bookpreview: "text",
      albums: "album",
      sources: "source",
    }) &&
    JSON.stringify(config.PANEL_CLASS_MEDIA_TYPES) ===
      JSON.stringify(config.PANEL_CLASS_MEDIA_TYPE_DEFAULTS),
  `DEFAULTS=${JSON.stringify(config.PANEL_CLASS_MEDIA_TYPE_DEFAULTS)} 旧导出=${JSON.stringify(config.PANEL_CLASS_MEDIA_TYPES)}`,
);
check(
  "defaultSubclassFormatFor：取该类目分域的第一个取值；无分域返回空串（据此拒绝建子类）",
  config.defaultSubclassFormatFor("text") === "epub" &&
    config.defaultSubclassFormatFor("image") === "" &&
    config.defaultSubclassFormatFor(undefined) === "",
);
check(
  "图书预览面板把单击 / 双击上报蓝图引擎（此前本面板完全不发事件）",
  /app\.dispatch\(\{\s*trigger:\s*"click"/.test(bookFamilySrc) &&
    /app\.dispatch\(\{\s*trigger:\s*"double_click"/.test(bookFamilySrc) &&
    /bookDispatchTarget\(/.test(bookFamilySrc) &&
    // 三个视图的单元都要接上双击（只接一个视图 = 另两个视图静默不生效）。
    (bookFamilySrc.match(/onDoubleClick=\{cellDoubleClick\}/g) ?? []).length === 3,
);
check(
  "nextScrollLeft：两端夹紧；没有可滚动的余量时返回 0",
  bookView.nextScrollLeft(0, -40, 100) === 0 &&
    bookView.nextScrollLeft(50, 20, 100) === 70 &&
    bookView.nextScrollLeft(95, 20, 100) === 100 &&
    bookView.nextScrollLeft(10, 5, 0) === 0,
);
check(
  "wrapCoverName：只在**真的截断**时加省略号，且不超过行数上限",
  eqList(bookView.wrapCoverName("一二三", 6, 4), ["一二三"]) &&
    eqList(bookView.wrapCoverName("一二三四五六七", 3, 4), ["一二三", "四五六", "七"]) &&
    // 7 个字 / 每行 3 / 最多 2 行 → 第二行被截断，末尾必须出现省略号。
    eqList(bookView.wrapCoverName("一二三四五六七", 3, 2), ["一二三", "四五…"]) &&
    bookView.wrapCoverName("   ", 3, 2).length === 0,
);
check(
  "textCoverHue：同名恒同色、取值落在色相环内（跨会话稳定，不随随机数变）",
  bookView.textCoverHue("同一本书") === bookView.textCoverHue("同一本书") &&
    [1, 2, 3, 4, 5].every((n) => {
      const hue = bookView.textCoverHue(`书${n}`);
      return Number.isInteger(hue) && hue >= 0 && hue < 360;
    }),
);
check(
  "取值域与纯函数模块**零依赖**（无 React / Tauri，门禁可直接 import）",
  !/from\s+"react"/.test(bookViewSrc) &&
    !/@tauri-apps/.test(bookViewSrc) &&
    !/^\s*import\s/m.test(bookViewSrc),
);

// 面板侧：设置消费、冻结、取数口径。
check(
  "面板经 `usePanelSettingValue` 消费 view / coverSize，且注册表把 dockview API 传下去",
  /usePanelSettingValue\(\s*BOOK_PREVIEW_PANEL_ID,\s*"view"/.test(bookFamilySrc) &&
    /usePanelSettingValue\(\s*BOOK_PREVIEW_PANEL_ID,\s*"coverSize"/.test(bookFamilySrc) &&
    // 第 4 条触发源（面板重新可见时补读设置）需要面板 API。
    /<BookPreviewPanel api=\{ctx\.api\}/.test(registrySource),
);
check(
  "工具条有**媒体预览同款**的封面宽度滑条（range + 夹紧范围 + 步进 + 数字显示）",
  // 滑块复用 `mp-size*` 样式类（同款），min/max/step 取自取值域常量。
  /<span className="mp-size">/.test(bookFamilySrc) &&
    /type="range"/.test(bookFamilySrc) &&
    /className="mp-size-range"/.test(bookFamilySrc) &&
    /min=\{BOOK_COVER_SIZE_MIN\}/.test(bookFamilySrc) &&
    /max=\{BOOK_COVER_SIZE_MAX\}/.test(bookFamilySrc) &&
    /step=\{BOOK_COVER_SIZE_STEP\}/.test(bookFamilySrc) &&
    /className="mp-size-value"/.test(bookFamilySrc),
);
check(
  "列表 / 封面模式的信息三行共用一个 `BookRowInfo`，作者与简介带前缀（作者：/简介：）",
  // 共享组件 + i18n 键（不硬编码中文）——两模式规则一致的落点。
  /<BookRowInfo/.test(bookFamilySrc) &&
    /book\.authorLabel/.test(bookFamilySrc) &&
    /book\.descLabel/.test(bookFamilySrc) &&
    /const MISSING = "—"/.test(bookFamilySrc),
);
check(
  "简介截断行数经 `--bp-desc-lines` 下发（面板算行数，CSS 只消费）",
  /"--bp-desc-lines":\s*String\(bookDescLineCount\(coverSize\)\)/.test(bookFamilySrc) &&
    /"--bp-cover-size":\s*`\$\{coverSize\}px`/.test(bookFamilySrc),
);
check(
  "面板按后台可见性冻结条目容器（不显示就不为看不见的书取封面）",
  /usePanelForeground\(panelApi\)/.test(bookFamilySrc) &&
    /foreground\s*&&/.test(bookFamilySrc),
);
check(
  "取数只按仓库 / 源 / 目录过滤「书」的两个类目（不按相册：相册成员分页只认三种媒体字面量）",
  // 2026-10-11：PDF 与文本类**同在图书预览**（用户口径"图书预览增加 pdf 支持"），
  // 因此过滤集合是两个类目，不是 `["text"]` 一个。
  /mediaTypes:\s*\[\.\.\.BOOK_MEDIA_TYPES\]/.test(bookFamilySrc) &&
    /const BOOK_MEDIA_TYPES = \["text", "pdf"\] as const/.test(bookFamilySrc) &&
    !/albumId/.test(bookFamilySrc) &&
    // 反向：不得再出现旧的单值拼法（媒体类型过滤已改为集合，D95）。
    !/mediaType:\s*"text"/.test(bookFamilySrc),
);

// 文件名滚轮横滚：**必须是原生非被动监听**。
const bookCardSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[1]), "utf8");
/** 共享右键菜单源码（封面覆盖经它的 `extraItems` 插槽挂进来）。 */
const mediaMenuSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewMenu.tsx"),
  "utf8",
);
// 封面覆盖相关的家族文件（在下面的断言里被多处引用，提前读以免踩 `const` 的 TDZ）。
const bookCoverArtSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[5]), "utf8");
const bookTextCoverSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[6]), "utf8");
const bookCoverCacheSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[11]), "utf8");
const bookCoverMenuSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[13]), "utf8");
const bookCardCode = stripComments(bookCardSrc);
check(
  "文件名滚轮横滚走**原生监听器 + { passive: false }**（React 的 onWheel 是被动的，preventDefault 无效）",
  /addEventListener\(\s*"wheel"/.test(bookCardCode) &&
    /passive:\s*false/.test(bookCardCode) &&
    /preventDefault\(\)/.test(bookCardCode) &&
    // 反向：不得用 React 的合成事件（它拦不住滚动，名字会与面板一起滚）。
    !/onWheel=/.test(bookCardCode) &&
    // DOM 事件类型必须是 `WheelEvent`：拿 React 的合成事件类型去接原生监听会读不到 deltaY 的真实语义。
    /WheelEvent/.test(bookCardCode),
);
check(
  "没被省略就不拦截滚轮（拦截它会让滚动列表在长名字单元上失灵）",
  /max\s*<=\s*0\)\s*return/.test(bookCardCode),
);

// 文件名可聚焦（"焦点在文件名上"要字面上成立）+ 三种截断形态齐备 + 封面模式右栏规格。
check(
  "卡片模式的文件名可聚焦（tabIndex），三种视图的文本截断形态齐备",
  /tabIndex=\{0\}/.test(bookCardSrc) &&
    // 卡片：单行省略。
    /\.bp-name\s*\{[^}]*overflow:\s*hidden/.test(stylesSource) &&
    /\.bp-name\s*\{[^}]*text-overflow:\s*ellipsis/.test(stylesSource) &&
    /\.bp-name\s*\{[^}]*white-space:\s*nowrap/.test(stylesSource) &&
    // 列表/封面模式：文件名与作者各单行省略，简介多行截断。
    /\.bp-row-name\s*\{[^}]*text-overflow:\s*ellipsis/.test(stylesSource) &&
    /\.bp-row-author\s*\{[^}]*text-overflow:\s*ellipsis/.test(stylesSource) &&
    // 钉住"行数来自封面高度"：clamp 必须读 `--bp-desc-lines`，不许退回写死的数字。
    /\.bp-row-desc\s*\{[^}]*webkit-line-clamp:\s*var\(--bp-desc-lines/.test(stylesSource),
);
check(
  "封面模式：网格列宽固定（不拉伸）+ 右栏 = 封面宽度 × 2",
  // 单元格总宽 = 封面 + 间距 + 2 倍封面（与 `bookCoverCellWidth` 同款算术）。
  /\.bp-cover-grid\s*\{[^}]*calc\(var\(--bp-cover-size[^}]*\*\s*3\s*\+\s*10px\)/.test(
    stylesSource,
  ) &&
    /\.bp-cover-cell-info\s*\{[^}]*width:\s*calc\(var\(--bp-cover-size[^}]*\*\s*2\)/.test(
      stylesSource,
    ) &&
    // 右栏 flex: none——"不填充剩余空间"在布局层面的字面保证。
    /\.bp-cover-cell-info\s*\{[^}]*flex:\s*none/.test(stylesSource),
);

// ---- 封面外观：**白底 + 容器阴影**（2026-10-09 用户口径）----
//
// 用户原话："图书预览的 epub 的封面的背景改为白色，并为封面容器添加阴影"。
// 两件事都必须在**同一份 CSS** 上（三种视图共用 `.bp-art`），否则只有一种视图变。
check(
  "封面容器白底（不跟主题走）+ 有投影（用户口径 2026-10-09）",
  // 底色必须是**字面白色**而不是主题变量：跟主题走会在深色下变成一圈深灰，
  // 看着像图没加载完（`contain` 留出的就是这层底色）。
  /\.bp-art\s*\{[^}]*background:\s*#fff/i.test(stylesSource) &&
    // 投影：两段（近处实、远处散）。
    /\.bp-art\s*\{[^}]*box-shadow:/.test(stylesSource) &&
    // 深色主题下另给一组更重的投影（同样的 alpha 在深底上几乎看不见）。
    /\.app-root\.theme-dark\s+\.bp-art\s*\{[^}]*box-shadow:/.test(stylesSource),
);
check(
  "内嵌封面加载完成后藏起打底的文字封面（否则 `contain` 的白边里会透出彩色渐变）",
  /\.bp-art\.bp-art-loaded\s+\.bp-textcover\s*\{[^}]*display:\s*none/.test(stylesSource) &&
    // 面板侧：有图时才加 `bp-art-loaded`（加载中 / 失败时文字封面仍在 = 无空窗）。
    /bp-art-loaded/.test(bookCoverArtSrc) &&
    /className=\{`bp-art\$\{imageSrc \? " bp-art-loaded" : ""\}`\}/.test(bookCoverArtSrc),
);

// ---- 封面覆盖：颜色 / 自定义图片（2026-10-09 用户口径："txt 右键可以更换封面颜色或自定义图片"）----
//
// 这一段的守护重点是四件**看不见就必然是缺陷**的事：
// 1. **优先级**：图片覆盖 > 颜色覆盖 > 内嵌封面 / 文字封面。颜色必须**压过内嵌封面**，
//    否则对 epub 设颜色毫无效果（图盖在上面），用户会以为功能坏了；
// 2. **不是第二份菜单**：挂在共享菜单的 `extraItems` 插槽里（缺陷 0013 的 portal 口径）；
// 3. **批量取**：一页几百本不能逐本一次 IPC；且**按 id 记账**而不是按仓库整体去重
//    （翻页时每次带的 id 更多，整体去重会让新一页的封面永远取不到）；
// 4. **目录穿越**：库里的文件名会拼进磁盘路径，安全校验在后端（`hp_core`）与桥接层各一道。

check(
  "封面覆盖的**优先级**：图片 > 颜色 > 内嵌封面（颜色必须压过内嵌封面）",
  // 颜色覆盖时不出内嵌封面（`override === null` 是内嵌封面的前提）。
  /const embedded = override === null && coverUrl \? coverUrl : null;/.test(bookCoverArtSrc) &&
    // 图源：覆盖图片优先，其次内嵌。
    /const candidate = overrideImage \?\? embedded;/.test(bookCoverArtSrc) &&
    // 文字封面接颜色覆盖（用户选的纯色）。
    /colorOverride=\{override\?\.kind === "color" \? override\.value : null\}/.test(
      bookCoverArtSrc,
    ) &&
    // 文字封面：给了颜色就用它，否则回落到派生色相的渐变。
    /const background =\s*\n?\s*colorOverride \?\?/.test(bookTextCoverSrc),
);
check(
  "图片加载失败按**图源**记录（不是一个布尔）：内嵌封面失败不得压住用户设的图片",
  /const \[failedSrc, setFailedSrc\] = useState<string \| null>\(null\)/.test(bookCoverArtSrc) &&
    /candidate !== failedSrc \? candidate : null/.test(bookCoverArtSrc) &&
    // 反向：不得再用一个布尔去表达"哪张图失败了"。
    !/const \[failed, setFailed\] = useState\(false\)/.test(bookCoverArtSrc),
);
check(
  "「更换封面」与「book 标记」挂在**共享菜单的插槽**里（不是第二份菜单）",
  /extraItems\?: ReactNode;/.test(mediaMenuSrc) &&
    // 共享菜单把它渲染在标准动作之后、删除之前。
    /\{extraItems && \(/.test(mediaMenuSrc) &&
    // 两个图书特有的附加项都经同一个 `extraItems` 插槽（先标记开关、后更换封面）。
    /extraItems=\{[\s\S]{0,200}?<BookMarkMenu[\s\S]{0,400}?<BookCoverMenu/.test(bookFamilySrc) &&
    // 反向：图书家族不得再 import portal 容器自己拼一份（缺陷 0013 的 portal 口径）。
    !/from "\.\.\/menu\/ContextMenu"/.test(bookFamilySrc),
);
check(
  "封面覆盖**批量取**（一页一次），且按 **id 粒度**记账（翻页时 id 会变多）",
  /export function loadBookCovers\(repoId: string, fileIds: string\[\]\)/.test(bookCoverCacheSrc) &&
    /const fresh = fileIds\.filter\(\(id\) => !done\.has\(id\)\)/.test(bookCoverCacheSrc) &&
    // 面板在 `items` 变化时批量拉一次。
    /void loadBookCovers\(\s*\n?\s*app\.repoId,\s*\n?\s*items\.map\(\(item\) => item\.id\),\s*\n?\s*\);/.test(
      bookFamilySrc,
    ) &&
    // 反向：不得逐本发一次命令（那正是批量要避免的形态）。
    !/items\.map\(\(item\) => void loadBookCovers/.test(bookFamilySrc),
);
check(
  "改完封面**失效缓存 + 刷新**（刷新会让批量取重跑，界面随即跟上）",
  /invalidateBookCovers\(app\.repoId\)/.test(bookFamilySrc) &&
    /invalidateBookCovers\(repoId\)/.test(bookFamilySrc) &&
    /app\.refresh\(\)/.test(bookFamilySrc) &&
    // 失效必须把**记账**也清掉，否则那一本被记为"已请求过"、重新拉不到。
    /requestedIds\.delete\(repoId\)/.test(bookCoverCacheSrc),
);
check(
  "封面设置失败要报错（静默失败会让用户以为「设了但没生效」）",
  /book\.cover\.setFailed/.test(bookFamilySrc) &&
    /errorTextOf\(app\.t, e\)/.test(bookFamilySrc),
);
check(
  "「恢复默认」只在**真有覆盖**时给出（否则是一个必然无效果的空操作）",
  /hasOverride &&/.test(bookCoverMenuSrc) &&
    /hasOverride=\{menuFileOverride !== null\}/.test(bookFamilySrc),
);
check(
  "颜色是**预设色板 + 系统取色器**两种入口（快速挑一个 / 任意颜色）",
  /BOOK_COVER_PRESET_COLORS/.test(bookCoverMenuSrc) &&
    /type="color"/.test(bookCoverMenuSrc) &&
    /\.bp-cover-swatch\s*\{/.test(stylesSource) &&
    /\.bp-cover-picker\s*\{/.test(stylesSource),
);


// ---- 右键菜单（2026-10-09 用户口径："图书预览用媒体预览同款右键菜单"）----
//
// "同款"落在三件事上，各由断言钉住：
// 1. **同一份实现**——菜单的开关/定位/菜单项与四类文件动作都复用媒体预览那两个模块
//    （`mediaPreviewMenu` / `mediaPreviewActions`），本家族不得再出现第二份菜单；
// 2. **删除不按相册分流**——文本类文件进不了相册成员列表（相册成员分页只认三个媒体
//    字面量），跟着"当前选中的相册"走会把删除变成"移出相册 0 项"的静默空操作，
//    文件还在盘上；同时媒体预览那一侧的缺省不许被这次改动带偏；
// 3. **三种视图同一套口径**——单元只回传"点的是哪一本"（并自己挡掉默认菜单），
//    选中集、菜单定位与菜单项都在面板侧；回调必须是恒定引用（单元是 `memo` 的）。
const bookRowSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[2]), "utf8");
const bookCoverCellSrc = readFileSync(join(ROOT, BOOK_FAMILY_FILES[3]), "utf8");
/** 选中态类名的字面拼法（三视图同款，跟着 `selected` 走）。 */
const selectedClassLiteral = (cls) => `className={\`${cls}\${selected ? " selected" : ""}\`}`;
const bookCellViews = [
  ["卡片", bookCardSrc, "bp-card"],
  ["列表", bookRowSrc, "bp-row"],
  ["封面", bookCoverCellSrc, "bp-cover-cell"],
];
check(
  "图书预览的右键菜单就是**媒体预览那一份**（复用开关与菜单项，不自建第二份菜单）",
  /import \{ MediaContextMenu, useMediaContextMenu \} from "\.\.\/mediaPreviewMenu"/.test(
    bookFamilySrc,
  ) &&
    /const menu = useMediaContextMenu\(\);/.test(bookFamilySrc) &&
    /<MediaContextMenu/.test(bookFamilySrc) &&
    // 反向：不得绕过共享菜单、直接拿 portal 容器自己拼一份（缺陷 0013 的 portal 口径也会跟着丢）。
    !/from "\.\.\/menu\/ContextMenu"/.test(bookFamilySrc),
);
check(
  "四类文件动作复用媒体预览那一份，且**删除不按相册分流**（文本类进不了相册成员列表）",
  /import \{ useMediaFileActions \} from "\.\.\/mediaPreviewActions"/.test(bookFamilySrc) &&
    /useMediaFileActions\(\{ albumScoped: false \}\)/.test(bookFamilySrc) &&
    // 媒体预览的缺省必须仍是"按相册上下文分流"：这条改了 = 相册里删除变成真删盘。
    /albumScoped = true,/.test(mediaActionsSrc),
);
check(
  "三种视图的单元接同一套选中 / 右键口径（选中态类名 + 回传 props + 先挡默认菜单）",
  bookCellViews.every(
    ([, src, cls]) =>
      src.includes(selectedClassLiteral(cls)) &&
      /onSelect: \(file: FileItem\) => void;/.test(src) &&
      /onContextMenu: \(file: FileItem, e: ReactMouseEvent\) => void;/.test(src) &&
      /onClick=\{\(\) => onSelect\(item\)\}/.test(src) &&
      /e\.preventDefault\(\);/.test(src) &&
      /onContextMenu\(item, e\);/.test(src),
  ),
  bookCellViews
    .filter(([, src, cls]) => !src.includes(selectedClassLiteral(cls)))
    .map(([name]) => name)
    .join(","),
);
check(
  "面板：三种视图三处接线齐备 + 回调恒定引用 + 右键先落选中（菜单项由所选数量决定）",
  (bookFamilySrc.match(/selected=\{app\.selectedIds\.has\(item\.id\)\}/g) || []).length === 3 &&
    (bookFamilySrc.match(/onSelect=\{cellSelect\}/g) || []).length === 3 &&
    (bookFamilySrc.match(/onContextMenu=\{cellContextMenu\}/g) || []).length === 3 &&
    /const cellSelect = useStableCallback\(selectBook\);/.test(bookFamilySrc) &&
    /const cellContextMenu = useStableCallback\(openMenu\);/.test(bookFamilySrc) &&
    // 右键 = 先按选中口径落选中，再在光标处开菜单（顺序反了会删错文件）。
    /ensureSelected\(file\);\s*\n\s*menu\.open\(file, e\);/.test(bookFamilySrc) &&
    /selectedCount=\{selectedCount\}/.test(bookFamilySrc) &&
    // 计数只数**本面板列出的书**：别处残留的选中项不能把"是否单选"判断带偏。
    /items\.reduce\(\(n, item\) => \(app\.selectedIds\.has\(item\.id\) \? n \+ 1 : n\), 0\)/.test(
      bookFamilySrc,
    ),
);
check(
  "三种视图的选中态是同一份 CSS（同款 token；用 outline 不吃掉网格间距）",
  /\.bp-card\.selected,\s*\n\.bp-row\.selected,\s*\n\.bp-cover-cell\.selected\s*\{[\s\S]{0,220}?outline:\s*1px solid var\(--sel-border\)/.test(
    stylesSource,
  ) &&
    /\.bp-card\.selected,[\s\S]{0,220}?background:\s*var\(--sel-bg\)/.test(stylesSource),
);

// 元数据取数：只对需要内嵌封面的书发命令，且有缓存 + in-flight 去重。
check(
  "只为需要内嵌封面的书取元数据（txt/md 一个 IPC 都不发），并做结果缓存与 in-flight 去重",
  /if\s*\(!repoId\s*\|\|\s*!wants\)/.test(bookFamilySrc) &&
    /inflight/.test(bookFamilySrc) &&
    /const cached = metaCache\.get\(fileId\)/.test(bookFamilySrc),
);

// 桥接层：命令形态、坏书降级、封面落盘路径。
const bookBridgeSrc = BOOK_BRIDGE_SRC;
check(
  "book.meta 是已包装命令，解析在阻塞线程里跑，坏书降级为「没有元数据」而不是错误",
  /pub\(crate\) async fn book_meta\(/.test(bookBridgeSrc) &&
    /ApiAsync<BookMetaResult>/.test(bookBridgeSrc) &&
    /spawn_blocking/.test(bookBridgeSrc) &&
    // 降级写法二选一：显式 match 或 unwrap_or_default（clippy 会要求后者）。
    // 断言的是"坏书 → 默认值、不抛错"这个**行为**，不是具体语法。
    (/Err\(_\) => hp_book::BookMeta::default\(\)/.test(bookBridgeSrc) ||
      /read_book_meta\(source_path\)\.unwrap_or_default\(\)/.test(bookBridgeSrc)),
);
check(
  "封面原格式落盘（不转码），元数据缓存按内容哈希失效",
  /path_for_book_cover/.test(bookBridgeSrc) && /path_for_book_meta/.test(bookBridgeSrc),
);

// 文本媒体类型与子类型：跨层口径只有一处。
const coreSourceSrc = readFileSync(join(ROOT, "crates/hp-core/src/source.rs"), "utf8");
const scannerMediaTypeSrc = readFileSync(
  join(ROOT, "crates/hp-scanner/src/media_type.rs"),
  "utf8",
);
// 蓝图取值域（系统标记清单 **10 项**在这里定义，D102 扩为 2 项、D134 扩为 10 项）。
const blueprintTypesSrc = readFileSync(
  join(ROOT, "crates/hp-core/src/blueprint_types.rs"),
  "utf8",
);
// 文件模型（`default_book_mark_for_ext` 的唯一来源在 hp-core 的 file.rs）。
const coreFileSrc = readFileSync(join(ROOT, "crates/hp-core/src/file.rs"), "utf8");
check(
  "Rust 侧 `text` 媒体类型与**标记**取值域齐备（标记可多值、不再有 document 子类型）",
  /MediaType::Text => "text"/.test(coreSourceSrc) &&
    /"text" => Some\(MediaType::Text\)/.test(coreSourceSrc) &&
    // 默认标记表在扫描器（`default_file_marks` 调 hp-core 的 `default_book_mark_for_ext`），
    // 而 epub → book 的**映射本身**在 hp-core（唯一来源）。
    /default_book_mark_for_ext/.test(scannerMediaTypeSrc) &&
    /default_book_mark_for_ext[\s\S]{0,200}?BOOK_MARK/.test(coreFileSrc) &&
    // 内置标记清单含 book 与 manga（用户口径的例子；D134 扩为 10 项后这两项仍在，
    // 它们是 `file_marks` 存量值与 epub/pdf 默认标记的落库字面量，字面量不得改）。
    /BOOK_MARK/.test(blueprintTypesSrc) &&
    /MANGA_MARK/.test(blueprintTypesSrc) &&
    // 旧 `document` 子类型**已废弃**：扫描器不再产出它（`FileSubtype` 枚举本身已删除）。
    !/FileSubtype/.test(scannerMediaTypeSrc) &&
    // 文本类**只认扩展名**：不参与内容兜底（否则未知二进制会被吸进索引）。
    !/sniff[\s\S]{0,400}MediaType::Text/.test(scannerMediaTypeSrc),
);
check(
  "迁移 0010 建 `file_marks` 多值标记表、搬迁旧 book 子类型，且登记进迁移清单（forward-only，不改 0001）",
  // 0010 的要点：一对多表 + 存量搬迁（只搬 book，不搬 document）。
  (() => {
    const m = readFileSync(
      join(ROOT, "crates/hp-repo/migrations/repo/0010_file_marks.sql"),
      "utf8",
    );
    // 只取**可执行语句**（去掉 `--` 注释）再断言，避免注释里提到 `document` 就误判。
    const sql = m
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    return (
      /CREATE TABLE file_marks/.test(sql) &&
      // 一对多：主键是 (file_id, mark)，因此同一文件可带多个标记。
      /PRIMARY KEY \(file_id, mark\)/.test(sql) &&
      // 存量搬迁：只搬 `book`。
      /WHERE subtype = 'book'/.test(sql) &&
      // 语句里**不得**出现 `document`（它不是标记状态，不该被搬成标记）。
      !/document/.test(sql)
    );
  })() &&
    /0010_file_marks\.sql/.test(
      readFileSync(join(ROOT, "crates/hp-repo/src/repo_db.rs"), "utf8"),
    ) &&
    // 0001 是 forward-only，不得被改（其中不应出现标记相关字样）。
    !/subtype|file_marks/.test(
      readFileSync(join(ROOT, "crates/hp-repo/migrations/repo/0001_init.sql"), "utf8"),
    ),
);
check(
  "Rust：`file.query` 的媒体类型过滤是**集合**（四个固定旗标 ⇒ SQL 静态、参数个数固定）",
  /pub media_types: &'a \[MediaType\]/.test(
    readFileSync(join(ROOT, "crates/hp-repo/src/file_repo.rs"), "utf8"),
  ) &&
    /media_types: Option<Vec<String>>/.test(
      readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/file.rs"), "utf8"),
    ) &&
    // 空集合 = 不筛（不是"什么都不返回"）；非空即"只这些"。
    /空切片 = 不筛/.test(
      readFileSync(join(ROOT, "crates/hp-repo/src/file_repo.rs"), "utf8"),
    ),
);
check(
  "Rust：相册属性一律不含「书」（文本类 + PDF；`Multimedia` 是三种媒体，不是「索引里的一切」）",
  // 否则跟随源相册会把文本 / PDF 文件**写成成员**，而 `query_album_members_page` 只认三个
  // 媒体字面量、永远列不出它们——表现为"有成员但看不见"。
  //
  // 判据用 `MediaType::is_book()`（**唯一**定义在 `source.rs`）而不是逐个列
  // `Text | Pdf`：相册的排除集就是"图书预览的收录集"，两处必须是同一件事——
  // 下次再新增"书"类型时，只要它进了 `is_book()`，相册这一侧自动跟上。
  /if file_type\.is_book\(\) \{\s*\n\s*return false;/.test(
    readFileSync(join(ROOT, "crates/hp-core/src/album.rs"), "utf8"),
  ) &&
    // 正向锚点：`is_book` 必须真的把 text 与 pdf 都算进去。
    (() => {
      const source = readFileSync(join(ROOT, "crates/hp-core/src/source.rs"), "utf8");
      return /pub fn is_book\(&self\) -> bool \{\s*\n\s*matches!\(self, MediaType::Text \| MediaType::Pdf\)/.test(
        source,
      );
    })(),
);

// ==================== PDF 支持（断言）====================
//
// 口径与「用户原话」见上面 `usesEmbeddedCover` 之后那一段说明；
// 断言放在这里，是因为下面这几条要读的源码常量（`coreSourceSrc` /
// `scannerMediaTypeSrc` / `scannerScanTaskSrc` / `coreFileSrc`）在上文才声明。
const coreAlbumSrc = readFileSync(join(ROOT, "crates/hp-core/src/album.rs"), "utf8");
check(
  "Rust：`pdf` 是**独立媒体类型**（不是并进 text），且 `is_book()` 是「书」的唯一判据",
  /MediaType::Pdf => "pdf"/.test(coreSourceSrc) &&
    /"pdf" => Some\(MediaType::Pdf\)/.test(coreSourceSrc) &&
    /matches!\(self, MediaType::Text \| MediaType::Pdf\)/.test(coreSourceSrc) &&
    // 相册与图书预览必须共用同一条判据（两处各写一遍必然漂移）。
    /if file_type\.is_book\(\)/.test(coreAlbumSrc),
);
check(
  "Rust：PDF **走内容兜底**（`%PDF-` magic bytes），与文本类**刻意相反**",
  // 这是 D11「扩展名优先 + 内容兜底」里内容兜底该发挥作用的地方：
  // 改名的 PDF（`a.dat`）也能正确入库。而 txt / md 没有 magic bytes，
  // 任何"看着像文本"的兜底都会把未知二进制吸进索引。
  /b"%PDF-"[\s\S]{0,40}MediaType::Pdf/.test(scannerMediaTypeSrc) &&
    /"pdf" => Some\(MediaType::Pdf\)/.test(scannerMediaTypeSrc),
);
check(
  "Rust：`pdf` 与文本类**入库口径相同**（照算内容哈希、不产出索引期派生数据）",
  // 合成一个 arm 写两遍一模一样的代码，只会在下次改动时漏掉其中一个。
  /MediaType::Text \| MediaType::Pdf => \{/.test(
    readFileSync(join(ROOT, "crates/hp-scanner/src/scan_task.rs"), "utf8"),
  ) &&
    // 缩略图：PDF 的封面走 `book.meta` 的磁盘缓存，索引期**不**产出缩略图。
    /MediaType::Text \| MediaType::Pdf => false/.test(
      readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/file.rs"), "utf8"),
    ) &&
    // 缩略图格式表：文本与 PDF 都没有缩略图（`hp-media`）。
    // **音频不在这一支**（2026-10-17 / D115）：它有自己的波形图格式
    // （`ThumbFormat::WaveformPng`，见下一条断言），因此这里的取值域只含文本与 PDF。
    /MediaType::Text \| MediaType::Pdf => None/.test(
      readFileSync(join(ROOT, "crates/hp-media/src/cache.rs"), "utf8"),
    ),
);
check(
  "Rust：音频（D115）有内容哈希 + ffprobe 元数据，缩略图格式是**波形 PNG**",
  // 这条把 D11 → D115 的升级钉在三处落点上，任一处漏掉就是"升了级却还是占位行"：
  //  ① `scan_task` 的 `MediaType::Audio` 分支**照算内容哈希**（移动识别/去重靠它），
  //     并调 ffprobe 取媒体信息（此前索引里根本没有音频时长）；
  //  ② `scanner` 判 `verify_status = Ok`（不再是 `Placeholder`），且**存量占位行**
  //     即使 size/mtime 未变也要补算（`needs_audio_upgrade`，判据是哈希缺失）；
  //  ③ `hp-media` 的格式表给音频**波形 PNG**（透明背景，三套主题共用一张图）。
  //
  // 反向锚点同样重要：音频**不得**有感知哈希（它没有视觉本体，与文本/PDF 同款）。
  (() => {
    const scanTask = readFileSync(join(ROOT, "crates/hp-scanner/src/scan_task.rs"), "utf8");
    const scanner = readFileSync(join(ROOT, "crates/hp-scanner/src/scanner.rs"), "utf8");
    const cache = readFileSync(join(ROOT, "crates/hp-media/src/cache.rs"), "utf8");
    const waveform = readFileSync(join(ROOT, "crates/hp-media/src/waveform.rs"), "utf8");
    return (
      // ① 音频分支里有 `hash_file`，且不再返回默认的"空 Computed"。
      /MediaType::Audio => \{[\s\S]{0,700}hash_file\(&prepared\.path\)/.test(scanTask) &&
      // 音频调 ffprobe 取元数据（与视频同一份 `hp_media::probe`，不是第二条命令）。
      /fn probe_audio\([\s\S]{0,300}hp_media::probe\(/.test(scanTask) &&
      // ② 校验状态不再按媒体类型分流成 placeholder。
      !/VerifyStatus::Placeholder/.test(scanner) &&
      // 存量占位行必须被补算，且判据是**哈希缺失**（不是 status 镜像）。
      /needs_audio_upgrade[\s\S]{0,200}content_hash\.is_none\(\)/.test(scanner) &&
      /unchanged && !needs_audio_upgrade/.test(scanner) &&
      // ③ 波形 PNG 这个格式本身，以及它走的是 ffmpeg `showwavespic`。
      /MediaType::Audio => Some\(ThumbFormat::WaveformPng\)/.test(cache) &&
      /WaveformPng => "png"/.test(cache) &&
      /showwavespic/.test(waveform) &&
      // 波形图用 `hidden_command`（GUI 下不弹控制台，与其它四个接入口同款）。
      /hidden_command\(ffmpeg_bin\)/.test(waveform)
    );
  })(),
);
check(
  "Rust：`pdf` 默认带 **book 标记**（决定封面来源），且 hp-core 与面板侧的兜底清单一致",
  // 后端：唯一来源是 `default_book_mark_for_ext`。
  /eq_ignore_ascii_case\("epub"\) \|\| ext\.eq_ignore_ascii_case\("pdf"\)/.test(coreFileSrc) &&
    // 前端：旧行兜底的扩展名清单必须与后端**逐项一致**，否则"还没重扫"期间
    // 面板会与后端给出不同的封面来源。
    /DEFAULT_BOOK_MARK_EXTS = \["epub", "pdf"\] as const/.test(bookViewSrc),
);
check(
  "Rust：桥接层按**媒体类型**分流到 PDF 解析器（不是按扩展名猜），且封面落盘复用同一条路径",
  (() => {
    const bridge = BOOK_BRIDGE_SRC;
    return (
      // book.meta：PDF → `hp_pdf` 栅格化第一页；文本类 → `hp_book` 解 OPF。
      /MediaType::Pdf => parse_pdf_and_cache/.test(bridge) &&
        /hp_pdf::read_pdf_meta/.test(bridge) &&
        // 封面与 EPUB **共用** `path_for_book_cover`（前端因此只有一条渲染路径）。
        /path_for_book_cover\(hash, cover\.ext\)/.test(bridge) &&
        // 解析放阻塞线程（栅格化实测 20–122 ms，不能占 IPC 线程）。
        /spawn_blocking/.test(bridge)
    );
  })(),
);
check(
  "Rust：`book.content` 的 PDF 分支**逐页栅格化**，游标是**页码**（与 epub 同形）",
  (() => {
    const bridge = BOOK_BRIDGE_SRC;
    return (
      // **按媒体类型分流，不按扩展名**：扫描器对 PDF 做了 `%PDF-` 内容兜底，
      // 因此扩展名被改掉的 PDF（`a.dat`）也会入库为 `media_type = pdf`；
      // 按扩展名分流会把它当 GBK 文本解码（满屏乱码）。
      /fn read_page_by_media_type\(/.test(bridge) &&
        /if media_type == MediaType::Pdf \{\s*\n\s*return read_pdf_page/.test(bridge) &&
        // 调用点把 `ReaderCtx`（正文缓存 + 落盘缓存）整体传下去：2026-10-16 起
        // 阅读器的整本缓存与查看器共用同一条分页实现。
        /read_page_by_media_type\(media_type, &src_path, &ext, offset, &ctx\)/.test(bridge) &&
        /fn read_pdf_page\(/.test(bridge) &&
        /hp_pdf::render_page_jpeg/.test(bridge) &&
        /hp_pdf::PDF_PAGE_WIDTH/.test(bridge) &&
        // 分页形态与 epub 一致：前端只有一套翻页与进度提示。
        /section_count: Some\(total\)/.test(bridge) &&
        /format: "pdf"\.into\(\)/.test(bridge) &&
        // 反向：不得再出现"按扩展名分流到 pdf"的写法（那正是本缺口）。
        !/"pdf" => read_pdf_page/.test(bridge)
    );
  })(),
);
check(
  "PDF 渲染是**纯 Rust**（D20：不引入 pdfium / mupdf 那类运行期原生库）",
  (() => {
    const cargo = readFileSync(join(ROOT, "crates/hp-pdf/Cargo.toml"), "utf8");
    // 反面断言先剥 `#` 注释：Cargo.toml 的模块文档**引用**了 pdfium / mupdf
    // 说明"为什么不用它们"，全文匹配会把注释当依赖（与 `stripComments` 同一条处置）。
    const deps = cargo
      .split("\n")
      .map((line) => line.replace(/#.*$/, ""))
      .join("\n");
    return (
      /hayro = \{ version = "0\.8"/.test(deps) &&
        // 关掉 simd（只是加速档，开启会拉进 fearless_simd 的平台分支）。
        /default-features = false/.test(deps) &&
        // **必须**保留 embed-fonts + embed-cmaps：关掉它们，14 个标准字体与 CJK 的
        // CMap 就没人提供，中文 PDF 会整页变成豆腐块（实测语料全是中文）。
        /"embed-fonts"/.test(deps) &&
        /"embed-cmaps"/.test(deps) &&
        // 反向：不得出现原生 PDF 库。
        !/pdfium|mupdf/.test(deps)
    );
  })(),
);
check(
  "前端：PDF 在阅读区**恒单栏**（整页位图不该被断成两栏），且逐页纵向堆叠",
  // 面板侧：`--vr-columns` 对 PDF 钉成 1。
  /isPdf \? 1 : readerColumns\(width\)/.test(viewerReaderSrc) &&
    // CSS 侧再钉一道：免得将来有人只改了一处。
    /\.vr-content\.vr-pdf\s*\{[^}]*column-count:\s*1/.test(stylesSource) &&
    // 页面图按整宽显示、**不设** `max-height`（整页就是内容本体，
    // 限制高度会让用户每页都要放大才能读——那是 `.vr-image` 给插图定的 70vh）。
    /\.vr-pdf \.vr-image\s*\{[^}]*max-height:\s*none/.test(stylesSource) &&
    /\.vr-pdf \.vr-image\s*\{[^}]*width:\s*100%/.test(stylesSource),
);
check(
  "前端：查看器按 `format === \"pdf\"` 分流，进度提示用**页**而不是**章**",
  /first\?\.format === "pdf"/.test(viewerReaderSrc) &&
    /isPdf/.test(viewerReaderSrc) &&
    // 两者共用 `section` 游标，但文案不能混（"第 3 / 54 章"对一份展板 PDF 是错的）。
    /viewer\.pageOf/.test(viewerReaderSrc) &&
    /viewer\.pageOf/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/i18n/zh-CN.ts"), "utf8"),
    ) &&
    /viewer\.pageOf/.test(readFileSync(join(ROOT, "apps/desktop/src/app_ui/i18n/en.ts"), "utf8")),
);

}
