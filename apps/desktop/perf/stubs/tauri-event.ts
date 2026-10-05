/**
 * `@tauri-apps/api/event` 的桩：`listen` 只登记、永不触发。
 *
 * 夹具不需要真实事件（设置热加载、任务进度都走不到），但**必须**让 `listen`
 * 返回一个可 `dispose` 的 Promise——否则 `settingValue.ts` 的 `.then(unlisten)`
 * 会抛错并让面板渲染失败。
 */

type UnlistenFn = () => void;

const listeners = new Set<string>();

export async function listen(event: string, _handler: unknown): Promise<UnlistenFn> {
  listeners.add(event);
  return () => {
    listeners.delete(event);
  };
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  /* 夹具不触发事件 */
}

export async function once(_event: string, _handler: unknown): Promise<UnlistenFn> {
  return () => undefined;
}
