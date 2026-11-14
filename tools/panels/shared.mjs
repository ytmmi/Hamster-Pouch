// 面板门禁的共享真值层（D189）：被两个以上分节用到的源码常量、派生值与 TS 模块句柄
// 都集中在这里，逐字搬自拆分前的 prelude 与各分节顶层。断言一条都不在这里。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 图书桥接自 D181 起按职责拆成 `book/{mod,cache,paging,cover}.rs`。下面这些断言校验的是
// **桥接层整体**的行为（媒体类型分流 / 命令形态 / 封面落盘 / 渐进读取），拆文件不该让任何一条
// 静默失效，所以统一拼成一份源码再匹配——正则看到的内容与拆分前逐字相同。
export const BOOK_BRIDGE_SRC = ["mod", "cache", "paging", "cover", "source"]
  .map((name) =>
    readFileSync(join(ROOT, `apps/desktop/src-tauri/src/commands/book/${name}.rs`), "utf8"),
  )
  .join("\n");

// 文件命令族自 D217 起按职责拆成 `file/{mod,preview,task}.rs`：命令形态、缩略图分流、
// 原图回退三条判据分散在不同文件里，断言仍按「桥接层整体」匹配，拼成一份源码再跑正则。
export const FILE_BRIDGE_SRC = ["mod", "preview", "task"]
  .map((name) =>
    readFileSync(join(ROOT, `apps/desktop/src-tauri/src/commands/file/${name}.rs`), "utf8"),
  )
  .join("\n");

export const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);
// `.tsx` 不能直接被 Node 的 TS 剥离加载（JSX 不是可剥离语法），因此组件表用**源码解析**
// 断言（与 `tools/control-check.mjs` 对 `ControlRenderer.tsx` 的做法一致）。
export const registrySource = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/panelRegistry.tsx"),
  "utf8",
);
// 内置面板的渲染表 `RENDERERS`：只按 id 给出渲染体（id / titleKey 的唯一真值在
// `packages/config/src/panels.ts`）。这里解析它的**键集**，用来断言"注册表里的每个内置面板
// 都有渲染体、且没有多余键"。
export const renderersStart = registrySource.indexOf("const RENDERERS");
export const renderersEnd = registrySource.indexOf("\n};", renderersStart);
export const rendererKeys =
  renderersStart < 0 || renderersEnd < 0
    ? []
    : [...registrySource.slice(renderersStart, renderersEnd).matchAll(/^ {2}([a-z]+):/gm)].map(
        (m) => m[1],
      );
// 反向断言用：旧写法是每条 `{ id: "…", titleKey: "…", render: … }` 字面量。
export const handCopiedPanelDefs = [
  ...registrySource.matchAll(/\{ id: "[^"]+", titleKey: "[^"]+", render:/g),
].map((m) => m[0]);
export const panelDefsDerived = registrySource.includes("BUILTIN_PANEL_SPECS.map((spec) => ({");

export const doc = readFileSync(join(ROOT, "docs/spec/panel-standard.md"), "utf8");
export const rustPanels = readFileSync(join(ROOT, "crates/hp-core/src/panel_types.rs"), "utf8");

// 被断言的前端源码：**提前读**，供多处断言共用。
// （写在断言之后会踩 `const` 的 TDZ 陷阱：脚本是顺序执行的，不是函数体。）
export const viewerSettingsSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/useViewerSettings.ts"),
  "utf8",
);
export const settingValueSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/settingValue.ts"),
  "utf8",
);
export const viewerPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/ViewerPanel.tsx"),
  "utf8",
);
export const metadataPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MetadataPanel.tsx"),
  "utf8",
);
export const settingsAppSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/settings/SettingsApp.tsx"),
  "utf8",
);
export const stylesSource = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
  "utf8",
);

export const builtinIds = config.BUILTIN_PANEL_SPECS.map((s) => s.id);

export const imageViewerSpec = config.panelSpec("imageviewer");

export const optionValues = (panelId, key) =>
  (config.panelSpec(panelId)?.settings?.find((s) => s.key === key)?.options ?? []).map(
    (o) => o.value,
  );

export const viewerReaderSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/viewer/ViewerReader.tsx"),
  "utf8",
);

export const MEDIA_FAMILY_FILES = [
  "apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewData.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewPaging.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewVirtual.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewVirtualRows.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewScroll.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewSession.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewToolbar.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewActions.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewMenu.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewSelection.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewCell.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewDropdown.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewView.ts",
];

export const mediaActionsSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewActions.ts"),
  "utf8",
);

export const mediaView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewView.ts")).href
);

export const mediaPaging = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewPaging.ts")).href
);

export const pageStub = (pages) => {
  const calls = [];
  let index = 0;
  const fetchPage = async (cursor) => {
    calls.push(cursor);
    const page = pages[index++];
    // 取数次数超出预期时抛错而不是挂住：死循环在测试里要**立刻失败**，不是等超时。
    if (!page) throw new Error(`取数次数超出预期（第 ${index} 次）`);
    return page;
  };
  return { fetchPage, calls };
};

export const fileAt = (n) => ({ id: `f${n}` });

export const scroll = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewScroll.ts")).href
);

export const masonry = mediaView.distributeColumns([1, 2, 3, 4, 5, 6, 7], 3);

export const format = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/format.ts")).href
);

export const viewerInfoBarSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ViewerInfoBar.tsx"),
  "utf8",
);

export const imageViewerPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ImageViewerPanel.tsx"),
  "utf8",
);

export const mediaSortStore = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/core/mediaSortStore.ts")).href
);

export const preload = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPreload.ts")).href
);

export const repoDisplay = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/repoDisplay.ts")).href
);

export const BOOK_FAMILY_FILES = [
  "apps/desktop/src/app_ui/panels/bookpreview/BookPreviewPanel.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/BookCard.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/BookListRow.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/BookCoverCell.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/BookRowInfo.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/BookCoverArt.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/BookTextCover.tsx",
  "apps/desktop/src/app_ui/panels/bookpreview/bookPreviewData.ts",
  "apps/desktop/src/app_ui/panels/bookpreview/bookPreviewView.ts",
  "apps/desktop/src/app_ui/panels/bookpreview/bookMetaCache.ts",
  "apps/desktop/src/app_ui/panels/bookpreview/useBookMeta.ts",
  // 封面覆盖（用户口径 2026-10-09："txt 右键可以更换封面颜色或自定义图片"）
  "apps/desktop/src/app_ui/panels/bookpreview/bookCoverCache.ts",
  "apps/desktop/src/app_ui/panels/bookpreview/useBookCoverOverride.ts",
  "apps/desktop/src/app_ui/panels/bookpreview/BookCoverMenu.tsx",
];

