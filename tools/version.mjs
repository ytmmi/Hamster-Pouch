/**
 * version.mjs：应用版本号的**唯一入口**——两条编译管线各管一个版本，互不覆盖。
 *
 * 两条管线（口径见 D230）：
 *  - **开发管线**：X.Y.Z.A-Alpha（四段数字 + -Alpha 后缀，例如 0.1.1.1-Alpha）。
 *    A 是开发过程中的迭代号；-Alpha（大小写不限）**只属于**开发管线。
 *  - **发布管线**：X.Y.Z，可带 -beta 后缀或完全无后缀（例如 0.1.1-beta、1.0.0）。
 *
 * X.Y.Z 三段在两条管线里是**同一组数字**（开发包就是在这组数字上加一个迭代号）。
 * 但**写谁只由管线决定**：编译开发包只改 tools/versions.json 的 dev 字段，
 * 一个字节都不碰发布版本；编译发布包只改 release 字段（以及它派生的三处副本）。
 *
 * 为什么开发版本不能直接写进 Cargo.toml / tauri.conf.json：cargo 只认 semver，
 * 四段版本直接编译失败（unexpected character '.' after patch version number），
 * tauri-build 也会跳过 Windows 资源版本写入。所以四段版本住在 tools/versions.json，
 * 由构建编排器 tools/build.mjs 以 HP_APP_VERSION 环境变量传给 build.rs，
 * 再由 env!("HP_APP_VERSION") 烙进二进制（见 apps/desktop/src-tauri/src/version.rs）。
 *
 * 发布版本仍是**三处副本同源**（tauri.conf.json 是 cargo/tauri 真正读的那份）：
 *  apps/desktop/src-tauri/tauri.conf.json、apps/desktop/src-tauri/Cargo.toml 的
 *  [package] version、apps/desktop/package.json。三处由本脚本一次写齐并回读校验。
 *
 * 两条管线的 X.Y.Z 允许**相差 1**：开发包通常是「下一个发布版本」的快照（dev 领先
 * 一个 patch），也可能落后刚发出去的那个 patch。差得多就要吼一声——见 pipelineDrift()，
 * 构建编排器 tools/build.mjs 会在每次构建前把它打出来（差值 ≤1 静默，>1 提示）。
 *
 * 用法（任意工作目录均可，HP_PROJECT_ROOT 可指向别的副本做隔离验证）：
 *
 *   node tools/version.mjs                              # 打印两条管线的当前版本
 *   node tools/version.mjs --current [--pipeline dev]   # 打印指定管线（默认 release）
 *   node tools/version.mjs --bump  [--pipeline dev]     # 只打印下一个版本，不写文件（--next 同义）
 *   node tools/version.mjs --write <版本号> [--pipeline dev]   # 写成指定版本（--set 同义）
 *   node tools/version.mjs --apply [--pipeline dev]     # HP_VERSION 非空则原样用，否则 +1；写并打印
 *   node tools/version.mjs --verify                     # 校验发布版本三处副本与 versions.json 一致
 *   node tools/version.mjs --self-test                  # 纯函数自检（pnpm check:version）
 *
 * 退出码：0 成功；1 参数/版本号/文件不合法（错误信息一律中文，直接给人看）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（HP_PROJECT_ROOT 可覆盖，用于隔离验证）。 */
