/**
 * `@tauri-apps/plugin-dialog` 的桩：夹具不用原生对话框。
 */

export async function open(_options?: unknown): Promise<string | null> {
  return null;
}

export async function save(_options?: unknown): Promise<string | null> {
  return null;
}

export async function message(_message: string, _options?: unknown): Promise<void> {
  /* 夹具不弹系统对话框 */
}

export async function ask(_message: string, _options?: unknown): Promise<boolean> {
  return false;
}

export async function confirm(_message: string, _options?: unknown): Promise<boolean> {
  return false;
}
