#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建内置 tag 词库（RFC 0006 数据管线）。

> ⚠️ **已被取代（RFC 0008 / D33-D37）**：本脚本产出的是 **RFC 0006 旧 schema**
> （`tag_dict_entries` 以原始生态 tag 为锚、中文可重复、artist 整体排除），
> 仅供旧 `TagDictDb` 回退路径使用。**当前实现请用 `build_tag_lib.py`**
> （四库 schema、概念为锚、纳入 artist 全量、三语对等）。
> 保留本脚本只为 RFC 0008「`tag_dict.sqlite` 保留作对照与回退」这条约定。

输入（ffdkj 每日更新对照表，MIT 许可）：
  data/danbooru_tags.sqlite  - tags(name, category, cn_name, post_count)，328K+ 条
  data/pixiv_tags.sqlite     - pixiv_tags(name, cn_name, en_name, posts, categories)，169K+ 条

输出：
  output/tag_dict.sqlite     - 内置词库（表结构对齐 hp-store migrations/dict/0001_init.sql）

步骤：
  1. 读取 pixiv 全量词条
  2. 读取 danbooru 词条并过滤（category IN (0,3,4) 且 post_count >= 100）
  3. 中文交叉融合：以 cn_name 为桥——pixiv 词条英文缺口用 danbooru 补全，
     danbooru 词条日文缺口用 pixiv 补全
  4. 分类归一化：pixiv categories 文本 / danbooru category ID -> 统一五类
  5. 写入词库（词条 + 翻译 + dict_meta），UTF-8 全量导入

用法：
  python build_tag_dict.py [--data-dir data] [--output output/tag_dict.sqlite]
