/**
 * 树面板的共享件检查（D210）。
 *
 * 三类重复曾真实存在：折叠箭头三份（相册树 / 媒体源树 / 打标菜单）、文件夹图标两份、
 * 相册树规则与渲染混在同一个 1096 行组件里。这里把「只有一份」钉住，避免下次又复制一份。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const APP_UI = join(ROOT, "apps/desktop/src/app_ui");

let passed = 0;
let failed = 0;

function report(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failed += 1;
    console.log("  FAIL " + label + (detail ? "\n       " + detail : ""));
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(abs);
  }
  return out;
}

const relOf = (abs) => relative(APP_UI, abs).split("\\").join("/");
const read = (abs) => stripComments(readFileSync(abs, "utf8"));

const PANEL_SOURCES = walk(join(APP_UI, "panels"), []);
const ICONS = join(APP_UI, "panels/shared/icons.tsx");
const TREE = join(APP_UI, "panels/album/tree.ts");
const ALBUM = join(APP_UI, "panels/AlbumPanel.tsx");
const SOURCE = join(APP_UI, "panels/SourcePanel.tsx");
const MARK_MENU = join(APP_UI, "panels/markMenu.tsx");

console.log("[check-tree-panels] 树面板的共享件");

// 1. 图标只在 icons.tsx
const iconOwners = PANEL_SOURCES.filter((abs) => abs !== ICONS).filter((abs) => {
  const body = read(abs);
  return body.includes("tree-chevron-icon") || body.includes("tree-folder-icon");
});
report(
  iconOwners.length === 0,
  "树图标（折叠箭头 / 文件夹）的 SVG 只在 panels/shared/icons.tsx",
  iconOwners.length ? iconOwners.map(relOf).join("、") + "  仍在自建图标" : "",
);
const iconSrc = read(ICONS);
report(
  iconSrc.includes("export function ChevronIcon") && iconSrc.includes("export function FolderIcon"),
  "icons.tsx 提供 ChevronIcon / FolderIcon 两个导出",
  "缺少导出",
);

// 2. 相册树规则只在 album/tree.ts
const treeSrc = read(TREE);
const TREE_NEEDLES = [
  "export function buildAlbumTree(",
  "export function effectiveMediaType(",
  "export function containsMedia(",
  "export function isDescendantOf(",
  "export function edgeFromEvent(",
  "export const ALBUM_DRAG_MIME",
  "export const EDGE_RATIO",
];
const missing = TREE_NEEDLES.filter((needle) => !treeSrc.includes(needle));
report(missing.length === 0, "相册树规则集中在 panels/album/tree.ts", missing.length ? "缺少：" + missing.join("、") : "");
const albumSrc = read(ALBUM);
const DUP_DEFS = [
  "function buildAlbumTree(",
  "function effectiveMediaType(",
  "function containsMedia(",
  "function isDescendantOf(",
  "function edgeFromEvent(",
];
const dupDefs = DUP_DEFS.filter((needle) => albumSrc.includes(needle));
report(dupDefs.length === 0, "AlbumPanel.tsx 不再自己实现树规则", dupDefs.length ? "仍有：" + dupDefs.join("、") : "");
report(
  albumSrc.includes("from \"./album/tree\"") && albumSrc.includes("from \"./shared/icons\""),
  "AlbumPanel.tsx 从 album/tree 与 shared/icons 取用",
  "缺少其一",
);

// 3. 三个树面板共用图标
const consumers = [["AlbumPanel.tsx", ALBUM], ["SourcePanel.tsx", SOURCE], ["markMenu.tsx", MARK_MENU]];
const notShared = consumers.filter((pair) => !/from "\.\/shared\/icons"/.test(read(pair[1]))).map((pair) => pair[0]);
report(notShared.length === 0, "三个树面板都从 shared/icons 取图标", notShared.length ? notShared.join("、") + "  未接入" : "");

// 4. 反向：两棵树不再内联 SVG
report(
  !albumSrc.includes("<svg") && !read(SOURCE).includes("<svg"),
  "相册树与媒体源树不再内联 SVG",
  "仍有内联 <svg>",
);

const total = passed + failed;
console.log("\n[check-tree-panels] " + passed + "/" + total + " 通过");
if (failed > 0) process.exit(1);