const ROOT = process.env.HP_PROJECT_ROOT
  ? resolve(process.env.HP_PROJECT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 两条管线的**状态文件**（版本事实在这里，其余都是派生副本）。 */
export const VERSIONS_FILE = "tools/versions.json";

/** 发布版本的第一副本：tauri 读它。 */
export const TAURI_CONF = "apps/desktop/src-tauri/tauri.conf.json";
/** 发布版本的第二副本：env!("CARGO_PKG_VERSION") 读的就是这一行。 */
export const BRIDGE_CARGO = "apps/desktop/src-tauri/Cargo.toml";
/** 发布版本的第三副本：前端包的版本（不参与编译，只为了三处一致可读）。 */
export const DESKTOP_PKG = "apps/desktop/package.json";

/** 管线名。字符串常量是 CLI 与调用方共用的唯一拼写。 */
export const PIPELINES = ["dev", "release"];

/** 发布版本：X.Y.Z + 可选 -后缀 + 可选 +构建元数据；各数字段不允许前导零。 */
const RELEASE_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 开发版本：四段数字 + 可选后缀 + 可选构建元数据（后缀另行强制为 -Alpha）。 */
const DEV_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 开发管线独占的后缀（比较时大小写不限，写回时保留调用方给的原样字符）。 */
const ALPHA_RE = /^-[Aa][Ll][Pp][Hh][Aa]$/;

/** 校验管线名，写错就抛（不静默退回默认值）。 */
export function normalizePipeline(pipeline) {
  if (PIPELINES.includes(pipeline)) return pipeline;
  throw new Error(
    "管线不合法：" + JSON.stringify(pipeline) + " —— 只能是 " + PIPELINES.join(" / ") +
      "（dev=开发管线，release=发布管线）",
  );
}

/**
 * 规范化**发布版本**：X.Y.Z，可带 -后缀（但**不能**是 -Alpha，那是开发管线独占）。
 * @param {string} version
 * @returns {string}
 */
export function normalizeVersion(version) {
  const text = String(version ?? "").trim();
  if (!text) {
    throw new Error(
      "版本号为空：发布管线需要形如 X.Y.Z 或 X.Y.Z-后缀（例如 0.1.1-beta、1.0.0）",
    );
  }
  const m = RELEASE_RE.exec(text);
  if (!m) {
    throw new Error(
      "版本号不合法：" + JSON.stringify(text) +
        " —— 发布管线需要 X.Y.Z（可带 -后缀，如 0.1.1-beta）；各数字段不得有前导零，" +
        "后缀只用字母/数字/连字符/点；四段版本属于开发管线",
    );
  }
  if (m[4] && ALPHA_RE.test(m[4])) {
    throw new Error(
      "版本号不合法：" + JSON.stringify(text) +
        " —— -Alpha 后缀是**开发管线独占**的，发布管线请用 -beta 或不带后缀",
    );
  }
  return text;
}

/**
 * 规范化**开发版本**：X.Y.Z.A-Alpha（四段数字，后缀必须是 -Alpha，大小写不限）。
 * @param {string} version
 * @returns {string}
 */
export function normalizeDevVersion(version) {
  const text = String(version ?? "").trim();
  if (!text) {
    throw new Error("版本号为空：开发管线需要形如 X.Y.Z.A-Alpha（例如 0.1.1.1-Alpha）");
  }
  const m = DEV_RE.exec(text);
  if (!m) {
    throw new Error(
      "版本号不合法：" + JSON.stringify(text) +
        " —— 开发管线需要 X.Y.Z.A-Alpha（四段数字，如 0.1.1.1-Alpha）；各数字段不得有前导零",
    );
  }
  if (!m[5] || !ALPHA_RE.test(m[5])) {
    throw new Error(
      "版本号不合法：" + JSON.stringify(text) +
        " —— 开发管线必须以 -Alpha 结尾（大小写不限）；-beta 与无后缀属于发布管线",
    );
  }
  return text;
}

/**
 * 规范化**任一管线**的版本号（发布的三段或开发的四段 -Alpha 都收）。
 *
 * 给"只关心版本号形状"的调用方用（例如产物命名）：管线的合法性由
 * normalizeVersion / normalizeDevVersion 各自把关，这里只回答"是不是个像样的版本号"。
 * @param {string} version
 * @returns {string}
 */
export function normalizeAnyVersion(version) {
  const text = String(version ?? "").trim();
  const dm = DEV_RE.exec(text);
  if (dm && dm[5] && ALPHA_RE.test(dm[5])) return text;
  return normalizeVersion(text);
}

/** 按管线规范化版本号。 */
export function normalizeByPipeline(pipeline, version) {
  return normalizePipeline(pipeline) === "dev"
    ? normalizeDevVersion(version)
    : normalizeVersion(version);
}

/**
 * 发布版本的下一个：只把 Z 段 +1，后缀与构建元数据**原样拼回**。
 * @param {string} version
 * @returns {string}
 */
export function bumpPatch(version) {
  const m = RELEASE_RE.exec(normalizeVersion(version));
  const patch = Number(m[3]) + 1;
  return m[1] + "." + m[2] + "." + patch + (m[4] ?? "") + (m[5] ?? "");
}

/** 旧名，等价于 bumpPatch（保留给既有调用方）。 */
export const bumpPatchVersion = bumpPatch;

/**
 * 开发版本的下一个：只把 A 段 +1，X.Y.Z 与 -Alpha 后缀原样保留。
 * @param {string} version
 * @returns {string}
 */
export function bumpDev(version) {
  const m = DEV_RE.exec(normalizeDevVersion(version));
  const iteration = Number(m[4]) + 1;
  return m[1] + "." + m[2] + "." + m[3] + "." + iteration + (m[5] ?? "") + (m[6] ?? "");
}

/**
 * 取开发版本的迭代号 A（x.y.z.**a**-Alpha 里的 a）。
 * @param {string} version
 * @returns {number}
 */
export function devIteration(version) {
  const m = DEV_RE.exec(normalizeDevVersion(version));
  return Number(m[4]);
}

/**
 * 用"发布版本的 X.Y.Z + 迭代号 A"拼出一个开发版本。
 *
 * 这条函数是**两条管线共用同一组 X.Y.Z** 的落地点：开发版本的三段数字永远
 * 从发布版本抄过来，只有 A 段属于开发管线自己。
 * @param {string} releaseVersion
 * @param {number} iteration
 * @returns {string}
 */
export function composeDevVersion(releaseVersion, iteration) {
  const m = RELEASE_RE.exec(normalizeVersion(releaseVersion));
  const a = Number(iteration);
  if (!Number.isSafeInteger(a) || a < 0) {
    throw new Error("开发迭代号不合法：" + JSON.stringify(iteration) + " —— 需要非负整数");
  }
  return m[1] + "." + m[2] + "." + m[3] + "." + a + "-Alpha";
}

/**
 * 两条管线的 X.Y.Z 允许差多少：**相差 1 算正常**。
 *
 * 开发包是「下一个发布版本」的快照（dev 领先一个 patch），发布刚发完时 dev 落后
 * 一个 patch 也正常。差得多说明有若干发布版本没走过开发构建，或版本被人手工改过，
 * 这时要提示人去确认（构建编排器负责打印）。
 */
export const DRIFT_TOLERANCE = 1;

/** 取版本号的前三段数字（开发四段与发布三段都收，用来比 X.Y.Z）。 */
export function tripletParts(version) {
  const text = String(version ?? "").trim();
  const m = DEV_RE.exec(text) ?? RELEASE_RE.exec(text);
  if (!m) {
    throw new Error("版本号不合法：" + JSON.stringify(version) + " —— 取不出 X.Y.Z 三段");
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * 比较两条管线的 X.Y.Z 偏差（只做判断，不打印——打印是调用方的事）。
 * @returns {{ level: "ok" | "warn", delta: number, release: string, dev: string, message: string }}
 */
export function pipelineDrift(releaseVersion, devVersion) {
  const release = normalizeVersion(releaseVersion);
  const dev = normalizeDevVersion(devVersion);
  const rel = tripletParts(release);
  const dv = tripletParts(dev);
  const bake = (level, delta, message) => ({ level, delta, release, dev, message });
  if (rel.major !== dv.major || rel.minor !== dv.minor) {
    return bake(
      "warn",
      dv.patch - rel.patch,
      "两条管线的 major/minor 不同（发布 " + release + " / 开发 " + dev + "）——" +
        "开发包的 X.Y.Z 应与发布版本相同，请确认这是预期",
    );
  }
  const delta = dv.patch - rel.patch;
  if (Math.abs(delta) <= DRIFT_TOLERANCE) {
    return bake(
      "ok",
      delta,
      "两条管线同属 " + rel.major + "." + rel.minor + "，Z 相差 " + Math.abs(delta) +
        "（≤" + DRIFT_TOLERANCE + " 属正常偏差）",
    );
  }
  return bake(
    "warn",
    delta,
    "两条管线的 Z 相差 " + Math.abs(delta) + "（>" + DRIFT_TOLERANCE + "）：发布 " + release +
      " 的 Z=" + rel.patch + "，开发 " + dev + " 的 Z=" + dv.patch + " ——" +
      "要么有 " + (Math.abs(delta) - 1) + " 个发布版本没走过开发构建，要么版本被手工改过，请确认",
  );
}

/** 按管线推导下一个版本。 */
export function bumpByPipeline(pipeline, version) {
  return normalizePipeline(pipeline) === "dev" ? bumpDev(version) : bumpPatch(version);
}

/** 读 JSON 文件里的顶层 version 字段（缺失/坏 JSON 都抛）。 */
function readJsonVersion(relPath) {
  const abs = resolve(ROOT, relPath);
  let data;
  try {
    data = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(abs + " 不是合法 JSON：" + e.message);
  }
  return String(data.version ?? "").trim();
}

/** 读 Cargo.toml 的 [package] version（只认 [package] 段，不碰依赖版本）。 */
function readCargoPackageVersion(relPath) {
  const abs = resolve(ROOT, relPath);
  const text = readFileSync(abs, "utf8");
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[(.+)\]\s*$/.exec(line);
    if (head) {
      section = head[1].trim();
      continue;
    }
    if (section !== "package") continue;
    const m = /^version\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1].trim();
  }
  throw new Error(abs + " 的 [package] 段里找不到 version = \"...\"（文件结构被改过？）");
}

/**
 * 读两条管线的当前版本（唯一事实来源：tools/versions.json）。
 * @returns {{ release: string, dev: string }}
 */
export function readVersions() {
  const abs = resolve(ROOT, VERSIONS_FILE);
  let data;
  try {
    data = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(abs + " 读不出来（两条管线的版本事实都在这里）：" + e.message);
  }
  return {
    release: normalizeVersion(data.release),
    dev: normalizeDevVersion(data.dev),
  };
}

/** 读指定管线的当前版本。 */
export function readVersion(pipeline = "release") {
  const p = normalizePipeline(pipeline);
  return readVersions()[p];
}

/**
 * 读**发布版本**。旧名保留：artifact-name.mjs 依赖它，产物名只该用发布版本。
 * @returns {string}
 */
export function readAppVersion() {
  return readVersions().release;
}

/** 发布版本的三处副本（数组顺序即写入顺序）。 */
export function readAllVersions() {
  return [
    { file: TAURI_CONF, version: readJsonVersion(TAURI_CONF) },
    { file: BRIDGE_CARGO, version: readCargoPackageVersion(BRIDGE_CARGO) },
    { file: DESKTOP_PKG, version: readJsonVersion(DESKTOP_PKG) },
  ];
}

/** 定点改写 JSON 顶层的 version（保持缩进与键序，改完 JSON.parse 回读比对）。 */
function writeJsonVersion(relPath, version) {
  const abs = resolve(ROOT, relPath);
  const text = readFileSync(abs, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(abs + " 不是合法 JSON，拒绝改写：" + e.message);
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "version")) {
    throw new Error(abs + " 顶层没有 version 字段，拒绝改写");
  }
  const indentMatches = [...text.matchAll(/^([ \t]*)"([^"]+)"[ \t]*:/gm)].map((m) => m[1]);
  const topIndent = indentMatches.reduce((min, cur) => (cur.length < min.length ? cur : min));
  const lineRe = new RegExp("^" + topIndent + "\"version\"([ \\t]*):([ \\t]*)\"[^\"]*\"", "m");
  if (!lineRe.test(text)) {
    throw new Error(abs + " 里找不到顶层 \"version\": \"...\" 行，拒绝改写");
  }
  const next = text.replace(lineRe, topIndent + "\"version\"$1:$2\"" + version + "\"");
  const reread = JSON.parse(next);
  if (reread.version !== version) {
    throw new Error(abs + " 改写回读不一致：期望 " + version + "，实际 " + reread.version);
  }
  writeFileSync(abs, next);
}

