#!/usr/bin/env node
/**
 * artifact-name.mjs：发布产物文件名的**唯一入口**。
 *
 * 为什么需要它：同一个名字要在三处各拼一次（`release.yml` 的 zip 文件名、Actions 的
 * artifact 名、Release 资产的路径），而**产物名是用户挑包时读的第一手信息**——拼错一处
 * 就会出现"发布页上的包名和文档/更新清单里写的对不上"。规则只写在这里，其余地方一律
 * 调用本脚本，不许再手拼。
 *
 * 命名（对齐一般开源软件的产物名习惯，用户口径 2026-11-10）：
 *
 *     Hamster-Pouch-v0.1.13-Alpha-Windows-x64-Portable.zip
 *     └── 软件名 ──┘ └─版本──┘ └平台─┘ └架构┘ └安装方式┘
 *
 * 五段用 `-` 连接，段内只用 ASCII：平台首字母大写（`Windows`）、架构小写（`x64`）、
 * 安装方式首字母大写（`Portable`）——与 `CC-Switch-v4.0.25-Windows-arm64-Portable.zip`
 * 这类常见产物逐段同构。**软件名用仓库英文名 `Hamster-Pouch` 而不是中文「仓鼠颊」**：
 * 中文文件名在 zip 解压、URL 转义、跨工具传递上处处要额外处理，却换不来任何信息量
 * （发布页上中文已经写在标题里）。**exe 名 `hamster-pouch-desktop.exe` 不跟着改**：
 * 它是进程名、快捷方式目标与自更新替换目标的共同锚点，改名是另一件事（D153 边界）。
 *
 * 版本段恒带 `v`（`v0.1.13-Alpha`）。后缀 `-Alpha` **原样保留**——它是版本的一部分，
 * 摘掉会让 Alpha 包与将来的正式包同名。**构建元数据 `+xxx` 不参与命名**：semver 里它
 * 不影响版本先后，而 `+` 在 URL 与部分工具里要转义。
 *
 * 用法（任意工作目录均可，与 version.mjs 同一套 `HP_PROJECT_ROOT` 隔离口径）：
 *   node tools/artifact-name.mjs                      # 当前版本的产物基名
 *   node tools/artifact-name.mjs --zip                # 同上，带 .zip
 *   node tools/artifact-name.mjs --version 0.1.14-Alpha [--zip]
 *   node tools/artifact-name.mjs --self-test          # 纯函数自检（`pnpm check:artifact-name`）
 *
 * 退出码：0 成功；1 参数/版本号不合法（错误信息一律中文，直接给人看）。
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { normalizeVersion, readAppVersion } from "./version.mjs";

/** 软件名（仓库英文名，与 GitHub 仓库 / 发布页标题一致）。 */
export const PRODUCT = "Hamster-Pouch";

/** 平台段：本仓只出 Windows 包（`rust-toolchain.toml` 硬编码 x86_64-pc-windows-msvc）。 */
export const PLATFORM = "Windows";

/**
 * 架构段：`x64` 对应当前唯一的三元组 `x86_64-pc-windows-msvc`。
 * 将来出 arm64 包时改成参数传入（`artifactBase({ arch: "arm64" })`），**不要**另写一套命名。
 */
export const ARCH = "x64";

/** 安装方式段：本仓只发便携文件夹（D14 / D122），没有 NSIS/MSI 通道。 */
export const METHOD = "Portable";

/**
 * 产物名里每一段都必须是"ASCII + 数字 + 连字符/点"，且不以符号开头。
 * 这道校验挡的是**拼错的软件名/平台名**（空格、中文、斜杠），不是版本号——
 * 版本号已由 `normalizeVersion` 按 semver 校验过，它本来就不允许路径分隔符。
 */
const SEGMENT_RE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

/**
 * 产物基名（不含扩展名，也是 zip 内**顶层目录名**，因此解压即得同名文件夹）。
 *
 * @param {object} opts
 * @param {string} opts.version 应用版本（`0.1.13-Alpha`；不合法直接抛错）
 * @param {string} [opts.product] 软件名段
 * @param {string} [opts.platform] 平台段
 * @param {string} [opts.arch] 架构段
 * @param {string} [opts.method] 安装方式段
 * @returns {string} 形如 `Hamster-Pouch-v0.1.13-Alpha-Windows-x64-Portable`
 */
export function artifactBase({
  version,
  product = PRODUCT,
  platform = PLATFORM,
  arch = ARCH,
  method = METHOD,
} = {}) {
  // 先按 semver 校验（非法版本号不能进文件名），再摘掉 `+构建元数据`。
  const bare = normalizeVersion(version).split("+")[0];
  const segments = [product, `v${bare}`, platform, arch, method];
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new Error(
        `产物名的段不合法：${JSON.stringify(segment)} —— 每段只能是字母/数字/连字符/点，` +
          "且不得以符号开头（中文、空格、下划线、斜杠都不行）",
      );
    }
  }
  return segments.join("-");
}

/**
 * 产物文件名（基名 + `.zip`）。
 * zip 是**唯一**发布形态：一个压缩包 = 一个可运行文件夹（D122）。
 */
export function artifactFileName(opts) {
  return `${artifactBase(opts)}.zip`;
}

