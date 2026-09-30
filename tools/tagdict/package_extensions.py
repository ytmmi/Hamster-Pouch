#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把细分 tag 库打成 plugins-dist 下的扩展包（RFC 0008 / D36 第二层）。

每个细分扩展包 = 一个目录，内含：
  plugin.manifest           - runtime.kind = static-data（纯数据，无 entry）
  data/tag_lib.sqlite       - 该细分的四库数据（同构 schema）
  README.md                 - 数据来源与许可（RFC 0008 要求）
  CHANGELOG                 - 版本与计数

命名原则（用户要求）：**按扩展类型分类 + 按细分内容取名**，不用"字典"这类泛称。
  - 词典扩展 `tagdict-*`：按生态来源切分 -> tagdict-pixiv / tagdict-danbooru
  - 关系扩展 `tagrel-*`：库 2 关系映射 -> tagrel-games

数据文件名统一为 `data/tag_lib.sqlite`：宿主按固定名装配，不因包而异
（历史上关系包用 `tag_lib_games.sqlite`，导致宿主按固定名静默装不上）。

注意：不在此处生成 SHA256SUMS / SHA256SUMS.sig——签名走 tools/sign-plugin.mjs
（需要 Ed25519 私钥，属发布流程）。

用法：
  python package_extensions.py [--split-dir output/split] [--dist-dir ../../plugins-dist]
"""

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).parent
# HERE = <repo>/tools/tagdict -> parents[0]=tools, parents[1]=<repo>
ROOT = HERE.resolve().parents[1]

# 扩展包按**类型**分两类命名（用户要求：关系扩展与词典扩展要能一眼区分）：
#   - **词典扩展** `tagdict-*`：词库内容（概念 / 多语言名称 / 分类 / 别名），按生态来源细分
#   - **关系扩展** `tagrel-*`：库 2 关系映射（概念之间的层级/关联边）
# 目录名与插件 id 都带类型前缀，显示名也写明类型。
#
# 每项：目录名, 插件 id 后缀, 显示名, 说明, 数据文件名
# 数据文件名统一为 `tag_lib.sqlite`（宿主按固定名装配，不再因包而异——见 shared.rs）。
SLICES = {
    "pixiv": (
        "tagdict-pixiv",
        "tagdict.pixiv",
        "tagdict · pixiv 词典（日语生态）",
        "pixiv 生态的 tag 概念、多语言名称、分类与别名。以日文写法为主，含中文译名与英文名。",
        "tag_lib.sqlite",
    ),
    "danbooru": (
        "tagdict-danbooru",
        "tagdict.danbooru",
        "tagdict · danbooru 词典（英语生态，含 artist 全量）",
        "danbooru 生态的 tag 概念、多语言名称、分类与别名。含 artist 全量（15 万余条，按 D35 不做热度过滤）。",
        "tag_lib.sqlite",
    ),
    # 库 2 关系映射：游戏 → 角色（RFC 0008 库 2 / D34）
    "games": (
        "tagrel-games",
        "tagrel.games",
        "tagrel · 游戏角色关系（库 2 关系映射）",
        "9 款游戏（原神 / 碧蓝航线 / 碧蓝档案 / 明日方舟 / 异环 / 鸣潮 / 绝区零 / 崩坏3 / 崩坏：星穹铁道）\
与其角色的层级关系。角色名不带括号后缀，作品归属由关系边表达；多语言由 tag_name 承担，软件内按语言算法匹配。",
        "tag_lib.sqlite",
    ),
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_meta(db: Path) -> dict:
    con = sqlite3.connect(str(db))
    meta = dict(con.execute("SELECT key, value FROM lib_meta"))
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("tag", "tag_source", "tag_name", "tag_relation",
                        "tag_artist", "tag_character", "tag_work")}
    con.close()
    meta["counts"] = counts
    return meta


def build_manifest(slice_key: str, meta: dict, version: str) -> dict:
    _dir, id_suffix, name, _desc, _file = SLICES[slice_key]
    return {
        "id": f"dev.hamsterpouch.extension.{id_suffix}",
        "name": name,
        "version": version,
        "min_host_version": 1,
        "api_version": 1,
        # 纯数据包：无 entry、无能力、无贡献点（宿主负责读取词库数据）
        "runtime": {"kind": "static-data"},
        "capabilities": [],
        "contributions": [],
        "data_queries": [],
        "events": [],
        "trust": {"requested": "community"},
    }


def build_readme(slice_key: str, meta: dict) -> str:
    _dir, _id, name, desc, _file = SLICES[slice_key]
    c = meta["counts"]
    is_rel = _dir.startswith("tagrel-")
    kind_line = (
        "**扩展类型：关系扩展（`tagrel-*`）**——库 2 关系映射，承载概念之间的层级/关联边。"
        if is_rel
        else "**扩展类型：词典扩展（`tagdict-*`）**——词库内容，承载概念、多语言名称、分类与别名。"
    )
    rel_note = (
        "本包是**关系扩展**：库 1 概念 + 库 4 多语言名称 + 库 3 原作/角色字段，"
        "以及连接二者的 `tag_relation` 层级边。"
        if is_rel
        else "本包是**词典扩展**：提供概念与名称；库 2 关系由关系扩展（`tagrel-*`）提供。"
    )
    return f"""# {name}

{desc}

{kind_line}

本包是 **tag 四库扩展包**（RFC 0008 / D36 第二层），按扩展类型与细分内容命名。
`runtime.kind = static-data`：**纯数据，不执行任何代码**，由宿主负责读取。

## 命名约定

