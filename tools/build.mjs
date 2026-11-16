/**
 * build.mjs：两条编译管线的**唯一编排入口**。
 *
 *   pnpm app:build      # 开发管线：X.Y.Z.A-Alpha（默认把 A 段 +1）
 *   pnpm app:release    # 发布管线：X.Y.Z[-beta]（默认把 Z 段 +1）
 *
 * 一次运行只做一条管线，**绝不碰另一条**（D230）：
 *  - 开发管线：只把新版本写进 tools/versions.json 的 dev 字段，然后把四段版本
 *    以 HP_APP_VERSION 环境变量传给 cargo；Cargo.toml / tauri.conf.json /
 *    apps/desktop/package.json 的发布版本一个字节都不动。
 *  - 发布管线：把新版本写进 tools/versions.json 的 release 字段，并派生三处副本
 *    （tauri.conf.json / 桥接 Cargo.toml 的 [package] version / apps/desktop/package.json），
 *    同时同样注入 HP_APP_VERSION（与 CARGO_PKG_VERSION 相同）与 HP_APP_PIPELINE。
 *
 * 为什么开发版本必须走环境变量：cargo 只认 semver，四段版本直接编译失败
 * （unexpected character '.' after patch version number）。四段版本由 build.rs
 * 读 HP_APP_VERSION 后以 cargo:rustc-env 烙进二进制（见 src/version.rs）。
 *
 * 两条管线的 X.Y.Z 是同一组数字（开发包 = 当前发布版本 + 迭代号 A），但发布版本
 * 每升一次 Z，开发包的 X.Y.Z 就**落后一个 patch**，这是被允许的常态（差值 1）。
 * 差值 >1（或有 major/minor 不同）时打印提示——见 version.mjs 的 pipelineDrift()。
 * 开发管线自动推导时把三段**重新对齐到当前发布版本**，所以两条管线不会越差越远。
 *
 * 发布管线**必须由开发者确认版本号**（产出会挂到 GitHub Release）：交互终端里会
 * 打印版本明细并要求输入 yes；回车取消，直接输入别的版本号则改用它。CI 与
 * `--yes` 跳过确认。开发管线不问（默认 A 段 +1）。
 *
 * 版本号只在**真实编译**时变更：只有真的跑 cargo/tauri 编译，才把新版本写进
 * tools/versions.json。--dry-run 与 HP_SKIP_TAURI_BUILD=1（只打包、只看计划）
 * 一律不写；只提交代码也不会变更版本号（pre-commit 只跑 check:*，不碰版本号）。
 * 编译失败会把版本号**回滚**到编译前的值，避免留下「版本升了、产物却没出来」的悬空版本。
 *
 * 参数：
 *   --pipeline dev|release   必填（scripts 里已经带上）
 *   --no-bump                不推导下一个版本，直接用当前版本（重打同一个版本）
 *   --version <版本>          指定版本（等价于 HP_VERSION，优先级最高）
 *   --yes                    跳过发布构建前的版本确认（CI 自动跳过，无需此开关）
 *   --dry-run                 只打印将要做什么，不写文件、不编译、不打包、不改版本号
 *   --skip-package            只编译，不执行 tools/package-build.mjs
 *
 * 环境变量：HP_VERSION（等同 --version）、HP_SKIP_TAURI_BUILD=1（只打包不编译，版本号不变更）、
 * CI=true（CI 里不做交互确认）。
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  bumpByPipeline,
  bumpPatch,
  composeDevVersion,
  devIteration,
  normalizeByPipeline,
  normalizePipeline,
  normalizeVersion,
  pipelineDrift,
  readVersions,
  tripletParts,
  verifyCopies,
  writeVersion,
} from "./version.mjs";

const ROOT = process.env.HP_PROJECT_ROOT
  ? resolve(process.env.HP_PROJECT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = [
  "用法：node tools/build.mjs --pipeline dev|release [--no-bump] [--version <版本>] [--yes] [--dry-run] [--skip-package]",
  "  --pipeline dev      开发管线（X.Y.Z.A-Alpha），只写 dev 版本",
  "  --pipeline release  发布管线（X.Y.Z[-beta]），写 release 版本并派生三处副本",
  "  --yes               跳过发布构建前的版本确认（CI 里自动跳过）",
].join("\n");

/** 解析命令行开关（不认识的一律报错，避免拼错后静默跑错管线）。 */
function parseArgs(argv) {
  const opts = { pipeline: "", dryRun: false, skipPackage: false, bump: true, version: "", yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pipeline") {
      opts.pipeline = normalizePipeline(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--pipeline=")) {
      opts.pipeline = normalizePipeline(arg.slice("--pipeline=".length));
    } else if (arg === "--version") {
      opts.version = String(argv[i + 1] ?? "").trim();
      i += 1;
    } else if (arg.startsWith("--version=")) {
      opts.version = arg.slice("--version=".length).trim();
    } else if (arg === "--no-bump") {
      opts.bump = false;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--skip-package") {
      opts.skipPackage = true;
    } else if (arg === "--yes" || arg === "-y") {
      opts.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error("无法识别的参数：" + arg + "\n" + USAGE);
    }
  }
  if (!opts.pipeline) throw new Error("必须显式指定 --pipeline dev 或 --pipeline release\n" + USAGE);
  return opts;
}

