// check-encoding.mjs：全仓文本文件必须是**合法 UTF-8**，否则退出非 0。
//
// 动机（缺陷 0011）：`apps/desktop/src/app_ui/shared/styles.css` 曾被写坏成非法 UTF-8
// （UTF-8 字节被按单字节编码读出、丢字节后又按 UTF-8 写回），此后 4 个提交一直带病，
// 而当时**没有任何门禁会去解码文件文本**：`check-line-count` 只数行数、
// `check-doc-status` 只看文档头、`pnpm typecheck`/`vite build` 对 CSS 注释里的坏字节
// 一律照收。代价是 `read`/`edit` 一类按 UTF-8 读取的工具**直接拒绝打开该文件**，
// 也就是"源码还在、但正常工具链再也改不动它"。
//
// 判定口径：按字节自行校验（不依赖解码器的报错文案），报告每个文件的
// 「首个非法字节偏移 + 所在行 + 非法序列数」，便于直接定位。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["apps", "crates", "packages", "tools", "plugins", "docs", "external-cli"];
/** 参与校验的文本扩展名（二进制与生成物不在内）。 */
const EXTS = new Set([
  ".ts", ".tsx", ".rs", ".css", ".md", ".txt", ".json", ".mjs", ".js",
  ".toml", ".html", ".sql", ".yml", ".yaml", ".manifest", ".py", ".sh", ".xml",
]);
/** 非源码目录：构建产物、依赖、版本库与对账中间产物。 */
const SKIP_DIRS = new Set([
  "node_modules", "target", "dist", ".git", ".pnpm-store", "backups",
  ".codegraph", ".omo", "gen",
]);
/** 确定性：按路径排序后再遍历，输出顺序稳定。 */
const files = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return; // 目录不存在时忽略
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p);
    else if (EXTS.has(extname(p))) files.push(p);
  }
}

for (const root of ROOTS) walk(root);

/**
 * 逐个字节校验 UTF-8；返回非法序列的**首个字节**偏移列表。
 * 口径与常见的严格校验一致：拒绝过长编码、代理区码点与超出 U+10FFFF 的码点。
 */
function invalidOffsets(buf) {
  const bad = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let len;
    if (b < 0x80) {
      i++;
      continue;
    } else if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    else {
      bad.push(i);
      i++;
      continue;
    }
    let ok = i + len <= buf.length;
    if (ok) {
      for (let j = 1; j < len; j++) {
        if ((buf[i + j] & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
      }
    }
    // 过长编码 / 代理区 / 越界码点
    if (ok && len === 3 && b === 0xe0 && buf[i + 1] < 0xa0) ok = false;
    if (ok && len === 4 && b === 0xf0 && buf[i + 1] < 0x90) ok = false;
    if (ok && len === 3 && b === 0xed && buf[i + 1] > 0x9f) ok = false;
    if (ok && len === 4 && b > 0xf4) ok = false;
    if (ok) i += len;
    else {
      bad.push(i);
      i++;
    }
  }
  return bad;
}

let failed = false;
let checked = 0;
for (const p of files) {
  const buf = readFileSync(p);
  checked++;
  const bad = invalidOffsets(buf);
  if (bad.length === 0) continue;
  // 首个非法偏移 → 行号（数它前面有多少个 0x0A）
  let line = 1;
  for (let k = 0; k < bad[0]; k++) if (buf[k] === 0x0a) line++;
  console.error(
    `[check-encoding] ${p}: 非法 UTF-8 —— ${bad.length} 个非法序列，首个在字节偏移 ${bad[0]}（第 ${line} 行）`,
  );
  failed = true;
}

if (failed) {
  console.error(
    "[check-encoding] 失败：上列文件不是合法 UTF-8。按 UTF-8 读取的工具（read/edit、编辑器、diff）会拒绝或误读它们。",
  );
} else {
  console.log(`[check-encoding] OK：${checked} 个文本文件全部为合法 UTF-8`);
}
process.exit(failed ? 1 : 0);
