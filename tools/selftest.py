#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""本包自检（不需要 ComfyUI、不需要显卡，30 秒内跑完）。

用法::

    python tools/selftest.py
    python tools/selftest.py --src E:\\wushulong\\H3武斗模拟器-v9.12   # 临时改用开发目录

检查项：
 1. 桥接状态（node 是否可用、JS 内核在哪）
 2. 内核自检（sim3d/cli.js op=selftest）
 3. 完整一场：提示词/证据/时间账/目的审计/体检
 4. 5 个节点能否实例化并跑通（直接调用节点类，不经 ComfyUI）
 5. 同种子可复现
"""

from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
sys.path.insert(0, os.path.join(PKG, "wushu_sim"))

PASS = FAIL = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ " + name + (("  " + extra) if extra else ""))
    else:
        FAIL += 1
        print("  ✗ " + name + (("  " + extra) if extra else ""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="", help="改用开发目录里的 JS 内核（设置 H3WUSHU_SIM_ROOT）")
    args = ap.parse_args()
    if args.src:
        os.environ["H3WUSHU_SIM_ROOT"] = os.path.abspath(args.src)

    from wushu_sim import bridge, nodes  # noqa: E402

    print("1) 桥接状态")
    info = bridge.backend_info()
    print("   " + str(info))
    ok("node 可用", bool(info.get("node")), str(info.get("node")))
    ok("JS 内核就位", bool(info.get("root")), str(info.get("root")))
    if not info.get("ok"):
        print("\n桥接不可用，后续检查跳过。请先安装 Node 或设置 H3WUSHU_SIM_NODE / H3WUSHU_SIM_ROOT。")
        return 1

    print("\n2) 内核自检")
    st = bridge.run("selftest", use_cache=False)
    ok("内核自检通过", bool(st.get("ok")), str(st.get("note")))
    print("   " + str(st.get("checks")))

    print("\n3) 完整一场（节点 1：H3 武斗模拟）")
    sim = nodes.H3WushuSimulate()
    out = sim.run(角色A="太刀|7|男性，黑发披散，黑色武士劲装|过肩劈,横扫,突刺",
                  角色B="刀|5|男性，灰发束髻，靛蓝汉服武袍|撩刀,反手削",
                  场景="雨夜长街，灯笼暖光", 情景="field", 时长秒=8.0, 节奏="norm",
                  分镜数="auto", 种子=20260921, 壳="t2v", 注入核心打斗逻辑=True, 英文提示词=False,
                  参考图数量=0, 额外要求="")
    res = out["result"]
    prompt, evidence, timeline_text, audit, errs = res
    ok("返回提示词", isinstance(prompt, str) and len(prompt) > 500, "%d 字符" % len(prompt))
    ok("返回证据", isinstance(evidence, str) and len(evidence) > 3000, "%.0f KB" % (len(evidence) / 1024))
    ok("返回时间账文本", "动作时间账" in timeline_text, timeline_text.splitlines()[0] if timeline_text else "")
    ok("返回逻辑审计", "逻辑审计" in audit, audit.splitlines()[1] if len(audit.splitlines()) > 1 else "")
    ok("体检错误数可读", isinstance(errs, float), "errors=%s" % errs)

    print("\n4) 其余节点")
    ltx = nodes.H3WushuLtx25Prompt().run(分镜文本=prompt, 范式="multi", 角色与外貌="",
                                         场景="雨夜长街", 声音="", 时长秒=8.0)["result"]
    ok("LTX 2.5 单段散文", ltx[0].count("\n") == 0 and len(ltx[0]) > 150, "%d 字符" % len(ltx[0]))
    ok("LTX 请求参数（帧数 8k+1）", "num_frames" in ltx[1], ltx[1].splitlines()[2] if len(ltx[1].splitlines()) > 2 else "")
    timing = nodes.H3WushuActionTiming().run(模式="从模拟结果取", 显示段数=60, 种子=20260921,
                                             时长秒=8.0, 角色A="太刀|7|甲", 角色B="刀|5|乙")["result"][0]
    ok("动作时间账节点", "→" in timing and "秒" in timing, timing.splitlines()[1] if len(timing.splitlines()) > 1 else "")
    tpl = nodes.H3WushuTemplates().run(库="打斗", 模板序号=0, 包含骨架=True)["result"]
    ok("模板库（打斗 208）", tpl[2] >= 208, "count=%d" % tpl[2])
    ok("模板骨架内容", "逐拍骨架" in tpl[0] or "核心打斗逻辑" in tpl[0], tpl[0][:40].replace("\n", " "))
    dpl = nodes.H3WushuTemplates().run(库="文戏", 模板序号=0, 包含骨架=False)["result"]
    ok("模板库（文戏 154）", dpl[2] >= 150, "count=%d" % dpl[2])
    status = nodes.H3WushuSimStatus().run(运行内核自检=True)["result"]
    ok("桥接状态节点", bool(status[1]) is True, status[0].splitlines()[0])

    print("\n5) 可复现性")
    a = nodes.H3WushuSimulate().run(角色A="太刀|7|甲|过肩劈", 角色B="刀|5|乙|撩刀", 场景="雨夜",
                                    情景="field", 时长秒=6.0, 节奏="norm", 分镜数="auto",
                                    种子=123, 壳="t2v", 注入核心打斗逻辑=True, 英文提示词=False,
                                    参考图数量=0, 额外要求="")["result"][0]
    b = nodes.H3WushuSimulate().run(角色A="太刀|7|甲|过肩劈", 角色B="刀|5|乙|撩刀", 场景="雨夜",
                                    情景="field", 时长秒=6.0, 节奏="norm", 分镜数="auto",
                                    种子=123, 壳="t2v", 注入核心打斗逻辑=True, 英文提示词=False,
                                    参考图数量=0, 额外要求="")["result"][0]
    ok("同种子逐字一致", a == b and len(a) > 200, "%d 字符" % len(a))

    print("\n=== 结果：%d 通过 / %d 失败 ===" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