"""

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone

# ---------- 常量 ----------

# danbooru 过滤：只收 general/copyright/character 三类（artist/meta 延后，RFC 0006 第 3 节）
DANB_CATEGORIES = {0, 3, 4}
DANB_MIN_POSTS = 100
DANB_CAT_MAP = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}

# pixiv categories（逗号分隔多值）-> 归一化（按优先级取首个可映射类别）
PIXIV_CAT_RULES = [
    ("artist", {"Artist"}),
    ("character", {"Character", "Person"}),
    ("copyright", {"Game", "Anime", "Manga", "Novel", "Music", "Doujin", "Vocaloid"}),
]
PIXIV_DEFAULT_CAT = "general"

# 日文判定：含假名即视为日文（pixiv name 为日文或英文原始标签）
KANA_RE = re.compile(r"[\u3040-\u30ff]")

# 词库 DDL：与 crates/hp-store/migrations/dict/0001_init.sql 保持一致
DDL = """
CREATE TABLE IF NOT EXISTS dict_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tag_dict_entries (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  source_key TEXT NOT NULL,
  zh         TEXT NOT NULL,
  category   TEXT NOT NULL,
  popularity INTEGER,
  nsfw       INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_dict_entries_zh ON tag_dict_entries(zh);
CREATE INDEX IF NOT EXISTS idx_dict_entries_popularity ON tag_dict_entries(popularity DESC);
CREATE TABLE IF NOT EXISTS tag_dict_translations (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,
  value    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'alt',
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX IF NOT EXISTS idx_dict_translations_entry ON tag_dict_translations(entry_id);
CREATE INDEX IF NOT EXISTS idx_dict_translations_value ON tag_dict_translations(lang, value);
CREATE TABLE IF NOT EXISTS tag_dict_aliases (
  entry_id TEXT NOT NULL,
  lang     TEXT NOT NULL,
  value    TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES tag_dict_entries(id)
);
CREATE INDEX IF NOT EXISTS idx_dict_aliases_value ON tag_dict_aliases(lang, value);
"""


# ---------- 归一化 ----------

def norm_cat_pixiv(cats: str) -> str:
    """pixiv categories（逗号分隔）-> 归一化分类。"""
    if not cats:
        return PIXIV_DEFAULT_CAT
    parts = [p.strip() for p in cats.split(",") if p.strip()]
    for cat, keywords in PIXIV_CAT_RULES:
        if any(p in keywords for p in parts):
            return cat
    return PIXIV_DEFAULT_CAT


def is_japanese(s: str) -> bool:
    return bool(KANA_RE.search(s))


# ---------- 读取与融合 ----------

def load_pixiv(path: str):
    """读取 pixiv 表，返回词条列表与 cn_name 索引。"""
    con = sqlite3.connect(path)
    rows = con.execute("SELECT name, cn_name, en_name, posts, categories FROM pixiv_tags").fetchall()
    con.close()
    entries = []
    by_cn = defaultdict(list)  # cn_name -> [(name, posts)]
    for name, cn, en, posts, cats in rows:
        entries.append(
            {
                "source": "pixiv",
                "source_key": name,
                "zh": cn,
                "category": norm_cat_pixiv(cats),
                "popularity": posts,
                "extra": {"raw_categories": cats, "posts": posts, "en_name": en},
            }
        )
        by_cn[cn].append((name, posts or 0))
    return entries, by_cn


def load_danbooru(path: str):
    """读取 danbooru 表并按范围过滤，返回词条列表与 cn_name 索引。"""
    con = sqlite3.connect(path)
    rows = con.execute(
        "SELECT name, category, cn_name, post_count FROM tags"
    ).fetchall()
    con.close()
    entries = []
    by_cn = defaultdict(list)  # cn_name -> [(name, post_count)]
    for name, cat_id, cn, pc in rows:
        if cat_id not in DANB_CATEGORIES:
            continue
        if (pc or 0) < DANB_MIN_POSTS:
            continue
        entries.append(
            {
                "source": "danbooru",
                "source_key": name,
                "zh": cn,
                "category": DANB_CAT_MAP.get(cat_id, "general"),
                "popularity": pc,
                "extra": {"raw_category_id": cat_id, "post_count": pc},
            }
        )
        by_cn[cn].append((name, pc or 0))
    return entries, by_cn


def build_translations(pix_entry, d_by_cn, p_by_cn):
    """生成 pixiv 词条的翻译行：ja（日文 name）/ en（en_name 或 danbooru 补全）。"""
    name = pix_entry["source_key"]
    cn = pix_entry["zh"]
    en_name = pix_entry["extra"].get("en_name")
    trans = []

    if is_japanese(name) or not name.isascii():
        # 日文/非 ASCII name（pixiv 原始 tag 以日文为主，含纯汉字如"漫画""写真"；
        # 中文用户 tag 属少数，zh 主词仍是首要检索字段，误判影响可接受）
        trans.append(("ja", name, "primary"))
        en = en_name if en_name else best_en_from_danbooru(cn, d_by_cn)
        if en:
            trans.append(("en", en, "primary" if en == en_name else "alt"))
    else:
        # 纯英文/ASCII name
        trans.append(("en", name, "primary"))
        if en_name and en_name != name:
            trans.append(("en", en_name, "alt"))

    # danbooru 侧若有同名英文（不同下划线写法）也并入 alt
    d_names = [n for n, _ in d_by_cn.get(cn, [])]
    existing = {v for _, v, _ in trans}
    for n in d_names:
        norm = n.lower().replace("_", " ")
        if norm not in {v.lower().replace("_", " ") for v in existing} and n not in existing:
            trans.append(("en", n, "alt"))
            existing.add(n)
    return trans


def best_en_from_danbooru(cn: str, d_by_cn) -> str | None:
    """取 danbooru 同中文名下 post_count 最高的英文 tag。"""
    cands = d_by_cn.get(cn)
    if not cands:
        return None
    return max(cands, key=lambda x: x[1])[0]


def ja_from_pixiv(cn: str, p_by_cn) -> str | None:
    """取 pixiv 同中文名下 posts 最高的日文 tag。"""
    cands = p_by_cn.get(cn)
    if not cands:
        return None
    ja = [n for n, _ in cands if is_japanese(n)]
    if not ja:
        return None
    best = max([c for c in cands if c[0] in ja], key=lambda x: x[1])
    return best[0]


# ---------- 写入 ----------

def write_dict(out_path: str, pix_entries, dan_entries, pix_by_cn, dan_by_cn, meta):
    import os

    parent = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(parent, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    con = sqlite3.connect(out_path)
    con.executescript(DDL)
    con.execute("DELETE FROM tag_dict_aliases")
    con.execute("DELETE FROM tag_dict_translations")
    con.execute("DELETE FROM tag_dict_entries")

    # 词条 + 翻译
    total_en_filled = 0
    total_ja_filled = 0
    entry_rows = []
    trans_rows = []
    eid = 0

    def entry_id(prefix: str) -> str:
        nonlocal eid
        eid += 1
        return f"{prefix}-{eid:07d}"

    for e in pix_entries:
        eid_s = entry_id("p")
        trans = build_translations(e, dan_by_cn, pix_by_cn)
        had_en = bool(e["extra"].get("en_name"))
        if not had_en and any(t[0] == "en" for t in trans):
            total_en_filled += 1
        entry_rows.append(
            (
                eid_s, e["source"], e["source_key"], e["zh"], e["category"],
                e["popularity"], 0, json.dumps(e["extra"], ensure_ascii=False), now,
            )
        )
        for lang, val, kind in trans:
            trans_rows.append((eid_s, lang, val, kind))

    for e in dan_entries:
        eid_s = entry_id("d")
        cn = e["zh"]
        en_name = e["source_key"]
        trans = [("en", en_name, "primary")]
        ja = ja_from_pixiv(cn, pix_by_cn)
        if ja:
            trans.append(("ja", ja, "alt"))
            total_ja_filled += 1
        entry_rows.append(
            (
                eid_s, e["source"], e["source_key"], e["zh"], e["category"],
                e["popularity"], 0, json.dumps(e["extra"], ensure_ascii=False), now,
            )
        )
        for lang, val, kind in trans:
            trans_rows.append((eid_s, lang, val, kind))

    con.executemany(
        "INSERT INTO tag_dict_entries "
        "(id, source, source_key, zh, category, popularity, nsfw, extra_json, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        entry_rows,
    )
    con.executemany(
        "INSERT INTO tag_dict_translations (entry_id, lang, value, kind) VALUES (?,?,?,?)",
        trans_rows,
    )

    # dict_meta
    meta_rows = [
        ("version", meta["version"]),
        ("generated_at", now),
        ("sources", json.dumps(meta["sources"], ensure_ascii=False)),
        ("counts", json.dumps(meta["counts"], ensure_ascii=False)),
    ]
    con.executemany(
        "INSERT INTO dict_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        meta_rows,
    )
    con.commit()
    con.close()
    return len(entry_rows), len(trans_rows), total_en_filled, total_ja_filled


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description="构建内置 tag 词库（RFC 0006）")
    ap.add_argument("--data-dir", default="data", help="对照表缓存目录")
    ap.add_argument("--output", default="output/tag_dict.sqlite", help="词库输出路径")
    args = ap.parse_args()

    dan_path = f"{args.data_dir}/danbooru_tags.sqlite"
    pix_path = f"{args.data_dir}/pixiv_tags.sqlite"

    print("读取 danbooru 对照表 ...")
    dan_entries, dan_by_cn = load_danbooru(dan_path)
    print(f"  danbooru 过滤后词条: {len(dan_entries)}（category IN (0,3,4) 且 post_count>={DANB_MIN_POSTS}）")

    print("读取 pixiv 对照表 ...")
    pix_entries, pix_by_cn = load_pixiv(pix_path)
    print(f"  pixiv 词条: {len(pix_entries)}")

    print("写入词库 ...")
    n_entry, n_trans, en_filled, ja_filled = write_dict(
        args.output,
        pix_entries,
        dan_entries,
        pix_by_cn,
        dan_by_cn,
        meta={
            "version": datetime.now(timezone.utc).strftime("%Y.%m.%d"),
            "sources": {
                "pixiv": pix_path,
                "danbooru": dan_path,
            },
            "counts": {},
        },
    )

    # 补 counts 后回写
    con = sqlite3.connect(args.output)
    counts = {
        "pixiv_entries": sum(1 for e in pix_entries),
        "danbooru_entries": len(dan_entries),
        "total_entries": n_entry,
        "total_translations": n_trans,
        "en_filled_from_danbooru": en_filled,
        "ja_filled_from_pixiv": ja_filled,
    }
    con.execute(
        "UPDATE dict_meta SET value=? WHERE key='counts'",
        (json.dumps(counts, ensure_ascii=False),),
    )
    con.commit()
    con.close()

    print("\n=== 生成完成 ===")
    print(f"词条总数   : {n_entry}（pixiv {counts['pixiv_entries']} + danbooru {counts['danbooru_entries']}）")
    print(f"翻译行数   : {n_trans}")
    print(f"英文补全   : {en_filled}（pixiv 英文缺口经 danbooru 中文交叉命中补全）")
    print(f"日文补全   : {ja_filled}（danbooru 词条经 pixiv 补日文）")
    print(f"输出文件   : {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
