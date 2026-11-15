#!/usr/bin/env node
/**
 * D211：播放器公共件各只有一份。
 *
 * 时间格式、音量夹紧与音量图标原先在视频面板与音乐面板各写一遍（`formatMs` 逐字相同、
 * `clampVolume` 只差兜底常量、喇叭图标两套几何）；音乐字形则全塞在 1000 行的
 * `MusicStage.tsx` 里。这份门禁钉住「定义只在 shared/ 与 music/icons.tsx」这一件事——
 * 少一处就会重新长出第二份，而两份实现里只有一份会被修。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const UI = join(ROOT, "apps/desktop/src/app_ui");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(abs);
  }
  return out;
}

const files = walk(UI).map((abs) => ({
  rel: relative(UI, abs).replace(/\\/g, "/"),
  text: readFileSync(abs, "utf8"),
}));

const TIME = "panels/shared/time.ts";
const VOLUME = "panels/shared/volume.ts";
const SHARED_ICONS = "panels/shared/icons.tsx";
const MUSIC_ICONS = "panels/music/icons.tsx";
const VIDEO_PANEL = "panels/MediaPlayerPanel.tsx";
const MUSIC_PANEL = "panels/MusicPlayerPanel.tsx";
const MUSIC_STAGE = "panels/music/MusicStage.tsx";

const byRel = new Map(files.map((f) => [f.rel, f.text]));
const read = (rel) => byRel.get(rel) ?? "";

let passed = 0;
let total = 0;
function report(label, ok, detail) {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const TIME_FUNCS = ["formatMs", "formatClock", "formatRemaining"];
report(
  "时间格式只在 panels/shared/time.ts 定义（视频与音乐共用一套）",
  TIME_FUNCS.every((fn) => read(TIME).includes(`export function ${fn}(`)) &&
    files.every(
      (f) =>
        f.rel === TIME ||
        !TIME_FUNCS.some((fn) => new RegExp(`function ${fn}\\s*\\(`).test(f.text)),
    ) &&
    read(VIDEO_PANEL).includes('from "./shared/time"') &&
    read(MUSIC_STAGE).includes('from "../shared/time"'),
);

report(
  "音量夹紧只在 panels/shared/volume.ts 定义（兜底默认值各自传）",
  read(VOLUME).includes("export function clampVolume(value: number, fallback: number)") &&
    files.every(
      (f) => f.rel === VOLUME || !/function clampVolume\s*\(/.test(f.text),
    ) &&
    read(VIDEO_PANEL).includes('from "./shared/volume"') &&
    read(MUSIC_PANEL).includes('from "./shared/volume"') &&
    /clampVolume\(storedVolume, PLAYER_VOLUME_DEFAULT\)/.test(read(VIDEO_PANEL)) &&
    /clampVolume\(storedVolume, MUSIC_VOLUME_DEFAULT\)/.test(read(MUSIC_PANEL)),
);

report(
  "音量图标只在 panels/shared/icons.tsx 定义（尺寸与静音叉由调用方指定）",
  read(SHARED_ICONS).includes("export function VolumeIcon(") &&
    read(SHARED_ICONS).includes("muteMark = true") &&
    files.every(
      (f) => f.rel === SHARED_ICONS || !/function VolumeIcon\s*\(/.test(f.text),
    ) &&
    read(VIDEO_PANEL).includes('import { VolumeIcon } from "./shared/icons"') &&
    read(MUSIC_STAGE).includes('import { VolumeIcon } from "../shared/icons"') &&
    /<VolumeIcon volume=\{volume\} size=\{15\} muteMark=\{false\} \/>/.test(read(MUSIC_STAGE)),
);

const GLYPHS = [
  "FavoriteIcon",
  "PlayIcon",
  "PauseIcon",
  "PrevIcon",
  "NextIcon",
  "ShuffleIcon",
  "RepeatIcon",
  "RepeatOneIcon",
  "StarIcon",
  "HeartIcon",
];
report(
  "音乐字形只在 panels/music/icons.tsx 定义（舞台只负责渲染）",
  GLYPHS.every((name) => new RegExp(`export function ${name}\\s*\\(`).test(read(MUSIC_ICONS))) &&
    files.every((f) => f.rel === MUSIC_ICONS || !GLYPHS.some((n) => new RegExp(`function ${n}\\s*\\(`).test(f.text))) &&
    read(MUSIC_STAGE).includes('from "./icons"') &&
    !read(MUSIC_STAGE).includes("<svg"),
);

// ==================== D220：面板激活即取键盘焦点 ====================
//
// 两条用户报障（进度条拖不动 / 音乐面板方向键与空格不响应）是同一个毛病的两面：
// ① 媒体播放器根节点的 `onPointerDown` 在 pointerdown 里同步调 `panel.api.setActive()`，
//    面板 DOM 因此重新挂载/重排，浏览器随即取消 `mousedown` 兼容事件——原生 range 的
//    拖拽永不启动（进度条、音量条都拖不动）；② 点标签切面板后焦点留在标签元素上，
//    面板根的 `onKeyDown` 收不到键（方向键被 dockview 拿去移动标签）。
// 修法：激活即取焦点只留一份实现（`shared/panelFocus.ts`），根节点点击**只聚焦**。
const FOCUS_TARGET = "shared/focusTarget.ts";
const PANEL_FOCUS = "shared/panelFocus.ts";
const VIEWER_PANEL = "panels/imageviewer/ImageViewerPanel.tsx";

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const HOOK = "usePanelFocusOnActivate(panelApi, rootRef)";
const panelsWithFocus = [VIDEO_PANEL, MUSIC_PANEL, VIEWER_PANEL];
report(
  "面板激活即取键盘焦点只有一份实现（shared/panelFocus.ts，三个面板共用）",
  read(PANEL_FOCUS).includes("export function usePanelFocusOnActivate(") &&
    read(PANEL_FOCUS).includes("requestAnimationFrame(") &&
    read(PANEL_FOCUS).includes("enteredRef.current = active;") &&
    read(PANEL_FOCUS).includes("shouldTakePanelFocus(document.activeElement)") &&
    read(PANEL_FOCUS).includes("pointerRef.current = Date.now();") &&
    read(PANEL_FOCUS).includes("const byPointer = Date.now() - pointerRef.current < 600;") &&
    read(PANEL_FOCUS).includes("cancelAnimationFrame(frameRef.current)") &&
    read(FOCUS_TARGET).includes("export function shouldTakePanelFocus(") &&
    files.every((f) => f.rel === PANEL_FOCUS || !/function usePanelFocusOnActivate\s*\(/.test(f.text)) &&
    panelsWithFocus.every((rel) => read(rel).includes(HOOK) && read(rel).includes("shared/panelFocus")) &&
    // 查看器不再自带那段内联实现（曾只有它有，另外两个面板根本没有）。
    !/enteredRef|focusFrameRef/.test(read(VIEWER_PANEL)),
);

report(
  "面板根不得用 setActive() 抢激活（pointerdown 里同步激活会打断原生 range 拖拽）",
  files.every(
    (f) =>
      !/panelApi\??\.setActive\??\(/.test(stripComments(f.text)) &&
      !/setActive\??\(\)\s*;\s*\/\/.*pointerdown/.test(f.text),
  ) &&
    /closest\("button, input, select, textarea"\)/.test(read(VIDEO_PANEL)) &&
    /rootRef\.current\?\.focus\(\{ preventScroll: true \}\)/.test(read(VIDEO_PANEL)) &&
    /ref=\{rootRef\}/.test(read(VIDEO_PANEL)),
);

report(
  "进度条左端按已播时间显示 0:00（formatClock）而不是 --:--（formatMs 对 0 的占位）",
  /formatClock\(displayPosition\)/.test(read(VIDEO_PANEL)) &&
    /formatMs\(durationMs\)/.test(read(VIDEO_PANEL)) &&
    !/formatMs\(displayPosition\)/.test(read(VIDEO_PANEL)),
);

console.log(`\n[check-player-shared] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
