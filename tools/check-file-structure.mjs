/**
 * 文件命令族的目录划分（D217）。
 *
 * 原 commands/file.rs 1032 行，把三件互不相干的事塞在一起：缩略图/预览的取数策略
 * （白名单、原图回退的三条判据）、两条长任务的线程骨架、以及一批只读写库的命令。
 * 拆成 file/{mod,preview,task}.rs 之后，这里钉住「谁该在哪份文件里」——
 * 拆完不改门禁，下一个人把取图策略写回 mod.rs 也不会有人发现。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "apps/desktop/src-tauri/src/commands/file");
const read = (name) => readFileSync(join(DIR, name + ".rs"), "utf8");
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const modSrc = stripComments(read("mod"));
const previewSrc = stripComments(read("preview"));
const taskSrc = stripComments(read("task"));
const mainSrc = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/main.rs"), "utf8");

let passed = 0;
const total = 6;
function report(ok, label, detail) {
  if (ok) passed += 1;
  const extra = ok || !detail || !detail.length ? "" : " — " + detail.join("、");
  console.log((ok ? "PASS  " : "FAIL  ") + label + extra);
}

const threeFiles = ["mod", "preview", "task"];
const dirOk = threeFiles.every((name) => existsSync(join(DIR, name + ".rs")));
const legacyGone = !existsSync(join(ROOT, "apps/desktop/src-tauri/src/commands/file.rs"));
report(legacyGone && dirOk, "文件命令族是目录（mod / preview / task），原单文件不得复活");

const previewNeedles = [
  "struct ThumbJob {",
  "fn generate_thumbnail(",
  "fn is_natively_renderable(",
  "fn should_serve_original(",
  "async fn thumb_get(",
  "async fn preview_get(",
];
const previewMissing = previewNeedles.filter((needle) => !previewSrc.includes(needle));
report(previewMissing.length === 0, "取图策略（缩略图生成 / 原图回退判据 / 两条取数命令）都在 preview.rs", previewMissing);

const helperRe = /fn (?:generate_thumbnail|is_natively_renderable|should_serve_original)\(/g;
const strayPreview = [];
for (const m of modSrc.matchAll(helperRe)) strayPreview.push("mod.rs:" + m[0].trim());
for (const m of taskSrc.matchAll(helperRe)) strayPreview.push("task.rs:" + m[0].trim());
report(strayPreview.length === 0, "取图助手只有一份（mod.rs / task.rs 不得再定义）", strayPreview);

const taskNeedles = ["fn run_reanalyze(", "fn run_backfill(", "spawn_repo_task(", "spawn_task_at("];
const taskMissing = taskNeedles.filter((needle) => !taskSrc.includes(needle));
const spawnRe = /spawn_repo_task\(|spawn_task_at\(/g;
const straySpawn = [...modSrc.matchAll(spawnRe)].length + [...previewSrc.matchAll(spawnRe)].length;
const taskLabel = "两条长任务只在 task.rs，且经 task_shell 起线程";
const taskDetail = taskMissing.slice();
if (straySpawn > 0) taskDetail.push("mod/preview 里还有 " + straySpawn + " 处 spawn_*");
report(taskMissing.length === 0 && straySpawn === 0, taskLabel, taskDetail);

const commandNeedles = ["async fn thumb_get(", "async fn preview_get(", "async fn file_reanalyze(", "fn start_backfill("];
const strayCommands = commandNeedles.filter((needle) => modSrc.includes(needle));
report(strayCommands.length === 0, "命令本体按归属分文件（mod.rs 只剩库内读写类命令）", strayCommands);

const registryNeedles = [
  "commands::file::preview::thumb_get",
  "commands::file::preview::preview_get",
  "commands::file::task::file_reanalyze",
  "commands::file::task::file_backfill",
];
const registryMissing = registryNeedles.filter((needle) => !mainSrc.includes(needle));
report(registryMissing.length === 0, "main.rs 的 invoke_handler 指向子模块路径（否则 __cmd__* 找不到）", registryMissing);

console.log("");
console.log(`[check-file-structure] ${passed}/${total} 通过`);
if (passed !== total) process.exit(1);
