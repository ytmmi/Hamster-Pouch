/**
 * 面板门禁分节 · 图书阅读器：排印 / 栏头 / 进度 / 章节数（原第 28–36 节）。
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
  registrySource, stylesSource,
} from "./shared.mjs";
export default async function run() {
// ============================== 图书阅读器（`panel.bookreader`，2026-10-16）==============================
//
// 面板按"单文件 ≤ 1200 行"分文件，断言读**整个家族**（与 `MEDIA_FAMILY_FILES` /
// `BOOK_FAMILY_FILES` 同口径：**新增文件必须手动登记**，否则断言形同虚设）。

const READER_FAMILY_FILES = [
  "apps/desktop/src/app_ui/panels/bookreader/BookReaderPanel.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/ReaderTocRail.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/ReaderBookHeader.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/ReaderOptionsRail.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/ReaderFooter.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/ReaderMoreMenu.tsx",
  "apps/desktop/src/app_ui/panels/bookreader/useReaderBook.ts",
  "apps/desktop/src/app_ui/panels/bookreader/useReaderBookIdentity.ts",
  "apps/desktop/src/app_ui/panels/bookreader/useReaderSettings.ts",
  "apps/desktop/src/app_ui/panels/bookreader/readerView.ts",
  // 正文块文本遍历（两个消费方共用；2026-10-18 抽出以免循环依赖）。
  "apps/desktop/src/app_ui/panels/bookreader/bookText.ts",
];
const readerFamilySrc = READER_FAMILY_FILES.map((p) => readFileSync(join(ROOT, p), "utf8")).join(
  "\n",
);
const readerViewSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/readerView.ts"),
  "utf8",
);
const readerPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/BookReaderPanel.tsx"),
  "utf8",
);
/** 阅读区本体（D228 起焦点与方向键都在这里，断言要单独读它）。 */
const readerStageSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
  "utf8",
);
const moreMenuSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderMoreMenu.tsx"),
  "utf8",
);
const bookReaderRust = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/book/toc.rs"),
  "utf8",
);

const readerView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/readerView.ts")).href
);
const readerSpec = config.panelSpec("bookreader");

check(
  "注册表：bookreader 是内置面板（media / 无类目 / control），且声明了 13 项阅读选项",
  readerSpec !== undefined &&
    readerSpec.category === "media" &&
    readerSpec.hasClass === false &&
    readerSpec.blueprintNode === "control" &&
    readerSpec.titleKey === "panel.bookreader" &&
    (readerSpec.settings ?? []).length === 13 &&
    readerSpec.defaultSize?.width === 900 &&
    readerSpec.defaultSize?.height === 700,
  `decls=${(readerSpec?.settings ?? []).map((s) => s.key).join(",") || "（无）"}`,
);

/** 声明里的 select 候选（缺项给空数组）。 */
const readerOptions = (key) =>
  (readerSpec?.settings?.find((s) => s.key === key)?.options ?? []).map((o) => o.value);

check(
  "bookreader 的 select 候选 ↔ readerView 的枚举逐项一致（翻页 / 背景 / 文字色 / 字体 / 对齐）",
  eqList(readerOptions("viewMode"), [...readerView.READER_VIEW_MODES]) &&
    eqList(readerOptions("bg"), [...readerView.READER_BG_PRESETS]) &&
    eqList(readerOptions("text"), [...readerView.READER_TEXT_PRESETS]) &&
    eqList(readerOptions("fontFamily"), [...readerView.READER_FONT_FAMILIES]) &&
    eqList(readerOptions("textAlign"), [...readerView.READER_TEXT_ALIGNS]),
  `viewMode=${readerOptions("viewMode").join(",")} bg=${readerOptions("bg").join(",")}`,
);

check(
  "bookreader 的数值项缺省 ↔ readerView 的范围常量逐项一致（且缺省落在范围内）",
  (() => {
    const pairs = [
      ["fontSize", readerView.READER_FONT_SIZE],
      ["lineHeight", readerView.READER_LINE_HEIGHT],
      ["pageMargin", readerView.READER_PAGE_MARGIN],
      ["pageWidth", readerView.READER_PAGE_WIDTH],
      ["letterSpacing", readerView.READER_LETTER_SPACING],
      ["paragraphSpacing", readerView.READER_PARAGRAPH_SPACING],
      ["brightness", readerView.READER_BRIGHTNESS],
    ];
    return pairs.every(([key, range]) => {
      const decl = readerSpec?.settings?.find((s) => s.key === key);
      return (
        decl?.default === range.default &&
        range.min <= range.default &&
        range.default <= range.max
      );
    });
  })(),
  `defaults=${(readerSpec?.settings ?? [])
    .filter((s) => typeof s.default === "number")
    .map((s) => `${s.key}:${s.default}`)
    .join(" ")}`,
);

check(
  "readerView 是**零依赖纯逻辑**（无 React / Tauri / 任何 import）——门禁才能直接 import 驱动它",
  !/from\s+"react"/.test(readerViewSrc) &&
    !/@tauri-apps/.test(readerViewSrc) &&
    !/^\s*import\s/m.test(readerViewSrc),
);

// ==================== 用户实测反馈的四项修复（2026-10-16）====================
//
// 这四条都是"代码看起来对、真机上就是不对"的缺陷，因此断言必须钉住
// **行为与机制**，不能只钉"某个符号出现过"（那条教训在批注校验上已经吃过一次）。

// 复用文件开头已读入的 `stylesSource`（第 88 行），不重复读同一份文件。

check(
  "① 左右两栏**浮在正文之上**（绝对定位），不是并排挤压正文",
  (() => {
    // 并排三栏会改变正文宽度 ⇒ 分栏重算、当前页漂移；用户只开个目录看一眼，
    // 正文却跟着跳。因此两栏必须是定位容器里的绝对定位浮层。
    const body = stylesSource.match(/\.br-body\s*\{[^}]*\}/)?.[0] ?? "";
    const rail = stylesSource.match(/\.br-rail\s*\{[^}]*\}/)?.[0] ?? "";
    const left = stylesSource.match(/\.br-rail-left\s*\{[^}]*\}/)?.[0] ?? "";
    const right = stylesSource.match(/\.br-rail-right\s*\{[^}]*\}/)?.[0] ?? "";
    return (
      /position:\s*relative/.test(body) &&
      /position:\s*absolute/.test(rail) &&
      /z-index:\s*\d+/.test(rail) &&
      /left:\s*0/.test(left) &&
      /right:\s*0/.test(right) &&
      // 反向：不得再有"占布局宽度"的写法（flex-shrink: 0 + 固定 width 就是并排）。
      !/flex-shrink:\s*0/.test(rail)
    );
  })(),
);
check(
  "①b 窄面板下两栏**不互相覆盖**：宽度按面板比例分配，且窄到并排放不下时改成上下分栏",
  (() => {
    // 真机实测（D224）：面板拖到 205px 宽时，左栏 `min(260px, 70%)` 占 132px、右栏固定
    // 240px 贴右，两栏重叠 183px，四个标签页被压成 27px 且点击落到右栏标题上——目录
    // 直接不可用。判据分两层：① 两栏百分比之和 ≤ 100（永远不会横向交叠）；
    // ② 窄到每栏只剩百来像素时上下分栏（`@container` 块里两条都改 width: 100%）。
    const body = stylesSource.match(/\.br-body\s*\{[^}]*\}/)?.[0] ?? "";
    const left = stylesSource.match(/\.br-rail-left\s*\{[^}]*\}/)?.[0] ?? "";
    const right = stylesSource.match(/\.br-rail-right\s*\{[^}]*\}/)?.[0] ?? "";
    const pct = (rule) => {
      const m = rule.match(/width:\s*min\(\s*\d+px\s*,\s*(\d+)%\s*\)/);
      return m ? Number(m[1]) : null;
    };
    const leftPct = pct(left);
    const rightPct = pct(right);
    // 窄面板那一段必须是容器查询（拿 `.br-body` 的宽度量），且两栏都占满整宽、纵向分层。
    const narrow = stylesSource.match(/@container\s*\(max-width:\s*300px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    return (
      /container-type:\s*inline-size/.test(body) &&
      leftPct !== null &&
      rightPct !== null &&
      leftPct + rightPct <= 100 &&
      /width:\s*100%/.test(narrow) &&
      // 上下分栏的判据：一侧贴底、一侧贴顶（不再靠 left/right 并排）。
      /bottom:\s*\d+%/.test(narrow) &&
      /top:\s*\d+%/.test(narrow)
    );
  })(),
);

check(
  "② 目录当前章 / ⑤ 选中档位**不得**用 `color: var(--accent)`（浅色主题下是白色 → 白字白底）",
  (() => {
    // 这是"看得见"的问题：浅色主题 `--accent: #ffffff`，与深色文字互换后选中项直接消失
    // （用户实测："选择某章节后文字变白/消失"、"被选择的按钮文字是白色，看不清"）。
    // 正确做法是项目既有的"选中"约定：`--active-bg` 实心底 + `--active-fg` 反色前景。
    const tocActive = stylesSource.match(/\.br-toc-item-active\s*\{[^}]*\}/)?.[0] ?? "";
    const choiceActive = stylesSource.match(/\.br-choice-item-active\s*\{[^}]*\}/)?.[0] ?? "";
    return (
      /background:\s*var\(--active-bg\)/.test(tocActive) &&
      /color:\s*var\(--active-fg\)/.test(tocActive) &&
      /background:\s*var\(--active-bg\)/.test(choiceActive) &&
      /color:\s*var\(--active-fg\)/.test(choiceActive) &&
      // 反向：这两处不得出现 `color: var(--accent)`（注释里提到它不算——先剥注释）。
      !/color:\s*var\(--accent\)/.test(stripComments(tocActive)) &&
      !/color:\s*var\(--accent\)/.test(stripComments(choiceActive))
    );
  })(),
);

