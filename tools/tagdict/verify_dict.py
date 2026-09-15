# -*- coding: utf-8 -*-
"""验证生成的 tag_dict.sqlite 数据质量"""
import sqlite3
import sys
import re

sys.stdout.reconfigure(encoding="utf-8")

con = sqlite3.connect(r"E:\Hamster Pouch\tools\tagdict\output\tag_dict.sqlite")

print("== 规模 ==")
print("entries:", con.execute("SELECT COUNT(*) FROM tag_dict_entries").fetchone()[0])
print("translations:", con.execute("SELECT COUNT(*) FROM tag_dict_translations").fetchone()[0])
print("meta:", con.execute("SELECT key, value FROM dict_meta").fetchall())

print("\n== 分类分布 ==")
for row in con.execute(
    "SELECT category, COUNT(*) c FROM tag_dict_entries GROUP BY category ORDER BY c DESC"
):
    print("  ", row)

print("\n== 用户案例：写真 / 照片 / Photo / 摄影 ==")
for q in ["写真", "照片", "Photo", "摄影"]:
    rows = con.execute(
        """SELECT DISTINCT e.source, e.source_key, e.zh, e.popularity, e.category
           FROM tag_dict_entries e
           LEFT JOIN tag_dict_translations t ON t.entry_id = e.id
           WHERE e.zh = ? OR t.value = ?
           ORDER BY e.popularity DESC LIMIT 5""",
        (q, q),
    ).fetchall()
    print(f"  [{q}] -> {rows}")

print("\n== 翻译语言覆盖 ==")
print("  ja:", con.execute("SELECT COUNT(*) FROM tag_dict_translations WHERE lang='ja'").fetchone()[0])
print("  en:", con.execute("SELECT COUNT(*) FROM tag_dict_translations WHERE lang='en'").fetchone()[0])
print("  zh:", con.execute("SELECT COUNT(*) FROM tag_dict_translations WHERE lang='zh'").fetchone()[0])

# 日文覆盖率：pixiv 词条中有日文翻译的比例
n_pix = con.execute("SELECT COUNT(*) FROM tag_dict_entries WHERE source='pixiv'").fetchone()[0]
n_pix_ja = con.execute(
    """SELECT COUNT(DISTINCT e.id) FROM tag_dict_entries e
       JOIN tag_dict_translations t ON t.entry_id = e.id AND t.lang='ja'
       WHERE e.source='pixiv'"""
).fetchone()[0]
n_pix_en = con.execute(
    """SELECT COUNT(DISTINCT e.id) FROM tag_dict_entries e
       JOIN tag_dict_translations t ON t.entry_id = e.id AND t.lang='en'
       WHERE e.source='pixiv'"""
).fetchone()[0]
print(f"\npixiv 词条 {n_pix}：含日文 {n_pix_ja} ({round(n_pix_ja/n_pix*100,1)}%)，含英文 {n_pix_en} ({round(n_pix_en/n_pix*100,1)}%)")

n_dan = con.execute("SELECT COUNT(*) FROM tag_dict_entries WHERE source='danbooru'").fetchone()[0]
n_dan_en = con.execute(
    """SELECT COUNT(DISTINCT e.id) FROM tag_dict_entries e
       JOIN tag_dict_translations t ON t.entry_id = e.id AND t.lang='en'
       WHERE e.source='danbooru'"""
).fetchone()[0]
n_dan_ja = con.execute(
    """SELECT COUNT(DISTINCT e.id) FROM tag_dict_entries e
       JOIN tag_dict_translations t ON t.entry_id = e.id AND t.lang='ja'
       WHERE e.source='danbooru'"""
).fetchone()[0]
print(f"danbooru 词条 {n_dan}：含英文 {n_dan_en} (100%)，含日文 {n_dan_ja} ({round(n_dan_ja/n_dan*100,1)}%)")

print("\n== 质量抽样（pixiv 高热度）==")
for row in con.execute(
    """SELECT e.source_key, e.zh, group_concat(t.lang || ':' || t.value)
       FROM tag_dict_entries e
       JOIN tag_dict_translations t ON t.entry_id = e.id
       WHERE e.source='pixiv' AND e.popularity > 1000000
       GROUP BY e.id ORDER BY e.popularity DESC LIMIT 6"""
):
    print("  ", row)

con.close()
