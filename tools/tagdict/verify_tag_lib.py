#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 tag 四库产物（RFC 0008 验收条款）。

核对：
  1. 用户示例四语（碧蓝档案/蔚蓝档案/ブルーアーカイブ/ブルアカ/BlueArchive/BA）命中同一 tag；
  2. 库 2 用户示例两棵树完整往返（父子关系可从库 2 种子还原）；
  3. D37 每 (tag, lang) 至多一个 standard；
  4. 库 3 三张专属表与 tag.kind 一致；
  5. 库 2 与仓库级 tag_relations 不混用（表名与文件均独立）；
  6. 外键完整性（除刻意置空外）。

用法：
  python verify_tag_lib.py [--base output/tag_lib_base.sqlite3] [--ext output/tag_lib.sqlite]
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).parent

FAIL = []


def check(cond, label, detail=""):
    mark = "PASS" if cond else "FAIL"
    if not cond:
        FAIL.append(label)
    print(f"  [{mark}] {label}" + (f" — {detail}" if detail else ""))
    return cond


def resolve_all(con, value):
    """按名称（任意语言、任意 kind）解析命中的 tag_id 集合。"""
    return {r[0] for r in con.execute("SELECT tag_id FROM tag_name WHERE value = ?", (value,))}


def verify_file(path: Path, label: str, expect_kinds=None):
    print(f"\n=== {label}: {path.name} ({path.stat().st_size / 1024 / 1024:.2f} MB) ===")
    con = sqlite3.connect(str(path))
    con.execute("PRAGMA foreign_keys=ON")

    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for t in ("tag", "tag_source", "tag_name", "tag_relation", "tag_work",
              "tag_character", "tag_artist", "lib_meta"):
        check(t in tables, f"表存在: {t}")

    # 外键完整性
    fk_errs = con.execute("PRAGMA foreign_key_check").fetchall()
    check(not fk_errs, "外键完整性 (foreign_key_check 无违规)", f"{len(fk_errs)} 条" if fk_errs else "")

    # D37：每 (tag_id, lang) 至多一个 standard
    dup = con.execute(
        """SELECT tag_id, lang, COUNT(*) c FROM tag_name WHERE kind='standard'
           GROUP BY tag_id, lang HAVING c > 1 LIMIT 5"""
    ).fetchall()
    check(not dup, "D37: 每 (tag, lang) 至多一个 standard", str(dup) if dup else "")

    # 库 3 专属表与 kind 一致
    for tbl, kind in (("tag_artist", "artist"), ("tag_character", "character"), ("tag_work", "work")):
        bad = con.execute(
            f"""SELECT COUNT(*) FROM {tbl} x JOIN tag t ON t.id = x.tag_id WHERE t.kind <> ?""",
            (kind,),
        ).fetchone()[0]
        check(bad == 0, f"库 3: {tbl} 全部指向 kind={kind}", f"{bad} 条越界" if bad else "")

    # 库 2 关系自环
    self_loop = con.execute("SELECT COUNT(*) FROM tag_relation WHERE from_tag_id = to_tag_id").fetchone()[0]
    check(self_loop == 0, "库 2: 无自环关系", f"{self_loop} 条" if self_loop else "")

    # 库 2 与仓库级 tag_relations 表名不冲突
    check("tag_relations" not in tables, "库 2 与仓库级 tag_relations 表名不混用（本库无 tag_relations）")

    counts = {k: con.execute(f"SELECT COUNT(*) FROM {k}").fetchone()[0]
              for k in ("tag", "tag_source", "tag_name", "tag_relation")}
    print(f"  规模: {counts}")
    print(f"  kind 分布: {dict(con.execute('SELECT kind, COUNT(*) FROM tag GROUP BY kind ORDER BY 2 DESC'))}")
    return con


def verify_user_example(con, label, strict=True):
    """核对用户示例（RFC 0008 D37）。

    strict=True（全量库/基底库）：要求六种写法**全部**命中同一 work 概念。
    strict=False（按来源切分的细分包）：单个包只含一个生态来源，不可能覆盖全部写法，
    因此只报告覆盖率，并要求**能命中的写法收敛到同一个 work 概念**。
    """
    print(f"\n=== 用户示例验收（{label}）===")
    groups = {
        "碧蓝档案(zh)": "碧蓝档案",
        "蔚蓝档案(zh)": "蔚蓝档案",
        "ブルーアーカイブ(ja)": "ブルーアーカイブ",
        "ブルアカ(ja)": "ブルアカ",
        "BlueArchive(en)": "BlueArchive",
        "Blue Archive(en)": "Blue Archive",
    }
    hits = {k: resolve_all(con, v) for k, v in groups.items()}
    for k, v in hits.items():
        kinds = []
        for tid in sorted(v)[:3]:
            row = con.execute("SELECT kind FROM tag WHERE id=?", (tid,)).fetchone()
            kinds.append(f"{tid}:{row[0] if row else '?'}")
        print(f"    {k:24s} -> {len(v):3d} 个 tag  {kinds}")

    # 在所有命中的概念里找 work 锚点
    work_ids = set()
    for v in hits.values():
        for tid in v:
            row = con.execute("SELECT kind FROM tag WHERE id=?", (tid,)).fetchone()
            if row and row[0] == "work":
                work_ids.add(tid)

    if strict:
        target = next(iter(work_ids), None)
        ok = target is not None and all(target in v for v in hits.values())
        check(ok, f"六种写法全部命中同一 work 概念 {target}")
    else:
        # 细分包：要求能命中的写法都指向**同一个** work 概念（不允许分裂成多个）
        if not work_ids:
            print("    (本细分包未覆盖该示例的 work 概念)")
            return
        ok = len(work_ids) == 1
        check(ok, f"本包内命中的写法收敛到单一 work 概念 {sorted(work_ids)}")

    target = next(iter(work_ids), None)
    if target:
        names = con.execute(
            "SELECT lang, value, kind FROM tag_name WHERE tag_id=? ORDER BY lang, kind", (target,)
        ).fetchall()
        std = {lang: v for lang, v, k in names if k == "standard"}
        print(f"    标准名: {std}")
        check("zh" in std and "ja" in std and "en" in std, "该概念 zh/ja/en 三语标准名齐备")
        srcs = con.execute("SELECT source, source_key FROM tag_source WHERE tag_id=?", (target,)).fetchall()
        print(f"    生态来源 {len(srcs)} 条: {sorted(srcs)}")


