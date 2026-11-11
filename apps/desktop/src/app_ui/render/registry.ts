/**
 * 档位的**会话级记忆**（RFC §4.3）。
 *
 * 为什么需要它：一次 `device-lost`（TDR、驱动重置）之后，同一个档位往往会连续失败；
 * 每次换图都重新撞一遍会把「降级」变成「反复卡顿」。所以同一档位在同一会话里
 * 构造失败 2 次就禁用到下次加载（刷新页面即重置，不需要持久化）。
 *
 * 为什么显式强制档位不受记忆影响：排障时用户选 `webgpu` 就是想看失败现场；
 * 被记忆挡住就永远拿不到报错。
 */

import type { Backend } from "./surface";

/** 同一档位构造失败多少次后禁用（第 2 次失败即禁用）。 */
export const FAILURES_BEFORE_DISABLE = 2;

interface BackendMemory {
  failures: number;
  disabledUntilReload: boolean;
}

const memory = new Map<Backend, BackendMemory>();

function entry(backend: Backend): BackendMemory {
  const found = memory.get(backend);
  if (found) return found;
  const created: BackendMemory = { failures: 0, disabledUntilReload: false };
  memory.set(backend, created);
  return created;
}

/** 记一次构造/运行失败；返回「这一档是否已被禁用」。 */
export function noteBackendFailure(backend: Backend): boolean {
  const found = entry(backend);
  found.failures += 1;
  if (found.failures >= FAILURES_BEFORE_DISABLE) found.disabledUntilReload = true;
  return found.disabledUntilReload;
}

/** 记一次成功（重建成功后清掉计数：设备丢失是事件，不是慢性病）。 */
export function noteBackendReady(backend: Backend): void {
  const found = entry(backend);
  found.failures = 0;
}

/** 这一档在本次会话里是否已被禁用。 */
export function isBackendDisabled(backend: Backend): boolean {
  return memory.get(backend)?.disabledUntilReload === true;
}

/** 清空记忆（单测与「刷新页面」语义用；生产路径只在测试里调）。 */
export function resetBackendMemory(): void {
  memory.clear();
}