check(
  "③ 分页滚轮翻页用**原生监听器 + passive:false**（React onWheel 是 passive，preventDefault 无效）",
  (() => {
    // 项目已在 `bookpreview/BookCard.tsx` 记录过这个坑：React 在根节点把 wheel
    // 注册成 passive，`preventDefault()` 被忽略 ⇒ 原生滚动照常发生，
    // "分页"退化成"普通滚动"（用户实测："现在的方式和普通滚动无区别"）。
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    return (
      /addEventListener\("wheel",\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/.test(stage) &&
      /removeEventListener\("wheel",\s*onWheel\)/.test(stage) &&
      /event\.preventDefault\(\)/.test(stage) &&
      // 反向：不得再用 React 的 `onWheel=`（那正是失效的写法）。
      !/onWheel=\{/.test(stage)
    );
  })(),
);

check(
  "③ 滚轮按**增量累积**折算「一次滚动 = 一页」（一次物理滚动 ≠ 一个 wheel 事件）",
  (() => {
    // 触控板会把一次滑动拆成几十个小事件；按"事件数"翻页会一滑翻十几页。
    // 而按"除以阈值取整"又会让一格 300 的鼠标一次翻 5 页。
    // 正确口径：累积到阈值即翻**一页**并清零（超出的部分丢掉）。
    const step = readerView.accumulateWheelStep(0, 10, 60);
    const one = readerView.accumulateWheelStep(50, 20, 60);
    const big = readerView.accumulateWheelStep(0, 300, 60);
    const back = readerView.accumulateWheelStep(0, -60, 60);
    const hold = readerView.accumulateWheelStep(0, 30, 60);
    return (
      step.step === 0 &&
      step.accumulated === 10 &&
      one.step === 1 &&
      one.accumulated === 0 &&
      // 一次大增量**只翻一页**（不是 5 页），且累积清零。
      big.step === 1 &&
      big.accumulated === 0 &&
      back.step === -1 &&
      hold.step === 0 &&
      hold.accumulated === 30 &&
      // `deltaMode` 归一化：按行的 3 必须折算成 48（否则永远攒不到阈值 = 滚轮失灵）。
      readerView.normalizeWheelDelta(3, 1) === 48 &&
      readerView.normalizeWheelDelta(1, 2) === 400 &&
      readerView.normalizeWheelDelta(120, 0) === 120
    );
  })(),
  `big=${JSON.stringify(readerView.accumulateWheelStep(0, 300, 60))} line3=${readerView.normalizeWheelDelta(3, 1)}`,
);

check(
  "③ 分页几何**一处算术**：页数与步进都按「一张纸」算（双页不得按单栏翻）",
  (() => {
    // 旧实现把 `pitch` 定义成**一栏**的列距（`columnWidth + gap`），而 JSX 又拿它当
    // **一屏 / 一张纸**用（`translateX(-page · pitch)`）。单页模式两者恰好相等（N=1）
    // **掩盖了它**；双页模式下页面只推进半屏，正文在两屏之间**重叠一栏**。
    // 现在口径是 `screenPitch = 纸内正文宽 + 栏间距`（恒等于 `paperWidth`）。
    // 参数：纸内正文宽 600、栏间距 32（= 2×页边距 16）。
    const single = readerView.readerPagination(3000, 600, 1, 32);
    const spread = readerView.readerPagination(3000, 600, 2, 32);
    return (
      // 单栏：栏宽 600、步进 600+32=632。
      single.columnWidth === 600 &&
      single.screenPitch === 632 &&
      single.pageCount === Math.ceil(single.columnCount / 1) &&
      // 双页：栏宽 (600-32)/2 = 284、步进仍是 600+32 = 632（**不是** 316）。
      spread.columnWidth === 284 &&
      spread.screenPitch === 632 &&
      spread.pageCount === Math.ceil(spread.columnCount / 2) &&
      // 关键：双页的页数**约为**单栏的一半（一张纸两栏），不是与单栏相等。
      spread.pageCount <= single.pageCount &&
      // 反向：步进**不得**退回"一栏"（= 一张纸只挪半张、两屏重叠一栏）。
      spread.screenPitch !== spread.columnWidth + 32 &&
      readerView.readerScreenPitch(600, 32) === 632
    );
  })(),
  `single=${JSON.stringify(readerView.readerPagination(3000, 600, 1, 32))} spread=${JSON.stringify(readerView.readerPagination(3000, 600, 2, 32))}`,
);

check(
  "③ 阅读位置按**几何**判定（视口左缘落在哪一项的并集盒里），不再单点取点",
  (() => {
    // 2026-11-15 真机实测的缺陷：页脚恒为「当前进度 0.00% 本章进度 0.0% 章节数 1 / 13」
    // （翻页也不动）。根因是 reportPosition 用 `elementFromPoint` 单点取页——
    // 第一版把探测点挪进纸张内容盒（`paper.top + margin + 4`）后仍然失败：
    // 真机上同一个点一次命中 `.br-flow`、一次命中 `.br-paper`，因为正文栏顶部
    // 常有 30–40px 首行留白（标题上边距、图片块留白），点一进空白就 `closest` 到 null。
    //
    // 现在的口径是**问几何**：视口内容左缘（`paper.left + margin`）落在哪一项的
    // 并集盒里，那一项就是"正在读的项"。这里钉三件事：纯函数的算术、组件的接线、
    // 以及"分页分支不得再取点"。
    const box = (index, left, right, top, bottom) => ({ index, left, right, top, bottom });
    // 真机页 8 的实测值：跨栏项的并集盒横跨 265 → 29162（右缘远在视口之外）。
    const spanning = readerView.readerVisiblePageIndex({
      vpLeft: 265,
      vpTop: 95,
      vpBottom: 739,
      pages: [box(12, 265, 29162, 127, 707)],
    });
    // 视口在第 2 栏时，只占第 1 栏的项（右缘 650 < 1180）必须被跳过、选中第 2 栏的项。
    const secondColumn = readerView.readerVisiblePageIndex({
      vpLeft: 1180,
      vpTop: 95,
      vpBottom: 739,
      pages: [box(3, 265, 650, 127, 707), box(4, 1180, 1560, 127, 707)],
    });
    // 整项都被推到视口左边（都读完了）——这一屏没有"正在读"的项。
    const allBehind = readerView.readerVisiblePageIndex({
      vpLeft: 1180,
      vpTop: 95,
      vpBottom: 739,
      pages: [box(1, 265, 600, 127, 707), box(2, 620, 1000, 127, 707)],
    });
    // 纵向不相交（该项在另一屏）：横向再合适也不能算。
    const offScreenVertically = readerView.readerVisiblePageIndex({
      vpLeft: 265,
      vpTop: 95,
      vpBottom: 739,
      pages: [box(9, 265, 29162, 800, 1200)],
    });
    // 平局（同一左缘）取序号较小者：先读到的是前者。
    const tieBreak = readerView.readerVisiblePageIndex({
      vpLeft: 265,
      vpTop: 95,
      vpBottom: 739,
      pages: [box(6, 265, 29162, 127, 707), box(5, 265, 29162, 127, 707)],
    });
    // 滚动模式同样问几何（D227）：视口上缘落在哪一项的纵向区间里，那一项就是正在读的。
    // 真机页脚恒 0.00% 的直接原因就是取点被左栏盖住，所以这里连"取点"本身都钉死。
    const scrollStraddle = readerView.readerScrollVisiblePageIndex({
      vpTop: 300,
      pages: [box(0, 0, 800, 100, 250), box(1, 0, 800, 300, 600), box(2, 0, 800, 700, 900)],
    });
    // 视口顶线在正文之上（顶部留白）→ 取最靠上的那一项。
    const scrollAboveAll = readerView.readerScrollVisiblePageIndex({
      vpTop: 60,
      pages: [box(4, 0, 800, 300, 600), box(0, 0, 800, 100, 250)],
    });
    // 同一上缘平局 → 序号较小者；纵向区间之间的空隙不返回 -1（跨过顶线的那项仍在读）。
    const scrollTie = readerView.readerScrollVisiblePageIndex({
      vpTop: 400,
      pages: [box(7, 0, 800, 300, 350), box(3, 0, 800, 300, 350)],
    });
    const scrollEmpty = readerView.readerScrollVisiblePageIndex({ vpTop: 400, pages: [] });
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    const stageCode = stripComments(stage);
    return (
      spanning === 12 &&
      secondColumn === 4 &&
      allBehind === -1 &&
      offScreenVertically === -1 &&
      tieBreak === 5 &&
      scrollStraddle === 1 &&
      scrollAboveAll === 0 &&
      scrollTie === 3 &&
      scrollEmpty === -1 &&
      // 接线：两个分支都必须调纯函数、且喂的是每项的矩形（不是取点）。
      /readerVisiblePageIndex\(\{/.test(stageCode) &&
      /readerScrollVisiblePageIndex\(\{ vpTop: hostRect\.top, pages \}\)/.test(stageCode) &&
      /querySelectorAll<HTMLElement>\("\[data-page-index\]"\)/.test(stageCode) &&
      // 反向：两种模式都不得再取点——`elementFromPoint` 在阅读器里已无调用方。
      !/paged: true,/.test(stageCode) &&
      !/basis\.top \+ 2/.test(stageCode) &&
      !/document\.elementFromPoint\(/.test(stageCode) &&
      !/readerProbePoint\(/.test(stageCode)
    );
  })(),
  `span=${readerView.readerVisiblePageIndex({ vpLeft: 265, vpTop: 95, vpBottom: 739, pages: [{ index: 12, left: 265, right: 29162, top: 127, bottom: 707 }] })}`,
);

// ============ 分页纸张几何 + 仿真背景 + 2026-10-18 五项修订 ============
//
// 用户口径（2026-10-17）："单页应为一个居中容器，双页应为一对居中的容器，
// 并且都是跟随自适应大小的。" + 仿真背景（图书阴影）与开关。
// 用户口径（2026-10-18）：① 书页大一点、桌面露出少一点；② 正文外边距大一点；
// ③ 单/双页默认**刷新切换**而不是滑动；⑤ 全屏时纸张铺满上下（裁决 B）。
//
// 这一组的断言钉四件事：
// ① **纸张等分**——双页是"一对**相贴**的纸页"（`N` 张按 `paperWidth / N` 逐像素铺满）；
// ② **书脊缝 = 2×页边距**——每栏因此**恰好居中**在它自己的纸上（几何精确解）；
// ③ **桌面留白与「页边距」互不联动**（两个独立的数，2026-10-18 ①② 同时成立的前提）；
// ④ **纸张宽高跟随可用空间**（"跟随自适应大小"），且纸宽不得超出可用宽。

check(
  "分页纸张：`N` 张纸按 `paperWidth / N` **等分铺满**；且 `纸宽 = 栏宽 + 2×页边距`（恒等式）",
  (() => {
    // 2026-10-18 修订：纸页不再"各外扩半个栏间距"凑相贴，而是**切分**纸张——
    // `faceWidth = paperWidth / N`，两张相加恰好等于纸宽（逐像素无缝）。
    //
    // 代入 `gap = 2·margin` 后可证明一个**更强的恒等式**：
    //   columnWidth = faceWidth - 2·margin  ⇒  faceWidth = columnWidth + 2·margin
    // 它把"一张纸"讲清楚了：**纸 = 栏 + 两侧页边距**。旧版把 paperWidth 与栏宽
    // 用 `inset` 间接联系，改一个常数就会破坏这条关系（所以旧版要额外钉等式）；
    // 新版它是**算出来的**，天然成立。
    const spread = readerView.readerPagedLayout({
      availableWidth: 900,
      availableHeight: 600,
      pageWidthPercent: 100,
      pageMargin: 24,
      columns: 2,
    });
    const single = readerView.readerPagedLayout({
      availableWidth: 900,
      availableHeight: 600,
      pageWidthPercent: 100,
      pageMargin: 24,
      columns: 1,
    });
    return (
      Math.abs(spread.faceWidth * 2 - spread.paperWidth) < 0.01 &&
      Math.abs(single.faceWidth - single.paperWidth) < 0.01 &&
      // 恒等式：纸宽 = 栏宽 + 2×页边距（**精确**，不是近似）。
      Math.abs(spread.faceWidth - (spread.columnWidth + 2 * spread.margin)) < 0.01 &&
      Math.abs(single.faceWidth - (single.columnWidth + 2 * single.margin)) < 0.01
    );
  })(),
  `face=${readerView.readerPagedLayout({ availableWidth: 900, availableHeight: 600, pageWidthPercent: 100, pageMargin: 24, columns: 2 }).faceWidth}`,
);

check(
  "分页书脊缝 = **2×页边距** ⇒ 每栏**恰好居中**在它自己的纸上（几何精确解）",
  (() => {
    // 推导见 `readerPagedLayout` 文件头：第 i 栏中心与第 i 张纸中心相等 ⇔ g = 2·margin。
    const l = readerView.readerPagedLayout({
      availableWidth: 900,
      availableHeight: 600,
      pageWidthPercent: 100,
      pageMargin: 24,
      columns: 2,
    });
    const faceCenters = [0, 1].map((i) => (i + 0.5) * l.faceWidth);
    const colCenters = [0, 1].map(
      (i) => l.margin + i * (l.columnWidth + l.gap) + l.columnWidth / 2,
    );
    return (
      l.gap === l.margin * 2 &&
      faceCenters.every((c, i) => Math.abs(c - colCenters[i]) <= 0.01) &&
      // 反向：书脊缝**不得**等于其它量（那些都会让栏与纸错位）。
      l.gap !== l.margin &&
      l.gap !== l.columnWidth
    );
  })(),
  (() => {
    const l = readerView.readerPagedLayout({
      availableWidth: 900,
      availableHeight: 600,
      pageWidthPercent: 100,
      pageMargin: 24,
      columns: 2,
    });
    return `gap=${l.gap} margin=${l.margin} colW=${l.columnWidth.toFixed(1)} faceW=${l.faceWidth}`;
  })(),
);

check(
  "分页纸张：**桌面留白与「页边距」互不联动**（改页边距不动纸张宽，只改正文离纸边）",
  (() => {
    // 【I1】"书页大一点、桌面露出少一点"【I2】"正文外边距大一点"能**同时**成立的前提：
    // 桌面留白（CSS 的 `--br-desk-*`）与「页边距」（纸张 `padding`）是两个独立的数。
    // 旧实现两者共用一个 `--br-page-margin`，于是"把正文推离纸边"必然"把纸缩小一圈"。
    const thin = readerView.readerPagedLayout({
      availableWidth: 900,
      availableHeight: 600,
      pageWidthPercent: 100,
      pageMargin: 8,
      columns: 2,
    });
    const wide = readerView.readerPagedLayout({
      availableWidth: 900,
      availableHeight: 600,
      pageWidthPercent: 100,
      pageMargin: 60,
      columns: 2,
    });
    return (
      // 纸张宽**完全不变**（页边距不再缩小纸张）。
      Math.abs(thin.paperWidth - wide.paperWidth) < 0.01 &&
      // 但栏宽**变了**（页边距把正文推离纸边）。
      wide.columnWidth < thin.columnWidth &&
      wide.margin > thin.margin
    );
  })(),
  `paper 8→${readerView.readerPagedLayout({ availableWidth: 900, availableHeight: 600, pageWidthPercent: 100, pageMargin: 8, columns: 2 }).paperWidth} / 60→${readerView.readerPagedLayout({ availableWidth: 900, availableHeight: 600, pageWidthPercent: 100, pageMargin: 60, columns: 2 }).paperWidth}`,
);

check(
  "分页纸张：书脊缝**跟随** 2×页边距（拖「页边距」时栏与纸始终居中，不出现错位）",
  (() => {
    // "每栏在自己纸上居中"的**稳定性**：页边距一变，书脊缝必须同步变。
    // 旧实现的 `inset` 与栏间距是两个独立常数，正是"改了页边距就错位"的隐患。
    return [0, 8, 24, 40, 60, 80].every((m) => {
      const l = readerView.readerPagedLayout({
        availableWidth: 900,
        availableHeight: 600,
        pageWidthPercent: 100,
        pageMargin: m,
        columns: 2,
      });
      const faceCenters = [0, 1].map((i) => (i + 0.5) * l.faceWidth);
      const colCenters = [0, 1].map(
        (i) => l.margin + i * (l.columnWidth + l.gap) + l.columnWidth / 2,
      );
      return (
        l.gap === l.margin * 2 && faceCenters.every((c, i) => Math.abs(c - colCenters[i]) <= 0.01)
      );
    });
  })(),
  `测试页边距 ${[0, 8, 24, 40, 60, 80].join("/")} 全部居中`,
);

check(
  "【I2】页边距**按可读性夹紧**：窄面板 + 大页边距也不得把栏宽挤到 <48px",
  (() => {
    // 「页边距」上限 80px，而窄面板（如 320px 宽双页）下 80×2 已吃掉半张纸。
    // 夹紧保证每栏至少 `READER_MIN_COLUMN_WIDTH`，否则正文会变成一行一个字。
    //
    // 上限是 `(faceWidth - MIN)/2`：由恒等式 `columnWidth = faceWidth - 2·margin`
    // 解出（**不是** `(paperWidth - N·MIN)/2`——那样会放大 N 倍、夹得太松）。
    const tiny = readerView.readerPagedLayout({
      availableWidth: 320,
      availableHeight: 240,
      pageWidthPercent: 100,
      pageMargin: 80,
      columns: 2,
    });
    return (
      tiny.margin < 80 &&
      tiny.margin >= 0 &&
      tiny.columnWidth >= readerView.READER_MIN_COLUMN_WIDTH - 0.01 &&
      tiny.paperWidth > 0
    );
  })(),
  (() => {
    const t = readerView.readerPagedLayout({
      availableWidth: 320,
      availableHeight: 240,
      pageWidthPercent: 100,
      pageMargin: 80,
      columns: 2,
    });
    return `320px 双页 / 页边距 80 → 夹紧为 margin=${t.margin} colW=${t.columnWidth.toFixed(1)}`;
  })(),
);

// ============ EPUB 正文排印（2026-10-18，参考 Readium CSS / foliate-js）============
//
// 用户口径："**解析 epub 排版要正确，去参考开源的 epub 的解析器和阅读器的实现**"。
//
// 判据来自 **Readium CSS**（<https://github.com/readium/css>）的
// `ReadiumCSS-default-cjk-horizontal.css` / `-default.css`（第三方样式表，不随仓库
// 携带副本；用到的原值直接写在下面，出处给上游地址可查）：
//   --RS__paraIndent: 1em;  :root:lang(zh) { --RS__paraIndent: 2em; }
//   --RS__paraSpacing: 0;   p { margin: 0; text-indent: var(--RS__paraIndent) }
//   body { text-align: justify; text-justify: inter-character }
//   h1 + p, ... { text-indent: 0 }
// 与 **foliate-js**（<https://github.com/johnfactotum/foliate-js>）的 `fb2.js`：
//   `:not(p) + p, p:first-child { text-indent: 0 }`

check(
  "EPUB 排印：**段落间距缺省 0**（中英文书刊都用首行缩进分段，不叠一段间距）",
  (() => {
    const decl = readerSpec?.settings?.find((s) => s.key === "paragraphSpacing");
    const constRange = readerView.READER_PARAGRAPH_SPACING;
    // 声明缺省与取值域同源（`check:panels` 的另一条已逐项比对，这里单独钉"是 0"）。
    return decl?.default === 0 && constRange.default === 0 && constRange.min === 0;
  })(),
  `decl=${readerSpec?.settings?.find((s) => s.key === "paragraphSpacing")?.default} range=${JSON.stringify(readerView.READER_PARAGRAPH_SPACING)}`,
);

check(
  "EPUB 排印：首行缩进**按语言分档**（中文 2em / 拉丁 1em，Readium CSS 口径）",
  (() => {
    const em = readerView.READER_PARA_INDENT_EM;
    const css = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8");
    return (
      em.cjk === 2 &&
      em.latin === 1 &&
      // CSS 真的消费了面板下发的变量。
      /text-indent:\s*var\(--br-para-indent/.test(css) &&
      // 紧跟标题 / 分隔线的第一段不缩进（Readium 与 foliate 同款）。
      /\.vr-heading\s*\+\s*\.vr-paragraph/.test(css) &&
      // 段落内的行内元素不继承缩进（Readium：`p * { text-indent: 0 }`）。
      /\.vr-paragraph \*\s*\{[^}]*text-indent:\s*0/.test(css)
    );
  })(),
  `cjk=${readerView.READER_PARA_INDENT_EM.cjk}em latin=${readerView.READER_PARA_INDENT_EM.latin}em`,
);

check(
  "EPUB 排印：正文语言档按**字符构成**判定（纯函数，门禁直接驱动）",
  (() => {
    const probe = readerView.readerBodyProfile;
    if (typeof probe !== "function") return false;
    const zh = "这是一段中文正文，用来判断语言档。".repeat(3);
    const en = "This is an English paragraph used to detect the profile. ".repeat(3);
    return (
      probe(zh) === "cjk" &&
      probe(en) === "latin" &&
      // 样本不足（章节开头一行短标题）时**沿用**上一档——否则同一本书会章章跳变。
      probe("序章", "cjk") === "cjk" &&
      probe("Prologue", "latin") === "latin" &&
      // 空串沿用上一档（不抛错）。
      probe("", "cjk") === "cjk" &&
      // 中英混排以方块字占比为准（≥30% 判 cjk）。
      probe("这是一本 English book 混排。".repeat(3)) === "cjk"
    );
  })(),
  `zh=${readerView.readerBodyProfile("这是一段中文正文，用来判断语言档。".repeat(3))} en=${readerView.readerBodyProfile("This is an English paragraph used to detect the profile. ".repeat(3))}`,
);

check(
  "EPUB 排印：语言档判定**必须把块渲染的正文算进来**（否则中文 EPUB 永远判成 latin）",
  (() => {
    // 实测发现的一处疏漏：`txt` 的内容在 `item.text`，而 `epub` / `md` 的内容在
    // `item.blocks`（`text` 恒为 null）。只收集 `text` 时，一本中文 EPUB 的
    // 首行缩进会永远停在 1em（拉丁档），而中文书刊的口径是 2em。
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    const code = stripComments(stage);
    const helper = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/bookText.ts"),
      "utf8",
    );
    return (
      /item\.blocks\) sample \+= collectBlockText\(item\.blocks\)/.test(code) &&
      // 遍历必须递归（列表 / 引用 / 脚注里的正文也算）。
      /if \(block\.list_items\) for \(const item of block\.list_items\) walk\(item\.blocks\)/.test(
        helper,
      ) &&
      // 反向：不得只收集 `text`（那正是这条断言要防的写法）。
      !/bodyProfile[\s\S]{0,400}?\bonlyText\b/.test(code)
    );
  })(),
);

check(
  "EPUB 排印：块文本遍历**单一实现**（两个消费方共用，不复制第二份）",
  (() => {
    // 抽成 `bookText.ts` 的理由：`BookReaderPanel` 已 import `ReaderStage`，
    // 若把遍历留在任一个组件里，另一个 import 它就成**循环依赖**；复制一份又漂移。
    const text = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/bookText.ts"),
      "utf8",
    );
    const panel = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/BookReaderPanel.tsx"),
      "utf8",
    );
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    return (
      /export function collectBlockText/.test(text) &&
      // 两个消费方都从 `bookText` 取（不是各自实现）。
      /import \{ collectBlockText \} from "\.\/bookText"/.test(panel) &&
      /import \{ collectBlockText \} from "\.\/bookText"/.test(stage) &&
      // 反向：两处都不得再有第二份实现（函数名重复定义）。
      (panel.match(/function collectBlockText/g) ?? []).length === 0 &&
      (stage.match(/function collectBlockText/g) ?? []).length === 0 &&
      // 反向：`ReaderStage` 不得 import `BookReaderPanel`（那会成环）。
      !/from "\.\/BookReaderPanel"/.test(stage)
    );
  })(),
);

check(
  "「更多」图标是**矢量**：`<svg>` + 四个 `<rect>`（不得用文字 / 图片 / 字体图标代替）",
  /export function MoreGridIcon/.test(moreMenuSrc) &&
    /<svg/.test(moreMenuSrc) &&
    ([...moreMenuSrc.matchAll(/<rect\b/g)].length === 4) &&
    // 颜色必须跟随主题（`currentColor`），否则深色主题下图标会消失。
    /currentColor/.test(readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8")),
  `rect=${[...moreMenuSrc.matchAll(/<rect\b/g)].length}`,
);

check(
  "「更多」按钮直接同时开合左右两栏，不弹出目录 / 书签 / 笔记 / 高亮 / 阅读选项菜单",
  /const \[leftTab, setLeftTab\] = useState<ReaderTab>\("toc"\)/.test(readerPanelSrc) &&
    /const \[railsOpen, setRailsOpen\] = useState\(false\)/.test(readerPanelSrc) &&
    /const toggleRails = useCallback\(\(\) => \{\s*setRailsOpen\(\(open\) => !open\)/.test(readerPanelSrc) &&
    /expanded=\{railsOpen\}/.test(readerPanelSrc) &&
    // 同一个 railsOpen 条件挂载左右栏；左栏默认目录，右栏阅读选项。
    /\{railsOpen && \(\s*<ReaderTocRail/.test(readerPanelSrc) &&
    /\{railsOpen && \(\s*<ReaderOptionsRail/.test(readerPanelSrc) &&
    /tab=\{leftTab\}/.test(readerPanelSrc) &&
    /aria-expanded=\{expanded\}/.test(moreMenuSrc) &&
    // 不应再有弹出菜单、菜单项或第二层开合状态。
    !/role="menu"|role="menuitemcheckbox"|br-more-menu|ReaderMenuEntry/.test(moreMenuSrc) &&
    !/menuOpen|menuEntries|rightOpen/.test(readerPanelSrc),
);

check(
  "目录跳转**直接用 `book.toc` 给的游标**（前端不换算——两套坐标漂移会让「点第三章跳到第五章」）",
  /onJump=\{book\.jumpTo\}/.test(readerPanelSrc) &&
    /onJump\(entry\.cursor\)/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderTocRail.tsx"), "utf8"),
    ) &&
    /api\.bookToc\(\{ repoId, fileId \}\)/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/useReaderBook.ts"), "utf8"),
    ) &&
    // 反向：目录项游标不得被前端"再加工"（`Number(...)` 只允许出现在**比较**用途）。
    !/cursor:\s*String\(/.test(readerFamilySrc),
);

check(
  "面板接线：走 useReaderSettings / useReaderBook，并把 dockview API 传下去（设置热加载）",
  /useReaderSettings\(panelApi\)/.test(readerPanelSrc) &&
    /useReaderBook\(\)/.test(readerPanelSrc) &&
    /^ {2}bookreader: \(ctx\) => <BookReaderPanel api=\{ctx\.api\} \/>,$/m.test(
      registrySource,
    ) &&
    // 反向：用户 2026-10-18 口径"**删除退出阅读按钮**"——面板里不再有那条关闭逻辑。
    !/exitReading/.test(readerPanelSrc) &&
    !/panelApi\?\.close\(\)/.test(readerPanelSrc),
);

check(
  "跳章用 `key={游标}` 重新挂载阅读区（滚动位置与当前页一起回到开头，不与渲染竞态）",
  /key=\{`\$\{fileId \?\? "-"\}:\$\{book\.cursor \?\? "start"\}`\}/.test(readerPanelSrc),
);

check(
  "阅读选项是**面板设置**（不新增库表）：12 项都经 setting.set 落 `panel.bookreader.*` 并本地广播",
  /panelSettingStorageKey\(READER_PANEL_ID, key\)/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/useReaderSettings.ts"),
      "utf8",
    ),
  ) &&
    /api\s*\.settingSet\(/.test(
      readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/useReaderSettings.ts"),
        "utf8",
      ),
    ) &&
    /publishSettingChanged\(storageKey\)/.test(
      readFileSync(
        join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/useReaderSettings.ts"),
        "utf8",
      ),
    ) &&
    // Rust 侧设置镜像必须同步（否则 `setting.set` 直接拒写，面板上"改了没反应"）。
    /id: "viewMode"/.test(
      readFileSync(join(ROOT, "crates/hp-core/src/panel_settings_generated.rs"), "utf8"),
    ) &&
    /owner_id: Some\("bookreader"\)/.test(
      readFileSync(join(ROOT, "crates/hp-core/src/panel_settings_generated.rs"), "utf8"),
    ),
);

check(
  "Rust：`book.toc` 按**媒体类型**分流、返回 `ApiAsync`，纯文本走**流式**扫描（覆盖全书且不整本进内存）",
  (() => {
    /*
     * **反面断言要看代码，不看注释**：这两个文件的注释**必须**解释"旧机制为什么被删"
     * （旧 `READER_MAX_BYTES` / `with_reader_text` / `ReaderTextCache`）——注释里提到它们
     * 是正当的，甚至是被要求的（本项目"注释即文档"）。因此先把注释剥掉，再断言
     * "代码里没有把它们写回来"。
     */
    const code = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
    const readerCode = code(bookReaderRust);
    return (
      /pub\(crate\) async fn book_toc\(/.test(readerCode) &&
      /-> ApiAsync<BookTocResult>/.test(readerCode) &&
      // PDF 与 epub / md 一样按媒体类型先判，不按扩展名猜。
      /if media_type == MediaType::Pdf/.test(readerCode) &&
      /hp_book::read_epub_toc\(/.test(readerCode) &&
      /hp_book::text_toc_stream\(/.test(readerCode) &&
      /hp_book::markdown_toc\(/.test(readerCode) &&
      /*
       * 纯文本目录必须**覆盖全书**（否则第 800 章不在目录里），但**不得**把整本读进
       * 内存——2026-10-18 用户实测"打开一本 txt 内存涨到 5 GB 以上并卡死"（需求 2）。
       * 因此判据是"流式扫描"而不是"整本解码 + 单本缓存"：下面把旧机制的**代码**
       * 明确排除掉（它不是"忘了写"，而是**不允许**写回来）。
       */
      !/with_reader_text\(/.test(readerCode) &&
      !/ReaderTextCache/.test(readerCode) &&
      !/READER_MAX_BYTES/.test(readerCode) &&
      // 旧缓存字段也不得复活（`AppState` 上已无 `book_text`）。
      !/book_text/.test(readerCode)
    );
  })(),
);

check(
  "Rust：纯文本**渐进读取**（需求 2）——按窗口取页 + 有界锚点表，且不含「整本解码」路径",
  (() => {
    const stream = readFileSync(join(ROOT, "crates/hp-book/src/text_stream.rs"), "utf8");
    const bookSrc = BOOK_BRIDGE_SRC;
    // 反面断言只看**代码**（注释里解释旧机制是正当的，见上一条的说明）。
    const code = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
    const bookCode = code(bookSrc);
    return (
      // 三个入口都在（统计 / 取页 / 流式目录），且都由 `lib.rs` 导出。
      /pub fn scan_text\(/.test(stream) &&
      /pub fn read_text_page_window\(/.test(stream) &&
      /pub fn text_toc_stream\(/.test(stream) &&
      /pub use text_stream::/.test(
        readFileSync(join(ROOT, "crates/hp-book/src/lib.rs"), "utf8"),
      ) &&
      // 有界闸门与锚点步长都是**常量**（可审计的算术，不是散落的魔法数）。
      /pub const TEXT_SCAN_MAX_BYTES: u64 = 512 \* 1024 \* 1024;/.test(stream) &&
      /pub const ANCHOR_STRIDE_BYTES: u64 = 64 \* 1024;/.test(stream) &&
      /pub const ANCHOR_TABLES_MAX: usize = 4;/.test(stream) &&
      // 锚点表按**内容身份**键控（`files.content_hash`），换内容必然换表。
      /content_key: Option<String>/.test(stream) &&
      // 锚点必须落在字符边界上（否则会多算一个字符、游标整体偏移）。
      // 断言读**实现 + 测试**两处：那条不变量由 `text_stream_tests.rs` 里的用例按
      // 行为钉住（2026-10-18 拆分后测试不再与实现同文件）。
      /fn count_chunk\(/.test(stream) &&
      /fn anchors_land_on_character_boundaries/.test(
        readFileSync(join(ROOT, "crates/hp-book/src/text_stream_tests.rs"), "utf8"),
      ) &&
      // 正文取页走窗口函数，且把内容哈希作为内容身份传进去。
      /hp_book::read_text_page_window\(/.test(bookCode) &&
      /Some\(content_key\)/.test(bookCode) &&
      // **反面**：桥接层不得再出现"整本解码"的调用（`decode_file_limited` 是那条路径）。
      !/decode_file_limited/.test(bookCode)
    );
  })(),
);

check(
  "CSS：需求 3/4 的换页与图片封顶（真机探针量出的两处洞已堵）",
  (() => {
    const cssRaw = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8");
    /*
     * **反面断言只看代码、不看注释**：这条规则替换掉的旧写法（
     * `[style*="--vr-columns: 1"]`）必须在注释里被**说明**（"注释即文档"是本项目
     * 的要求），因此先把 CSS 注释剥掉再断言"代码里没有把它写回来"。
     */
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
    return (
      // 需求 4 的主判据：页容器上的**属性**（不是"往流里塞空块"）。
      /\.br-stage-paged\s+\.br-page\[data-page-break-before\]/.test(css) &&
      // 多栏里断的是**栏**，不是打印页（`page` 在屏幕上没有效果）。
      /break-before:\s*column/.test(css) &&
      /*
       * 查看器一侧必须用**结构类名**，**不得**字符串匹配内联样式：
       * 2026-10-18 真机探针量出 `[style*="--vr-columns: 1"]`（带空格）永远匹配不上
       * React 序列化的 `--vr-columns:1`（无空格），于是单栏模式反而命中多栏分支，
       * 每一页被推到不存在的下一栏、正文整页移出可视区。类名判据与变量写法无关。
       */
      /\.vr-content\.vr-multicolumn\s+\.vr-page\[data-page-break-before\]/.test(css) &&
      !/\[style\*="--vr-columns/.test(css) &&
      // 面板必须在 columns >= 2 时给出这个类（否则判据永远不会命中）。
      /vr-multicolumn/.test(
        readFileSync(
          join(ROOT, "apps/desktop/src/app_ui/panels/viewer/ViewerReader.tsx"),
          "utf8",
        ),
      ) &&
      // 需求 3：普通图**按容器高封顶**（koodo `handleImageSize` 的口径），
      // 不是「不封顶」（旧 `max-height: none` 正是"顶破一页"的成因）。
      /--br-page-h/.test(css) &&
      /--vr-page-h/.test(css) &&
      // **PDF 例外必须与规则先后顺序无关**：`.br-content .vr-image`（0,2,0）与
      // `.vr-pdf .vr-image`（0,2,0）平局时后者先写、前者后写 ⇒ 前者赢。
      // 因此阅读器侧必须存在**更高特异性**的 PDF 例外（0,3,0）。
      /\.br-content\.vr-pdf\s+\.vr-image/.test(css) &&
      /\.br-content\s+\.vr-pdf\s+\.vr-image/.test(css) &&
      // 图组整体不可拆（图与图注同栏）。
      /\.vr-figure[^}]*break-inside:\s*avoid/.test(css) &&
      // 需求 1：全屏改白必须**两条**都存在（根节点内部 + ::backdrop 外部）。
      /\.br-root:fullscreen\s*\{[^}]*background:\s*#ffffff/.test(css) &&
      /\.br-root:fullscreen::backdrop\s*\{[^}]*background:\s*#ffffff/.test(css)
    );
  })(),
);

check(
  "Rust：`hp-book` 的目录解析覆盖 nav / NCX / 兜底与小说章节规则（每条都有单元测试）",
  (() => {
    const toc = readFileSync(join(ROOT, "crates/hp-book/src/toc.rs"), "utf8");
    return (
      /pub fn read_epub_toc\(/.test(toc) &&
      /fn nav_entries\(/.test(toc) &&
      /fn ncx_entries\(/.test(toc) &&
      /fn spine_titles\(/.test(toc) &&
      /pub fn text_toc\(/.test(toc) &&
      /pub fn markdown_toc\(/.test(toc) &&
      // 防误判的三条约束 + 三类写法都要有测试钉住。
      /fn txt_prose_that_merely_mentions_chapters_is_not_a_heading/.test(toc) &&
      /fn txt_volumes_group_chapters_one_level_deeper/.test(toc) &&
      /fn txt_special_and_english_headings_are_recognized/.test(toc)
    );
  })(),
);

check(
  "Rust：整本解码的字节上限由调用方给出（阅读器 64 MiB / 查看器沿用 2 MiB），且「恰好等于上限」不算截断",
  (() => {
    const text = readFileSync(join(ROOT, "crates/hp-book/src/text.rs"), "utf8");
    return (
      /pub fn decode_head_limited\(/.test(text) &&
      /pub fn decode_file_limited\(/.test(text) &&
      /pub fn decode_file_head\(/.test(text) &&
      /fn decode_file_limited_honours_the_caller_byte_cap/.test(text)
    );
  })(),
);

check(
  "Rust：阅读批注（书签 / 笔记 / 高亮）落库——迁移 0011 + 三种形态共用一张表 + 写库前校验",
  (() => {
    const sql = readFileSync(
      join(ROOT, "crates/hp-repo/migrations/repo/0011_reader_annotations.sql"),
      "utf8",
    );
    const repoDb = readFileSync(join(ROOT, "crates/hp-repo/src/repo_db.rs"), "utf8");
    const repo = readFileSync(
      join(ROOT, "crates/hp-repo/src/annotation_repo.rs"),
      "utf8",
    );
    const core = readFileSync(join(ROOT, "crates/hp-core/src/annotation.rs"), "utf8");
    return (
      // 迁移必须**登记进执行器**，否则表根本不会建（"写了 SQL 但没接上"）。
      /0011_reader_annotations\.sql/.test(repoDb) &&
      /CREATE TABLE reader_annotations/.test(sql) &&
      // 外键级联 + 按 file_id 存（与 file_covers / ratings 同一口径）。
      /REFERENCES files\(id\) ON DELETE CASCADE/.test(sql) &&
      // 三种形态一张表、由 kind 区分。
      /kind\s+TEXT NOT NULL,\s*-- bookmark\|note\|highlight/.test(sql) &&
      // 写库前校验（不接受"库里存了什么就是什么"）。
      // **钉调用点而不是符号名**：只断言 `validate_annotation_content` 出现过，
      // 会被 import 那一行满足（实测：把调用改成 `if false {` 仍然全绿）。
      /if let Err\(reason\) = validate_annotation_content\(kind, cursor, excerpt, note\) \{/.test(
        repo,
      ) &&
      // 未知 kind 的行**跳过**而不是退化成某一种（猜错会把书签显示成空白笔记）。
      /AnnotationKind::from_str\(&kind\) else \{\s*\n\s*return Err\(rusqlite::Error::QueryReturnedNoRows\)/.test(
        repo,
      ) &&
      // 领域侧：书签不需要正文、笔记 / 高亮必须有内容。
      /pub fn requires_content\(self\) -> bool/.test(core) &&
      // 外键级联有测试钉住（文件删了批注必须跟着消失）。
      /fn delete_is_idempotent_and_cascades_with_the_file/.test(
        readFileSync(join(ROOT, "crates/hp-repo/tests/m7_reader_annotations.rs"), "utf8"),
      )
    );
  })(),
);

check(
  "Rust：卸载源时必须清掉**标记与阅读批注**（DERIVED_TABLES 与清点成对维护）",
  (() => {
    const purge = readFileSync(join(ROOT, "crates/hp-repo/src/purge_repo.rs"), "utf8");
    return (
      // 两张表都带 ON DELETE CASCADE，但**显式登记**才能不依赖 foreign_keys 开关。
      /"file_marks",/.test(purge) &&
      /"reader_annotations",/.test(purge) &&
      // 清点与清理必须成对：少一项只会让进度条总数偏小（不报错，因此更要有断言）。
      /marks: count\("file_marks"\)\?/.test(purge) &&
      /annotations: count\("reader_annotations"\)\?/.test(purge) &&
      /self\.marks\s*\n?\s*\+ self\.annotations/.test(purge) &&
      /"file_marks" => removed\.marks = n/.test(purge) &&
      /"reader_annotations" => removed\.annotations = n/.test(purge)
    );
  })(),
);

// ============================== 左栏栏头（2026-10-17）==============================
//
// 用户口径："目录部分的样式如图所示，最上面要有封面，作者等。"
// （参考图左栏 = 封面 + 书名 + 作者 + 已读，其下四个标签与章节列表）。
//
// 这一组的断言钉**结构与来源**，不只钉"某符号出现过"：
// - 栏头必须在**四个标签之上**（切标签不收起），因此它在 `ReaderTocRail` 里、
//   位于 `.br-rail-tabs` **之前**；
// - 封面必须复用图书预览的 `BookCoverArt`（同一本书两个面板一张封面），
//   且取数走 `usesEmbeddedCover`（`txt` / `md` 一次 IPC 都不发）；
// - 「已读」必须与顶栏的会话计时是**同一个数**（`sessionMinutes`），
//   不得另起一个累计计时（项目里没有累计阅读时长这种记录）。

const readerRailSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderTocRail.tsx"),
  "utf8",
);
const readerHeaderSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderBookHeader.tsx"),
  "utf8",
);
const readerIdentitySrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/useReaderBookIdentity.ts"),
  "utf8",
);

check(
  "左栏栏头：封面 / 书名 / 作者 / 已读在**四个标签之上**（切标签不收起）",
  (() => {
    const head = readerRailSrc.indexOf("<ReaderBookHeader");
    const tabs = readerRailSrc.indexOf('className="br-rail-tabs"');
    return (
      // 位置关系：栏头在前、标签条在后（注释里也提到这两个名字，因此按
      // **JSX 出现位置**比较，而不是"是否出现过"）。
      head > 0 && tabs > 0 && head < tabs &&
      // 栏头必须**包在切换条件之外**：不是 `{tab === "toc" && <ReaderBookHeader …>}`。
      !/\{tab[^}]*&&\s*<ReaderBookHeader/.test(readerRailSrc) &&
      /book && <ReaderBookHeader/.test(readerRailSrc) &&
      // 三样内容都在栏头里（书名 / 作者 / 已读）。
      /br-book-title/.test(readerHeaderSrc) &&
      /br-book-author/.test(readerHeaderSrc) &&
      /bookreader\.headReadTime/.test(readerHeaderSrc) &&
      // 作者沿用图书预览的「作者：」标签（不另立第二套文案），缺值显示 `—`。
      /book\.authorLabel/.test(readerHeaderSrc) &&
      /bookreader\.unknown/.test(readerHeaderSrc)
    );
  })(),
  `head@${readerRailSrc.indexOf("<ReaderBookHeader")} tabs@${readerRailSrc.indexOf(
    'className="br-rail-tabs"',
  )}`,
);

check(
  "左栏栏头：封面**复用图书预览的 `BookCoverArt`**（同一本书两个面板一张封面）",
  (() =>
    // 正向：用同一个封面组件（文字封面打底 + 封面图盖上 + 覆盖优先级 + 失败回落都不要再写一遍）。
    /import \{ BookCoverArt \} from "\.\.\/bookpreview\/BookCoverArt"/.test(readerHeaderSrc) &&
    /<BookCoverArt\b/.test(readerHeaderSrc) &&
    // 书名与图书预览**同一条**规则（去目录去扩展名），不是取 `relative_path` 原样。
    /import \{ bookDisplayName \} from "\.\.\/bookpreview\/bookPreviewView"/.test(
      readerHeaderSrc,
    ) &&
    /bookDisplayName\(file\.relative_path\)/.test(readerHeaderSrc) &&
    // 反向：不得自己再拼一套封面渲染（`<img src=…>` / 自造渐变）。
    !/<img\b/.test(readerHeaderSrc) &&
    !/linear-gradient/.test(readerHeaderSrc))(),
);

check(
  "左栏栏头：`txt` / `md` **不发**元数据命令（判据与图书预览同一个 `usesEmbeddedCover`）",
  (() =>
    /import \{ usesEmbeddedCover \} from "\.\.\/bookpreview\/bookPreviewView"/.test(
      readerIdentitySrc,
    ) &&
    /const wantsCover = item !== null && usesEmbeddedCover\(item\)/.test(readerIdentitySrc) &&
    // 判据为假时直接返回、**不**调 `loadBookMeta`（守卫必须在调用之前）。
    /if \(!repoId \|\| !fileId \|\| !wantsCover\) \{\s*\n\s*setMeta\(null\);\s*\n\s*return;/.test(
      readerIdentitySrc,
    ) &&
    // 反向：`loadBookMeta` 只能出现在守卫**之后**（否则 txt 也会白跑一次 IPC）。
    readerIdentitySrc.indexOf("loadBookMeta(repoId, fileId)") >
      readerIdentitySrc.indexOf("if (!repoId || !fileId || !wantsCover)"))(),
);

check(
  "左栏栏头：「已读 N min」与顶栏会话计时是**同一个数**（不另起累计计时）",
  (() =>
    // 面板把**同一个** `sessionMinutes` 交给栏头（顶栏的「本次阅读时间」用的是它）。
    /readMinutes: sessionMinutes/.test(readerPanelSrc) &&
    // 栏头把它原样透传给组件，组件把它渲染成「已读」那一行。
    /<ReaderBookHeader \{\.\.\.book\} t=\{t\} \/>/.test(readerRailSrc) &&
    /bookreader\.headReadTime", \{ min: readMinutes \}/.test(readerHeaderSrc) &&
    // 反向：栏头里不得自己起一个计时器 / 读 `Date.now()`（那会是第二个口径）。
    !/setInterval|Date\.now\(\)|SessionStart/.test(readerHeaderSrc))(),
);

check(
  "左栏栏头：封面覆盖（用户自选颜色 / 图片）与图书预览**共用**同一份缓存",
  (() =>
    /loadBookCovers\(repoId, \[fileId\]\)/.test(readerIdentitySrc) &&
    /import \{ useBookCoverOverride \}/.test(readerIdentitySrc) &&
    /useBookCoverOverride\(repoId, fileId \?\? ""\)/.test(readerIdentitySrc) &&
    // 反向：不得自己发一次 `book_covers` 或另建一份缓存。
    !/api\.bookCovers\(/.test(readerIdentitySrc) &&
    !/new Map</.test(readerIdentitySrc))(),
);

check(
  "左栏栏头：样式里封面宽度固定、书名最多三行、四个标签等分栏宽",
  (() => {
    const cover = stylesSource.match(/\.br-book-cover\s*\{[^}]*\}/)?.[0] ?? "";
    const title = stylesSource.match(/\.br-book-title\s*\{[^}]*\}/)?.[0] ?? "";
    const tab = stylesSource.match(/\.br-rail-tab\s*\{[^}]*\}/)?.[0] ?? "";
    return (
      /width:\s*\d+px/.test(cover) &&
      /flex:\s*none/.test(cover) &&
      /-webkit-line-clamp:\s*[23]/.test(title) &&
      /flex:\s*1/.test(tab) &&
      // 标签条不得再用 `margin-left: auto` 推关闭按钮（那会让四个标签不再等分）。
      !/margin-left:\s*auto/.test(stylesSource.match(/\.br-rail-close\s*\{[^}]*\}/)?.[0] ?? "")
    );
  })(),
);

// ============================== 点击正文收起两栏（2026-10-17）==============================
//
// 用户口径："点击更多后，点击正文区域可以隐藏两栏（等同于再次点击更多）"。
//
// 这组的重点是**不误伤**：点链接要跳走、点分页按钮要翻页、划词要能选中——
// 三种操作都会产生 click 事件，都不该把目录关掉。

check(
  "点击正文收起两栏：纯函数按行为判定（点在链接 / 分页按钮 / 划词时都不收起）",
  (() => {
    const fn = readerView.bodyClickHidesRails;
    if (typeof fn !== "function") return false;
    return (
      // 正文空白处：收起。
      fn({ interactive: false, hasSelection: false }) === true &&
      // 点在链接 / 分页按钮里：**不**收起（它们有各自的语义）。
      fn({ interactive: true, hasSelection: false }) === false &&
      // 正在划词：**不**收起（划完松手同样会触发 click）。
      fn({ interactive: false, hasSelection: true }) === false &&
      fn({ interactive: true, hasSelection: true }) === false
    );
  })(),
);

check(
  "点击正文收起两栏：可交互判定走 `closest` 而不是 tagName（点链接内的 span 也算链接）",
  (() => {
    const probe = readerView.isInteractiveTarget;
    if (typeof probe !== "function") return false;
    // 假一份"链接内部的 span"：closest("button, a, …") 命中 ⇒ 可交互。
    const innerSpan = { tagName: "SPAN", closest: (s) => (s.includes("a") ? {} : null) };
    // 正文段落：closest 一律 null ⇒ 不可交互。
    const paragraph = { tagName: "P", closest: () => null };
    return (
      probe(innerSpan) === true &&
      probe(paragraph) === false &&
      // 无 closest（文本节点 / 空目标）不得抛错。
      probe(null) === false &&
      probe(undefined) === false &&
      probe({}) === false
    );
  })(),
);

check(
  "点击正文收起两栏：阅读区挂了 onClick、面板只在两栏展开时传回调（收起态无副作用）",
  (() => {
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    return (
      // 阅读区真的接了点击（正向锚点）。
      /onClick=\{handleClick\}/.test(stage) &&
      // 两条否决判据都问纯函数，而不是各自写死一个 if。
      /bodyClickHidesRails\(\{/.test(stage) &&
      /isInteractiveTarget\(/.test(stage) &&
      /window\.getSelection\(\)\?\.toString\(\)/.test(stage) &&
      // 面板：展开才传回调；收起时是 `undefined`（结构性保证，不在回调里判）。
      /onBodyClick=\{railsOpen \? collapseRails : undefined\}/.test(readerPanelSrc) &&
      // 收起动作必须与「更多」同一个状态量（否则点正文与再点更多会走两条路）。
      /const collapseRails = useCallback\(\(\) => \{\s*setRailsOpen\(false\);/.test(
        readerPanelSrc,
      ) &&
      /const toggleRails = useCallback\(\(\) => \{\s*setRailsOpen\(\(open\) => !open\)/.test(
        readerPanelSrc,
      )
    );
  })(),
);

// ============ 进度 / 章节数：页游标区间 + 页内插值（2026-10-17 最终架构）============
//
// 用户口径："章节数十/十二的计数直接读取目录和当前章节计算不就可以了"。
//
// 因此旧的两套辅助函数已删除（它们都在做「跨页的比例乘法」，而比例是像素的、
// 章节长度是结构的，两者不成比例 → 章节数乱跳）：
//   `readerProgress`        —— 段起点 + 段内比例 × 已载入单位
//   `readerScrollFraction`  —— 整段滚动像素比例
//   `readerPageFraction`    —— 当前页 / 总页数
//   `readerLoadedUnits`     —— 已载入单位求和
// 现在位置只由 `readerPageCursors`（精确页区间）+ `readerPositionFromPage`
// （单页内部插值）得出；章号另取整数页起点。两者的行为断言在下面几段。

check(
  "上报节流：小于显示精度的变化不上报（滚动一秒几十次，不重画整块正文）",
  // 1e-4 就是 0.01%——当前进度的最小可见变化。
  readerView.fractionWorthReporting(0.5, 0.50001) === false &&
    readerView.fractionWorthReporting(0.5, 0.5002) === true &&
    readerView.fractionWorthReporting(0.9, 0.1) === true &&
    // 非有限值一律放行（宁可多报一次，也不要吞掉位置）。
    readerView.fractionWorthReporting(Number.NaN, 0.5) === true,
);

check(
  "章节数 = **目录 + 当前页游标**直接算（不靠插值；整数页起点，页内比例不改变章号）",
  (() => {
    // 真实目录（E:\仓鼠\图书测试\re0\…04.epub 实测）。
    const toc = [
      { cursor: "0" }, { cursor: "2" }, { cursor: "4" }, { cursor: "5" },
      { cursor: "10" }, { cursor: "11" }, { cursor: "12" }, { cursor: "13" },
      { cursor: "14" }, { cursor: "15" }, { cursor: "16" }, { cursor: "17" },
      { cursor: "18" },
    ];
    // 20 个 section（第 0 起）。
    const pages = Array.from({ length: 20 }, (_, i) => ({
      format: "epub",
      text: null,
      blocks: [],
      section: i,
      next_cursor: i + 1 < 20 ? String(i + 1) : null,
    }));
    const cursors = readerView.readerPageCursors(pages, "0");
    const expected = (section) => {
      let idx = -1;
      for (let i = 0; i < toc.length; i += 1) {
        if (Number(toc[i].cursor) <= section) idx = i;
        else break;
      }
      return idx;
    };
    // 逐项：每页起点算出的章号必须与目录一致，且**页内比例不改变章号**。
    let ok = true;
    for (let i = 0; i < pages.length; i += 1) {
      const start = Math.floor(cursors[i].start);
      if (readerView.currentTocIndex(toc, String(start)) !== expected(i)) ok = false;
    }
    // 序章（section 11）→ 目录第 6 项；第四章（15）→ 第 10 项。
    const atPreface = readerView.currentTocIndex(toc, "11");
    const atCh4 = readerView.currentTocIndex(toc, "15");

    /*
     * **加载更多不得改变已显示页的起点**——这是旧实现"乱跳"的直接来源：
     * 旧式"段起点 + 比例 × 已载入单位"里，`loadedUnits` 随加载变大、像素比例随总高变小，
     * 两者相乘后的结果会在加载瞬间跳好几章。现在页区间由 `next_cursor` 精确给出，
     * 追加页只往后加，**前面页的 start 逐字节不变**。
     */
    const before = readerView.readerPageCursors(pages.slice(0, 6), "0");
    const after = readerView.readerPageCursors(pages.slice(0, 12), "0");
    let stable = true;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i].start !== after[i].start || before[i].end !== after[i].end) stable = false;
    }
    // 且同一页的章号在加载前后一致。
    let chapterStable = true;
    for (let i = 0; i < before.length; i += 1) {
      const a = readerView.currentTocIndex(toc, String(Math.floor(before[i].start)));
      const b = readerView.currentTocIndex(toc, String(Math.floor(after[i].start)));
      if (a !== b) chapterStable = false;
    }
    return (
      ok &&
      atPreface === 5 &&
      atCh4 === 9 &&
      stable &&
      chapterStable &&
      // 反向：面板必须读 `currentPageCursor`（整数页起点），不得拿带小数的
      // `absolutePosition` 去判章——小数越过下一条目录项会让章号提前跳。
      /const at = currentTocIndex\(book\.toc, String\(currentPageCursor\)\)/.test(
        stripComments(readerPanelSrc),
      ) &&
      !/const at = currentTocIndex\(book\.toc, String\(absolutePosition\)\)/.test(
        stripComments(readerPanelSrc),
      )
    );
  })(),
);

check(
  "位置探测：每页带 `data-page-index`、由 DOM 认出当前页（不再用「整段像素比例」）",
  (() => {
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    const code = stripComments(stage);
    return (
      // 每页仍必须带页号标记（几何判定要靠它认项；`closest` 早已不用，见下面的反向断言）。
      /data-page-index=\{index\}/.test(code) &&
      // 上报的是"第几页 + 页内比例"。
      /onPositionChange\(\{ visibleIndex, offsetInPage \}\)/.test(code) &&
      // **两个分支量的是同一组矩形**（D227）：每项只取一次 `getBoundingClientRect()`，
      // 分页拿横向并集盒比视口左缘、滚动拿纵向区间比视口上缘。
      //
      // 钉**取值来源**，不只钉变量名（项目记过教训：把一行换成 `host.getBoundingClientRect()`
      // 时，只检查变量名字面写法的断言仍然全绿——变量名没变、变的是它装了什么）。
      /const elements = Array\.from\(flow\.querySelectorAll<HTMLElement>\("\[data-page-index\]"\)\);/.test(
        code,
      ) &&
      // **反向**：两种模式都不得再向"被平移的内容框"要基准。
      !/const flowRect = flow\.getBoundingClientRect\(\);/.test(code) &&
      !/const flowRect = host\.getBoundingClientRect\(\);/.test(code) &&
      // **分页模式的上报基准是纸张**（视口，不随 `translateX` 平移）。
      // 2026-11-15 真机实测后分页改成"量几何"：视口内容左缘 = 纸张左缘 + 纸内页边距，
      // 它落在哪一项的并集盒里，那一项就是正在读的项（单点取点会落进首行留白）。
      // 反向断言钉住旧算式与旧取点（`basis.top + 2` / `paged: true` 的探测点）。
      /const paperRect = paperRef\.current\?\.getBoundingClientRect\(\) \?\? null;/.test(code) &&
      /const viewportLeft = \(paperRect\?\.left \?\? 0\) \+ pagedLayout\.margin;/.test(code) &&
      /readerVisiblePageIndex\(\{/.test(code) &&
      /readerScrollVisiblePageIndex\(\{ vpTop: hostRect\.top, pages \}\)/.test(code) &&
      !/basis\.top \+ 2/.test(code) &&
      !/paged: true,/.test(code) &&
      // **反向**：阅读器里不得再有任何取点（D227 之后 `elementFromPoint` 归零）。
      !/document\.elementFromPoint\(/.test(code) &&
      !/closest\?\.\("\[data-page-index\]"\)/.test(code) &&
      // 纸张必须真的挂上了 ref（否则 `paperRef.current` 恒为 null、退回被平移的内容框）。
      /className="br-paper"\s+ref=\{paperRef\}/.test(code) &&
      // **页内比例的分母必须是"这一项的宽"**（`.br-page` 的并集盒 = 该项总内容宽）：
      // 消费方 `readerPositionFromPage` 算 `item.start + offset × item.span`，
      // 两边都必须是"项的百分比"才能相乘。
      //
      // 钉住这条是因为**实测踩过一次**：把分母换成"屏内栏数 ÷ 屏宽"（语义 = 读到屏内第几栏）
      // 在项短于一屏时看着也对，项一跨栏就**饱和**——实测三屏得 0 / 2.078 / 4.156，
      // `clamp01` 压成 1，于是**第一屏翻页后进度直接跳到项尾**
      // （`tools/reader-probe-verify.mjs` 逐屏量出）。
      /const viewportLeft =\s*\n?\s*\(paperRef\.current\?\.getBoundingClientRect\(\)\.left \?\? 0\) \+ pagedLayout\.margin;/.test(
        code,
      ) &&
      /pageRect\.width > 0 \? \(viewportLeft - pageRect\.left\) \/ pageRect\.width : 0/.test(code) &&
      // **反向**：不得把页内比例换算成"屏内第几栏"（会饱和到 1）。
      !/\* columns\) \/ screenWidth/.test(code) &&
      // **反向**：分页模式不得再以被平移的内容框为基准取点。
      !/flowRect\.left \+ Math\.min\(flowRect\.width \/ 2, 40\)/.test(code) &&
      // **反向**：不得再回到"整段像素比例"那套（它与章数不成比例，正是乱跳的根因）。
      !/reportFraction\(readerScrollFraction/.test(code) &&
      !/readerScrollFraction\(/.test(code) &&
      !/readerPageFraction\(/.test(code)
    );
  })(),
);

check(
  "位置探测的三个触发点齐备（滚动 / 翻页 / 内容或几何变化），且翻页回调不直接上报",
  (() => {
    const stage = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderStage.tsx"),
      "utf8",
    );
    const code = stripComments(stage);
    return (
      /const handleScroll = useCallback\([\s\S]*?reportPosition\(\);/.test(code) &&
      // `pages` / `page` / 宽度变化后重探（不产生任何事件，必须补）。
      /requestAnimationFrame\(\(\) => reportPosition\(\)\)/.test(code) &&
      // 挂载时也探一次（跳章后 `key` 变即重挂载）。
      (code.match(/reportPosition\(\)/g) ?? []).length >= 3
    );
  })(),
);

check(
  "接线：面板把位置算进两处进度，底部两处精度分开（当前 00.00% / 本章 00.0%）",
  (() => {
    const footer = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderFooter.tsx"),
      "utf8",
    );
    return (
      /onPositionChange=\{setVisiblePage\}/.test(readerPanelSrc) &&
      /readerPositionFromPage\(visiblePage\.visibleIndex, visiblePage\.offsetInPage, pageCursors\)/.test(
        readerPanelSrc,
      ) &&
      /readerChapterProgress\(book\.toc, absolutePosition, totalUnits\)/.test(readerPanelSrc) &&
      // epub / pdf 的总量取 `section_count`（它们的 `book.total` 恒为 null）。
      /first\?\.section_count \?\? null\)/.test(readerPanelSrc) &&
      /formatProgressPercent\(progress, 2\)/.test(footer) &&
      /formatProgressPercent\(chapterProgress, 1\)/.test(footer) &&
      /bookreader\.footer\.chapterProgress/.test(footer)
    );
  })(),
);

// ==================== 底栏：删页数、章节数保持原样（2026-10-17）====================
//
// 用户口径："使用百分比计数" → 随即更正为"**章节数保持原样，仅删除页数**"。
// 因此这里钉两件事：章节数**仍是 `1 / 14`**（不是百分比）、页数那一格**确实没了**。

check(
  "底栏：章节数**保持原样** `1 / 14`（更正过：不改成百分比）",
  (() => {
    const footer = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderFooter.tsx"),
      "utf8",
    );
    return (
      // 正向：仍然是整数比值。
      /<b>\s*\{chapters\.at\} \/ \{chapters\.total\}\s*<\/b>/.test(footer) &&
      // 反向：不得把章节数折成百分比（用户先要后撤，两者不能并存）。
      !/formatProgressPercent\(\s*chapters\.at/.test(stripComments(footer)) &&
      !/chaptersPercent/.test(stripComments(footer))
    );
  })(),
);

check(
  "底栏：**页数一格已删除**（面板不再算 pagesInfo，footer 不再有 pages 属性与文案）",
  (() => {
    const footer = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/ReaderFooter.tsx"),
      "utf8",
    );
    return (
      // 正向：三格（当前进度 / 本章进度 / 章节数）。
      !/pages/.test(stripComments(footer)) &&
      // 面板侧不再有这套折算：它是"按一页 2 万字符"估出来的，与另外两格的精确百分比并列会误导。
      !/pagesInfo/.test(stripComments(readerPanelSrc)) &&
      // 传参里也不再出现 pages。
      !/pages=\{pagesInfo\}/.test(readerPanelSrc)
    );
  })(),
);

// ==================== 章节数 = 目录 + 当前页游标（2026-10-17 最终口径）====================
//
// 用户口径："章节数十/十二的计数直接读取目录和当前章节计算不就可以了"。
// 就是这一条：章节数**不做任何插值**——取当前页的**整数起点游标**，去目录里找
// "最后一条 cursor ≤ 它"的项。插值只服务"本章进度"的小数部分，与章号无关。

check(
  "章节数 / 章节标题 / 目录高亮：三处都用**当前页游标**（整数），不是取数游标",
  (() => {
    const src = stripComments(readerPanelSrc);
    const chaptersBlock =
      src.match(/const chaptersInfo = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? "";
    const titleBlock =
      src.match(/const chapterTitle = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? "";
    return (
      /currentTocIndex\(book\.toc, String\(currentPageCursor\)\)/.test(chaptersBlock) &&
      /currentTocIndex\(book\.toc, String\(currentPageCursor\)\)/.test(titleBlock) &&
      // 反向：不得退回取数游标（只在换章时变 → "不跳动"），
      // 也不得用带小数的 absolutePosition（小数越过下一条目录项会让章号提前跳）。
      !/book\.cursor/.test(chaptersBlock) &&
      !/book\.cursor/.test(titleBlock) &&
      !/String\(absolutePosition\)/.test(chaptersBlock) &&
      !/String\(absolutePosition\)/.test(titleBlock) &&
      // 目录高亮同一判据。
      /cursor=\{currentPageCursor === null \? null : String\(currentPageCursor\)\}/.test(src) &&
      // 当前页游标必须取整数（`Math.floor`），否则小数部分会让相邻两页落到同一项之外。
      /return Number\.isFinite\(start\) \? Math\.floor\(start\) : null;/.test(src)
    );
  })(),
);

check(
  "章节数实时**不影响阅读区实例**：`key` 仍是取数游标（拿位置当 key 会每帧重挂载）",
  (() => {
    const src = stripComments(readerPanelSrc);
    const key = src.match(/key=\{`\$\{fileId \?\? "-"\}:\$\{([^}]*)\}`\}/)?.[1] ?? "";
    return key.includes("book.cursor") && !key.includes("absolutePosition") && !key.includes("visiblePage");
  })(),
  `key 变量=${(stripComments(readerPanelSrc).match(/key=\{`\$\{fileId \?\? "-"\}:\$\{([^}]*)\}`\}/)?.[1] ?? "（未命中）")}`,
);

check(
  "绝对位置：由**页游标区间 + 页内比例**算出（只在单页内部插值，不做跨页比例乘法）",
  (() => {
    const src = stripComments(readerPanelSrc);
    const block =
      src.match(/const absolutePosition = useMemo\([\s\S]*?\[visiblePage, pageCursors\],\s*\n  \);/)?.[0] ??
      "";
    return (
      // 正向：单页内部插值。
      /readerPositionFromPage\(visiblePage\.visibleIndex, visiblePage\.offsetInPage, pageCursors\)/.test(
        block,
      ) &&
      // 页游标区间来自 `next_cursor`（精确），不是靠页数估算。
      /readerPageCursors\(book\.pages, book\.segmentStart\)/.test(src) &&
      // **反向**：不得再出现"整段像素比例 × 已载入单位"（两种度量不成比例，
      // 章节长短不等时会跳整章——这是"章节数乱跳"的根因）。
      !/readFraction \* loadedUnits/.test(src) &&
      !/baseCursor \+ readFraction/.test(src) &&
      // 进度由绝对位置直接得出（与章节数同源，不会各说各话）。
      /absolutePosition \/ totalUnits/.test(src)
    );
  })(),
);

check(
  "段起点 `segmentStart`：`loadMore` **不**改动它（改了会让已读位置往后退，章节数回 1）",
  (() => {
    // D209 起分页状态机在共享钩子里：两个面板共用一份，断言跟着搬过去；
    // 同时反向钉住"阅读器自己不再持有世代号 / 取数 / 页表"。
    const code = stripComments(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/useBookPages.ts"), "utf8"),
    );
    const readerHook = stripComments(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/useReaderBook.ts"), "utf8"),
    );
    const loadMoreBlock = code.match(/const loadMore = useCallback\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? "";
    const fetchPageBlock = code.match(/const fetchPage = useCallback\([\s\S]*?\n  \);/)?.[0] ?? "";
    return (
      // 正向：首屏与跳转各自设起点（跳转 = 目标）。
      /setSegmentStart\("0"\)/.test(code) &&
      /setSegmentStart\(target\)/.test(code) &&
      // 反向：`loadMore` 与 `fetchPage` 都不得写 `setSegmentStart` / `setCursor`——
      // 一个会让段起点漂移，另一个会让 `key` 每页变一次（阅读区反复重挂载）。
      //
      // 注意正则写的是 **`setSegmentStart`**（带 `set`）：只写 `segmentStart` 会漏掉
      // 真正的赋值语句——setter 名里的那一段是 `SegmentStart`（大写 S），
      // `/segmentStart/` 匹配不到它。这条在本轮变异测试里**第一次没红**，
      // 正是因为断言只匹配了小写的变量名（已如实记录）。
      !/setSegmentStart/.test(loadMoreBlock) &&
      !/setCursor/.test(loadMoreBlock) &&
      !/setSegmentStart/.test(fetchPageBlock) &&
      !/setCursor/.test(fetchPageBlock) &&
      !/setState\(\(prev\) => \(\{ \.\.\.prev, loading: false, cursor: from/.test(code) &&
      !/cursor: from, error: null/.test(code) &&
      // 消费方必须把 `book.segmentStart` 交给页游标表（不是 `book.cursor`——
      // 后者只是跳转目标，首屏与 loadMore 都不更新）。
      /readerPageCursors\(book\.pages, book\.segmentStart\)/.test(stripComments(readerPanelSrc)) &&
      !/readerPageCursors\(book\.pages, book\.cursor\)/.test(stripComments(readerPanelSrc)) &&
      !/generationRef|api\.bookContent\(|setPages\(/.test(readerHook)
    );
  })(),
);

// ============ D228：点标签切进阅读器时把键盘焦点交给阅读区 ============
//
// 真机实测：点标签进阅读器后焦点留在 DIV.dv-tab 上，方向键翻页**完全没反应**
// （页脚恒 0.00% / 0.0% / 1 / 13、.br-flow 的 transform 恒 translateX(0px)）；
// 先给 .br-stage 手动 focus() 再按右方向键，第一次就翻到 2.46% / translateX(-793px)。
// 可见 D222 的几何判定本身是好的，缺的是"把焦点送过去"这一步。
//
// 焦点目标是**阅读区**（键处理挂在 .br-stage 上），不是面板根 .br-root：
// 面板根没有键处理器，把焦点给根等于换了个地方收不到键。
check(
  "图书阅读器：点标签切进面板时把键盘焦点拿到阅读区（与播放器等共用 shared/panelFocus.ts）",
  /import \{ usePanelFocusOnActivate \} from "\.\.\/\.\.\/shared\/panelFocus";/.test(readerStageSrc) &&
    /usePanelFocusOnActivate\(api, hostRef\);/.test(readerStageSrc) &&
    /api\?: PanelRenderCtx\["api"\];/.test(readerStageSrc) &&
    // 面板真的把句柄传下去了（否则钩子空转，等于没接）。
    /api=\{panelApi\}/.test(readerPanelSrc),
);
check(
  "图书阅读器：焦点落在阅读区（.br-stage 可聚焦且有键处理），不是没有键处理器的面板根",
  /ref=\{hostRef\}[\s\S]{0,80}?tabIndex=\{0\}/.test(readerStageSrc) &&
    /onKeyDown=\{handleKeyDown\}/.test(readerStageSrc) &&
    !/className="panel br-root" ref=\{rootRef\} tabIndex/.test(readerPanelSrc),
);

}