def verify_lib2_tree(con, seed_path: Path, label):
    print(f"\n=== 库 2 关系树往返验收（{label}）===")
    data = json.loads(seed_path.read_text(encoding="utf-8"))
    total, ok_cnt, missing = 0, 0, []

    def walk(node, parent_name=None):
        nonlocal total, ok_cnt
        name, kind = node["name"], node.get("kind", "general")
        row = con.execute(
            """SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id=t.id
               WHERE n.value=? AND t.kind=? LIMIT 1""", (name, kind)).fetchone()
        if row is None:
            missing.append(f"{name}({kind})")
            for ch in node.get("children", []):
                walk(ch, name)
            return
        tid = row[0]
        if parent_name is not None:
            total += 1
            prow = con.execute(
                """SELECT t.id FROM tag t JOIN tag_name n ON n.tag_id=t.id
                   WHERE n.value=? AND t.kind=? LIMIT 1""", (parent_name, "general")).fetchone()
            # 父节点 kind 需按种子实际解析，这里用关系反查更可靠
            has = con.execute(
                """SELECT COUNT(*) FROM tag_relation r
                   JOIN tag_name pn ON pn.tag_id = r.from_tag_id
                   WHERE r.to_tag_id=? AND pn.value=? AND r.relation_kind='hierarchy'""",
                (tid, parent_name)).fetchone()[0]
            if has:
                ok_cnt += 1
            else:
                missing.append(f"{parent_name} -> {name}")
        for ch in node.get("children", []):
            walk(ch, name)

    for tree in data["tree"]:
        walk(tree)

    check(total > 0 and ok_cnt == total, f"库 2 父子关系全部往返 ({ok_cnt}/{total})",
          f"缺失: {missing}" if missing else "")

    rels = con.execute(
        """SELECT pn.value, cn.value FROM tag_relation r
           JOIN tag_name pn ON pn.tag_id=r.from_tag_id AND pn.lang='zh' AND pn.kind='standard'
           JOIN tag_name cn ON cn.tag_id=r.to_tag_id AND cn.lang='zh' AND cn.kind='standard'
           WHERE r.relation_kind='hierarchy' ORDER BY pn.value, cn.value"""
    ).fetchall()
    n_rel = con.execute("SELECT COUNT(*) FROM tag_relation WHERE relation_kind='hierarchy'").fetchone()[0]
    print(f"    库 2 hierarchy 关系 {n_rel} 条（下列按 zh 标准名展开）：")
    for p, c in rels:
        print(f"      {p} -> {c}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=str(HERE / "output" / "tag_lib_base.sqlite3"))
    ap.add_argument("--ext", default=str(HERE / "output" / "tag_lib.sqlite"))
    ap.add_argument("--split-dir", default=str(HERE / "output" / "split"))
    ap.add_argument("--seed", default=str(HERE / "data" / "lib2_relations.json"))
    args = ap.parse_args()

    ext = Path(args.ext)
    base = Path(args.base)

    con_ext = None
    if ext.exists():
        con_ext = verify_file(ext, "全量四库（构建中间产物）")
        verify_user_example(con_ext, "全量库", strict=True)

    # 细分扩展包（plugins-dist 的源）
    split_dir = Path(args.split_dir)
    if split_dir.is_dir():
        for db in sorted(split_dir.glob("tag_lib_*.sqlite")):
            con = verify_file(db, f"细分扩展包（{db.stem}）")
            verify_user_example(con, db.stem, strict=False)
            con.close()

    con_base = None
    if base.exists():
        con_base = verify_file(base, "内置基底库（DB-1）")
        verify_user_example(con_base, "基底库", strict=True)
        verify_lib2_tree(con_base, Path(args.seed), "基底库")

    print("\n" + "=" * 60)
    if FAIL:
        print(f"结果：{len(FAIL)} 项失败")
        for f in FAIL:
            print(f"  - {f}")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
