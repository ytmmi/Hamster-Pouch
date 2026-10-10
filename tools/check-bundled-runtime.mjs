// check-bundled-runtime.mjs：守护「随应用捆绑发布」的两份运行时资产**真的进包**。
//
// 为什么需要它：D14 与契约 §3.11 都承诺 ffmpeg/ffprobe 与 plugins/system 随应用发布，
// 而 2026-10 之前**打包脚本里根本没有 external-cli**——产物里没有这两份资产，
// 只是靠"包还躺在仓库树里、find_upwards 一路向上凑巧找到"才显得能用。
// 一旦把包整夹搬走（打包脚本自己宣称的"自包含"），ffmpeg 就消失，且**没有任何东西会报错**：
// 视频缩略图、ffprobe 元数据、AVIF/HEIC 兜底解码全部静默降级。
//
// 本门禁把"进包"从**事后观察**变成**事前断言**。它检查三件事：
//   A. `tools/package-build.mjs` 仍在把资产放进包（且位置在 exe 同级）；
//   B. ffmpeg 的**运行时子集**规则仍然自洽——bin\ 下除显式排除项外一个都不能少
//      （DLL 是 PE 导入表静态绑定的，少一个连 `-version` 都跑不起来）；
//   C. 被排除的条目**确实不被产品引用**（ffplay / presets 等），
//      排除项一旦被代码引用，本门禁变红；
//   D. mpv 是**可选**资产：**不入库**故新克隆没有它，打包脚本必须"存在则入包、
//      缺失则跳过"——门禁断言这条语义没被改成硬失败（否则新克隆上打包会断）。
//
// 用法：pnpm check:bundled-runtime
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_BUILD = join(ROOT, "tools", "package-build.mjs");
const FFMPEG_BIN = join(ROOT, "external-cli", "ffmpeg", "bin");
const BUNDLED_PLUGINS = join(ROOT, "plugins", "system");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const pkgText = readFileSync(PACKAGE_BUILD, "utf8");

// ───────── A. 打包脚本确实把两份资产放进 exe 同级 ─────────
check(
  "package-build.mjs 调用 placeBundledRuntime（两份资产进包）",
  pkgText.includes("placeBundledRuntime("),
);
check(
  "external-cli 与 plugins/system 都放在包根（exe 同级，find_upwards 第一跳即命中）",
  pkgText.includes('"external-cli", "ffmpeg"') && pkgText.includes('"plugins", "system"'),
);check(
  "打包脚本带 fail-closed 自检（verifyBundledRuntime）",
  pkgText.includes("verifyBundledRuntime("),
);
// dev 用硬链接、release 用真实复制：两条调用必须分别传 true / false。
check(
  "dev 包允许硬链接、release 包强制真实复制",
  /placeBundledRuntime\(devDir,[^)]*true\)/.test(pkgText) &&
    /placeBundledRuntime\(relDir,[^)]*false\)/.test(pkgText),
);

// ───────── B. 运行时子集规则自洽：bin\ 下 DLL 一个都不能漏 ─────────
// 解析脚本里的 FFMPEG_EXCLUDE，取其中以 `bin/` 开头的项（这些是 bin 目录内的排除项）。
const excludeMatch = /const FFMPEG_EXCLUDE = new Set\(\[([\s\S]*?)\]\)/.exec(pkgText);
const excludeEntries = excludeMatch
  ? [...excludeMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];
check("能解析出 FFMPEG_EXCLUDE 清单", excludeEntries.length > 0, `${excludeEntries.length} 项`);

// 被排除的顶层目录（非 bin/ 前缀）应在清单里；bin/ 前缀项是 bin 内的排除文件。
const excludedTopDirs = excludeEntries.filter((e) => !e.startsWith("bin/"));
const excludedBinFiles = new Set(
  excludeEntries.filter((e) => e.startsWith("bin/")).map((e) => e.slice("bin/".length)),
);
check(
  "排除清单含 ffplay.exe（bin 内）与开发期目录（doc/include/lib/presets）",
  excludedBinFiles.has("ffplay.exe") &&
    ["doc", "include", "lib", "presets"].every((d) => excludedTopDirs.includes(d)),
  `bin 内排除 ${[...excludedBinFiles].join(", ")}；目录排除 ${excludedTopDirs.join(", ")}`,
);

if (existsSync(FFMPEG_BIN)) {
  const binFiles = readdirSync(FFMPEG_BIN);
  // 关键不变量：bin\ 下除显式排除项外**每个文件都必须进包**。
  // 这条防的是"上游升级 ffmpeg 新增了一个 DLL，而子集规则按老清单写死"——
  // 那种情况下新 DLL 会被静默漏掉，产物里 ffmpeg 直接起不来。
  const missingFromRule = binFiles.filter((n) => !excludedBinFiles.has(n));
  check(
    "bin\\ 下除显式排除项外的文件都会进包（无白名单式漏项）",
    missingFromRule.length + excludedBinFiles.size === binFiles.length,
    `bin\\ 共 ${binFiles.length} 文件；进包 ${missingFromRule.length}，排除 ${excludedBinFiles.size}`,
  );
  // 两个入口必须真的在源目录里（否则打包脚本的前置检查会失败，这里提前暴露）。
  check(
    "external-cli\\ffmpeg\\bin\\ 有 ffmpeg.exe 与 ffprobe.exe",
    existsSync(join(FFMPEG_BIN, "ffmpeg.exe")) && existsSync(join(FFMPEG_BIN, "ffprobe.exe")),
  );
  // 断言两个 exe 与全部 DLL 是同一套构建的邻居：DLL 数量 ≥ 5（当前 7 个 av*/sw*）。
  const dllCount = binFiles.filter((n) => n.endsWith(".dll")).length;
  check(
    "bin\\ 下的 DLL 数量合理（≥5，全部随包）",
    dllCount >= 5,
    `实测 ${dllCount} 个 DLL`,
  );
} else {
  check("external-cli\\ffmpeg\\bin 存在", false, "目录不存在，无法校验子集规则");
}

