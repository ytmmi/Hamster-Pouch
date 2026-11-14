// check-media-url.mjs：媒体显示 URL 的解析与转换只能各有一处（D208 护航门禁）。
//
// 为什么需要它：`convertFileSrc` 曾经散在十来个面板里（查看器、媒体/音乐播放器、
// 元数据探针、书封缓存、预览数据、正文插图…），每处都各自记得 `path ? convertFileSrc(path)`，
// 空值口径互不相同；"该用原图还是后端全分辨率预览"这条策略也分住在图像查看器、
// 查看器面板（内联分支，注释里自己写着「属既有重复」）与播放器里。缓存 + 在途去重
// 更是抄了三份同形代码。
//
// 现在：转换只有 `shared/assetUrl.ts`，策略与媒体缓存只有 `shared/mediaUrl.ts`，
// 缩略图/预览各自保留自己的缓存模块，三者共用 `shared/urlCache.ts` 的骨架。
// 本门禁把「不许再抄回去」变成断言。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "desktop", "src");
const SHARED = join(SRC, "app_ui", "shared");

let total = 0;
let passed = 0;
function report(ok, label, detail) {
  total += 1;
  if (ok) {
    passed += 1;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    for (const line of detail.slice(0, 12)) console.log(`      ${line}`);
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 收集 `apps/desktop/src` 下全部 .ts / .tsx（不走 node_modules，本身就没有）。 */
function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collect(abs, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

const files = collect(SRC, []);
const rel = (abs) => relative(ROOT, abs).replace(/\\/g, "/");
const readAt = (abs) => stripComments(readFileSync(abs, "utf8"));
const ASSET_URL = join(SHARED, "assetUrl.ts");
const MEDIA_URL = join(SHARED, "mediaUrl.ts");
const URL_CACHE = join(SHARED, "urlCache.ts");
const PREVIEW_URL = join(SHARED, "previewUrl.ts");
const THUMB_URL = join(SHARED, "thumbUrl.ts");

// ① 路径 → asset URL 的转换只有一处
{
  const offenders = [];
  for (const abs of files) {
    if (abs === ASSET_URL) continue;
    const body = readAt(abs);
    if (/convertFileSrc\s*\(/.test(body) || /import\s*\{[^}]*convertFileSrc/.test(body)) {
      offenders.push(rel(abs));
    }
  }
  const assetSrc = existsSync(ASSET_URL) ? readAt(ASSET_URL) : "";
  const problems = [...offenders];
  if (!assetSrc) problems.push("apps/desktop/src/app_ui/shared/assetUrl.ts 不存在");
  for (const name of ["assetUrl", "assetUrlOrNull", "assetUrlOrEmpty"]) {
    if (assetSrc && !new RegExp(`export function ${name}\\(`).test(assetSrc)) {
      problems.push(`assetUrl.ts 缺少导出 ${name}`);
    }
  }
  report(
    problems.length === 0,
    "路径 → asset URL 的转换只在 shared/assetUrl.ts（面板不得直接 convertFileSrc）",
    problems,
  );
}

// ② 图片「原图还是后端预览」的策略只有一处，且不再有图像专用模块
{
  const problems = [];
  const mediaSrc = existsSync(MEDIA_URL) ? readAt(MEDIA_URL) : "";
  if (!mediaSrc) problems.push("apps/desktop/src/app_ui/shared/mediaUrl.ts 不存在");
  for (const name of ["resolveMediaUrlOutcome", "resolveMediaUrl", "resolveSourceUrl"]) {
    if (mediaSrc && !new RegExp(`export function ${name}\\(`).test(mediaSrc)) {
      problems.push(`mediaUrl.ts 缺少导出 ${name}`);
    }
  }
  if (mediaSrc) {
    if (!/needsPreview\(relativePath\)/.test(mediaSrc)) problems.push("mediaUrl.ts 未按 needsPreview 分流");
    if (!/resolvePreviewUrl\(repoId, fileId\)/.test(mediaSrc)) problems.push("mediaUrl.ts 未复用 previewUrl 的缓存");
    if (!/mediaType === "image"/.test(mediaSrc)) problems.push("mediaUrl.ts 未限定图片才走预览");
  }
  if (existsSync(join(SHARED, "imageUrl.ts"))) {
    problems.push("shared/imageUrl.ts 仍在（D208 起并入 mediaUrl.ts）");
  }
  for (const abs of files) {
    if (abs === MEDIA_URL || abs === PREVIEW_URL) continue;
    const body = readAt(abs);
    if (/api\.previewGet\s*\(/.test(body)) problems.push(`${rel(abs)} 直接调用 previewGet`);
  }
  for (const abs of files) {
    if (abs === THUMB_URL) continue;
    const body = readAt(abs);
    if (/api\.thumbGet\s*\(/.test(body)) problems.push(`${rel(abs)} 直接调用 thumbGet`);
  }
  report(problems.length === 0, "图片/媒体 URL 的策略只在 shared/mediaUrl.ts（imageUrl 已并入）", problems);
}

// ③ 缓存 + 在途去重只有一份骨架
{
  const problems = [];
  const cacheSrc = existsSync(URL_CACHE) ? readAt(URL_CACHE) : "";
  if (!cacheSrc) problems.push("apps/desktop/src/app_ui/shared/urlCache.ts 不存在");
  if (cacheSrc) {
    for (const needle of ["export function createUrlResolver", "const settled = new Map<string, T>()", "const inflight = new Map<string, Promise<T>>()", "inflight.delete(key)"]) {
      if (!cacheSrc.includes(needle)) problems.push(`urlCache.ts 缺少 ${needle}`);
    }
  }
  for (const [abs, name] of [
    [THUMB_URL, "thumbUrl.ts"],
    [PREVIEW_URL, "previewUrl.ts"],
    [MEDIA_URL, "mediaUrl.ts"],
  ]) {
    const body = existsSync(abs) ? readAt(abs) : "";
    if (!/createUrlResolver</.test(body)) problems.push(`${name} 未使用 createUrlResolver`);
  }
  for (const abs of files) {
    if (abs === URL_CACHE) continue;
    if (/new Map<string, Promise</.test(readAt(abs))) problems.push(`${rel(abs)} 自建在途表`);
  }
  report(problems.length === 0, "URL 缓存的「命中 / 合并 / 落缓存」只有 shared/urlCache.ts 一份骨架", problems);
}

// ④ 播放器与元数据探针走同一个源 URL 入口
{
  const problems = [];
  const consumers = [
    ["apps/desktop/src/app_ui/panels/MediaPlayerPanel.tsx", "媒体播放器"],
    ["apps/desktop/src/app_ui/panels/MusicPlayerPanel.tsx", "音乐播放器"],
    ["apps/desktop/src/app_ui/panels/MetadataPanel.tsx", "元数据探针"],
    ["apps/desktop/src/app_ui/panels/ViewerPanel.tsx", "查看器"],
  ];
  for (const [relPath, label] of consumers) {
    const abs = join(ROOT, relPath);
    const body = existsSync(abs) ? readAt(abs) : "";
    if (!body) {
      problems.push(`${relPath} 不存在`);
      continue;
    }
    const usesShared =
      /resolveSourceUrl\(/.test(body) || /resolveMediaUrlOutcome\(/.test(body) || /resolveMediaUrl\(/.test(body);
    if (!usesShared) problems.push(`${label} 未走 shared/mediaUrl（${relPath}）`);
    if (/api\.filePath\(/.test(body) && !/mediaPreviewActions/.test(relPath)) {
      problems.push(`${label} 仍自己调 filePath 再拼 URL（${relPath}）`);
    }
  }
  report(problems.length === 0, "播放器 / 元数据探针 / 查看器共用同一个源 URL 入口", problems);
}

console.log(`\n[check-media-url] ${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
