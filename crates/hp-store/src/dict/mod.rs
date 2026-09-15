//! tag 词库（独立 SQLite 文件，应用级共享）：连接/迁移 + 多语言查询（RFC 0006）。

mod dict_db;

pub use dict_db::TagDictDb;