/** 定点改写 Cargo.toml 的 [package] version（行级替换，其余字节不动）。 */
function writeCargoPackageVersion(relPath, version) {
  const abs = resolve(ROOT, relPath);
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  let section = "";
  let hit = false;
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\s*\[(.+)\]\s*$/.exec(lines[i]);
    if (head) {
      section = head[1].trim();
      continue;
    }
    if (section !== "package") continue;
    if (/^version\s*=\s*"[^"]*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/^version\s*=\s*"[^"]*"/, "version = \"" + version + "\"");
      hit = true;
      break;
    }
  }
  if (!hit) throw new Error(abs + " 的 [package] 段里找不到 version = \"...\"，拒绝改写");
  writeFileSync(abs, lines.join("\n"));
}

/** 把发布版本写进三处副本并回读校验。 */
function writeReleaseCopies(version) {
  const next = normalizeVersion(version);
  writeJsonVersion(TAURI_CONF, next);
  writeCargoPackageVersion(BRIDGE_CARGO, next);
  writeJsonVersion(DESKTOP_PKG, next);
  const drifted = readAllVersions().filter((item) => item.version !== next);
  if (drifted.length > 0) {
    throw new Error(
      "写好回读不一致：" + drifted.map((d) => d.file + "=" + d.version).join("，"),
    );
  }
}

