#!/usr/bin/env node
/**
 * 开发期用户数据（测试数据库）同步：按「文件夹为单位」复制 / 恢复。
 *
 * 数据落在应用文件夹内（`<exe 同目录>\data\`），按三类区分：
 *   system\（全局库 + 内置词库）、user\repos\（每仓库一个库）、plugins\（插件与扩展库）、
 *   thumbnails\（缓存）、debug.log。
 * 本脚本只搬运这个「用户数据文件夹」整体，不改动其内部结构，也不新建 devdata。
 *
 * 用法：
 *   node tools/sync-user-data.mjs              # 快照：用户数据 → backups/appdata/<时间戳>/
 *   node tools/sync-user-data.mjs --restore    # 恢复：最近一次快照 → 应用数据目录
 *   node tools/sync-user-data.mjs --list       # 列出已有快照
 *   node tools/sync-user-data.mjs --dir <路径>  # 指定应用数据目录（默认自动定位 release/debug 的 data）
 *
 * 约定：
 *   - 快照是「保留开发期测试数据」的手段：每次编译后执行一次（pnpm data:sync），测试库不丢。
 *   - 快照/恢复前请**先退出应用**：WAL 模式下一次写事务会同时改动 <db> / <db>-wal / <db>-shm，
 *     应用运行中复制可能拿到不一致的组合。
 *   - 发布构建（pnpm app:build = tauri build --no-bundle）**不执行**本脚本，
 *     构建产物里不包含任何用户数据（数据只留在 exe 同目录的 data\，从不进入 dist\ 或打包物）。
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ARGS = new Set(process.argv.slice(2));
const RESTORE = ARGS.has("--restore");
const LIST = ARGS.has("--list");

/** 应用数据目录默认候选：编译产物里 release/debug 的 exe 同目录 data\（先到先用）。 */
const DATA_CANDIDATES = [
  join(ROOT, "apps", "desktop", "src-tauri", "target", "release", "data"),
  join(ROOT, "apps", "desktop", "src-tauri", "target", "debug", "data"),
];

/** 自动定位默认数据目录：第一个存在的候选，否则取 release 候选（快照时会跳过不存在的源）。 */
function defaultDataDir() {
  return DATA_CANDIDATES.find((c) => existsSync(c)) ?? DATA_CANDIDATES[0];
}

const dirFlagIndex = process.argv.indexOf("--dir");
const DATA_DIR = resolve(
  dirFlagIndex >= 0 ? process.argv[dirFlagIndex + 1] : defaultDataDir(),
);
const SNAPSHOT_ROOT = join(ROOT, "backups", "appdata");

/** 递归复制 srcDir 的内容到 destDir（destDir 可已存在，合并覆盖）。 */
async function copyInto(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(srcDir, entry.name);
    const to = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyInto(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

/** 与 backups/ 既有命名一致：repo-2026-09-23T13-38-12-856Z → appdata-2026-09-23T13-38-12-856Z。 */
function stamp() {
  return `appdata-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function listSnapshots() {
  let entries;
  try {
    entries = await readdir(SNAPSHOT_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("appdata-"))
    .map((e) => e.name)
    .sort();
}

if (LIST) {
  const snaps = await listSnapshots();
  if (snaps.length === 0) {
    console.log("[sync-user-data] 暂无快照（backups/appdata/ 为空）");
  } else {
    console.log("[sync-user-data] 已有快照：");
    for (const name of snaps) console.log(`  ${name}`);
  }
  process.exit(0);
}

if (RESTORE) {
  const snaps = await listSnapshots();
  if (snaps.length === 0) {
    console.error("[sync-user-data] 没有可恢复的快照（backups/appdata/ 为空）");
    process.exit(1);
  }
  const latest = snaps[snaps.length - 1]; // ISO 命名按字典序即时间序
  const from = join(SNAPSHOT_ROOT, latest);
  await copyInto(from, DATA_DIR);
  console.log(`[sync-user-data] 已恢复: ${latest}\n  → ${DATA_DIR}`);
  console.log("[sync-user-data] 请先确认应用已退出（WAL 库恢复期间勿运行应用）");
  process.exit(0);
}

// 默认动作：快照（保留开发期用户数据）
let exists = false;
try {
  exists = (await stat(DATA_DIR)).isDirectory();
} catch {
  exists = false;
}
if (!exists) {
  console.log(`[sync-user-data] 应用数据目录不存在，跳过快照: ${DATA_DIR}`);
  process.exit(0);
}
const snapDir = join(SNAPSHOT_ROOT, stamp());
await copyInto(DATA_DIR, snapDir);
console.log(`[sync-user-data] 已快照用户数据: ${snapDir}`);
console.log(`[sync-user-data] 快照根: ${SNAPSHOT_ROOT}（git 已忽略 backups/，不入库）`);
console.log(
  "[sync-user-data] 发布构建（pnpm app:build）不含用户数据：数据只留在 exe 同目录的 data\\，从不进入 dist\\ 或打包物；pnpm clean 清理时会保留 data\\。",
);
