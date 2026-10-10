#!/usr/bin/env node
/**
 * 打包：每次编译后生成「开发包」与「发布包」（按文件夹为单位，类似便携打包）。
 *
 * 结构（都在 `apps/desktop/src-tauri/target/release/` 下）：
 *   dev\dev-<YYYYMMDD-HHMMSS>\   开发包：hamster-pouch-desktop.exe + data\（含用户数据）
 *                                   + external-cli\ + plugins\system\。
 *                                   每次编译新建一个；命名按时间排序，一眼可辨先后。
 *   release\                     发布包：hamster-pouch-desktop.exe + data\system\（**系统数据库**，
 *                                   全局配置库随发布）+ data\plugins\（**系统插件** trust_level=system，
 *                                   含其自带数据库，随应用发布）+ external-cli\ + plugins\system\；
 *                                   **不含用户数据**——user\repos\ 仓库库、
 *                                   非系统插件、thumbnails\ 缓存、debug.log 一律不带，
 *                                   发布全局库的仓库注册表/按仓库授权清空、非系统插件注册删除
 *                                   （系统插件 source_ref 改写为包内路径）。
 *
 * **随包分发的运行时资产（D14 / 契约 §3.11）**：`external-cli\`（ffmpeg 运行时子集 +
 * 可选 mpv）与 `plugins\system\`（`plugin.installBundled` 的来源）都放在 **exe 同级**，
 * 与仓库内布局同构——这样 `commands/shared.rs` 的 `find_upwards` / `find_upwards_dir`
 * 从 exe 目录起步的第一跳就能命中，**包整夹搬走也仍然可用**（这正是此前"伪捆绑"的缺口：
 * 产物里没有这些资产，只靠包还躺在仓库树里才凑巧向上找到）。
 *
 * **"不入 git 库"与"能否进构建包"是两件事**：本脚本从**本地磁盘**复制，不读 git。
 *   - `external-cli\ffmpeg\` **已入库**（224 个文件）⇒ 任何完整工作树都有 ⇒ 必需项。
 *   - `external-cli\mpv\` **不入库**（`.gitignore` 忽略，100 MB+ 二进制不进版本库）
 *     ⇒ 新克隆必然没有 ⇒ **可选项**，存在则入包、缺失则跳过（否则新克隆上打包直接断掉）。
 *
 * 体积与落盘策略：
 *   - `external-cli\ffmpeg\` 只带**运行时子集**（两个 exe + bin\ 下全部 DLL + LICENSE.txt，
 *     约 168 MB）；`ffplay.exe`（交互式播放器，产品从不调用）与 `doc\` / `include\` /
 *     `lib\` / `presets\`（开发期文档与链接库）不带。mpv 不做裁剪（见 placeBundledRuntime）。
 *   - **dev 包用硬链接**（NTFS，零额外占用、瞬时完成；同卷实测可用，跨卷自动回退复制），
 *     **release 包用真实复制**（可分发实体文件）。硬链接只是省盘，包内容完整可搬走。
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
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, link, mkdir, readdir, rm, stat } from "node:fs/promises";
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

const BASE_DICT = join(ROOT, "tools", "tagdict", "output", "tag_lib_base.sqlite3");

/** 随包分发的外部 CLI 目录（仓库内）与其在包内的相对位置。 */
const EXTERNAL_CLI = join(ROOT, "external-cli");
/** 随包分发的系统插件目录（仓库内）与其在包内的相对位置。 */
const BUNDLED_PLUGINS = join(ROOT, "plugins", "system");
/** libmpv 播放器（可选资产，见 [`placeBundledRuntime`] 的 mpv 说明）。 */
const MPV_DIR = join(EXTERNAL_CLI, "mpv");

/**
 * `external-cli\ffmpeg\` 里**产品运行时不需要**的条目（相对 `ffmpeg\` 的路径）。
 *
 * 判据（每条都实测过，不是猜的）：
 *   - `bin\ffplay.exe`：交互式播放器，全仓无任何调用方（播放器面板走 DOM `<video>`，
 *     libmpv 路径已休眠）；去掉后 ffmpeg/ffprobe 的 `-version`、抽帧、libwebp 编码、
 *     AVIF 编解码全部正常。
 *   - `doc\` / `include\` / `lib\` / `presets\`：开发期文档、C 头文件、导入库与
 *     预设文件。全仓无 `-fpre` / `-vpre` 调用，运行时不读它们。
 *
 * **`bin\` 下的 DLL 一个都不能省**：`ffmpeg.exe` / `ffprobe.exe` 是同一套构建的
 * 薄壳，加载时按 PE 导入表静态绑定**全部** av* DLL。实测去掉 `avdevice-62.dll`
 * 即 `exit -1073741515`（`0xC0000135` STATUS_DLL_NOT_FOUND）——**连 `-version` 都跑不起来**。
 * 因此这里**只按名字排除明确不需要的条目**，绝不写"只保留某几个 DLL"的白名单：
 * 上游升级 ffmpeg 时若新增 DLL，白名单会静默漏掉它，而黑名单不会。
 */