/**
 * 写指定管线的版本。
 *
 * **只写自己那条管线**：dev 只改 tools/versions.json 的 dev 字段；release 改
 * release 字段并派生三处副本。另一边一个字节都不动（D230）。
 * @param {"dev"|"release"} pipeline
 * @param {string} version
 * @returns {string} 写下的版本
 */
export function writeVersion(pipeline, version) {
  const p = normalizePipeline(pipeline);
  const next = normalizeByPipeline(p, version);
  const abs = resolve(ROOT, VERSIONS_FILE);
  const current = readVersions();
  const merged = p === "dev" ? { ...current, dev: next } : { ...current, release: next };
  writeFileSync(abs, JSON.stringify(merged, null, 2) + "\n");
  if (p === "release") writeReleaseCopies(next);
  const reread = readVersions()[p];
  if (reread !== next) {
    throw new Error(
      "写好回读不一致：" + VERSIONS_FILE + " 的 " + p + " 期望 " + next + "，实际 " + reread,
    );
  }
  return next;
}

/** 旧名；现在等价于 writeVersion("release", version)。 */
export function writeAppVersion(version) {
  return writeVersion("release", version);
}

/**
 * 校验发布版本三处副本与 tools/versions.json 一致（漂移即抛）。
 * @returns {{ release: string, dev: string }}
 */
