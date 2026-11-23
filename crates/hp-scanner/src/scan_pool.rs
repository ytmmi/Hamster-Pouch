//! 扫描期的**有界并行**执行器（`docs/issues/0018`）。
//!
//! **为什么需要它**：大图库（数万张、单张 9000×9000 以上）的扫描成本主要在
//! **重采样**而不是解码，而旧实现是单线程逐文件——16 个逻辑核只有 1 个在干活。
//! 实测（41 张真实分布样本）：单线程 357 ms/张 → 全并行 86 ms/张（**4.1×**）。
//!
//! **为什么不能直接全并行**：一张 9000² 图解码后约 **231 MB**（RGB8），
//! 16 个核同时持图就是 3.7 GB。因此并发度必须**按图像大小加权**：
//!
//! - 小图（1536² ≈ 2.4 MP）可以高并发，不牺牲吞吐；
//! - 大图（9000² ≈ 81 MP）自动把并发压到 1–2 张，不打爆内存。
//!
//! 配额以**百万像素**计，总预算 [`PIXEL_BUDGET_MP`]；单张图的配额**上限等于预算**，
//! 保证任何一张图都能独占通过（不会被自己饿死）。

use std::sync::{Arc, Condvar, Mutex, mpsc};

/// 并行预算（单位：百万像素）。约等于 768 MB 的 RGB8 同时驻留（256 MP × 3 B）。
pub const PIXEL_BUDGET_MP: u64 = 256;

/// 把像素数折算成配额（百万像素，向上取整、下限 1、上限 = 总预算）。
pub fn pixel_cost(width: u32, height: u32) -> u64 {
    let mp = (width as u64 * height as u64).div_ceil(1_000_000);
    mp.clamp(1, PIXEL_BUDGET_MP)
}

/// 按像素数计量的配额闸门。
struct Budget {
    available: Mutex<u64>,
    ready: Condvar,
}

/// 已取得的配额；`Drop` 时自动归还（异常路径也不会泄漏配额）。
pub struct Permit<'a> {
    budget: &'a Budget,
    cost: u64,
}

impl Budget {
    fn new() -> Self {
        Self {
            available: Mutex::new(PIXEL_BUDGET_MP),
            ready: Condvar::new(),
        }
    }

    /// 申请 `cost` 配额；不足则等待。`cost` 已被 [`pixel_cost`] 夹到 `[1, 预算]`。
    fn acquire(&self, cost: u64) -> Permit<'_> {
        let mut available = self.available.lock().unwrap_or_else(|e| e.into_inner());
        while *available < cost {
            available = self
                .ready
                .wait(available)
                .unwrap_or_else(|e| e.into_inner());
        }
        *available -= cost;
        Permit { budget: self, cost }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut available = self
            .budget
            .available
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *available = (*available + self.cost).min(PIXEL_BUDGET_MP);
        self.budget.ready.notify_all();
    }
}

/// 并行度上限：`workers` 与可用核数取小，且至少 1。
///
/// 这里只限制**线程数**；真正的内存约束由 [`Budget`] 承担（见模块文档）。
pub fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .max(1)
}

/// 一个待执行的工作单元（`Job` 里装的是**单个条目**的处理闭包）。
type Job = Box<dyn FnOnce() + Send + 'static>;