const FFMPEG_EXCLUDE = new Set([
  "bin/ffplay.exe",
  "doc",
  "include",
  "lib",
  "presets",
]);
/** 自检时"不该出现"的包内路径（与 [`FFMPEG_EXCLUDE`] 对应，防止规则失效后静默通过）。 */
const FFMPEG_MUST_BE_ABSENT = ["bin/ffplay.exe", "doc", "include", "lib", "presets"];

/** 复制内置基底词库到 data/system/ 下（如果来源文件存在）。 */
async function copyBaseDict(targetDataRoot) {
  try {
    if ((await stat(BASE_DICT)).isFile()) {
      const dest = join(targetDataRoot, "system", "tag_lib_base.sqlite3");
      await mkdir(join(targetDataRoot, "system"), { recursive: true });
      await cp(BASE_DICT, dest);
      return true;
    }
  } catch { /* 文件不存在时不复制 */ }
  return false;
}

/**
 * 把一个文件放进包内：**先试硬链接，失败回退真实复制**。
 *
 * 硬链接与复制在"包能不能搬走"上**等价**：NTFS 硬链接是同一份数据的第二个目录项，
 * 把包目录整夹拷到别处时，拷贝方读到的就是完整文件内容。它只省**本机**磁盘与时间。
 * 跨卷（包与源不在同一卷）时 `link` 会 `EXDEV` 失败，此时回退复制。
 *
 * `allowLink=false` 时**强制真实复制**——release 包按既定口径要"可分发实体文件"，
 * 不与仓库内源码共享数据块（否则原地保留时，源码侧任何改动都会连带改变包内容）。
 */
async function placeFile(src, dest, allowLink) {
  await mkdir(dirname(dest), { recursive: true });
  if (allowLink) {
    try {
      await link(src, dest);
      return "link";
    } catch { /* 跨卷或文件系统不支持：回退复制 */ }
  }
  await cp(src, dest);
  return "copy";
}

/**
 * 递归放置目录内容，跳过 `exclude` 里列出的条目，返回 `{ files, bytes, links }`。
 *
 * `exclude` 里的键是**相对源根**的 POSIX 风格路径（如 `bin/ffplay.exe`、`doc`）；
 * 目录被排除时整棵子树都不复制。逐文件放置（而非整目录 `cp`）是为了让 dev 包能走
 * 硬链接。`prefix` 是当前递归层相对源根的路径前缀，仅供匹配用。
 */
async function placeDir(src, dest, exclude = new Set(), prefix = "", allowLink = true) {
  let files = 0;
  let bytes = 0;
  let links = 0;
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const relKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (exclude.has(relKey)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = await placeDir(from, to, exclude, relKey, allowLink);
      files += sub.files;
      bytes += sub.bytes;
      links += sub.links;
    } else {
      const how = await placeFile(from, to, allowLink);
      files++;
      bytes += (await stat(from)).size;
      if (how === "link") links++;
    }
  }
  return { files, bytes, links };
}

/**
 * 随包分发的运行时资产：`external-cli\`（ffmpeg 运行时子集 + 可选 mpv）与 `plugins\system\`。
 *
 * 放在 exe 同级，与仓库内布局同构 ⇒ `find_upwards` / `find_upwards_dir` 从 exe 目录
 * 起步第一跳即命中，包整夹搬走仍可用。
 *
 * **ffmpeg 与 mpv 的"缺失"语义刻意不同**（两者是不同的事）：
 *   - **ffmpeg 是必需项**：它随仓库入库（`git ls-files external-cli/ffmpeg` 有 224 个文件），
 *     任何完整工作树里都必然存在。缺了就是工作树坏了 ⇒ 由调用方的前置检查**硬失败**。
 *   - **mpv 是可选项**：`external-cli/mpv/` **不入库**（`.gitignore` 忽略，100 MB+ 二进制
 *     不进版本库），因此**新克隆里必然没有它**。若做成硬失败，新克隆上 `pnpm app:build`
 *     会直接断掉。故这里按"**存在则入包、缺失则跳过并说明**"处理。
 *
 * 注意：**"不入 git 库"与"能否进构建包"是两件事**。本脚本从**本地磁盘**复制，
 * 不读 git —— mpv 只要在本机存在，就能进包；入库与否只决定新克隆是否自带源文件。
 *
 * mpv 不做裁剪（整目录原样入包，119.05 MB）：`mpv.exe` 的 IPC 能启动**不证明**视频渲染
 * 不需要 `d3dcompiler_43.dll`（D3D11 输出编译 shader 用它），证据不足就不裁。
 */
