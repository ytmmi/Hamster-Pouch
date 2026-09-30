#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建内置基底 tag 库（RFC 0008 / D36 第一层）。

输入：
  output/tag_lib.sqlite            - 扩展词库全量（build_tag_lib.py 产物）
  data/lib2_relations.json         - 库 2 关系人工内置种子（VOCALOID / 风格示例树）

输出：
  output/tag_lib_base.sqlite3      - 内置基底库（随应用分发，目标数 MB 内）

策略（D36）：
  - **按 kind 配额**取 Top-N 概念，而不是全局 Top-N：artist 全量有 15 万，
    全局排序会让基底被 artist/character 占满，通用词反而进不来。
  - **库 2 种子节点及其全部祖先/后代强制纳入**（即使热度低），否则内置关系树
    会指向基底库中不存在的 tag（外键失败）。
  - 库 2 种子中在扩展库**不存在**的节点（如 `赛璐珞`）以 `source=manual` 新建概念，
    保证用户示例树完整往返。
  - 只搬运被选中概念的 `tag_name` / `tag_source` / 库 3 专属行。

用法：
  python build_base_lib.py [--src output/tag_lib.sqlite] [--out output/tag_lib_base.sqlite3]
"""

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DDL_PATH = ROOT / "crates" / "hp-store" / "migrations" / "dict_lib" / "0001_init.sql"
HERE = Path(__file__).parent

# 每个 kind 的基底配额（D36「基础中文标准名、常用分类、默认关系」，目标数 MB 内）
QUOTA = {
    "general": 3000,
    "character": 3000,
    "work": 1500,
    "artist": 600,
    "meta": 200,
    "unknown": 0,
}


def manual_tag_id(kind: str, zh: str) -> str:
    h = hashlib.sha1(f"{kind}\x1f{zh}".encode("utf-8")).hexdigest()
    return f"tag-{h[:16]}"


def load_seed_nodes(path: Path) -> list:
    """展平库 2 种子树，返回 [(name, kind, aliases)]。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []

    def walk(node):
        out.append((node["name"], node.get("kind", "general"), node.get("aliases", [])))
        for ch in node.get("children", []):
            walk(ch)

    for tree in data["tree"]:
        walk(tree)
    return out


def resolve(con: sqlite3.Connection, name: str, kind: str):
    """在扩展库中按 (名称, kind) 解析概念 id；未命中返回 None。"""
    row = con.execute(
        """SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id = t.id
           WHERE n.value = ? AND t.kind = ?
           ORDER BY t.popularity DESC LIMIT 1""",
        (name, kind),
    ).fetchone()
    return row[0] if row else None


