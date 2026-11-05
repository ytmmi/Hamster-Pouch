#!/usr/bin/env node
/**
 * version.mjs：应用版本号的**唯一入口**——推导下一个版本，并回写三处副本。
 *
 * 为什么需要它：应用版本号有**三份副本**——`apps/desktop/src-tauri/tauri.conf.json`
 * （单点权威，Tauri 从它取 exe 版本）、`apps/desktop/src-tauri/Cargo.toml` 的
 * `[package] version`（桥接层 crate 版本，`env!("CARGO_PKG_VERSION")` 读它）、
 * `apps/desktop/package.json`（前端包版本）。三份靠手工同步迟早漂移：exe 属性、
 * Cargo 元数据、包版本各说各话，而**没有任何门禁去比对**。本脚本把
 * 「确定最终版本 → 同时写三处」收进一条命令，构建链只认它。
 *
 * 用户口径（2026-11）：**默认构建**（没指定版本号）只在 `X.Y.Z` 的 **z 段数字 +1**，
 * 其余字符原样保留——`0.1.0-Alpha` → `0.1.1-Alpha`（预发布后缀 `-Alpha` 不动）。
 * 指定了版本号（`--write` / 环境变量 `HP_VERSION`）则原样使用。
 * 只做"数字 +1"而不是"重新拼版本串"：`-Alpha`、`-beta.2` 是人的意图，
 * 脚本没有资格改写它。
 *
 * 用法（任意工作目录均可，脚本用 `import.meta.url` 定位仓库根）：
 *   node tools/version.mjs                  # 打印当前版本（权威 = tauri.conf.json）
 *   node tools/version.mjs --current        # 同上
 *   node tools/version.mjs --bump           # 只打印 z+1 后的版本，不写文件（--next 同义）
 *   node tools/version.mjs --write <ver>    # 三处写成指定版本（--set 同义）
 *   node tools/version.mjs --apply          # HP_VERSION 非空则原样用，否则 z+1；写三处并打印
 *   node tools/version.mjs --self-test      # 纯函数自检（`pnpm check:version`）
 *
 * 退出码：0 成功；1 参数/版本号/文件结构不合法（错误信息一律中文，直接给人看）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 仓库根：`tools/` 的上一级（不依赖当前工作目录，CI 与本机一致）。
 * `HP_PROJECT_ROOT` 只为隔离验证保留：把三份副本复制到临时目录后，
 * 用它把读写指过去，就能在不动真仓库的前提下跑通 `--write` 全流程。
 */