export function verifyCopies() {
  const versions = readVersions();
  const drifted = readAllVersions().filter((item) => item.version !== versions.release);
  if (drifted.length > 0) {
    throw new Error(
      "发布版本三处副本与 " + VERSIONS_FILE + " 不一致：权威 " + versions.release + "；" +
        drifted.map((d) => d.file + "=" + d.version).join("，") +
        " —— 跑一次 node tools/version.mjs --write <版本> 收口",
    );
  }
  return versions;
}

const USAGE = [
  "用法：node tools/version.mjs [--current | --bump | --write <版本号> | --apply | --verify | --self-test] [--pipeline dev|release]",
  "  --pipeline dev      开发管线（X.Y.Z.A-Alpha）；缺省是 release（发布管线 X.Y.Z[-beta]）",
  "  不带参数时打印两条管线的当前版本",
].join("\n");

/** 从 argv 里摘出 --pipeline <名>（顺便吃掉它的值，剩下的按位置解析）。 */
function takePipeline(argv) {
  const rest = [];
  let pipeline = "release";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pipeline") {
      pipeline = normalizePipeline(argv[i + 1]);
      i += 1;
      continue;
    }
    rest.push(argv[i]);
  }
  return { pipeline, rest };
}

/** 纯函数自检（pnpm check:version）。 */
export function selfTest() {
  let count = 0;
  const eq = (actual, expected, what) => {
    count += 1;
    if (actual !== expected) {
      throw new Error(what + "：期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
    }
  };
  const throws = (fn, what) => {
    count += 1;
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(what + "：本应抛错却通过了");
  };

  // 发布管线：只 +1 Z 段，后缀/构建元数据原样保留
  const releaseCases = [
    ["0.1.1-beta", "0.1.2-beta"],
    ["0.1.0", "0.1.1"],
    ["1.9.9-beta.2", "1.9.10-beta.2"],
    ["2.3.4+build.7", "2.3.5+build.7"],
    ["10.0.0-rc.1+build", "10.0.1-rc.1+build"],
  ];
  for (const [from, to] of releaseCases) eq(bumpPatch(from), to, "发布管线 " + from + " 的下一个");

  // 开发管线：只 +1 A 段，X.Y.Z 与 -Alpha 后缀逐字保留
  const devCases = [
    ["0.1.1.1-Alpha", "0.1.1.2-Alpha"],
    ["0.1.1.9-alpha", "0.1.1.10-alpha"],
    ["2.3.4.0-Alpha", "2.3.4.1-Alpha"],
  ];
  for (const [from, to] of devCases) eq(bumpDev(from), to, "开发管线 " + from + " 的下一个");

  // 发布管线拒绝四段与 -Alpha（-Alpha 是开发管线独占）
  const badRelease = ["", "0.1", "0.1.1.1", "01.2.3", "v1.2.3", "1.2.3-", "1.2.3 x", "1.2.3-Alpha", "1.2.3-ALPHA"];
  for (const bad of badRelease) throws(() => normalizeVersion(bad), "发布管线应拒绝 " + JSON.stringify(bad));

  // 开发管线拒绝三段、非 -Alpha 后缀、带前导零的四段
  const badDev = ["", "0.1.1", "0.1.1.1", "0.1.1.1-Beta", "0.1.1.1-beta", "01.1.1.1-Alpha", "1.1.1.1-Alpha.2"];
  for (const bad of badDev) throws(() => normalizeDevVersion(bad), "开发管线应拒绝 " + JSON.stringify(bad));

  // 大小写不限：-alpha / -ALPHA 都是合法开发版本，且后缀字符原样写回
  eq(normalizeDevVersion("0.1.1.1-alpha"), "0.1.1.1-alpha", "小写 alpha 也合法");
  eq(bumpDev("0.1.1.1-ALPHA"), "0.1.1.2-ALPHA", "大写 ALPHA 原样保留");

  // 管线名写错要抛（不静默退回 release），并按管线分派
  throws(() => normalizePipeline("beta"), "未知管线应拒绝");
  eq(normalizeByPipeline("dev", "0.1.1.1-Alpha"), "0.1.1.1-Alpha", "按管线分派（dev）");
  eq(normalizeByPipeline("release", "0.1.1-beta"), "0.1.1-beta", "按管线分派（release）");

  // 两条管线的 X.Y.Z 偏差：相差 ≤1 属正常，>1 要提示
  eq(pipelineDrift("0.1.1-beta", "0.1.1.1-Alpha").level, "ok", "同一个 Z 属正常");
  eq(pipelineDrift("0.1.1-beta", "0.1.2.1-Alpha").level, "ok", "dev 领先一个 patch 属正常");
  eq(pipelineDrift("0.1.2-beta", "0.1.1.1-Alpha").level, "ok", "dev 落后一个 patch 属正常");
  eq(pipelineDrift("0.1.1-beta", "0.1.3.1-Alpha").level, "warn", "相差 2 要提示");
  eq(pipelineDrift("0.1.3-beta", "0.1.1.1-Alpha").level, "warn", "落后 2 也要提示");
  eq(pipelineDrift("0.1.1-beta", "0.2.0.1-Alpha").level, "warn", "minor 不同要提示");
  eq(pipelineDrift("0.1.1-beta", "0.1.3.7-Alpha").delta, 2, "delta 记录 Z 的差值");
  eq(pipelineDrift("0.1.2-beta", "0.1.1.9-Alpha").delta, -1, "dev 落后时 delta 为负");
  throws(() => pipelineDrift("0.1.1-beta", "0.1.1"), "开发版本形状不对要抛");
  throws(() => tripletParts("不是版本"), "取不出三段要抛");

  console.log("版本号推导自检通过（" + count + " 项）");
}

/** CLI 入口。 */
function main(argv) {
  const { pipeline, rest } = takePipeline(argv);
  const [cmd, target] = rest;

  if (!cmd) {
    const v = verifyCopies();
    console.log("发布管线: " + v.release);
    console.log("开发管线: " + v.dev);
    return 0;
  }
  if (cmd === "--current") {
    console.log(readVersion(pipeline));
    return 0;
  }
  if (cmd === "--bump" || cmd === "--next") {
    console.log(bumpByPipeline(pipeline, readVersion(pipeline)));
    return 0;
  }
  if (cmd === "--write" || cmd === "--set") {
    if (!target) throw new Error("--write 需要版本号\n" + USAGE);
    const written = writeVersion(pipeline, target);
    console.error("[version] " + pipeline + " 管线写成 " + written);
    console.log(written);
    return 0;
  }
  if (cmd === "--apply") {
    const current = readVersion(pipeline);
    const explicit = String(process.env.HP_VERSION ?? "").trim();
    const next = explicit
      ? normalizeByPipeline(pipeline, explicit)
      : bumpByPipeline(pipeline, current);
    console.error(
      "[version] " + pipeline + " 管线：" + current + " → " + next +
        "（" + (explicit ? "HP_VERSION" : "自动 +1") + "）",
    );
    writeVersion(pipeline, next);
    console.log(next);
    return 0;
  }
  if (cmd === "--verify") {
    const v = verifyCopies();
    console.log("[version] 发布版本三处副本一致：" + v.release + "（开发版本 " + v.dev + "）");
    return 0;
  }
  if (cmd === "--self-test") {
    selfTest();
    return 0;
  }
  throw new Error("无法识别的参数：" + cmd + "\n" + USAGE);
}

const SELF = fileURLToPath(import.meta.url).toLowerCase();
const ENTRY = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (ENTRY === SELF) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error("[version] " + e.message);
    process.exitCode = 1;
  }
}
