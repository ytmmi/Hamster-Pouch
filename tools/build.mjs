/**
 * build.mjs：两条编译管线的**唯一编排入口**。
 *
 *   pnpm app:build      # 开发管线：X.Y.Z.A-Alpha（默认把 A 段 +1）
 *   pnpm app:release    # 发布管线：X.Y.Z[-beta]（默认沿用当前版本，--bump 才把 Z 段 +1）
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
 * 发布管线**默认不改版本号**（D232），并且**必须由开发者确认**（产出会挂到 GitHub
 * Release）：交互终端里会打印版本明细并要求输入 yes；回车取消，直接输入别的版本号
 * 则改用它。要发新号得显式 `--bump`。CI 与 `--yes` 跳过确认。开发管线不问（默认 A 段 +1）。
 *
 * 版本号只在**真实编译**时变更：只有真的跑 cargo/tauri 编译，才把新版本写进
 * tools/versions.json。--dry-run 与 HP_SKIP_TAURI_BUILD=1（只打包、只看计划）
 * 一律不写；只提交代码也不会变更版本号（pre-commit 只跑 check:*，不碰版本号）。
 * 编译失败会把版本号**回滚**到编译前的值，避免留下「版本升了、产物却没出来」的悬空版本。
 *
 * 参数：
 *   --pipeline dev|release   必填（scripts 里已经带上）
 *   --bump                   推导下一个版本（发布管线 Z 段 +1；开发管线本来就是默认行为）
 *   --no-bump                不推导下一个版本，直接用当前版本（重打同一个版本）
 *   --version <版本>          指定版本（等价于 HP_VERSION，优先级最高）
 *   --yes                    跳过发布构建前的版本确认（CI 自动跳过，无需此开关）
 *   --dry-run                 只打印将要做什么，不写文件、不编译、不打包、不改版本号
 *   --skip-package            只编译，不执行 tools/package-build.mjs
 *   --self-test               纯函数自检（pnpm check:build-plan），不读磁盘、不改版本号
 *
 * **两条管线的默认推导方式不同**（D232）：开发管线默认 `A` 段 +1（迭代很密，每次构建
 * 都该有个新号）；发布管线默认**沿用当前版本**——发布是人工决策，脚本不替人挑号，重打
 * 同一个版本（补资产、重跑流水线）也不会被莫名抬号。要发新号就显式加 `--bump`，
 * 或者用 `--version <版本>` / HP_VERSION 直接指定。
 *
 * 环境变量：HP_VERSION（等同 --version）、HP_BUMP=1（等同 --bump，给 release.yml 的 `version=next`
 * 用）、HP_SKIP_TAURI_BUILD=1（只打包不编译，版本号不变更）、CI=true（CI 里不做交互确认）。
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
  "用法：node tools/build.mjs --pipeline dev|release [--bump|--no-bump] [--version <版本>] [--yes] [--dry-run] [--skip-package]",
  "  --pipeline dev      开发管线（X.Y.Z.A-Alpha），只写 dev 版本；默认 A 段 +1",
  "  --pipeline release  发布管线（X.Y.Z[-beta]），写 release 版本并派生三处副本；默认沿用当前版本",
  "  --bump              推导下一个版本（发布管线 Z 段 +1；开发管线本来就是默认行为）",
  "  --no-bump           沿用当前版本（开发管线用它重打同一个迭代号）",
  "  --yes               跳过发布构建前的版本确认（CI 里自动跳过）",
  "  --self-test         纯函数自检（pnpm check:build-plan）",
].join("\n");

/** 管线默认是否推导新版本号（D232）：开发每次都 +1；发布**沿用当前版本**。 */
export function defaultBump(pipeline) {
  return normalizePipeline(pipeline) === "dev";
}

/**
 * 解析命令行开关（不认识的一律报错，避免拼错后静默跑错管线）。
 *
 * `bump` 是三态：`true` = 显式 `--bump`、`false` = 显式 `--no-bump`、`null` = 没说，
 * 落到 `defaultBump(pipeline)` 上——**开发管线默认 +1，发布管线默认不动号**（D232）。
 */
function parseBuildArgs(argv) {
  const opts = { pipeline: "", dryRun: false, skipPackage: false, bump: null, version: "", yes: false };
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
    } else if (arg === "--bump") {
      opts.bump = true;
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
  // HP_BUMP=1 等同 --bump：workflow 的手动输入里没法传命令行开关，只能走环境变量。
  const envBump = String(process.env.HP_BUMP ?? "").trim().toLowerCase();
  if (opts.bump === null && (envBump === "1" || envBump === "true")) opts.bump = true;
  if (opts.bump === null) opts.bump = defaultBump(opts.pipeline);
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
  const releaseNext = bumpPatch(versions.release);
  const core = decideVersionPlan({
    pipeline,
    current: versions[pipeline],
    releaseVersion: versions.release,
    explicit,
    bump: opts.bump,
  });
  return { pipeline, current: versions[pipeline], next: core.next, releaseNext, source: core.source, warning: core.warning };
}

/**
 * 纯函数版的核心决策：不读磁盘、不写文件，只做「用哪个号」这一步。
 *
 * 抽出来是为了自检（`pnpm check:build-plan`）能在没有 versions.json 的情况下把两条
 * 管线的默认行为都跑一遍。`bump` 省略（`undefined` / `null`）时落到
 * `defaultBump(pipeline)`：**开发 +1，发布沿用当前版本**（D232）。
 */
