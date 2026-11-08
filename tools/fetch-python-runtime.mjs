#!/usr/bin/env node
/**
 * 获取**随包 Python 运行时**（`plugins/system/python-core/runtime/`）。
 *
 * 为什么要有这个脚本（而不是"把解释器解压进去提交"）：
 *   1. **D20**：能部署在项目内的一律项目内化，但版本必须用**锁定文件**固定
 *      （`tools/python-runtime.lock.json`：URL + 字节数 + sha256），不靠"本机碰巧有 Python"。
 *   2. 解释器约 12MB 压缩 / 25MB 展开，且是**第三方二进制**：入库会污染版本库，也不该让
 *      GitHub 单文件上限成为约束（与 `external-cli/mpv` 同口径；`.gitignore` 忽略
 *      `plugins/system/python-core/runtime/`）。
 *   3. 用户机器**不依赖系统 Python**（RFC 0009「内嵌或随包发布」）：所以构建期必须把它
 *      落到插件目录里，`pnpm app:build` 才有可发布的东西。
 *
 * 用法：
 *   node tools/fetch-python-runtime.mjs          # 缓存命中则直接用；否则下载+校验+解压
 *   node tools/fetch-python-runtime.mjs --check  # 只校验已落地运行时（**不联网**，门禁用）
 *   node tools/fetch-python-runtime.mjs --force  # 忽略缓存重新下载
 *
 * 退出码：0 成功；1 失败（缺运行时/校验不符）。**fail-closed**：宁可直接失败，也不留一个
 * "看起来打好了、运行时却是空的"插件包 —— 那正是本脚本存在的理由。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = join(ROOT, "tools", "python-runtime.lock.json");
const CACHE_DIR = join(ROOT, "target", "py-runtime-cache");
// 运行时落点：**插件包内**（entry 是 bin/python-core.exe，它按自身路径推包根再找 runtime/）。
const DEST = join(ROOT, "plugins", "system", "python-core", "runtime");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const force = args.has("--force");

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
const zipName = lock.url.split("/").pop();
const cacheZip = join(CACHE_DIR, zipName);
const EXPECTED_SHA = String(lock.sha256 || "").toLowerCase();

function fail(message) {
  console.error(`[python-runtime] ✗ ${message}`);
  process.exit(1);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/** 运行时是否已落地且**可执行**（不只看目录存在）。 */
function verifyRuntime({ quiet = false } = {}) {
  const problems = [];
  const exe = join(DEST, "python.exe");
  if (!existsSync(exe)) problems.push(`缺 ${exe.replace(ROOT, "")}`);
  // 标准库压缩包是 embeddable 包的形态特征：只有 python.exe 而没有它 = 解压坏了。
  const stdlib = join(DEST, `python${lock.version.split(".")[0]}${lock.version.split(".")[1]}.zip`);
  if (!existsSync(stdlib)) problems.push(`缺标准库 ${stdlib.replace(ROOT, "")}`);
  if (problems.length === 0) {
    // 真判据：**它能启动并自报版本**。只断言文件存在会放过"架构不对/DLL 缺失"的包。
    const probe = spawnSync(exe, ["-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"], {
      encoding: "utf8",
    });
    const got = (probe.stdout || "").trim();
    if (probe.status !== 0 || got !== lock.version) {
      problems.push(
        `随包解释器自检失败：期望 ${lock.version}，实际 "${got}"` +
          (probe.stderr ? ` stderr=${probe.stderr.trim().split("\n")[0]}` : ""),
      );
    }
  }
  if (!quiet) {
    if (problems.length === 0) {
      console.log(`[python-runtime] ✓ 运行时就绪：Python ${lock.version} @ plugins/system/python-core/runtime/`);
    } else {
      for (const p of problems) console.error(`[python-runtime] ✗ ${p}`);
    }
  }
  return problems;
}

if (checkOnly) {
  const problems = verifyRuntime();
  if (problems.length > 0) {
    fail(
      "随包 Python 运行时未就绪。先跑 `node tools/fetch-python-runtime.mjs`" +
        "（需要网络；若要跳过，本机必须已有该目录）。",
    );
  }
  process.exit(0);
}

// ───────── 1) 取压缩包：缓存优先（sha256 不符即重下）─────────
mkdirSync(CACHE_DIR, { recursive: true });
let haveZip = false;
if (!force && existsSync(cacheZip)) {
  const size = statSync(cacheZip).size;
  if (String(size) === String(lock.size) && sha256File(cacheZip) === EXPECTED_SHA) {
    haveZip = true;
    console.log(`[python-runtime] 缓存命中：${cacheZip.replace(ROOT, "")}（${size} 字节）`);
  } else {
    console.log("[python-runtime] 缓存与锁定文件不符，重新下载");
  }
}

if (!haveZip) {
  console.log(`[python-runtime] 下载 ${lock.url}`);
  const part = `${cacheZip}.part`;
  rmSync(part, { force: true });
  const started = Date.now();
  let response;
  try {
    response = await fetch(lock.url, { redirect: "follow" });
  } catch (e) {
    fail(`下载失败（网络不可达或 TLS 失败）：${e.message}`);
  }
  if (!response.ok || !response.body) fail(`下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") || lock.size);
  let seen = 0;
  let lastTick = 0;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    seen += chunk.length;
    const mb = seen / 1048576;
    if (mb - lastTick >= 2) {
      lastTick = mb;
      console.log(`[python-runtime]   …${mb.toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
    }
  });
  await pipeline(body, createWriteStream(part));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (statSync(part).size !== Number(lock.size)) {
    fail(`字节数不符：期望 ${lock.size}`);
  }
  renameSync(part, cacheZip);
  console.log(`[python-runtime] 下载完成：${(Number(lock.size) / 1048576).toFixed(1)} MB / ${seconds}s`);
}

const actualSha = sha256File(cacheZip);
if (EXPECTED_SHA.startsWith("__")) {
  // 首次固定：把真实摘要写回锁定文件（人工复核后提交）。
  lock.sha256 = actualSha;
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`[python-runtime] 锁定文件尚未固定摘要，已写入 sha256=${actualSha}`);
} else if (actualSha !== EXPECTED_SHA) {
  fail(`sha256 不符：期望 ${EXPECTED_SHA}，实际 ${actualSha}（拒绝解压不可信的产物）`);
}

// ───────── 2) 解压到插件包（先清后解，保证是本次规则的确定性结果）─────────
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
// 用 bsdtar 解 zip：Windows 10+ 自带 System32\tar.exe（bsdtar/libarchive，能读 zip），
// 且它就在 PATH 上；MSYS 的 unzip 不保证存在。两者都试，任一成功即可。
const attempts = [
  ["tar", ["-xf", cacheZip, "-C", DEST]],
  ["unzip", ["-o", "-q", cacheZip, "-d", DEST]],
];
let extracted = false;
for (const [bin, argv] of attempts) {
  const r = spawnSync(bin, argv, { stdio: "ignore" });
  if (r.status === 0 && existsSync(join(DEST, "python.exe"))) {
    extracted = true;
    console.log(`[python-runtime] 解压完成（${bin}）`);
    break;
  }
}
if (!extracted) fail("解压失败：tar 与 unzip 都不可用或产物不完整");

const problems = verifyRuntime();
if (problems.length > 0) fail("解压后自检未通过");
console.log(`[python-runtime] ✓ ${DEST.replace(ROOT, "")} 就绪（Python ${lock.version}）`);
