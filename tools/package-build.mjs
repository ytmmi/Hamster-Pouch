#!/usr/bin/env node
/**
 * 打包：每次编译后生成「开发包」与「发布包」（按文件夹为单位，类似便携打包）。
 *
 * 结构（都在 `apps/desktop/src-tauri/target/release/` 下）：
 *   dev\dev-<YYYYMMDD-HHMMSS>\   开发包：hamster-pouch-desktop.exe + data\（含用户数据）。
 *                                   每次编译新建一个；命名按时间排序，一眼可辨先后。
 *   release\                     发布包：hamster-pouch-desktop.exe + data\system\（**系统数据库**，
 *                                   全局配置库随发布）+ data\plugins\（**系统插件** trust_level=system，
 *                                   含其自带数据库，随应用发布）；**不含用户数据**——user\repos\ 仓库库、
 *                                   非系统插件、thumbnails\ 缓存、debug.log 一律不带，
 *                                   发布全局库的仓库注册表/按仓库授权清空、非系统插件注册删除
 *                                   （系统插件 source_ref 改写为包内路径）。
 *
 * 数据来源：`target\release\data\`（编译目录下的活动数据：system\ 全局库 /
 * user\repos\ 仓库库 / plugins\ 插件 / thumbnails\ 缓存 / debug.log）。
 * 开发包 = exe + 该数据快照，并把包内全局库注册表（repos.repo_db_path、
 * plugin_registry.source_ref）改写为**包内**绝对路径——每个开发包自包含、
 * 可整夹带走；发布包只保留系统数据库。
 *
 * 用法：
 *   node tools/package-build.mjs      # 或 pnpm app:package
 *   （`pnpm app:build` 成功后会顺带执行本脚本，即「每次编译新建一个」）
 */

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = join(ROOT, "apps", "desktop", "src-tauri", "target", "release");
const EXE = join(BASE, "hamster-pouch-desktop.exe");
const DATA = join(BASE, "data");

/** 本地时间戳：YYYYMMDD-HHMMSS，字典序即先后顺序。 */
function stampLocal() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 递归统计目录字节数（不存在返回 0）。 */
async function dirSize(p) {
  let total = 0;
  try {
    const entries = await readdir(p, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(p, entry.name);
      total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
    }
  } catch {
    return 0;
  }
  return total;
}

const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

const BASE_DICT = join(ROOT, "tools", "tagdict", "output", "tag_dict_base.sqlite3");

/** 复制内置基底词库到 data/system/ 下（如果来源文件存在）。 */
async function copyBaseDict(targetDataRoot) {
  try {
    if ((await stat(BASE_DICT)).isFile()) {
      const dest = join(targetDataRoot, "system", "tag_dict_base.sqlite3");
      await mkdir(join(targetDataRoot, "system"), { recursive: true });
      await cp(BASE_DICT, dest);
      return true;
    }
  } catch { /* 文件不存在时不复制 */ }
  return false;
}

// 前置检查：必须有编译产物
if (!(await stat(EXE).catch(() => null))?.isFile()) {
  console.error(`[package-build] 未找到编译产物: ${EXE}\n  请先运行 pnpm app:build`);
  process.exit(1);
}

// ---- 1) 开发包：exe + 用户数据（每次编译新建一个，命名带时间戳）----
const devDir = join(BASE, "dev", `dev-${stampLocal()}`);
await mkdir(devDir, { recursive: true });
await cp(EXE, join(devDir, "hamster-pouch-desktop.exe"));
let devSize = (await stat(join(devDir, "hamster-pouch-desktop.exe"))).size;
const dataStat = await stat(DATA).catch(() => null);
if (dataStat?.isDirectory()) {
  await cp(DATA, join(devDir, "data"), { recursive: true });
  devSize += await dirSize(DATA);

  // 自包含：把包内全局库注册表从「暂存路径」改写为「包内路径」，
  // 使开发包可整体带走（仓库库路径 / 插件 source_ref 都指向包内 data\）。
  const gdb = join(devDir, "data", "system", "hamster-pouch-global.sqlite3");
  if (await stat(gdb).catch(() => null)) {
    const pkgData = join(devDir, "data");
    const sql =
      `UPDATE repos SET repo_db_path = replace(repo_db_path, '${DATA}', '${pkgData}');` +
      `UPDATE plugin_registry SET source_ref = replace(source_ref, '${DATA}', '${pkgData}');`;
    try {
      execFileSync("sqlite3", [gdb, sql], { stdio: "ignore" });
    } catch (e) {
      console.error(`[package-build] 改写包内全局库注册表失败（${e.message}），包内数据可能不自包含`);
      process.exit(1);
    }
  }
}