async function placeBundledRuntime(targetRoot, mode, allowLink) {
  // release 目录不按时间戳（固定 `release\`），复用同一目录时会留下上一次的陈旧文件；
  // 先清掉这些子树的旧内容，保证产物是本次规则的确定性结果（dev 目录每次新建，无此问题）。
  await rm(join(targetRoot, "external-cli"), { recursive: true, force: true });
  await rm(join(targetRoot, "plugins", "system"), { recursive: true, force: true });
  const external = await placeDir(join(EXTERNAL_CLI, "ffmpeg"), join(targetRoot, "external-cli", "ffmpeg"), FFMPEG_EXCLUDE, "", allowLink);
  const plugins = await placeDir(BUNDLED_PLUGINS, join(targetRoot, "plugins", "system"), new Set(), "", allowLink);

  // mpv：可选资产（见上方说明）。整目录原样复制，不设排除项。
  const mpvSourceExists = existsSync(join(MPV_DIR, "mpv.exe"));
  let mpv = { present: false, files: 0, bytes: 0 };
  if (mpvSourceExists) {
    const placed = await placeDir(MPV_DIR, join(targetRoot, "external-cli", "mpv"), new Set(), "", allowLink);
    mpv = { present: true, files: placed.files, bytes: placed.bytes };
  }

  console.log(
    `[package-build]   随包资产(${mode}): external-cli\\ffmpeg\\ ${external.files} 文件 / ${fmtMB(external.bytes)}` +
      `，plugins\\system\\ ${plugins.files} 文件 / ${fmtMB(plugins.bytes)}` +
      (mpv.present
        ? `，external-cli\\mpv\\ ${mpv.files} 文件 / ${fmtMB(mpv.bytes)}`
        : "，external-cli\\mpv\\ 跳过（本机无 mpv.exe：该目录不入库，见 README「外部依赖」）"),
  );
  return { external, plugins, mpv };
}

/**
 * **fail-closed 自检**：断言包内两份资产真的可用，缺任何一项即失败。
 *
 * 为什么必须断言而不是"复制完就算了"：本脚本的整个存在理由就是"产物里要有它"。
 * 若上游改了目录名、或子集规则漏掉了新依赖，静默产出一个"看起来打好了、运行时
 * 却找不到 ffmpeg"的包，比直接失败糟得多——那正是本次修复前的状态。
 * 这里断言的是**运行时的真实判据**：`find_upwards` 从 exe 目录第一跳能否命中。
 */
