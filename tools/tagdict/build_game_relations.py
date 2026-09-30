#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建「关系映射库-游戏」扩展（RFC 0008 库 2 / D34）。

用户要求：**只实现一个语言，软件内用算法匹配多语言**。
因此种子（`data/lib2_games.json`）只写**中文游戏名**与**匹配后缀**；多语言由
`tag_name` 里已有的 zh/ja/en 标准名承担，运行时按语言查名即可。

匹配角色到游戏的**多信号**（按可靠性排序，任一命中即建立关系）：
  1. **danbooru 的 `角色_(作品)` 命名约定**——最可靠，生态标准写法。
     例：`ganyu_(genshin_impact)` → 原神。
  2. **中文括号后缀**——`甘雨（原神）` → 原神（管线已把括号内容留在 `extra_json.suffixes`）。
  3. **已有的 `tag_character.work_tag_id`**——构建期按「无歧义才写」的启发式归属。

输出：一个**完整四库同构 schema** 的扩展库，只含：
  - 目标游戏概念（库 1 `tag` + 库 4 `tag_name` + 库 3 `tag_work`）
  - 匹配到的角色概念（库 1 + 库 4 + 库 3 `tag_character`）
  - 游戏 → 角色的库 2 关系（`hierarchy`，游戏是上级）

用法：
  python build_game_relations.py [--src output/tag_lib.sqlite] [--out output/tag_lib_games.sqlite]
"""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
DDL_PATH = ROOT / "crates" / "hp-store" / "migrations" / "dict_lib" / "0001_init.sql"

# danbooru 角色的 `_(作品)` 后缀
SUFFIX_RE = re.compile(r"_\(([^)]+)\)$")


def norm_key(s: str) -> str:
    """归一化匹配键：小写、下划线/空格统一为空格、去首尾空白。"""
    return re.sub(r"\s+", " ", (s or "").strip().lower().replace("_", " "))


def load_games(path: Path) -> tuple:
    """读取种子：返回 (游戏列表, 角色简称别名表)。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["games"], data.get("character_aliases", {})


def resolve_work(con: sqlite3.Connection, name: str):
    """按中文标准名解析 work 概念 id。"""
    row = con.execute(
        """SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
           WHERE n.value = ? AND t.kind = 'work' ORDER BY t.popularity DESC LIMIT 1""",
        (name,),
    ).fetchone()
    return row[0] if row else None


def build_suffix_index(con: sqlite3.Connection, games: list):
    """后缀（归一化）→ 游戏 work id。"""
    index = {}
    unresolved = []
    for g in games:
        wid = resolve_work(con, g["name"])
        if not wid:
            unresolved.append(g["name"])
            continue
        for suf in g["suffixes"]:
            index[norm_key(suf)] = wid
    return index, unresolved


