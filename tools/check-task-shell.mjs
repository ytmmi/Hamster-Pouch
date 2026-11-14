// check-task-shell.mjs：长任务的「登记 / 起线程 / panic 收敛 / 收尾」只能实现一次（D196）。
//
// 为什么需要它：四个后台任务（source.scan / source.unmount / file.reanalyze /
// file.backfill）此前各自手抄这段骨架。四条约束都**不会**在泄漏时编译失败，只在异常路径上
// 表现出来：
//   · `tasks.start` 之前起线程 → 任务一被外部看见就没有可定位的控制块（缺陷 0003 的反面）；
//   · 路径解析失败不 `finish` → 注册表被一条从未启动的任务占死，之后所有任务都报「已有任务」；
//   · 漏 `catch_unwind` → 线程 panic 吞掉终止事件，前端浮窗永远停在原地；
//   · 漏 `tasks.finish` → 同上，且下一次任务直接被闸门挡住。
//
// 断言（扫描 apps/desktop/src-tauri/src/commands 下的全部 .rs）：
// 1. `catch_unwind` 只出现在 commands/task_shell.rs；
// 2. `.tasks.start(` 只出现在 commands/task_shell.rs；
// 3. `.tasks.finish(` 只出现在 commands/task_shell.rs 与 tasks.rs；
// 4. 四个任务入口都经外壳起线程：file/task.rs 2 处（分析 + 回填）、source.rs 2 处（扫描 + 卸载）；
// 5. 外壳自己不做空：两个入口都在，且 `catch_unwind` 与 `tasks.finish` 仍在里面。
//
// 用法：pnpm check:task-shell

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const BRIDGE_SRC = join(ROOT, "apps", "desktop", "src-tauri", "src");
const COMMANDS = join(BRIDGE_SRC, "commands");
const SHELL = join(COMMANDS, "task_shell.rs");
const TASKS_RS = join(BRIDGE_SRC, "tasks.rs");

let total = 0;
let passed = 0;
function report(ok, label, detail) {
  total += 1;
  if (ok) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    for (const d of detail ?? []) console.error(`        ${d}`);
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".rs")) out.push(full);
  }
  return out;
}

/** 去掉行注释与块注释（本脚本只做文本锚点匹配，注释里的示例不该算数）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const files = walk(COMMANDS);
const offenders = [];
let catchCount = 0;
let finishCount = 0;
let shellCatch = 0;
let shellFinish = 0;
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const body = stripComments(readFileSync(file, "utf8"));
  const isShell = rel.endsWith("commands/task_shell.rs");
  const catches = (body.match(/catch_unwind\s*\(/g) ?? []).length;
  const starts = (body.match(/\.tasks\s*\.\s*start\s*\(/g) ?? []).length;
  const finishes = (body.match(/\.tasks\s*\.\s*finish\s*\(/g) ?? []).length;
  catchCount += catches;
  finishCount += finishes;
  if (isShell) {
    shellCatch += catches;
    shellFinish += finishes;
    continue;
  }
  if (catches > 0) offenders.push(`${rel}  ${catches} 处 catch_unwind（应交给 task_shell）`);
  if (starts > 0) offenders.push(`${rel}  ${starts} 处 .tasks.start()（应交给 task_shell）`);
  if (finishes > 0) offenders.push(`${rel}  ${finishes} 处 .tasks.finish()（应交给 task_shell）`);
}
report(
  offenders.length === 0,
  `长任务的登记 / panic 收敛 / 收尾只在 commands/task_shell.rs（扫描 ${files.length} 个命令源文件）`,
  offenders,
);

// tasks.rs 自己不能收编——它只管控制块，起线程与收尾不在这儿。
const tasksBody = stripComments(readFileSync(TASKS_RS, "utf8"));
report(
  !/catch_unwind\s*\(/.test(tasksBody) && !/\.tasks\s*\.\s*finish\s*\(/.test(tasksBody),
  "tasks.rs 只放控制块，不承担起线程与收尾",
  ["tasks.rs 里出现了 catch_unwind / tasks.finish"],
);

const shellBody = stripComments(readFileSync(SHELL, "utf8"));
const shellMissing = [];
for (const needle of ["pub(crate) fn spawn_repo_task", "pub(crate) fn spawn_task_at"]) {
  if (!shellBody.includes(needle)) shellMissing.push(`commands/task_shell.rs 缺少 ${needle}`);
}
if (shellCatch === 0) shellMissing.push("commands/task_shell.rs 没有 catch_unwind（外壳被掏空？）");
if (shellFinish === 0) shellMissing.push("commands/task_shell.rs 没有 tasks.finish（外壳被掏空？）");
report(shellMissing.length === 0, "外壳自身仍承担 panic 收敛与收尾", shellMissing);

// 四个任务入口逐个钉住：漏改一处就退回手抄。
const ENTRIES = [
  ["apps/desktop/src-tauri/src/commands/file/task.rs", "spawn_repo_task(", 1],
  ["apps/desktop/src-tauri/src/commands/file/task.rs", "spawn_task_at(", 1],
  ["apps/desktop/src-tauri/src/commands/source.rs", "spawn_repo_task(", 2],
];
const entryProblems = [];
for (const [rel, needle, expected] of ENTRIES) {
  const body = stripComments(readFileSync(join(ROOT, rel), "utf8"));
  const count = (body.split(needle).length - 1);
  if (count !== expected) {
    entryProblems.push(`${rel}  出现 ${needle} ${count} 处（应为 ${expected}）`);
  }
}
report(
  entryProblems.length === 0,
  "四个长任务入口都经外壳起线程（scan / unmount / reanalyze / backfill）",
  entryProblems,
);

console.log(`\n[check-task-shell] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);