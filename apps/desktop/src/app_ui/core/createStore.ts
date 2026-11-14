/**
 * 模块级 store 的**唯一骨架**（D205）。
 *
 * 为什么单独成文件：`playerPlayStore` / `musicPlayStore` / `taskStore` / `mediaSortStore` /
 * `settingChangeStore` / `render/surfaceStatsStore` 六处各抄了一遍「`Set` 订阅表 + 遍历通知」，
 * 而其中只有一部分真的守住了下面两条不变量——`surfaceStatsStore` 手写五个字段逐个比较
 * （新增字段忘了加就静默不刷新），`taskStore` 无条件通知（同一对象也重渲染）。
 * 抄写本身不是问题，**抄出来的语义不一致**才是问题。
 *
 * 因此本文件把两条不变量写成代码，而不是写成注释：
 *
 * 1. `get()` 返回**稳定引用**：值没变就不换引用、不发通知。这是 `useSyncExternalStore`
 *    对 `getSnapshot` 的硬要求（换引用即无限重渲染）；`equals` 默认 `Object.is`。
 * 2. 通知遍历的是**订阅者快照**：监听方可以在回调里退订/订阅自己，不会漏掉或跳过。
 *
 * 纯 TS、无 React / Tauri 依赖（`pnpm check:panels` 直接 import 断言口径）。多个实例各自独立；
 * 需要「同一份事实只存一处」时**共用同一个实例**，需要「两处互不干扰」时各建一个
 * （播放请求就是这样：`playerPlayStore` 与 `musicPlayStore` 必须分开，见 D166）。
 */

/** 订阅返回值：退订函数（幂等）。 */
export type Unsubscribe = () => void;

/** 比较函数：返回 `true` 表示「没有变化」，不换引用、不通知。 */
export type StoreEquals<T> = (previous: T, next: T) => boolean;

/** 值型 store：读快照 / 换值 / 订阅。 */
export interface Store<T> {
  /** 当前快照（引用只在值变化时更换，可直接交给 `useSyncExternalStore`）。 */
  get(): T;
  /** 换值；`equals` 判为未变化时什么都不做。 */
  set(next: T): void;
  /** 订阅变化；返回退订函数。 */
  subscribe(listener: () => void): Unsubscribe;
}

/**
 * 建一个值型 store。
 *
 * @param initial 初值（本身即首帧快照，调用方不要再复制一份）。
 * @param equals  未变化判定；默认 `Object.is`。传自定义比较时**必须比较全部字段**——
 *                漏字段的后果是「值变了但界面不动」，这正是本文件要消灭的那类缺陷。
 */
export function createStore<T>(initial: T, equals: StoreEquals<T> = Object.is): Store<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: T) {
      if (equals(current, next)) {
        return;
      }
      current = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 事件型通道：不留快照，只把这一次的载荷交给当前订阅者。 */
export interface EventChannel<Args extends readonly unknown[]> {
  /** 广播一次；`[...listeners]` 快照保证回调里退订不会打断本轮。 */
  emit(...args: Args): void;
  /** 订阅；返回退订函数。 */
  subscribe(listener: (...args: Args) => void): Unsubscribe;
}

/**
 * 建一个事件型通道（「同窗口写完即广播」这类场景：载荷只对当时在座的订阅者有意义，
 * 没有「当前值」可言——后来者不该收到历史事件）。
 */
export function createEventChannel<Args extends readonly unknown[]>(): EventChannel<Args> {
  const listeners = new Set<(...args: Args) => void>();
  return {
    emit(...args: Args) {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
    subscribe(listener: (...args: Args) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