def collect_characters(con: sqlite3.Connection, suffix_index: dict):
    """多信号匹配角色 → 游戏。返回 {work_id: {char_id: 证据分}}。

    **一个角色可以有多个作品**（用户明确要求）：如「爱丽丝」同时在绝区零与碧蓝档案
    中存在。关系库**只展示关系、不区分作品**——即一个角色节点可以挂多个游戏父级
    （这正是 D34 的**多父级 DAG** 语义）。筛选时由调用方**按作品限定（AND）**收窄，
    而不是在这里替用户选一个唯一归属。

    因此这里**保留全部命中**，不丢弃任何 (角色, 游戏) 对；证据分只用于记录
    「这条关系有多可信」，不用于排除。

    证据强度（高→低）：
      3 = danbooru `_(作品)` 后缀——生态标准写法，最可靠
      2 = 括号后缀（来自别名，如 `甘雨（原神）`）
      1 = 已有 `tag_character.work_tag_id` 启发式归属
    """
    target_works = set(suffix_index.values())
    evidence: dict = defaultdict(int)   # (char_id, work_id) -> 最高证据分

    # 信号 3（最低分）
    for tid, wid in con.execute(
        "SELECT tag_id, work_tag_id FROM tag_character WHERE work_tag_id IS NOT NULL"
    ):
        if wid in target_works:
            evidence[(tid, wid)] = max(evidence[(tid, wid)], 1)

    # 信号 2：括号后缀（在**别名**里，如 `甘雨（原神）`）
    paren = re.compile(r"[（(]([^）)]+)[）)]")
    for tid, value in con.execute(
        """SELECT n.tag_id, n.value FROM tag_name n
           JOIN tag t ON t.id = n.tag_id
           WHERE t.kind = 'character' AND n.lang IN ('zh','ja','en')"""
    ):
        for inner in paren.findall(value or ""):
            wid = suffix_index.get(norm_key(inner))
            if wid:
                evidence[(tid, wid)] = max(evidence[(tid, wid)], 2)

    # 信号 1（最高分）：danbooru `_(作品)` 后缀
    for tid, key in con.execute(
        """SELECT s.tag_id, s.source_key FROM tag_source s
           JOIN tag t ON t.id = s.tag_id
           WHERE s.source = 'danbooru' AND t.kind = 'character'"""
    ):
        m = SUFFIX_RE.search(key or "")
        if not m:
            continue
        wid = suffix_index.get(norm_key(m.group(1)))
        if wid:
            evidence[(tid, wid)] = max(evidence[(tid, wid)], 3)

    # **保留全部命中**（多父级 DAG）；按角色汇总
    hits: dict = defaultdict(dict)
    stats = defaultdict(int)
    multi_parent = 0
    for (tid, wid), score in evidence.items():
        hits[wid][tid] = score
        stats[{3: "danbooru_suffix", 2: "paren_suffix", 1: "work_tag_id"}[score]] += 1

    # 统计多作品角色（**正常现象**，不是错误）
    per_char: dict = defaultdict(set)
    for wid, chars in hits.items():
        for cid in chars:
            per_char[cid].add(wid)
    multi_parent = sum(1 for v in per_char.values() if len(v) > 1)

    return hits, stats, multi_parent


def copy_concept(con_out: sqlite3.Connection, con_in: sqlite3.Connection, tid: str, now: str):
    """把一个概念的 tag / tag_name / tag_source / 库 3 专属行复制到输出库。"""
    row = con_in.execute(
        "SELECT id, kind, nsfw, popularity, extra_json FROM tag WHERE id = ?", (tid,)
    ).fetchone()
    if not row:
        return None
    kind = row[1]
    con_out.execute(
        "INSERT OR IGNORE INTO tag (id, kind, nsfw, popularity, created_at, updated_at, extra_json)"
        " VALUES (?,?,?,?,?,?,?)",
        (row[0], kind, row[2], row[3], now, now, row[4]),
    )
    for n in con_in.execute(
        "SELECT tag_id, lang, value, kind FROM tag_name WHERE tag_id = ?", (tid,)
    ):
        con_out.execute("INSERT OR IGNORE INTO tag_name VALUES (?,?,?,?)", n)
    for s in con_in.execute(
        "SELECT tag_id, source, source_key, popularity, extra_json FROM tag_source WHERE tag_id = ?",
        (tid,),
    ):
        con_out.execute("INSERT OR IGNORE INTO tag_source VALUES (?,?,?,?,?)", s)

    if kind == "work":
        w = con_in.execute(
            "SELECT tag_id, short_name, medium, extra_json FROM tag_work WHERE tag_id = ?", (tid,)
        ).fetchone()
        if w:
            con_out.execute("INSERT OR IGNORE INTO tag_work VALUES (?,?,?,?)", w)
    elif kind == "character":
        c = con_in.execute(
            "SELECT tag_id, work_tag_id, extra_json FROM tag_character WHERE tag_id = ?", (tid,)
        ).fetchone()
        if c:
            con_out.execute("INSERT OR IGNORE INTO tag_character VALUES (?,?,?)", c)
    elif kind == "artist":
        a = con_in.execute(
            "SELECT tag_id, artist_kind, person_name, base_model, extra_json FROM tag_artist WHERE tag_id = ?",
            (tid,),
        ).fetchone()
        if a:
            con_out.execute("INSERT OR IGNORE INTO tag_artist VALUES (?,?,?,?,?)", a)
    return kind


