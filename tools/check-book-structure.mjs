#!/usr/bin/env node
// EPUB 正文模块的结构门禁（D216）。
//
// `crates/hp-book/src/epub_text.rs` 曾 1190 行（正文循环 + 图片/图注抽取 + spine 读取 + 725 行用例），
// 距 `check:line-count` 的 1200 行硬上限只剩 10 行。拆成目录之后，这里钉住三件事：
// ① 原单文件不得复活、四份文件齐全；② 公开入口各自的落点（`blocks_from_xhtml` 在 blocks.rs，
// `read_epub_section` 在 mod.rs）；③ 每份文件都不许再长出内联 `mod tests`（用例只在 tests.rs）。
// 判定前先去掉注释：模块文档里解释拆分理由的段落不算实现。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "crates/hp-book/src");
const DIR = join(SRC, "epub_text");
const LEGACY = join(SRC, "epub_text.rs");
const FILES = ["mod.rs", "blocks.rs", "spine.rs", "tests.rs"];
const LIMIT = 800;

const read = (file) => readFileSync(join(DIR, file), "utf8");
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const results = [];
const report = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

report(
  "epub_text 以目录形态存在（原单文件不得复活）",
  !existsSync(LEGACY) && existsSync(join(DIR, "mod.rs")),
  existsSync(LEGACY) ? "crates/hp-book/src/epub_text.rs 又出现了" : "",
);

const present = FILES.filter((f) => existsSync(join(DIR, f)));
report(
  "epub_text/ 的四份：mod / blocks / spine / tests",
  present.length === FILES.length,
  present.length === FILES.length ? "" : `缺少 ${FILES.filter((f) => !present.includes(f)).join(", ")}`,
);

const src = Object.fromEntries(FILES.map((f) => [f, code(read(f)).replace(/^\s+/gm, " ")]));
const definers = (needle) => FILES.filter((f) => src[f].includes(needle));
const blocksFrom = definers("fn blocks_from_xhtml(");
const sectionRead = definers("fn read_epub_section(");
report(
  "公开入口各只有一处：blocks_from_xhtml 在 blocks.rs，read_epub_section 在 mod.rs",
  blocksFrom.length === 1 && blocksFrom[0] === "blocks.rs" && sectionRead.length === 1 && sectionRead[0] === "mod.rs",
  `blocks_from_xhtml=${blocksFrom.join(",") || "无"} read_epub_section=${sectionRead.join(",") || "无"}`,
);

const inlineTests = FILES.filter((f) => f !== "tests.rs" && /mod tests \{/.test(src[f]));
report("用例只在 tests.rs（其余文件不得内联 mod tests）", inlineTests.length === 0, inlineTests.join(", "));

const tooBig = FILES.map((f) => ({ f, n: read(f).split("\n").length - 1 })).filter((x) => x.n > LIMIT);
report(
  `epub_text/ 每份不超过 ${LIMIT} 行（用例独占一份，实现文件不再长回去）`,
  tooBig.length === 0,
  tooBig.map((x) => `${x.f}=${x.n}`).join(", "),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n[check-book-structure] ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
