#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""裁剪内置基底 tag 词库：从完整词库取 Top-N 词条 + 全部翻译。

> ⚠️ **已被取代（RFC 0008 / D33-D37）**：本脚本产出的是 **RFC 0006 旧 schema**
> （`tag_dict_entries` 以原始生态 tag 为锚），仅供旧 `TagDictDb` 回退路径使用。
> **当前实现请用 `build_base_lib.py`**（四库 schema，概念为锚 + 按 kind 配额 + 库 2 关系种子）。
> 保留本脚本只为 RFC 0008「`tag_dict.sqlite` 保留作对照与回退」这条约定。

输出：
  output/tag_dict_base.sqlite3 - 内置基底词库（数 MB）

策略：
  - 从完整词库按 popularity 降序取 Top 5000
  - 携完整翻译行
"""

import sqlite3
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "output" / "tag_dict.sqlite"
OUT = ROOT / "output" / "tag_dict_base.sqlite3"
LIMIT = 5000

def build():
    if not SRC.exists():
        print(f"[build_base_dict] 源词库不存在: {SRC}")
        return

    si = sqlite3.connect(str(SRC))
    si.row_factory = sqlite3.Row
    so = sqlite3.connect(str(OUT))
    so.execute("PRAGMA journal_mode=WAL")
    so.executescript("""
        CREATE TABLE IF NOT EXISTS dict_meta (
          key   TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tag_dict_entries (
          id TEXT PRIMARY KEY, source TEXT NOT NULL,
          source_key TEXT NOT NULL, zh TEXT NOT NULL,
          category TEXT NOT NULL, popularity INTEGER,
          nsfw INTEGER NOT NULL DEFAULT 0,
          extra_json TEXT, created_at TEXT NOT NULL,
          UNIQUE (source, source_key)
        );
        CREATE INDEX IF NOT EXISTS idx_entries_zh ON tag_dict_entries(zh);
        CREATE TABLE IF NOT EXISTS tag_dict_translations (
          entry_id TEXT NOT NULL, lang TEXT NOT NULL,
          value TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'alt',
          FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
        );
        CREATE INDEX IF NOT EXISTS idx_translations_entry ON tag_dict_translations(entry_id);
    """)

    print(f"[build_base_dict] 正在取 Top {LIMIT} 词条...")
    ids = [r["id"] for r in si.execute(
        "SELECT id FROM tag_dict_entries ORDER BY popularity DESC LIMIT ?", (LIMIT,)
    )]

    so.execute("BEGIN")
    for eid in ids:
        e = si.execute("SELECT * FROM tag_dict_entries WHERE id=?", (eid,)).fetchone()
        so.execute(
            "INSERT INTO tag_dict_entries VALUES (?,?,?,?,?,?,?,?,?)",
            (e["id"], e["source"], e["source_key"], e["zh"],
             e["category"], e["popularity"], e["nsfw"],
             e["extra_json"], e["created_at"])
        )
        for t in si.execute("SELECT * FROM tag_dict_translations WHERE entry_id=?", (eid,)):
            so.execute(
                "INSERT INTO tag_dict_translations VALUES (?,?,?,?)",
                (t["entry_id"], t["lang"], t["value"], t["kind"])
            )
    so.execute("COMMIT")

    ec = so.execute("SELECT COUNT(*) FROM tag_dict_entries").fetchone()[0]
    tc = so.execute("SELECT COUNT(*) FROM tag_dict_translations").fetchone()[0]
    mb = OUT.stat().st_size / 1024 / 1024
    print(f"[build_base_dict] 完成: {ec} 词条 / {tc} 翻译行 / {mb:.1f} MB -> {OUT}")

if __name__ == "__main__":
    build()