def drop_merged_aggregates(
    con_in: sqlite3.Connection, suffix_index: dict, hits: dict, min_suffixes: int = 6
) -> int:
    """剔除**合并聚合体**：D33 概念合并会把不同作品的同名角色并成一个概念。

    例：纯名 `爱丽丝` 合并了 26 个作品的角色（danbooru 来源含
    `alice_(genshin_impact)` / `aris_(blue_archive)` / `iris_(pokemon)` /
    `alice_(disney)` …）。把它当作「某个角色」挂到作品下是错的——它不是角色，
    是**同名角色的聚合**。

    **判据的两次修正（实测踩到，记录以免回退）**：
      1. 不能数「后缀数」而不看语义：`甘雨` 有 4 个后缀
         （`genshin_impact` / `young` / `twilight_blossom` / `china_merchants_bank`），
         但都是**同一个游戏的形态限定**，按 >=3 判会误剔正常角色。
      2. 只数「映射到本扩展 9 个目标游戏的后缀数」也不够：`爱丽丝` 的 26 个后缀里
         只有 `blue_archive` / `genshin_impact` 命中目标游戏（=2），会被漏掉。

    最终判据：**该角色 danbooru 来源里的 `_(作品)` 后缀总数 >= `min_suffixes`**
    （默认 6）。聚合体必然横跨大量作品，后缀数会远超正常角色（正常角色通常 1-4 个，
    含形态限定）；阈值 6 在实测中把 `甘雨`（4）等正常角色留在库内，把 `爱丽丝`（26）
    这类聚合体剔除。

    返回剔除的角色数。
    """
    pat = re.compile(r"_\(([^)]+)\)")
    dropped = 0
    for wid in list(hits.keys()):
        for cid in list(hits[wid].keys()):
            suffixes = set()
            for key, in con_in.execute(
                "SELECT source_key FROM tag_source WHERE tag_id = ? AND source = 'danbooru'",
                (cid,),
            ):
                suffixes.update(pat.findall(key or ""))
            if len(suffixes) >= min_suffixes:
                del hits[wid][cid]
                dropped += 1
        if not hits[wid]:
            del hits[wid]
    return dropped


def add_short_name_aliases(con_out: sqlite3.Connection, hits: dict, seed_aliases: dict) -> int:
    """给「全名角色」补上**日常简称**别名（用户要求）。

    例：绝区零的 `爱丽丝·泰姆菲尔德` 日常称呼就是「爱丽丝」；蔚蓝档案的
    `天童爱丽丝` 简称也是「爱丽丝」。

    **为什么用别名而不是标准名**：简称天然**有歧义**——「爱丽丝」同时指多个作品的
    不同角色。库 4 的约束是「每 (tag, lang) 至多一个 standard」，所以简称只能进
    `alias`（同一别名可被多个概念共享）。于是：
      - 搜「爱丽丝」→ 命中多个角色（各带自己的作品关系边）；
      - 想精确定位 → 用 AND 按作品限定（用户口径：关系库只展示关系、不区分作品）。

    **因此别名允许与其它概念的标准名重名**——这正是歧义的表达方式，不能拦。

    简称来源：
      1. **种子显式声明**（`character_aliases`）——用于无法自动推断的（如
         `天童爱丽丝` → `爱丽丝`，姓氏无法可靠切分）。
      2. **间隔号前缀**（`爱丽丝·泰姆菲尔德` → `爱丽丝`）——中日文全名的常见写法。

    只补 `alias`，绝不改动/降级任何 `standard`。
    """
    added = 0
    for wid, chars in hits.items():
        for cid in chars:
            existing = {
                (lang, value)
                for lang, value in con_out.execute(
                    "SELECT lang, value FROM tag_name WHERE tag_id = ?", (cid,)
                )
            }
            stds = [
                (lang, value)
                for lang, value in con_out.execute(
                    "SELECT lang, value FROM tag_name WHERE tag_id = ? AND kind = 'standard'",
                    (cid,),
                )
            ]

            candidates: set = set()

            # 来源 1：种子显式声明（按中文标准名匹配）
            for lang, value in stds:
                if lang == "zh":
                    for short in seed_aliases.get(value, []):
                        candidates.add(("zh", short))

            # 来源 2：间隔号前缀
            for lang, value in stds:
                for sep in ("·", "・", "‧"):
                    if sep in value:
                        head = value.split(sep)[0].strip()
                        if len(head) >= 2 and head != value:
                            candidates.add((lang, head))
                        break

            for lang, short in candidates:
                if (lang, short) in existing:
                    continue
                con_out.execute(
                    "INSERT OR IGNORE INTO tag_name (tag_id, lang, value, kind) VALUES (?,?,?,?)",
                    (cid, lang, short, "alias"),
                )
                existing.add((lang, short))
                added += 1
    return added