| 前缀 | 类型 | 内容 |
| --- | --- | --- |
| `tagdict-*` | **词典扩展** | 概念、多语言名称、分类、别名（按生态来源细分） |
| `tagrel-*` | **关系扩展** | 库 2 关系映射（概念之间的层级/关联边） |

## 结构（RFC 0008 四库，同构 schema）

| 表 | 含义 | 行数 |
| --- | --- | --- |
| `tag` | 库 1 tag 总库（一条记录 = 一个概念，D33） | {c['tag']:,} |
| `tag_source` | 生态写法（原始 tag 名，作来源证据） | {c['tag_source']:,} |
| `tag_name` | 库 4 别名与多语言映射（每语言一个标准名，D37） | {c['tag_name']:,} |
| `tag_artist` | 库 3 艺术家（人类记人名 / AI 记基座，D35） | {c['tag_artist']:,} |
| `tag_character` | 库 3 角色（`work_tag_id` 指向归属原作） | {c['tag_character']:,} |
| `tag_work` | 库 3 原作（IP / 游戏 / 动画） | {c['tag_work']:,} |
| `tag_relation` | 库 2 关系映射（`hierarchy`：上级 → 下级） | {c['tag_relation']:,} |

{rel_note}

## 角色命名约定

**角色名不带括号后缀**（如 `甘雨`，不是 `甘雨（原神）`）；**作品归属由 `tag_relation`
的关系边表达**（`原神 --hierarchy--> 甘雨`）。带括号的完整写法作为**别名**保留，
因此既支持「按名字直接命中」，也支持「按作品筛选角色」。

## 多语言

本包**只实现一种语言**（中文标准名）；日/英标准名与别名随概念一并携带，
软件内按语言查 `tag_name` 即可匹配多语言（如 `甘雨` / `Ganyu` 命中同一 `tag_id`）。

## 数据来源与许可

- **danbooru 对照表**：`ffdkj/Danbooru_Tag-Chinese-English-Translation-Table`（**MIT 许可**）
- **pixiv 对照表**：`ffdkj/Pixiv_Tag-Chinese-English-Translation-Table`（**MIT 许可**）

两个主源均为个人维护的每日更新仓库。数据为社区 LLM 生成的中英对照，存在错译可能。
关系归属由 `tools/tagdict/build_game_relations.py` 按多信号匹配生成（danbooru 的
`角色_(作品)` 命名约定、括号后缀、既有归属启发式），**歧义者不归属**，可能需人工校正。

## 生成信息

- 版本：`{meta.get('version', '')}`
- 生成时间：`{meta.get('generated_at', '')}`
- 细分：`{meta.get('slice', '')}`
- 概念合并策略：以 `kind` 为第一分区键，按 zh→en→ja 标准名级联（D33）
- 中文名归一：去括号后缀（括号内容保留为别名）
- artist 范围：全量纳入、不做热度过滤（D35）
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="打包细分 tag 库扩展包")
    ap.add_argument("--split-dir", default=str(HERE / "output" / "split"))
    ap.add_argument("--dist-dir", default=str(ROOT / "plugins-dist"))
    args = ap.parse_args()

    split_dir, dist_dir = Path(args.split_dir), Path(args.dist_dir)
    version = datetime.now(timezone.utc).strftime("0.1.%Y%m%d")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if not split_dir.is_dir():
        print(f"[package_extensions] 细分目录不存在: {split_dir}")
        print("  请先运行: python tools/tagdict/build_tag_lib.py --split-by-source")
        return 1

    built = []
    for slice_key, (dirname, _id, name, _desc, data_file) in SLICES.items():
        # 细分包的数据文件：pixiv/danbooru 在 output/split/ 下；
        # 关系包（games）直接在 output/ 下（不是按来源切分的产物）。
        src_db = (split_dir / f"tag_lib_{slice_key}.sqlite")
        if not src_db.is_file():
            src_db = HERE / "output" / f"tag_lib_{slice_key}.sqlite"
        if not src_db.is_file():
            print(f"[package_extensions] 跳过 {slice_key}：未找到 {src_db.name}")
            continue

        pkg = dist_dir / dirname
        if pkg.exists():
            shutil.rmtree(pkg)
        (pkg / "data").mkdir(parents=True)

        dst_db = pkg / "data" / data_file
        shutil.copy2(src_db, dst_db)

        meta = read_meta(dst_db)
        (pkg / "plugin.manifest").write_text(
            json.dumps(build_manifest(slice_key, meta, version), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (pkg / "README.md").write_text(build_readme(slice_key, meta), encoding="utf-8")
        (pkg / "CHANGELOG").write_text(
            f"{version}  {now}\n"
            f"  - 由 tools/tagdict/build_tag_lib.py 生成的 {slice_key} 细分\n"
            f"  - 概念 {meta['counts']['tag']:,} / 名称 {meta['counts']['tag_name']:,} "
            f"/ 来源 {meta['counts']['tag_source']:,}\n",
            encoding="utf-8",
        )

        mb = dst_db.stat().st_size / 1024 / 1024
        print(f"[package_extensions] {dirname}: {name}")
        print(f"    {meta['counts']['tag']:,} 概念 / {meta['counts']['tag_name']:,} 名称 / {mb:.1f} MB")
        print(f"    sha256(data/{data_file}) = {sha256_file(dst_db)}")
        built.append(dirname)

    print(f"\n已生成 {len(built)} 个细分扩展包于 {dist_dir}: {built}")
    print("  提示：签名需运行 node tools/sign-plugin.mjs <包目录>（需 Ed25519 私钥）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
