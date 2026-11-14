// check-stores.mjs：前端模块级 store 的订阅表只能有一份骨架（D205 护航门禁）。
//
// 为什么需要它：`playerPlayStore` / `musicPlayStore` / `taskStore` / `mediaSortStore` /
// `settingChangeStore` / `render/surfaceStatsStore` 原先各抄一遍「Set 订阅表 + 遍历通知」，
// 抄出来的语义并不一致——`surfaceStatsStore` 手写五个字段逐个比较（加字段忘了加比较就静默不刷新），
// `taskStore` 无条件通知（同一对象也重渲染），播放请求两份逐字同构却各自维护。
// D205 把骨架收进 `core/createStore.ts`（`createStore` / `createEventChannel`），本门禁把
// 「不许再抄回去」变成断言：六个受管模块里出现自建 `new Set<` 或手写通知循环即红。
//
// 同时钉住两条语义，它们是 `useSyncExternalStore` 的硬要求，靠注释守不住：
//   · 值没变不换引用、不发通知（`equals` 判等后提前返回）；
//   · 通知遍历订阅者**快照**（回调里退订不会跳过别人）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const APP_UI = join(ROOT, "apps", "desktop", "src", "app_ui");
const CREATE_STORE = join(APP_UI, "core", "createStore.ts");

/// 受管 store：文件（相对仓库根）与其应使用的骨架。
const STORES = [
  ["apps/desktop/src/app_ui/core/playerPlayStore.ts", "createStore"],
  ["apps/desktop/src/app_ui/core/musicPlayStore.ts", "createStore"],
  ["apps/desktop/src/app_ui/core/taskStore.ts", "createStore"],
  ["apps/desktop/src/app_ui/core/mediaSortStore.ts", "createStore"],
  ["apps/desktop/src/app_ui/core/settingChangeStore.ts", "createEventChannel"],
  ["apps/desktop/src/app_ui/render/surfaceStatsStore.ts", "createStore"],
];

