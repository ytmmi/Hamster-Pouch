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

console.log(`\n[check-player-shared] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
