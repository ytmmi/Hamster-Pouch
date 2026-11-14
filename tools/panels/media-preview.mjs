/**
 * 面板门禁分节 · 媒体预览：缺省视图 / 排序 / 翻页 / 虚拟化（原第 5 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList, stripComments } from "./harness.mjs";
import {
  FILE_BRIDGE_SRC, MEDIA_FAMILY_FILES, ROOT, config, fileAt, format, masonry,
  mediaPaging, mediaSortStore, mediaView, optionValues, pageStub, registrySource,
  scroll, stylesSource,
} from "./shared.mjs";
export default async function run() {
// ============ 媒体预览（`panel.media`）：缺省视图 / 排序 设置 + 面板消费 ============
//
// 与查看器 / 色彩参考同一套闭环：**声明**（注册表）↔ **取值域**（声明候选 ↔ 面板纯函数
// 逐项一致）↔ **归一化**（非法取值回落缺省）↔ **面板消费**（真的按设置排布与排序）↔
// **热加载**（共享钩子的四条触发源 + `viewer`/`color` 同款的 dockview 面板 API）。
//
// 另加两条本面板特有的口径：
// 1. 面板右上角的下拉是**本会话内**的临时覆盖（模块级变量），设置里的值才是缺省；
//    用户在「全部设置」里改动该项时必须**放弃**覆盖，否则就是"改了设置没反应"；
// 2. 排序下拉是「四个排序键 + 横线 + 正序/倒序」，横线由 `menu-sep` 画（不是两个下拉）。

const mediaPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx"),
  "utf8",
);
// 单元与下拉各自成文件（单文件 1200 行上限）：断言跟着代码走，不看它原来在哪。
const mediaCellSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewCell.tsx"),
  "utf8",
);
// 宽高比缓存的**本体**（D206 起与图像查看器的胶片栏共用一份，断言跟着代码走）。
const ratioCacheSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/ratioCache.ts"),
  "utf8",
);
const mediaDropdownSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewDropdown.tsx"),
  "utf8",
);
// 视图几何的**纯函数**（宽高比辅助、列分配）：缺陷 0043 阶段 3 起这里多两条
// ——`indexedRatio`（索引尺寸 → 比例）与 `resolveRatio`（缓存优先、索引兜底）。
const mediaViewSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewView.ts"),
  "utf8",
);
// 媒体预览面板家族（2026-09 第四轮按 1200 行规则再拆）：主面板 / 取值域 / 会话状态 /
// 工具条 / 文件动作 / 右键菜单 / 选区 / 单元 / 下拉。**断言跟着代码走**：
// 凡「面板真的消费 / 真的渲染」这类断言读**整个家族**；反向断言同样读整个家族——
// 拆分不得成为逃离断言的后门（同上一条的既有口径）。
const mediaFamilySrc = MEDIA_FAMILY_FILES.map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");
const mediaToolbarSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewToolbar.tsx"),
  "utf8",
);
// 后台冻结的判据（共享钩子）：面板不可见时不该继续干活。
const panelForegroundSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/panelForeground.ts"),
  "utf8",
);
// 恒定引用回调（共享钩子）：两个面板的单元 `memo` 都靠它生效（2026-10 从
// MediaPreviewPanel 抽到 shared/，图书预览接入右键菜单时一并复用）。
const stableCallbackSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/stableCallback.ts"),
  "utf8",
);
// 波形图的纯几何（2026-10-17 / D115）：**行为断言**直接跑真函数——
// 游标与"点哪儿跳到哪儿"互为逆运算这件事，只有按取值断言才守得住（正则守不住）。
const waveView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/waveformView.ts")).href
);

// ---- 缺陷 0018 P1-A：**全库游标翻页**的纯逻辑（`mediaPreviewPaging.ts`）----
//
// 取数上限从"有界的一页"放开为"整个来源"之后，**循环安全**的来源变了：
// 旧实现靠 `MEDIA_PREVIEW_MAX_ITEMS` 兜底，现在那个上限正是要取消的东西，
// 于是只能靠"游标必须严格前进 + 页数上限"保证一个写坏的 `nextCursor` 不会变成死循环。
// 这些用例是**行为断言**（直接跑真函数），不是源码正则——正则守不住死循环。

{
  const three = pageStub([
    { items: [fileAt(1), fileAt(2)], nextCursor: "c1" },
    { items: [fileAt(3)], nextCursor: "c2" },
    { items: [fileAt(4)], nextCursor: null },
  ]);
  const drained = await mediaPaging.drainPages(three.fetchPage);
  check(
    "翻页取完**整个来源**：首游标为 `null`，其后一律回传上一页的 `nextCursor`，`null` 即末页",
    three.calls.length === 3 &&
      JSON.stringify(three.calls) === JSON.stringify([null, "c1", "c2"]) &&
      drained.map((f) => f.id).join(",") === "f1,f2,f3,f4",
    `调用=${JSON.stringify(three.calls)} 条目=${drained.map((f) => f.id).join(",")}`,
  );
}

{
  const single = pageStub([{ items: [fileAt(1)], nextCursor: null }]);
  const drained = await mediaPaging.drainPages(single.fetchPage);
  check(
    "只有一页时不发第二次请求（`nextCursor === null` 即停）",
    single.calls.length === 1 && drained.length === 1,
    `调用=${single.calls.length}`,
  );
}

{
  // 后端若把游标写坏（永远回同一个非 null 值），旧式 `while (cursor)` 会永远翻下去。
  const looped = pageStub([
    { items: [fileAt(1)], nextCursor: "same" },
    { items: [fileAt(2)], nextCursor: "same" },
    { items: [fileAt(3)], nextCursor: "same" },
  ]);
  const result = await mediaPaging.drainPages(looped.fetchPage);
  check(
    "游标**不前进**（后端写坏）时立即停止，不退化成死循环",
    looped.calls.length === 2 && result.length === 2,
    `调用=${looped.calls.length} 条目=${result.length}`,
  );
}

{
  const dup = pageStub([
    { items: [fileAt(1), fileAt(2)], nextCursor: "c1" },
    { items: [fileAt(2), fileAt(3)], nextCursor: null },
  ]);
  const result = await mediaPaging.drainPages(dup.fetchPage);
  check(
    "跨页重复 id 去重且保持首次出现的顺序（库内容在翻页途中变动时不得出现重复单元）",
    result.map((f) => f.id).join(",") === "f1,f2,f3",
    `条目=${result.map((f) => f.id).join(",")}`,
  );
}

{
  const pages = pageStub([
    { items: [fileAt(1)], nextCursor: "c1" },
    { items: [fileAt(2)], nextCursor: null },
  ]);
  let stop = false;
  const result = await mediaPaging.drainPages(pages.fetchPage, {
    isCancelled: () => stop,
    onPage: () => {
      stop = true;
    },
  });
  check(
    "翻页途中取消：**不再多发请求**（全库翻页可能上百次往返，卸载/切换来源后必须立刻停）",
    pages.calls.length === 1 && result.length === 1,
    `取消后调用=${pages.calls.length}`,
  );
}

{
  const progressive = pageStub([
    { items: [fileAt(1), fileAt(2)], nextCursor: "c1" },
    { items: [fileAt(3)], nextCursor: "c2" },
    { items: [fileAt(4)], nextCursor: null },
  ]);
  const seen = [];
  await mediaPaging.drainPages(progressive.fetchPage, {
    onPage: (_added, accumulated) => seen.push(accumulated.length),
  });
  check(
    "首屏**第一页到手即回调**（不是等全部翻完才出图），且累计数单调增长",
    JSON.stringify(seen) === JSON.stringify([2, 3, 4]),
    `每页累计=${JSON.stringify(seen)}`,
  );
}

check(
  "取数上限已放开为**整个来源**：不再有 `MEDIA_PREVIEW_MAX_ITEMS` 截断，页大小仍是 500",
  !/MEDIA_PREVIEW_MAX_ITEMS/.test(mediaFamilySrc) &&
    mediaPaging.MEDIA_PREVIEW_PAGE_LIMIT === 500 &&
    /drainPages/.test(mediaFamilySrc),
);

check(
  "面板取数只依赖「看的是哪个来源」，**不依赖 `app` 整个对象**",
  // `app` 上下文对象在每次选中变化时都会换身份（`selectedIds` / `selectedFile` 是
  // `AppUiApp` 那个 `useMemo` 的依赖项）。若取数依赖它，用户每点一下缩略图都会重跑
  // 整个取数——在"翻完全库"的语义下就是每次点击重发上百次游标请求。
  /\[repoId, albumId, sourceId, dirPath, typeFilter, refreshKey\]/.test(mediaFamilySrc) &&
    !/\}, \[app, typeFilter\]\)/.test(mediaFamilySrc),
);

// 类型筛选：**媒体预览永不请求文本类**（用户口径 2026-10-08「媒体预览不包含 text 类型，
// text 类型在图书预览显示」，D95）。防的是"「全部」= 不筛"这个看似无害的写法：
// 文本类自 2026-10 起已进索引，不筛就会让它漏进媒体预览（以无缩略图的条目出现）。
check(
  "媒体预览的类型筛选档位与请求集合：**「全部」= 图片/视频/音频三个**，任何档位都不含 text",
  eqList([...mediaView.MEDIA_TYPE_FILTERS], ["all", "image", "video", "audio"]) &&
    Object.values(mediaView.MEDIA_FILTER_TYPES).every((types) => !types.includes("text")) &&
    eqList(mediaView.mediaTypesForFilter("all"), ["image", "video", "audio"]) &&
    eqList(mediaView.mediaTypesForFilter("image"), ["image"]) &&
    eqList(mediaView.mediaTypesForFilter("video"), ["video"]) &&
    eqList(mediaView.mediaTypesForFilter("audio"), ["audio"]) &&
    // 正向锚点：取数把**档位映射成集合**交给 `file.query`（不是把档位当单值直传，
    // 也不是留空表示"不筛"——留空就会把文本类放进来）。
    /mediaTypes:\s*mediaTypesForFilter\(typeFilter\)/.test(mediaFamilySrc),
);
check(
  "类型筛选的选项由取值域生成（手写四个 `<option>` 时，加档位忘了加选项不会被发现）",
  /MEDIA_TYPE_FILTERS\.map\(/.test(mediaToolbarSrc) && !/<option value="all"/.test(mediaToolbarSrc),
);

check(
  "后台翻页的**进度刷新只做首屏一次**（每次 `setFiles` 都会让前端全量排序重跑）",
  // 实测：5 万项名称排序约 281 ms（`localeCompare`）。若每页刷一次，5 万张（100 页）
  // 期间累计重排约 100 次、单线程阻塞十余秒；"每 10 页刷一次"仍有约 10 次递增的全量
  // 重排。中间过程对用户没有价值（首屏已出图、计数另有 `loading` 提示），
  // 因此只在第一页刷一次。
  /let firstPageRendered = false;/.test(mediaFamilySrc) &&
    /if \(firstPageRendered\) return;/.test(mediaFamilySrc) &&
    // 反向：不得再出现"每 N 页刷一次"那种按页数取模的节流。
    !/pageCount % \d+ !== 0/.test(mediaFamilySrc),
);

// ---- 缺陷 0018 P1-A：**虚拟化的行模型**（`mediaPreviewVirtual.ts`）----
//
// 容器虚拟化要先把条目切成"行"，行模型错了会直接表现为"丢项/重复/空白行"。
// 这些是**行为断言**（直接跑真函数）。
const virtual = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewVirtual.ts")).href
);

{
  const rows = virtual.chunkRows([1, 2, 3, 4, 5, 6, 7], 3);
  check(
    "按行切分：保序、不丢项、不重复，最后一行可以不满",
    JSON.stringify(rows) === JSON.stringify([[1, 2, 3], [4, 5, 6], [7]]),
    JSON.stringify(rows),
  );
}
check(
  "按行切分的边界：空列表得空数组，`perRow <= 0` 按 1 处理（否则切出无穷多空行）",
  virtual.chunkRows([], 3).length === 0 &&
    JSON.stringify(virtual.chunkRows([1, 2], 0)) === JSON.stringify([[1], [2]]) &&
    JSON.stringify(virtual.chunkRows([1, 2], -5)) === JSON.stringify([[1], [2]]),
);

// ---- 缺陷 0046：**缩略图自适应分辨率**（放大不糊 / 按档缓存 / 大图回退原图）----
//
// 三条会**静默**失败的路：
//   ① 前端把"这一格排版需要多大"算错 → 请求偏小，图被浏览器放大（就是 0046 的现象）；
//   ② 前端与后端的档梯不一致 → 同一张图按两档各生成一次，缓存条目白翻一倍；
//   ③ 请求没带尺寸、或缓存键不带档 → 改了「图片宽度」仍显示第一档的糊图。
// 因此这里跑**真函数**做行为断言（`thumbPixelSize` / `thumbBucket`），
// 并把两端的档梯与可解码白名单**逐项对齐**（各写一套就是 ② 的来源）。
const thumbSize = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/thumbSize.ts")).href
);

check(
  "档梯吸附：向上取档（宁可多一档也不放大糊图）、上限 1280、非法值归首档",
  thumbSize.THUMB_DIM_LADDER.join(",") === "320,480,640,960,1280" &&
    thumbSize.THUMB_DIM_BASE === 320 &&
    thumbSize.thumbBucket(0) === 320 &&
    thumbSize.thumbBucket(Number.NaN) === 320 &&
    thumbSize.thumbBucket(320) === 320 &&
    thumbSize.thumbBucket(321) === 480 &&
    thumbSize.thumbBucket(480) === 480 &&
    thumbSize.thumbBucket(800) === 960 &&
    thumbSize.thumbBucket(960) === 960 &&
    thumbSize.thumbBucket(961) === 1280 &&
    thumbSize.thumbBucket(50_000) === 1280,
  `ladder=${thumbSize.THUMB_DIM_LADDER.join(",")} 800→${thumbSize.thumbBucket(800)}`,
);

check(
  "缓存键分档：同一 fileId 的不同档必须是不同条目（否则换档后永远显示第一档）",
  thumbSize.thumbCacheKey("f1", 320) !== thumbSize.thumbCacheKey("f1", 960) &&
    thumbSize.thumbCacheKey("f1", 320) === "f1@320",
);

check(
  "每视图的长边需求：平铺按 cover 取宽高较大者、自适应按行高 2× 封顶、瀑布流按列宽×比例、DPR 封顶 2",
  (() => {
    const t = virtual.thumbPixelSize;
    return (
      // 平铺是正方形 + `object-fit: cover`：横图 2:1 要按宽度那一侧取，竖图同理。
      t("tile", 160, 2, 1) === 320 &&
      t("tile", 160, 0.5, 1) === 320 &&
      t("tile", 160, 1, 1) === 160 &&
      // 自适应是 contain + 行高上限 2×：3:1 的横图只需 2×（不是 3×）。
      t("adaptive", 160, 3, 1) === 320 &&
      t("adaptive", 160, 0.5, 1) === 160 &&
      // 瀑布流：列宽固定，竖图的高度才是长边。
      t("masonry", 160, 0.5, 1) === 320 &&
      t("masonry", 160, 3, 1) === 160 &&
      // DPR 乘上去并向上取整；封顶 2（再高对肉眼无收益，缓存却是 4× 面积）。
      t("masonry", 160, 0.5, 2) === 640 &&
      t("masonry", 160, 0.5, 3) === 640 &&
      t("masonry", 160, 0.5, 0) === 320 &&
      t("masonry", 161, 0.5, 1) === 322
    );
  })(),
  `tile2=${virtual.thumbPixelSize("tile", 160, 2, 1)} adaptive3=${virtual.thumbPixelSize("adaptive", 160, 3, 1)} dpr3=${virtual.thumbPixelSize("masonry", 160, 0.5, 3)}`,
);

check(
  "档梯两端同源：Rust `IMAGE_THUMB_DIM_LADDER` ↔ 前端 `THUMB_DIM_LADDER`；320 档沿用旧缓存名 `<hash>.webp`",
  (() => {
    const thumbRs = readFileSync(join(ROOT, "crates/hp-media/src/thumbnail/image_pipeline.rs"), "utf8");
    const cacheRs = readFileSync(join(ROOT, "crates/hp-media/src/cache.rs"), "utf8");
    const base = /pub const IMAGE_THUMB_MAX_DIM: u32 = (\d+);/.exec(thumbRs);
    const ladder = /pub const IMAGE_THUMB_DIM_LADDER: &\[u32\] = &\[([^\]]+)\];/.exec(thumbRs);
    if (!base || !ladder) return false;
    // 首项写的是 `IMAGE_THUMB_MAX_DIM` 常量（不是字面量），先展开再逐项比。
    const dims = ladder[1]
      .replace(/IMAGE_THUMB_MAX_DIM/g, base[1])
      .match(/\d+/g)
      ?.map(Number);
    return (
      base[1] === "320" &&
      dims?.join(",") === thumbSize.THUMB_DIM_LADDER.join(",") &&
      /pub const IMAGE_THUMB_MAX_LADDER_DIM: u32 = 1280;/.test(thumbRs) &&
      // 首档 == 旧名、其余带 `@<dim>`：升级不该让既有缓存整体作废。
      /if dim <= IMAGE_THUMB_MAX_DIM \{/.test(cacheRs) &&
      /format!\("\{content_hash\}@\{dim\}\.webp"\)/.test(cacheRs)
    );
  })(),
);

check(
  "可解码白名单两端同源：后端 `NATIVE_RENDER_EXTS` ↔ 前端 `previewUrl.ts`（回退原图的前提）",
  (() => {
    const listOf = (text, head) => {
      const m = new RegExp(`${head}[^\\[]*\\[([^\\]]*)\\]`).exec(text);
      return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : null;
    };
    const rust = listOf(
      FILE_BRIDGE_SRC,
      "NATIVE_RENDER_EXTS: &\\[&str\\] = &",
    );
    const ts = listOf(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/previewUrl.ts"), "utf8"),
      "NATIVE_RENDER_EXTS = ",
    );
    return rust !== null && ts !== null && rust.join(",") === ts.join(",");
  })(),
);

// ---- 缺陷 0018 P1-A 回归：**滚动位置恢复 vs 后台翻页**（`mediaPreviewScroll.ts`）----
//
// P1-A 把取数从"一次取回有界一页"改成"后台翻页翻完全库"之后，恢复滚动的**时机**
// 与内容的**长度**不再同步：第一页到手时内容只有 500 行高，深位置会被浏览器夹住。
// 更隐蔽的是，这次"夹住"会触发 `scroll` 事件，监听器把夹住的中间值当成新目标记下来
// → 原始目标永久丢失，后面内容变长也恢复不回去。
//
// 这些是**行为断言**（直接跑真函数、按真实时序模拟"翻页→再翻页→用户滚动"），
// 不是源码正则：正则守不住"目标被中间值覆盖"这类时序缺陷。

{
  // 模拟：5 万张、每行 100px 行高，用户在 3 万行处（target = 3000000）离开。
  // 第一页 500 项到手 → 内容 50000px、视口 800px → 最多滚到 49200，目标到不了。
  const slot = scroll.createScrollSlot();
  slot.target = 3_000_000;
  const firstApply = scroll.planScrollApply(slot, 50_000, 800, false);
  const pendingAfterFirst = slot.pending;

  // 浏览器把 scrollTop 夹到上限，并因此触发一次 scroll 事件。
  scroll.onScrollEvent(slot, 49_200, 50_000, 800);
  const targetAfterClamp = slot.target;

  // 后台翻完（内容 5,000,000px）后再恢复一次。
  const finalApply = scroll.planScrollApply(slot, 5_000_000, 800, true);

  check(
    "后台翻页下的滚动恢复：被夹住的中间值**不得**覆盖真实目标，翻完后再恢复到位",
    // 第一页时确实到不了（这正是回归的触发条件）。
    firstApply === 3_000_000 &&
      pendingAfterFirst === 3_000_000 &&
      // 关键：夹住所触发的那次 scroll 事件**没有**把目标改成 49200。
      targetAfterClamp === 3_000_000 &&
      // 内容变长后一次到位，且不再欠恢复。
      finalApply === 3_000_000 &&
      slot.pending === null,
    `首次=${firstApply} 夹住后target=${targetAfterClamp} 最终=${finalApply} pending=${slot.pending}`,
  );
}

check(
  "滚动恢复的退化输入：目标 0 / 非法值不欠恢复；**容器未布局**时必须挂住而不是抹掉目标",
  // 目标 0：没有要恢复的位置。
  scroll.needsScrollRestore(0, 50_000, 800) === false &&
    // NaN / 负数按 0 处理。
    scroll.needsScrollRestore(Number.NaN, 50_000, 800) === false &&
    scroll.needsScrollRestore(-5, 50_000, 800) === false &&
    // 正例：内容装得下就不欠恢复；装不下就欠。
    scroll.needsScrollRestore(1_000, 50_000, 800) === false &&
    scroll.needsScrollRestore(60_000, 50_000, 800) === true &&
    // **首帧**（scrollHeight = 0）是"还没量出来"，不是"内容只有 0 高"：
    // 必须挂住 pending，否则那次赋值触发的 scroll 事件会把目标抹成 0。
    scroll.needsScrollRestore(1_000, 0, 0) === true &&
    (() => {
      const slot = scroll.createScrollSlot();
      slot.target = 1_000;
      // 首帧：loading 还是 false（取数 effect 尚未把它置真），也不能收敛成 0。
      const applied = scroll.planScrollApply(slot, 0, 0, true);
      return applied === 1_000 && slot.pending === 1_000 && slot.target === 1_000;
    })(),
);

check(
  "翻页已结束而目标仍到不了时：就地收敛到可滚上限并**解除** pending",
  // 否则 pending 会永久挂着，用户之后的所有滚动都记不进 target（新的"恢复不了"）。
  (() => {
    const slot = scroll.createScrollSlot();
    slot.target = 3_000_000;
    const applied = scroll.planScrollApply(slot, 50_000, 800, true);
    // 条目被删到只剩 500 项：收敛到上限 49200，并解除 pending。
    return applied === 49_200 && slot.pending === null && slot.target === 49_200;
  })(),
);

check(
  "用户主动滚动（不欠恢复时）必须正常记录，否则浏览进度会丢",
  (() => {
    const slot = scroll.createScrollSlot();
    // 已到位、无 pending：用户滚到 1200 就该记住 1200。
    scroll.onScrollEvent(slot, 1_200, 50_000, 800);
    const normal = slot.target === 1_200 && slot.pending === null;

    // 还欠恢复、但内容已经装得下 → 这一跳就是恢复落地，按目标收口并解除。
    const slot2 = scroll.createScrollSlot();
    slot2.target = 3_000_000;
    slot2.pending = 3_000_000;
    scroll.onScrollEvent(slot2, 3_000_000, 5_000_000, 800);
    const landed = slot2.target === 3_000_000 && slot2.pending === null;

    return normal && landed;
  })(),
);

check(
  "面板真的接了这套恢复逻辑：存的是 slot 而不是裸数字，依赖数组含内容长度与 loading",
  // 缺陷 0018 回归的**接线**断言：纯函数对了但面板没接，等于没修。
  /const thumbScroll = createScrollSlot\(\);/.test(mediaPanelSrc) &&
    /const nameScroll = createScrollSlot\(\);/.test(mediaPanelSrc) &&
    // **两个**容器都必须走 planScrollApply——只要求"文件里出现过"会让"改了一个、
    // 漏了另一个"照样通过（实测：只回退平铺那个，断言仍全绿）。
    (mediaPanelSrc.match(/el\.scrollTop = planScrollApply\(/g) ?? []).length === 2 &&
    (mediaPanelSrc.match(/onScrollEvent\(/g) ?? []).length === 2 &&
    // 不得再退回"直接赋保存值"的写法（那正是被夹住的来源）。
    !/el\.scrollTop = thumbScroll\.target/.test(mediaPanelSrc) &&
    !/el\.scrollTop = nameScroll\.target/.test(mediaPanelSrc) &&
    // 依赖数组必须含内容长度与 loading：否则内容变长后不再重试，深位置恢复不回去。
    /\}, \[viewMode, view, foreground, app\.repoId, items\.length, loading\]\);/.test(mediaPanelSrc) &&
    /\}, \[viewMode, foreground, app\.repoId, items\.length, loading\]\);/.test(mediaPanelSrc),
);

{
  // 行高必须是**有限正数**：分数高度会让「行号 × 行高」与浏览器实际布局逐渐错位，
  // 滚到列表深处表现为"越滚越偏"。
  const tileName = virtual.tileRowHeight(160, true);
  const tileNoName = virtual.tileRowHeight(160, false);
  const list = virtual.listRowHeight();
  check(
    "行高由纯函数给出且为整数：平铺（缩略图方形 + 可选文件名）与列表",
    Number.isInteger(tileName) &&
      Number.isInteger(tileNoName) &&
      Number.isInteger(list) &&
      tileName > tileNoName &&
      tileName > 160 &&
      list > 0,
    `平铺(有名)=${tileName} 平铺(无名)=${tileNoName} 列表=${list}`,
  );
}
check(
  "行高与样式表的口径一致：平铺内边距 4px + 边框 1px（box-sizing: border-box）",
  /box-sizing:\s*border-box/.test(stylesSource) &&
    /\.mp-cell\s*\{[^}]*padding:\s*4px/.test(stylesSource) &&
    /\.mp-cell\s*\{[^}]*border:\s*1px solid transparent/.test(stylesSource) &&
    /\.mp-grid\.mp-view-tile \.mp-thumb\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/.test(stylesSource),
);

check(
  "平铺与列表**按行虚拟化**：只渲染窗口内的行，DOM 单元数与条目总数无关",
  // 缺陷 0018 的核心：容器不再 `items.map`，而是"占位层撑起总高度 + 只渲染窗口行"。
  // 平铺的行高按媒体类型分项（`tileRowHeights`）逐行算，因此走**变量行高**虚拟化。
  /const tileVirtual = useVariableRowVirtualizer\(/.test(mediaPanelSrc) &&
    /const listVirtual = useMeasuredRowVirtualizer\(/.test(mediaPanelSrc) &&
    /tileVirtual\.rows\.map\(/.test(mediaPanelSrc) &&
    /listVirtual\.rows\.map\(/.test(mediaPanelSrc) &&
    /className="mp-virtual" style=\{\{ height: tileVirtual\.totalSize \}\}/.test(mediaPanelSrc) &&
    /className="mp-virtual" style=\{\{ height: listVirtual\.totalSize \}\}/.test(mediaPanelSrc) &&
    // 列表视图**不得**再直接铺全部条目：退回全量渲染必须当场变红。
    // （平铺/自适应走 `renderCell` 那条路，见下面那条断言；自适应见 `content-visibility` 的说明。）
    !/\{items\.map\(\(\{ file \}\) => \(/.test(mediaPanelSrc),
);

check(
  "平铺行高按媒体类型**逐行**算：同一行混着「显示 / 不显示文件名」时取该行最大值",
  // 三个分项开关让行高不再是常量。若仍按单一布尔算一个常量行高，
  // CSS 网格的自然行高（该行最高的单元）与虚拟化预测就会差一个文件名行，
  // 表现为行错位 / 底部留白。
  /const tileRowHeights = useMemo\(/.test(mediaPanelSrc) &&
    /tileRows\.map\(\(row\) =>/.test(mediaPanelSrc) &&
    /Math\.max\(/.test(mediaPanelSrc) &&
    /tileRowHeight\(imageSize, showFileNameFor\(file\.media_type\)\)/.test(mediaPanelSrc) &&
    // 平铺的虚拟化吃的是逐行行高数组，不是常量。
    /useVariableRowVirtualizer\(\s*gridRef,\s*view === "tile" && viewMode === "thumb" \? tileRowHeights : \[\]/.test(
      mediaPanelSrc,
    ),
);

check(
  "列表视图的行高走**测量**而不是猜死（文字度量随语言/系统缩放变化）",
  /useMeasuredRowVirtualizer\(\s*listRef,/.test(mediaPanelSrc) &&
    /ref=\{listVirtual\.measureRef\}/.test(mediaPanelSrc) &&
    /listRowHeight\(\)/.test(mediaPanelSrc) &&
    // **`data-index` 是测量生效的前提**：库靠它把 DOM 节点反查回行号
    // （`indexFromElement` 读的就是这个属性）。少了它 → 返回 -1 →
    // `isIndexInRange(-1)` 为假 → 测量被**整条跳过**，行高永远停在首帧估计值，
    // 而且只在控制台打一句 warning。这是实测确认过的坑，必须钉住。
    /data-index=\{row\.index\}/.test(mediaPanelSrc) &&
    // 挂 `measureRef` 的元素与 `data-index` 必须在**同一个** DOM 节点上：
    // 库是"对回调传入的那个 node"读属性的，挂错层级同样读不到。
    // （窗口放宽到 900 字符：两者之间夹着上面那段说明注释。）
    /ref=\{listVirtual\.measureRef\}[\s\S]{0,900}?data-index=\{row\.index\}/.test(mediaPanelSrc),
);

check(
  "平铺虚拟化的**列数**与 CSS 同源：面板算好下发 `--mp-tile-columns`，切行用同一个值",
  // 不一致会表现为"行错位/留白"——CSS 排 4 列而 JS 按 3 列切行时尤其明显。
  /const tilePerRow = masonryColumnCount\(gridWidth, imageSize, MASONRY_GAP\);/.test(
    mediaPanelSrc,
  ) &&
    /chunkRows\(items, tilePerRow\)/.test(mediaPanelSrc) &&
    /"--mp-tile-columns": String\(Math\.max\(1, masonryColumns\)\)/.test(mediaPanelSrc) &&
    /repeat\(var\(--mp-tile-columns/.test(stylesSource),
);

check(
  "虚拟化容器的总高度由占位层给出（滚动条长度不随滚动变化，因此不会抖）",
  /\.mp-virtual\s*\{[^}]*position:\s*relative/.test(stylesSource) &&
    /\.mp-virtual-row\.mp-virtual-grid\s*\{[^}]*position:\s*absolute/.test(stylesSource) &&
    /\.mp-virtual-row\.mp-virtual-list\s*\{[^}]*position:\s*absolute/.test(stylesSource) &&
    // 行间距只在**一处**加：行盒高度里不含 gap（虚拟化下发 gap），CSS 若再加一次会翻倍。
    /MEDIA_TILE_ROW_GAP/.test(mediaFamilySrc) &&
    /MEDIA_LIST_ROW_GAP/.test(mediaFamilySrc) &&
    !/\.mp-virtual-row\.mp-virtual-grid\s*\{[^}]*row-gap/.test(stylesSource) &&
    !/\.mp-list\s*\{[^}]*gap:\s*2px/.test(stylesSource),
);

check(
  "跳过渲染（`content-visibility`）在自适应/瀑布流**打开**，占位高度按视图算得接近真实",
  // 原先这两个视图靠 `content-visibility: visible` 回避"占位高度写错导致的滚动抖动"。
  // 根因是占位值错（写死 140px），不是跳过渲染不可用——面板按视图下发接近真实的值。
  /content-visibility:\s*auto/.test(stylesSource) &&
    !/\.mp-view-adaptive \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    !/\.mp-masonry \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    // 单元真的把面板算出的值下发到块轴占位（内联覆盖样式表的简写块轴分量），
    // 且带 `auto` 关键字（渲染过就用记下的真实尺寸）。
    /containIntrinsicBlockSize:\s*`auto \$\{intrinsicHeight\}px`/.test(mediaCellSrc) &&
    /intrinsicHeight=\{cellIntrinsicHeight\(file\)\}/.test(mediaPanelSrc) &&
    // 自适应按图片尺寸估；瀑布流按**该文件**的宽高比算。
    // 文件名行的高度按该条目的媒体类型判定（`showName` 是 `showFileNameFor(file.media_type)`）。
    /adaptiveCellIntrinsicHeight\(imageSize, showName\)/.test(mediaPanelSrc) &&
    /masonryCellHeight\(imageSize, ratio, showName\)/.test(mediaPanelSrc) &&
    /const showName = showFileNameFor\(file\.media_type\);/.test(mediaPanelSrc) &&
    // 宽高比取自 `resolveRatio`：解码后量到的优先，其次索引里的 `files.width/height`
    //（缺陷 0043 阶段 3——首帧即按真实比例估高，不再从 1:1 跳一次）。
    /resolveRatio\(file, getCachedRatio\(file\.id\)\)/.test(mediaPanelSrc) &&
    /export function indexedRatio\(/.test(mediaViewSrc) &&
    /export function resolveRatio\(/.test(mediaViewSrc),
);

check(
  "瀑布流单元高度的**盒模型与样式表一致**（实测反推：28 + (列宽−12)/宽高比）",
  // 原先按"内边距 4+4、边框 1+1、缩略图 (列宽−10)/比例、文件名 16px"估算，
  // 实测**全错**：按列虚拟化（绝对定位）之后，高度猜错不再表现为错位、而是
  // **相邻单元重叠**——实测 minGap = −18px（应为 8px）。
  // 真实盒模型（列宽 160、border-box）：
  //   thumbW = 160 − 8(内边距) − 2(单元边框) = 150
  //   imgW   = 150 − 2(缩略图边框) = 148
  //   单元高 = 10 + (148/比例 + 2) + 4 + 12(文件名实际行高) = 28 + 148/比例
  // 该式对 5 个实测样本的误差 ≤ 0.05px。
  (() => {
    const at = (col, ratio) => virtual.masonryCellHeight(col, ratio, true);
    // 列宽 160、比例 1 → 28 + 148 = 176（实测 176.0）。
    if (at(160, 1) !== 176) return false;
    // 比例 1.78 → 28 + 83.1 = 111（实测 111.1）。
    if (Math.abs(at(160, 1.78) - 111) > 1) return false;
    // 比例 0.562 → 28 + 263.3 = 291（实测 291.4）。
    if (Math.abs(at(160, 0.562) - 291) > 1) return false;
    // 无文件名时只少 16px（4 gap + 12 行高）。
    if (virtual.masonryCellHeight(160, 1, false) !== 160) return false;
    return true;
  })(),
  `方=${virtual.masonryCellHeight(160, 1, true)} 宽=${virtual.masonryCellHeight(160, 1.78, true)} 竖=${virtual.masonryCellHeight(160, 0.562, true)} 无名=${virtual.masonryCellHeight(160, 1, false)}`,
);

check(
  "瀑布流**按列虚拟化**：只渲染窗口内的条目，列高由面板下发",
  // 与平铺/列表同一条不变量：DOM 单元数与条目总数脱钩。
  /masonryColumnLayout\(columns,/.test(mediaPanelSrc) &&
    /masonryVisibleRange\(/.test(mediaPanelSrc) &&
    /useScrollWindow\(gridRef, gridVersion\)/.test(mediaPanelSrc) &&
    // 列内必须**按窗口切片**渲染，不得 `column.map` 全量铺开。
    // （只断言"没有 column.map(({file,url})…"会被 `column.map((item, i)…` 绕过——
    //   实测：把 slice 退回全量 map，那条断言照样全绿。这里直接钉住切片本身。）
    /column\.slice\(start, range\.end\)\.map\(/.test(mediaPanelSrc) &&
    !/column\.map\(/.test(mediaPanelSrc) &&
    // 列高必须由面板给出：虚拟化后列内只有几十个单元，不给高度容器总高会塌掉。
    /style=\{\{ height: masonry\.columnHeights\[index\] \?\? 0 \}\}/.test(mediaPanelSrc) &&
    // 槽位用绝对定位 + 面板算出的偏移（不参与列内布局，避免累积误差）。
    /className="mp-masonry-slot"/.test(mediaPanelSrc) &&
    /transform: `translateY\(\$\{offsets\[at\] \?\? 0\}px\)`/.test(mediaPanelSrc),
);

check(
  "瀑布流的**宽高比异步到达**必须触发重算：ratioCache 有版本号 + 面板订阅",
  // 宽高比是 `<img>` 解码后才知道的，而行高由它推出。不重算的话列偏移停在
  // DEFAULT_CELL_RATIO 的估计上，与单元实际高度错位（这是本视图最容易踩的坑）。
  /export function getRatioCacheVersion\(\)/.test(mediaCellSrc) &&
    /export function subscribeRatioChange\(/.test(mediaCellSrc) &&
    /export function setRatioCache\(/.test(mediaCellSrc) &&
    // 缓存本体只有一份（D206）：单元文件不得再自建 Map，写入 / 版本号 / 通知都在
    // 共享模块里，胶片栏读的就是这一份（否则同一张图两个面板各量一次）。
    !/new Map<string, number>\(\)/.test(mediaCellSrc) &&
    /const ratios = new Map<string, number>\(\);/.test(ratioCacheSrc) &&
    /export function setCachedRatio\(/.test(ratioCacheSrc) &&
    // 通知必须**合并**：一次滚动会解码几十张，5 万张的库会解码上万张，
    // 每次写入都通知就是上万次 O(条目数) 的布局重算。
    /queueMicrotask\(/.test(mediaCellSrc) &&
    /if \(ratioNotifyScheduled\) return;/.test(mediaCellSrc) &&
    /subscribeRatioChange\(\(\) => setRatioVersion\(getRatioCacheVersion\(\)\)\)/.test(
      mediaPanelSrc,
    ) &&
    // 版本号与文件名开关（按媒体类型分项）都进布局依赖数组。
    /\[columns, imageSize, showFileNameFor, view, viewMode, ratioVersion\]/.test(mediaPanelSrc),
);

check(
  "瀑布流列内间距**只在面板算的偏移里**加一次（列内不得再有 flex gap）",
  // 面板的 `masonryColumnLayout` 已经把 gap 加进偏移；列内再叠一层 flex gap
  // 会让偏移与实际位置差一个 gap（错位）。
  /\.mp-masonry-slot\s*\{[^}]*position:\s*absolute/.test(stylesSource) &&
    /\.mp-masonry-slot\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    !/\.mp-masonry-col\s*\{[^}]*gap:/.test(stylesSource),
);

check(
  "瀑布流单元高度按**宽高比**算（列宽 ÷ 宽高比），且退化输入有兜底",
  (() => {
    const square = virtual.masonryCellHeight(160, 1, false);
    const wide = virtual.masonryCellHeight(160, 2, false);
    const tall = virtual.masonryCellHeight(160, 0.5, false);
    return (
      Number.isInteger(square) &&
      // 宽图矮、竖图高（单调性：这是"瀑布流"与整齐网格的区别）。
      wide < square &&
      square < tall &&
      // 退化宽高比（0 / 负数 / NaN）按 1:1 兜底，不得算出 NaN 或负高度。
      virtual.masonryCellHeight(160, 0, false) === square &&
      virtual.masonryCellHeight(160, -2, false) === square &&
      virtual.masonryCellHeight(160, Number.NaN, false) === square
    );
  })(),
  `方=${virtual.masonryCellHeight(160, 1, false)} 宽=${virtual.masonryCellHeight(160, 2, false)} 竖=${virtual.masonryCellHeight(160, 0.5, false)}`,
);

check(
  "缩略图**挂载即预热**：不再有「等进入视口」的闸门（用户 2026-10-07：向上不预加载）",
  // 三种视图都已虚拟化，"被挂载" ⟺ "在虚拟化窗口内"（窗口以 scrollTop 为中心、上下同余量），
  // 因此窗口**就是**对称的预加载带。此前的两道闸门都会让取图时机偏离这条窗口：
  //   ① 共享 IntersectionObserver 等"真的进入视口"（虚拟化之前的做法）；
  //   ② `<img loading="lazy">` 交给浏览器启发式。
  // 另加**显式预热**：`.mp-cell` 的 `content-visibility: auto` 会让被跳过渲染的单元
  // 不触发 `<img>` 取图，而 overscan 带恰恰最容易被跳过。
  //
  // **断言前先剥注释**：本文件的说明文字里会**引用**这些被禁的写法（"不用
  // `loading="lazy"`"之类），直接对全文匹配会把注释当成代码，出现"注释一写就红"的假失败。
  (() => {
    const code = stripComments(mediaCellSrc);
    return (
      /const warmedThumbs = new Set<string>\(\);/.test(code) &&
      /new Image\(\)/.test(code) &&
      // **预热键必须带分辨率档**（缺陷 0046）：只按 `file.id` 记的话，换档后
      // 新档的图没人预热（`content-visibility` 的单元不会自己去取），
      // 表现为"放大图片宽度后滚回去还是糊的"。
      /const warmKey = .*thumbBucket\(thumbRequestSize\)/.test(code) &&
      /warmedThumbs\.add\(warmKey\)/.test(code) &&
      // 请求必须把**该档尺寸**传下去，否则后端恒按首档出图（放大就糊，0046 原样复发）。
      /void resolveThumbUrl\(repoId, file\.id, thumbRequestSize\)/.test(code) &&
      // **正向锚点**：缩略图 effect 的守卫必须**只有** `needsThumb` 一个条件——
      // 后面紧跟 `resolveThumbUrl`，因此再挂任何"等可见"的条件（`!visible` /
      // `!audioVisible` / 别的状态）都会让这条不成立。
      // 只写"禁止某个旧拼法"是不够的：换成另一种可见性状态名就绕过去了
      // （实测：把守卫改成 `!needsThumb || !audioVisible` 时，旧断言仍然通过）。
      /if \(!needsThumb\) return;\s*let cancelled = false;\s*void resolveThumbUrl\(/.test(code) &&
      // 去掉浏览器懒加载：窗口已有界，取图要确定。
      !/loading="lazy"/.test(code)
    );
  })(),
);
check(
  "音频波形改由后端出图后，**三种媒体类型走同一条取图路径**（2026-10-17 / D115）",
  // D115 之前音频是唯一的例外：波形由前端 `decodeAudioData` 现算现画，因此它
  // **躲开**了"挂载即预热"，另走一道"真的进入视口才解码"的观察器闸门
  // （D89 ③ 刻意保留的例外）。波形改成后端 ffmpeg 画好的一张 PNG 之后，
  // 取它已无 CPU 代价（与图片缩略图同一份 `thumbUrl.ts` 缓存），
  // 那条例外必须**一并消失**——否则音频重新变回"向上不预加载"的形态（缺陷 0025）。
  //
  // 两条正向锚点 + 一条反向：
  //  ① `needsThumb` 必须把 `audio` 也算进来（音频走同一道"挂载即预热"）；
  //  ② 音频那一格渲染的是**共用组件** `AudioWaveform`（不是自己画 canvas）；
  //  ③ 模块里**零** `IntersectionObserver`，且不再有 `decodeAudioData` / `extractWaveform`。
  (() => {
    const code = stripComments(mediaCellSrc);
    return (
      /file\.media_type === "image"[\s\S]{0,160}file\.media_type === "audio"/.test(code) &&
      // 音频那一格把**单元已取到的 URL** 传给共用组件：因此"同一条取图路径"
      // 不是靠 `thumbUrl.ts` 的缓存兜住的巧合，而是字面成立
      // （`url={thumbUrl}` 这一行就是它；少了它，同一个 fileId 会被订阅第二次）。
      /<AudioWaveform[\s\S]{0,200}url=\{thumbUrl\}/.test(code) &&
      /<AudioWaveform/.test(code) &&
      (code.match(/IntersectionObserver/g) ?? []).length === 0 &&
      !/decodeAudioData/.test(code) &&
      !/extractWaveform/.test(code)
    );
  })(),
);
check(
  "音频波形组件（`shared/AudioWaveform`）与取图缓存同源，且游标几何按**真实绘制盒**算",
  // 三处消费方（媒体预览单元 / 查看器音频舞台 / 播放器）共用同一个组件与同一份
  // 纯几何模块——分开写就会让"游标位置"与"点哪儿跳到哪儿"各自漂移。
  (() => {
    const shared = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/shared/AudioWaveform.tsx"),
      "utf8",
    );
    const view = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/shared/waveformView.ts"),
      "utf8",
    );
    return (
      // 取图走**共享**的 `resolveThumbUrl`（不是第二条取图命令 / 第二个缓存）。
      /resolveThumbUrl\(repoId, fileId\)/.test(shared) &&
      // 游标与定位都由**纯函数**算出（门禁可直接 import 断言，见 §媒体预览 的取值域断言）。
      /waveCursorPercent\(/.test(shared) &&
      /waveSeekSeconds\(/.test(shared) &&
      // **几何必须按"真正画出来的矩形"算**：`object-fit: contain` 会在容器里
      // 留下 letterbox 空白，拿容器宽度当图像宽度就会让游标/定位偏一个留白量
      // （与缺陷 0027 同一类：几何口径必须与真实绘制一致）。
      /waveDrawnBox\(/.test(shared) &&
      /export function waveDrawnBox\(/.test(view) &&
      // 样式与之一致：图像用 `contain`，游标用绝对定位（且用 px 而不是百分比）。
      // 窗口给足：规则体内有解释 letterbox 的注释（正是这条断言要守的那件事），
      // 窗口太窄会因为"注释写详细了"而假失败。
      /\.wf-image \{[\s\S]{0,400}object-fit: contain;/.test(stylesSource) &&
      /\.wf-cursor \{[\s\S]{0,400}position: absolute;/.test(stylesSource)
    );
  })(),
);
// ---- 波形几何：**行为断言**（跑真函数），守住三条不变量 ----
//
// 这三条各自对应一个真实的坑，且都**不会让功能测试变红**：
//   ① 游标与"点哪儿跳"必须是同一份映射的互逆运算（各写一遍就会漂移）；
//   ② `object-fit: contain` 的 letterbox 留白必须被算进去（否则偏一个留白量，
//      与缺陷 0027 同一类：几何口径必须与真实绘制一致）；
//   ③ 越界取值必须夹紧 / 报"不适用"，不能画出框外游标或对未知时长响应点击。
check(
  "波形几何：游标百分比与「点哪儿跳到哪儿」**互为逆运算**（同一份线性映射）",
  (() => {
    // 取一个刻意**不等宽**的几何（容器 800 宽、波形只画 600：左右各留 100 白）。
    const geometry = { width: 600, durationMs: 180_000 };
    const box = { left: 100, top: 20, width: 300, height: 120 };
    let ok = true;
    for (const fraction of [0, 0.25, 0.5, 0.73, 1]) {
      const seconds = (fraction * geometry.durationMs) / 1000;
      const percent = waveView.waveCursorPercent(seconds * 1000, { ...geometry, width: box.width });
      // 百分比 → 容器像素（`waveCursorX` 会补回 left 留白）；
      // 再把那个像素喂回 `waveSeekSeconds`，应当回到同一个时间点。
      const x = waveView.waveCursorX(percent, box);
      const back = waveView.waveSeekSeconds(x, box, geometry);
      if (back === null || Math.abs(back - seconds) > 1e-6) ok = false;
    }
    return ok;
  })(),
);
check(
  "波形几何：`object-fit: contain` 的留白被算进绘制盒（游标不偏、点击不偏）",
  (() => {
    // 容器 800×120、波形 1200×240（2:1）→ contain 后画成 600×120，左右各留 100。
    const box = waveView.waveDrawnBox({ width: 800, height: 120 }, { width: 1200, height: 240 });
    if (!box || Math.abs(box.left - 100) > 1e-6 || Math.abs(box.width - 600) > 1e-6) return false;
    // **关键对照**：点容器左边缘（x=0）应落在第 0 秒，而不是"音频开头的一小段"——
    // 若实现拿容器宽度当图像宽度，这里会得到负数夹成 0 或明显偏大的值。
    const atLeft = waveView.waveSeekSeconds(0, box, { width: box.width, durationMs: 60_000 });
    const atRight = waveView.waveSeekSeconds(800, box, { width: box.width, durationMs: 60_000 });
    // 留白区（x=50）夹紧到 0 秒；留白区右侧（x=750）夹紧到总时长。
    const inGutter = waveView.waveSeekSeconds(50, box, { width: box.width, durationMs: 60_000 });
    return atLeft === 0 && atRight === 60 && inGutter === 0;
  })(),
);
check(
  "波形几何：越界与「不适用」都有确定答案（不画框外游标、不对未知时长响应点击）",
  (() => {
    const geometry = { width: 400, durationMs: 10_000 };
    // 超出末帧的位置（浏览器 currentTime 与 duration 常差几毫秒）夹到 1，不越界。
    const over = waveView.waveCursorPercent(10_500, geometry);
    const under = waveView.waveCursorPercent(-500, geometry);
    // 时长未知（0 / null）→ `null`（不画游标），而不是画一根在 0 上的假游标。
    const unknown = waveView.waveCursorPercent(3_000, { width: 400, durationMs: 0 });
    // 几何不可用 → 点击不响应（`null`）。
    const noBox = waveView.waveSeekSeconds(100, null, geometry);
    const noSize = waveView.waveDrawnBox({ width: 0, height: 100 }, { width: 1200, height: 240 });
    return (
      over === 1 &&
      under === 0 &&
      unknown === null &&
      noBox === null &&
      noSize === null
    );
  })(),
);
// 方向性差异的**根**在"窗口是否对称"：上下余量必须相等，否则预加载带本身就偏向一侧。
// 用纯函数按行为断言（不是读源码正则）——这是本次缺陷的第一性判据。
check(
  "虚拟化窗口**上下对称**（预加载带必须以 scrollTop 为中心，否则天然偏向一侧）",
  (() => {
    const offsets = Array.from({ length: 40 }, (_, i) => i * 200);
    const heights = Array.from({ length: 40 }, () => 200);
    const scrollTop = 4000;
    const viewportHeight = 800;
    const overscan = Math.max(200, viewportHeight / 2);
    const r = virtual.masonryVisibleRange(offsets, heights, scrollTop, viewportHeight, overscan);
    const above = Math.max(0, scrollTop - (offsets[r.start] ?? 0));
    const below = Math.max(
      0,
      (offsets[r.end - 1] ?? 0) + (heights[r.end - 1] ?? 0) - (scrollTop + viewportHeight),
    );
    return r.start < r.end && above === below && above > 0;
  })(),
);

const mediaSpec = config.panelSpec("media");
const mediaSettingKeys = (mediaSpec?.settings ?? []).map((s) => s.key);
/** 按媒体类型分项的文件名开关（总开关 `showFileName` 之下各自独立）。 */
const MEDIA_FILE_NAME_TOGGLE_KEYS = [
  "showFileName",
  "showImageFileName",
  "showVideoFileName",
  "showAudioFileName",
];
check(
  "媒体预览声明了 8 项面板设置（view / imageSize / 4 个文件名开关 / sortKey / sortDir），都带 i18n 键",
  eqList(mediaSettingKeys, [
    "view",
    "imageSize",
    "showFileName",
    "showImageFileName",
    "showVideoFileName",
    "showAudioFileName",
    "sortKey",
    "sortDir",
  ]) &&
    (mediaSpec?.settings ?? []).every(
      (s) => typeof s.title_key === "string" && s.title_key.length > 0,
    ),
  `decls=${mediaSettingKeys.join(",") || "（无）"}`,
);
check(
  "三项 select（视图 / 排序键 / 方向）+ numberInput（图片尺寸）+ 四个 switch（文件名总开关与三个分项）：`slider` 会把值夹在浏览器默认的 0–100，声明层没有 min/max",
  mediaSpec?.settings?.find((s) => s.key === "view")?.kind === "select" &&
    mediaSpec?.settings?.find((s) => s.key === "sortKey")?.kind === "select" &&
    mediaSpec?.settings?.find((s) => s.key === "sortDir")?.kind === "select" &&
    mediaSpec?.settings?.find((s) => s.key === "imageSize")?.kind === "numberInput" &&
    MEDIA_FILE_NAME_TOGGLE_KEYS.every(
      (key) => mediaSpec?.settings?.find((s) => s.key === key)?.kind === "switch",
    ) &&
    // 宿主 `slider` 渲染是裸 `<input type="range">`（无 min/max）→ 值域会被压在 0–100，
    // 图片尺寸 80–400 会被截断，故**不得**用 slider。
    !(mediaSpec?.settings ?? []).some((s) => s.kind === "slider"),
);
check(
  "媒体预览的 select 候选 ↔ 面板纯函数取值域逐项一致（视图 / 排序键 / 方向）",
  eqList(optionValues("media", "view"), [...mediaView.MEDIA_VIEW_MODES]) &&
    eqList(optionValues("media", "sortKey"), [...mediaView.MEDIA_SORT_KEYS]) &&
    eqList(optionValues("media", "sortDir"), [...mediaView.SORT_DIRECTIONS]),
  `view=${optionValues("media", "view").join(",")} ` +
    `sortKey=${optionValues("media", "sortKey").join(",")} ` +
    `sortDir=${optionValues("media", "sortDir").join(",")}`,
);
check(
  "缺省视图是「自适应」、缺省排序是「名称 · 正序」、缺省图片尺寸落在面板夹紧范围内",
  mediaView.MEDIA_VIEW_MODES.includes("adaptive") &&
    mediaSpec?.settings?.find((s) => s.key === "view")?.default === "adaptive" &&
    mediaSpec?.settings?.find((s) => s.key === "sortKey")?.default === "name" &&
    mediaSpec?.settings?.find((s) => s.key === "sortDir")?.default === "asc" &&
    typeof mediaSpec?.settings?.find((s) => s.key === "imageSize")?.default === "number" &&
    mediaSpec.settings.find((s) => s.key === "imageSize").default >=
      mediaView.MEDIA_IMAGE_SIZE_MIN &&
    mediaSpec.settings.find((s) => s.key === "imageSize").default <=
      mediaView.MEDIA_IMAGE_SIZE_MAX,
);
check(
  "图片尺寸夹紧：0 / 负数 / 非数值回落兜底值，超界夹到 [MIN, MAX]，正常值取整",
  mediaView.clampImageSize(0) === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize(-10) === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize(Number.NaN) === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize("bad") === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize(1) === mediaView.MEDIA_IMAGE_SIZE_MIN &&
    mediaView.clampImageSize(100000) === mediaView.MEDIA_IMAGE_SIZE_MAX &&
    mediaView.clampImageSize(200.4) === 200 &&
    mediaView.MEDIA_IMAGE_SIZE_MIN === 80 &&
    mediaView.MEDIA_IMAGE_SIZE_MAX === 400,
  `[${mediaView.MEDIA_IMAGE_SIZE_MIN}, ${mediaView.MEDIA_IMAGE_SIZE_MAX}] 兜底 ${mediaView.MEDIA_IMAGE_SIZE_FALLBACK}`,
);
check(
  "媒体预览设置按声明归一化：非法取值回落缺省、未注册面板返回 undefined",
  config.normalizePanelSettingValue("media", "view", "masonry") === "masonry" &&
    config.normalizePanelSettingValue("media", "view", "grid") === "adaptive" &&
    config.normalizePanelSettingValue("media", "view", null) === "adaptive" &&
    config.normalizePanelSettingValue("media", "imageSize", 220) === 220 &&
    config.normalizePanelSettingValue("media", "imageSize", "240") === 240 &&
    config.normalizePanelSettingValue("media", "imageSize", "big") === 160 &&
    config.normalizePanelSettingValue("media", "imageSize", null) === 160 &&
    config.normalizePanelSettingValue("media", "showFileName", false) === false &&
    config.normalizePanelSettingValue("media", "showFileName", "false") === false &&
    // 开关的缺省是**显示**（与既有观感一致）；非法值回落缺省。
    config.normalizePanelSettingValue("media", "showFileName", "yes") === true &&
    config.normalizePanelSettingValue("media", "showFileName", null) === true &&
    // 三个分项开关与总开关同款归一化（缺省同样是"显示"）。
    MEDIA_FILE_NAME_TOGGLE_KEYS.filter((key) => key !== "showFileName").every(
      (key) =>
        config.normalizePanelSettingValue("media", key, false) === false &&
        config.normalizePanelSettingValue("media", key, "false") === false &&
        config.normalizePanelSettingValue("media", key, "yes") === true &&
        config.normalizePanelSettingValue("media", key, null) === true,
    ) &&
    config.normalizePanelSettingValue("media", "sortKey", "date") === "name" &&
    config.normalizePanelSettingValue("media", "sortDir", "up") === "asc" &&
    config.normalizePanelSettingValue("media", "sortDir", "desc") === "desc" &&
    config.normalizePanelSettingValue("ghost", "view", "tile") === undefined,
);
check(
  "四个文件名开关都被面板真的消费：总开关 × 按媒体类型的分项开关（列表视图文件名照旧）",
  // 四个开关的缺省都是「显示」= 与既有观感一致（零视觉变化）。
  MEDIA_FILE_NAME_TOGGLE_KEYS.every(
    (key) => mediaSpec?.settings?.find((s) => s.key === key)?.default === true,
  ) &&
    // 四个开关各自被 `usePanelSwitch` 读出来（不是只读总开关）。
    MEDIA_FILE_NAME_TOGGLE_KEYS.every((key) =>
      new RegExp(`usePanelSwitch\\(MEDIA_PANEL_ID, "${key}", \\{ api: panelApi \\}\\)`).test(
        mediaFamilySrc,
      ),
    ) &&
    // 总开关 ∧ 分项开关在同一个回调里合成"这一格要不要标签"。
    /if \(!showFileName\) return false;/.test(mediaFamilySrc) &&
    /if \(mediaType === "image"\) return showImageFileName;/.test(mediaFamilySrc) &&
    /if \(mediaType === "video"\) return showVideoFileName;/.test(mediaFamilySrc) &&
    /if \(mediaType === "audio"\) return showAudioFileName;/.test(mediaFamilySrc) &&
    // 三种缩略图视图都按**该条目的媒体类型**取开关（不是全局一个布尔）。
    /showFileNameFor\(item\.file\.media_type\)/.test(mediaFamilySrc) &&
    /showFileNameFor\(file\.media_type\)/.test(mediaFamilySrc) &&
    /showName=\{showFileNameFor\(file\.media_type\)\}/.test(mediaFamilySrc) &&
    // 单元按开关条件渲染标签；列表视图的文件名是条目本体，不受开关影响。
    /\{showName && <span className="mp-name">/.test(mediaCellSrc) &&
    /<span className="mp-row-name">\{file\.relative_path\}<\/span>/.test(mediaFamilySrc),
);
check(
  "三视图**各自**按条目媒体类型取开关：瀑布流逐格算高、自适应逐格给 nameBlock、平铺逐行取最大、单元按格渲染",
  // 只断言"家族里出现过 showFileNameFor"是不够的——那会让其中两个视图退回全局布尔
  // 仍然全绿。四个消费点必须**逐个**锚定到各自的调用形状上。
  // ① 瀑布流：`masonryCellHeight` 的第三参是该格文件的媒体类型判定。
  /masonryCellHeight\([\s\S]{0,400}?showFileNameFor\(item\.file\.media_type\)/.test(mediaPanelSrc) &&
    // ② 自适应：`adaptiveRowLayout` 的第 6 参是**按条目下标**的数组（不是常数）。
    /items\.map\(\(item\) =>\s*showFileNameFor\(item\.file\.media_type\)/.test(mediaPanelSrc) &&
    // ③ 平铺：逐行取该行最大值。
    /tileRowHeight\(imageSize, showFileNameFor\(file\.media_type\)\)/.test(mediaPanelSrc) &&
    // ④ 单元：`showName` 由面板按媒体类型算好再传进来。
    /showName=\{showFileNameFor\(file\.media_type\)\}/.test(mediaPanelSrc) &&
    // ⑤ 占位高度（`content-visibility` 的块轴）同源。
    /const showName = showFileNameFor\(file\.media_type\);/.test(mediaPanelSrc),
);
check(
  "列表视图的体积走**宿主设置** `ui.sizeUnit`（与元数据面板同一份格式化），不另立同名面板设置",
  // 面板设置里不得出现 sizeUnit / dateFormat 这类宿主项的同名副本（两套口径必然漂移）。
  !(mediaSpec?.settings ?? []).some((s) => s.key === "sizeUnit") &&
    !(mediaSpec?.settings ?? []).some((s) => s.key === "dateFormat") &&
    /const sizeUnit = resolveSizeUnit\(useHostSettingValue\(SETTING_KEYS\.sizeUnit, panelApi\)\)/.test(
      mediaPanelSrc,
    ) &&
    /formatByteSize\(file\.size, sizeUnit\)/.test(mediaPanelSrc) &&
    // 不许退回裸字节数（用户反馈的就是这个）。
    !/<span className="mp-row-size">\{file\.size\}<\/span>/.test(mediaPanelSrc),
);
check(
  "媒体预览设置用 `divider_before` 分成三组（视图+尺寸+总开关 / 三个分项开关 / 排序），首项无分隔线",
  eqList(
    (mediaSpec?.settings ?? []).filter((s) => s.divider_before).map((s) => s.key),
    ["showImageFileName", "sortKey"],
  ) && mediaSpec?.settings?.[0]?.divider_before !== true,
);
const mkFile = (relative_path, size, mtime, media_type) => ({
  relative_path,
  size,
  mtime,
  media_type,
});
const mediaRows = [
  mkFile("b\\img10.jpg", 300, "1600000000000000000", "image"),
  mkFile("a\\img2.jpg", 100, "1700000000000000000", "image"),
  mkFile("c\\clip.mp4", 200, "1500000000000000000", "video"),
];
const nameOf = (list) => list.map((f) => f.relative_path).join(",");
const sortBy = (key, dir) => nameOf(mediaView.sortFiles(mediaRows, key, dir));
check(
  "排序纯函数：四个键 × 两个方向（名称**数字感知** `img2` < `img10`、时间按 epoch 纳秒、大小按字节）",
  sortBy("name", "asc") === "c\\clip.mp4,a\\img2.jpg,b\\img10.jpg" &&
    sortBy("name", "desc") === "b\\img10.jpg,a\\img2.jpg,c\\clip.mp4" &&
    sortBy("size", "asc") === "a\\img2.jpg,c\\clip.mp4,b\\img10.jpg" &&
    sortBy("time", "asc") === "c\\clip.mp4,b\\img10.jpg,a\\img2.jpg" &&
    // 「类型」同类型内再按名称，否则组内顺序由查询顺序决定（看起来在抖）。
    sortBy("type", "asc") === "a\\img2.jpg,b\\img10.jpg,c\\clip.mp4",
  `name=${sortBy("name", "asc")} | size=${sortBy("size", "asc")} | time=${sortBy("time", "asc")}`,
);
check(
  "排序是纯函数（不改动入参数组）且从**路径最后一段**取名（`\\` 与 `/` 都认）",
  mediaRows[0].relative_path === "b\\img10.jpg" &&
    mediaView.fileName("a\\b\\c.jpg") === "c.jpg" &&
    mediaView.fileName("a/b/c.jpg") === "c.jpg" &&
    mediaView.fileName("noext") === "noext",
);
check(
  "瀑布流列分配：按序号从左到右（`i % columns`）、列数恒等于请求列数；宽度不可用时退 1 列",
  JSON.stringify(masonry) === JSON.stringify([[1, 4, 7], [2, 5], [3, 6]]) &&
    mediaView.distributeColumns([1, 2], 1.5).length === 1 &&
    mediaView.masonryColumnCount(0) === 1 &&
    mediaView.masonryColumnCount(-10) === 1 &&
    // 列数公式与 CSS `repeat(auto-fill, <单元格宽度>)` 一致（`n*w + (n-1)*gap <= 容器宽`）——
    // 平铺与瀑布流因此**永远同列数**（两者单元格同宽是用户口径）。
    mediaView.masonryColumnCount(400, 160, 8) === Math.floor((400 + 8) / (160 + 8)) &&
    mediaView.masonryColumnCount(1000, 160, 8) === Math.floor((1000 + 8) / (160 + 8)) &&
    // 808 = 400 + 8 + 400：刚好放得下两列（再多 1px 就只能放一列）。
    mediaView.masonryColumnCount(808, 400, 8) === 2 &&
    mediaView.masonryColumnCount(800, 400, 8) === 1,
  `400px→${mediaView.masonryColumnCount(400, 160, 8)} 1000px→${mediaView.masonryColumnCount(1000, 160, 8)}（单元格 160 / 间距 8）`,
);
check(
  "媒体预览面板真的消费四项设置（缺省读取 + 排序 + 三种视图 + 图片尺寸下发与列数）",
  /usePanelSettingValue\(MEDIA_PANEL_ID, "view", panelApi\)/.test(mediaFamilySrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "imageSize", panelApi\)/.test(mediaFamilySrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortKey", panelApi\)/.test(mediaFamilySrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortDir", panelApi\)/.test(mediaFamilySrc) &&
    /sortFiles\(files, sortKey, sortDir\)/.test(mediaFamilySrc) &&
    /mediaViewClass\(view\)/.test(mediaFamilySrc) &&
    /distributeColumns\(items, masonryColumns\)/.test(mediaFamilySrc) &&
    // 图片尺寸经 CSS 变量下发（一种设置、三种排布同一口径）。
    /"--mp-image-size": `\$\{imageSize\}px`/.test(mediaFamilySrc) &&
    /style=\{containerStyle\}/.test(mediaFamilySrc) &&
    /masonryColumnCount\(el\.clientWidth, imageSize, MASONRY_GAP\)/.test(mediaFamilySrc) &&
    /new ResizeObserver\(measure\)/.test(mediaFamilySrc),
);
check(
  "图片尺寸滑条在「视图」**左边**，取值域来自纯函数常量，列表模式下置灰",
  // 工具条顺序：滑条块在 `<ToolbarDropdown labelKey="media.settings.view"` 之前。
  // （2026-09 第四轮拆分：工具条整块渲染落在 `mediaPreviewToolbar.tsx`。）
  /className="mp-size"[\s\S]*?<ToolbarDropdown\s+labelKey="media\.settings\.view"/.test(mediaToolbarSrc) &&
    /min=\{MEDIA_IMAGE_SIZE_MIN\}/.test(mediaToolbarSrc) &&
    /max=\{MEDIA_IMAGE_SIZE_MAX\}/.test(mediaToolbarSrc) &&
    /value=\{imageSize\}/.test(mediaToolbarSrc) &&
    /onChange=\{\(e\) => onChooseImageSize\(Number\(e\.target\.value\)\)\}/.test(mediaToolbarSrc) &&
    // 与视图下拉同一处置：只在「预览图」模式下有效。
    /disabled=\{viewMode !== "thumb"\}/.test(mediaToolbarSrc) &&
    // 夹紧与「本会话记住」在会话状态模块（`chooseImageSize`），工具条只转发。
    /const clamped = clampImageSize\(next\);/.test(mediaFamilySrc),
);
check(
  "面板内的改动只做**本会话**覆盖，且「全部设置」显式改动时放弃覆盖（否则＝改了设置没反应）",
  // 视图 / 图片尺寸的覆盖仍是本面板的模块变量；排序两项的覆盖自缺陷 0039 / D144 起
  // 在共享 store（`core/mediaSortStore.ts`，图像查看器同步消费）——断言跟着代码走。
  /let sessionView: MediaViewMode \| null = null;/.test(mediaFamilySrc) &&
    /let sessionImageSize: number \| null = null;/.test(mediaFamilySrc) &&
    /sessionView = next;/.test(mediaFamilySrc) &&
    /sessionImageSize = clamped;/.test(mediaFamilySrc) &&
    /subscribeSettingChanged\(\(key\) => \{/.test(mediaFamilySrc) &&
    /key === VIEW_STORAGE_KEY/.test(mediaFamilySrc) &&
    /key === IMAGE_SIZE_STORAGE_KEY/.test(mediaFamilySrc) &&
    (mediaFamilySrc.match(/= null;\n\s+set\w+Override\(null\);/g) ?? []).length === 2 &&
    // 排序覆盖的写入与放弃都只经 store（面板不得再私藏第二份排序覆盖）。
    /chooseMediaSort\(next\);/.test(mediaFamilySrc) &&
    !/let sessionSortKey/.test(mediaFamilySrc) &&
    !/let sessionSortDir/.test(mediaFamilySrc),
);
check(
  "排序下拉 =「名称 / 时间 / 大小 / 类型」+ **一条横线** +「正序 / 倒序」（两组都由取值域派生）",
  // 取值域本身的顺序就是界面顺序（注册表候选与之逐项一致，见上面的 `eqList`）。
  eqList([...mediaView.MEDIA_SORT_KEYS], ["name", "time", "size", "type"]) &&
    eqList([...mediaView.SORT_DIRECTIONS], ["asc", "desc"]) &&
    /MEDIA_SORT_KEYS\.map\(/.test(mediaToolbarSrc) &&
    /SORT_DIRECTIONS\.map\(/.test(mediaToolbarSrc) &&
    // 横线挂在**方向组第一项**之前（`index === 0`），不会跑到最上面或错位。
    /ruleBefore: index === 0/.test(mediaToolbarSrc) &&
    /\{option\.ruleBefore && <div className="menu-sep" \/>\}/.test(mediaDropdownSrc),
  `sortKeys=${[...mediaView.MEDIA_SORT_KEYS].join(",")} directions=${[...mediaView.SORT_DIRECTIONS].join(",")}`,
);
check(
  "「视图」下拉只在「预览图」模式下有效（列表模式下置灰并给出原因）",
  /disabled=\{viewMode !== "thumb"\}/.test(mediaToolbarSrc) &&
    /disabledHint=\{t\("media\.viewOnlyInThumb"\)\}/.test(mediaToolbarSrc) &&
    // 下拉组件本身必须接住 `disabled`（否则"置灰"只是面板一厢情愿）。
    /disabled=\{disabled\}/.test(mediaDropdownSrc) &&
    // 工具条只接面板传下来的 `t`（同一份 i18n 函数，不是工具条自建一份文案）。
    /<MediaPreviewToolbar[\s\S]{0,900}?t=\{app\.t\}/.test(mediaPanelSrc) &&
    /import \{ ToolbarDropdown, type DropdownOption \} from "\.\/mediaPreviewDropdown";/.test(
      mediaToolbarSrc,
    ),
);
const contextMenuForDropdownSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/menu/ContextMenu.tsx"),
  "utf8",
);
check(
  "媒体预览在**后台标签时冻结**：三个条目容器都要求 `foreground`，滚动/列数测量在前台变化后重跑",
  /import \{ usePanelForeground \} from "\.\.\/shared\/panelForeground";/.test(mediaPanelSrc) &&
    /const foreground = usePanelForeground\(panelApi\);/.test(mediaPanelSrc) &&
    (mediaPanelSrc.match(/repoId && foreground && viewMode ===/g) ?? []).length === 3 &&
    // 冻结时容器不在 DOM 里：滚动恢复与瀑布流测量必须跟着前台变化重跑一次。
    // （滚动恢复的依赖数组另外还要含 `items.length` / `loading`——后台翻页下内容会
    //  一轮轮变长，只依赖"从无到有"的布尔会让深位置永远恢复不回去，见 `mediaPreviewScroll.ts`。）
    /\}, \[viewMode, view, foreground, app\.repoId, items\.length, loading\]\);/.test(
      mediaPanelSrc,
    ) &&
    /\}, \[viewMode, foreground, app\.repoId, items\.length, loading\]\);/.test(mediaPanelSrc) &&
    /\}, \[view, viewMode, foreground, imageSize, app\.repoId, items\.length > 0\]\);/.test(
      mediaPanelSrc,
    ),
);
check(
  "冻结判据只用 `isVisible`（不得掺 `isActive`：那会让「点别的面板就冻住」复发），且失败方向选「先渲染」",
  // `isActive` 表示"本组也是当前聚焦组"：用户点媒体源/相册时它会变 false，
  // 而本面板仍在显示——用 `isVisible && isActive` 当判据就会出现"点源不刷新、点一下才显示"。
  // D212：订阅口收进 `shared/panelActivity.ts`，本文件只取 `isVisible` 一个维度。
  /usePanelActivity\(panelApi, \(\{ isVisible \}\) => setForeground\(isVisible\)\)/.test(
    panelForegroundSrc,
  ) &&
    !/panelApi\.isActive/.test(panelForegroundSrc) &&
    !/onDidActiveChange|onDidVisibilityChange/.test(panelForegroundSrc) &&
    // 首帧乐观：判断"不在显示"而误会让面板空白，宁可多渲染一次。
    /const \[foreground, setForeground\] = useState\(true\);/.test(panelForegroundSrc),
);
// `renderCell` 的实现块：`ThumbCell` 的 props 必须全是稳定引用（列表视图的行走另一条路径，
// 那几行不是 memo 的受益者，不在此约束内）。
const renderCellSrc = (
  mediaPanelSrc.match(/const renderCell = useCallback\([\s\S]*?\n  \);/) || [""]
)[0];
check(
  "缩略图单元 `memo` 的前提被钉住：回调恒定引用 + 双击以文件为参数（不再逐格新建闭包）",
  /export const ThumbCell = memo\(function ThumbCell\(/.test(mediaCellSrc) &&
    /onDoubleClick: \(file: FileItem\) => void;/.test(mediaCellSrc) &&
    /onDoubleClick=\{\(\) => onDoubleClick\(file\)\}/.test(mediaCellSrc) &&
    // 恒定引用回调本身住在 `shared/stableCallback.ts`（媒体预览与图书预览共用一份），
    // 面板侧只保留"用了它"的锚点。
    /function useStableCallback<A extends unknown\[\], R>/.test(stableCallbackSrc) &&
    /import \{ useStableCallback \} from "\.\.\/shared\/stableCallback"/.test(mediaPanelSrc) &&
    /const cellSelect = useStableCallback\(handleSelect\);/.test(mediaPanelSrc) &&
    /onSelect=\{cellSelect\}/.test(renderCellSrc) &&
    /onDoubleClick=\{cellDoubleClick\}/.test(renderCellSrc) &&
    // 反向：`ThumbCell` 的 props 里不许再出现逐格新建的箭头函数（那会让 memo 完全失效）。
    !/=\(\) =>/.test(renderCellSrc) &&
    !/onDoubleClick=\{\(\) =>/.test(renderCellSrc),
);
check(
  "两个下拉复用 portal 的 `ContextMenu`，且「点外部关闭」**同时排除按钮与弹出层**",  // 弹出层由 `ContextMenu` portal 到 `document.body`：它的 DOM **不在按钮里**，
  // 只排除按钮的话，按在选项上的 mousedown 会先关掉下拉、卸载弹出层，
  // 选项的 click 永远不会发生（"下拉能开、选什么都没反应"）。
  /<ContextMenu x=\{anchor\.x\} y=\{anchor\.y\}>/.test(mediaDropdownSrc) &&
    /btnRef\.current\?\.contains\(target\)/.test(mediaDropdownSrc) &&
    /target\.closest\("\.context-menu"\)/.test(mediaDropdownSrc) &&
    // 判定收在纯函数里（下面按行为断言），组件不得再手写一份 if。
    /shouldCloseDropdown\(inButton, inPopup\)/.test(mediaDropdownSrc) &&
    // 类名两侧必须对得上：弹出层的容器类由 `ContextMenu` 定义。
    /className="context-menu"/.test(contextMenuForDropdownSrc) &&
    // 顺序：先判"是不是外部"，再关；反过来等于没排除。
    /if \(!shouldCloseDropdown\(inButton, inPopup\)\) return;[\s\S]{0,80}?setAnchor\(null\);/.test(
      mediaDropdownSrc,
    ),
);
check(
  "「点外部关闭」的不变量：按在**弹出层内**不关闭（谁也不能化简回 `!inButton`）",
  mediaView.shouldCloseDropdown(false, false) === true &&
    mediaView.shouldCloseDropdown(true, false) === false &&
    mediaView.shouldCloseDropdown(false, true) === false &&
    mediaView.shouldCloseDropdown(true, true) === false,
  `(按钮内,弹出层内)=(${mediaView.shouldCloseDropdown(true, false)},${mediaView.shouldCloseDropdown(false, true)})`,
);
check(
  "media 面板拿到 dockview 面板 API（第 4 条触发源「面板激活」才可达）",
  /^ {2}media: \(ctx\) => <MediaPreviewPanel api=\{ctx\.api\} \/>,$/m.test(
    registrySource,
  ),
);
check(
  "三种视图的样式齐全且**共用一个图片尺寸变量**：平铺（固定列宽）/ 自适应（逐行两端对齐）/ 瀑布流（固定列宽）",
  // 平铺：固定列宽 = 图片尺寸。列数由**面板下发**（`--mp-tile-columns`）而不是
  // `auto-fill`——虚拟化必须知道 CSS 会排几列，否则"按几列切行"与 CSS 排布不一致，
  // 表现为行错位/留白。列数仍用与 `auto-fill` 相同的公式算（`masonryColumnCount`）。
  /\.mp-grid\.mp-view-tile\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--mp-tile-columns/.test(
    stylesSource,
  ) &&
    !/\.mp-grid\.mp-view-tile\s*\{[^}]*repeat\(auto-fill/.test(stylesSource) &&
    /"--mp-tile-columns":\s*String\(Math\.max\(1, masonryColumns\)\)/.test(mediaPanelSrc) &&
    /\.mp-view-tile \.mp-thumb img[\s\S]{0,120}?object-fit:\s*cover/.test(stylesSource) &&
    // 瀑布流：列宽 = 同一个变量（**不再 `flex: 1 1 0` 等分**，那会让列宽随面板漂移）。
    /\.mp-masonry\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    /\.mp-masonry-col\s*\{[^}]*flex:\s*0 0 var\(--mp-image-size/.test(stylesSource) &&
    !/\.mp-masonry-col\s*\{[^}]*flex:\s*1 1 0/.test(stylesSource) &&
    /\.mp-masonry \.mp-thumb img[\s\S]{0,160}?height:\s*auto/.test(stylesSource) &&
    // 行高不等的瀑布流**不得**再靠"关掉跳过渲染"回避滚动抖动：占位高度由面板按宽高比
    // 逐个文件下发（`contain-intrinsic-block-size`），跳过渲染因此可以打开。
    !/\.mp-masonry \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    /\.mp-size-range\s*\{/.test(stylesSource) &&
    /\.mp-dd\s*\{/.test(stylesSource),
);
check(
  "自适应 = **逐行两端对齐**：断行改由 JS（第 6 轮），行内仍按宽高比分配剩余空间（`flex-grow`/`flex-basis` 同为宽高比）",
  // 第 6 轮（缺陷 0018 §3.1 路线 2）：断行从 CSS `flex-wrap` 移到 JS（`adaptiveRowLayout`），
  // 否则虚拟化无从下手（JS 不测量就不知道 CSS 会断在哪）。**行内宽度分配仍是 CSS**，
  // 因此"两端对齐"的观感一字不改——这一点由 n=60 的 A/B 实测证明：
  // 旧实现 contentHeight = 1684，新实现同样 1684（逐行一致）。
  /\.mp-grid\.mp-view-adaptive\s*\{[^}]*--mp-row-max-factor:\s*2/.test(stylesSource) &&
    // 行容器是 flex 行，且**不得**再 `flex-wrap: wrap`：行边界由 JS 决定，
    // CSS 再换行就会与 JS 不一致（表现为行错位/留白）。
    /\.mp-virtual-row\.mp-virtual-adaptive\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    /\.mp-virtual-row\.mp-virtual-adaptive\s*\{[^}]*flex-wrap:\s*nowrap/.test(stylesSource) &&
    // 两端对齐的两行：grow 与 basis 都必须取宽高比，缺一就退化成"等高不齐边"。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*flex-grow:\s*var\(--mp-cell-ratio/.test(stylesSource) &&
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*flex-basis:\s*calc\(var\(--mp-cell-ratio/.test(
      stylesSource,
    ) &&
    // 内边距/边框必须在自适应下清零：它们会在宽度上加常数，破坏"高度 = 宽 ÷ 宽高比"，
    // 表现为同一行内各格高度参差（行底部不齐）。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*padding:\s*0/.test(stylesSource) &&
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*border:\s*none/.test(stylesSource) &&
    /\.mp-view-adaptive \.mp-cell\.selected\s*\{[^}]*outline-color/.test(stylesSource) &&
    // 缩略图高度由宽高比推出（行内等高、行间不等）。
    /\.mp-view-adaptive \.mp-thumb\s*\{[^}]*aspect-ratio:\s*var\(--mp-cell-ratio/.test(
      stylesSource,
    ) &&
    // 稀疏行不把单张图放大到上千像素：到行高上限即停手（JS 的 `adaptiveRowLayout` 用同一系数）。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*max-width:\s*calc\([\s\S]{0,160}?--mp-row-max-factor/.test(
      stylesSource,
    ) &&
    // 长文件名不得顶宽单元格（否则"按宽高比配平"失效）。
    /\.mp-view-adaptive \.mp-name\s*\{[^}]*contain:\s*inline-size/.test(stylesSource) &&
    // 行高由宽高比推出 → 跳过渲染的占位高度必须**接近真实**（不能靠关掉跳过渲染回避）。
    !/\.mp-view-adaptive \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource),
);
check(
  "自适应**断行与行高**由 JS 算（`adaptiveRowLayout`），且与 CSS 的配平同源",
  // 缺陷 0018 §3.1 路线 2：断行必须由 JS 算，虚拟化才可能；行内宽度仍交给 CSS。
  // 这里断言的是**纯函数行为**（门禁直接跑真函数），不是源码正则。
  (() => {
    const gap = 8;
    const target = 160;
    const factor = 2;
    // 10 张 1:1 的图、容器宽 808：每格基准宽 160 + 间距 8，
    // 5 格需要 5×160 + 4×8 = 832 > 808 → **每行只能放 4 格**（与 CSS flex-wrap 同判据）。
    const ratios = Array.from({ length: 10 }, () => 1);
    const layout = virtual.adaptiveRowLayout(ratios, 808, target, gap, factor);
    if (layout.rows.length !== 3) return false;
    if (layout.rows[0].length !== 4 || layout.rows[1].length !== 4) return false;
    if (layout.rows[2].length !== 2) return false;
    // 保序、不丢项、不重复。
    if (JSON.stringify(layout.rows.flat()) !== JSON.stringify([...Array(10).keys()])) return false;
    // 行内各格等高：(容器宽 − 行内间距) / Σ宽高比 = (808 − 24) / 4 = 196 → 行高 196。
    if (layout.rowHeights[0] !== 196 || layout.rowHeights[1] !== 196) return false;
    // 末行只有 2 格：撑满会是 (808−8)/2 = 400 > 160×2 = 320 → **封顶到 320**。
    if (layout.rowHeights[2] !== 320) return false;
    // 偏移单调、总高 = Σ行高 + 行间距。
    if (layout.offsets[0] !== 0 || layout.offsets[1] !== 196 + gap) return false;
    if (layout.total !== 196 + gap + 196 + gap + 320) return false;
    return true;
  })(),
  `行高=${virtual.adaptiveRowLayout(Array(10).fill(1), 808, 160, 8, 2).rowHeights.join(",")} 各行列数=${virtual
    .adaptiveRowLayout(Array(10).fill(1), 808, 160, 8, 2)
    .rows.map((r) => r.length)
    .join(",")}`,
);

check(
  "自适应行高**封顶**：稀疏行不被放大到荒唐高度（与 `--mp-row-max-factor` 同源）",
  (() => {
    // 一行只有 1 张 1:1 的图、容器宽 1578：撑满会是 1578px 高，必须封顶到 160×2 = 320。
    const layout = virtual.adaptiveRowLayout([1], 1578, 160, 8, 2);
    if (layout.rows.length !== 1) return false;
    if (layout.rowHeights[0] !== 320) return false;
    // 封顶后该格宽 = 1 × 160 × 2 = 320（`adaptiveCellWidth` 与之一致）。
    const width = virtual.adaptiveCellWidth(1, 1, 1, 1578, 160, 8, 2);
    return width === 320;
  })(),
);

check(
  "自适应行高**逐格**取文件名块：同一行混着「显示 / 不显示文件名」时取该行最大值",
  (() => {
    // 三个文件名分项开关让同一行可能混着图像 / 视频 / 音频，行内仍必须等高，
    // 因此 `nameBlock` 接受**按条目下标的数组**，行高取该行最大值。
    const gap = 8;
    const target = 160;
    const factor = 2;
    const ratios = Array.from({ length: 10 }, () => 1);
    // 基线：全部不显示文件名 → 与常数 0 完全一致。
    const zeros = Array.from({ length: 10 }, () => 0);
    const base = virtual.adaptiveRowLayout(ratios, 808, target, gap, factor, zeros);
    if (base.rowHeights[0] !== 196 || base.rowHeights[2] !== 320) return false;
    // 只把第 0 项（落在第 1 行）的文件名块设成 16：**只有第 1 行**长高 16px。
    const mixed = Array.from({ length: 10 }, (_, i) => (i === 0 ? 16 : 0));
    const layout = virtual.adaptiveRowLayout(ratios, 808, target, gap, factor, mixed);
    if (layout.rows.length !== 3) return false;
    if (layout.rowHeights[0] !== 196 + 16) return false;
    if (layout.rowHeights[1] !== 196) return false;
    if (layout.rowHeights[2] !== 320) return false;
    // 偏移跟着行高走（总高 = Σ行高 + 行间距），否则虚拟化窗口会错位。
    if (layout.offsets[1] !== 212 + gap) return false;
    if (layout.total !== 212 + gap + 196 + gap + 320) return false;
    // 同一行里**非首项**带文件名块也要生效（不是"只看第 0 项"）。
    const tail = Array.from({ length: 10 }, (_, i) => (i === 3 ? 16 : 0));
    const tailLayout = virtual.adaptiveRowLayout(ratios, 808, target, gap, factor, tail);
    if (tailLayout.rowHeights[0] !== 212) return false;
    // 常数形式仍然等价于"整行统一"（旧调用点不必改）。
    const scalar = virtual.adaptiveRowLayout(ratios, 808, target, gap, factor, 16);
    if (scalar.rowHeights[0] !== 212 || scalar.rowHeights[2] !== 336) return false;
    return true;
  })(),
  `逐格=${virtual.adaptiveRowLayout(Array(10).fill(1), 808, 160, 8, 2, [16, 0, 0, 0, 0, 0, 0, 0, 0, 0]).rowHeights.join(",")}`,
);

check(
  "自适应断行的**退化输入**：空输入、非法宽高比、零宽容器都不崩",
  (() => {
    const empty = virtual.adaptiveRowLayout([], 800, 160, 8, 2);
    if (empty.rows.length !== 0 || empty.total !== 0) return false;
    // 0 / 负数 / NaN 一律按 1:1 处理（否则 flex 计算会得到 NaN，整行作废）。
    const bad = virtual.adaptiveRowLayout([0, -2, Number.NaN], 800, 160, 8, 2);
    if (bad.rows.flat().length !== 3) return false;
    if (!bad.rowHeights.every((h) => Number.isFinite(h) && h > 0)) return false;
    // 容器宽 0（首帧尚未测量）不得产出 NaN/负高度。
    const zero = virtual.adaptiveRowLayout([1, 1], 0, 160, 8, 2);
    if (!zero.rowHeights.every((h) => Number.isFinite(h) && h > 0)) return false;
    return true;
  })(),
);

check(
  "自适应**按行虚拟化**：只渲染窗口内的行（DOM 单元数与条目总数脱钩）",
  /adaptiveRowLayout\(/.test(mediaPanelSrc) &&
    /useVariableRowVirtualizer\(/.test(mediaPanelSrc) &&
    /adaptiveVirtual\.rows\.map\(/.test(mediaPanelSrc) &&
    // 必须**按窗口切片**渲染，不得退回 `items.map` 全量铺开。
    /\(adaptive\.rows\[row\.index\] \?\? \[\]\)\.map\(/.test(mediaPanelSrc) &&
    !/items\.map\(\(\{ file, url \}\) => renderCell/.test(mediaPanelSrc) &&
    // 内容总高度由虚拟化给出（行高逐行不同，但完全由纯函数算，不测量）。
    /className="mp-virtual" style=\{\{ height: adaptiveVirtual\.totalSize \}\}/.test(mediaPanelSrc) &&
    // 宽高比、文件名开关（按媒体类型分项）与容器宽度都必须进依赖：
    // 解码后断行会变，容器宽度变了要重新断行，开关切换要重新算行高。
    /\[items, gridWidth, imageSize, showFileNameFor, view, viewMode, ratioVersion\]/.test(
      mediaPanelSrc,
    ),
);

check(
  "自适应行高的**变量行高虚拟化**按行号取高度（不是常量）",
  // 行内等高、行间不等——用常量 estimateSize 会让内容总高与滚动条长度全错。
  // `.tsx` 不能被 Node 直接加载（JSX 不是可剥离语法），故读**家族源码**。
  /export function useVariableRowVirtualizer\(/.test(mediaFamilySrc) &&
    /estimateSize: \(index\) => heightsRef\.current\[index\] \?\? 0/.test(mediaFamilySrc),
);

check(
  "宽高比是自适应配平的输入：纯函数带兜底（0 / 负数 / NaN 不得进入 flex 计算）并**量后缓存**",
  mediaView.imageRatio(1600, 900) === 1600 / 900 &&
    mediaView.imageRatio(900, 1600) === 900 / 1600 &&
    mediaView.imageRatio(0, 100) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.imageRatio(100, 0) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.imageRatio(Number.NaN, 5) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.imageRatio(-3, 5) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.DEFAULT_CELL_RATIO === 1 &&
    mediaView.AUDIO_CARD_RATIO === 1.5 &&
    // 单元（`mediaPreviewCell.tsx`）：以 `--mp-cell-ratio` 下发 + 解码后量一次并写缓存
    // （重挂载不再重排一遍）；音频没有宽高比，用固定卡片比例，免得在自适应里成一张方块。
    /"--mp-cell-ratio": String\(ratio\)/.test(mediaCellSrc) &&
    /const next = imageRatio\(naturalWidth, naturalHeight, ratio\);/.test(mediaCellSrc) &&
    // 写入口是 `setRatioCache`（**不是**直接 `ratioCache.set`）：它同时推进版本号，
    // 让面板重算瀑布流/自适应的行高——见上面那条"宽高比异步到达"的断言。
    /setRatioCache\(file\.id, next\);/.test(mediaCellSrc) &&
    /const ratios = new Map<string, number>\(\);/.test(ratioCacheSrc) &&
    !/new Map<string, number>\(\)/.test(mediaCellSrc) &&
    /file\.media_type === "audio"\s*\?\s*AUDIO_CARD_RATIO/.test(mediaCellSrc) &&
    // 面板必须真的用它渲染条目（不是留着两条渲染路径）。
    /import \{ ThumbCell, getRatioCacheVersion, subscribeRatioChange \} from "\.\/mediaPreviewCell";/.test(mediaPanelSrc) &&
    /import \{ getCachedRatio \} from "\.\.\/shared\/ratioCache";/.test(mediaPanelSrc) &&
    /<ThumbCell/.test(mediaPanelSrc),
);
check(
  "三种视图都**居中对齐**（图片宽度定死时余量左右均分，不许堆在右边留一条空白）；自适应被行高上限截住的行同理",
  /\.mp-grid\.mp-view-tile\s*\{[^}]*justify-content:\s*center/.test(stylesSource) &&
    // 自适应：断行改由 JS 后，居中落在**行容器**上（每一行各自居中；见第 6 轮的路线 2）。
    /\.mp-virtual-row\.mp-virtual-adaptive\s*\{[^}]*justify-content:\s*center/.test(stylesSource) &&
    /\.mp-masonry\s*\{[^}]*justify-content:\s*center/.test(stylesSource),
);

}