def main() -> int:
    ap = argparse.ArgumentParser(description="构建内置基底 tag 库（RFC 0008 D36）")
    ap.add_argument("--src", default=str(HERE / "output" / "tag_lib.sqlite"))
    ap.add_argument("--out", default=str(HERE / "output" / "tag_lib_base.sqlite3"))
    ap.add_argument("--seed", default=str(HERE / "data" / "lib2_relations.json"))
    args = ap.parse_args()

    src, out, seed_path = Path(args.src), Path(args.out), Path(args.seed)
    if not src.exists():
        print(f"[build_base_lib] 源扩展库不存在: {src}")
        print("  请先运行: python tools/tagdict/build_tag_lib.py")
        return 1

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    si = sqlite3.connect(str(src))

    # ---- 1) 选取概念 id 集合 ----
    picked = set()
    for kind, quota in QUOTA.items():
        if quota <= 0:
            continue
        for (tid,) in si.execute(
            "SELECT id FROM tag WHERE kind = ? ORDER BY popularity DESC LIMIT ?", (kind, quota)
        ):
            picked.add(tid)

    # 库 2 种子节点强制纳入（先解析，未命中的登记为 manual 新建）
    seed_nodes = load_seed_nodes(seed_path)
    manual_new = {}          # (kind, name) -> tag_id
    seed_resolved = {}       # (name, kind) -> tag_id
    for name, kind, _aliases in seed_nodes:
        tid = resolve(si, name, kind)
        if tid:
            seed_resolved[(name, kind)] = tid
            picked.add(tid)
        else:
            tid = manual_tag_id(kind, name)
            manual_new[(kind, name)] = tid
            seed_resolved[(name, kind)] = tid
            picked.add(tid)

    print(f"基底概念: 配额选取 + 库 2 种子强制纳入 = {len(picked)} 个")
    print(f"  其中库 2 种子命中扩展库: {len(seed_resolved) - len(manual_new)}")
    print(f"  其中库 2 种子新建 manual: {len(manual_new)} -> {sorted(n for _, n in manual_new)}")

    # ---- 2) 打开目标库 ----
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    so = sqlite3.connect(str(out))
    so.execute("PRAGMA journal_mode=MEMORY")
    so.executescript(DDL_PATH.read_text(encoding="utf-8"))

    ids = sorted(picked)
    qmarks = ",".join("?" * len(ids))

    # ---- 3) 搬运四库行 ----
    for row in si.execute(
        f"SELECT id,kind,nsfw,popularity,created_at,updated_at,extra_json FROM tag WHERE id IN ({qmarks})",
        ids,
    ):
        so.execute("INSERT INTO tag VALUES (?,?,?,?,?,?,?)", row)

    for row in si.execute(
        f"SELECT tag_id,source,source_key,popularity,extra_json FROM tag_source WHERE tag_id IN ({qmarks})",
        ids,
    ):
        so.execute("INSERT INTO tag_source VALUES (?,?,?,?,?)", row)

    for row in si.execute(
        f"SELECT tag_id,lang,value,kind FROM tag_name WHERE tag_id IN ({qmarks})", ids
    ):
        so.execute("INSERT INTO tag_name VALUES (?,?,?,?)", row)

    for tbl, cols in (
        ("tag_artist", "tag_id,artist_kind,person_name,base_model,extra_json"),
        ("tag_character", "tag_id,work_tag_id,extra_json"),
        ("tag_work", "tag_id,short_name,medium,extra_json"),
    ):
        for row in si.execute(f"SELECT {cols} FROM {tbl} WHERE tag_id IN ({qmarks})", ids):
            # tag_character.work_tag_id 可能指向未被选中的原作 -> 置空（外键约束）
            if tbl == "tag_character" and row[1] is not None and row[1] not in picked:
                row = (row[0], None, row[2])
            so.execute(f"INSERT INTO {tbl} VALUES ({','.join('?' * len(row))})", row)

    # ---- 4) 新建缺失的库 2 种子概念 ----
    for (kind, name), tid in manual_new.items():
        so.execute(
            "INSERT INTO tag (id,kind,nsfw,popularity,created_at,updated_at,extra_json) VALUES (?,?,?,?,?,?,?)",
            (tid, kind, 0, 0, now, now, json.dumps({"origin": "lib2_seed_manual"}, ensure_ascii=False)),
        )
        so.execute(
            "INSERT INTO tag_name (tag_id,lang,value,kind) VALUES (?,?,?,?)",
            (tid, "zh", name, "standard"),
        )
        so.execute(
            "INSERT INTO tag_source (tag_id,source,source_key,popularity,extra_json) VALUES (?,?,?,?,?)",
            (tid, "manual", name, 0, json.dumps({"origin": "lib2_seed"}, ensure_ascii=False)),
        )
        if kind == "general":
            pass  # general 无专属表
        elif kind == "work":
            so.execute("INSERT INTO tag_work VALUES (?,?,?,?)", (tid, None, None, None))
        elif kind == "character":
            so.execute("INSERT INTO tag_character VALUES (?,?,?)", (tid, None, None))
        elif kind == "artist":
            so.execute("INSERT INTO tag_artist VALUES (?,?,?,?,?)", (tid, "human", name, None, None))

    # ---- 5) 人工补充别名（种子里的 aliases，如 平涂->薄涂）----
    for name, kind, aliases in seed_nodes:
        tid = seed_resolved.get((name, kind))
        if not tid:
            continue
        for alias in aliases:
            so.execute(
                "INSERT OR IGNORE INTO tag_name (tag_id,lang,value,kind) VALUES (?,?,?,?)",
                (tid, "zh", alias, "alias"),
            )

    # ---- 6) 库 2 关系：种子树展开为 tag_relation（hierarchy）----
    data = json.loads(seed_path.read_text(encoding="utf-8"))
    rel_rows = []

    def emit(parent_id, node):
        child_id = seed_resolved.get((node["name"], node.get("kind", "general")))
        if parent_id and child_id and parent_id != child_id:
            rid = "rel-" + hashlib.sha1(f"{parent_id}\x1f{child_id}".encode()).hexdigest()[:16]
            rel_rows.append((rid, parent_id, child_id, "hierarchy", now))
        for ch in node.get("children", []):
            emit(child_id, ch)

    for tree in data["tree"]:
        emit(None, tree)

    so.executemany("INSERT OR IGNORE INTO tag_relation VALUES (?,?,?,?,?)", rel_rows)

    # ---- 7) 元信息 ----
    counts = {
        "tag": so.execute("SELECT COUNT(*) FROM tag").fetchone()[0],
        "tag_source": so.execute("SELECT COUNT(*) FROM tag_source").fetchone()[0],
        "tag_name": so.execute("SELECT COUNT(*) FROM tag_name").fetchone()[0],
        "tag_relation": so.execute("SELECT COUNT(*) FROM tag_relation").fetchone()[0],
        "tag_artist": so.execute("SELECT COUNT(*) FROM tag_artist").fetchone()[0],
        "tag_character": so.execute("SELECT COUNT(*) FROM tag_character").fetchone()[0],
        "tag_work": so.execute("SELECT COUNT(*) FROM tag_work").fetchone()[0],
        "lib2_seed_manual": len(manual_new),
    }
    so.executemany(
        "INSERT INTO lib_meta (key,value) VALUES (?,?)",
        [
            ("source", "base"),
            ("version", datetime.now(timezone.utc).strftime("%Y.%m.%d")),
            ("generated_at", now),
            ("derived_from", str(src)),
            ("counts", json.dumps(counts, ensure_ascii=False)),
            ("quota", json.dumps(QUOTA, ensure_ascii=False)),
            ("lib2_seed", str(seed_path)),
        ],
    )
    so.commit()
    so.execute("PRAGMA journal_mode=DELETE")
    so.execute("VACUUM")
    so.execute("ANALYZE")
    so.close()
    si.close()

    mb = out.stat().st_size / 1024 / 1024
    print("\n=== 基底库生成完成 ===")
    for k, v in counts.items():
        print(f"  {k:18s}: {v}")
    print(f"  输出文件           : {out}  ({mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
