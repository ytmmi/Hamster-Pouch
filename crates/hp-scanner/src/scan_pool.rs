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

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};

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
            available = self.ready.wait(available).unwrap_or_else(|e| e.into_inner());
        }
        *available -= cost;
        Permit {
            budget: self,
            cost,
        }
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

/// 对 `items` 做**保序**的有界并行映射。
///
/// - `cost_of` 给出每项的像素配额（在真正解码前调用，用于限流）；
/// - `f` 是纯计算，**不得访问数据库**（数据库写回由调用方串行完成）；
/// - 返回的 `Vec` 与 `items` **下标一一对应**，因此调用方的进度与计数语义不变。
pub fn map_bounded<T, R, C, F>(items: &[T], cost_of: C, f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    C: Fn(&T) -> u64 + Sync,
    F: Fn(&T) -> R + Sync,
{
    if items.is_empty() {
        return Vec::new();
    }
    let workers = worker_count().min(items.len());
    let budget = Budget::new();
    let next = AtomicUsize::new(0);
    // 结果按下标落位：并行完成顺序与提交顺序无关，但**产出顺序恒定**。
    let slots: Vec<Mutex<Option<R>>> = (0..items.len()).map(|_| Mutex::new(None)).collect();

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    if index >= items.len() {
                        return;
                    }
                    let item = &items[index];
                    // 先按尺寸申请配额，再进入昂贵解码。
                    let _permit = budget.acquire(cost_of(item));
                    let value = f(item);
                    *slots[index].lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
                }
            });
        }
    });

    slots
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .unwrap_or_else(|e| e.into_inner())
                .expect("每个下标都必须被填充")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

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
        let concurrent = AtomicU64::new(0);
        let peak = AtomicU64::new(0);
        let items: Vec<u32> = (0..16).collect();
        map_bounded(
            &items,
            |_| 1,
            |_| {
                let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(60));
                concurrent.fetch_sub(1, Ordering::SeqCst);
            },
        );
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
        let concurrent = AtomicU64::new(0);
        let peak = AtomicU64::new(0);
        let items: Vec<u32> = (0..4).collect();
        map_bounded(
            &items,
            |_| pixel_cost(20_000, 10_000),
            |_| {
                let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(20));
                concurrent.fetch_sub(1, Ordering::SeqCst);
            },
        );
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "超大图必须被预算串行化，否则会 OOM"
        );
    }
}
