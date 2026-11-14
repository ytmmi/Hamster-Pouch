/**
 * 「解析一次、结果留住、在途合并」的唯一实现（URL 类缓存的骨架）。
 *
 * 缩略图、全分辨率预览、媒体源三处曾各写一份完全同形的代码：一张结果表、一张
 * 在途表，命中就返回 → 在途就返回同一个 Promise → 否则发请求并在兑现后落缓存；
 * 清空时两张表一起清。
 *
 * 三份的差别只有：键怎么拼（缩略图带分辨率档）、失败怎么表达（`null` 还是带
 * `error` 的对象）。这些正是调用方自己的事；而「先查、再合、后落、清两张表」的
 * 次序没有第二种正确写法——写错一处就是**同一个文件被并发请求两次**（后端多做一次
 * 解码/转码），或者**失败被永久缓存**。
 *
 * 因此骨架收在这里，调用方只给两样东西：
 *
 * - `keyOf(...args)`：把这次请求折成一个缓存键；
 * - `load(...args)`：真正发请求。**失败语义由它决定**——想「失败也算一种结果」就在
 *   里面 `catch` 成值（会被缓存）；想「失败不缓存、下次重试」就直接抛，骨架只缓存
 *   **兑现**的结果。
 *
 * 键里该不该带仓库 id 由调用方决定（`fileId` 在仓库间可能复用，带上是更稳的默认）。
 */

/** 一个键值缓存的解析入口。 */
export interface UrlResolver<Args extends readonly unknown[], T> {
  /** 命中缓存 / 合并在途请求 / 否则发起一次 `load`。 */
  resolve(...args: Args): Promise<T>;
  /** 清空结果表与在途表（仓库切换后旧 fileId 恒失效）。 */
  clear(): void;
}

/**
 * 造一个解析器。
 *
 * `load` 抛错时**不写缓存**：错误原样传给这次（及并发的）调用方，下次再调会重新请求。
 */
export function createUrlResolver<Args extends readonly unknown[], T>(
  keyOf: (...args: Args) => string,
  load: (...args: Args) => Promise<T>,
): UrlResolver<Args, T> {
  const settled = new Map<string, T>();
  const inflight = new Map<string, Promise<T>>();
  return {
    resolve(...args: Args): Promise<T> {
      const key = keyOf(...args);
      if (settled.has(key)) {
        return Promise.resolve(settled.get(key) as T);
      }
      const running = inflight.get(key);
      if (running) {
        return running;
      }
      const pending = load(...args)
        .then((value): T => {
          settled.set(key, value);
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, pending);
      return pending;
    },
    clear(): void {
      settled.clear();
      inflight.clear();
    },
  };
}
