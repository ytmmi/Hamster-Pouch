/**
 * 清理构建产物（按「文件夹为单位」删除编译中间文件与最终产物）。
 *
 * 只删除下面**固定清单**里的目录；清单之外的任何路径一律不碰，尤其是：
 *   - 活动用户数据（`<exe 同目录>\data\`：system\ 全局库 / user\repos\ 仓库库 /
 *     plugins\ 插件与扩展库 / thumbnails\ 缓存 / debug.log）——**清理时保留**；
 *   - node_modules / .pnpm-store（依赖，非编译产物）——**保留**；
 *   - external-cli / tools/tagdict（运行时与开发期数据）——**保留**。
 *
 * 用户数据与构建产物同根（都在 `apps/desktop/src-tauri/target/<profile>/` 下），
 * 因此清理 `src-tauri/target` 时会把 `<profile>/data` 整棵排除（保留）；
 * 其余内容（编译中间文件、最终 exe、`dev\` 开发包与 `release\` 发布包等最终产物）
 * 一律删除——旧包内的数据副本可由 `pnpm data:sync` 快照恢复。
 *
 * 用法（每次编译后想清掉旧产物时执行）：
 *   node tools/clean-build.mjs     # 或 pnpm clean
 */

import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 固定清单：以文件夹/文件为单位的编译中间产物与最终产物；skip = 清理时保留的相对路径。 */
const TARGETS = [
  { rel: "target", skip: [] }, // 根 Cargo workspace（crates）编译产物
  {
    rel: "apps/desktop/src-tauri/target", // Tauri 应用编译产物 + 最终 exe（debug/release）
    skip: ["release/data", "debug/data"].map((r) => r.split("/").join(sep)), // 用户数据整棵保留
  },
  { rel: "apps/desktop/dist", skip: [] }, // Vite 前端构建产物
  { rel: "apps/desktop/src-tauri/gen", skip: [] }, // Tauri 生成的 schema / 权限文件
];

/** 递归统计路径占用字节数（不存在返回 0）。 */
async function dirSize(p) {
  let total = 0;
  try {
    const entries = await readdir(p, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
    }
  } catch {
    return 0;
  }
  return total;
}

/**
 * 删除 root 下除 skipRels（相对 root、OS 分隔符）之外的整个目录树。
 * 保留路径整棵不动；空目录自底向上移除。返回实际删除的文件字节数。
 */
async function rmExcept(root, skipRels) {
  const skip = new Set(skipRels);
  let freed = 0;

  async function walk(p, rel) {
    if (skip.has(rel)) return true; // 保留路径：整棵不动，视为「有保留内容」
    let keptAny = false;
    let entries;
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(p, entry.name);
      const childRel = rel ? `${rel}${sep}${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (await walk(full, childRel)) keptAny = true;
      } else {
        const st = await stat(full).catch(() => null);
        const s = st ? st.size : 0;
        await rm(full, { force: true });
        freed += s;
      }
    }
    if (!keptAny && rel !== "") {
      await rm(p, { recursive: true, force: true }).catch(() => {});
      return false;
    }
    return true;
  }

  const rootKept = await walk(root, "");
  if (!rootKept) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return freed;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let freed = 0;
for (const { rel, skip } of TARGETS) {
  const abs = resolve(ROOT, rel);
  // 安全兜底：只允许删除固定清单内的相对路径，绝不接受清单外/越界路径。
  // （Windows 下 relative() 返回反斜杠，与清单的前斜杠比较前先归一化。）
  const relCheck = relative(ROOT, abs);
  if (relCheck.split(sep).join("/") !== rel || rel.includes("..") || relCheck.startsWith("..")) {
    console.error(`[clean-build] 拒绝删除清单外路径: ${abs}`);
    process.exit(1);
  }
  const size = await dirSize(abs);
  if (size === 0) {
    console.log(`[clean-build] 跳过（不存在）: ${rel}`);
    continue;
  }
  const removed = await rmExcept(abs, skip);
  freed += removed;
  const kept = await dirSize(abs);
  const keptNote = kept > 0 ? `（保留用户数据 ${fmtMB(kept)}）` : "";
  console.log(`[clean-build] 已清理: ${rel}（释放 ${fmtMB(removed)}）${keptNote}`);
}

console.log(`\n[clean-build] 共释放 ${fmtMB(freed)}（按文件夹为单位）`);
console.log(
  "[clean-build] 用户数据未触碰：`<exe 同目录>\\data\\`（system\\ 全局库 / user\\repos\\ 仓库库 / plugins\\ 插件 / thumbnails\\ 缓存）保留原样；发布构建不包含用户数据。",
);
