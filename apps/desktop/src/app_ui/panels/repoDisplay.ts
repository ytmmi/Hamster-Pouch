/**
 * 仓库面板：**当前仓库的显示名解析**（纯函数）。
 *
 * 面板的「当前仓库」一行显示的是**仓库名**，不是 `repoId`：`repoId` 是仓库的内部主键
 * （`RepoId::generate()` 的 UUID），把它印在界面上对用户没有任何意义，而且与同一个面板
 * 「切换仓库」子菜单里显示的**名字**对不上——同一件事在一个面板里两套写法。
 *
 * 本文件**无框架依赖**（不 import React / Tauri），因此：
 * 1. 面板只消费这里的判定函数，不自己写 `repos.find(...)` 分支；
 * 2. 门禁 `pnpm check:panels` 可**直接导入**它，按行为断言解析口径。
 *
 * 解析**只认已装载列表里真实存在的行**：查不到就是"名字不可得"，由调用方渲染占位符，
 * **绝不回落到 `repoId`**——回落等于把哈希换个位置显示，正是本次要消掉的形态。
 */

/** 列表行的**最小结构**：面板与门禁都只依赖这两个字段（不绑定 `RepoListItem` 的其余列）。 */
export interface RepoNameSource {
  id: string;
  name: string;
}

/**
 * 名字不可得时的占位符。
 *
 * 与全应用其它"缺值"处同款（`—`）：**不省略该行**，否则"没有名字"与"面板坏了"外观一致。
 */
export const REPO_NAME_PLACEHOLDER = "—";

/**
 * 按 `repoId` 在仓库列表里查名字；未打开仓库 / 查不到 → `null`。
 *
 * 判据是 **`id` 相等**：名称可重名、列表顺序可变，两者都不能当查找键。
 */
export function resolveRepoName(
  repos: readonly RepoNameSource[],
  repoId: string | null | undefined,
): string | null {
  if (!repoId) {
    return null;
  }
  const name = repos.find((repo) => repo.id === repoId)?.name.trim();
  return name ? name : null;
}

/**
 * 「当前仓库」一行的**显示文本**：仓库名，名字不可得时为占位符。
 *
 * **永不回落 `repoId`**：内部主键不是显示值。
 */
export function repoNameLabel(
  repos: readonly RepoNameSource[],
  repoId: string | null | undefined,
): string {
  return resolveRepoName(repos, repoId) ?? REPO_NAME_PLACEHOLDER;
}
