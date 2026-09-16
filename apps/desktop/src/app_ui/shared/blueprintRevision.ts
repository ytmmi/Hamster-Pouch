/**
 * 蓝图进程内同步令牌（RFC 0007 运行时集成）。
 *
 * 背景（实测缺陷）：蓝图面板可以**独立窗口**打开（dockview detach）。此时
 * `window.dispatchEvent` 只在该 WebView 内广播，主窗口收不到"我刚保存了"的通知；
 * 若后端 `blueprint.changed` 事件这一路也不可用，主窗口就永远拿着旧图，
 * 表现为"蓝图保存后不热更新，重启才生效"。
 *
 * 解决：把"已保存的蓝图版本令牌"放在**所有 WebView 共享的宿主对象**上
 * （Tauri v2 注入的 `document` 是共享的，绑在它上面的自定义事件同样跨窗口派发），
 * 主窗口只在**自己 document 的事件流里**监听 `storage` 式的令牌变化并按需重载——
 * 不依赖"谁保存谁通知"，任何窗口保存后其它窗口都会自我收敛。
 *
 * 实现细节：优先用共享 `document` 上的自定义事件（跨窗口且有载荷、无需轮询）；
 * 拿不到共享对象时退回 `localStorage` + `storage` 事件（同样跨窗口）。两条路都不
 * 需要后端参与，因此即使事件桥接失效，热更新依然成立。
 */

import type { BlueprintGraph } from "@hamster-pouch/config";

/** 进程内令牌（跨窗口可见）：最近一次保存的蓝图 id / 时间戳 / 节点数。 */
const TOKEN_KEY = "hp.blueprint.rev";
/** 共享 document 上的自定义事件名。 */
export const SHARED_REV_EVENT = "hp:blueprint-rev";

export interface BlueprintRevision {
  /** 蓝图 id。 */
  id: string;
  /** 保存时间戳（Date.now()）。 */
  at: number;
  /** 文档节点数（供诊断）。 */
  nodes: number;
}

/** 共享宿主对象（Tauri v2 的 document 跨 WebView 共享；取不到则退回 window）。 */
function sharedHost(): EventTarget | null {
  try {
    if (typeof document !== "undefined" && document) {
      return document;
    }
  } catch {
    /* 忽略 */
  }
  try {
    if (typeof window !== "undefined" && window) {
      return window;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 广播"蓝图已保存"（任何窗口都能看到）。 */
export function publishBlueprintRevision(input: {
  id: string;
  graph: BlueprintGraph;
}): BlueprintRevision {
  const revision: BlueprintRevision = {
    id: input.id,
    at: Date.now(),
    nodes: input.graph.nodes.length,
  };
  const host = sharedHost();
  if (host) {
    try {
      host.dispatchEvent(
        new CustomEvent<BlueprintRevision>(SHARED_REV_EVENT, { detail: revision }),
      );
    } catch {
      /* 忽略：订阅方仍有 localStorage 回退路径 */
    }
  }
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(revision));
  } catch {
    /* 隐私模式/无 storage 时忽略 */
  }
  return revision;
}

/** 读取当前令牌（跨窗口）。 */
export function readBlueprintRevision(): BlueprintRevision | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as BlueprintRevision;
    return typeof parsed?.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 订阅跨窗口蓝图变更令牌。
 * 返回取消订阅函数。
 */
export function subscribeBlueprintRevision(
  onChanged: (revision: BlueprintRevision) => void,
): () => void {
  const host = sharedHost();
  const onShared = (e: Event) => {
    const detail = (e as CustomEvent<BlueprintRevision>).detail;
    if (detail && typeof detail.at === "number") {
      onChanged(detail);
    }
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== TOKEN_KEY || !e.newValue) {
      return;
    }
    try {
      const parsed = JSON.parse(e.newValue) as BlueprintRevision;
      if (typeof parsed?.at === "number") {
        onChanged(parsed);
      }
    } catch {
      /* 忽略 */
    }
  };
  host?.addEventListener(SHARED_REV_EVENT, onShared);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    host?.removeEventListener(SHARED_REV_EVENT, onShared);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
