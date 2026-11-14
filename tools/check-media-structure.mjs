// check-media-structure.mjs：hp-media 的落盘原子性与模块划分（D215）。
// 规则来源：thumbnail 子系统原为一个 1142 行文件（原子写 / 视频抽帧 / 图片管线 + 700 行测试），
// 三类职责各写一遍 ffmpeg 与临时文件；拆成 thumbnail/ 目录后，任一类不得再长回别处。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const MEDIA_SRC = join(ROOT, "crates/hp-media/src");
const THUMB_DIR = join(MEDIA_SRC, "thumbnail");
let passed = 0;
let total = 0;
function check(label, ok, detail) {
  total += 1;
  if (ok) passed += 1;
  console.log((ok ? "PASS  " : "FAIL  ") + label + (ok || !detail ? "" : "  — " + detail));
}

// 收集 crate 内全部 .rs（相对 crates/hp-media/src 的正斜杠路径）。
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name.endsWith(".rs")) out.push({ abs, rel: relative(MEDIA_SRC, abs).split("\\").join("/") });
  }
  return out;
}
const sources = walk(MEDIA_SRC, []);
const read = (rel) => readFileSync(join(MEDIA_SRC, rel), "utf8");
// 判定只针对代码：注释里的术语（例如模块文档解释 blackframe 为什么 amount 必须是 0）不算实现。
const code = (abs) =>
  readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

check(
  "thumbnail 以目录形态存在（原单文件不得复活）",
  !existsSync(join(MEDIA_SRC, "thumbnail.rs")) && existsSync(join(THUMB_DIR, "mod.rs")),
  "crates/hp-media/src/thumbnail.rs 又出现了",
);

const PARTS = ["mod.rs", "atomic.rs", "video.rs", "image_pipeline.rs", "tests.rs"];
const missing = PARTS.filter((n) => !existsSync(join(THUMB_DIR, n)));
check(
  "thumbnail/ 的五份：mod / atomic / video / image_pipeline / tests",
  missing.length === 0,
  "缺少 " + missing.join("、"),
);

// 原子落盘只有一处实现：std::fs::rename 只许出现在 thumbnail/atomic.rs。
const renameHits = sources.filter((s) => /std::fs::rename|fs::rename\(/.test(code(s.abs)));
check(
  "原子替换只有一处实现（thumbnail/atomic.rs 的 commit）",
  renameHits.length === 1 && renameHits[0].rel === "thumbnail/atomic.rs",
  renameHits.map((s) => s.rel).join("、") || "一处都没有",
);

// 临时文件命名同理：temp_sibling 只在 atomic.rs 定义，其余文件只能 import。
const tempDefs = sources.filter((s) => /fn\s+temp_sibling\s*\(/.test(code(s.abs)));
check(
  "临时文件命名只有一处定义（thumbnail/atomic.rs 的 temp_sibling）",
  tempDefs.length === 1 && tempDefs[0].rel === "thumbnail/atomic.rs",
  tempDefs.map((s) => s.rel).join("、") || "一处都没有",
);

// 视频抽帧的过滤链（blackframe / metadata=select）只在 video.rs。
const blackHits = sources.filter((s) => /blackframe/.test(code(s.abs)));
check(
  "跳过黑屏的过滤链只在 thumbnail/video.rs",
  blackHits.length === 1 && blackHits[0].rel === "thumbnail/video.rs",
  blackHits.map((s) => s.rel).join("、") || "一处都没有",
);

console.log("\n[check-media-structure] " + passed + "/" + total + " 通过");
process.exit(passed === total ? 0 : 1);
