#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建 tag 四库扩展包（RFC 0008 / D33-D37）。

输入（ffdkj 每日更新对照表，MIT 许可）：
  data/danbooru_tags.sqlite  - tags(name, category, cn_name, post_count)
  data/pixiv_tags.sqlite     - pixiv_tags(name, cn_name, en_name, posts, categories)

输出：
  output/tag_lib.sqlite      - 四库全量（schema 取自 migrations/dict_lib/0001_init.sql）

与旧管线（build_tag_dict.py，RFC 0006）的差别：
  1. **实体锚点由「原始生态 tag」改为「概念」**（D33）：一条 `tag` 记录 = 一个概念，
     生态写法（pixiv / danbooru name）作来源证据挂 `tag_source`。
  2. **纳入 artist 全量**（D35）：旧管线 `DANB_CATEGORIES = {0,3,4}` 整体丢弃 category=1。
  3. **中文标准名进入 `tag_name`**（`lang='zh', kind='standard'`），实现三语对等（D37）；
     旧管线 `tag_dict_translations` 的 zh 行数为 0。
  4. **别名真正落表**（旧 `tag_dict_aliases` 为 0 行）。
  5. **分类专属字段**：`tag_artist` / `tag_character` / `tag_work`（D35）。

概念合并（D33）：
  - **以 kind 为第一分区键**（中文主词跨 kind 出现时不得合并）；
  - 分区内按 **zh 归一 → en 归一 → ja 归一** 级联合并（并查集）；
  - zh 归一 = 去括号后缀（实测 47.6% 的中文名带 `（VOCALOID）` 这类后缀），
    括号内容保留为别名；被去掉的后缀同时用于推断角色的归属原作。

用法：
  python build_tag_lib.py [--data-dir data] [--output output/tag_lib.sqlite]
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

ROOT = Path(__file__).resolve().parents[2]
DDL_PATH = ROOT / "crates" / "hp-store" / "migrations" / "dict_lib" / "0001_init.sql"

# ---------- 常量 ----------

# danbooru category ID -> kind（RFC 0008 数据模型：artist|work|character|general|meta）
DANB_KIND = {0: "general", 1: "artist", 3: "work", 4: "character", 5: "meta"}
# 纳入范围：general/work/character 取 post_count>=100；artist **全量**（D35 已确认不做热度过滤）
DANB_THRESHOLD_KINDS = (0, 3, 4)
DANB_MIN_POSTS = 100
# meta 不纳入（RFC 0008 规模口径 374,729 = pixiv 169,438 + danbooru 53,194 + artist 152,097）

# pixiv categories（逗号分隔多值）-> kind。实测 pixiv 侧**不存在** Artist 类别（0 行），
# 规则仍保留以备数据源补齐；艺术家的唯一来源是 danbooru。
PIXIV_KIND_RULES = [
    ("artist", {"Artist"}),
    ("character", {"Character", "Person"}),
    ("work", {"Game", "Anime", "Manga", "Novel", "Music", "Doujin", "Vocaloid"}),
]
PIXIV_DEFAULT_KIND = "general"

# 作品介质（tag_work.medium），取自 pixiv categories 词表
MEDIUM_MAP = {
    "Game": "game", "Anime": "anime", "Manga": "manga", "Novel": "novel",
    "Music": "music", "Doujin": "doujin", "Vocaloid": "vocaloid",
    "Figure": "figure", "Event": "event", "Quote": "quote",
    "Design": "design", "Art": "art",
}

KANA_RE = re.compile(r"[\u3040-\u30ff]")
# 汉字（含中日共用区）：用于区分「中文写法」与「英文写法」
HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
# 括号后缀：全角（）与半角 ()
PAREN_RE = re.compile(r"[（(][^）)]*[）)]")
# 括号内内容
PAREN_INNER_RE = re.compile(r"[（(]([^）)]*)[）)]")
NSFW_RE = re.compile(r"r-?18|18禁|nsfw|\bero\b|成人|r18g", re.I)

