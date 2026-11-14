/**
 * 本地绝对路径 → WebView 可加载的 asset URL（唯一一处 `convertFileSrc`）。
 *
 * Tauri 的 `convertFileSrc` 把磁盘路径改写成 `asset://` / `http://asset.localhost` 形式；
 * 它出现的次数曾经和「要显示一个本地文件的地方」一样多（媒体播放器、元数据探针、
 * 书封、预览数据、文本块…十来处），每处都各自记得 `path ? convertFileSrc(path) : …`。
 * 这类转换一旦分散：
 *
 * - **改一次要改十几处**——Tauri 换协议、加 CSP、换 `assetProtocol` 作用域时逐个找；
 * - **空值口径各自不同**——有的返回空串、有的返回 `null`、有的干脆漏判；
 * - **本机路径泄漏进业务类型**——调用方分不清「文件绝对路径」与「可显示的 URL」。
 *
 * 所以只在这里做转换，调用方按需要的空值形状挑一个入口：
 *
 * - [`assetUrl`]：路径一定有，直接换；
 * - [`assetUrlOrNull`]：路径可能为空（可选封面等），空则 `null`；
 * - [`assetUrlOrEmpty`]：路径可能为空，但消费方（`<img src>` / `<video src>`）只吃字符串。
 *
 * **不负责取路径**：拿路径仍是 `api.filePath` / `api.previewGet` / `api.thumbGet`；
 * 带缓存与去重的取法见 `./urlCache`、`./mediaUrl`、`./thumbUrl`、`./previewUrl`。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

/** 把一定有值的绝对路径换成 asset URL。 */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/** 把可能为空的绝对路径换成 asset URL；空值原样返回 `null`（不产生空串 URL）。 */
export function assetUrlOrNull(path: string | null | undefined): string | null {
  return path ? convertFileSrc(path) : null;
}

/** 把可能为空的绝对路径换成 asset URL；空值给空串（`<img src>` 的既有口径）。 */
export function assetUrlOrEmpty(path: string | null | undefined): string {
  return path ? convertFileSrc(path) : "";
}
