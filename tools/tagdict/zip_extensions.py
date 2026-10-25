#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 `plugins-dist/` 下已构建的扩展插件目录打成分发用单包 zip。

背景（RFC 0008 / D36 第二层）：扩展插件（`tagdict-pixiv` / `tagdict-danbooru` /
`tagrel-games`）体积 129–162MB，其中 `data/tag_lib.sqlite` **单文件已超过
GitHub 100MB 单文件上限**，因此「目录」不能直接入库；而压缩后每个包 1.8–57MB
（<100MB），可作为**构建输入资产**入库，供 CI 发布时直接挂到 Release。

产物（随仓库提交，`plugins-dist/` 目录本身仍留在 .gitignore）：
  plugins-dist/<name>.zip   内含顶级目录 <name>/（解压即得可安装目录，
                            与 `plugin.installLocal` 的「指向本地目录」口径一致）

确定性：所有条目按路径排序、时间戳固定为 1980-01-01 00:00:00、权限固定 0644，
同样的输入重复执行得到**逐字节相同**的 zip（便于目录/压缩包的一致性检查）。

用法：
  python tools/tagdict/zip_extensions.py            # 全部扩展
  python tools/tagdict/zip_extensions.py tagrel-games   # 只打某个
  python tools/tagdict/zip_extensions.py --check    # 只校验（zip 缺失或与目录不一致则退出码 1）
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "plugins-dist"

# 固定时间戳与权限：让 zip 可复现（同目录内容 ⇒ 同字节）
FIXED_DATE = (1980, 1, 1, 0, 0, 0)
FIXED_MODE = 0o644 << 16


def zip_name(plugin_dir: Path) -> Path:
    return plugin_dir.parent / f"{plugin_dir.name}.zip"


def write_zip(plugin_dir: Path) -> Path:
    out = zip_name(plugin_dir)
    tmp = out.with_suffix(".zip.tmp")
    entries = sorted(
        (p for p in plugin_dir.rglob("*") if p.is_file()),
        key=lambda p: p.relative_to(plugin_dir.parent).as_posix(),
    )
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in entries:
            info = zipfile.ZipInfo(p.relative_to(plugin_dir.parent).as_posix(), FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = FIXED_MODE
            zf.writestr(info, p.read_bytes())
    tmp.replace(out)
    return out


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def discover(only: list[str]) -> list[Path]:
    if not DIST.is_dir():
        return []
    dirs = sorted(
        p
        for p in DIST.iterdir()
        if p.is_dir() and not p.name.startswith(".") and (p / "plugin.manifest").is_file()
    )
    if only:
        dirs = [p for p in dirs if p.name in set(only)]
    return dirs


def main() -> int:
    ap = argparse.ArgumentParser(description="把 plugins-dist/<name>/ 打成 <name>.zip（确定性）")
    ap.add_argument("names", nargs="*", help="只处理这些扩展目录名（默认全部）")
    ap.add_argument("--check", action="store_true", help="只校验：zip 缺失或与目录内容不一致则返回 1")
    args = ap.parse_args()

    dirs = discover(args.names)
    if not dirs:
        print(f"[ext-zip] 未找到可打包的扩展目录（{DIST}）", file=sys.stderr)
        return 1

    failed = False
    for plugin_dir in dirs:
        target = zip_name(plugin_dir)
        if args.check:
            if not target.is_file():
                print(f"[ext-zip] 缺失 zip: {target.name}（运行 python {Path(__file__).name} 生成）")
                failed = True
                continue
            # 与目录内容比对：条目集合 + 逐文件 CRC32
            expected: dict[str, int] = {}
            for p in plugin_dir.rglob("*"):
                if p.is_file():
                    expected[p.relative_to(plugin_dir.parent).as_posix()] = zipfile.crc32(p.read_bytes())
            with zipfile.ZipFile(target) as zf:
                actual = {i.filename: i.CRC for i in zf.infolist()}
            if expected != actual:
                print(f"[ext-zip] 与目录不一致: {target.name}（目录内容已变化，请重新生成并提交）")
                failed = True
            else:
                print(f"[ext-zip] ok: {target.name}（{len(expected)} 文件，{target.stat().st_size / 1048576:.1f} MB）")
            continue

        written = write_zip(plugin_dir)
        size_mb = written.stat().st_size / 1048576
        print(f"[ext-zip] 已生成: {written.name}（{size_mb:.1f} MB，sha256={sha256(written)[:16]}…）")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