# AI 绘画模型基座识别（D35：AI 创作记绘画模型名并精确到基座）。
# 保守策略：只有命中已知基座族才标 ai_model，否则一律 human——误判比漏判代价高。
AI_MODEL_PATTERNS = [
    ("stable_diffusion", ("stable_diffusion", "stable-diffusion", "sdxl", "sd1.5", "sd15", "sd_1_5", "sd3")),
    ("novelai", ("novelai", "nai3", "nai_3")),
    ("midjourney", ("midjourney", "niji")),
    ("dall_e", ("dall_e", "dall-e", "dalle")),
    ("pony", ("pony_diffusion", "ponydiffusion", "pony_v6")),
    ("illustrious", ("illustrious", "noobai", "noob_ai")),
    ("flux", ("flux",)),
]


# ---------- 归一化 ----------

def norm_zh(s: str) -> str:
    """中文标准名的合并键：去括号后缀 + 去首尾空白。"""
    return PAREN_RE.sub("", s or "").strip()


def paren_suffixes(s: str) -> list:
    """取出括号内的后缀（用于推断角色归属原作）。"""
    return [m.strip() for m in PAREN_INNER_RE.findall(s or "") if m.strip()]


def norm_en(s: str) -> str:
    """英文合并键：小写 + 下划线归一为空格（`blue_archive` == `Blue Archive`）。"""
    return re.sub(r"\s+", " ", (s or "").strip().lower().replace("_", " "))


def norm_ja(s: str) -> str:
    return (s or "").strip()


def is_japanese(s: str) -> bool:
    return bool(KANA_RE.search(s or ""))


def pixiv_kind(cats: str) -> str:
    parts = [p.strip() for p in (cats or "").split(",") if p.strip()]
    for kind, keywords in PIXIV_KIND_RULES:
        if any(p in keywords for p in parts):
            return kind
    return PIXIV_DEFAULT_KIND


def pixiv_medium(cats: str):
    parts = [p.strip() for p in (cats or "").split(",") if p.strip()]
    for p in parts:
        if p in MEDIUM_MAP:
            return MEDIUM_MAP[p]
    return None


def detect_ai_base(*values: str):
    """返回命中的 AI 基座名，未命中返回 None。"""
    joined = " ".join(v or "" for v in values).lower()
    for base, keys in AI_MODEL_PATTERNS:
        if any(k in joined for k in keys):
            return base
    return None


def tag_id_of(kind: str, zh_norm: str) -> str:
    """由 (kind, 中文归一) 派生稳定 ID（跨重建确定，便于聚合层与用户库引用）。"""
    h = hashlib.sha1(f"{kind}\x1f{zh_norm}".encode("utf-8")).hexdigest()
    return f"tag-{h[:16]}"


# ---------- 并查集 ----------