export function decideVersionPlan({ pipeline, current, releaseVersion, explicit = "", bump }) {
  const plan = { pipeline: normalizePipeline(pipeline), current, next: current, source: "", warning: "" };
  const shouldBump = bump === undefined || bump === null ? defaultBump(plan.pipeline) : Boolean(bump);
  const text = String(explicit ?? "").trim();

  if (text) {
    plan.next = normalizeByPipeline(plan.pipeline, text);
    plan.source = "指定版本";
  } else if (!shouldBump) {
    plan.source = "沿用当前版本";
  } else {
    plan.next = bumpByPipeline(plan.pipeline, current);
    plan.source = "自动 +1";
  }

  if (plan.pipeline === "dev") {
    const iteration = devIteration(plan.next);
    if (text) {
      const mine = tripletParts(plan.next);
      const official = tripletParts(releaseVersion);
      if (mine.major !== official.major || mine.minor !== official.minor || mine.patch !== official.patch) {
        plan.warning =
          "指定的开发版本 " + plan.next + " 的 X.Y.Z 与发布版本 " + releaseVersion +
          " 不同（两条管线应共用同一组 X.Y.Z，这里照你给的写，不改）";
      }
    } else if (shouldBump) {
      plan.next = composeDevVersion(releaseVersion, iteration);
      plan.source = "自动 A+1，X.Y.Z 对齐发布版本";
    }
  }
  return plan;
}

/**
 * 纯函数自检（`pnpm check:build-plan`）：把「默认要不要动版本号」这条口径钉死。
 *
 * 这里只测纯函数，不读 versions.json、不碰 git——发布管线默认沿用当前版本是
 * D232 的核心约定，被谁改回去都必须当场红。
 */
export function selfTest() {
  let count = 0;
  const eq = (actual, expected, what) => {
    count += 1;
    if (actual !== expected) {
      throw new Error("自检失败：" + what + " —— 期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
    }
  };
  const throws = (fn, what) => {
    count += 1;
    let hit = false;
    try {
      fn();
    } catch {
      hit = true;
    }
    if (!hit) throw new Error("自检失败：" + what + " —— 期望抛错，实际没有");
  };

  // ① 默认值：开发 +1，发布沿用当前版本（D232 的核心）。
  eq(defaultBump("dev"), true, "开发管线默认推导新版本号");
  eq(defaultBump("release"), false, "发布管线默认沿用当前版本号");
  throws(() => defaultBump("nightly"), "未知管线应当报错");

  // ② 发布管线：不传 bump 时号不动，显式 --bump 才 +1。
  const releaseQuiet = decideVersionPlan({ pipeline: "release", current: "0.1.1-beta", releaseVersion: "0.1.1-beta" });
  eq(releaseQuiet.next, "0.1.1-beta", "发布管线默认不改号");
  eq(releaseQuiet.source, "沿用当前版本", "发布管线默认的来源说明");
  const releaseBump = decideVersionPlan({
    pipeline: "release", current: "0.1.1-beta", releaseVersion: "0.1.1-beta", bump: true,
  });
  eq(releaseBump.next, "0.1.2-beta", "发布管线 --bump 时 Z 段 +1");
  eq(releaseBump.source, "自动 +1", "发布管线 --bump 的来源说明");
  const releaseSpan = decideVersionPlan({
    pipeline: "release", current: "0.1.1-beta", releaseVersion: "0.1.1-beta", explicit: "0.3.0",
  });
  eq(releaseSpan.next, "0.3.0", "显式版本号优先于一切推导");
  eq(releaseSpan.source, "指定版本", "显式版本号的来源说明");

  // ③ 开发管线：默认 A 段 +1，并把 X.Y.Z 对齐到发布版本。
  const devDefault = decideVersionPlan({
    pipeline: "dev", current: "0.1.1.3-Alpha", releaseVersion: "0.1.5-beta",
  });
  eq(devDefault.next, "0.1.5.4-Alpha", "开发管线默认 A+1 且 X.Y.Z 对齐发布版本");
  const devHold = decideVersionPlan({
    pipeline: "dev", current: "0.1.1.3-Alpha", releaseVersion: "0.1.1-beta", bump: false,
  });
  eq(devHold.next, "0.1.1.3-Alpha", "开发管线 --no-bump 时号不动");
  eq(devHold.source, "沿用当前版本", "开发管线 --no-bump 的来源说明");

  // ④ 开发管线显式指定了不同 X.Y.Z：照写，但必须留一条 warning。
  const devDrift = decideVersionPlan({
    pipeline: "dev", current: "0.1.1.3-Alpha", releaseVersion: "0.1.1-beta", explicit: "0.2.0.7-Alpha",
  });
  eq(devDrift.next, "0.2.0.7-Alpha", "显式开发版本照写");
  eq(devDrift.warning !== "", true, "X.Y.Z 与发布版本不一致时应留 warning");

  // ⑤ 同样的输入、只换管线：开发动号、发布不动号 —— 这条红了说明口径又被改回去了。
  const devSame = decideVersionPlan({ pipeline: "dev", current: "0.1.1.1-Alpha", releaseVersion: "0.1.1-beta" });
  eq(devSame.next, "0.1.1.2-Alpha", "同样输入下开发管线应当动号");
  eq(releaseQuiet.next, "0.1.1-beta", "同样输入下发布管线应当不动号");

  console.log("[build] 自检通过（" + count + " 项）");
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
  const lines = [
    "[build] 即将构建**发布包**（会挂到 GitHub Release）：",
    "  当前发布版本: " + versions.release,
    "  本次发布版本: " + plan.next + "（" + plan.source + "）",
    "  开发版本保持: " + versions.dev + "（发布构建不改开发版本）",
  ];
  if (plan.next === versions.release) {
    lines.push("  提示: 发布管线默认沿用当前版本号；要 Z 段 +1 请加 --bump，或在下面的提示里直接输入新版本号");
  }
  console.log(lines.join("\n"));

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
  if (argv.includes("--self-test")) {
    selfTest();
    return 0;
  }
  const opts = parseBuildArgs(argv);
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
