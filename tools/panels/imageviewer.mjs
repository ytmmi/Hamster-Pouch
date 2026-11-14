/**
 * 面板门禁分节 · 图像查看器：键映射 / 胶片栏 / 序列 / 格式 / 首帧（原第 8–15 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList, stripComments } from "./harness.mjs";
import {
  BOOK_BRIDGE_SRC, ROOT, config, fileAt, imageViewerPanelSrc, imageViewerSpec,
  mediaPaging, mediaSortStore, mediaView, pageStub, preload, scroll,
  settingValueSrc, stylesSource, viewerInfoBarSrc, viewerSettingsSrc,
} from "./shared.mjs";
export default async function run() {
// ==================== 图像查看器：按键映射 + 键盘焦点获取 ====================
//
// 防的是"功能都在、就是按不动"这一类缺陷（与缺陷 0015「面板内点不动」同族）：
// ① 键位散落在组件里 → 改一处漏一处；② 键盘处理挂在面板根节点上，而**从其他面板
// 进来**时焦点还在原面板上，根节点根本收不到 `keydown`。两段都按**行为**断言
// （直接 import 纯函数），而不是只对源码写正则。

const keymap = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts")).href
);

check(
  "图像查看器按键映射：左方向键 = 上一张、右方向键 = 下一张（顺序即胶片栏序列）",
  keymap.viewerKeyAction("ArrowLeft") === "prev" &&
    keymap.viewerKeyAction("ArrowRight") === "next",
  `左=${keymap.viewerKeyAction("ArrowLeft")} 右=${keymap.viewerKeyAction("ArrowRight")}`,
);
check(
  "按键映射是**纯函数**：无关按键返回 null（调用方放行、不 preventDefault，宿主快捷键照常冒泡）",
  keymap.viewerKeyAction("a") === null &&
    keymap.viewerKeyAction("Enter") === null &&
    keymap.viewerKeyAction("Escape") === null &&
    keymap.viewerKeyAction("F5") === null,
);
check(
  "方向键上下与 PageUp/PageDown 的既有语义未被删除（回归对照：它们自面板引入起就是换图）",
  keymap.viewerKeyAction("ArrowUp") === "prev" &&
    keymap.viewerKeyAction("PageUp") === "prev" &&
    keymap.viewerKeyAction("ArrowDown") === "next" &&
    keymap.viewerKeyAction("PageDown") === "next" &&
    keymap.viewerKeyAction("Home") === "fit" &&
    keymap.viewerKeyAction("1") === "actual",
);
// 上一张 / 下一张必须落到**同一个**换图入口（`step` → `stepIndex` → `selectIndex`），
// 否则左右键会绕开胶片栏顺序（例如自己 +1 下标、忽略序列边界与空序列）。
check(
  "左右方向键落到同一换图入口（`stepIndex` + 选中序列项），不另立一套下标推进",
  /viewerKeyAction\(event\.key\)/.test(imageViewerPanelSrc) &&
    /action === "prev"[\s\S]{0,80}?step\(-1\)/.test(imageViewerPanelSrc) &&
    /action === "next"[\s\S]{0,80}?step\(1\)/.test(imageViewerPanelSrc) &&
    /stepIndex\(sequence\.index, sequence\.files\.length, delta\)/.test(imageViewerPanelSrc) &&
    // 组件里不得再有散落的 `case "ArrowLeft"` 分支（键位判定只在 viewerKeymap.ts 一处）。
    !/case "ArrowLeft"/.test(imageViewerPanelSrc),
);
// 「从其他面板进入图像查看器」这条路径：面板被程序激活时 DOM 焦点还在原面板上，
// 必须由面板自己把焦点拿到根节点——否则方向键永远不可达（用户看到的正是这个）。
// 三道细节都必须守住，缺一条都会"看起来实现了、实际按不动"：
//   ① 只在**进入**这个转换上取一次（独立单面板窗口的 `panelApi` 每次渲染都是新替身，
//      无条件取会反复抢焦点）；
//   ② 判据在激活的**当帧**读（`onDidActiveChange` 在 `pointerdown` 派发中同步触发，
//      此刻浏览器尚未执行"点击即聚焦"，读到的是点之前的焦点 → 放行；键盘在标签条
//      按 Enter 激活时读到标签元素 → 拦下，标签条左右键导航得以保留）；
//   ③ 取焦点**延后一帧**（鼠标点标签页时浏览器默认动作会把焦点给标签元素，同步
//      `focus()` 会被覆盖，表现为"进来了却按不动"）。
check(
  "从其他面板进入（程序激活）时面板把键盘焦点拿到根节点",
  // 订阅口全仓唯一（`shared/panelActivity.ts`，D212）：面板不再自己接 dockview 事件。
  /usePanelActivity\(panelApi, \(\{ isVisible, isActive \}\)/.test(imageViewerPanelSrc) &&
    !/panelApi\.onDidActiveChange\(|panelApi\.onDidVisibilityChange\(/.test(imageViewerPanelSrc) &&
    /const active = isVisible && isActive;/.test(imageViewerPanelSrc) &&
    /const entered = active && !enteredRef\.current;/.test(imageViewerPanelSrc) &&
    /enteredRef\.current = active;/.test(imageViewerPanelSrc) &&
    /if \(!entered\) return;/.test(imageViewerPanelSrc) &&
    /shouldTakeViewerFocus\(document\.activeElement\)/.test(imageViewerPanelSrc) &&
    // 取焦点延后一帧（否则被浏览器"点击即聚焦标签"的默认动作覆盖）；
    // 帧内重读激活态——这一帧里用户可能已经切走，此时不能再抢焦点。
    /requestAnimationFrame\(\(\) => \{[\s\S]{0,260}?if \(!api\.isVisible \|\| !api\.isActive\) return;[\s\S]{0,80}?rootRef\.current\?\.focus\(\{ preventScroll: true \}\);/.test(
      imageViewerPanelSrc,
    ) &&
    /cancelAnimationFrame\(focusFrameRef\.current\)/.test(imageViewerPanelSrc),
);
// 取焦点**不能无条件抢**：正在输入 / 模态浮层 / 标签条键盘导航都必须让路。
check(
  "取焦点有判据：输入框（input/textarea/select/contenteditable）不抢",
  keymap.shouldTakeViewerFocus({ tagName: "INPUT" }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "TEXTAREA" }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "SELECT" }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "DIV", isContentEditable: true }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "INPUT", closest: () => null }) === false,
);
check(
  "取焦点有判据：模态浮层（[role=dialog]）与标签条（[role=tablist]）内不抢",
  keymap.shouldTakeViewerFocus({ tagName: "DIV", closest: (s) => (s.includes("dialog") ? {} : null) }) ===
    false &&
    keymap.shouldTakeViewerFocus({
      tagName: "DIV",
      closest: (s) => (s.includes("tablist") ? {} : null),
    }) === false,
);
check(
  "取焦点有判据：无焦点 / body / 普通元素（即「从别的面板进来」的形态）要取",
  keymap.shouldTakeViewerFocus(null) === true &&
    keymap.shouldTakeViewerFocus(undefined) === true &&
    keymap.shouldTakeViewerFocus({ tagName: "BODY", closest: () => null }) === true &&
    keymap.shouldTakeViewerFocus({ tagName: "DIV", closest: () => null }) === true,
);
// 面板内点击取焦点这条入口保持不变（胶片栏的 `<button>` 仍不抢）。
check(
  "面板内点击仍把焦点交给根节点（胶片栏按钮不抢，避免键盘操作被面板吞掉）",
  /closest\("button"\)/.test(imageViewerPanelSrc) &&
    /tabIndex=\{0\}/.test(imageViewerPanelSrc) &&
    /onKeyDown=\{onKeyDown\}/.test(imageViewerPanelSrc),
);
check(
  "按键映射与焦点判据是**纯逻辑模块**（无 React / Tauri 依赖，门禁可直接 import）",
  !/from "react"/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts"),
      "utf8",
    ),
  ) && !/@tauri-apps/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts"),
      "utf8",
    ),
  ),
);

// ==================== 图像查看器：胶片栏排序与媒体预览一致（缺陷 0039 / D144） ====================
//
// 防的是"媒体预览设为名称·倒序，胶片栏还是查询顺序的正序"：排序此前是媒体预览
// 私有模块变量 + 面板内 useMemo，第二个消费方（图像查看器）读不到也不消费。
// 修法的三件事各有断言：① 会话覆盖收敛进共享 store（行为驱动）；② 查看器读
// **同一批设置键 + 同一个 store + 同一个纯函数**（源码锚点）；③ 排序变化只重排、
// 不重发游标请求（取数依赖不含排序）。

const settingChangeStore = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/core/settingChangeStore.ts")).href
);
const mediaSortStoreSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/mediaSortStore.ts"),
  "utf8",
);
const mediaSessionSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewSession.ts"),
  "utf8",
);
const viewerSequenceSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/useViewerSequence.ts"),
  "utf8",
);

{
  // 行为断言：写入通知、同值不通知、快照引用只在变化时更换（useSyncExternalStore 前提）。
  let notified = 0;
  const unsubscribe = mediaSortStore.subscribeMediaSort(() => {
    notified += 1;
  });
  const before = mediaSortStore.getMediaSortSession();
  mediaSortStore.chooseMediaSort("time");
  const afterKey = mediaSortStore.getMediaSortSession();
  mediaSortStore.chooseMediaSort("time"); // 同值：不得再通知
  mediaSortStore.chooseMediaSort("desc");
  const afterDir = mediaSortStore.getMediaSortSession();
  mediaSortStore.chooseMediaSort("bogus"); // 非法取值：忽略且不通知
  check(
    "D144：排序覆盖 store——写入即通知、同值/非法不通知、快照稳定引用且键与方向互不覆盖",
    notified === 2 &&
      before !== afterKey &&
      afterKey !== afterDir &&
      afterKey.key === "time" &&
      afterKey.dir === null &&
      afterDir.key === "time" &&
      afterDir.dir === "desc" &&
      mediaSortStore.getMediaSortSession() === afterDir,
    `通知=${notified} key=${afterDir.key} dir=${afterDir.dir}`,
  );
  // 「全部设置」显式写入对应落库键 → 放弃该项覆盖（另一项不受牵连）。
  settingChangeStore.publishSettingChanged(mediaSortStore.MEDIA_SORT_DIR_STORAGE_KEY);
  const afterDirReset = mediaSortStore.getMediaSortSession();
  settingChangeStore.publishSettingChanged(mediaSortStore.MEDIA_SORT_KEY_STORAGE_KEY);
  settingChangeStore.publishSettingChanged("panel.media.view"); // 无关键：不通知
  const afterAllReset = mediaSortStore.getMediaSortSession();
  check(
    "D144：设置显式改动放弃对应覆盖（方向键只清方向、键只清键；无关键不动）",
    afterDirReset.key === "time" &&
      afterDirReset.dir === null &&
      afterAllReset.key === null &&
      afterAllReset.dir === null &&
      notified === 4 &&
      mediaSortStore.MEDIA_SORT_KEY_STORAGE_KEY === "panel.media.sortKey" &&
      mediaSortStore.MEDIA_SORT_DIR_STORAGE_KEY === "panel.media.sortDir",
    `通知=${notified}`,
  );
  unsubscribe();
  mediaSortStore.chooseMediaSort("name");
  check(
    "D144：退订后不再收到通知（订阅表不泄漏）",
    notified === 4,
    `通知=${notified}`,
  );
  // 清理会话状态，避免污染后续断言（store 是模块级的）。
  settingChangeStore.publishSettingChanged(mediaSortStore.MEDIA_SORT_KEY_STORAGE_KEY);
}

check(
  "D144：排序覆盖 store 是纯逻辑模块（无 React / Tauri 依赖），且模块加载即订阅设置变更（放弃覆盖不依赖面板挂载）",
  !/from "react"/.test(mediaSortStoreSrc) &&
    !/@tauri-apps/.test(mediaSortStoreSrc) &&
    /subscribeSettingChanged\(onSettingChanged\);/.test(mediaSortStoreSrc),
);

check(
  "D144：媒体预览从共享 store 取排序覆盖（快照经 useSyncExternalStore），缺省仍读面板设置",
  /useSyncExternalStore\(subscribeMediaSort, getMediaSortSession, getMediaSortSession\)/.test(
    mediaSessionSrc,
  ) &&
    /sortSession\.key \?\? \(isMediaSortKey\(defaultSortKey\) \? defaultSortKey : "name"\)/.test(
      mediaSessionSrc,
    ) &&
    /sortSession\.dir \?\? \(isSortDirection\(defaultSortDir\) \? defaultSortDir : "asc"\)/.test(
      mediaSessionSrc,
    ) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortKey", panelApi\)/.test(mediaSessionSrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortDir", panelApi\)/.test(mediaSessionSrc),
);

// 行为对照：胶片栏用的排序函数与媒体预览**是同一个导出**（不是同形复制）。
{
  const rows = [
    { relative_path: "a\\img2.jpg", size: 100, mtime: "1700000000000000000", media_type: "image" },
    { relative_path: "b\\img10.jpg", size: 300, mtime: "1600000000000000000", media_type: "image" },
    { relative_path: "c\\img1.jpg", size: 200, mtime: "1500000000000000000", media_type: "image" },
  ];
  const asc = mediaView.sortFiles(rows, "name", "asc").map((f) => f.relative_path);
  const desc = mediaView.sortFiles(rows, "name", "desc").map((f) => f.relative_path);
  check(
    "D144：胶片栏消费与媒体预览同一个 `sortFiles` 导出（名称·倒序 = 正序的完全反转，数字感知）",
    asc.join(",") === "c\\img1.jpg,a\\img2.jpg,b\\img10.jpg" &&
      desc.join(",") === "b\\img10.jpg,a\\img2.jpg,c\\img1.jpg" &&
      /import \{[\s\S]*?sortFiles,[\s\S]*?\} from "\.\.\/mediaPreviewView";/.test(viewerSequenceSrc) &&
      /sortFiles\(rawFiles, sortKey, sortDir\)/.test(viewerSequenceSrc),
    `asc=${asc.join(",")}`,
  );
}

check(
  "D144：查看器序列读同一批排序设置键 + 同一个会话覆盖 store（缺省读取带面板 API，热加载四触发源）",
  /usePanelSettingValue\(MEDIA_PANEL_ID, "sortKey", panelApi\)/.test(viewerSequenceSrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortDir", panelApi\)/.test(viewerSequenceSrc) &&
    /useSyncExternalStore\(subscribeMediaSort, getMediaSortSession, getMediaSortSession\)/.test(
      viewerSequenceSrc,
    ) &&
    /sortSession\.key \?\?/.test(viewerSequenceSrc) &&
    /sortSession\.dir \?\?/.test(viewerSequenceSrc) &&
    // 面板把 dockview API 传进序列钩子（否则第 4 条触发源不可达）。
    /useViewerSequence\(app, panelApi\)/.test(imageViewerPanelSrc),
);

check(
  "D144：排序变化只重排、不重取——取数 effect 依赖不含排序，排序在 useMemo 里消费",
  /\}, \[repoId, albumId, sourceId, dirPath, refreshKey\]\);/.test(viewerSequenceSrc) &&
    /\[rawFiles, sortKey, sortDir\],/.test(viewerSequenceSrc) &&
    // 反向：查看器不得另写比较器（同一个事实只有一份实现）。
    !/\.sort\(/.test(stripComments(viewerSequenceSrc)) &&
    !/localeCompare/.test(stripComments(viewerSequenceSrc)),
);

// ==================== 图像查看器：序列无上限 + 胶片栏窗口化（缺陷 0018 余留项 / D146） ====================
//
// 防的是"上限取消了，性能悬崖却搬了家"：取数侧靠 drainPages 的循环安全
// （严格前进 + 页数上限），渲染侧靠有界对称窗口（旧的"只追加不回收"在
// 导航到深处时会挂出几万个 DOM 单元）。行为断言直接跑真函数；接线与
// 盒模型常量按源码/样式表锚点断言。

const filmstripLayout = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerFilmstripLayout.ts")).href
);
const filmstripSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ViewerFilmstrip.tsx"),
  "utf8",
);
const filmstripLayoutSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerFilmstripLayout.ts"),
  "utf8",
);

// ---- drainPages 的完成标志（complete）：不完整必须可判，数组行为不变 ----
{
  const done = pageStub([
    { items: [fileAt(1)], nextCursor: "c1" },
    { items: [fileAt(2)], nextCursor: null },
  ]);
  const drained = await mediaPaging.drainPages(done.fetchPage);
  check(
    "D146：drainPages 翻到末页 → complete=true，且数组展开/序列化行为与旧签名一致",
    drained.complete === true &&
      drained.length === 2 &&
      [...drained].length === 2 &&
      !JSON.stringify(drained).includes("complete"),
    `complete=${drained.complete}`,
  );
}
{
  const looped = pageStub([
    { items: [fileAt(1)], nextCursor: "same" },
    { items: [fileAt(2)], nextCursor: "same" },
    { items: [fileAt(3)], nextCursor: "same" },
  ]);
  const drained = await mediaPaging.drainPages(looped.fetchPage);
  const pages = pageStub([
    { items: [fileAt(1)], nextCursor: "c1" },
    { items: [fileAt(2)], nextCursor: null },
  ]);
  let stop = false;
  const cancelled = await mediaPaging.drainPages(pages.fetchPage, {
    isCancelled: () => stop,
    onPage: () => {
      stop = true;
    },
  });
  check(
    "D146：防御性停手（游标不前进）与中途取消 → complete=false（序列不完整必须可判）",
    drained.complete === false && cancelled.complete === false,
    `looped=${drained.complete} cancelled=${cancelled.complete}`,
  );
}

// ---- 取数侧接线：无条目上限、复用 drainPages、首屏只刷一次、世代号取消 ----
check(
  "D146：查看器序列取消条目上限（VIEWER_MAX_FILES 不复存在），翻页复用媒体预览同一个 drainPages",
  !/VIEWER_MAX_FILES/.test(viewerSequenceSrc) &&
    !/VIEWER_MAX_FILES/.test(filmstripSrc) &&
    !/VIEWER_MAX_FILES/.test(imageViewerPanelSrc) &&
    /import \{ drainPages, type MediaPreviewPageFetcher \} from "\.\.\/mediaPreviewPaging";/.test(
      viewerSequenceSrc,
    ) &&
    /await drainPages<FileItem>\(fetchPage, \{/.test(viewerSequenceSrc) &&
    // 反向：不得再自写第二套 do/while 翻页（循环安全只有 drainPages 一处）。
    !/do \{/.test(stripComments(viewerSequenceSrc)),
);
check(
  "D146：首屏第一页即出图、进度只刷那一次（逐页刷新 = 递增全量重排，0018 P1-A 教训）",
  /let firstPageRendered = false;/.test(viewerSequenceSrc) &&
    /if \(firstPageRendered\) return;/.test(viewerSequenceSrc) &&
    /onFirstPage\?\.\(imagesOnly\(accumulated\)\)/.test(viewerSequenceSrc) &&
    // 反向禁止"按页数取模"的节流写法（每 10 页刷一次仍有秒级累计阻塞）。
    !/% \d+ === 0/.test(stripComments(viewerSequenceSrc)),
);
check(
  "D146：后台翻页用世代号取消（卸载/换来源即停），truncated 只标注防御性停手",
  /const generation = \+\+generationRef\.current;/.test(viewerSequenceSrc) &&
    /const isCancelled = \(\) => generationRef\.current !== generation;/.test(viewerSequenceSrc) &&
    /truncated: !drained\.complete && !\(isCancelled\?\.\(\) \?\? false\)/.test(viewerSequenceSrc),
);

// ---- 窗口几何：行为断言（直接跑真函数） ----
{
  const size = 76;
  const ratioAt = () => 1;
  const unit = filmstripLayout.filmstripCellExtent(size, 1, false) + filmstripLayout.FILMSTRIP_GAP;
  const deep = filmstripLayout.filmstripWindow(50000, 20000 * unit, 600, size, false, ratioAt);
  const head = filmstripLayout.filmstripWindow(50000, 0, 600, size, false, ratioAt);
  check(
    "D146：5 万项序列只渲染有界窗口（深处导航不再挂出前 N 万个单元），窗口覆盖视口",
    deep.end - deep.start <= 40 &&
      head.end - head.start <= 40 &&
      deep.start > 19000 &&
      deep.startOffset <= 20000 * unit + filmstripLayout.FILMSTRIP_PADDING &&
      deep.startOffset + (deep.end - deep.start) * unit >= 20000 * unit + 600,
    `deep=[${deep.start},${deep.end}) head=[${head.start},${head.end})`,
  );
  // 对称余量：视口前后各多渲染的单元数都 ≥ MARGIN−1 且相差 ≤ 2（缺陷 0025 的
  // "向下预加载、向上不预加载"就是要防的方向性差异）。
  const scroll = 20000 * unit;
  const before = Math.floor((scroll - deep.startOffset) / unit);
  const afterCells = deep.end - deep.start - before - Math.ceil(600 / unit);
  check(
    "D146：窗口余量前后对称（各 ≥ MARGIN−1，相差 ≤ 2）",
    before >= filmstripLayout.FILMSTRIP_WINDOW_MARGIN - 1 &&
      afterCells >= filmstripLayout.FILMSTRIP_WINDOW_MARGIN - 1 &&
      Math.abs(before - afterCells) <= 2,
    `before=${before} after=${afterCells}`,
  );
  // 总长与起点偏移必须与逐项求和一致（含混合宽高比，经前缀索引修正）。
  const mixed = (i) => (i % 2 === 0 ? 2 : 0.5);
  const ids1000 = Array.from({ length: 1000 }, (_, i) => `mix${i}`);
  const idx1000 = new filmstripLayout.FilmstripDeltaIndex();
  idx1000.bindSequence(ids1000, size, false);
  for (let i = 0; i < 1000; i++) {
    filmstripLayout.setCachedFilmstripRatio(`mix${i}`, mixed(i));
    idx1000.update(`mix${i}`);
  }
  const delta1000 = (i) => idx1000.deltaBefore(i);
  const w = filmstripLayout.filmstripWindow(1000, 5000, 600, size, false, mixed, delta1000);
  let sum = filmstripLayout.FILMSTRIP_PADDING;
  for (let i = 0; i < 1000; i++) {
    sum += filmstripLayout.filmstripCellExtent(size, mixed(i), false) + filmstripLayout.FILMSTRIP_GAP;
  }
  const expectTotal = sum - filmstripLayout.FILMSTRIP_GAP + filmstripLayout.FILMSTRIP_PADDING;
  let expectStart = filmstripLayout.FILMSTRIP_PADDING;
  for (let i = 0; i < w.start; i++) {
    expectStart += filmstripLayout.filmstripCellExtent(size, mixed(i), false) + filmstripLayout.FILMSTRIP_GAP;
  }
  const empty = filmstripLayout.filmstripWindow(0, 0, 600, size, false, ratioAt);
  check(
    "D146：前缀索引修正后的总长/起点偏移与逐项求和逐值一致；空序列给空窗口",
    Math.abs(w.totalExtent - expectTotal) < 1e-6 &&
      Math.abs(w.startOffset - expectStart) < 1e-6 &&
      empty.start === 0 &&
      empty.end === 0 &&
      empty.totalExtent === 0,
    `total=${w.totalExtent} expect=${expectTotal}`,
  );
  // 居中定位：纯几何、不要求当前项已挂载（深处当前项不在 DOM 里也要能定位）。
  const center = filmstripLayout.filmstripCenterScroll(49999, 600, size, false, ratioAt);
  const expectCenter =
    filmstripLayout.FILMSTRIP_PADDING +
    49999 * unit +
    filmstripLayout.filmstripCellExtent(size, 1, false) / 2 -
    300;
  check(
    "D146：当前项居中按纯几何计算（第 5 万项不要求已挂载），与占位公式逐值一致",
    Math.abs(center - expectCenter) < 1e-9 && center > 0,
    `center=${center}`,
  );
  // 前缀索引增量更新与重建等价（写入后再 bind 一次，两者逐项一致）。
  idx1000.bindSequence(ids1000, size, false);
  const rebuilt = filmstripLayout.filmstripWindow(1000, 5000, 600, size, false, mixed, (i) => idx1000.deltaBefore(i));
  check(
    "D146：前缀索引增量更新与全量重建等价（换序列重建不漂移）",
    rebuilt.start === w.start &&
      Math.abs(rebuilt.totalExtent - w.totalExtent) < 1e-9 &&
      Math.abs(rebuilt.startOffset - w.startOffset) < 1e-9,
    `start=${rebuilt.start}/${w.start}`,
  );
  filmstripLayout.clearFilmstripRatioCache();
  // 比例兜底：非法值不塌成 0；平铺恒方形。
  check(
    "D146：占位比例兜底（0/负/NaN/Infinity → 1:1），平铺视图恒为方形",
    filmstripLayout.filmstripCellRatio("adaptive", 0) === 1 &&
    filmstripLayout.filmstripCellRatio("adaptive", -2) === 1 &&
    filmstripLayout.filmstripCellRatio("adaptive", Number.NaN) === 1 &&
    filmstripLayout.filmstripCellRatio("adaptive", Number.POSITIVE_INFINITY) === 1 &&
    filmstripLayout.filmstripCellRatio("adaptive", undefined) === 1 &&
    filmstripLayout.filmstripCellRatio("adaptive", 1.5) === 1.5 &&
    filmstripLayout.filmstripCellRatio("tile", 1.5) === 1,
  );
}

// ---- 宽高比共享缓存：写入通知 / 同值与非法不通知 / 退订不泄漏 ----
{
  filmstripLayout.clearFilmstripRatioCache();
  let notified = 0;
  const unsubscribe = filmstripLayout.subscribeFilmstripRatios(() => {
    notified += 1;
  });
  filmstripLayout.setCachedFilmstripRatio("fa", 1.5);
  filmstripLayout.setCachedFilmstripRatio("fa", 1.5); // 同值不通知
  filmstripLayout.setCachedFilmstripRatio("fa", 0); // 非法不通知
  filmstripLayout.setCachedFilmstripRatio("fb", 2);
  check(
    "D146：宽高比缓存写入即通知、同值/非法不通知、读回真值（单元卸载不丢）",
    notified === 2 &&
      filmstripLayout.getCachedFilmstripRatio("fa") === 1.5 &&
      filmstripLayout.getCachedFilmstripRatio("fb") === 2 &&
      filmstripLayout.getCachedFilmstripRatio("missing") === undefined,
    `通知=${notified}`,
  );
  unsubscribe();
  filmstripLayout.setCachedFilmstripRatio("fc", 3);
  check("D146：退订后不再收到通知（订阅表不泄漏）", notified === 2, `通知=${notified}`);
  filmstripLayout.clearFilmstripRatioCache();
}

// ---- 渲染侧接线与盒模型对账 ----
check(
  "D146：胶片栏消费有界窗口 + 绝对定位轨道，旧的只追加窗口与逐格观察器已删除",
  /filmstripWindow\(files\.length, scroll, viewport, crossExtent, vertical, ratioAt, deltaBefore\)/.test(filmstripSrc) &&
    /className="iv-film-track"/.test(filmstripSrc) &&
    /window_\.totalExtent/.test(filmstripSrc) &&
    /window_\.startOffset/.test(filmstripSrc) &&
    // 反向：不得复活"只追加不回收"（setEnd）与 IntersectionObserver 闸门。
    !/setEnd\(/.test(stripComments(filmstripSrc)) &&
    !/IntersectionObserver/.test(stripComments(filmstripSrc)) &&
    !/scrollIntoView/.test(stripComments(filmstripSrc)),
);
check(
  "D146：滚动与宽高比通知都按帧合并（rAF），居行走纯几何且不惊动祖先",
  /requestAnimationFrame/.test(filmstripSrc) &&
    /subscribeFilmstripRatios\(/.test(filmstripSrc) &&
    // 增量更新必须真的在跑（注释掉 = 索引与缓存漂移，断言剥注释后仍须命中）。
    /deltaRef\.current\.update\(fileId\)/.test(stripComments(filmstripSrc)) &&
    /filmstripCenterScroll\(index, viewport, crossExtent, vertical, ratioAt, deltaBefore\)/.test(filmstripSrc) &&
    /container\.scrollTop = Math\.max\(0, target\)/.test(filmstripSrc) &&
    /container\.scrollLeft = Math.max\(0, target\)/.test(filmstripSrc),
);
check(
  "D146：几何模块是无框架依赖的纯逻辑（无 React / Tauri / DOM 读取）",
  !/from "react"/.test(filmstripLayoutSrc) &&
    !/@tauri-apps/.test(filmstripLayoutSrc) &&
    !/document\./.test(stripComments(filmstripLayoutSrc)) &&
    !/querySelector/.test(stripComments(filmstripLayoutSrc)),
);
{
  // 盒模型常量 ↔ 样式表逐项对账（改 CSS 不改常量 = 单元错位/重叠，0018 P1-A
  // 第 6 轮瀑布流盒模型踩过的同款坑）。
  const filmBlock = /\.iv-film \{([\s\S]*?)\}/.exec(stylesSource)?.[1] ?? "";
  const cellBlock = /\.iv-film-cell \{([\s\S]*?)\}/.exec(stylesSource)?.[1] ?? "";
  const px = (block, prop) => {
    const m = new RegExp(`${prop}:\\s*(\\d+)px`).exec(block);
    return m ? Number(m[1]) : null;
  };
  const padding = px(filmBlock, "padding");
  const border = px(filmBlock, "border");
  const cellPadding = px(cellBlock, "padding");
  const cellBorder = px(cellBlock, "border");
  check(
    "D146：胶片栏盒模型常量与样式表一致（容器 padding/border、单元盒开销），轨道/单元定位齐全",
    padding === filmstripLayout.FILMSTRIP_PADDING &&
      border === filmstripLayout.FILMSTRIP_BORDER &&
      cellPadding !== null &&
      cellBorder !== null &&
      cellPadding * 2 + cellBorder * 2 === filmstripLayout.FILMSTRIP_CELL_CHROME &&
      /\.iv-film-track \{\s*position: relative;/.test(stylesSource) &&
      /position: absolute;/.test(cellBlock) &&
      /box-sizing: border-box;/.test(cellBlock),
    `padding=${padding} border=${border} chrome=${cellPadding}*2+${cellBorder}*2`,
  );
}
{
  // 信息栏如实提示：loading（后台翻页中）与 truncated（防御性停手）两个状态都接线，三语齐备。
  const zhCN = readFileSync(join(ROOT, "apps/desktop/src/app_ui/i18n/zh-CN.ts"), "utf8");
  const zhTW = readFileSync(join(ROOT, "apps/desktop/src/app_ui/i18n/zh-TW.ts"), "utf8");
  const en = readFileSync(join(ROOT, "apps/desktop/src/app_ui/i18n/en.ts"), "utf8");
  check(
    "D146：信息栏的 loading/truncated 提示三语齐备且面板真的接线（不假装是全部）",
    [zhCN, zhTW, en].every(
      (dict) =>
        dict.includes('"imageviewer.info.loading"') && dict.includes('"imageviewer.info.truncated"'),
    ) &&
    /loading=\{sequence\.loading\}/.test(imageViewerPanelSrc) &&
    /truncated=\{sequence\.truncated\}/.test(imageViewerPanelSrc) &&
    /\{loading && ` \$\{t\("imageviewer\.info\.loading"\)\}`\}/.test(viewerInfoBarSrc) &&
    /\{truncated && ` \$\{t\("imageviewer\.info\.truncated"\)\}`\}/.test(viewerInfoBarSrc),
  );
}

// ==================== 图像查看器：胶片栏自适应视图对齐原视图（缺陷 0041 / D147） ====================
//
// 防的是"公式对、浏览器不对"与"观感漂移"：D146 窗口化后几何从厚度设置推算
// "理想盒"，不知道经典占位滚动条会扣客户区、贴边规则会去掉一侧边框；且竖栏
// 主轴是高，恒乘宽高比把横竖图用反。观感基准 = 76e073a 原视图（flex stretch +
// border-box aspect-ratio）。真机量由 tools/filmstrip-layout-verify.mjs 承担
// （26 项，回退即红两个旋钮各自复现）；这里钉行为与接线。

// ---- 几何行为：外框比例 = 原视图的 aspect-ratio 语义 ----
{
  const cross = 100;
  const extent = filmstripLayout.filmstripCellExtent;
  check(
    "D147：横栏主轴 = 交叉轴外框 × r、竖栏 = ÷ r（76e073a 原视图 border-box aspect-ratio 语义）",
    extent(cross, 2, false) === 200 &&
      extent(cross, 0.5, false) === 50 &&
      extent(cross, 2, true) === 50 &&
      extent(cross, 0.5, true) === 200 &&
      extent(cross, 1, true) === extent(cross, 1, false),
    `横×2=${extent(cross, 2, false)} 竖×2=${extent(cross, 2, true)}`,
  );
  check(
    "D147：外框不塌（外框 < 单元盒开销时夹紧），非法比例/交叉轴回落不产生 NaN",
    extent(2, 1, false) === filmstripLayout.FILMSTRIP_CELL_CHROME &&
      extent(0, 1, false) === filmstripLayout.FILMSTRIP_CELL_CHROME &&
      extent(2, 5, false) === 10 &&
      extent(cross, 0, false) === cross &&
      extent(cross, Number.NaN, true) === cross &&
      extent(cross, Number.POSITIVE_INFINITY, false) === cross &&
      extent(Number.NaN, 2, false) === filmstripLayout.FILMSTRIP_CELL_CHROME,
  );
  // 竖栏混合比例的前缀索引：修正量按 ÷r 算（恒乘 r 即回 D146 缺陷形态）。
  const ids = ["v0", "v1", "v2"];
  filmstripLayout.clearFilmstripRatioCache();
  filmstripLayout.setCachedFilmstripRatio("v0", 2);
  filmstripLayout.setCachedFilmstripRatio("v1", 0.5);
  const vIdx = new filmstripLayout.FilmstripDeltaIndex();
  vIdx.bindSequence(ids, cross, true);
  const expectDelta2 =
    extent(cross, 2, true) - extent(cross, 1, true) + (extent(cross, 0.5, true) - extent(cross, 1, true));
  check(
    "D147：竖栏前缀修正按 ÷r 累计（换边重建不沿用横栏口径）",
    Math.abs(vIdx.deltaBefore(2) - expectDelta2) < 1e-9 && vIdx.deltaBefore(0) === 0,
    `deltaBefore(2)=${vIdx.deltaBefore(2)} expect=${expectDelta2}`,
  );
  filmstripLayout.clearFilmstripRatioCache();
  // 未测量占位：理想盒推算收敛在唯一函数，且与实测口径可区分。
  check(
    "D147：未测量占位 = 厚度 − padding×2 − border×2（filmstripCrossSizeFallback 唯一实现）",
    filmstripLayout.filmstripCrossSizeFallback(76) ===
      76 - filmstripLayout.FILMSTRIP_PADDING * 2 - filmstripLayout.FILMSTRIP_BORDER * 2 &&
      filmstripLayout.filmstripCrossSizeFallback(10) === 0,
  );
}

// ---- 组件接线：两轴实测、滚动双通道重读、几何消费实测值 ----
check(
  "D147：交叉轴从容器实测客户区推（滚动条/贴边边框天然算进去），size 只作未测量占位",
  /const \[crossClient, setCrossClient\] = useState\(0\)/.test(filmstripSrc) &&
    /crossClient - FILMSTRIP_PADDING \* 2/.test(stripComments(filmstripSrc)) &&
    /filmstripCrossSizeFallback\(size\)/.test(filmstripSrc) &&
    // 反向：不得再按厚度直接推交叉轴外尺寸（缺陷 0041 的形态）。
    !/size - FILMSTRIP_PADDING \* 2 - FILMSTRIP_BORDER \* 2/.test(stripComments(filmstripSrc)),
);
check(
  "D147：ResizeObserver 与 onScroll 双通道重读两轴（滚动条出没不保证触发 RO）",
  /const cross = vertical \? el\.clientWidth : el\.clientHeight/.test(filmstripSrc) &&
    /new ResizeObserver\(readContainer\)/.test(filmstripSrc) &&
    /setCrossClient\(\(prev\) => \(prev === cross \? prev : cross\)\)/.test(filmstripSrc) &&
    // onScroll 的 rAF 回调里必须真的重读（只断言符号名会被 effect 里的调用满足；
    // 剥注释后从 onScroll 定义起到依赖数组止的片段里找调用）。
    (() => {
      const stripped = stripComments(filmstripSrc);
      const start = stripped.indexOf("const onScroll = useCallback");
      const end = stripped.indexOf("[vertical, readContainer]", start);
      return start >= 0 && end > start && stripped.slice(start, end).includes("readContainer();");
    })(),
);
check(
  "D147：窗口/居中/单元尺寸全部消费实测 crossExtent 与 vertical（不再喂 size）",
  /filmstripWindow\(files\.length, scroll, viewport, crossExtent, vertical, ratioAt, deltaBefore\)/.test(filmstripSrc) &&
    /filmstripCenterScroll\(index, viewport, crossExtent, vertical, ratioAt, deltaBefore\)/.test(filmstripSrc) &&
    /filmstripCellExtent\(crossExtent, ratioAt\(i\), vertical\)/.test(filmstripSrc) &&
    /bindSequence\(/.test(filmstripSrc) &&
    // bindSequence 的第三参必须是 vertical（换边重建）。
    /crossExtent,\s*vertical,\s*\)/.test(filmstripSrc),
);
// ---- CSS：overflow 按主轴收窄（交叉轴按构造不溢出，双保险钉死不变量） ----
{
  const verticalBlock = /\.iv-film-left,\s*\.iv-film-right \{([\s\S]*?)\}/.exec(stylesSource)?.[1] ?? "";
  const horizontalBlock = /\.iv-film-horizontal \{([\s\S]*?)\}/.exec(stylesSource)?.[1] ?? "";
  check(
    "D147：胶片栏 overflow 按主轴收窄（竖栏 x-hidden/y-auto、横栏 x-auto/y-hidden），不出第二条滚动条",
    /overflow-x: hidden;/.test(verticalBlock) &&
      /overflow-y: auto;/.test(verticalBlock) &&
      /overflow-x: auto;/.test(horizontalBlock) &&
      /overflow-y: hidden;/.test(horizontalBlock),
  );
}
{
  // 真机验证脚本必须存在且量的是真实样式表（登记进工具清单，防"写了没接"）。
  const verifyPath = join(ROOT, "tools/filmstrip-layout-verify.mjs");
  const verifySrc = existsSync(verifyPath) ? readFileSync(verifyPath, "utf8") : "";
  check(
    "D147：真机布局验证脚本在位（真实 styles.css + 同构夹具 + 回退即红旋钮）",
    verifySrc.includes("apps/desktop/src/app_ui/shared/styles.css") &&
      verifySrc.includes("iv-film-track") &&
      verifySrc.includes("HP_FILM_CROSS_MODE") &&
      verifySrc.includes("HP_FILM_EXTENT_MODE"),
  );
}
{
  // D148：扩展真机验证（交互面）在位——覆盖 0018 真机验证此前没碰过的六个面：
  // 媒体预览翻页计数收敛 / 右键 / 相册 / 拖拽 / 查看器翻页 / 胶片栏窗口。
  // 它抓到的 0042（游标键名蛇形）证明了只有穿过**真实序列化**的检查才测得到这一环。
  const verifyPath = join(ROOT, "tools/real-interaction-verify.mjs");
  const verifySrc = existsSync(verifyPath) ? readFileSync(verifyPath, "utf8") : "";
  const covers = [
    "media.paging.drain",
    "contextmenu.open",
    "album.create",
    "drag.files-to-album",
    "viewer.keyboard-paging",
    "filmstrip.bounded-window",
  ];
  check(
    "D148：扩展真机验证脚本在位（翻页/右键/相册/拖拽/查看器/胶片栏 六面全覆盖）",
    verifySrc.length > 0 && covers.every((name) => verifySrc.includes(`"${name}"`)),
  );
  check(
    "D148：真机验证走真实 app + WebView2 CDP（零新增依赖，与 0018 第 6 轮同设施）",
    verifySrc.includes("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") &&
      verifySrc.includes("remote-debugging-port") &&
      verifySrc.includes("hamster-pouch-desktop.exe"),
  );
}

// ==================== 图像查看器：相邻图像预加载 ====================
//
// 防的是"预加载写了但没接上/接了却把内存吃光"：取哪些邻居由纯函数决定（按行为断言），
// 而"什么时候取、取到什么程度"由三条边界守住（前台才取 / 大图不解码 / 同张只预热一次）。

const preloadHookSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/useViewerPreload.ts"),
  "utf8",
);
// 显示 URL 的策略与缓存只在 `shared/mediaUrl.ts`（D208 把图像专用的 imageUrl 扩成通用入口）。
const mediaUrlSrc = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/mediaUrl.ts"), "utf8");
const urlCacheSrc = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/urlCache.ts"), "utf8");

check(
  "预加载取相邻项：以当前项为中心前后各 N 张，近的优先、同距离时向前优先",
  eqList(preload.preloadTargets(5, 20, 2), [6, 4, 7, 3]),
  `targets=${preload.preloadTargets(5, 20, 2).join(",")}`,
);
check(
  "预加载**越界不环绕**（与换图口径一致：到头就停，不绕回序列另一端）",
  eqList(preload.preloadTargets(0, 5, 2), [1, 2]) &&
    eqList(preload.preloadTargets(4, 5, 2), [3, 2]) &&
    eqList(preload.preloadTargets(1, 3, 3), [2, 0]),
);
check(
  "预加载半径 0 = **关闭**（不是「至少一张」）；当前项不在序列内时返回空",
  eqList(preload.preloadTargets(5, 20, 0), []) &&
    eqList(preload.preloadTargets(-1, 20, 2), []) &&
    eqList(preload.preloadTargets(0, 0, 2), []) &&
    eqList(preload.preloadTargets(20, 20, 2), []),
);
check(
  "预加载半径夹紧到 [0, 3]（上限的理由是内存：100 MP 解码后可达数百 MB）",
  preload.clampPreloadRadius(0) === 0 &&
    preload.clampPreloadRadius(-5) === 0 &&
    preload.clampPreloadRadius(99) === preload.PRELOAD_RADIUS_MAX &&
    preload.clampPreloadRadius(2.4) === 2 &&
    preload.clampPreloadRadius(Number.NaN) === preload.PRELOAD_RADIUS_FALLBACK &&
    preload.PRELOAD_RADIUS_MAX === 3,
);
check(
  "预加载半径的**声明缺省**落在面板夹紧范围内（与 filmstripSize 同一处置）",
  (() => {
    const decl = imageViewerSpec?.settings?.find((s) => s.key === "preloadRadius");
    return (
      decl?.kind === "numberInput" &&
      typeof decl?.default === "number" &&
      decl.default >= preload.PRELOAD_RADIUS_MIN &&
      decl.default <= preload.PRELOAD_RADIUS_MAX
    );
  })(),
  `kind=${imageViewerSpec?.settings?.find((s) => s.key === "preloadRadius")?.kind} ` +
    `default=${imageViewerSpec?.settings?.find((s) => s.key === "preloadRadius")?.default}`,
);
// 边界 1：面板不在前台就不预加载（dockview 会把后台标签留在 DOM 里）。
check(
  "预加载只在面板**前台**进行（判据只看 isVisible，见 shared/panelForeground.ts）",
  /usePanelForeground\(panelApi\)/.test(imageViewerPanelSrc) &&
    /enabled: foreground && Boolean\(repoId\)/.test(imageViewerPanelSrc) &&
    /if \(!enabled \|\| !repoId\)/.test(preloadHookSrc),
);
// 边界 2：大图只"解析 + 生成"，不"解码预热"（把解码位图留在内存里会吃光内存）。
check(
  "大图不参与**解码预热**（仍解析 URL 并触发后端生成，只是不用 new Image() 驻留位图）",
  /PRELOAD_DECODE_MAX_BYTES/.test(preloadHookSrc) &&
    /if \(file\.size > PRELOAD_DECODE_MAX_BYTES\) return;/.test(preloadHookSrc) &&
    /new Image\(\)/.test(preloadHookSrc) &&
    /image\.decoding = "async"/.test(preloadHookSrc),
);
// 边界 3：同一张只预热一次；换序列才重置。
check(
  "同一张只预热一次（换序列才重置记录），避免每次渲染重造 Image",
  /warmedRef\.current\.has\(file\.id\)/.test(preloadHookSrc) &&
    /warmedRef\.current\.add\(file\.id\)/.test(preloadHookSrc) &&
    /filesRef\.current !== files/.test(preloadHookSrc) &&
    /warmedRef\.current\.clear\(\)/.test(preloadHookSrc),
);
// 登记与预热必须**成对**：若"已登记"之后又因 effect 清理而放弃预热，那张图就永远
// 不会再试（登记表说它做过了）。这类缺陷没有任何外部症状，只能靠这条断言钉住。
check(
  "预热不因 effect 清理而丢弃（登记表说做过、就必须真的做，否则永不重试）",
  !/let cancelled = false;/.test(preloadHookSrc) &&
    !/if \(cancelled \|\| !url\) return;/.test(preloadHookSrc) &&
    /void resolveMediaUrl\(repoId, file\.id, file\.relative_path\)\.then\(\(url\) => \{\s*if \(!url\) return;/.test(
      preloadHookSrc,
    ),
);
// 预加载必须走与当前图**同一份** URL 缓存，否则 HEIC 会被生成两次。
check(
  "预加载与当前图共用同一份 URL 缓存与去重（否则 HEIC 全分辨率生成两次）",
  /resolveMediaUrl\(repoId, file\.id, file\.relative_path\)/.test(preloadHookSrc) &&
    /resolveMediaUrlOutcome\(repoId, file\.id, file\.relative_path\)/.test(imageViewerPanelSrc) &&
    // 缓存与在途去重的骨架只有一份（shared/urlCache.ts）。
    /const mediaUrls = createUrlResolver/.test(mediaUrlSrc) &&
    /const settled = new Map<string, T>\(\)/.test(urlCacheSrc) &&
    /const inflight = new Map<string, Promise<T>>\(\)/.test(urlCacheSrc) &&
    // HEIC/HEIF 复用 previewUrl 的缓存（两个入口命中同一份）。
    /resolvePreviewUrl\(repoId, fileId\)/.test(mediaUrlSrc) &&
    /needsPreview\(relativePath\)/.test(mediaUrlSrc),
);
check(
  "取图策略收敛到一处：面板不再自己写 needsPreview ? previewGet : filePath 分支",
  !/api\.previewGet\(/.test(imageViewerPanelSrc) &&
    !/api\.filePath\(/.test(imageViewerPanelSrc) &&
    !/convertFileSrc/.test(imageViewerPanelSrc),
);

// === 图片格式扩容的**跨语言一致性**（2026-10-11） ===
//
// 三个模块各持一份图片扩展名清单，**任一不一致都表现为静默的功能缺失**：
// - `hp-scanner/media_type.rs` 决定**入不入库**（漏项 → 扫描时直接跳过，用户看不到）；
// - `hp-media/decode.rs` 的 `FFMPEG_ONLY_IMAGE_EXTS` 决定**解不解得开**
//   （入库了但没进这张表 → 缩略图/查看器显示"不可用"）；
// - `app_ui/shared/previewUrl.ts` 的白名单决定**走原图还是走后端预览**
//   （该预览的格式走了原图 → Chromium 画不出，一片坏图）。
//
// 三者是**同一件事的三个切面**，靠人同步必然漂移，因此在这里逐项对账。
const scannerSrcForFormats = readFileSync(
  join(ROOT, "crates/hp-scanner/src/media_type.rs"),
  "utf8",
);
const decodeSrcForFormats = readFileSync(join(ROOT, "crates/hp-media/src/decode.rs"), "utf8");
const previewUrlSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/previewUrl.ts"),
  "utf8",
);

/** 从 Rust 源码里取某个 `const NAME: [&str; N] = [ ... ];` 的字符串字面量集合。 */
function rustStrArray(src, name) {
  const m = new RegExp(`const ${name}\\s*:[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(src);
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]));
}

/** 从 TS 源码里取某个 `const NAME = [ ... ];` 的字符串字面量集合。 */
function tsStrArray(src, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(src);
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]));
}

const ffmpegOnly = rustStrArray(decodeSrcForFormats, "FFMPEG_ONLY_IMAGE_EXTS");
const nativeRender = tsStrArray(previewUrlSrc, "NATIVE_RENDER_EXTS");
const scannerExts = (() => {
  const m = /fn ext_to_media_type[\s\S]*?=> Some\(MediaType::Image\)/.exec(scannerSrcForFormats);
  if (!m) return null;
  return new Set([...m[0].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]));
})();

check(
  "图片格式三份清单都能解析（scanner 扩展名表 / ffmpeg-only 表 / 前端原生渲染白名单）",
  scannerExts !== null &&
    ffmpegOnly !== null &&
    nativeRender !== null &&
    scannerExts.size > 30 &&
    ffmpegOnly.size === 17 &&
    nativeRender.size === 11,
  `scanner=${scannerExts?.size} ffmpegOnly=${ffmpegOnly?.size} native=${nativeRender?.size}`,
);

// 正向：ffmpeg-only 的每个扩展名都必须**同时**在扫描器扩展名表里。
// 只进 decode 表不进 scanner 表 = 解码能力白做（文件根本不入库）。
check(
  "ffmpeg-only 表 ⊆ 扫描器图片扩展名表（否则解码能力白做：文件不入库）",
  ffmpegOnly !== null &&
    scannerExts !== null &&
    [...ffmpegOnly].every((e) => scannerExts.has(e)),
  `差集=${[...(ffmpegOnly ?? [])].filter((e) => !(scannerExts ?? new Set()).has(e)).join(",")}`,
);

// 反向：**进程内能解**的格式不得出现在 ffmpeg-only 表里。
// 划错了会改变既有行为（坏文件从"报错"变成"被 ffmpeg 抢救成功"），
// 并让扫描期 dHash / 调色板缓存不再与旧实现可比。
const IN_PROCESS_CAPABLE = [
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "avif", "heic", "heif",
  "ico", "svg", "svgz", "tga", "dds", "exr", "hdr", "qoi", "ff", "pnm", "pam", "ppm", "pgm", "pbm",
];
check(
  "进程内可解的格式不得进 ffmpeg-only 表（否则坏文件会被 ffmpeg 抢救、缓存口径变更）",
  ffmpegOnly !== null && IN_PROCESS_CAPABLE.every((e) => !ffmpegOnly.has(e)),
  `误收=${IN_PROCESS_CAPABLE.filter((e) => (ffmpegOnly ?? new Set()).has(e)).join(",")}`,
);

// 前端白名单与 scanner 表**不得重叠**：白名单里的格式必须都是扫描器认得的图片。
check(
  "前端原生渲染白名单 ⊆ 扫描器图片扩展名表",
  nativeRender !== null &&
    scannerExts !== null &&
    [...nativeRender].every((e) => scannerExts.has(e)),
  `差集=${[...(nativeRender ?? [])].filter((e) => !(scannerExts ?? new Set()).has(e)).join(",")}`,
);

// 前端取反口径必须真的取反：漏一个 `!` 就会把"Chromium 画不了"当成"能画"。
check(
  "needsPreview 是白名单取反（失败方向 = 多一次后端转码，而不是画坏图）",
  /return\s+!NATIVE_RENDER_EXTS\.includes\(/.test(previewUrlSrc) &&
    // 没有扩展名也当"需要预览"（新格式/无后缀默认安全侧）。
    /if \(dot < 0\) return true;/.test(previewUrlSrc),
);

// `needsPreview` 只回答"Chromium 画不了这张图"，对视频/音频无意义：
// `preview.get` 对非图片返回 null，拿它判视频会把能播的视频变成"不可用"。
check(
  "查看器把媒体类型交给共享模块判定（否则视频/音频会被误送去 preview.get）",
  (() => {
    const viewerPanelSrc = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/ViewerPanel.tsx"),
      "utf8",
    );
    return (
      /resolveMediaUrlOutcome\(/.test(viewerPanelSrc) &&
      // 四个参数：仓库、文件、相对路径、媒体类型——最后一个是「图片才看 needsPreview」的判据。
      /selected\.media_type,\s*\)/.test(viewerPanelSrc) &&
      // 面板自己不再写 needsPreview? previewGet : filePath 这类分支。
      !/api\.previewGet\(/.test(viewerPanelSrc) &&
      !/api\.filePath\(/.test(viewerPanelSrc) &&
      !/convertFileSrc/.test(viewerPanelSrc)
    );
  })(),
);

// ==================== SVG / SVGZ 的跨语言对账（D112，2026-10-16） ====================
//
// SVG 与前几档**都不同**：它是**矢量**，ffmpeg 对它**有解复用器（`svg_pipe`）、
// 没有解码器**——这正是 D111 记下的假阳性反例。因此三条不变量都必须钉住，
// 且**每一条破了都是静默失效**（没有报错、只是功能没了或白耗）：
// - 误收进 ffmpeg-only 表 → 每个 SVG 都白起一个**必然失败**的子进程；
// - 漏出扫描器扩展名表 → 文件根本不入库；
// - `svgz` 混进前端原生渲染白名单 → 查看器画**一片空白**（gzip 流不是 XML）。
// 外加依赖侧：`resvg` 必须仍是**纯 Rust + 不开系统字体**（D20 的"不把用户环境
// 变成运行期前提"，与 D110 不引 pdfium 同一条判据）。
const svgSrcForFormats = readFileSync(join(ROOT, "crates/hp-media/src/svg.rs"), "utf8");
const thumbnailSrcForFormats = readFileSync(
  join(ROOT, "crates/hp-media/src/thumbnail.rs"),
  "utf8",
);
const hpMediaCargoSrc = readFileSync(join(ROOT, "crates/hp-media/Cargo.toml"), "utf8");
const svgExts = rustStrArray(svgSrcForFormats, "SVG_EXTS");

check(
  "Rust：SVG / SVGZ 在扫描器扩展名表（入库）且**不在** ffmpeg-only 表（ffmpeg 对它无解码器）",
  svgExts !== null &&
    svgExts.size === 2 &&
    scannerExts !== null &&
    [...svgExts].every((e) => scannerExts.has(e)) &&
    ffmpegOnly !== null &&
    [...svgExts].every((e) => !ffmpegOnly.has(e)),
  `svgExts=${[...(svgExts ?? [])].join(",")} 未入库=${[...(svgExts ?? [])]
    .filter((e) => !(scannerExts ?? new Set()).has(e))
    .join(",")} 误收=${[...(svgExts ?? [])]
    .filter((e) => (ffmpegOnly ?? new Set()).has(e))
    .join(",")}`,
);

check(
  "前端：`svg` 进原生渲染白名单、`svgz` 刻意不进（gzip 流 Chromium 画不出来，必须走 preview.get）",
  nativeRender !== null && nativeRender.has("svg") && !nativeRender.has("svgz"),
  `svg=${nativeRender?.has("svg")} svgz=${nativeRender?.has("svgz")}`,
);

// 顺序不变量：生产 `preview.get` 传的 ffmpeg **恒为 Some**（随包分发），
// 所以"svg 分流"必须在 ffmpeg 快路径**之前**——反了就是 SVGZ 一片空白。
check(
  "Rust：`generate_image_preview` 的 SVG 分流在 ffmpeg 快路径**之前**（顺序反了 = SVGZ 一片空白）",
  (() => {
    const at = thumbnailSrcForFormats.indexOf("pub fn generate_image_preview(");
    if (at < 0) return false;
    const body = thumbnailSrcForFormats.slice(at, at + 800);
    const svgAt = body.indexOf("crate::svg::is_svg(src)");
    const ffAt = body.indexOf("generate_preview_via_ffmpeg(src, output_jpg, bin, timeout)");
    return svgAt >= 0 && ffAt >= 0 && svgAt < ffAt;
  })(),
);

check(
  "依赖：SVG 栅格化是纯 Rust 且**不开** system-fonts / memmap-fonts（D20：不把用户字体目录变成运行期前提）",
  /resvg\s*=\s*\{[^}]*default-features\s*=\s*false/.test(hpMediaCargoSrc) &&
    /resvg\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"svgz"/.test(hpMediaCargoSrc) &&
    !/resvg\s*=\s*\{[^}]*"system-fonts"/.test(hpMediaCargoSrc) &&
    !/resvg\s*=\s*\{[^}]*"memmap-fonts"/.test(hpMediaCargoSrc),
);

// 封面自选图片：后端 `COVER_IMAGE_EXTS` 是**存得下**的格式，对话框是**够得着**的格式。
// 两者不一致就是"能力有、用户够不着"（`svg` 正是这样漏掉的，见 D112）。
// 注意方向：后端**按 magic bytes 归一**扩展名（`.jpeg` 内容存成 `jpg`），
// 所以对话框多一个 `jpeg` 是对的，不算不对称。
const coverMenuSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/bookpreview/BookCoverMenu.tsx"),
  "utf8",
);
const coverStoreExts = rustStrArray(BOOK_BRIDGE_SRC, "COVER_IMAGE_EXTS");
const coverFilterExts = (() => {
  const m = /extensions:\s*\[([^\]]*)\]/.exec(coverMenuSrc);
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]));
})();
check(
  "封面：对话框能挑到后端**存得下**的每一种格式（含 `svg`），且 `jpeg` 也在（`.jpeg` 文件很常见，后端按 magic bytes 归一成 `jpg`）",
  coverFilterExts !== null &&
    coverStoreExts !== null &&
    coverStoreExts.size > 0 &&
    [...coverStoreExts].every((e) => coverFilterExts.has(e)) &&
    // `jpg` 有两个常见后缀：少了 `jpeg`，用户就挑不到 `.jpeg` 文件。
    (!coverStoreExts.has("jpg") || coverFilterExts.has("jpeg")),
  `后端=${[...(coverStoreExts ?? [])].join(
    ",",
  )} 对话框=${[...(coverFilterExts ?? [])].join(",")} 缺=${[
    ...(coverStoreExts ?? []),
    ...((coverStoreExts ?? new Set()).has("jpg") ? ["jpeg"] : []),
  ]
    .filter((e) => !(coverFilterExts ?? new Set()).has(e))
    .join(",")}`,
);

check(
  "预加载纯逻辑模块无 React / Tauri 依赖（门禁可直接 import）",
  !/from "react"/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPreload.ts"),
      "utf8",
    ),
  ) && !/@tauri-apps/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPreload.ts"),
      "utf8",
    ),
  ),
);
// 面板消费该设置（声明 ↔ 消费闭环，与 filmstripSize 同款）。
check(
  "面板真的消费预加载半径设置（读设置 → 传进钩子）",
  /radius: settings\.preloadRadius/.test(imageViewerPanelSrc) &&
    /preloadRadius: clampPreloadRadius\(declaredDefault\("preloadRadius", 1\)\)/.test(viewerSettingsSrc) &&
    /preloadRadius:/.test(viewerSettingsSrc),
);

// ==================== 图像查看器：换图首帧的视图变换 ====================
//
// 防的是"切换瞬间的拉伸"（缺陷 0026）。机制（已确证，见该记录的证据行）：
// 新图解码完成（`<img onLoad>` → `setNatural`）与"重新适应窗口"（**被动** `useEffect`）
// 分属两个提交——`onLoad` 那一提交**先被浏览器绘制**，effect 才把变换改回来。因此若变换与
// "它属于哪张图"没有绑定，新图就会被先画成**上一张**的缩放与平移，下一帧才跳到「适应窗口」。
// 极值对照：从 6000×4000 切到 400×300 时先按 0.13 倍画、下一帧跳到 2.5 倍（反之亦然），
// 用户看到的就是切换瞬间的一次拉伸/跳变。
//
// 修复口径：**判据必须在渲染路径上**（`resolveViewTransform`），不能靠 effect 事后纠正
// ——换 `useLayoutEffect` 只是把窗口压小，仍依赖"onLoad → 绘制"的时序约定。

const viewerZoom = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts")).href
);
const zoomStage = { width: 800, height: 600 };
const zoomBig = { width: 6000, height: 4000 };
const zoomSmall = { width: 400, height: 300 };
/** 上一张的"极端"变换：放大过、也平移过（任何沿用都会一眼看出来）。 */
const zoomStale = { zoom: 3, offset: { x: 120, y: -80 } };

check(
  "换图首帧：变换记录**不属于**当前图像时取「适应窗口」（不沿用上一张的缩放/平移）",
  (() => {
    const t = viewerZoom.resolveViewTransform(
      "asset://old.jpg",
      "asset://new.jpg",
      zoomStale,
      zoomSmall,
      zoomStage,
    );
    return (
      t.zoom === viewerZoom.fitZoom(zoomSmall, zoomStage) && t.offset.x === 0 && t.offset.y === 0
    );
  })(),
  (() => {
    const t = viewerZoom.resolveViewTransform(
      "asset://old.jpg",
      "asset://new.jpg",
      zoomStale,
      zoomSmall,
      zoomStage,
    );
    return `zoom=${t.zoom} offset=${t.offset.x},${t.offset.y}`;
  })(),
);
check(
  "换图首帧的取值与上一张**完全无关**（同一张新图，无论上一张多离谱都得到同一个变换）",
  (() => {
    const crazy = { zoom: 32, offset: { x: 9999, y: -9999 } };
    const a = viewerZoom.resolveViewTransform("asset://old.jpg", "asset://new.jpg", zoomStale, zoomBig, zoomStage);
    const b = viewerZoom.resolveViewTransform("asset://old.jpg", "asset://new.jpg", crazy, zoomBig, zoomStage);
    const c = viewerZoom.resolveViewTransform("", "asset://new.jpg", zoomStale, zoomBig, zoomStage);
    return a.zoom === b.zoom && a.zoom === c.zoom && viewerZoom.fitZoom(zoomBig, zoomStage) === a.zoom;
  })(),
);
check(
  "同一张图内（记录属于当前图像）**保留**用户的缩放与平移（渲染路径不得把它当换图清掉）",
  (() => {
    const t = viewerZoom.resolveViewTransform(
      "asset://a.jpg",
      "asset://a.jpg",
      zoomStale,
      zoomBig,
      zoomStage,
    );
    return t.zoom === zoomStale.zoom && t.offset.x === 120 && t.offset.y === -80;
  })(),
);
check(
  "「适应窗口」= contain + 居中（平移清零）；尺寸不可用时退化为恒等（此时舞台无可见区域）",
  (() => {
    const fitted = viewerZoom.fitTransform(zoomBig, zoomStage);
    return (
      fitted.zoom === viewerZoom.fitZoom(zoomBig, zoomStage) &&
      fitted.offset.x === 0 &&
      fitted.offset.y === 0 &&
      viewerZoom.fitTransform(null, zoomStage) === viewerZoom.IDENTITY_TRANSFORM &&
      viewerZoom.fitTransform(zoomBig, { width: 0, height: 0 }) === viewerZoom.IDENTITY_TRANSFORM
    );
  })(),
);
// 正向锚点：面板必须把"这份变换属于哪张图"交给纯函数，并在**写入时**记下 token。
// 反向锚点：不得再出现"无主的" `useState<ViewTransform>` + 裸 `setTransform(` ——那正是
// 缺陷 0026 的形态（一个视图变换变量 + 事后 effect 纠正 → 换图首帧必然沿用上一张）。
check(
  "面板把「变换属于哪张图」交给纯函数（渲染路径判定 + 写入时记账），不再有无主的视图变换状态",
  /const transform = resolveViewTransform\(\s*owned\.token,\s*token,\s*owned\.transform,\s*natural,\s*viewport,?\s*\)/.test(
    imageViewerPanelSrc,
  ) &&
    /useState<OwnedTransform>\(\{ token: "", transform: IDENTITY_TRANSFORM \}\)/.test(
      imageViewerPanelSrc,
    ) &&
    /const token = url;/.test(imageViewerPanelSrc) &&
    /setOwned\(\{ token, transform: next \}\)/.test(imageViewerPanelSrc) &&
    // 舞台拿到的必须是**渲染路径算出的**变换，而不是某个状态变量直传。
    /transform=\{transform\}/.test(imageViewerPanelSrc) &&
    !/useState<ViewTransform>/.test(stripComments(imageViewerPanelSrc)) &&
    !/setTransform\(/.test(stripComments(imageViewerPanelSrc)),
);
// 换图后的"重新适应窗口"只由纯函数给值一次（渲染路径），effect 不得再兼任——否则
// 又回到"先画一帧旧的、再由 effect 纠正"。
check(
  "换图不靠 effect 事后纠正：适应窗口的取值只在纯函数里给，effect 只负责落账与改尺寸重适应",
  /commitTransform\(fitTransform\(natural, viewport\)\)/.test(imageViewerPanelSrc) &&
    /const transformRef = useRef\(transform\);/.test(imageViewerPanelSrc) &&
    !/fitZoom\(natural, viewport\)/.test(stripComments(imageViewerPanelSrc)),
);
check(
  "缩放几何纯逻辑模块无 React / Tauri 依赖（门禁可直接 import）",
  !/from "react"/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts"),
      "utf8",
    ),
  ) && !/@tauri-apps/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts"),
      "utf8",
    ),
  ),
);
// 相对更新（滚轮 / 导航器 / 1:1）必须走**函数式**写法，且基准先经纯函数归一化：
// ① 滚轮这类**连续事件**在 React 18+ 里会被批处理，若先读渲染当帧的 `transform` 再写入，
//    同一帧内的第二次事件会读到同一份旧值——中间那一步被丢掉（按步累加的 `prev` 形式不会）；
// ② 基准若不经归一化，换图后就会拿上一张的缩放当基准（与首帧毛病同源，只是发生在更新侧）。
check(
  "相对更新走函数式写法（连续事件不被批处理吞掉），且基准先归一化到当前图像",
  /setOwned\(\(prev\) => \(\{/.test(imageViewerPanelSrc) &&
    /resolveViewTransform\(prev\.token, token, prev\.transform, natural, baseViewport\)/.test(
      imageViewerPanelSrc,
    ) &&
    /updateTransform\(\(base\) => zoomAround\(base, base\.zoom \* factor, natural, size, anchor\), size\)/.test(
      imageViewerPanelSrc,
    ) &&
    /updateTransform\(\(base\) => zoomAround\(base, 1, natural, viewport, centerAnchor\(viewport\)\)\)/.test(
      imageViewerPanelSrc,
    ) &&
    /updateTransform\(\(base\) => centerOn\(base, natural, viewport, u, v\)\)/.test(
      imageViewerPanelSrc,
    ) &&
    // 反向锚点：不得把**渲染当帧**的 `transform` 当基准（批处理下会丢步、换图后会串图）。
    !/zoomAround\(transform,/.test(stripComments(imageViewerPanelSrc)) &&
    !/centerOn\(transform,/.test(stripComments(imageViewerPanelSrc)),
);

// 换图必须是**原子替换**：URL 与"这张图的尺寸"同批提交（缺陷 0028）。
//
// 用户报的现象（原文）："下一张图片大小为上一张的，然后复原为原比例，然后图像闪烁或抖动一次"。
// 这要求某一帧里同时成立"已经是新 URL"+"尺寸/几何还是上一张的"——即换图被拆成了两次提交。
// 修法：把"正在显示的图"收敛成**一个状态对象**（url + natural + fileId），并**先解码后替换**：
// 解码回来时尺寸已知，于是 url 与尺寸一次提交；换图只发生一帧，而那一帧里位图已就绪、几何已知。
const stageSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ViewerStage.tsx"),
  "utf8",
);
const decodeSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerDecode.ts"),
  "utf8",
);
check(
  "换图是原子替换：url + 尺寸 + 文件 id（+ LOD0 档）同一个状态对象，渲染两值都取自它",
  /useState<ShownImage \| null>\(null\)/.test(imageViewerPanelSrc) &&
    /setShown\(\{ url: nextUrl, natural: size, fileId, lowResUrl \}\)/.test(imageViewerPanelSrc) &&
    /const url = shown\?\.url \?\? "";/.test(imageViewerPanelSrc) &&
    /const natural = shown\?\.natural \?\? null;/.test(imageViewerPanelSrc) &&
    // 反向锚点：不得再出现"先换 URL、尺寸另一次提交"的老写法（那正是"半新半旧"帧的来源）。
    !/setUrl\(/.test(stripComments(imageViewerPanelSrc)) &&
    !/setNatural\(/.test(stripComments(imageViewerPanelSrc)),
);
check(
  "换图**先解码后替换**：解码完成才把 url 与尺寸一起换（换图只发生一帧，且位图已就绪）",
  /await decodeImageSize\(nextUrl\)/.test(imageViewerPanelSrc) &&
    /if \(wantRef\.current !== fileId\) return;/.test(imageViewerPanelSrc) &&
    /await showImage\(outcome\.url, file\.id\)/.test(imageViewerPanelSrc) &&
    // 兜底（预览）也必须走同一条"解码后替换"的路，不得自己 setShown。
    /await showImage\(previewUrl, current\.id\)/.test(imageViewerPanelSrc),
);
check(
  "换图不再提前清空画面：解码期间上一张继续显示（没有「载入中」闪烁/空白帧）",
  // 选中项变化时**不**清空 `shown`（只有"没有可显示的图"和失败才清）。
  !/wantRef\.current = file\.id;\s*\n\s*setShown\(null\);/.test(imageViewerPanelSrc) &&
    /if \(!repoId \|\| !file \|\| file\.media_type !== "image"\) \{[\s\S]{0,120}?setShown\(null\);/.test(
      imageViewerPanelSrc,
    ),
);
// 绘制元素搬进表面层之后（RFC 0013 §10），这条不变量的**位置**变了，判据本身不变：
// 舞台只提供宿主节点，每张图必须由 `surfaceDom` 现建一个 `<img>`（`decoding="sync"`），
// 新节点就绪后才摘旧节点。复用同一个元素换 `src` 会把旧图层的光栅拉成新尺寸（缺陷 0028 的形态）。
const domSurfaceSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/render/surfaceDom.ts"),
  "utf8",
);
check(
  "舞台不再自己持有 <img>；表面层每张图现建一个元素 + `decoding=\"sync\"`（复用元素会把旧图层的光栅拉成新尺寸）",
  // 舞台把绘制节点交给表面（宿主 div），不得再有 <img>。
  !/<img\b/.test(stripComments(stageSrc)) &&
    /document\.createElement\("img"\)/.test(domSurfaceSrc) &&
    /el\.decoding = "sync"/.test(domSurfaceSrc) &&
    /el\.className = "iv-image"/.test(domSurfaceSrc) &&
    // 反向锚点：不得对**旧**节点重新赋 src（只允许给新建的 `el` 赋）。
    !/previous\.src =/.test(domSurfaceSrc) &&
    !/node\.src =/.test(domSurfaceSrc) &&
    // 新节点就位后才摘旧节点：中间没有空舞台帧。
    /const previous = node;/.test(domSurfaceSrc) &&
    /detach\(previous\);/.test(domSurfaceSrc),
);
check(
  "解码模块是 DOM 工具（不得变成组件/纯函数混装）：无 React 依赖，且只导出 `decodeImageSize`",
  !/from "react"/.test(decodeSrc) &&
    !/@tauri-apps/.test(decodeSrc) &&
    /export async function decodeImageSize\(/.test(decodeSrc),
);

// 「待解码」兜底几何必须与「适应窗口」同口径（缺陷 0027）。
//
// 断言的是**两处实现同一个公式**：`viewerZoom.fitZoom` 是 `min(舞台/图)`，而
// `.iv-image-pending` 用 `width/height: 100%` + `object-fit: contain`（CSS 的 contain
// **含放大**）。旧写法 `max-width/max-height: 100%` 只会缩小、**永不放大**，于是"宽高都小于
// 舞台的图"在解码完成那一帧先按原尺寸画、下一帧才被放大——实测 400×300 的图在 800×600 舞台里
// 先画 400×300、再跳到 800×600（**50% 偏差**，一帧即用户报的"一瞬间拉伸"）。
// 大图两帧恰好相同，所以这个缺陷**只在小图上可见**（这也是它此前没被当成"换图"缺陷的原因）。

/** 取某条 CSS 规则的声明块正文（选择器只出现一次时用它做断言）。 */
function cssRuleBody(source, selector) {
  const at = source.indexOf(`\n${selector} {`);
  if (at < 0) return null;
  const start = source.indexOf("{", at);
  const end = source.indexOf("}", start);
  return start < 0 || end < 0 ? null : source.slice(start + 1, end);
}

const pendingRule = cssRuleBody(stylesSource, ".iv-image-pending");
check(
  "「待解码」兜底用 CSS 的 contain（含放大）：宽度/高度吃满舞台 + `object-fit: contain`",
  Boolean(pendingRule) &&
    /width:\s*100%/.test(pendingRule) &&
    /height:\s*100%/.test(pendingRule) &&
    /object-fit:\s*contain/.test(pendingRule) &&
    // 居中由 object-position（默认 50% 50%）负责，不再靠 transform 偏移。
    /left:\s*0/.test(pendingRule) &&
    /top:\s*0/.test(pendingRule) &&
    /transform:\s*none/.test(pendingRule),
);
check(
  "**不得**再退回 `max-width/max-height: 100%`（那两条只缩小、不放大 → 小图会先按原尺寸画一帧）",
  Boolean(pendingRule) &&
    !/max-width/.test(pendingRule) &&
    !/max-height/.test(pendingRule),
);
check(
  "「待解码」兜底几何 ↔ `fitZoom` 同一公式（含**放大**与缩小、宽扁与高瘦四组夹具）",
  [
    [{ width: 400, height: 300 }, { width: 800, height: 600 }], // 小图：必须被放大
    [{ width: 6000, height: 4000 }, { width: 800, height: 600 }], // 大图：缩小
    [{ width: 1200, height: 400 }, { width: 800, height: 600 }], // 宽扁
    [{ width: 200, height: 2000 }, { width: 800, height: 600 }], // 高瘦
  ].every(([natural, vp]) => {
    // CSS `object-fit: contain` 的等比缩放因子
    const contain = Math.min(vp.width / natural.width, vp.height / natural.height);
    return Math.abs(viewerZoom.fitZoom(natural, vp) - contain) < 1e-9;
  }),
);

check(
  "宿主项与面板项共用同一份归一化内核与订阅内核（只在 config/settingValue.ts 与 shared/settingValue.ts 各一份）",
  /normalizeDeclaredValue/.test(
    readFileSync(join(ROOT, "packages/config/src/panels.ts"), "utf8"),
  ) &&
    /normalizeDeclaredValue/.test(
      readFileSync(join(ROOT, "packages/config/src/settings.ts"), "utf8"),
    ) &&
    /useStoredSetting/.test(settingValueSrc) &&
    /useHostSettingValue/.test(settingValueSrc) &&
    /usePanelSettingValue/.test(settingValueSrc),
);

}
