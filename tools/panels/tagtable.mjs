/**
 * 面板门禁分节 · tag 表：媒体拖放打标与选中框（原第 37 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, stripComments } from "./harness.mjs";
import { ROOT, masonry } from "./shared.mjs";
export default async function run() {
// ==================== tag表：媒体拖放打标 + 媒体预览选中框（D117，2026-10-19）====================
//
// 用户两条直接要求：①「媒体单选或多选拖拽到 tag 表内，悬浮在某个 tag 上面时 tag 出现蓝色框
// 标识，鼠标放下代表把刚刚选择的媒体加上该 tag」，且「标签 评分」面板同步更新；②「在媒体
// 预览面板，选择媒体的提示框进行加粗」（澄清：指**被点击的媒体外面那个框**太细，不是计数文案）。
//
// 这里断言的是**契约性落点**，不是像素观感（观感由 `archive/` 的无头探针量计算值）：
// 载荷判据只能写在 `onDragOver`（拖拽中 `getData` 受保护模式限制，只有 `types` 可读）、
// 落点必须复用既有 `tag.add`（按名幂等）而不是新命令、同步必须走 `app.refresh()`、
// 媒体落在空白处**不得**被当成 tag 移动。

check(
  "tag表：媒体拖放打标（`application/x-hp-files` → `tag.add` → `app.refresh()` 同步「标签 评分」）",
  (() => {
    const src = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/TagTablePanel.tsx"),
      "utf8",
    );
    const code = stripComments(src);
    const dropFiles = code.match(/const dropFilesOnNode = async[\s\S]*?\n  \};/)?.[0] ?? "";
    return (
      // 载荷 MIME 与媒体预览同源（不能自造第二套）。
      /const FILES_MIME = "application\/x-hp-files"/.test(code) &&
      // 判据用 `types`（`getData` 在 dragover 阶段读不到）：三处 —— 行 dragover、行 drop、空白 drop。
      (code.match(/dataTransfer\.types\.includes\(FILES_MIME\)/g) ?? []).length >= 3 &&
      // **反面**：`getData` 只允许出现在解析函数里一次（放进 dragover 会永远拿到空串）。
      (code.match(/\.getData\(/g) ?? []).length === 1 &&
      // 高亮是**独立属性**：与 tag 移动的 `data-drop` 分开，两种语义不能共用一个状态。
      /data-drop-files=\{fileDropId === node\.id \? "1" : undefined\}/.test(code) &&
      /data-drop=\{dropTargetId === node\.id \? "1" : undefined\}/.test(code) &&
      // 落点复用既有 `tag.add`（`create_tag` 同仓库同名返回已有实体）——不新增命令。
      /api\.tagAdd\(\{ repoId: app\.repoId, fileIds, tagName: target\.name \}\)/.test(dropFiles) &&
      // 同步：`refreshKey` 递增 ⇒ 本面板重拉树、「标签 评分」面板重拉所选文件的 tag。
      /app\.refresh\(\)/.test(dropFiles) &&
      // **反面**：媒体落在空白处不得走 tag 移动（否则会静默把 tag 挪到根）。
      /if \(e\.dataTransfer\.types\.includes\(FILES_MIME\)\) return;[\s\S]{0,40}?void dropOnRoot\(\);/.test(
        code,
      )
    );
  })(),
);

check(
  "CSS：tag表媒体拖放目标的**蓝色框**（2px + 焦点环色，与 tag 移动的 1px 高亮区分）",
  (() => {
    const css = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    return (
      /\.tag-tree-row\[data-drop-files="1"\]\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/.test(
        css,
      ) &&
      // 既有 D24 移动高亮必须保留（两条规则并存，互不覆盖）。
      /\.tag-tree-row\[data-drop="1"\]\s*\{[^}]*outline:\s*1px solid var\(--focus-ring\)/.test(
        css,
      )
    );
  })(),
);

check(
  "CSS：媒体预览**选中框加粗**（三视图同一套 `--sel-ring`，不再用浅灰 `--sel-border`）",
  (() => {
    const cssRaw = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
      "utf8",
    );
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
    return (
      // 专用 token 在**两套主题**都有定义（浅色灰线正是"太细看不出来"的成因）。
      /--sel-ring:\s*#[0-9a-f]{6}/.test(css) &&
      /\.app-root\.theme-dark\s*\{[^}]*--sel-ring:/.test(css) &&
      // 平铺 / 瀑布流：选中单元换色 + 外扩同色环（1px 灰边不够）。
      /\.mp-cell\.selected\s*\{[^}]*border-color:\s*var\(--sel-ring\)/.test(css) &&
      /\.mp-cell\.selected\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--sel-ring\)/.test(css) &&
      // 列表视图同样加粗（行高更小，环取 1px 以免相邻行粘连）。
      /\.mp-row\.selected\s*\{[^}]*border-color:\s*var\(--sel-ring\)/.test(css) &&
      /\.mp-row\.selected\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--sel-ring\)/.test(css) &&
      // 自适应视图没有 border（几何由 flex 决定），只能靠 outline —— 必须仍在同一选择器上
      // 保留 `outline-color`（既有门禁也断言这一条），并加粗到 2px。
      /\.mp-view-adaptive \.mp-cell\.selected\s*\{[^}]*outline-color:\s*var\(--sel-ring\)/.test(
        css,
      ) &&
      /\.mp-view-adaptive \.mp-cell\.selected\s*\{[^}]*outline-width:\s*2px/.test(css) &&
      // 单元基础盒模型不变（既有断言依赖 padding/border，选中靠叠加环而非改尺寸）。
      /\.mp-cell\s*\{[^}]*padding:\s*4px/.test(css) &&
      /\.mp-cell\s*\{[^}]*border:\s*1px solid transparent/.test(css)
    );
  })(),
);

check(
  "CSS：媒体预览容器留出**纵向**内边距，选中环不再被滚动容器裁掉（D117-R1）",
  (() => {
    const css = readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    /*
     * 成因（用户 m01342「第一层媒体的蓝色选择框顶部被遮挡了一点」）：选中环是
     * `box-shadow`，画在**边框盒之外**且不参与布局；而 `overflow: auto` 把后代裁在
     * **内边距盒**边界上。容器纵向内边距为 0 时首行那圈环整条落在裁切线外。
     *
     * 因此钉住三件事：①三个滚动容器（`.mp-grid` 覆盖平铺与自适应、`.mp-masonry`、
     * `.mp-list`）都拿到同一条规则；②留出的量 ≥ 4px（= 最宽环 2px **加 2px 余量**：
     * 环外缘与裁切线恰好重合时，分数像素会磨掉边缘，余量让"完整可见"不依赖像素对齐）；
     * ③**只有纵向** —— 横向内边距会计入 `clientWidth`，而列数正是按 `clientWidth`
     * 算的（`masonryColumnCount`），加横向 padding 会少算一列。
     */
    const rule =
      css.match(/\.mp-grid,\s*\.mp-masonry,\s*\.mp-list\s*\{[^}]*\}/)?.[0] ?? "";
    const blockPx = parseFloat(
      rule.match(/padding-block:\s*([\d.]+)px/)?.[1] ?? "0",
    );
    // `padding-block` 不会被这个模式命中（`padding` 后面接的是 `-block`，不是 `:`）。
    const noInlinePadding = !/padding(?:-inline|-left|-right)?\s*:/.test(rule);
    return blockPx >= 4 && noInlinePadding;
  })(),
);

