/**
 * 媒体预览**排序会话覆盖**的跨面板共享状态（缺陷 0039 / D144）。
 *
 * 为什么排序覆盖要进 store，而视图 / 图片尺寸留在面板模块里：排序不只是媒体预览
 * 自己的排版参数——图像查看器的胶片栏浏览序列也必须按**同一份有效排序**排列
 * （`useViewerSequence.ts` 消费 `subscribeMediaSort` / `getMediaSortSession`）。
 * 覆盖值此前是 `mediaPreviewSession.ts` 的私有模块变量，第二个消费方根本读不到，
 * 于是"媒体预览设为名称倒序、胶片栏还是正序"（同一个事实写在两处、只有一处跟得上，
 * 0024 / 0031 / 0032 同族）。视图 / 尺寸没有第二个消费方，保持原状。
 *
 * **store 只存覆盖，不存缺省**：设置缺省的唯一事实来源仍是 `app_settings`，
 * 两个面板各自经 `usePanelSettingValue`（四条热加载触发源）读同一批键并按声明归一化，
 * 有效值 = 覆盖 ?? 缺省。store 再镜像一份缺省就是第二份真相，且会引入
 * "媒体预览没挂载时查看器读不到设置"的挂载依赖。
 *
 * 口径与 `mediaPreviewSession.ts` 的既有语义**逐字一致**：
 *
 * - 覆盖是**本会话内**的临时值（模块级，跨 dockview 卸载重建保留，不落库）；
 * - 「全部设置」显式改动 `panel.media.sortKey` / `panel.media.sortDir` 时**放弃**对应覆盖
 *   （本地广播 `settingChangeStore` 携带落库键；不做"缺省值变了就清覆盖"的推断——
 *   那会在面板重建时把用户刚选的排序抹掉）。
 *
 * 与 `core/settingChangeStore` / `core/panelStore` 同款：模块级订阅表 + 纯函数，
 * 不进 React context、不落库、不参与蓝图求值；通知只在值真的变化时发。
 * 本模块无 React / Tauri 依赖（`pnpm check:panels` 直接 import 断言）。
 */

import { panelSettingStorageKey } from "@hamster-pouch/config";

import { subscribeSettingChanged } from "./settingChangeStore";
import {
  isMediaSortKey,
  isSortDirection,
  MEDIA_PANEL_ID,
  type MediaSortKey,
  type SortDirection,
} from "../panels/mediaPreviewView";

/** 排序设置落库键（`panel.media.<key>`；声明见 `packages/config/src/panels.ts`）。 */
export const MEDIA_SORT_KEY_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "sortKey");
export const MEDIA_SORT_DIR_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "sortDir");

/** 会话覆盖快照（`null` = 跟随设置缺省）。恒为稳定引用，供 `useSyncExternalStore`。 */
export interface MediaSortSession {
  key: MediaSortKey | null;
  dir: SortDirection | null;
}

let sessionSnapshot: MediaSortSession = { key: null, dir: null };

type Listener = () => void;
const listeners = new Set<Listener>();

function publish(next: MediaSortSession): void {
  sessionSnapshot = next;
  for (const listener of [...listeners]) listener();
}

/** 订阅排序覆盖变化；返回退订函数。 */
export function subscribeMediaSort(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前会话覆盖快照（引用只在变化时更换）。 */
export function getMediaSortSession(): MediaSortSession {
  return sessionSnapshot;
}

/** 面板内选排序（键或方向；非法取值忽略）。本会话内记住，并通知其它消费方。 */
export function chooseMediaSort(next: string): void {
  if (isMediaSortKey(next)) {
    if (sessionSnapshot.key === next) return;
    publish({ ...sessionSnapshot, key: next });
  } else if (isSortDirection(next)) {
    if (sessionSnapshot.dir === next) return;
    publish({ ...sessionSnapshot, dir: next });
  }
}

/** 「全部设置」显式写入对应键 → 放弃该项会话覆盖（否则＝改了设置没反应）。 */
function onSettingChanged(key: string): void {
  if (key === MEDIA_SORT_KEY_STORAGE_KEY) {
    if (sessionSnapshot.key === null) return;
    publish({ ...sessionSnapshot, key: null });
  } else if (key === MEDIA_SORT_DIR_STORAGE_KEY) {
    if (sessionSnapshot.dir === null) return;
    publish({ ...sessionSnapshot, dir: null });
  }
}

// 模块加载即挂上：放弃覆盖不依赖"哪个面板恰好挂载着"（媒体预览被 dockview 卸载后，
// 用户在设置里改排序，图像查看器仍在消费这份覆盖——清除必须照常发生）。
subscribeSettingChanged(onSettingChanged);