let total = 0;
let passed = 0;
function report(ok, label, detail) {
  total += 1;
  if (ok) {
    passed += 1;
  }
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}`);
  if (!ok) {
    for (const line of detail.slice(0, 12)) console.log(`      ${line}`);
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(rel) {
  const abs = join(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

// ① 骨架存在且语义齐全
const skeleton = existsSync(CREATE_STORE) ? stripComments(readFileSync(CREATE_STORE, "utf8")) : "";
const skeletonProblems = [];
if (!skeleton) {
  skeletonProblems.push("apps/desktop/src/app_ui/core/createStore.ts 不存在");
} else {
  for (const needle of [
    "export function createStore<T>",
    "export function createEventChannel<Args",
    "export interface Store<T>",
  ]) {
    if (!skeleton.includes(needle)) skeletonProblems.push(`createStore.ts 缺少 ${needle}`);
  }
  // 值没变就不通知
  if (!/if \(equals\(current, next\)\) \{\s*return;/.test(skeleton)) {
    skeletonProblems.push("createStore.ts  没有「equals 判等后提前返回」（值不变会白通知、白换引用）");
  }
  // 通知遍历快照
  if (!/for \(const listener of \[\.\.\.listeners\]\)/.test(skeleton)) {
    skeletonProblems.push("createStore.ts  通知没有遍历订阅者快照（回调里退订会跳过后续监听方）");
  }
  if (!/return \(\) => \{\s*listeners\.delete\(listener\);/.test(skeleton)) {
    skeletonProblems.push("createStore.ts  subscribe 没有返回退订函数");
  }
}
report(skeletonProblems.length === 0, "订阅表骨架 createStore.ts 语义完整（判等 / 快照遍历 / 退订）", skeletonProblems);

// ② 六个受管 store 不再自建订阅表
const handRolled = [];
let delegated = 0;
for (const [rel, helper] of STORES) {
  const src = read(rel);
  if (src === null) {
    handRolled.push(`${rel}  文件不存在`);
    continue;
  }
  const body = stripComments(src);
  if (/new Set</.test(body)) handRolled.push(`${rel}  仍自建订阅表（new Set<…>）`);
  if (/for \(const \w+ of \[\.\.\.(listeners|\w+Listeners)\]\)/.test(body) || /for \(const \w+ of (listeners|\w+Listeners)\)/.test(body)) {
    handRolled.push(`${rel}  仍手写通知循环`);
  }
  if (!body.includes(`${helper}<`)) handRolled.push(`${rel}  没有使用 ${helper}`);
  if (/\.subscribe\(listener\)/.test(body)) delegated += 1;
}
if (delegated < STORES.length) {
  handRolled.push(`只有 ${delegated}/${STORES.length} 个 store 把 subscribe 委托给骨架`);
}
report(handRolled.length === 0, `六个模块级 store 共用一份订阅表骨架（${STORES.length} 个文件）`, handRolled);

// ③ 两个播放请求是**独立实例**（D166：共一条会让双击视频把音乐面板吵醒）
const playProblems = [];
const playerSrc = stripComments(read(STORES[0][0]) ?? "");
const musicSrc = stripComments(read(STORES[1][0]) ?? "");
if (!/const store = createStore<PlayRequest \| null>\(null\)/.test(playerSrc)) {
  playProblems.push("playerPlayStore.ts  没有自己的 createStore 实例");
}
if (!/const store: Store<PlayRequest \| null> = createStore<PlayRequest \| null>\(null\)/.test(musicSrc)) {
  playProblems.push("musicPlayStore.ts  没有自己的 createStore 实例（或从 playerPlayStore 借了实例）");
}
if (/from "\.\/playerPlayStore"/.test(musicSrc) && !/import type \{ PlayRequest \} from "\.\/playerPlayStore"/.test(musicSrc)) {
  playProblems.push("musicPlayStore.ts  除了类型之外还从 playerPlayStore 取了值（两面板会互相吵醒）");
}
report(playProblems.length === 0, "视频 / 音乐播放请求各持一个独立 store 实例", playProblems);

// ④ 宽高比缓存只有一份（D206：媒体预览与胶片栏共用 `shared/ratioCache`）
//
// 同一张图的宽高比原本由两个面板各量一次、各存一份：媒体预览的单元（`mediaPreviewCell`）
// 与图像查看器的胶片栏（`viewerFilmstripLayout`）。两处都是「解码后量一次，模块级存起来」，
// 于是切面板要重新解码、口径（校验 / LRU / 通知）还各写一套。现在本体与纪律只在
// `shared/ratioCache.ts` 一处，胶片栏把自己的历史名字转出去给调用方。
const ratioProblems = [];
const RATIO_MODULE = "apps/desktop/src/app_ui/shared/ratioCache.ts";
const ratioSrc = read(RATIO_MODULE);
if (ratioSrc === null) {
  ratioProblems.push(`${RATIO_MODULE}  不存在`);
} else {
  const body = stripComments(ratioSrc);
  for (const needle of [
    "const ratios = new Map<string, number>();",
    "export const RATIO_CACHE_MAX",
    "export function getCachedRatio(",
    "export function touchCachedRatio(",
    "export function setCachedRatio(",
    "export function seedCachedRatios(",
    "export function clearCachedRatios(",
    "export function ratioCacheVersion(",
    "export function subscribeRatioChange(",
    "while (ratios.size > RATIO_CACHE_MAX)",
  ]) {
    if (!body.includes(needle)) ratioProblems.push(`${RATIO_MODULE} 缺少 ${needle}`);
  }
}
for (const [rel, why] of [
  ["apps/desktop/src/app_ui/panels/mediaPreviewCell.tsx", "媒体预览单元"],
  ["apps/desktop/src/app_ui/panels/imageviewer/viewerFilmstripLayout.ts", "胶片栏几何"],
]) {
  const src = read(rel);
  if (src === null) {
    ratioProblems.push(`${rel}  文件不存在`);
    continue;
  }
  const body = stripComments(src);
  // 只钉「宽高比缓存」本身的两个旧形状（`idToIndex` 之类的普通 Map 不在此列）。
  if (/const ratioCache = new Map<string, number>\(\)/.test(body)) {
    ratioProblems.push(`${rel}  仍自建宽高比缓存（${why}）`);
  }
  if (/const ratioListeners = new Set</.test(body)) {
    ratioProblems.push(`${rel}  仍自建宽高比通知表（${why}）`);
  }
}
const filmstripSrc = stripComments(read("apps/desktop/src/app_ui/panels/imageviewer/viewerFilmstripLayout.ts") ?? "");
for (const alias of [
  "export const clearFilmstripRatioCache = clearCachedRatios;",
  "export const getCachedFilmstripRatio = getCachedRatio;",
  "export const seedFilmstripRatios = seedCachedRatios;",
  "export const setCachedFilmstripRatio = setCachedRatio;",
  "export const subscribeFilmstripRatios = subscribeRatioChange;",
  "export const touchCachedFilmstripRatio = touchCachedRatio;",
]) {
  if (!filmstripSrc.includes(alias)) {
    ratioProblems.push(`viewerFilmstripLayout.ts 没有转出 ${alias}（调用方会拿不到缓存）`);
  }
}
report(ratioProblems.length === 0, "宽高比缓存只有一份（媒体预览与胶片栏共用 shared/ratioCache）", ratioProblems);

console.log(`\n[check-stores] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