check(
  "i18n：拖放打标两条文案三语齐备（D27 键集一致由类型强制，这里钉住键存在）",
  (() => {
    const read = (f) =>
      readFileSync(join(ROOT, `apps/desktop/src/app_ui/i18n/${f}`), "utf8");
    const zhCN = read("zh-CN.ts");
    const zhTW = read("zh-TW.ts");
    const en = read("en.ts");
    const has = (src, key) => new RegExp(`"${key}":`).test(src);
    return (
      has(zhCN, "tagtable.dropAdded") &&
      has(zhCN, "tagtable.dropFailed") &&
      has(zhTW, "tagtable.dropAdded") &&
      has(zhTW, "tagtable.dropFailed") &&
      has(en, "tagtable.dropAdded") &&
      has(en, "tagtable.dropFailed") &&
      // 成功文案必须带**数量与 tag 名**：只说"已添加"无法确认加到了哪个 tag。
      /\{count\}/.test(zhCN) &&
      /tagtable\.dropAdded": "[^"]*\{count\}[^"]*\{name\}/.test(zhCN)
    );
  })(),
);

// ---- D138：相册 / 源面板把**面板标记**并入蓝图上报 ----
//
// 用户口径（2026-11-02）：「相册链里的标记需要命中，并把源面板的标记也一起修复，标记就是
// 为了给单个对象进行精确细分，注意，标记不改变对象性质，只是作为对象的限制条件，是可选项，
// 功能和名称一致，即"标记"。」
//
// 这两个面板的标记存在**面板本地**（`shared/panelMarks.ts`，落 `app_settings` 的
// `panelMarks.<repoId>`），与文件表的 `file_marks` 是两套存储。D138 之前，相册行的
// `app.dispatch` 恒报 `marks: []`、源面板行根本不 dispatch ⇒ 画布上
// 「类目 → 对象 → 标记 → 操作」在运行时永远求值不到，而标记的语义正是**对象的限制条件**，
// 不上报就等于这条链没有任何条件可判。本组断言钉住"上报真的带上了标记"。
{
  const panelSrc = (rel) => stripComments(readFileSync(join(ROOT, rel), "utf8"));
  const albumSrc = panelSrc("apps/desktop/src/app_ui/panels/AlbumPanel.tsx");
  // 相册树规则在 D210 搬到 panels/album/tree.ts：包含判定等断言读那个文件。
  const albumTreeSrc = panelSrc("apps/desktop/src/app_ui/panels/album/tree.ts");
  const sourceSrc = panelSrc("apps/desktop/src/app_ui/panels/SourcePanel.tsx");
  const markMenuSrc = panelSrc("apps/desktop/src/app_ui/panels/markMenu.tsx");
  const marksMod = await import(
    pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/panelMarks.ts")).href
  );

  check(
    'D138：相册行上报 `mediaType: "album"` + `fileId: 相册 id`（面板身份 > 行内 media_type）',
    /mediaType:\s*"album"/.test(albumSrc) && /fileId:\s*node\.id/.test(albumSrc),
    '相册行的真实 media_type 是 multimedia/image/空，透传会与类目的 "album" 精确比较失败',
  );
  check(
    'D138/D139：相册上报的 `marks` 是**已落库的有效标记**（`effectiveMarksFor(…, "albums", 相册 id)`），不再恒为 `[]`',
    /effectiveMarksFor\(\s*marks,\s*"albums",\s*node\.id\s*\)/.test(albumSrc) &&
      // 反面：旧实现那句 `marks: []` 不得复活（否则标记轴对相册天然不可命中）。
      !/marks:\s*\[\s*\]/.test(albumSrc),
  );
  check(
    'D138：源面板行点击**真的上报**（此前完全不上报）：`click` + `mediaType: "source"` + `fileId: 节点 key`',
    /app\.dispatch\(\{\s*trigger:\s*"click"/.test(sourceSrc) &&
      /mediaType:\s*"source"/.test(sourceSrc) &&
      /fileId:\s*node\.key/.test(sourceSrc),
    "源面板此前只有 setSourceId/setDirPath/setAlbumId，没有任何 dispatch",
  );
  check(
    "D138：源面板 `marks` 取 `sources` 域并按节点 key 取（与右键菜单 `markTargetKey()` 同口径）",
    /marks:\s*marksOf\(\s*marks,\s*"sources",\s*node\.key\s*\)/.test(sourceSrc),
  );

  // 行为断言：`effectiveMarksFor` 只做集合合并，不改匹配语义
  // ——标记仍是可选项（链上没有标记节点时完全不参与判定）。
  const marksBase = marksMod.emptyPanelMarksState();
  const userMarked = marksMod.setMark(marksBase, "albums", "a1", "manga", true);
  check(
    "D138：`effectiveMarksFor` 就是已落库的标记集合（无额外并入时不复制、不追加）",
    JSON.stringify(marksMod.effectiveMarksFor(userMarked, "albums", "a1")) ===
      JSON.stringify(["manga"]) &&
      // 没打标 ⇒ 空集合（标记是可选项，不是隐式约束）。
      marksMod.effectiveMarksFor(marksBase, "albums", "a1").length === 0 &&
      // 目标键隔离：别的相册打不上。
      marksMod.effectiveMarksFor(userMarked, "albums", "a2").length === 0,
  );

  // ---- D139：自动标记落库、可取消、与用户标记行为一致 ----
  //
  // 用户口径（2026-11-05）：「如果用户没有更改此标记，就同步，如果改了就不同步，系统同步的
  // 标记为灰黑色（不是灰色，灰色是不可编辑），点击取消再点击回来就是用户标记，为黑色了」。
  check(
    "D139：`autoMarksForMediaType` —— `unlimited`/空不自动打标记，其余打同名标记",
    marksMod.autoMarksForMediaType("unlimited").length === 0 &&
      marksMod.autoMarksForMediaType(null).length === 0 &&
      marksMod.autoMarksForMediaType("")?.length === 0 &&
      JSON.stringify(marksMod.autoMarksForMediaType("multimedia")) === JSON.stringify(["media"]) &&
      JSON.stringify(marksMod.autoMarksForMediaType("image")) === JSON.stringify(["image"]),
  );
  {
    // 属性 = image → 自动打上 image，且记进 auto（菜单据此画灰黑色）。
    let s = marksMod.syncAlbumAutoMark(marksBase, "a1", "image");
    const autoOn = marksMod.isAutoMark(s, "albums", "a1", "image");
    const markedOn = JSON.stringify(marksMod.marksOf(s, "albums", "a1")) === JSON.stringify(["image"]);
    // 用户取消它 ⇒ 从 marks 摘掉并记进 dismissed（此后属性再变也不自动加回）。
    let s2 = marksMod.toggleMarkFromMenu(s, "albums", "a1", "image", false);
    const afterCancel = JSON.stringify(marksMod.marksOf(s2, "albums", "a1")) === "[]";
    const dismissed = marksMod.dismissedMarksOf(s2, "albums", "a1").includes("image");
    // 属性再变回 image（同步一次）⇒ 仍不加回。
    const s3 = marksMod.syncAlbumAutoMark(s2, "a1", "image");
    const stayedOff = marksMod.marksOf(s3, "albums", "a1").length === 0;
    // 用户再勾回来 ⇒ 变回**用户标记**（不在 auto、也不在 dismissed），画黑色。
    const s4 = marksMod.toggleMarkFromMenu(s3, "albums", "a1", "image", true);
    const backAsUser =
      JSON.stringify(marksMod.marksOf(s4, "albums", "a1")) === JSON.stringify(["image"]) &&
      !marksMod.isAutoMark(s4, "albums", "a1", "image") &&
      !marksMod.dismissedMarksOf(s4, "albums", "a1").includes("image");
    check(
      "D139：自动标记落库且**可取消**；取消后不再自动加回；重新勾上即转为用户标记（不再灰黑）",
      autoOn && markedOn && afterCancel && dismissed && stayedOff && backAsUser,
      `auto=${autoOn} marked=${markedOn} cancel=${afterCancel} dismissed=${dismissed} stay=${stayedOff} user=${backAsUser}`,
    );
  }
  {
    // 属性变更同步：auto 跟着变，用户亲手打过的不动，`unlimited` 会摘掉旧的自动标记。
    const s = marksMod.setMark(marksBase, "albums", "a1", "manga", true);
    const sAuto = marksMod.syncAlbumAutoMark(s, "a1", "video");
    const gotVideo = marksMod.marksOf(sAuto, "albums", "a1").includes("video");
    const sSwitch = marksMod.syncAlbumAutoMark(sAuto, "a1", "image");
    const afterSwitch =
      JSON.stringify(marksMod.marksOf(sSwitch, "albums", "a1")) ===
      JSON.stringify(["manga", "image"]);
    const sUnlimited = marksMod.syncAlbumAutoMark(sSwitch, "a1", "unlimited");
    const afterUnlimited =
      JSON.stringify(marksMod.marksOf(sUnlimited, "albums", "a1")) === JSON.stringify(["manga"]);
    // 幂等：同样的属性再同步一次不产生任何变化（同一个对象引用）。
    const sIdem = marksMod.syncAlbumAutoMark(sUnlimited, "a1", "unlimited");
    check(
      "D139：属性变更时自动标记跟着同步（换属性替换、`unlimited` 摘掉、用户标记不动、幂等）",
      gotVideo && afterSwitch && afterUnlimited && sIdem === sUnlimited,
      `video=${gotVideo} switch=${afterSwitch} unlimited=${afterUnlimited} idem=${sIdem === sUnlimited}`,
    );
  }
  check(
    "D139：自动标记同步接在**显式**媒体属性上（`syncAlbumAutoMark` + `album.media_type`，不沿父链继承）",
    /syncAlbumAutoMark\(/.test(albumSrc) &&
      /album\.media_type/.test(albumSrc) &&
      // 右键菜单要按 auto 集合配色（灰黑 vs 黑），不能再用旧的"恒勾不可取消"。
      /autoMarks=\{menuAutoMarks\}/.test(albumSrc) &&
      /autoMarksOf\(\s*marks,\s*"albums"/.test(albumSrc) &&
      !/is-derived/.test(albumSrc) &&
      !/derivedMarksForAlbum/.test(albumSrc),
  );
  check(
    "D139：`unlimited` 参与拖拽包含判定（与 `multimedia` 一样覆盖全部具体媒体）",
    /outer === "unlimited"/.test(albumTreeSrc),
  );
  check(
    "D139：相册属性菜单有「无限制」项，且新建相册默认 `unlimited`",
    /setAlbumMediaType\(menu\.albumId,\s*"unlimited"\)/.test(albumSrc) &&
      /album\.media\.unlimited/.test(albumSrc) &&
      // 新建（含子相册）显式传 unlimited，不再靠"继承"兜底。
      (albumSrc.match(/mediaType:\s*"unlimited"/g) ?? []).length >= 2 &&
      // 反面：旧默认 multimedia 的创建调用不得复活。
      !/mediaType:\s*"multimedia"/.test(albumSrc),
  );
  check(
    "D139：标记菜单只留「＋ 新建自定义标记」，自定义标记排在它下面（删掉旧标题与空态）",
    /mark\.menu\.customAdd/.test(markMenuSrc) &&
      // 反面：(a) 旧标题「自定义标记」与空态「暂无自定义标记」不得复活；
      !/mark\.menu\.customEmpty/.test(markMenuSrc) &&
      !/t\("mark\.menu\.custom"\)/.test(markMenuSrc) &&
      // (b) 自定义标记行必须出现在新建按钮**之后**（按钮在前、已建的在下）。
      markMenuSrc.indexOf("mark.menu.customAdd") <
        markMenuSrc.lastIndexOf("customNames.map") &&
      // (c) 旧的"不可取消"拦截点不得复活：勾选走 toggleMarkFromMenu，菜单里不再有 info 拦截。
      /toggleMarkFromMenu\(/.test(markMenuSrc) &&
      !/mark\.derived/.test(markMenuSrc),
  );
  check(
    "D138：相册的自动标记来自**显式**媒体属性（multimedia → media、image → image、unlimited → 空）",
    marksMod.derivedMarkOfMediaType("multimedia") === "media" &&
      marksMod.derivedMarkOfMediaType("image") === "image",
  );
}

// ---- D225：tag 表的删除入口 ----
//
// 立论：领域层 delete_tag 早就是完整删除（事务内清人工 tag / 自动 tag / tag 关系），
// 但桥接层没有任何调用方、界面上也没有入口 —— 建错的 tag 只能改名，永远留在库里。
// 本组断言钉住整条链的四个落点：漏任何一处，要么"菜单在但没有命令"，要么"删了但没真删"。
{
  const panelSrc = stripComments(
    readFileSync(join(ROOT, "apps/desktop/src/app_ui/panels/TagTablePanel.tsx"), "utf8"),
  );
  const tagApiSrc = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/api/tag.ts"), "utf8");
  const tagCmdSrc = readFileSync(
    join(ROOT, "apps/desktop/src-tauri/src/commands/tag.rs"),
    "utf8",
  );
  const bridgeMainSrc = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/main.rs"), "utf8");
  const i18nSrc = (f) => readFileSync(join(ROOT, "apps/desktop/src/app_ui/i18n/" + f), "utf8");

  check(
    "D225：tag 表右键菜单有「删除」，先 window.confirm 再调 tagDelete（不可撤销）",
    /t\("tagtable\.delete"\)/.test(panelSrc) &&
      /const deleteNode = async \(node: TagTreeNode\)/.test(panelSrc) &&
      /window\.confirm\(app\.t\("tagtable\.deleteConfirm", \{ name: node\.name \}\)\)/.test(
        panelSrc,
      ) &&
      /api\.tagDelete\(node\.id\)/.test(panelSrc) &&
      /app\.t\("tagtable\.deleted", \{ name: node\.name \}\)/.test(panelSrc) &&
      // 反面：确认框必须在删除请求**之前**（顺序反了就是"问完已经删完了"）。
      panelSrc.indexOf("window.confirm(") < panelSrc.indexOf("api.tagDelete("),
  );
  check(
    "D225：删除链路四个落点齐备（菜单 → tagDelete → tag_delete → 领域层 delete_tag）",
    /export function tagDelete\(tagId: string\): Promise<void>/.test(tagApiSrc) &&
      /invokeApi<void>\("tag_delete", \{ tagId \}\)/.test(tagApiSrc) &&
      /pub\(crate\) fn tag_delete\(tag_id: String, state: State<AppState>\) -> ApiResponse<\(\)>/.test(
        tagCmdSrc,
      ) &&
      /db\.delete_tag\(&tag_id\)/.test(tagCmdSrc) &&
      /commands::tag::tag_delete,/.test(bridgeMainSrc),
  );
  check(
    "D225：四条删除文案三语齐备（键集一致性由类型强制，这里钉住键真的存在）",
    ["tagtable.delete", "tagtable.deleteConfirm", "tagtable.deleteFailed", "tagtable.deleted"].every(
      (key) =>
        ["zh-CN.ts", "zh-TW.ts", "en.ts"].every((f) =>
          new RegExp('"' + key + '":').test(i18nSrc(f)),
        ),
    ),
  );
}
}