const ROOT = process.env.HP_PROJECT_ROOT
  ? resolve(process.env.HP_PROJECT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 三个版本副本的相对路径（单一权威在最前）。 */
export const TAURI_CONF = "apps/desktop/src-tauri/tauri.conf.json";
export const BRIDGE_CARGO = "apps/desktop/src-tauri/Cargo.toml";
export const DESKTOP_PKG = "apps/desktop/package.json";

/**
 * 合法版本：`X.Y.Z` + 可选 `-预发布后缀` + 可选 `+构建元数据`。
 * - 数字段**不允许前导零**（`01.2.3` 在 semver 里非法，也会让"数字 +1"失去确定性）；
 * - 后缀只允许字母/数字/连字符/点（`-Alpha`、`-beta.2`、`-rc.1` 均可），原样保留。
 */
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * 校验版本号并返回去掉首尾空白的原串（**不改写内容**）。
 * 不合法即抛错——静默接受坏版本会写进 exe 元数据，事后很难查。
 */
export function normalizeVersion(version) {
  const raw = String(version ?? "").trim();
  if (!raw) throw new Error("版本号为空：需要形如 X.Y.Z 或 X.Y.Z-后缀（例如 0.1.0-Alpha）");
  if (!VERSION_RE.test(raw)) {
    throw new Error(
      `版本号不合法：${JSON.stringify(raw)} —— 需要 X.Y.Z（可带 -后缀，如 0.1.0-Alpha）；` +
        "各数字段不得有前导零，后缀只用字母/数字/连字符/点",
    );
  }
  return raw;
}

/**
 * 把 `X.Y.Z[-后缀]` 的 **patch 数字 +1**，其余字符原样保留。
 * `0.1.0-Alpha` → `0.1.1-Alpha`；`0.1.0` → `0.1.1`；`1.9.9-beta.2` → `1.9.10-beta.2`。
 */
export function bumpPatch(version) {
  const normalized = normalizeVersion(version);
  const m = VERSION_RE.exec(normalized);
  const patch = Number(m[3]) + 1;
  // m[4] = -预发布后缀，m[5] = +构建元数据；两者原样拼回，不做任何重排。
  return `${m[1]}.${m[2]}.${patch}${m[4] ?? ""}${m[5] ?? ""}`;
}

/** `bumpPatch` 的旧名（早期脚本/文档里用过，保留别名免得调用点断掉）。 */
export const bumpPatchVersion = bumpPatch;

/** 读 JSON 里的 version 字段（保持对象键序，不做字段重排）。 */
function readJsonVersion(abs) {
  const text = readFileSync(abs, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${abs} 不是合法 JSON：${e.message}`);
  }
  return String(data.version ?? "").trim();
}

/**
 * 读 `apps/desktop/src-tauri/Cargo.toml` 的 `[package] version`。
 * 只认 `[package]` 段：`[dependencies]` / `[target.'cfg(windows)'.dependencies]` 里的
 * `version = "2.12.5"` 是**依赖版本**，改错会把整个 crate 的依赖钉死到应用版本上。
 */
function readCargoPackageVersion(abs) {
  const lines = readFileSync(abs, "utf8").split("\n");
  let inPackage = false;
  for (const line of lines) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const m = /^version\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1].trim();
  }
  throw new Error(`${abs} 的 [package] 段里找不到 version = "..."（文件结构被改过？）`);
}

/** 当前应用版本：以 tauri.conf.json 为单点权威。 */
export function readAppVersion() {
  const version = readJsonVersion(resolve(ROOT, TAURI_CONF));
  if (!version) throw new Error(`${TAURI_CONF} 缺少 version 字段`);
  return version;
}

/** 读三处版本（用于报告漂移；authority 恒为 tauri.conf.json）。 */
export function readAllVersions() {
  return [
    { file: TAURI_CONF, version: readAppVersion() },
    { file: BRIDGE_CARGO, version: readCargoPackageVersion(resolve(ROOT, BRIDGE_CARGO)) },
    { file: DESKTOP_PKG, version: readJsonVersion(resolve(ROOT, DESKTOP_PKG)) },
  ];
}

/**
 * 写 JSON 里的 version：**定点替换那一行**，其余字节（键序、空行、数组换行风格、
 * 末尾换行）逐字保留。
 *
 * 为什么不用"解析后 JSON.stringify 重写"：重写会顺手改掉别处的排版——实测
 * `tauri.conf.json` 里 `"scope": ["**"]` 这种单行数组会被展开成多行，diff 里就出现
 * 与版本号无关的噪声。版本号同步只该改版本号那一个字符。
 *
 * 定位方式：先 JSON.parse 确认文件合法且 `version` 是字符串，再在原文里找
 * **顶层级缩进**的 `"version": "..."`（顶层的键缩进是全文件最小的那档，子对象里的
 * 同名键缩进更深，靠缩进比较即可排除）。
 */
function writeJsonVersion(abs, version) {
  const text = readFileSync(abs, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${abs} 不是合法 JSON：${e.message}`);
  }
  if (typeof data.version !== "string") {
    throw new Error(`${abs} 的顶层 version 不是字符串，拒绝写入`);
  }

  const keyLine = /^([ \t]*)"([^"]+)"[ \t]*:/gm;
  let topIndent = null;
  for (const m of text.matchAll(keyLine)) {
    if (topIndent === null || m[1].length < topIndent.length) topIndent = m[1];
  }
  if (topIndent === null) throw new Error(`${abs} 里找不到任何键，拒绝写入`);

  const indent = topIndent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionLine = new RegExp(`^${indent}"version"([ \\t]*):([ \\t]*)"[^"]*"`, "m");
  if (!versionLine.test(text)) {
    throw new Error(`${abs} 里找不到顶层 "version" 行，拒绝写入（文件结构被改过？）`);
  }
  const next = text.replace(versionLine, `${topIndent}"version"$1:$2"${version}"`);

  // 改完必须仍是合法 JSON 且只差这一个值，否则不写（fail-closed）。
  let check;
  try {
    check = JSON.parse(next);
  } catch (e) {
    throw new Error(`改写后的 ${abs} 不是合法 JSON（拒绝写入）：${e.message}`);
  }
  if (check.version !== version) {
    throw new Error(`改写后的 ${abs} 的 version 是 ${JSON.stringify(check.version)}，期望 ${JSON.stringify(version)}`);
  }
  writeFileSync(abs, next, "utf8");
}

/** 写 Cargo.toml 的 `[package] version`（只动这一行，其余字节原样保留）。 */
function writeCargoPackageVersion(abs, version) {
  const lines = readFileSync(abs, "utf8").split("\n");
  let inPackage = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const section = /^\s*\[(.+)\]\s*$/.exec(lines[i]);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    if (!/^version\s*=\s*"[^"]*"\s*(#.*)?$/.test(lines[i])) continue;
    lines[i] = lines[i].replace(/^version\s*=\s*"[^"]*"/, `version = "${version}"`);
    done = true;
    break;
  }
  if (!done) throw new Error(`${abs} 的 [package] 段里找不到 version = "..."，拒绝写入`);
  writeFileSync(abs, lines.join("\n"), "utf8");
}

