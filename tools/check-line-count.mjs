// check-line-count.mjs：遍历 apps/**/src、crates/**/src、packages/**/src 下的
// .ts/.tsx/.rs 文件，任一文件超过 1200 行即退出非 0，落实文件规则。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["apps", "crates", "packages"];
const EXTS = new Set([".ts", ".tsx", ".rs"]);
const LIMIT = 1200;
// 构建产物与第三方目录不参与行数检查。
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "gen"]);
let failed = false;

// 递归查找所有 `src` 目录（含其子目录）下的代码文件；
// 例如 apps/desktop/src、apps/desktop/src-tauri/src、crates/*/src。
function walk(dir, inSrc) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(p, inSrc || entry === "src");
    } else if (inSrc && EXTS.has(extname(p))) {
      const lines = readFileSync(p, "utf8").split("\n").length;
      if (lines > LIMIT) {
        console.error(`[check-line-count] ${p}: ${lines} 行超过 ${LIMIT}`);
        failed = true;
      }
    }
  }
}

for (const root of ROOTS) {
  try { walk(root, false); } catch { /* 目录不存在时忽略 */ }
}
process.exit(failed ? 1 : 0);