/** 自检里的断言（失败即抛，只在所有断言跑完后汇总，便于一次看全）。 */
function selfTest() {
  const failures = [];
  let total = 0;
  const check = (label, fn) => {
    total += 1;
    try {
      fn();
      console.log(`  ✓ ${label}`);
    } catch (e) {
      failures.push(`${label} —— ${e.message}`);
      console.log(`  ✗ ${label} —— ${e.message}`);
    }
  };
  const eq = (actual, expected, what = "") => {
    if (actual !== expected) {
      throw new Error(`${what}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
  };
  const throws = (fn, what) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`${what}本应抛错却通过了`);
  };

  console.log("[artifact-name] 自检：");

  check("当前版本（0.1.13-Alpha）的基名逐字正确", () => {
    eq(
      artifactBase({ version: "0.1.13-Alpha" }),
      "Hamster-Pouch-v0.1.13-Alpha-Windows-x64-Portable",
    );
  });

  check("带 .zip 的文件名 = 基名 + .zip", () => {
    eq(
      artifactFileName({ version: "0.1.13-Alpha" }),
      "Hamster-Pouch-v0.1.13-Alpha-Windows-x64-Portable.zip",
    );
  });

  check("无预发布后缀的版本同样成形（将来发正式版）", () => {
    eq(artifactBase({ version: "1.0.0" }), "Hamster-Pouch-v1.0.0-Windows-x64-Portable");
  });

  check("构建元数据 +build 不进文件名（semver 里不影响先后）", () => {
    eq(
      artifactBase({ version: "1.0.0+build.5" }),
      artifactBase({ version: "1.0.0" }),
    );
    if (artifactBase({ version: "1.0.0+build.5" }).includes("+")) {
      throw new Error("文件名里出现了 +");
    }
  });

  check("与用户给的样例同构：一条正则同时套住样例与我们的产物名", () => {
    // 参照样本来自用户原话（2026-11-10）：软件名-v版本-平台-架构-安装方式。
    // 软件名自身可以含连字符（CC-Switch / Hamster-Pouch），所以不能按 `-` 切段数，
    // 只能按"每一段的形状"整体匹配。
    const SHAPE =
      /^(?<name>[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-v(?<ver>\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)*)-(?<plat>[A-Z][A-Za-z]+)-(?<arch>[a-z0-9]+)-(?<method>[A-Z][A-Za-z]+)$/;
    const sample = "CC-Switch-v4.0.25-Windows-arm64-Portable";
    const ours = artifactBase({ version: "0.1.13-Alpha" });
    const sampleMatch = SHAPE.exec(sample);
    const ourMatch = SHAPE.exec(ours);
    if (!sampleMatch) throw new Error(`参照样本不满足五段形状：${sample}`);
    if (!ourMatch) throw new Error(`产物名不满足五段形状：${ours}`);
    eq(ourMatch.groups.name, PRODUCT, "软件名段：");
    eq(ourMatch.groups.ver, "0.1.13-Alpha", "版本段：");
    eq(ourMatch.groups.plat, "Windows", "平台段：");
    eq(ourMatch.groups.arch, "x64", "架构段：");
    eq(ourMatch.groups.method, "Portable", "安装方式段：");
  });

  check("架构段可覆盖（将来 arm64 包同一条规则）", () => {
    eq(
      artifactBase({ version: "0.1.0", arch: "arm64" }),
      "Hamster-Pouch-v0.1.0-Windows-arm64-Portable",
    );
  });

  check("产物名不含 Windows 文件名非法字符与空白", () => {
    const name = artifactFileName({ version: "0.1.13-Alpha" });
    if (/[\\/:*?"<>|\s]/.test(name)) throw new Error(`含非法字符：${name}`);
  });

  check("版本号非法时抛错（不静默产出怪名字）", () => {
    throws(() => artifactBase({ version: "0.1" }), "两段版本号");
    throws(() => artifactBase({ version: "0.1.3/evil" }), "含路径分隔符的版本号");
    throws(() => artifactBase({ version: "" }), "空版本号");
  });

  check("段不合法时抛错（挡住中文/空格/下划线）", () => {
    throws(() => artifactBase({ version: "1.0.0", product: "仓鼠颊" }), "中文软件名");
    throws(() => artifactBase({ version: "1.0.0", platform: "Win dows" }), "含空格的平台名");
    throws(() => artifactBase({ version: "1.0.0", arch: "x_64" }), "含下划线的架构名");
  });

  if (failures.length) {
    throw new Error(`${failures.length} 项自检失败`);
  }
  console.log(`[artifact-name] 自检通过（${total} 项）`);
}

/** 命令行入口。 */
function main(argv) {
  const args = [...argv];
  let withZip = false;
  let version = null;

  while (args.length) {
    const arg = args.shift();
    if (arg === "--zip") {
      withZip = true;
      continue;
    }
    if (arg === "--version" || arg === "--set") {
      version = String(args.shift() ?? "").trim();
      if (!version) throw new Error("--version 缺少版本号参数");
      continue;
    }
    if (arg === "--self-test") {
      selfTest();
      return 0;
    }
    throw new Error(`无法识别的参数 ${JSON.stringify(arg)}\n${USAGE}`);
  }

  const resolved = version ? normalizeVersion(version) : readAppVersion();
  const base = artifactBase({ version: resolved });
  console.log(withZip ? `${base}.zip` : base);
  return 0;
}

const USAGE = `用法：
  node tools/artifact-name.mjs                      # 当前版本的产物基名
  node tools/artifact-name.mjs --zip                # 同上，带 .zip
  node tools/artifact-name.mjs --version <v> [--zip]
  node tools/artifact-name.mjs --self-test`;

// 仅在被直接执行时跑 CLI；被 `import` 引入时只暴露纯函数（与 version.mjs 同口径）。
const SELF = fileURLToPath(import.meta.url).toLowerCase();
const ENTRY = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (ENTRY === SELF) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`[artifact-name] ${e.message}`);
    process.exitCode = 1;
  }
}