/// 常驻线程池的句柄：任务投递端 + worker 线程句柄。
///
/// **为什么让线程常驻**（2026-11-23 扫描速度专项）：旧实现每次 `map_bounded` 调用
/// 都 `std::thread::scope` 起 `worker_count()` 个线程、再分配 `items.len()` 个结果槽，
/// 干完立刻拆掉。实测每次调用的固定成本是 **1.0–1.4 ms**（与工作量无关）：
/// 20 000 项空转 chunk=16 时 1250 次调用 = 12.4 s；chunk=256 时 79 次 = 0.13 s。
/// 而扫描的真实库增量里 784 次调用 × 1.03 ms = 0.81 s，**正好等于实测总耗时 0.90 s**。
/// 换成常驻池后同一批 16 项的任务从 67.2 µs/项 降到 1.2 µs/项（57.6×）。
struct Pool {
    sender: mpsc::Sender<Job>,
    handles: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

impl Drop for Pool {
    fn drop(&mut self) {
        // 丢掉发送端 → worker 的 `recv` 返回 `Err` → 线程退出。
        // 这里只能重建一个占位发送端把原来的换出来：`mpsc::Sender` 没有 `close`。
        let (placeholder, _) = mpsc::channel();
        let _ = std::mem::replace(&mut self.sender, placeholder);
        let handles = std::mem::take(&mut *self.handles.lock().unwrap_or_else(|e| e.into_inner()));
        for handle in handles {
            let _ = handle.join();
        }
    }
}

/// 进程级共享线程池（惰性创建，`OnceLock` 持有，进程退出时随静态量析构）。
fn shared_pool() -> &'static Pool {
    static POOL: std::sync::OnceLock<Pool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let workers = worker_count();
        let (sender, receiver) = mpsc::channel::<Job>();
        let receiver = Arc::new(Mutex::new(receiver));
        let mut handles = Vec::with_capacity(workers);
        for index in 0..workers {
            let receiver = Arc::clone(&receiver);
            let handle = std::thread::Builder::new()
                .name(format!("hp-scan-{index}"))
                .spawn(move || {
                    loop {
                        // 锁只在取任务时持有（取到就放），任务本身在锁外跑。
                        let job = {
                            let guard = receiver.lock().unwrap_or_else(|e| e.into_inner());
                            guard.recv()
                        };
                        match job {
                            Ok(job) => job(),
                            Err(_) => return,
                        }
                    }
                })
                .expect("扫描线程池创建失败");
            handles.push(handle);
        }
        Pool {
            sender,
            handles: Mutex::new(handles),
        }
    })
}
/// 对 `items` 做**保序**的有界并行映射。
///
/// - `cost_of` 给出每项的像素配额（在真正解码前调用，用于限流）；
/// - `f` 是纯计算，**不得访问数据库**（数据库写回由调用方串行完成）；
/// - 返回的 `Vec` 与 `items` **下标一一对应**，因此调用方的进度与计数语义不变。
pub fn map_bounded<T, R, C, F>(items: &[T], cost_of: C, f: F) -> Vec<R>
where
    T: Clone + Send + 'static,
    R: Send + 'static,
    C: Fn(&T) -> u64 + Send + Sync + 'static,
    F: Fn(&T) -> R + Send + Sync + 'static,
{
    if items.is_empty() {
        return Vec::new();
    }
    let owned: Vec<T> = items.to_vec();
    let total = owned.len();
    // 结果按下标落位：并行完成顺序与提交顺序无关，但**产出顺序恒定**。
    let slots: Arc<Vec<Mutex<Option<R>>>> =
        Arc::new((0..total).map(|_| Mutex::new(None)).collect());
    let budget = Arc::new(Budget::new());
    let cost_of = Arc::new(cost_of);
    let f = Arc::new(f);
    let done = Arc::new((Mutex::new(0usize), Condvar::new()));
    // 工作线程里的 panic 必须在**调用方线程**上重新抛出：既保留"并行段出错就上抛"
    // 的既有语义，也不让调用方永远等在计数上。
    let panicked: Arc<Mutex<Option<Box<dyn std::any::Any + Send>>>> = Arc::new(Mutex::new(None));

    for (index, item) in owned.into_iter().enumerate() {
        let slots = Arc::clone(&slots);
        let budget = Arc::clone(&budget);
        let cost_of = Arc::clone(&cost_of);
        let f = Arc::clone(&f);
        let done = Arc::clone(&done);
        let panicked = Arc::clone(&panicked);
        let job: Job = Box::new(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                // 先按尺寸申请配额，再进入昂贵解码。
                let _permit = budget.acquire(cost_of(&item));
                let value = f(&item);
                *slots[index].lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
            }));
            if let Err(payload) = outcome {
                let mut slot = panicked.lock().unwrap_or_else(|e| e.into_inner());
                if slot.is_none() {
                    *slot = Some(payload);
                }
            }
            let (lock, ready) = &*done;
            let mut count = lock.lock().unwrap_or_else(|e| e.into_inner());
            *count += 1;
            if *count >= total {
                ready.notify_all();
            }
        });
        // 池已消失只可能发生在进程退出阶段；此时调用方本来也要返回，忽略即可。
        let _ = shared_pool().sender.send(job);
    }

    let (lock, ready) = &*done;
    let mut count = lock.lock().unwrap_or_else(|e| e.into_inner());
    while *count < total {
        count = ready.wait(count).unwrap_or_else(|e| e.into_inner());
    }
    drop(count);

    if let Some(payload) = panicked.lock().unwrap_or_else(|e| e.into_inner()).take() {
        std::panic::resume_unwind(payload);
    }

    // 用 take 而不是 Arc::try_unwrap：任务闭包持有的 Arc 由工作线程在计数通知
    // **之后**才释放，那里有一个无意义但真实的竞态窗口。
    slots
        .iter()
        .map(|slot| {
            slot.lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .expect("每个下标都必须被填充")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn pixel_cost_is_clamped_and_rounded_up() {
        assert_eq!(pixel_cost(1, 1), 1, "极小图也占 1 个配额");
        assert_eq!(pixel_cost(1536, 1536), 3, "2.36 MP 向上取整为 3");
        assert_eq!(pixel_cost(9000, 9000), 81);
        // 超过总预算的巨图被夹到预算，保证它能独占通过而不是永久等待。
        assert_eq!(pixel_cost(100_000, 100_000), PIXEL_BUDGET_MP);
    }

    #[test]
    fn map_bounded_preserves_order_and_covers_every_index() {
        let items: Vec<u32> = (0..500).collect();
        let out = map_bounded(&items, |_| 1, |v| v * 2);
        assert_eq!(out.len(), items.len());
        for (i, v) in out.iter().enumerate() {
            assert_eq!(*v, i as u32 * 2, "下标 {i} 的结果必须与输入一一对应");
        }
    }

    #[test]
    fn map_bounded_actually_runs_in_parallel() {
        // 16 个各自睡 60ms 的任务：串行需 ~960ms，并行应显著更快。
        // 不断言具体倍数（CI 机器核数不定），只断言"确实重叠执行过"。
        // map_bounded 的任务闭包必须活到 static（跑在常驻线程池里），计数器因此用 Arc。
        let concurrent = std::sync::Arc::new(AtomicU64::new(0));
        let peak = std::sync::Arc::new(AtomicU64::new(0));
        let items: Vec<u32> = (0..16).collect();
        {
            let concurrent = std::sync::Arc::clone(&concurrent);
            let peak = std::sync::Arc::clone(&peak);
            map_bounded(
                &items,
                |_| 1,
                move |_| {
                    let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(60));
                    concurrent.fetch_sub(1, Ordering::SeqCst);
                },
            );
        }
        if worker_count() > 1 {
            assert!(
                peak.load(Ordering::SeqCst) > 1,
                "多核机器上应当有重叠执行（实测峰值 {}）",
                peak.load(Ordering::SeqCst)
            );
        }
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let items: Vec<u32> = Vec::new();
        assert!(map_bounded(&items, |_| 1, |v| *v).is_empty());
    }

    #[test]
    fn big_items_are_serialized_by_budget() {
        // 每项 200 MP（配额被夹到 256），预算 256 → 同时最多 1 项。
        let concurrent = std::sync::Arc::new(AtomicU64::new(0));
        let peak = std::sync::Arc::new(AtomicU64::new(0));
        let items: Vec<u32> = (0..4).collect();
        {
            let concurrent = std::sync::Arc::clone(&concurrent);
            let peak = std::sync::Arc::clone(&peak);
            map_bounded(
                &items,
                |_| pixel_cost(20_000, 10_000),
                move |_| {
                    let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    concurrent.fetch_sub(1, Ordering::SeqCst);
                },
            );
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "超大图必须被预算串行化，否则会 OOM"
        );
    }
}
