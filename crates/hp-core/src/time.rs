//! 时间戳文本的唯一来源（D214）。
//!
//! 四张物理库的写入路径、插件安装的 LOCK 文件、AI 输出与桥接层都各自需要「当前时间」的
//! 文本表示。这个表示**必须**只有一份：`created_at` / `updated_at` / `installed_at` /
//! `fetched_at` 是同一批列上的字符串，一旦有人写 RFC 3339（带 `+00:00`）、有人写
//! `YYYY-MM-DD HH:MM:SS`，跨表比较与「按时间排序」就开始出错，而且这种错只有在两个写入者
//! 同时写过同一行时才暴露。
//!
//! 落点选 `hp-core` 而不是 `hp-db`：`hp-db` 带 `rusqlite`，而 `hp-ai` / `hp-album` /
//! `hp-scanner` / `hp-plugin-host` 与桥接层都不依赖 SQLite，却都要生成时间戳。
//! `hp-db::now_iso` 保留为**转调**（既有调用方不动），实现只有这里一处；
//! `tools/check-db-boundary.mjs` 反向断言全仓不再出现 `Rfc3339`。

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// 当前 UTC 时间的 ISO 8601（RFC 3339）文本，例如 `2026-11-15T03:12:45.123456789Z`。
///
/// 格式化本身不会失败（`Rfc3339` 对 `OffsetDateTime` 恒可格式），失败分支返回空串只为
/// 不把「时间戳写不出来」升级成写入失败——数据库列是 `TEXT NOT NULL DEFAULT ''`。
pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::now_iso;

    #[test]
    fn now_iso_is_rfc3339_utc_with_z_suffix() {
        let s = now_iso();
        assert!(s.ends_with('Z'), "应以 Z 结尾（UTC）: {s}");
        assert!(s.len() >= 20, "至少 `YYYY-MM-DDTHH:MM:SSZ` 长度: {s}");
        assert_eq!(s.get(4..5), Some("-"), "年份与月份之间是短横: {s}");
        assert_eq!(s.get(10..11), Some("T"), "日期与时间之间是 T: {s}");
    }
}
