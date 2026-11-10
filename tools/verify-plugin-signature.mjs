#!/usr/bin/env node
/**
 * 随包插件的签名校验（D156）：在**打包机上**复核一份插件目录与内置公钥是否对得上。
 *
 * 用法：
 *   node tools/verify-plugin-signature.mjs <插件目录路径>
 *
 * 为什么需要它：发布流水线不再自己签名（私钥不进 CI），而是下载本机签好的随包插件资产，
 * 解包后**先验签再打包**。信任锚点必须与运行期同一份——所以公钥从
 * `crates/hp-plugin-signing/src/lib.rs` 的 `BUILTIN_PUBKEY_HEX` 读，而不是读 pem 文件
 * （pem 只用于签名侧自验证，读它等于信任锚点可以漂移）。
 *
 * 校验三件事：
 *   1. `SHA256SUMS.sig` 是对 `SHA256SUMS` 内容的 Ed25519 签名，且内置公钥验得过；
 *   2. `SHA256SUMS` 里列的每个文件都在、且内容哈希一致；
 *   3. 目录里没有 `SHA256SUMS` 之外的多余文件（多出来的文件没有签名保护，
 *      运行期校验会漏过它，打包时却会把它带进发布包）。
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIB_RS = join(ROOT, "crates", "hp-plugin-signing", "src", "lib.rs");

// Ed25519 SubjectPublicKeyInfo 的 DER 头（RFC 8410）：后接 32 字节裸公钥。
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 从 lib.rs 读出内置公钥（唯一信任锚点）。 */
export function builtinPubkeyHex() {
  const src = readFileSync(LIB_RS, "utf8");
  const m = src.match(/BUILTIN_PUBKEY_HEX:\s*&str\s*=\s*"([0-9a-fA-F]{64})"/);
  if (!m) throw new Error(`未从 ${LIB_RS} 读到 BUILTIN_PUBKEY_HEX`);
  return m[1].toLowerCase();
}

function pubkeyObject() {
  const raw = Buffer.from(builtinPubkeyHex(), "hex");
  if (raw.length !== 32) throw new Error(`内置公钥长度应为 32 字节，实际 ${raw.length}`);
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/** 递归收集文件（与 tools/sign-plugin.mjs 同序同口径）。 */
export function collectFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 校验插件目录的签名与内容，返回问题清单（空数组 = 通过）。
 * 纯读，不改盘。
 */
export function verifyPluginDir(dir) {
  const problems = [];
  const sumsPath = join(dir, "SHA256SUMS");
  const sigPath = join(dir, "SHA256SUMS.sig");
  for (const [label, path] of [
    ["SHA256SUMS", sumsPath],
    ["SHA256SUMS.sig", sigPath],
  ]) {
    if (!existsSync(path)) problems.push(`缺少 ${label}（插件未签名）`);
  }
  if (problems.length > 0) return problems;

  const sums = readFileSync(sumsPath);
  const sig = readFileSync(sigPath);
  let sigOk = false;
  try {
    sigOk = verify(null, sums, pubkeyObject(), sig);
  } catch (err) {
    problems.push(`签名校验抛错：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!sigOk) {
    problems.push("签名与内置公钥不符（不是本机签署的那份资产，或被改过）");
    return problems;
  }

  // 逐行核对哈希；顺带记录受保护文件集合。
  const listed = new Set();
  for (const line of sums.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!m) {
      problems.push(`SHA256SUMS 行格式不认识：${line.slice(0, 80)}`);
      continue;
    }
    const [, hash, rel] = m;
    listed.add(rel);
    const path = join(dir, rel.split("/").join(sep));
    if (!existsSync(path)) {
      problems.push(`清单里有、盘上没有：${rel}`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== hash) problems.push(`内容与清单不一致：${rel}`);
  }

  // 多余文件没有签名保护。
  for (const rel of collectFiles(dir)) {
    if (rel === "SHA256SUMS" || rel === "SHA256SUMS.sig") continue;
    if (!listed.has(rel)) problems.push(`清单外的文件（不受签名保护）：${rel}`);
  }
  return problems;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("用法: node tools/verify-plugin-signature.mjs <插件目录路径>");
    process.exit(1);
  }
  const dir = resolve(arg);
  try {
    statSync(dir);
  } catch {
    console.error(`插件目录不存在: ${dir}`);
    process.exit(1);
  }
  const problems = verifyPluginDir(dir);
  if (problems.length > 0) {
    console.error(`[verify-plugin] ${dir} 校验失败：`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[verify-plugin] 签名与内容一致（公钥 ${builtinPubkeyHex().slice(0, 16)}…）：${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