// 附带已签名但**不随发布**的插件包（plugins-dist/tag-dict 等扩展插件）
const pluginsDist = join(ROOT, "plugins-dist");
let pluginsDistHasData = false;
try {
  pluginsDistHasData = (await stat(pluginsDist)).isDirectory();
} catch { /* 目录不存在时不附加 */ }if (pluginsDistHasData) {
  for (const dirEntry of await readdir(pluginsDist, { withFileTypes: true })) {
    if (dirEntry.isDirectory() && !dirEntry.name.startsWith(".")) {
      const src = join(pluginsDist, dirEntry.name);
      await cp(src, join(devDir, "plugins-dist", dirEntry.name), { recursive: true });
    }
  }
  console.log(`[package-build]   附加: plugins-dist/（已签名扩展插件，不含用户数据）`);
}

// 附带内置基底词库到 data/system/ 下
if (await copyBaseDict(join(devDir, "data"))) {
  console.log(`[package-build]   附加: data\\system\\tag_dict_base.sqlite3（内置基底词库）`);
}

// 同步系统插件签名文件（编译缓存可能不是最新）
const paletteSigSrc = join(ROOT, "plugins", "system", "palette", "SHA256SUMS");
const paletteSigSigSrc = join(ROOT, "plugins", "system", "palette", "SHA256SUMS.sig");
const paletteSigDst = join(DATA, "plugins", "palette");
if (await stat(paletteSigSrc).catch(() => null)) {
  await mkdir(paletteSigDst, { recursive: true });
  await cp(paletteSigSrc, join(paletteSigDst, "SHA256SUMS"));
  await cp(paletteSigSigSrc, join(paletteSigDst, "SHA256SUMS.sig"));
}
console.log(`[package-build] 开发包: ${devDir}`);
console.log(`[package-build]   内容: exe + data\\（用户数据） 共 ${fmtMB(devSize)}`);

// ---- 2) 发布包：exe + 系统数据库 + 系统插件（不含用户数据）----
const relDir = join(BASE, "release");
await mkdir(relDir, { recursive: true });
await cp(EXE, join(relDir, "hamster-pouch-desktop.exe"));

// 发布包只保留「系统内容」：复制暂存 data\ 后清掉用户库/缓存/日志与**非系统插件**，
// 再补回系统插件目录（trust_level=system，含其自带数据库），
// 发布全局库同时清空仓库注册表与按仓库授权、去掉非系统插件注册。
const stagingGdb = join(DATA, "system", "hamster-pouch-global.sqlite3");
let systemPlugins = [];
if (dataStat?.isDirectory()) {
  await cp(DATA, join(relDir, "data"), { recursive: true });
  for (const sub of ["user", "thumbnails"]) {
    await rm(join(relDir, "data", sub), { recursive: true, force: true });
  }
  await rm(join(relDir, "data", "debug.log"), { force: true });

  // 只保留系统插件：先整体清掉 plugins\，再按注册表复制 trust_level='system' 的插件目录。
  const relPlugins = join(relDir, "data", "plugins");
  await rm(relPlugins, { recursive: true, force: true });
  systemPlugins = (await stat(stagingGdb).catch(() => null))
    ? execFileSync("sqlite3", [stagingGdb, "SELECT id FROM plugin_registry WHERE trust_level='system';"], {
        encoding: "utf8",
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (systemPlugins.length > 0) {
    for (const pid of systemPlugins) {
      const src = join(DATA, "plugins", pid);
      if (await stat(src).catch(() => null)) {
        await cp(src, join(relPlugins, pid), { recursive: true });
      }
    }
  }

  // 发布全局库：清仓库注册/按仓库授权；系统插件 source_ref 改写为包内路径；
  // 非系统插件注册删除（其插件目录未随发布）。
  const relGdb = join(relDir, "data", "system", "hamster-pouch-global.sqlite3");
  if (await stat(relGdb).catch(() => null)) {
    const relData = join(relDir, "data");
    const sql =
      "DELETE FROM repos; " +
      "DELETE FROM plugin_repo_state; " +
      `UPDATE plugin_registry SET source_ref = replace(source_ref, '${DATA}', '${relData}') WHERE trust_level='system'; ` +
      "DELETE FROM plugin_registry WHERE trust_level <> 'system';";
    execFileSync("sqlite3", [relGdb, sql], { stdio: "ignore" });
  }
}
console.log(
  `[package-build] 发布包: ${join(relDir, "hamster-pouch-desktop.exe")} + data\\system\\（系统数据库）` +
    (systemPlugins.length > 0 ? ` + data\\plugins\\（系统插件 ${systemPlugins.join(", ")}）` : ""),
);
console.log(
  "[package-build]   不含用户数据：user\\repos\\、非系统插件、thumbnails\\、debug.log 均不带；发布全局库仓库注册表与按仓库授权已清空",
);
