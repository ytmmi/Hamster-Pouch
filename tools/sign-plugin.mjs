#!/usr/bin/env node
/**
 * 插件包签名工具：为插件目录生成 Ed25519 签名。
 *
 * 用法：
 *   node tools/sign-plugin.mjs <插件目录路径>
 *
 * 功能：
 *   1. 递归扫描目录下所有文件，生成 SHA256SUMS（Debian 格式）
 *   2. 用签署密钥（tools/signing/signing-key.pem）对 SHA256SUMS 签名
 *   3. 输出 SHA256SUMS + SHA256SUMS.sig 到插件目录
 *
 * 环境变量：
 *   HP_SIGN_KEY — 签署密钥 PEM 路径（默认 tools/signing/signing-key.pem）
 *   HP_IDENTITY — 签发人标识（默认提取 git user.name）
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_KEY = join(ROOT, "tools", "signing", "signing-key.pem");
const KEY = process.env.HP_SIGN_KEY ?? DEFAULT_KEY;

// ---- 确定签发人身份 ----
function detectIdentity() {
  try {
    const name = execFileSync("git", ["config", "--global", "user.name"], {
      encoding: "utf8",
      cwd: ROOT,
    }).trim();
    const email = process.env.HP_SIGN_IDENTITY ?? name;
    return email || "unknown";
  } catch {
    return "unknown";
  }
}
const IDENTITY = process.env.HP_IDENTITY ?? detectIdentity();

// ---- 递归收集文件 ----
function collectFiles(dir, prefix = "") {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === "SHA256SUMS" || entry.name === "SHA256SUMS.sig") continue;
    if (entry.isDirectory()) {
      files.push(...collectFiles(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

// ---- 生成 SHA256SUMS ----
function generateSha256sums(dir) {
  const files = collectFiles(dir);
  const lines = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f));
    const hash = createHash("sha256").update(content).digest("hex");
    lines.push(`${hash}  ${f}`);
  }
  return lines.join("\n") + "\n";
}

// ---- 主流程 ----
function main() {
  const pluginDir = resolve(process.argv[2]);
  if (!pluginDir) {
    console.error("用法: node tools/sign-plugin.mjs <插件目录路径>");
    process.exit(1);
  }
  try {
    statSync(pluginDir);
  } catch {
    console.error(`插件目录不存在: ${pluginDir}`);
    process.exit(1);
  }

  // 验证签署密钥存在
  try {
    statSync(KEY);
  } catch {
    console.error(`签署密钥不存在: ${KEY}`);
    process.exit(1);
  }

  const sumsPath = join(pluginDir, "SHA256SUMS");
  const sigPath = join(pluginDir, "SHA256SUMS.sig");
  const openssl = process.env.HP_OPENSSL ?? "D:\\BianCen\\conda\\Library\\bin\\openssl.exe";

  // 防止自己影响自己
  const existingFiles = collectFiles(pluginDir);
  if (existingFiles.includes("SHA256SUMS") || existingFiles.includes("SHA256SUMS.sig")) {
    console.log("检测到已有签名文件，重新生成...");
  }

  // 1. 生成 SHA256SUMS
  const sums = generateSha256sums(pluginDir);
  writeFileSync(sumsPath, sums, "utf8");
  console.log(`[sign-plugin] 已生成 SHA256SUMS（${sums.trim().split("\n").length} 行）`);

  // 2. 签名（Ed25519 需 pkeyutl，dgst -sign 不支持）
  execFileSync(
    openssl,
    ["pkeyutl", "-sign", "-inkey", KEY, "-out", sigPath, "-rawin", "-in", sumsPath],
    { stdio: "ignore" },
  );
  console.log(`[sign-plugin] 已生成 SHA256SUMS.sig`);

  // 3. 验证签名
  try {
    const verifyOut = execFileSync(
      openssl,
      ["pkeyutl", "-verify", "-pubin", "-inkey", join(ROOT, "tools/signing/signing-pub.pem"),
       "-sigfile", sigPath, "-rawin", "-in", sumsPath],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (verifyOut.includes("Verified")) {
      console.log(`[sign-plugin] ✅ 自验证通过 —— 签名有效`);
    } else {
      console.error(`[sign-plugin] ❌ 自验证失败——验证输出: ${verifyOut.trim()}`);
      process.exit(1);
    }

    // 显示签发信息
    console.log(`[sign-plugin] 签发人: ${IDENTITY}`);
    console.log(`[sign-plugin] 插件目录: ${pluginDir}`);
  } catch {
    console.error(`[sign-plugin] ❌ 自验证失败——签名可能有问题`);
    process.exit(1);
  }
}

main();
