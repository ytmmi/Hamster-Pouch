// check-doc-status.mjs：扫描 docs/**/*.md，检测残留的未决状态措辞并报告，
// 防止未决措辞误导实现。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "docs";
let failed = false;

// 需要标记的措辞：状态行非"正式草案/已确认"，或出现待确认类词汇。
const BAD_PATTERNS = [/状态：草案(?!。)/, /待确认/];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".md")) {
      const text = readFileSync(p, "utf8");
      for (const re of BAD_PATTERNS) {
        if (re.test(text)) {
          console.error(`[check-doc-status] ${p}: 命中未决措辞`);
          failed = true;
          break;
        }
      }
    }
  }
}

walk(ROOT);
process.exit(failed ? 1 : 0);