def main() -> int:
    ap = argparse.ArgumentParser(description="构建关系映射库-游戏扩展")
    ap.add_argument("--src", default=str(HERE / "output" / "tag_lib.sqlite"))
    ap.add_argument("--out", default=str(HERE / "output" / "tag_lib_games.sqlite"))
    ap.add_argument("--seed", default=str(HERE / "data" / "lib2_games.json"))
    args = ap.parse_args()

    src, out, seed = Path(args.src), Path(args.out), Path(args.seed)
    if not src.is_file():
        print(f"[game-relations] 源库不存在: {src}")
        print("  请先运行: python tools/tagdict/build_tag_lib.py")
        return 1

    games, seed_aliases = load_games(seed)
    con_in = sqlite3.connect(str(src))
    suffix_index, unresolved = build_suffix_index(con_in, games)
    # 游戏名 → work 概念 id（写库与打印共用）
    work_ids = {g["name"]: resolve_work(con_in, g["name"]) for g in games}

    print(f"游戏种子 {len(games)} 个：解析到 work 概念 {len(set(suffix_index.values()))} 个")
    if unresolved:
        print(f"  ⚠ 未解析到 work 概念（跳过）: {unresolved}")

    hits, stats, multi_parent = collect_characters(con_in, suffix_index)
    total_pairs = sum(len(v) for v in hits.values())
    print(f"匹配信号命中：danbooru 后缀 {stats['danbooru_suffix']} / "
          f"括号后缀 {stats['paren_suffix']} / work_tag_id {stats['work_tag_id']}")
    print(f"多作品角色（正常，D34 多父级 DAG）: {multi_parent} 个")
    print(f"去重后 游戏→角色 关系：{total_pairs} 条")

    # 剔除合并聚合体（同名角色被 D33 并成一个概念，不是真角色）
    dropped = drop_merged_aggregates(con_in, suffix_index, hits)
    if dropped:
        print(f"剔除合并聚合体（来源含 >=6 个作品后缀）: {dropped} 个")
        print(f"  剩余关系：{sum(len(v) for v in hits.values())} 条")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if out.exists():
        out.unlink()
    out.parent.mkdir(parents=True, exist_ok=True)
    con_out = sqlite3.connect(str(out))
    con_out.execute("PRAGMA journal_mode=MEMORY")
    con_out.executescript(DDL_PATH.read_text(encoding="utf-8"))

    # 写入游戏概念
    for g in games:
        wid = resolve_work(con_in, g["name"])
        if wid:
            copy_concept(con_out, con_in, wid, now)

    # 写入角色概念 + 关系
    rel_rows = []
    per_game = {}
    for wid, chars in sorted(hits.items()):
        per_game[wid] = len(chars)
        for cid in sorted(chars):
            copy_concept(con_out, con_in, cid, now)
            # 关系：游戏(hierarchy 上级) → 角色。
            # 一个角色可有多个游戏父级（多作品角色，D34 多父级 DAG）——**刻意保留**。
            rid = "rel-" + hashlib.sha1(f"{wid}\x1f{cid}".encode()).hexdigest()[:16]
            rel_rows.append((rid, wid, cid, "hierarchy", now))

    con_out.executemany("INSERT OR IGNORE INTO tag_relation VALUES (?,?,?,?,?)", rel_rows)

    # 清空指向**本包外概念**的 `tag_character.work_tag_id`（悬空外键）。
    # 本包是独立扩展，只含目标游戏与其角色；原值指向的 work（该角色的其它作品）
    # 不在本包内，会构成悬空外键（实测 8 条）。归属已由关系边承担，清空不丢信息。
    # 另：**不**把多作品角色的 work_tag_id 改写成某个游戏——单值字段装不下多作品。
    con_out.execute(
        """UPDATE tag_character SET work_tag_id = NULL
           WHERE work_tag_id IS NOT NULL
             AND work_tag_id NOT IN (SELECT id FROM tag)"""
    )

    # 补日常简称别名（用户要求）：全名角色 → 简称（如 爱丽丝·泰姆菲尔德 → 爱丽丝）。
    # 简称允许与其它概念的标准名重名（歧义由 AND 筛选解决），故在关系写完后统一补。
    alias_added = add_short_name_aliases(con_out, hits, seed_aliases)
    if alias_added:
        print(f"补充日常简称别名：{alias_added} 条")

    # 注意：**不**改写 `tag_character.work_tag_id`。
    # 该字段是「归属原作」的单值字段，而多作品角色没有唯一原作；关系库的作品归属
    # 由 `tag_relation` 的多条边表达（用户口径：关系库只展示关系、不区分作品，
    # 筛选时按作品 AND 收窄）。把多作品角色硬写成一个 work 反而会丢信息。

    # 元信息
    counts = {
        "tag": con_out.execute("SELECT COUNT(*) FROM tag").fetchone()[0],
        "tag_name": con_out.execute("SELECT COUNT(*) FROM tag_name").fetchone()[0],
        "tag_source": con_out.execute("SELECT COUNT(*) FROM tag_source").fetchone()[0],
        "tag_relation": con_out.execute("SELECT COUNT(*) FROM tag_relation").fetchone()[0],
        "tag_work": con_out.execute("SELECT COUNT(*) FROM tag_work").fetchone()[0],
        "tag_character": con_out.execute("SELECT COUNT(*) FROM tag_character").fetchone()[0],
        "games": len(set(suffix_index.values())),
        "unresolved_games": unresolved,
    }
    con_out.executemany(
        "INSERT INTO lib_meta (key, value) VALUES (?,?)",
        [
            ("source", "extension"),
            ("slice", "games"),
            ("version", datetime.now(timezone.utc).strftime("%Y.%m.%d")),
            ("generated_at", now),
            ("derived_from", str(src)),
            ("counts", json.dumps(counts, ensure_ascii=False)),
            ("match_signals", json.dumps(
                {"danbooru_suffix": stats["danbooru_suffix"],
                 "paren_suffix": stats["paren_suffix"],
                 "work_tag_id": stats["work_tag_id"],
                 "multi_parent_characters": multi_parent,
                 "short_name_aliases": alias_added,
                 "merged_aggregates_dropped": dropped}, ensure_ascii=False)),
        ],
    )
    con_out.commit()
    con_out.execute("PRAGMA journal_mode=DELETE")
    con_out.execute("VACUUM")
    con_out.execute("ANALYZE")
    con_out.close()
    con_in.close()

    print("\n=== 生成完成 ===")
    for k in ("tag", "tag_name", "tag_source", "tag_relation", "tag_work", "tag_character"):
        print(f"  {k:16s}: {counts[k]}")
    print(f"  输出文件        : {out}  ({out.stat().st_size / 1024 / 1024:.2f} MB)")
    print("\n  各游戏角色数：")
    for g in games:
        wid = work_ids.get(g["name"])
        if wid:
            print(f"    {g['name']:16s} {per_game.get(wid, 0)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
