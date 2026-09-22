# -*- coding: utf-8 -*-
"""Node 桥：把 H3 武斗模拟器的 JS 内核（sim3d）当作后端调用。

设计原则
--------
* **接口先定、后端可换**：本模块只暴露 ``run(op, **spec) -> dict``；
  今天的实现是 ``node sim3d/cli.js``，将来换成纯 Python 移植时，节点代码一行都不用改。
* **自包含**：JS 内核快照随包发布在 ``wushu_sim/js/``（用 ``tools/sync_js.py`` 同步），
  也可以用环境变量指向开发目录：``H3WUSHU_SIM_ROOT=E:\\wushulong\\H3武斗模拟器-v9.12``。
* **可缓存**：同 spec 的调用结果按 hash 缓存（ComfyUI 本身也会缓存节点，这里是双保险）。

环境变量
--------
``H3WUSHU_SIM_ROOT``   JS 内核根目录（默认包内 ``js/``）
``H3WUSHU_SIM_NODE``   node 可执行文件（默认从 PATH 里找）
``H3WUSHU_SIM_TIMEOUT`` 单次调用超时秒数（默认 120）
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict, Optional

__all__ = ["SimBridgeError", "js_root", "node_exe", "run", "available", "backend_info", "clear_cache"]

VERSION = "0.1.0"


class SimBridgeError(RuntimeError):
    """桥接失败（缺 node / 缺 JS 内核 / 内核报错）。"""


_CACHE: Dict[str, Dict[str, Any]] = {}
_MAX_CACHE = 32


# ── 路径与可执行文件 ────────────────────────────────────────────────────────
def js_root() -> str:
    """JS 内核根目录：环境变量优先，其次包内快照。"""
    env = (os.environ.get("H3WUSHU_SIM_ROOT") or "").strip()
    if env and os.path.isdir(os.path.join(env, "sim3d")):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    bundled = os.path.join(here, "js")
    if os.path.isdir(os.path.join(bundled, "sim3d")):
        return bundled
    raise SimBridgeError(
        "找不到 JS 内核目录。请在包里跑 tools/sync_js.py 生成 wushu_sim/js/，"
        "或设置环境变量 H3WUSHU_SIM_ROOT 指向模拟器目录（该目录下应有 sim3d/）。"
    )


def node_exe() -> str:
    env = (os.environ.get("H3WUSHU_SIM_NODE") or "").strip()
    if env and os.path.isfile(env):
        return env
    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        return found
    raise SimBridgeError("找不到 node 可执行文件。请安装 Node.js ≥18，或设置 H3WUSHU_SIM_NODE 指向 node。")


def _timeout() -> float:
    try:
        return max(5.0, float(os.environ.get("H3WUSHU_SIM_TIMEOUT") or 120))
    except Exception:
        return 120.0


def available() -> bool:
    try:
        root, node = js_root(), node_exe()
    except SimBridgeError:
        return False
    return os.path.isfile(os.path.join(root, "sim3d", "cli.js")) and bool(node)


def backend_info() -> Dict[str, Any]:
    """给节点/自检看的状态。"""
    info: Dict[str, Any] = {"backend": "node-bridge", "version": VERSION}
    try:
        info["root"] = js_root()
    except SimBridgeError as e:
        info["root"] = None
        info["error"] = str(e)
    try:
        info["node"] = node_exe()
    except SimBridgeError as e:
        info["node"] = None
        info.setdefault("error", str(e))
    info["ok"] = bool(info.get("root") and info.get("node"))
    return info


# ── 调用 ────────────────────────────────────────────────────────────────────
def _key(op: str, spec: Dict[str, Any]) -> str:
    raw = json.dumps({"op": op, "spec": spec}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def clear_cache() -> int:
    n = len(_CACHE)
    _CACHE.clear()
    return n


def run(op: str, use_cache: bool = True, **spec: Any) -> Dict[str, Any]:
    """调用内核。``op`` 见 sim3d/cli.js（simulate / lint / ltx25 / templates / selftest / compile）。

    返回解析后的 dict；失败抛 SimBridgeError（带 stderr 摘要，便于在 ComfyUI 里看日志）。
    """
    spec = {k: v for k, v in spec.items() if v is not None}
    spec["op"] = op
    ck = _key(op, spec)
    if use_cache and ck in _CACHE:
        return _CACHE[ck]

    root, node = js_root(), node_exe()
    cli = os.path.join(root, "sim3d", "cli.js")
    if not os.path.isfile(cli):
        raise SimBridgeError("缺少 " + cli)

    tmpdir = tempfile.mkdtemp(prefix="h3wushu_")
    cfg_path = os.path.join(tmpdir, "spec.json")
    out_path = os.path.join(tmpdir, "result.json")
    try:
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        proc = subprocess.run(
            [node, cli, "--file", cfg_path, "--out", out_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=_timeout(), cwd=root,
        )
        if proc.returncode != 0 or not os.path.isfile(out_path):
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
            raise SimBridgeError("内核执行失败（exit %s）：%s" % (proc.returncode, " / ".join(tail)))
        with open(out_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except subprocess.TimeoutExpired:
        raise SimBridgeError("内核超时（>%ss）" % _timeout())
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if isinstance(data, dict) and data.get("ok") is False:
        raise SimBridgeError("内核返回失败：%s" % data.get("error"))
    if use_cache:
        if len(_CACHE) >= _MAX_CACHE:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[ck] = data
    return data


def main() -> int:  # 便于 tools/selftest.py 与手工排查
    try:
        info = backend_info()
        print(json.dumps(info, ensure_ascii=False, indent=2))
        if not info.get("ok"):
            return 1
        st = run("selftest", use_cache=False)
        print("内核自检：", st.get("ok"), st.get("note"))
        print(json.dumps(st.get("checks", {}), ensure_ascii=False))
        return 0 if st.get("ok") else 1
    except SimBridgeError as e:
        print("失败：", e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
