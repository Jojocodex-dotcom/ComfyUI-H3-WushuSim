# -*- coding: utf-8 -*-
"""ComfyUI 节点：H3 武斗模拟（60Hz 内核）。

与已有的 ``ComfyUI-H3-WushuBridge`` 分工
----------------------------------------
* 本包（WushuSim）：**打什么** —— 60Hz 确定性内核跑一场对打，产出
  逐帧证据、动作时间账、招式准备/释放时间、以及**可直接喂模型的提示词**
  （H3 分镜壳 / LTX 2.5 单段散文）。
* 那个包（WushuBridge）：**怎么说得像武打** —— 语义桥（conditioning 空间）、
  提示词体检（h3lint）、训练侧（数据集/残差桥/JEV 评分头）。

典型接法::

    [H3 武斗模拟] --prompt--> [CLIPTextEncode] --> [H3 武打语义逻辑桥] --> 采样器
          |--timeline_json--> [文本显示节点]（看每个动作的开始/结束/时长）
          |--prompt--> [H3 武打提示词体检]（拿到分数与逐条问题）

节点
----
1. ``H3 Wushu Simulate (60Hz kernel)`` —— 内核模拟：提示词 + 证据 + 时间账 + 审计
2. ``H3 Wushu LTX 2.5 Prompt``        —— LTX 2.5 单段散文提示词（六要素/切点四件事）
3. ``H3 Wushu Action Timing``         —— 动作时间账文本（准备/释放时间范围、相位、连招）
4. ``H3 Wushu Templates``             —— 打斗 208 条 / 文戏 154 条模板骨架
5. ``H3 Wushu Sim Status``            —— 桥接状态自检（缺 node / 缺内核时一眼看出）
"""

from __future__ import annotations

import json
from typing import Any, Dict, Tuple

from . import bridge

CATEGORY = "MiniMax H3/Wushu Sim"

SCENARIOS = ["field", "arena", "chase", "aerial", "water"]
SCENARIO_ZH = {
    "field": "阵地战（掩体/道具）",
    "arena": "擂台战（出界判负）",
    "chase": "追逐战（一追一逃）",
    "aerial": "空战（双方在空中）",
    "water": "水战（打滑与水花）",
}
SPEEDS = ["slow", "norm", "fast"]
SPEED_ZH = {"slow": "慢速（写意）", "norm": "常规", "fast": "高速（极速剪辑）"}
SHOT_PLANS = ["auto", "1", "2", "3"]
MODE_ZH = {"t2v": "文生视频（T2VA 壳）", "ref2v": "多参考图（Ref2VA 壳）"}
PARADIGMS = ["single", "multi"]
PARADIGM_ZH = {"single": "单镜头（官方最推荐）", "multi": "多镜头（2~4 镜原生剪辑）"}


def _ui(result: Tuple[Any, ...], *texts: Any) -> Dict[str, Any]:
    """ComfyUI 文本预览（与 WushuBridge 的 _ui 行为一致）。"""
    lines = [str(t) for t in texts if t is not None and str(t).strip()]
    return {"ui": {"text": lines}, "result": result}


def _timing_text(data: Dict[str, Any], limit: int = 120) -> str:
    """把动作时间账渲染成人类可读文本。"""
    rows = []
    tl = data.get("timeline") or []
    for seg in tl[:limit]:
        who = seg.get("who", "")
        label = seg.get("label", "")
        flag = " [空中]" if seg.get("airborne") else ""
        rows.append("%6.2f→%6.2f 秒（%.2f 秒）%s %s%s" % (seg.get("t0", 0), seg.get("t1", 0), seg.get("dur", 0), who, label, flag))
    audit = data.get("actionAudit") or {}
    stats = audit.get("stats") or {}
    head = ["【动作时间账】共 %d 段（以下显示前 %d 段）" % (len(tl), min(limit, len(tl)))]
    if stats:
        ph = stats.get("phases") or {}
        head.append("相位合计：起手 %.2fs／有效 %.2fs／收招 %.2fs｜平均动作 %.2fs｜待机占比 %.0f%%｜滞空占比 %.0f%%"
                    % (ph.get("windup", 0), ph.get("active", 0), ph.get("recovery", 0),
                       stats.get("avgAction", 0), (stats.get("idleShare", 0) or 0) * 100, (stats.get("airShare", 0) or 0) * 100))
        if stats.get("counterAfterBlock") is not None:
            head.append("格挡后 0.8 秒内反击兑现率：%.0f%%" % (stats["counterAfterBlock"] * 100))
    return "\n".join(head + [""] + rows)


