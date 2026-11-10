#!/usr/bin/env node
/**
 * 取「随包插件资产」并验签落地（D156）。
 *
 * 背景：发布流水线不再自己签名——私钥只留在维护机。维护机把签好的
 * `plugins/system/python-core` 打成 zip 挂到固定 Release 上（tag 见
 * `tools/bundled-assets.json` 的 `release` 字段），CI 下载→比对钉住的 sha256→
 * 解包→用**内置公钥**验签→替换仓库里的插件目录，然后才 `pnpm app:build`。
 *
 * 用法：
 *   node tools/fetch-bundled-plugin.mjs                  # CI：从 Release 下载
 *   node tools/fetch-bundled-plugin.mjs --from <zip>      # 本地：用现成的 zip（演练）
 *   node tools/fetch-bundled-plugin.mjs --dest <dir>      # 换落地目录（默认仓库里的插件目录）
 *
 * 失败即 exit 1（打包链路 fail-closed：拿不到签好的资产就别产出发布包）。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { verifyPluginDir } from "./verify-plugin-signature.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ASSET_FILE = join(ROOT, "tools", "bundled-assets.json");

function readPlan() {
  const plan = JSON.parse(readFileSync(ASSET_FILE, "utf8"));
  const spec = plan.pythonCore;
  if (!spec) throw new Error(`${ASSET_FILE} 里没有 pythonCore 条目`);
  for (const key of ["asset", "sha256", "dir", "release"]) {
    const value = key === "release" ? plan.release : spec[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`${ASSET_FILE} 缺少 ${key}`);
    }
  }
  if (typeof plan.baseUrl !== "string" || plan.baseUrl === "") {
    throw new Error(`${ASSET_FILE} 缺少 baseUrl`);
  }
  return {
    release: plan.release,
    baseUrl: plan.baseUrl,
    asset: spec.asset,
    sha256: spec.sha256.toLowerCase(),
    dir: spec.dir,
    pluginVersion: spec.pluginVersion ?? "",
  };
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 直接按 Release 资产的公开 URL 取（`…/releases/download/<tag>/<asset>`）。
 *
 * 不用 `gh release download`：它在本机维护环境里会挂住（keyring/重定向相关的怪问题），
 * 而这个 URL 对公开仓库无需凭据，Node 自带 fetch 就够；有 token 时才带上（私有仓库）。
 */
async function download(plan, into) {
  const url = `${plan.baseUrl.replace(/\/+$/, "")}/${plan.release}/${encodeURIComponent(plan.asset)}`;
  const headers = { "user-agent": "hamster-pouch-bundled-plugin" };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  console.log(`[bundled-plugin] 下载 ${url}`);
  let response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch (err) {
    throw new Error(
      `下载失败：${url}\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `下载失败：${url} → HTTP ${response.status}（该 Release 上必须先挂上 ${plan.asset}）`,
    );
  }
  const path = join(into, plan.asset);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  const size = readFileSync(path).length;
  if (size === 0) throw new Error(`下载到的 ${plan.asset} 是空文件`);
  console.log(`[bundled-plugin] 已下载 ${plan.asset}（${size} 字节）`);
  return path;
}

function extract(zip, into) {
  mkdirSync(into, { recursive: true });
  try {
    execFileSync("7z", ["x", zip, `-o${into}`, "-y"], { stdio: "ignore" });
  } catch {
    // Runner 与维护机上不一定都有 7z；PowerShell 的 Expand-Archive 是 Windows 自带兜底。
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`,
      ],
      { stdio: "ignore" },
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const plan = readPlan();
  const dest = resolve(flag("--dest") ?? join(ROOT, plan.dir));
  const work = mkdtempSync(join(tmpdir(), "hp-bundled-"));

  try {
    const zip = flag("--from") ? resolve(flag("--from")) : await download(plan, work);
    if (!existsSync(zip)) throw new Error(`资产不存在: ${zip}`);

    // ① 资产文件本身的哈希必须与仓库里钉住的值一致（防替换、防下错版本）
    const actual = sha256Of(zip);
    if (actual !== plan.sha256) {
      throw new Error(
        `资产 sha256 不符：期望 ${plan.sha256}，实际 ${actual}\n` +
          `（若确实换过资产，请同步更新 tools/bundled-assets.json）`,
      );
    }
    console.log(`[bundled-plugin] 资产哈希一致：${plan.asset}`);

    // ② 解包到临时目录，先验签，再落地（绝不把未验签的内容写进仓库）
    const stage = join(work, "stage");
    extract(zip, stage);
    const staged = join(stage, "python-core");
    if (!existsSync(staged)) throw new Error(`${plan.asset} 里没有 python-core/ 目录`);
    const problems = verifyPluginDir(staged);
    if (problems.length > 0) {
      throw new Error(
        `解包后的插件目录验签失败：\n  - ${problems.join("\n  - ")}\n` +
          `（签名必须由本机 tools/sign-plugin.mjs 生成，且与内置公钥同一把钥匙）`,
      );
    }
    console.log(`[bundled-plugin] 验签通过（内置公钥）：${plan.asset}`);

    // ③ 整目录替换：清单里列了 README / 清单文件，逐个文件替换会留下两边不一致的余地
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    // 不用 rename：临时目录与工作区可能不在一张盘上（GitHub runner 上 C: → D:），
    // rename 会抛 EXDEV。整目录复制虽然慢一点（12 MB），但路径无关、哪儿都能跑。
    cpSync(staged, dest, { recursive: true });
    const files = verifyPluginDir(dest);
    if (files.length > 0) throw new Error(`落地后复核失败：\n  - ${files.join("\n  - ")}`);
    console.log(`[bundled-plugin] 已落地：${dest}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
