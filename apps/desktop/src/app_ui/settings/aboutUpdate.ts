/**
 * 「关于 → 更新」的纯逻辑（D140）：版本比较与 GitHub 响应解析。
 *
 * 为什么要单独一个文件：这些函数**必须能在没有 Tauri、没有网络的环境里被断言**
 * （版本比较错一位就会把"已是最新"报成"有新版本"，是用户唯一看得见的更新功能）。
 * 组件（`AboutPanel.tsx`）只负责把这里的结果渲染成界面。
 *
 * 数据源：`.github/workflows/release.yml` 发布的 GitHub Release，tag 形如
 * `v<version>`（`v0.1.1-Alpha`）。**版本号后缀（`-Alpha`）不参与比较**——
 * 手里只有"数字段的新旧"这一个可靠信号，把 `-Alpha`/`-Beta` 排序会把预发布
 * 当成比同号正式版更新，而本项目当前**全部**产物都带 `-Alpha`。
 */

import type { GitHubRelease } from "../shared/types/app";

/** 版本比较用的数字三段（预发布后缀与 `+build` 元数据不参与比较）。 */
export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * 更新检查的结论（界面文案各一条）。
 *
 * `unavailable` = 请求成功但**列表里没有任何可用版本**（仓库还没发过 Release、
 * 或 tag 都不像 `x.y.z`）。它与 `latest` 必须分开：把"查不到"说成"您已是最新"
 * 是在替用户做一个我们并不知道的断言。
 */
export type UpdateState = "idle" | "checking" | "latest" | "outdated" | "unavailable" | "error";

/** 检查出来的"有一个更新的版本"。 */
export interface UpdateFound {
  version: string;
  url: string;
}

/**
 * 取版本号的数字三段：`v0.1.1-Alpha` → `{0,1,1}`。
 *
 * 容忍前缀 `v`/`V`、容忍后缀（`-Alpha`、`-beta.2`、`+build`）、容忍首尾空白；
 * 只要开头是 `x.y.z` 就算成功。**不**接受两段（`0.1`）或四段，
 * 因为那说明 tag 命名跑偏了，宁可不认也不要猜。
 */
export function parseVersion(text: string | null | undefined): VersionParts | null {
  if (typeof text !== "string") return null;
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * 比较两个版本的数字段：`a < b` 返回负数、相等返回 0、`a > b` 返回正数。
 *
 * 任一侧解析失败按"不可比"返回 0（调用方据此判定为"已是最新"，也就是
 * **失败关闭**：解析不出来时宁可什么都不提示，也不要催用户去下载一个假更新）。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/** `candidate` 是否比 `current` 新（数字段严格大于）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** 把 GitHub API 的返回体收敛成 `GitHubRelease[]`；形状不符直接返回空表。 */
export function parseReleasesJson(payload: unknown): GitHubRelease[] {
  if (!Array.isArray(payload)) return [];
  const out: GitHubRelease[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const tag = row.tag_name;
    const url = row.html_url;
    if (typeof tag !== "string" || typeof url !== "string") continue;
    out.push({
      tag_name: tag,
      html_url: url,
      name: typeof row.name === "string" ? row.name : null,
      draft: row.draft === true,
      prerelease: row.prerelease === true,
      published_at: typeof row.published_at === "string" ? row.published_at : null,
    });
  }
  return out;
}

/**
 * 从 Release 列表里挑出**版本号最大**的一条。
 *
 * 规则：
 * - 跳过 `draft`（草稿只有维护者看得见，用户点不开）；
 * - 跳过 tag 解析不出 `x.y.z` 的（比如手打的 `nightly`）；
 * - `prerelease` **不跳过**：本项目当前所有产物都带 `-Alpha`，跳过就等于
 *   永远检查不到更新；
 * - 版本号相同则取发布时间更晚的那条（重新发布同一版本的情形）。
 */
export function pickLatestRelease(releases: readonly GitHubRelease[]): GitHubRelease | null {
  let best: GitHubRelease | null = null;
  let bestParts: VersionParts | null = null;
  for (const release of releases) {
    if (release.draft === true) continue;
    const parts = parseVersion(release.tag_name);
    if (parts === null) continue;
    if (best === null || bestParts === null) {
      best = release;
      bestParts = parts;
      continue;
    }
    const cmp =
      parts.major !== bestParts.major
        ? parts.major - bestParts.major
        : parts.minor !== bestParts.minor
          ? parts.minor - bestParts.minor
          : parts.patch - bestParts.patch;
    if (cmp > 0) {
      best = release;
      bestParts = parts;
      continue;
    }
    if (cmp === 0) {
      const prev = best.published_at ?? "";
      const next = release.published_at ?? "";
      if (next > prev) best = release;
    }
  }
  return best;
}

/**
 * 判定更新结论：把「当前版本」与 Release 列表压成一个可直接渲染的结果。
 *
 * 三态而不是布尔：
 * - `outdated`：有比当前版本更高的 tag，`newer` 带版本号与 Release 页地址；
 * - `latest`：**确认**列表里有版本号、且没有比当前更高的（含"当前版本自己"）；
 * - `unavailable`：列表为空，或所有 tag 都不像 `x.y.z`。此时既不能说"已是最新"
 *   （我们没查到任何版本），也不能说"有新版"。
 */
export function evaluateUpdate(
  currentVersion: string,
  releases: readonly GitHubRelease[],
): { state: "latest" | "outdated" | "unavailable"; newer: UpdateFound | null; checked: number } {
  // 自己的版本号都解析不出来时，「有没有更新」无从谈起：同样是"无法确认"，
  // 不能因为 `compareVersions` 的失败关闭口径（返回 0）就落到 "latest"。
  if (parseVersion(currentVersion) === null) {
    return { state: "unavailable", newer: null, checked: releases.length };
  }
  const latest = pickLatestRelease(releases);
  if (latest === null) {
    return { state: "unavailable", newer: null, checked: releases.length };
  }
  const version = latest.tag_name.replace(/^[vV]/, "");
  if (!isNewerVersion(version, currentVersion)) {
    return { state: "latest", newer: null, checked: releases.length };
  }
  return { state: "outdated", newer: { version, url: latest.html_url }, checked: releases.length };
}

/** GitHub 上本项目的 Release 列表地址（只用公开读取，不带 token）。 */
export const RELEASES_API_URL =
  "https://api.github.com/repos/ytmmi/Hamster-Pouch/releases?per_page=100";

/** 更新检查的超时（毫秒）：网络不通时不能让「检查更新」按钮一直转。 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 拉取 Release 列表并判定是否有更新。
 *
 * 失败（离线 / 被墙 / 限流）抛 `Error`，由界面渲染成"检查失败"，**不**静默
 * 当成"已是最新"——那样用户会以为自己在最新版上。
 */
export async function checkForUpdate(
  currentVersion: string,
  signal?: AbortSignal,
): Promise<{ state: "latest" | "outdated" | "unavailable"; newer: UpdateFound | null; checked: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub 返回 ${response.status}`);
    }
    const payload: unknown = await response.json();
    return evaluateUpdate(currentVersion, parseReleasesJson(payload));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