def _audit_text(data: Dict[str, Any]) -> str:
    pa = data.get("purposeAudit") or {}
    ta = data.get("actionAudit") or {}
    lint = data.get("lint") or {}
    out = ["【逻辑审计】"]
    if pa:
        counts = pa.get("counts") or {}
        top = "，".join("%s %d" % (k, v) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:8])
        out.append("决策总数 %s｜带目的 %s（%.0f%%）｜未落表 %s"
                   % (pa.get("total"), pa.get("tagged"), (pa.get("coverage") or 0) * 100, pa.get("unpurposed")))
        out.append("目的分布：" + (top or "—"))
        for it in pa.get("issues") or []:
            out.append("· [%s] %s" % (it.get("level"), it.get("msg")))
    for it in (ta.get("issues") or []):
        out.append("· [%s] %s" % (it.get("level"), it.get("msg")))
    if lint:
        out.append("提示词体检：%s（必改 %s 项）" % (lint.get("grade", "?"), lint.get("errors")))
    if data.get("counts"):
        out.append("场次统计：" + json.dumps(data["counts"], ensure_ascii=False))
    return "\n".join(out)


# ── 节点 1：内核模拟 ────────────────────────────────────────────────────────
class H3WushuSimulate:
    """60Hz 确定性内核：跑一场对打，产出提示词 + 证据 + 时间账 + 审计。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "角色A": ("STRING", {"default": "太刀|7|男性，黑发披散，黑色武士劲装，双手持野太刀|过肩劈,横扫,突刺",
                                    "multiline": False,
                                    "tooltip": "武器|等级|外貌|招式1,招式2 —— 与「H3 武打编排」同一个格式"}),
                "角色B": ("STRING", {"default": "刀|5|男性，灰发束髻，靛蓝汉服武袍，右手持雁翎单刀|撩刀,反手削",
                                    "multiline": False}),
                "场景": ("STRING", {"default": "雨夜长街，两侧灯笼暖光，湿石板反光", "multiline": True}),
                "情景": (SCENARIOS, {"default": "field", "tooltip": "内核真的按情景改结算：" + "；".join(
                    "%s=%s" % (k, v) for k, v in SCENARIO_ZH.items())}),
                "时长秒": ("FLOAT", {"default": 8.0, "min": 3.0, "max": 30.0, "step": 0.5,
                                   "tooltip": "目标成片时长（内核按 KO 结算，可能略长）"}),
                "节奏": (SPEEDS, {"default": "norm", "tooltip": "慢速=写意／常规／高速=极速剪辑"}),
                "分镜数": (SHOT_PLANS, {"default": "auto", "tooltip": "auto=按时长自动（≤8s 一镜到底）"}),
                "种子": ("INT", {"default": 20260921, "min": 0, "max": 2 ** 31 - 1,
                               "tooltip": "同种子完全可复现（内核是确定性的）"}),
                "壳": (list(MODE_ZH.keys()), {"default": "t2v", "tooltip": "；".join("%s=%s" % kv for kv in MODE_ZH.items())}),
                "注入核心打斗逻辑": ("BOOLEAN", {"default": True,
                                            "tooltip": "把 25 条核心打斗逻辑（动作目的/时间账/跳跃纪律…）写进提示词要求"}),
                "英文提示词": ("BOOLEAN", {"default": False, "tooltip": "勾选则输出英文（默认中文）"}),
            },
            "optional": {
                "参考图数量": ("INT", {"default": 0, "min": 0, "max": 6, "tooltip": "多参考图模式的参考图张数（写进壳头）"}),
                "额外要求": ("STRING", {"default": "", "multiline": True, "tooltip": "追加到提示词要求里（可留空）"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "FLOAT")
    RETURN_NAMES = ("prompt", "evidence", "timeline_text", "audit", "lint_errors")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def run(self, 角色A, 角色B, 场景, 情景, 时长秒, 节奏, 分镜数, 种子, 壳,
            注入核心打斗逻辑=True, 英文提示词=False, 参考图数量=0, 额外要求=""):
        spec: Dict[str, Any] = {
            "fighterA": 角色A, "fighterB": 角色B,
            "scene": 场景, "scenario": 情景, "duration": float(时长秒),
            "speed": 节奏, "shotPlan": 分镜数, "seed": int(种子),
            "refMode": 壳 == "ref2v", "refCount": int(参考图数量),
            "targetEn": bool(英文提示词), "injectLogic": bool(注入核心打斗逻辑),
            "extra": 额外要求 or "",
        }
        data = bridge.run("simulate", **spec)
        prompt = data.get("prompt") or ""
        timeline_text = _timing_text(data)
        audit = _audit_text(data)
        errors = float((data.get("lint") or {}).get("errors") or 0)
        return _ui((prompt, data.get("evidence") or "", timeline_text, audit, errors),
                   "【提示词】\n" + prompt[:4000], "【" + timeline_text.splitlines()[0] + "】", audit)


# ── 节点 2：LTX 2.5 提示词 ──────────────────────────────────────────────────
class H3WushuLtx25Prompt:
    """把设计稿/分镜整理成 LTX 2.5 官方格式：单段散文、六要素、切点四件事、声音在段内。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "分镜文本": ("STRING", {"multiline": True, "default": "",
                                      "tooltip": "填「H3 武斗模拟」的 prompt 输出，或任何分镜/动作设计稿"}),
                "范式": (PARADIGMS, {"default": "multi", "tooltip": "；".join("%s=%s" % kv for kv in PARADIGM_ZH.items())}),
                "角色与外貌": ("STRING", {"multiline": True, "default": "", "tooltip": "每个角色只写一次：年龄/发型/服装/兵器"}),
                "场景": ("STRING", {"default": "", "multiline": True}),
                "声音": ("STRING", {"default": "", "multiline": True, "tooltip": "环境音＋打击声；留空则用默认战斗音效"}),
                "时长秒": ("FLOAT", {"default": 8.0, "min": 2.0, "max": 20.0, "step": 0.5,
                                   "tooltip": "只用于请求参数（帧数 8k+1），不写进提示词正文"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "request_params", "verdict")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def run(self, 分镜文本, 范式, 角色与外貌, 场景, 声音, 时长秒):
        shots = _split_shots(分镜文本)
        data = bridge.run("ltx25", paradigm=范式, shotList=shots, cast=角色与外貌,
                          scene=场景, sound=声音, duration=float(时长秒))
        v = data.get("verdict") or {}
        verdict = "LTX 2.5 体检：%s｜约 %s 词｜段数 %s｜范式 %s" % (
            "通过" if v.get("ok") else "未通过", (v.get("stats") or {}).get("words"),
            (v.get("stats") or {}).get("paragraphs"), data.get("paradigm"))
        for it in v.get("issues") or []:
            verdict += "\n· [%s] %s" % (it.get("level"), it.get("msg"))
        return _ui((data.get("prompt") or "", data.get("request") or "", verdict), data.get("prompt") or "", verdict)


def _split_shots(text: str):
    """把分镜文本切成 [{camera, action}]，供 LTX 单/多镜范式使用。"""
    import re
    text = (text or "").strip()
    if not text:
        return []
    parts = re.split(r"(?=\[Shot\s*\d+\])", text)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        m = re.match(r"\[Shot\s*\d+\]\s*([\d.]+-[\d.]+s)?\.?\s*([^.。]*)[.。]?\s*(.*)", p, re.S)
        if m:
            cam = (m.group(2) or "").strip() or "胸口高度手持跟拍中景镜头"
            body = (m.group(3) or "").strip()
            out.append({"camera": cam, "action": body or p})
        else:
            out.append({"camera": "胸口高度手持跟拍中景镜头", "action": p})
    return out


# ── 节点 3：动作时间账 ──────────────────────────────────────────────────────
class H3WushuActionTiming:
    """单独查看动作时间账：每个动作的开始→结束→时长、相位、滞空、格挡/闪避时长。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模式": (["从模拟结果取", "只给时间账文本"], {"default": "从模拟结果取"}),
                "显示段数": ("INT", {"default": 120, "min": 10, "max": 400}),
            },
            "optional": {
                "种子": ("INT", {"default": 20260921, "min": 0, "max": 2 ** 31 - 1}),
                "时长秒": ("FLOAT", {"default": 8.0, "min": 3.0, "max": 30.0, "step": 0.5}),
                "角色A": ("STRING", {"default": "太刀|7|男性，黑发披散|过肩劈,横扫"}),
                "角色B": ("STRING", {"default": "刀|5|男性，灰发束髻|撩刀"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("timeline_text",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def run(self, 模式, 显示段数, 种子=20260921, 时长秒=8.0, 角色A="", 角色B=""):
        if 模式 == "只给时间账文本":
            return _ui(("（时间账文本模式：请把「H3 武斗模拟」的 timeline_text 接到文本显示节点）",),
                       "（时间账文本模式）")
        data = bridge.run("simulate", fighterA=角色A, fighterB=角色B,
                          duration=float(时长秒), seed=int(种子), scenario="field")
        txt = _timing_text(data, limit=int(显示段数))
        return _ui((txt,), txt)


# ── 节点 4：模板库 ──────────────────────────────────────────────────────────
class H3WushuTemplates:
    """打斗 208 条 / 文戏 154 条模板骨架（含核心打斗逻辑与逐拍骨架）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "库": (["打斗", "文戏"], {"default": "打斗"}),
                "模板序号": ("INT", {"default": 0, "min": 0, "max": 400}),
                "包含骨架": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("skeleton", "id_list", "count")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def run(self, 库, 模板序号, 包含骨架=True):
        data = bridge.run("templates", withSkeleton=bool(包含骨架))
        key = "fight" if 库 == "打斗" else "drama"
        block = data.get(key) or {}
        ids = block.get("ids") or []
        idx = max(0, min(len(ids) - 1, int(模板序号))) if ids else -1
        skeleton = ""
        if idx >= 0 and 包含骨架:
            one = bridge.run("templates", id=ids[idx])
            skeleton = (one.get("template") or {}).get("skeleton") or ""
        head = "【%s模板】共 %d 条；当前取第 %d 条：%s" % (库, len(ids), idx + 1, ids[idx] if idx >= 0 else "—")
        return _ui((skeleton, "\n".join(ids), len(ids)), head, skeleton[:3000])


# ── 节点 5：桥接状态 ────────────────────────────────────────────────────────
class H3WushuSimStatus:
    """桥接状态自检：node 是否可用、JS 内核在哪、内核自检是否通过。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"运行内核自检": ("BOOLEAN", {"default": True})}}

    RETURN_TYPES = ("STRING", "BOOLEAN")
    RETURN_NAMES = ("status", "ok")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def run(self, 运行内核自检=True):
        info = bridge.backend_info()
        lines = ["【H3 武斗模拟 · 桥接状态】backend=%s version=%s ok=%s" % (info.get("backend"), info.get("version"), info.get("ok")),
                 "node：%s" % info.get("node"), "JS 内核：%s" % info.get("root")]
        ok = bool(info.get("ok"))
        if 运行内核自检 and ok:
            try:
                st = bridge.run("selftest", use_cache=False)
                lines.append("内核自检：%s｜%s" % (st.get("ok"), st.get("note")))
                lines.append(json.dumps(st.get("checks", {}), ensure_ascii=False))
                ok = bool(st.get("ok"))
            except Exception as e:  # noqa: BLE001
                lines.append("内核自检失败：%s" % e)
                ok = False
        elif info.get("error"):
            lines.append("错误：" + str(info["error"]))
        txt = "\n".join(lines)
        return _ui((txt, ok), txt)


NODE_CLASS_MAPPINGS = {
    "H3WushuSimulate": H3WushuSimulate,
    "H3WushuLtx25Prompt": H3WushuLtx25Prompt,
    "H3WushuActionTiming": H3WushuActionTiming,
    "H3WushuTemplates": H3WushuTemplates,
    "H3WushuSimStatus": H3WushuSimStatus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3WushuSimulate": "H3 武斗模拟（60Hz 内核）",
    "H3WushuLtx25Prompt": "H3 武斗 · LTX 2.5 提示词",
    "H3WushuActionTiming": "H3 武斗 · 动作时间账",
    "H3WushuTemplates": "H3 武斗 · 模板库（208+154）",
    "H3WushuSimStatus": "H3 武斗模拟 · 桥接状态",
}