/**
 * 决定这次构建用哪个版本号（不写任何文件）。
 *
 * 返回的 `releaseNext` 是**发布管线这条线**下一次要用的版本，开发管线靠它对齐
 * X.Y.Z（开发包 = 下一个发布版本的开发快照）。`warning` 只在"开发者显式指定了
 * 开发版本、但它的 X.Y.Z 与发布管线不同"时出现——不擅自改写用户给的版本。
 */
export function planVersion(opts) {
  const pipeline = normalizePipeline(opts.pipeline);
  const explicit = String(opts.version || process.env.HP_VERSION || "").trim();
  const versions = readVersions();
  const current = versions[pipeline];
  const releaseNext = bumpPatch(versions.release);
  const plan = { pipeline, current, next: current, releaseNext, source: "", warning: "" };

  if (explicit) {
    plan.next = normalizeByPipeline(pipeline, explicit);
    plan.source = "指定版本";
  } else if (!opts.bump) {
    plan.source = "沿用当前版本";
  } else {
    plan.next = bumpByPipeline(pipeline, current);
    plan.source = "自动 +1";
  }

  if (pipeline === "dev") {
    const iteration = devIteration(plan.next);
    if (explicit) {
      const mine = tripletParts(plan.next);
      const official = tripletParts(versions.release);
      if (mine.major !== official.major || mine.minor !== official.minor || mine.patch !== official.patch) {
        plan.warning =
          "指定的开发版本 " + plan.next + " 的 X.Y.Z 与发布版本 " + versions.release +
          " 不同（两条管线应共用同一组 X.Y.Z，这里照你给的写，不改）";
      }
    } else if (opts.bump) {
      plan.next = composeDevVersion(versions.release, iteration);
      plan.source = "自动 A+1，X.Y.Z 对齐发布版本";
    }
  }
  return plan;
}

/** 打印两条管线的 X.Y.Z 偏差：正常打一行，>1 打警告（不阻断构建）。 */
function reportDrift(plan, versions) {
  const nextRelease = plan.pipeline === "release" ? plan.next : versions.release;
  const nextDev = plan.pipeline === "dev" ? plan.next : versions.dev;
  const drift = pipelineDrift(nextRelease, nextDev);
  const head = "两条管线: 发布 " + nextRelease + " / 开发 " + nextDev + " —— ";
  if (drift.level === "ok") {
    console.log("[build] " + head + drift.message);
  } else {
    console.log("[build] 警告: " + head + drift.message);
  }
}

/**
 * 发布构建前让开发者确认版本号，返回最终采用的版本。
 *
 * 发布包会以 `v<版本>` 标签挂到 GitHub Release，版本一旦错了就要删标签重发，
 * 所以这里**默认拦一道**：交互终端里必须明确回答。回车 = 取消构建（不动版本），
 * 直接输入另一个合法版本号 = 改用它。
 */
