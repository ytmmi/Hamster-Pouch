/**
 * Phase 5 准备：把**真实图片源**写进开发包的仓库库（真机验证用）。
 *
 * ## 为什么直接写库而不是走 UI 扫描
 *
 * 扫描 4700 张真实照片要数分钟且与本轮改动无关；而本阶段要验证的是**渲染路径**
 * （真实缩略图生成 → 真实宽高比 → 真实布局）。因此只补"索引记录"，
 * 缩略图仍由 app 的 Rust 侧按需**真实解码生成**（`thumb.get`）——那才是要测的部分。
 *
 * ## 可重复性（用户要求）
 *
 * 本脚本 `--clean` 会**只删自己写入的行**（按 source_id 与 relative_path 前缀），
 * 不碰源文件、不碰其它数据。测完必须跑一次 `--clean`，避免缓存导致的漂移。
 *
 * 用法：
 *   node tools/real-source-prep.mjs --prepare --limit=4700
 *   node tools/real-source-prep.mjs --clean
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const REPO_DB =
  "apps/desktop/src-tauri/target/release/dev/dev-20261005-225353/data/user/repos/00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3";
const SOURCE_ROOT = "F:\\billfish资源库\\图片";
/** 标记：本脚本写入的行都挂在这个 source_id 下，便于精确清理。 */
const SOURCE_ID = "perf-real-source-0001";
const REPO_ID = "c07f28d2-57dc-4d73-a9e5-3d943fa9e4f2";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}
const LIMIT = Number(args.get("limit") ?? 5000);

/** 可解码的图片扩展名（与 `media_type.rs` 的判定一致，但排除 avif/heic/heif）。 */
const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i;

/**
 * 跳过的目录名。
 *
 * `.bf` 是 **Billfish 自己的内部预览缓存**（全是 `.webp`，且不是可解码的普通图片：
 * 实测这些文件交给 `image` crate 解码会失败，界面显示"不可用"）。
 * 真机验证要的是**真实照片**，因此必须排除——否则第一页全是缓存文件，
 * 量到的是"解码失败"的路径，不是真实布局。
 */
const SKIP_DIRS = new Set([".bf", ".thumbnails", ".cache", "$RECYCLE.BIN", "System Volume Information"]);

/** 递归收集可解码图片（确定性顺序：按路径排序）。 */
function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(join(dir, entry.name), out);
    } else if (IMAGE_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
    if (out.length >= LIMIT) return;
  }
}

const db = new DatabaseSync(REPO_DB);

if (args.has("clean")) {
  const before = db.prepare("SELECT COUNT(*) AS n FROM files WHERE source_id = ?").get(SOURCE_ID).n;
  db.prepare("DELETE FROM files WHERE source_id = ?").run(SOURCE_ID);
  db.prepare("DELETE FROM sources WHERE id = ?").run(SOURCE_ID);
  const after = db.prepare("SELECT COUNT(*) AS n FROM files WHERE source_id = ?").get(SOURCE_ID).n;
  console.log(`[clean] 删除 files ${before} 行、sources 1 行；剩余 ${after}`);
  const total = db.prepare("SELECT COUNT(*) AS n FROM files").get().n;
  console.log(`[clean] 库内 files 总数 = ${total}`);
  process.exit(0);
}

// ---- prepare ----
const files = [];
collect(SOURCE_ROOT, files);
console.log(`[prepare] 发现可解码图片 ${files.length} 张（上限 ${LIMIT}）`);

const mediaTypeOf = (p) => (/\.(mp4|mov|mkv|webm)$/i.test(p) ? "video" : "image");

db.exec("BEGIN");
try {
  // 源行（mounted=1，否则面板会把它当离线源排除）。
  db.prepare("DELETE FROM files WHERE source_id = ?").run(SOURCE_ID);
  db.prepare("DELETE FROM sources WHERE id = ?").run(SOURCE_ID);
  db.prepare(
    "INSERT INTO sources (id, repo_id, local_path, alias, parent_source_id, mounted, mounted_at) VALUES (?,?,?,?,?,?,?)",
  ).run(SOURCE_ID, REPO_ID, SOURCE_ROOT, "真机验证源", null, 1, new Date().toISOString());

  const insert = db.prepare(
    `INSERT INTO files
       (id, source_id, relative_path, media_type, size, mtime, scan_time, verify_status,
        content_hash, content_hash_algo, content_hash_algo_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const now = new Date().toISOString();
  let n = 0;
  for (const full of files) {
    const rel = relative(SOURCE_ROOT, full).split(sep).join("/");
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    /**
     * `content_hash` **必须非空**：`thumb_get` 是 `let Some(hash) = content_hash else
     * return Ok(None)`（缩略图按内容哈希做缓存键）。写 NULL 的话缩略图永远不生成、
     * 界面一律显示"不可用"——这是夹具的坑，不是产品缺陷。
     *
     * 这里用 `(相对路径 + 大小 + mtime)` 的确定性哈希**冒充**内容哈希：真机验证要的是
     * "每个文件有稳定且唯一的缓存键"，而不是内容寻址的真实性（那要完整读一遍文件）。
     * 前缀 `perf-` 标明它不是真哈希，避免与真实扫描的数据混淆。
     */
    const hash = "perf-" + createHash("sha256").update(`${rel}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 32);
    insert.run(
      randomUUID(),
      SOURCE_ID,
      rel,
      mediaTypeOf(full),
      st.size,
      st.mtime.toISOString(),
      now,
      "ok",
      hash,
      "perf-fixture",
      1,
    );
    n += 1;
  }
  db.exec("COMMIT");
  console.log(`[prepare] 写入 ${n} 行（source_id=${SOURCE_ID}）`);
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

const total = db.prepare("SELECT COUNT(*) AS n FROM files").get().n;
console.log(`[prepare] 库内 files 总数 = ${total}`);
