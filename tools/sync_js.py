#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 H3 武斗模拟器的 JS 内核同步进本包（``wushu_sim/js/``）。

为什么要快照：插件必须**自包含**——ComfyUI 机器上不该要求装整个模拟器目录。
同步是单向只读拷贝，不改动源目录的任何文件。

用法::

    python tools/sync_js.py                       # 用环境变量/默认路径找源
    python tools/sync_js.py --src E:\\wushulong\\H3武斗模拟器-v9.12
    python tools/sync_js.py --check               # 只比对是否已是最新（不写）

会拷贝的东西（内核相关，全部是纯逻辑、无 DOM 依赖的部分）：
    sim3d/{engine,pipeline,combat-logic,rig,cli}.js
    h3lint.js, h3tools.js
    ltx2/step2.js
    templates/{axes,corpus-data,corpus,library}.js
    drama/templates/{axes,library}.js
    drama/{engine,h3-prompts,h3-validate,one-line}.js
同时写出 ``wushu_sim/js/MANIFEST.json``（每个文件的 sha256 与字节数 + 源版本）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from typing import Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
DEST = os.path.join(PKG, "wushu_sim", "js")

FILES = [
    "core/combat-contract.js",
    "drama/engine.js",
    "drama/h3-prompts.js",
    "drama/h3-validate.js",
    "drama/one-line.js",
    "drama/templates/axes.js",
    "drama/templates/library.js",
    "h3lint.js",
    "h3tools.js",
    "ltx2/step2.js",
    "sim3d/action-system.js",
    "sim3d/ai-rehearsal.js",
    "sim3d/choreography.js",
    "sim3d/cli.js",
    "sim3d/combat-logic.js",
    "sim3d/diag.js",
    "sim3d/engine.js",
    "sim3d/moves.js",
    "sim3d/pipeline.js",
    "sim3d/rig.js",
    "sim3d/routines.js",
    "sim3d/settings-audit.js",
    "sim3d/skill-catalog.js",
    "sim3d/terrain.js",
    "templates/axes.js",
    "templates/corpus-data.js",
    "templates/corpus.js",
    "templates/library.js",
]

DEFAULT_SRC = [
    os.environ.get("H3WUSHU_SIM_SRC", ""),
    r"E:\wushulong\H3武斗模拟器-v9.12",
]


def find_src(explicit: str = "") -> str:
    for cand in [explicit] + DEFAULT_SRC:
        if cand and os.path.isfile(os.path.join(cand, "sim3d", "cli.js")):
            return os.path.abspath(cand)
    raise SystemExit("找不到内核源目录（需要包含 sim3d/cli.js）。请用 --src 指定，或设置 H3WUSHU_SIM_SRC。")


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(src: str) -> Dict[str, Dict[str, object]]:
    out: Dict[str, Dict[str, object]] = {}
    for rel in FILES:
        p = os.path.join(src, rel)
        if not os.path.isfile(p):
            print("  ! 缺失（跳过）：" + rel)
            continue
        out[rel] = {"sha256": sha256(p), "bytes": os.path.getsize(p)}
    return out


def version_of(src: str) -> str:
    """从内核里读版本号，写进 MANIFEST（便于对照）。"""
    v = {}
    try:
        with open(os.path.join(src, "sim3d", "engine.js"), encoding="utf-8") as fh:
            for line in fh:
                if "const VERSION" in line:
                    v["engine"] = line.split('"')[1] if '"' in line else line.strip()
                    break
    except Exception:
        pass
    try:
        with open(os.path.join(src, "sim3d", "combat-logic.js"), encoding="utf-8") as fh:
            for line in fh:
                if "const VERSION" in line:
                    v["combatLogic"] = line.split('"')[1] if '"' in line else line.strip()
                    break
    except Exception:
        pass
    try:
        with open(os.path.join(src, "ltx2", "step2.js"), encoding="utf-8") as fh:
            for line in fh:
                if "const VERSION" in line:
                    v["ltx2"] = line.split('"')[1] if '"' in line else line.strip()
                    break
    except Exception:
        pass
    return json.dumps(v, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="")
    ap.add_argument("--check", action="store_true", help="只比对是否已是最新，不写文件")
    args = ap.parse_args()
    src = find_src(args.src)
    print("源目录：" + src)
    files = collect(src)
    manifest = {
        "synced_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": src,
        "versions": version_of(src),
        "files": files,
    }
    manifest_path = os.path.join(DEST, "MANIFEST.json")
    if args.check:
        if not os.path.isfile(manifest_path):
            print("尚未同步（没有 MANIFEST.json）")
            return 1
        with open(manifest_path, encoding="utf-8") as fh:
            old = json.load(fh)
        same = old.get("files") == files
        print("与快照一致" if same else "快照已过期（源已更新）")
        return 0 if same else 1
    os.makedirs(DEST, exist_ok=True)
    n = 0
    for rel in files:
        dst = os.path.join(DEST, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(src, rel), dst)
        n += 1
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    total = sum(int(v["bytes"]) for v in files.values())
    print("已同步 %d 个文件（%.1f KB）→ %s" % (n, total / 1024, DEST))
    print("版本：" + manifest["versions"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
