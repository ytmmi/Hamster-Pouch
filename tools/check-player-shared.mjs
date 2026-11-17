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

// 焦点落在**哪个节点**因面板而异（播放器/查看器/媒体预览是面板根，阅读器是阅读区，
// 蓝图是画布），所以这里只约束"用同一个钩子、且第二参是某个 ref"，不锁具体名字。
const HOOK = /usePanelFocusOnActivate\((?:panelApi|api), \w+Ref\)/;
const MEDIA_PREVIEW = "panels/MediaPreviewPanel.tsx";
const READER_STAGE = "panels/bookreader/ReaderStage.tsx";
const BLUEPRINT_CANVAS = "panels/BlueprintCanvas.tsx";
const panelsWithFocus = [
  VIDEO_PANEL,
  MUSIC_PANEL,
  VIEWER_PANEL,
  MEDIA_PREVIEW,
  READER_STAGE,
  BLUEPRINT_CANVAS,
];
report(
  "面板激活即取键盘焦点只有一份实现（shared/panelFocus.ts，六个面板共用）",
  read(PANEL_FOCUS).includes("export function usePanelFocusOnActivate(") &&
    read(PANEL_FOCUS).includes("requestAnimationFrame(") &&
    read(PANEL_FOCUS).includes("enteredRef.current = active;") &&
    read(PANEL_FOCUS).includes("shouldTakePanelFocus(document.activeElement)") &&
    read(PANEL_FOCUS).includes("pointerRef.current = Date.now();") &&
    read(PANEL_FOCUS).includes("const byPointer = Date.now() - pointerRef.current < 600;") &&
    read(PANEL_FOCUS).includes("cancelAnimationFrame(frameRef.current)") &&
    read(FOCUS_TARGET).includes("export function shouldTakePanelFocus(") &&
    files.every((f) => f.rel === PANEL_FOCUS || !/function usePanelFocusOnActivate\s*\(/.test(f.text)) &&
    panelsWithFocus.every((rel) => HOOK.test(read(rel)) && read(rel).includes("shared/panelFocus")) &&
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

/**
 * D234：拖动进度条期间以本地值为准。
 *
 * 视频面板一直有这套时序，音乐面板没有——于是音乐面板拖到一半就被 ~4Hz 的
 * `timeupdate` 用元素真实位置覆盖回去，thumb 弹回旧位置，松手时 `event.target.value`
 * 读到的也是旧值，表现为"点了进度条却没跳"（偶发，取决于 timeupdate 落不落在拖动窗口里）。
 * 四处必须同时在场，少一处就等于没修：
 * ① `onTimeUpdate` / `onSeeked` 都有 `!scrubbingRef.current` 守卫；
 * ② 拖动用 `onScrub` 只落本地值、松手用 `onScrubCommit` 才走唯一入口 `commitSeek`；
 * ③ 显示的播放头是 `displayPosition = scrubMs ?? positionMs`；
 * ④ 换曲时清残留（`scrubbingRef.current = false` + `setScrubMs(null)` ≥2 处：载入 + 预载）。
 */
const guardedByScrub = (src, name) => {
  const start = src.indexOf(`const ${name} = () => {`);
  if (start < 0) return false;
  const end = src.indexOf("\n  };", start);
  const body = end > start ? src.slice(start, end) : src.slice(start, start + 400);
  // 守卫必须就在 setPositionMs 外面：allow 只在"函数体内"匹配，防止借下一个函数的守卫蒙混过关。
  return /if \([^)]*!scrubbingRef\.current\)\s*\{[^}]*setPositionMs\(/.test(body);
};

report(
  "两个播放面板的进度条都\"拖动中本地为准\"（守卫 / onScrub / displayPosition / 换曲清残留）",
  [VIDEO_PANEL, MUSIC_PANEL].every((rel) => {
    const src = read(rel);
    const resets = (src.match(/setScrubMs\(null\)/g) ?? []).length;
    return (
      guardedByScrub(src, "onTimeUpdate") &&
      guardedByScrub(src, "onSeeked") &&
      /const onScrub = \(\w+: number\) => \{[\s\S]{0,120}?scrubbingRef\.current = true;/.test(src) &&
      /const onScrubCommit = \(\w+: number\) => \{[\s\S]{0,160}?scrubbingRef\.current = false;[\s\S]{0,80}?setScrubMs\(null\);[\s\S]{0,80}?commitSeek\(\w+\);/.test(
        src,
      ) &&
      /const displayPosition = scrubMs \?\? positionMs;/.test(src) &&
      /positionMs=\{displayPosition\}/.test(src) &&
      resets >= 2
    );
  }),
);

console.log(`\n[check-player-shared] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