class DSU:
    def __init__(self, n: int):
        self.p = list(range(n))

    def find(self, x: int) -> int:
        p = self.p
        while p[x] != x:
            p[x] = p[p[x]]
            x = p[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


# ---------- 读取 ----------

def load_danbooru(path: Path) -> list:
    con = sqlite3.connect(str(path))
    rows = []
    sql = (
        "SELECT name, category, cn_name, post_count FROM tags "
        f"WHERE (category IN {DANB_THRESHOLD_KINDS} AND post_count >= ?) OR category = 1"
    )
    for name, cat_id, cn, pc in con.execute(sql, (DANB_MIN_POSTS,)):
        kind = DANB_KIND.get(cat_id)
        if kind is None or kind == "meta":
            continue
        rows.append({
            "source": "danbooru",
            "source_key": name,
            "zh": cn or "",
            "kind": kind,
            "pop": pc or 0,
            # danbooru 的 name 即生态标准英文写法
            "ens": [name] if name else [],
            "jas": [],
            "zhs": [],
            "medium": None,
            "raw": json.dumps({"category_id": cat_id, "post_count": pc or 0}, ensure_ascii=False),
        })
    con.close()
    return rows


def load_pixiv(path: Path) -> list:
    con = sqlite3.connect(str(path))
    rows = []
    for name, cn, en, posts, cats in con.execute(
        "SELECT name, cn_name, en_name, posts, categories FROM pixiv_tags"
    ):
        ens, jas, zhs = [], [], []
        if is_japanese(name):
            jas.append(name)
            if en:
                ens.append(en)
        elif HAN_RE.search(name or ""):
            # 汉字名（如 `碧蓝档案` / `蔚藍檔案`）：pixiv 生态里这类是**中文写法**，
            # 不是英文。误判为 en 会让它错过 known 集合，进而被当作括号后缀别名
            # 泛滥登记（实测 41 个概念）。此处记入 zhs 作中文别名。
            zhs.append(name)
            if en:
                ens.append(en)
        else:
            if name:
                ens.append(name)
            if en and en != name:
                ens.append(en)
        rows.append({
            "source": "pixiv",
            "source_key": name,
            "zh": cn or "",
            "kind": pixiv_kind(cats),
            "pop": posts or 0,
            "ens": ens,
            "jas": jas,
            "zhs": zhs,
            "medium": pixiv_medium(cats),
            "raw": json.dumps({"categories": cats, "posts": posts or 0, "en_name": en}, ensure_ascii=False),
        })
    con.close()
    return rows


# ---------- 概念合并（D33） ----------

def merge_concepts(rows: list) -> list:
    """按 kind 分区，分区内 zh→en→ja 级联合并，返回概念列表。"""
    dsu = DSU(len(rows))

    by_kind = defaultdict(list)
    for i, r in enumerate(rows):
        by_kind[r["kind"]].append(i)

    for kind, idxs in by_kind.items():
        # 第 1 级：中文标准名（归一后）一致
        buckets = defaultdict(list)
        for i in idxs:
            k = norm_zh(rows[i]["zh"])
            if k:
                buckets[k].append(i)
        for group in buckets.values():
            for j in group[1:]:
                dsu.union(group[0], j)

        # 第 2 级：英文标准名一致
        buckets = defaultdict(list)
        for i in idxs:
            for v in rows[i]["ens"]:
                k = norm_en(v)
                if k:
                    buckets[k].append(i)
        for group in buckets.values():
            for j in group[1:]:
                dsu.union(group[0], j)

        # 第 3 级：日文标准名一致
        buckets = defaultdict(list)
        for i in idxs:
            for v in rows[i]["jas"]:
                k = norm_ja(v)
                if k:
                    buckets[k].append(i)
        for group in buckets.values():
            for j in group[1:]:
                dsu.union(group[0], j)

    groups = defaultdict(list)
    for i in range(len(rows)):
        groups[dsu.find(i)].append(i)

    concepts = []
    for members in groups.values():
        concepts.append(_build_concept([rows[i] for i in members]))
    concepts.sort(key=lambda c: (-(c["popularity"] or 0), c["id"]))

    _add_suffix_aliases(concepts)
    return concepts


def _add_suffix_aliases(concepts: list) -> None:
    """把括号后缀有条件地登记为 zh 别名（用户决策：括号内容保留为别名，不丢信息）。

    但后缀常常是**跨概念的限定符**而非别名：`茶会（蔚蓝档案）` 的后缀是作品名
    `蔚蓝档案`，若无条件登记为别名，检索「蔚蓝档案」会命中 900+ 个无关角色概念
    （实测）。因此仅当后缀**不与任何既有概念名重合**时才登记为别名；重合者只保留在
    `extra_json.suffixes`，仍可用于归属原作推断，信息不丢。
    """
    # 全局已知名称集合：**所有语言**的标准名与写法。
    # 必须跨语言收集：后缀 `ブルーアーカイブ` 是某 work 概念的 ja 标准名，
    # 若只收集 zh 名就会把它当"新别名"登记到 100+ 个角色概念上（实测）。
    known = set()
    for c in concepts:
        for _, _lang, val, _ in c["names"]:
            known.add(val)
            known.add(norm_zh(val))
            known.add(norm_en(val))
            known.add(norm_ja(val))

    added = 0
    for c in concepts:
        if not c["suffixes"]:
            continue
        existing = {val for _, lang, val, _ in c["names"] if lang == "zh"}
        for suf in c["suffixes"]:
            if suf in known or suf in existing:
                continue  # 是别的概念的名字（或已存在），只留在 extra_json
            c["names"].append((c["id"], "zh", suf, "alias"))
            existing.add(suf)
            added += 1
    if added:
        print(f"  括号后缀登记为 zh 别名: {added} 条（不与既有概念名重合者）")


def _pick_standard(candidates: list):
    """从 [(值, 热度)] 里选标准名：热度最高者优先；同热度取较短者（更接近通用写法）。"""
    if not candidates:
        return None
    return sorted(candidates, key=lambda t: (-(t[1] or 0), len(t[0]), t[0]))[0][0]


def _build_concept(members: list) -> dict:
    kind = members[0]["kind"]
    popularity = max((m["pop"] or 0) for m in members)

    # 中文：归一形式作标准名；原始写法（含括号版）与括号内容作别名
    zh_norms = defaultdict(int)
    zh_raws = defaultdict(int)
    zh_inner = defaultdict(int)
    for m in members:
        n = norm_zh(m["zh"])
        if n:
            zh_norms[n] = max(zh_norms[n], m["pop"] or 0)
            zh_raws[m["zh"]] = max(zh_raws[m["zh"]], m["pop"] or 0)
        for s in paren_suffixes(m["zh"]):
            zh_inner[s] = max(zh_inner[s], m["pop"] or 0)
    zh_std = _pick_standard(list(zh_norms.items()))

    ens, jas = defaultdict(int), defaultdict(int)
    zh_alt = defaultdict(int)   # 汉字写法（来自 pixiv name 等），作 zh 别名
    for m in members:
        for v in m["ens"]:
            if v:
                ens[v] = max(ens[v], m["pop"] or 0)
        for v in m["jas"]:
            if v:
                jas[v] = max(jas[v], m["pop"] or 0)
        for v in m.get("zhs", ()):
            if v:
                zh_alt[v] = max(zh_alt[v], m["pop"] or 0)

    # ID 以分区内最小 zh 归一为基准，保证同输入重建得到同 ID
    id_key = min(zh_norms) if zh_norms else f"~{norm_en(' '.join(sorted(ens))) or members[0]['source_key']}"
    tid = tag_id_of(kind, id_key)

    # 来源去重（同一生态 tag 只能挂一个概念）
    sources = {}
    for m in members:
        sources[(m["source"], m["source_key"])] = {
            "tag_id": tid, "source": m["source"], "source_key": m["source_key"],
            "popularity": m["pop"], "extra_json": m["raw"],
        }

    # 库 4：tag_name
    # 注意：括号后缀（`茶会（蔚蓝档案）` 的 `蔚蓝档案`）是**消歧限定符**，不是别名。
    # 若把它登记为 tag_name 别名，检索「蔚蓝档案」会命中 900+ 个无关角色概念
    # （实测），因此后缀只用于推断归属原作（work_tag_id），**不进 tag_name**。
    # 原始全名（含括号）本身是合法的别名形式，保留。
    names = []
    if zh_std:
        names.append((tid, "zh", zh_std, "standard"))
    for v in zh_raws:
        if v != zh_std:
            names.append((tid, "zh", v, "alias"))
    for v in zh_alt:
        if v != zh_std:
            names.append((tid, "zh", v, "alias"))
    ja_std = _pick_standard(list(jas.items()))
    if ja_std:
        names.append((tid, "ja", ja_std, "standard"))
    for v in jas:
        if v != ja_std:
            names.append((tid, "ja", v, "alias"))
    en_std = _pick_standard(list(ens.items()))
    if en_std:
        names.append((tid, "en", en_std, "standard"))
    for v in ens:
        if v != en_std:
            names.append((tid, "en", v, "alias"))

    # 同 (tag, lang, value) 去重；standard 优先于 alias
    seen = {}
    for t, lang, val, k in names:
        key = (t, lang, val)
        if key not in seen or k == "standard":
            seen[key] = (t, lang, val, k)
    names = list(seen.values())

    mediums = [m["medium"] for m in members if m.get("medium")]
    nsfw = 1 if any(NSFW_RE.search(m["zh"] or "") or NSFW_RE.search(m["source_key"] or "") for m in members) else 0

    return {
        "id": tid,
        "kind": kind,
        "nsfw": nsfw,
        "popularity": popularity,
        "names": names,
        "sources": list(sources.values()),
        "medium": mediums[0] if mediums else None,
        "zh_std": zh_std,
        # 归一后的中文变体数（>1 = 经 en/ja 级联合并而来）
        "zh_norm_variants": len(zh_norms),
        # 原始中文写法数（>1 = 括号归一或跨源异名合并而来）
        "zh_raw_variants": len(zh_raws),
        # 括号后缀，用于推断角色归属原作
        "suffixes": sorted(zh_inner.keys(), key=lambda s: -zh_inner[s]),
        "extra": json.dumps({
            "sources": sorted({m["source"] for m in members}),
            "zh_norm_variants": len(zh_norms),
            "zh_raw_variants": len(zh_raws),
        }, ensure_ascii=False),
    }


# ---------- 归属原作推断（同名角色靠 IP 识别，D35） ----------

def resolve_character_works(concepts: list) -> dict:
    """用中文名的括号后缀推断 `tag_character.work_tag_id`（D35「同名角色靠 IP 识别」）。

    例：`初音未来（VOCALOID）` 的括号后缀 `VOCALOID` 命中同库的 work 概念 → 建立归属。
    这是无外部实体源（Bangumi 未验证）时的可用信号。

    **仅在无歧义时归属**：一个概念可能合并了多个作品的角色（如 `爱丽丝` 合并了
    45 个不同作品的角色，因为 danbooru 的 cn_name 都是「爱丽丝」）。此时多个后缀会
    解析出**不同**的 work，强行取第一个会给出错误归属。因此：
      - 解析出的 work 唯一 → 写入 `work_tag_id`；
      - 多个不同 work → 留空，候选记入 `extra_json.work_candidates` 供人工/后续补全。
    返回统计字典。
    """
    work_index = {}
    for c in concepts:
        if c["kind"] != "work":
            continue
        for _, lang, val, _ in c["names"]:
            for key in (norm_zh(val), norm_en(val), norm_ja(val)):
                if key:
                    work_index.setdefault((lang, key), c["id"])
            # 不分语言的兜底键（后缀可能跨语言命中）
            for key in (norm_zh(val), norm_en(val), norm_ja(val)):
                if key:
                    work_index.setdefault(("*", key), c["id"])

    stats = {"unique": 0, "ambiguous": 0, "none": 0}
    for c in concepts:
        if c["kind"] != "character":
            c["work_tag_id"] = None
            continue

        hits = []
        for suf in c["suffixes"]:
            hit = (
                work_index.get(("zh", norm_zh(suf)))
                or work_index.get(("ja", norm_ja(suf)))
                or work_index.get(("en", norm_en(suf)))
                or work_index.get(("*", norm_zh(suf)))
                or work_index.get(("*", norm_en(suf)))
            )
            if hit and hit != c["id"] and hit not in hits:
                hits.append(hit)

        if len(hits) == 1:
            c["work_tag_id"] = hits[0]
            stats["unique"] += 1
        else:
            c["work_tag_id"] = None
            if hits:
                stats["ambiguous"] += 1
                # 保留候选，信息不丢（供人工校正或后续接 Bangumi 补全）
                extra = json.loads(c["extra"])
                extra["work_candidates"] = hits[:16]
                c["extra"] = json.dumps(extra, ensure_ascii=False)
            else:
                stats["none"] += 1
    return stats


# ---------- 写入 ----------

def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(str(path))
    con.execute("PRAGMA journal_mode=MEMORY")
    con.execute("PRAGMA synchronous=OFF")
    con.executescript(DDL_PATH.read_text(encoding="utf-8"))
    return con


def write_concepts(con: sqlite3.Connection, concepts: list, now: str) -> dict:
    tag_rows, src_rows, name_rows = [], [], []
    artist_rows, char_rows, work_rows = [], [], []

    for c in concepts:
        tag_rows.append((c["id"], c["kind"], c["nsfw"], c["popularity"], now, now, c["extra"]))
        for s in c["sources"]:
            src_rows.append((s["tag_id"], s["source"], s["source_key"], s["popularity"], s["extra_json"]))
        name_rows.extend(c["names"])

        if c["kind"] == "artist":
            base = detect_ai_base(c["zh_std"] or "", *(s["source_key"] for s in c["sources"]))
            if base:
                artist_rows.append((c["id"], "ai_model", None, base, json.dumps({"confidence": "heuristic"}, ensure_ascii=False)))
            else:
                artist_rows.append((c["id"], "human", c["zh_std"], None, None))
        elif c["kind"] == "character":
            char_rows.append((c["id"], c.get("work_tag_id"), None))
        elif c["kind"] == "work":
            work_rows.append((c["id"], None, c["medium"], None))

    con.executemany(
        "INSERT INTO tag (id, kind, nsfw, popularity, created_at, updated_at, extra_json) VALUES (?,?,?,?,?,?,?)",
        tag_rows,
    )
    con.executemany(
        "INSERT INTO tag_source (tag_id, source, source_key, popularity, extra_json) VALUES (?,?,?,?,?)",
        src_rows,
    )
    con.executemany(
        "INSERT INTO tag_name (tag_id, lang, value, kind) VALUES (?,?,?,?)",
        name_rows,
    )
    con.executemany(
        "INSERT INTO tag_artist (tag_id, artist_kind, person_name, base_model, extra_json) VALUES (?,?,?,?,?)",
        artist_rows,
    )
    con.executemany(
        "INSERT INTO tag_character (tag_id, work_tag_id, extra_json) VALUES (?,?,?)",
        char_rows,
    )
    con.executemany(
        "INSERT INTO tag_work (tag_id, short_name, medium, extra_json) VALUES (?,?,?,?)",
        work_rows,
    )
    con.commit()

    return {
        "tag": len(tag_rows), "tag_source": len(src_rows), "tag_name": len(name_rows),
        "tag_artist": len(artist_rows), "tag_character": len(char_rows), "tag_work": len(work_rows),
    }


def write_split(concepts: list, out_dir: Path, now: str) -> dict:
    """按生态来源切分为多个细分扩展包（用户决策：扩展可有多个，对应多个细分）。

    每个包是**完整四库同构 schema**，只装该来源的概念。跨源概念（两源都有）在两个包中
    各出现一次——聚合层已允许同一概念多层出现（D36「用户库 > 扩展包 > 内置基底」优先级），
    因此这是刻意行为而非重复。
    """
    # 概念 -> 其来源集合
    by_source = defaultdict(list)
    for c in concepts:
        srcs = {s["source"] for s in c["sources"]}
        for src in srcs:
            by_source[src].append(c)

    out_dir.mkdir(parents=True, exist_ok=True)
    by_id = {c["id"]: c for c in concepts}
    results = {}
    for src, items in sorted(by_source.items()):
        # 只保留该来源的行；名称/专属表按概念整体搬运（多语言映射是概念级的）
        selected = {c["id"]: c for c in items}

        # **依赖闭包**：角色的 work_tag_id 可能指向另一来源包里的原作概念。
        # 若不把它一并纳入，本包 tag_character.work_tag_id 就是悬空外键
        # （实测 pixiv 包 2291 条 / danbooru 包 1060 条）。被拉入的原作概念只保留
        # tag / tag_name / tag_source / tag_work，标记 dependency=true 以便聚合层识别。
        added = 0
        for c in list(selected.values()):
            if c["kind"] != "character":
                continue
            wid = c.get("work_tag_id")
            if wid and wid not in selected and wid in by_id:
                wc = dict(by_id[wid])
                wc["dependency"] = True
                selected[wid] = wc
                added += 1

        filtered = []
        for c in selected.values():
            cc = dict(c)
            # 只保留本来源的行；依赖概念可能没有本来源行，则保留其全部行
            own = [s for s in c["sources"] if s["source"] == src]
            cc["sources"] = own if own else c["sources"]
            if cc.get("dependency"):
                extra = json.loads(cc["extra"])
                extra["dependency"] = True
                cc["extra"] = json.dumps(extra, ensure_ascii=False)
            filtered.append(cc)

        path = out_dir / f"tag_lib_{src}.sqlite"
        con = open_db(path)
        counts = write_concepts(con, filtered, now)
        kind_dist = dict(con.execute("SELECT kind, COUNT(*) FROM tag GROUP BY kind ORDER BY 2 DESC"))
        con.executemany(
            "INSERT INTO lib_meta (key, value) VALUES (?,?)",
            [
                ("source", "extension"),
                ("slice", src),
                ("version", datetime.now(timezone.utc).strftime("%Y.%m.%d")),
                ("generated_at", now),
                ("counts", json.dumps(counts, ensure_ascii=False)),
                ("kind_dist", json.dumps(kind_dist, ensure_ascii=False)),
                ("dependency_concepts", str(added)),
            ],
        )
        con.commit()
        con.execute("PRAGMA journal_mode=DELETE")
        con.execute("VACUUM")
        con.execute("ANALYZE")
        con.close()
        results[src] = {"path": str(path), "counts": counts, "kind_dist": kind_dist,
                        "mb": path.stat().st_size / 1024 / 1024, "dependency": added}
        print(f"  [{src}] {counts['tag']} 概念（含依赖原作 {added}）/ {counts['tag_name']} 名称 / "
              f"{results[src]['mb']:.1f} MB -> {path.name}")
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 tag 四库扩展包（RFC 0008）")
    ap.add_argument("--data-dir", default=str(Path(__file__).parent / "data"))
    ap.add_argument("--output", default=str(Path(__file__).parent / "output" / "tag_lib.sqlite"))
    ap.add_argument("--limit", type=int, default=0, help="仅取前 N 行做冒烟测试（0=全量）")
    ap.add_argument("--split-by-source", action="store_true",
                    help="按生态来源切分为多个细分扩展包（输出到 --split-dir）")
    ap.add_argument("--split-dir", default=str(Path(__file__).parent / "output" / "split"))
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    out_path = Path(args.output)

    print("读取 danbooru 对照表 ...")
    dan = load_danbooru(data_dir / "danbooru_tags.sqlite")
    print(f"  danbooru 行: {len(dan)}（general/work/character post_count>={DANB_MIN_POSTS} + artist 全量）")

    print("读取 pixiv 对照表 ...")
    pix = load_pixiv(data_dir / "pixiv_tags.sqlite")
    print(f"  pixiv 行: {len(pix)}")

    rows = dan + pix
    if args.limit:
        rows = rows[: args.limit]
        print(f"  [冒烟] 截断为 {len(rows)} 行")

    print("概念合并（kind 分区 + zh→en→ja 级联）...")
    concepts = merge_concepts(rows)
    print(f"  原始来源行 {len(rows)} -> 概念 {len(concepts)}（收敛 {len(rows) - len(concepts)}）")

    multi_zh = sum(1 for c in concepts if c["zh_raw_variants"] > 1)
    merged_zh = sum(1 for c in concepts if c["zh_norm_variants"] > 1)
    print(f"  同一概念内多种中文写法: {multi_zh}（括号归一/跨源异名合并）")
    print(f"  经 en/ja 级联并入的概念: {merged_zh}")

    stats = resolve_character_works(concepts)
    n_char = sum(1 for c in concepts if c["kind"] == "character")
    print(f"  角色归属原作（无歧义才写）: {stats['unique']} / {n_char}"
          f"（多义留空 {stats['ambiguous']}，无信号 {stats['none']}）")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if args.split_by_source:
        print(f"\n按生态来源切分为细分扩展包 -> {args.split_dir}")
        results = write_split(concepts, Path(args.split_dir), now)
        print("\n=== 生成完成（细分扩展包）===")
        for src, r in results.items():
            print(f"  tag_lib_{src}.sqlite: {r['counts']['tag']} 概念 / "
                  f"{r['counts']['tag_name']} 名称 / {r['mb']:.1f} MB")
            print(f"    kind 分布: {r['kind_dist']}")
        return 0

    con = open_db(out_path)
    counts = write_concepts(con, concepts, now)

    kind_dist = dict(con.execute("SELECT kind, COUNT(*) FROM tag GROUP BY kind ORDER BY 2 DESC").fetchall())
    name_dist = dict(con.execute("SELECT lang || ':' || kind, COUNT(*) FROM tag_name GROUP BY 1").fetchall())
    con.executemany(
        "INSERT INTO lib_meta (key, value) VALUES (?,?)",
        [
            ("source", "extension"),
            ("version", datetime.now(timezone.utc).strftime("%Y.%m.%d")),
            ("generated_at", now),
            ("sources", json.dumps({
                "danbooru": str(data_dir / "danbooru_tags.sqlite"),
                "pixiv": str(data_dir / "pixiv_tags.sqlite"),
            }, ensure_ascii=False)),
            ("counts", json.dumps(counts, ensure_ascii=False)),
            ("kind_dist", json.dumps(kind_dist, ensure_ascii=False)),
            ("name_dist", json.dumps(name_dist, ensure_ascii=False)),
            ("merge_policy", json.dumps({
                "partition": "kind", "cascade": ["zh_norm", "en_norm", "ja_norm"],
                "zh_norm": "strip_parenthetical_suffix",
                "artist_scope": "full_no_popularity_filter",
                "danbooru_scope": f"general/work/character post_count>={DANB_MIN_POSTS} + artist all",
            }, ensure_ascii=False)),
        ],
    )
    con.commit()
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("VACUUM")
    con.execute("ANALYZE")
    con.close()

    mb = out_path.stat().st_size / 1024 / 1024
    print("\n=== 生成完成 ===")
    for k, v in counts.items():
        print(f"  {k:15s}: {v}")
    print(f"  kind 分布      : {kind_dist}")
    print(f"  名称语言分布   : {name_dist}")
    print(f"  输出文件       : {out_path}  ({mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
