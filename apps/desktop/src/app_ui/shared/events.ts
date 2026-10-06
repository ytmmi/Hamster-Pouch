/**
 * Tauri 事件的**唯一收发口**：逻辑事件名 → 线上事件名（`.` → `:`）。
 *
 * **为什么必须有这一层（缺陷 0022）**：Tauri 2 的事件名只允许
 * `[A-Za-z0-9\-/:_]`，**不接受点号**——`emit("scan.progress", …)` 直接被拒
 * （`only alphanumeric, '-', '/', ':', '_' permitted for event names`），
 * 而本项目的事件名在契约与代码里沿用点分（与命令的 `domain.action` 同款）。
 * 命令侧早有等价映射（`domain.action` ↔ `domain_action`），事件侧此前漏了，
 * 于是整族事件静默失效：进度浮窗永远停在第一帧、插件/设置/蓝图/调色板刷新
 * 全部无声无息。**前端一律经 `listenHp` / `emitHp` 收发事件**；裸 `listen("a.b")`
 * 会永远收不到，且不会有任何报错。
 *
 * 后端对应实现：`apps/desktop/src-tauri/src/commands/shared.rs` 的
 * `wire_event` / `EmitHp::emit_hp`（同名规则、同一映射）。
 */

import { emit, listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

/** 逻辑事件名（点分，与 `docs/spec/commands-events.md` 一致）→ 线上事件名。 */
export function wireEventName(logical: string): string {
  return logical.replace(/\./g, ":");
}

/** 订阅事件（逻辑名点分，线上名由 [`wireEventName`] 映射）。 */
export function listenHp<T>(
  logical: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(wireEventName(logical), handler);
}

/** 广播事件（逻辑名点分，线上名由 [`wireEventName`] 映射）。 */
export function emitHp(logical: string, payload?: unknown): Promise<void> {
  return emit(wireEventName(logical), payload);
}
