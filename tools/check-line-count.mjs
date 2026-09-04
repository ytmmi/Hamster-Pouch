// check-line-count.mjs：遍历 apps/**/src、crates/**/src、packages/**/src 下的
// .ts/.tsx/.rs 文件，任一文件超过 1200 行即退出非 0，落实文件规则。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["apps", "crates", "packages"];
const EXTS = new Set([".ts", ".tsx", ".rs"]);
const LIMIT = 1200;
let failed = false;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "src") walk(p);
    } else if (EXTS.has(extname(p))) {
      const lines = readFileSync(p, "utf8").split("\n").length;
      if (lines > LIMIT) {
        console.error(`[check-line-count] ${p}: ${lines} 行超过 ${LIMIT}`);
        failed = true;
      }
    }
  }
}

for (const root of ROOTS) {
  try { walk(root); } catch { /* 目录不存在时忽略 */ }
}
process.exit(failed ? 1 : 0);