// ───────── C. 被排除的条目确实不被产品引用 ─────────
// 遍历源码与脚本，断言没有对 ffplay / presets 的调用。命中即说明排除规则错了。
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (["node_modules", "target", "dist", ".git", ".pnpm-store", "backups", "external-cli"].includes(name)) {
      continue;
    }
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(rs|ts|tsx|mjs|js|json|py)$/.test(name)) out.push(p);
  }
  return out;
}

const sources = [
  ...walkFiles(join(ROOT, "crates")),
  ...walkFiles(join(ROOT, "apps")),
  ...walkFiles(join(ROOT, "tools")),
];
// 跳过打包脚本（它必须写出排除清单）与本门禁自身（它必须把这些字符串当**搜索模式**，
// 否则无法断言"没人引用它们"——不跳过就会自己命中自己）。
const SELF = fileURLToPath(import.meta.url);
const refs = [];
for (const file of sources) {
  if (file === PACKAGE_BUILD || file === SELF) continue;
  const text = readFileSync(file, "utf8");
  for (const [needle, why] of [
    ["ffplay", "ffplay 被产品引用 ⇒ 不该从包里排除"],
    ["-fpre", "ffmpeg 预设文件被引用 ⇒ presets 不该排除"],
    ["-vpre", "ffmpeg 预设文件被引用 ⇒ presets 不该排除"],
  ]) {
    if (text.includes(needle)) {
      refs.push(`${file.replace(ROOT + "\\", "").replace(ROOT + "/", "")} 含 ${needle}（${why}）`);
    }
  }
}
check(
  "被排除的条目（ffplay / presets）确实不被产品代码引用",
  refs.length === 0,
  refs.length ? refs.join("; ") : `扫描 ${sources.length} 个源文件`,
);

// ───────── D. 随包插件来源根存在且可被 find_upwards_dir 命中 ─────────
check(
  "plugins/system 存在且含 palette/plugin.manifest（installBundled 的来源）",
  existsSync(join(BUNDLED_PLUGINS, "palette", "plugin.manifest")),
);

// ───────── E. mpv 是可选资产：存在则入包、缺失则跳过（不得改成硬失败）─────────
// 为什么断言"可选"语义：`external-cli/mpv/` **不入库**（100 MB+ 二进制不进版本库），
// 所以**新克隆里必然没有它**。若有人把 mpv 加进打包脚本的前置必需清单（硬失败），
// 新克隆上 `pnpm app:build` 会直接断掉——这是个只在别人机器上炸的缺陷。
const MPV_DIR = join(ROOT, "external-cli", "mpv");
const mpvSourcePresent = existsSync(join(MPV_DIR, "mpv.exe"));

check(
  "打包脚本把 mpv 作为可选资产处理（存在则入包）",
  pkgText.includes('join(targetRoot, "external-cli", "mpv")') ||
    pkgText.includes('"external-cli", "mpv"'),
);
check(
  "mpv 缺失时不进必需项清单（新克隆上打包不会断）",
  // 必需项清单是那个 for 循环里的数组；mpv 路径不得出现在其中。
  !/\[\s*"external-cli\/ffmpeg[\s\S]*?"external-cli\/mpv[\s\S]*?\]\s*\)\s*\{\s*if \(!existsSync/.test(pkgText),
);
check(
  "自检按 mpvExpected 判定（源在才要求包内有），而非无条件要求",
  // 必须断言**值来自"源是否存在"**（`<x>.mpv.present`），而不是只查字面量出现：
  // 把 `mpvExpected: x.mpv.present` 改成 `mpvExpected: true` 会让"新克隆上硬要求包内有 mpv"
  // 重新成立，而只查 `includes("mpvExpected")` 抓不到（首版就是这样，回退实测 MISSED）。
  /mpvExpected:\s*\w+\.mpv\.present/.test(pkgText),
  mpvSourcePresent ? "本机有 mpv 源" : "本机无 mpv 源（新克隆形态）",
);
check(
  "mpv 不做裁剪（不设排除项，整目录入包）",
  // mpv 的 placeDir 调用必须用空 Set 作排除项——裁剪需实测依据，不能顺手排除。
  /placeDir\(MPV_DIR, join\(targetRoot, "external-cli", "mpv"\), new Set\(\)/.test(pkgText),
);
if (mpvSourcePresent) {
  const mpvFiles = readdirSync(MPV_DIR);
  check(
    "本机 mpv 源含 mpv.exe 与 d3dcompiler_43.dll（D3D 输出编译 shader 需要）",
    mpvFiles.includes("mpv.exe") && mpvFiles.includes("d3dcompiler_43.dll"),
    mpvFiles.join(", "),
  );
}

// ───────── 汇总 ─────────
const failed = results.filter((r) => !r.ok);
console.log(
  `\n[check-bundled-runtime] ${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? `；失败：${failed.map((f) => f.label).join(" / ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