function verifyBundledRuntime(targetRoot, { allowLink, mpvExpected }) {
  const problems = [];
  const mustExist = [
    ["external-cli/ffmpeg/bin/ffmpeg.exe", "file"],
    ["external-cli/ffmpeg/bin/ffprobe.exe", "file"],
    ["external-cli/ffmpeg/LICENSE.txt", "file"],
    ["external-cli/ffmpeg/bin/avcodec-62.dll", "file"],
    ["external-cli/ffmpeg/bin/avdevice-62.dll", "file"],
    ["external-cli/ffmpeg/bin/avfilter-11.dll", "file"],
    ["external-cli/ffmpeg/bin/avformat-62.dll", "file"],
    ["external-cli/ffmpeg/bin/avutil-60.dll", "file"],
    ["external-cli/ffmpeg/bin/swresample-6.dll", "file"],
    ["external-cli/ffmpeg/bin/swscale-9.dll", "file"],
    ["plugins/system/palette/plugin.manifest", "file"],
  ];
  for (const [rel, kind] of mustExist) {
    const p = join(targetRoot, ...rel.split("/"));
    const st = statSync(p, { throwIfNoEntry: false });
    const ok = kind === "file" ? Boolean(st?.isFile()) : Boolean(st?.isDirectory());
    if (!ok) problems.push(`缺 ${rel}`);
  }
  // mpv 是可选项：**源在就必须进包**（防"复制逻辑静默漏掉"），源不在则不要求包里有。
  // 不写成"包里必须有 mpv"：新克隆没有该目录，那样会让 app:build 在新克隆上断掉。
  if (mpvExpected) {
    const st = statSync(join(targetRoot, "external-cli", "mpv", "mpv.exe"), { throwIfNoEntry: false });
    if (!st?.isFile()) problems.push("本机有 mpv 源，但包里没有 external-cli\\mpv\\mpv.exe");
  }
  // 排除项必须真的不在包里（否则"子集"名不副实，白占体积）。
  for (const rel of FFMPEG_MUST_BE_ABSENT) {
    const p = join(targetRoot, "external-cli", "ffmpeg", ...rel.split("/"));
    if (existsSync(p)) problems.push(`不该带却带了 ${rel}`);
  }
  // 反向断言：bin\ 下源目录里的每个 DLL 都必须进包（防"白名单漏项"式回归）。
  const binSrc = join(EXTERNAL_CLI, "ffmpeg", "bin");
  const binDst = join(targetRoot, "external-cli", "ffmpeg", "bin");
  if (existsSync(binSrc)) {
    for (const name of readdirSync(binSrc)) {
      if (FFMPEG_EXCLUDE.has(`bin/${name}`)) continue;
      if (!existsSync(join(binDst, name))) problems.push(`bin\\ 下漏了 ${name}`);
    }
  }
  // 落盘策略必须与包类型一致：dev 期望硬链接、release 期望真实复制。
  // 断言"至少有一个链接"而非逐文件相等——跨卷时 link 会合法地回退成复制。
  const linked = countHardLinks(join(targetRoot, "external-cli"));
  if (allowLink && linked === 0) {
    problems.push("dev 包期望硬链接，实测 0 个（是否与源不同卷？）");
  }
  if (!allowLink && linked > 0) {
    problems.push(`release 包不应有硬链接，实测 ${linked} 个`);
  }
  if (problems.length > 0) {
    console.error(`[package-build] 包内随包资产自检失败（${targetRoot}）：\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}

/** 统计目录树里处于硬链接状态的文件数（`nlink > 1`）。 */
function countHardLinks(dir) {
  let n = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (statSync(p, { throwIfNoEntry: false })?.nlink > 1) n++;
    }
  };
  if (existsSync(dir)) walk(dir);
  return n;
}

// 前置检查：必须有编译产物
if (!(await stat(EXE).catch(() => null))?.isFile()) {
  console.error(`[package-build] 未找到编译产物: ${EXE}\n  请先运行 pnpm app:build`);
  process.exit(1);
}

// 前置检查：**必需**随包资产的源必须存在。缺了就直说缺什么，
// 而不是让 placeDir 抛一个 ENOENT 栈（那会让人以为是脚本坏了）。
// 注意这里**只列必需项**（ffmpeg 入库、plugins/system 在仓库内）；
// mpv 是可选资产（目录不入库），缺失属正常，不进本清单——见 placeBundledRuntime。
for (const [label, p] of [
  ["external-cli/ffmpeg/bin/ffmpeg.exe", join(EXTERNAL_CLI, "ffmpeg", "bin", "ffmpeg.exe")],
  ["external-cli/ffmpeg/bin/ffprobe.exe", join(EXTERNAL_CLI, "ffmpeg", "bin", "ffprobe.exe")],
  ["plugins/system", BUNDLED_PLUGINS],
]) {
  if (!existsSync(p)) {
    console.error(
      `[package-build] 缺少随包资产源: ${label}（${p}）\n` +
        "  ffmpeg 随仓库分发（见根 README「外部依赖」）；plugins/system 是仓库内目录。请检查工作树是否完整。",
    );
    process.exit(1);
  }
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

// 附带已签名但**不随发布**的插件包（plugins-dist/ 下的 tagdict-* 词典扩展
// 与 tagrel-* 关系扩展，见 RFC 0008 D36.5）
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
  console.log(`[package-build]   附加: data\\system\\tag_lib_base.sqlite3（内置基底词库）`);
}
// 清掉已退役的旧基底库：RFC 0008 起由 tag_lib_base.sqlite3 取代。
// 它可能来自旧的 DATA 暂存缓存；留着会被误当成有效词库（旧 schema）。
await rm(join(devDir, "data", "system", "tag_dict_base.sqlite3"), { force: true });

// 同步系统插件签名文件（编译缓存可能不是最新）
const paletteSigSrc = join(ROOT, "plugins", "system", "palette", "SHA256SUMS");
const paletteSigSigSrc = join(ROOT, "plugins", "system", "palette", "SHA256SUMS.sig");
const paletteSigDst = join(DATA, "plugins", "palette");
if (await stat(paletteSigSrc).catch(() => null)) {
  await mkdir(paletteSigDst, { recursive: true });
  await cp(paletteSigSrc, join(paletteSigDst, "SHA256SUMS"));
  await cp(paletteSigSigSrc, join(paletteSigDst, "SHA256SUMS.sig"));
}
// 随包运行时资产：external-cli\（ffmpeg 运行时子集 + 可选 mpv）+ plugins\system\（随包插件来源）。
// 放在 exe 同级 —— 与仓库内布局同构，find_upwards 从 exe 目录第一跳即命中。
// dev 包走硬链接（零额外占用），见 placeFile。
const devBundled = await placeBundledRuntime(devDir, "硬链接优先", true);
devSize += devBundled.external.bytes + devBundled.plugins.bytes + devBundled.mpv.bytes;
verifyBundledRuntime(devDir, { allowLink: true, mpvExpected: devBundled.mpv.present });

console.log(`[package-build] 开发包: ${devDir}`);
console.log(
  `[package-build]   内容: exe + data\\（用户数据）+ external-cli\\ + plugins\\system\\ 共 ${fmtMB(devSize)}`,
);

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
  // 如果全局库无注册记录（全新编译），改用文件系统扫描 plugins/system/*/
  if (systemPlugins.length === 0) {
    const sysPluginRoot = join(ROOT, "plugins", "system");
    try {
      for (const entry of await readdir(sysPluginRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          systemPlugins.push(entry.name);
        }
      }
    } catch { /* 目录不存在则跳过 */ }
  }
  if (systemPlugins.length > 0) {
    for (const pid of systemPlugins) {
      // 从仓库根 plugins/system/<pid>/ 复制（比 DATA 更可靠——编译缓存可能缺失）
      let sysSrcExists = false;
      try { sysSrcExists = (await stat(join(ROOT, "plugins", "system", pid))).isDirectory(); } catch {}
      if (sysSrcExists) {
        await cp(join(ROOT, "plugins", "system", pid), join(relPlugins, pid), { recursive: true });
      } else {
        // 兜底：从编译缓存 DATA/plugins/<pid>/ 复制
        let dataSrcExists = false;
        try { dataSrcExists = (await stat(join(DATA, "plugins", pid))).isDirectory(); } catch {}
        if (dataSrcExists) {
          await cp(join(DATA, "plugins", pid), join(relPlugins, pid), { recursive: true });
        }
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

  // 发布包也必须带内置基底库：上面是从 DATA 暂存目录整体复制的，而 DATA 里可能是
  // 旧编译缓存（甚至只有已退役的 tag_dict_base.sqlite3）。这里**显式**再复制一次，
  // 保证发布包与开发包的内置基底库同源同版本；并清掉已退役的旧基底库
  // （RFC 0008 起由 tag_lib_base.sqlite3 取代，留着会让运行时读到旧 schema）。
  await rm(join(relDir, "data", "system", "tag_dict_base.sqlite3"), { force: true });
  if (await copyBaseDict(join(relDir, "data"))) {
    console.log(`[package-build]   发布包附加: data\\system\\tag_lib_base.sqlite3（内置基底词库）`);
  }
}
// 随包运行时资产：与开发包同源同内容，但**真实复制**（release 是可分发实体，
// 不依赖本机 NTFS 硬链接）。`plugins\system\` 与 `data\plugins\` 是两回事：
// 后者是**已安装**的运行时插件目录，前者是 `plugin.installBundled` 的**随包来源**根。
const relBundled = await placeBundledRuntime(relDir, "真实复制", false);
verifyBundledRuntime(relDir, { allowLink: false, mpvExpected: relBundled.mpv.present });

console.log(
  `[package-build] 发布包: ${join(relDir, "hamster-pouch-desktop.exe")} + data\\system\\（系统数据库）` +
    (systemPlugins.length > 0 ? ` + data\\plugins\\（系统插件 ${systemPlugins.join(", ")}）` : "") +
    ` + external-cli\\ffmpeg\\（${relBundled.external.files} 文件 / ${fmtMB(relBundled.external.bytes)}）` +
    (relBundled.mpv.present ? ` + external-cli\\mpv\\（${relBundled.mpv.files} 文件 / ${fmtMB(relBundled.mpv.bytes)}）` : "") +
    ` + plugins\\system\\（${relBundled.plugins.files} 文件）`,
);
console.log(
  "[package-build]   不含用户数据：user\\repos\\、非系统插件、thumbnails\\、debug.log 均不带；发布全局库仓库注册表与按仓库授权已清空",
);
console.log(
  "[package-build]   资产都在 exe 同级，与仓库内布局同构 ⇒ 包整夹搬走后 find_upwards 仍命中（D14 真正成立）",
);