/**
 * 把版本号写进三处副本，返回写入的版本号。
 * fail-closed：写完回读校验，任一文件没落到预期值即抛错（不留下"改了一半"的静默状态）。
 */
export function writeAppVersion(version) {
  const v = normalizeVersion(version);
  writeJsonVersion(resolve(ROOT, TAURI_CONF), v);
  writeCargoPackageVersion(resolve(ROOT, BRIDGE_CARGO), v);
  writeJsonVersion(resolve(ROOT, DESKTOP_PKG), v);
  for (const item of readAllVersions()) {
    if (item.version !== v) {
      throw new Error(
        `写好回读不一致：${item.file} 是 ${JSON.stringify(item.version)}，期望 ${JSON.stringify(v)}`,
      );
    }
  }
  return v;
}

/** CLI 帮助文案（参数错时打印到 stderr）。 */
const USAGE = [
  "用法：node tools/version.mjs [--current | --bump | --write <版本号> | --apply | --self-test]",
  "  无参数 / --current   打印当前版本（读 apps/desktop/src-tauri/tauri.conf.json）",
  "  --bump（--next）     只打印推导出的下一个版本（z 数字 +1，后缀保留），不写文件",
  "  --write <ver>（--set） 把三处写成指定版本（校验后原样使用）",
  "  --apply              确定最终版本并写入三处：HP_VERSION 非空则原样用，否则 z+1",
  "  --self-test          纯函数自检（不读写仓库文件）",
].join("\n");

/** 自检用例：题目 → 期望值；顺手验证非法输入确实会抛错。 */
const SELF_TEST_CASES = [
  ["0.1.0-Alpha", "0.1.1-Alpha"],
  ["0.1.0", "0.1.1"],
  ["1.9.9-beta.2", "1.9.10-beta.2"],
  ["2.3.4+build.7", "2.3.5+build.7"],
  ["10.0.0-rc.1+build", "10.0.1-rc.1+build"],
];

/** 纯函数自检：`pnpm check:version` 与 CI 的 check:* 枚举都跑它。 */
function selfTest() {
  let count = 0;
  for (const [input, expected] of SELF_TEST_CASES) {
    const actual = bumpPatch(input);
    if (actual !== expected) {
      throw new Error(`自检失败：bumpPatch(${JSON.stringify(input)}) = ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
    }
    count += 1;
  }
  // 非法输入必须抛错（静默放过会写坏 exe 元数据）。
  for (const bad of ["", "0.1", "0.1.0.0", "01.2.3", "v1.2.3", "1.2.3-", "1.2.3 " + "x"]) {
    let threw = false;
    try {
      bumpPatch(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`自检失败：非法版本 ${JSON.stringify(bad)} 没有被拒绝`);
    count += 1;
  }
  // 后缀必须逐字保留：只允许 z 段变化。
  const suffix = "-Alpha";
  if (!bumpPatch(`0.1.0${suffix}`).endsWith(suffix)) {
    throw new Error("自检失败：预发布后缀被改写");
  }
  count += 1;
  console.log(`版本号推导自检通过（${count} 项）`);
}

/** CLI 主流程：返回值即进程退出码，便于测试与阅读。 */
function main(argv) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--current") {
    console.log(readAppVersion());
    return 0;
  }

  if (command === "--bump" || command === "--next") {
    console.log(bumpPatch(readAppVersion()));
    return 0;
  }

  if (command === "--apply") {
    const override = String(process.env.HP_VERSION ?? "").trim();
    const next = override ? normalizeVersion(override) : bumpPatch(readAppVersion());
    if (override) console.error(`[version] 采用指定版本（HP_VERSION）：${next}`);
    else console.error(`[version] 未指定版本，z 段数字 +1：${next}`);
    writeAppVersion(next);
    console.log(next);
    return 0;
  }

  if (command === "--write" || command === "--set") {
    const target = rest[0];
    if (!target) throw new Error(`--write 缺少版本号参数\n${USAGE}`);
    console.log(writeAppVersion(normalizeVersion(target)));
    return 0;
  }

  if (command === "--self-test") {
    selfTest();
    return 0;
  }

  throw new Error(`无法识别的参数 ${JSON.stringify(command)}\n${USAGE}`);
}

// 仅在被直接执行时跑 CLI；被 `import` 引入时只暴露纯函数（便于单测与复用）。
const SELF = fileURLToPath(import.meta.url).toLowerCase();
const ENTRY = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (ENTRY === SELF) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`[version] ${e.message}`);
    process.exitCode = 1;
  }
}
