/**
 * 共享的**单帧调度器**（RFC §3 的 `setView` 语义落地处）。
 *
 * 为什么不是每个表面各起一个 `requestAnimationFrame`：一次滚轮事件会连续产生多帧变换，
 * 每帧多条表面若各排各的 rAF，同一帧里可能出现「A 已按新变换画、B 还停在上一帧」；
 * 更实际的问题是 n 个表面 = n 个 rAF 回调 + n 次布局读，帧预算会被调度开销吃掉。
 * 这里只保留一个 rAF，回调去重（同一函数重复登记只跑一次），一帧内多表面按登记顺序跑。
 */

type FrameTask = () => void;

const queue = new Set<FrameTask>();
let handle: number | null = null;

function flush(): void {
  handle = null;
  // 先快照再清空：任务在回调里重新登记（例如「画完再排下一帧」）必须落到下一帧，
  // 否则会在一帧里自激成死循环。
  const tasks = [...queue];
  queue.clear();
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      // 一个表面的绘制失败不能带走同一帧里其它表面的绘制（降级由表面自己上报）。
      console.warn("[render] frame task failed", error);
    }
  }
}

/** 登记一个「下一帧执行」的任务；返回撤销函数（幂等）。 */
export function scheduleFrame(task: FrameTask): () => void {
  queue.add(task);
  if (handle === null) handle = requestAnimationFrame(flush);
  return () => {
    queue.delete(task);
    // 队列空了就把 rAF 撤掉，别让空转的 rAF 一直唤醒合成器。
    if (queue.size === 0 && handle !== null) {
      cancelAnimationFrame(handle);
      handle = null;
    }
  };
}

/** 该任务是否已经登记（表面的 `setView` 用它做幂等去重）。 */
export function isFrameScheduled(task: FrameTask): boolean {
  return queue.has(task);
}
