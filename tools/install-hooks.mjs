// install-hooks.mjs：把 tools/hooks/ 下的钩子装到 .git/hooks（由 pnpm install 自动触发）。
//
// ## 为什么要装到 .git/hooks 而不是用框架
//
// git 只认 `.git/hooks/<name>`（且必须可执行）。husky 之类的价值在于"跟随仓库分发
// 钩子并自动安装"，但那要新增 devDependency + `prepare` 链。本仓库的选择是：
// **钩子脚本本身入库**（`tools/hooks/`，可 review、可版本化），安装步骤用一个
// 几十行的 node 脚本完成，并在 `package.json` 的 `prepare` 里调用。
//
// ## 为什么不覆盖已有的自定义钩子
//
// `.git/hooks/` 下可能已有别人手写的钩子。这里的原则是**只在不存在或已是我们装的
// 版本时写入**（我们的版本带 `hp-hook` 标记）；遇到其它内容则跳过并提示，
// 绝不静默覆盖——否则等于替用户做决定。
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOOKS_SRC = join(ROOT, "tools", "hooks");
const GIT_DIR = join(ROOT, ".git");

if (!existsSync(GIT_DIR)) {
  console.log("[install-hooks] 不在 git 工作树里（或无 .git），跳过");
  process.exit(0);
}

const HOOKS = ["pre-commit", "pre-push"];
const MARK = "# hp-hook";

mkdirSync(join(GIT_DIR, "hooks"), { recursive: true });

let installed = 0;
let skipped = 0;
for (const name of HOOKS) {
  const src = join(HOOKS_SRC, name);
  const dst = join(GIT_DIR, "hooks", name);
  if (!existsSync(src)) {
    console.warn(`[install-hooks] 缺少 ${src}`);
    continue;
  }
  if (existsSync(dst)) {
    const cur = readFileSync(dst, "utf8");
    const ours = cur.includes(MARK) || cur.includes("hp-hook");
    if (!ours) {
      console.warn(`[install-hooks] ${dst} 已存在且非本项目安装，跳过（不覆盖）`);
      skipped++;
      continue;
    }
  }
  let body = readFileSync(src, "utf8");
  // 在 shebang 之后插入标记，便于下次识别"这是我们装的"
  if (!body.includes(MARK)) {
    body = body.replace(/^#!\s*\/bin\/sh\n/, `#! /bin/sh\n${MARK}\n`);
  }
  writeFileSync(dst, body, { mode: 0o755 });
  try { chmodSync(dst, 0o755); } catch { /* Windows 上可能无效，git for windows 会兜底 */ }
  installed++;
  console.log(`[install-hooks] 已安装 ${name}`);
}

console.log(`[install-hooks] 完成：安装 ${installed} 个，跳过 ${skipped} 个`);
console.log("[install-hooks] 应急跳过校验：git commit --no-verify / git push --no-verify");