async function confirmRelease(plan, versions, opts) {
  console.log(
    [
      "[build] 即将构建**发布包**（会挂到 GitHub Release）：",
      "  当前发布版本: " + versions.release,
      "  本次发布版本: " + plan.next + "（" + plan.source + "）",
      "  开发版本保持: " + versions.dev + "（发布构建不改开发版本）",
    ].join("\n"),
  );

  if (opts.yes) {
    console.log("[build] --yes：跳过版本确认，使用 " + plan.next);
    return plan.next;
  }
  if (process.env.CI === "true" || process.env.CI === "1") {
    console.log("[build] CI 环境（CI=true）：不做交互确认，使用 " + plan.next);
    return plan.next;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "发布构建必须由开发者确认版本号，但当前不是交互终端（重定向/管道/脚本调用）。" +
        "请在终端里直接运行 pnpm app:release；确认版本无误时也可以加 --yes 跳过确认",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const raw = (
        await rl.question(
          "确认用 " + plan.next + " 构建发布包？（回车=取消 / yes=继续 / 直接输入另一个版本号=改用它）> ",
        )
      ).trim();
      if (!raw) throw new Error("已取消：没有构建发布包，版本号未改动");
      if (/^(y|yes|是|确认|确认构建)$/i.test(raw)) return plan.next;
      let fixed;
      try {
        fixed = normalizeVersion(raw);
      } catch (e) {
        console.log("[build] " + e.message);
        continue;
      }
      console.log("[build] 改用 " + fixed + " 构建发布包");
      return fixed;
    }
  } finally {
    rl.close();
  }
}

/** 跑子进程并转发输出；失败直接冒泡（调用方统一打中文错误）。 */
function run(cmd, args, env) {
  console.log("[build] $ " + cmd + " " + args.join(" "));
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
}

async function main(argv) {
  const opts = parseArgs(argv);
  const plan = planVersion(opts);
  const versions = readVersions();
  // 只有真的跑 cargo/tauri 编译才算「真实构建」：这时才允许改版本号。
  // --dry-run 与 HP_SKIP_TAURI_BUILD=1 都不编译，因此版本号一律不动。
  const realBuild = !opts.dryRun && process.env.HP_SKIP_TAURI_BUILD !== "1";

  console.log("[build] 管线: " + plan.pipeline);
  console.log("[build] 版本: " + plan.current + " → " + plan.next + "（" + plan.source + "）");

  if (plan.pipeline === "dev") {
    console.log("[build] 发布版本保持 " + versions.release + "（开发构建不改发布版本）");
  } else {
    console.log("[build] 开发版本保持 " + versions.dev + "（发布构建不改开发版本）");
  }
  if (plan.warning) console.log("[build] 注意: " + plan.warning);

  reportDrift(plan, versions);

  if (!realBuild) {
    console.log(
      "[build] 版本号不变更：" +
        (opts.dryRun ? "--dry-run" : "HP_SKIP_TAURI_BUILD=1（没有真实编译）") +
        "，versions.json 保持 " + plan.pipeline + " = " + versions[plan.pipeline],
    );
    console.log("[build] 版本号只在真实编译构建时变更：只提交代码、只打包都不改版本号");
    if (opts.dryRun && plan.pipeline === "release") {
      console.log("[build] --dry-run：实际执行时会先要求开发者确认版本号（--yes 可跳过）");
    }
    return 0;
  }

  if (plan.pipeline === "release") {
    const confirmed = await confirmRelease(plan, versions, opts);
    if (confirmed !== plan.next) {
      plan.next = confirmed;
      plan.source = "开发者确认时改写";
      console.log("[build] 版本: " + plan.current + " → " + plan.next + "（" + plan.source + "）");
      reportDrift(plan, versions);
    }
  }

  // 编译前先记下磁盘上的版本，编译失败好原样回滚。
  const before = readVersions();
  writeVersion(plan.pipeline, plan.next);
  if (plan.pipeline === "release") verifyCopies();

  const env = {
    HP_APP_VERSION: plan.next,
    HP_APP_PIPELINE: plan.pipeline,
  };

  try {
    run("pnpm", ["--filter", "@hamster-pouch/desktop", "exec", "tauri", "build", "--no-bundle"], env);
  } catch (e) {
    writeVersion(plan.pipeline, before[plan.pipeline]);
    if (plan.pipeline === "release") verifyCopies();
    console.log("[build] 编译失败：版本号已回滚到 " + before[plan.pipeline]);
    throw new Error("编译失败（版本号已回滚）：" + e.message);
  }

  if (!opts.skipPackage) {
    run("node", ["tools/package-build.mjs", "--pipeline", plan.pipeline], env);
  }

  console.log("[build] " + plan.pipeline + " 管线完成：" + plan.next);
  return 0;
}

const SELF = fileURLToPath(import.meta.url).toLowerCase();
const ENTRY = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (ENTRY === SELF) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error("[build] " + e.message);
      process.exitCode = 1;
    },
  );
}
