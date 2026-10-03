# ComfyUI-H3-WushuSim

**中文** | [English](#english)

把 **H3 武斗模拟器**的 60Hz 打斗内核做成 ComfyUI 节点：跑一场**确定性**对打，产出
**逐帧证据 + 动作时间账 + 招式库调用 + 可直接喂模型的提示词**（H3 分镜壳 / LTX 2.5 单段散文）。

> 配套插件：**ComfyUI-H3-WushuBridge**（语义桥 / 提示词体检 / 训练侧）、
> **ComfyUI-JEV-Orchestrator**（用 JEV 统筹整个执行）。本包负责"**打什么**"。

---

> **快照更新（2026-10-02 · V1.012）**：内核同步自 H3 武斗工作室 **V1.012**（engine `sim3d-2.1`）——
> 新增 `sim3d/skill-catalog.js` 等模块，`engine/pipeline/routines/moves` 一并更新；
> 同步清单改为「依赖闭包 ∪ 历史清单」共 26 个文件，避免再漏 `Cannot find module`。

> **快照更新（2026-10-03 · v20.6.6）**：内核同步自 H3 武斗工作室 **v20.6.6** ——
> `sim3d/engine.js` 更新（engine `sim3d-2.1`），同步清单仍为依赖闭包 ∪ 历史清单共 26 个文件。

## 目录

- [功能与原理](#功能与原理)
- [五个节点](#五个节点)
- [安装](#安装)
- [快速上手（3 步）](#快速上手3-步)
- [节点详解](#节点详解)
- [角色卡语法](#角色卡语法)
- [命令行用法（不用 ComfyUI）](#命令行用法不用-comfyui)
- [自检与排错](#自检与排错)
- [内核快照与升级](#内核快照与升级)
- [环境变量](#环境变量)
- [已知边界](#已知边界)
- [English](#english)

---

## 功能与原理

视频模型最大的痛点是**打斗编排**：人物为什么打、打到第几秒、怎么收招、被格挡后怎么反击——
这些东西靠人写提示词很难自洽。本包把一套 **60Hz 连续时空战斗内核**（米制坐标、固定步长、
判定帧帧级扫掠、几何命中、AI 效用决策）接进 ComfyUI，于是：

* **同种子逐帧可复现** —— 提示词不是"想出来的"，是跑出来的；
* **动作有时间过程** —— 每个动作都有 起手／有效／收招 的**时间范围**，不是瞬发瞬消；
* **招式从库里调用** —— 40+ 内置招式（每个都带 准备动作／出招动作／华丽效果／距离／扇角），
  库里没有的新招式会**自动入库并持久化**，下次同名直接调用；
* **零 GPU 成本** —— 编排在 CPU 上几十毫秒算完，显卡只用来出片。

## 五个节点

| 节点 | 作用 | 输出 |
|---|---|---|
| **H3 武斗模拟（60Hz 内核）** | 一次调用拿到：提示词、逐帧证据、动作时间账、逻辑审计、体检错误数 | `prompt` `evidence` `timeline_text` `audit` `lint_errors` |
| **H3 武斗 · LTX 2.5 提示词** | 按 LTX 2.5 官方规范输出**单段散文**（六要素、切点四件事、声音在段内、无配乐写法） | `prompt` `request_params` `verdict` |
| **H3 武斗 · 动作时间账** | 每个动作的 开始→结束（时长）、相位合计（起手/有效/收招）、待机与滞空占比、格挡后反击兑现率 | `timeline_text` |
| **H3 武斗 · 模板库** | 打斗 208 条 / 文戏 154 条骨架（含逐拍骨架与核心打斗逻辑） | `skeleton` `id_list` `count` |
| **H3 武斗模拟 · 桥接状态** | 一眼看出 node 是否可用、内核在哪、自检是否通过 | `status` `ok` |

## 安装

```text
把整个 ComfyUI-H3-WushuSim 目录放进：
    ComfyUI/custom_nodes/ComfyUI-H3-WushuSim/
重启 ComfyUI → 节点出现在分类 “MiniMax H3/Wushu Sim”
```

**依赖**

* 本包 Python 侧**只用标准库**（不需要 torch）；
* 内核用 Node 运行 → 机器上需要 **Node.js ≥ 18**（`node -v` 能跑即可）。

```bash
# 没装 Node 的话（Linux 服务器，用 conda 最省事）
conda install -y -c conda-forge nodejs
ln -sf "$(dirname "$(which node)")/node" /usr/local/bin/node   # 确保 ComfyUI 进程的 PATH 找得到
```

> 不想装 Node：把内核移植成纯 Python 后，只需替换 `wushu_sim/bridge.py` 的 `run()` 实现，
> **节点代码一行都不用改**（接口是 `bridge.run(op, **spec)`）。

## 快速上手（3 步）

1. 加 **H3 武斗模拟（60Hz 内核）** 节点，填角色卡（武器|等级|外貌|招式），设种子与时长；
2. `prompt` → **CLIPTextEncode** → 你的采样节点；`timeline_text` / `audit` 可接文本显示节点看细节；
3. （可选）`prompt` → **H3 武打提示词体检**（WushuBridge）看分数与逐条问题；
   `evidence` → **H3 武打语义逻辑桥**把逻辑推进 conditioning。

```text
[H3 武斗模拟] --prompt--> [CLIPTextEncode] --> [H3 武打语义逻辑桥] --> 采样器
      |--prompt-------> [H3 武打提示词体检]     → 分数/等级/逐条问题
      |--timeline_text-> [文本显示]             → 每个动作的开始/结束/时长
      |--evidence------> [文本显示/存档]         → 逐帧证据 JSON（可复现）
```

## 节点详解

### H3 武斗模拟（60Hz 内核）

| 输入 | 说明 |
|---|---|
| 角色A / 角色B | `武器\|等级\|外貌\|招式1,招式2`（见下一节） |
| 场景 | 一句话环境描述（写进提示词：光线、材质、天气） |
| 情景 | `field` 阵地战（掩体）／`arena` 擂台（出界判负）／`chase` 追逐（一追一逃）／`aerial` 空战／`water` 水战（打滑、水花） |
| 时长秒 | 目标成片时长（内核按 KO 结算，可能略长） |
| 节奏 | 慢速（写意）／常规／高速（极速剪辑） |
| 分镜数 | `auto`（≤8s 一镜到底）或 1/2/3 |
| 种子 | **同种子逐帧完全可复现** |
| 壳 | 文生视频（T2VA 壳）／多参考图（Ref2VA 壳） |
| 注入核心打斗逻辑 | 把 25 条核心逻辑（动作目的／时间账／跳跃纪律…）写进提示词要求 |
| 英文提示词 | 勾选则输出英文 |

输出里 `lint_errors` 是**原始分镜文本**的体检结果——它是给 AI 润色或编排节点再加工的素材，
不是最终成品稿（成品稿请接体检节点看分数）。

### H3 武斗 · 动作时间账

单独查看"每个动作花了多久"：`0.17→0.32s（0.15 秒）甲 力劈华山·起手` 这样的逐段清单，
外加相位合计、平均动作时长、待机占比、滞空占比、格挡后 0.8 秒内反击兑现率。

### H3 武斗 · 模板库

208 条打斗模板 + 154 条文戏模板（结婚／离婚／蜜月／争宠…），每条都是**逐拍骨架**，
内含核心打斗逻辑与逐拍目的，可直接当设计稿喂给上游。

## 角色卡语法

```
武器|等级|外貌|招式1,招式2,招式3
```

* **武器**：`dao` 刀／`jian` 剑／`qiang` 枪／`gun` 棍／`bang` 棒／`nodachi` 太刀／`pu` 朴刀／
  `duangun` 短棍／`duanren` 短刃／`none` 空手（也可写中文：刀/剑/枪/棍/棒/太刀/空手…）
* **等级** 1~9：决定力量、速度、反应、机动（跳跃／踏墙／飞行／悬停／落地冲击波）
* **外貌**：一句话，写进提示词（发型、服装、兵器持法）
* **招式**：可空。招式名会在**招式库**里查：库里有的直接用（带准备/出招/华丽效果/时间/距离）；
  库里没有的**自动入库**（按兵器与弧线生成华丽描述），并记住，下次同名直接调用。

示例：

```text
太刀|7|男性，黑发披散，黑色武士劲装，双手持野太刀|过肩劈,横扫,突刺
刀|5|男性，灰发束髻，靛蓝汉服武袍，右手持雁翎单刀|撩刀,反手削
空手|9|青年，白衣，赤足|寸拳,标指,鞭腿
```

## 命令行用法（不用 ComfyUI）

内核是独立可用的（Node 18+）：

```bash
# 自检：内核/规则/体检/LTX/招式库是否齐全
node sim3d/cli.js '{"op":"selftest"}'

# 跑一场（角色卡同款语法），输出提示词+证据+时间轴+审计+招式库统计
node sim3d/cli.js '{"op":"simulate","seed":7,"duration":10,
  "fighterA":"太刀|7|男性，黑发披散|过肩劈,横扫","fighterB":"刀|5|灰发束髻|撩刀",
  "scene":"雨夜长街，灯笼暖光"}'

# 招式库：统计 / 按兵器与等级筛 / 取一条 / 新增
node sim3d/cli.js '{"op":"moves","moveOp":"stats"}'
node sim3d/cli.js '{"op":"moves","moveOp":"list","weapon":"dao","tier":6}'
node sim3d/cli.js '{"op":"moves","moveOp":"get","name":"降龙十八掌"}'
node sim3d/cli.js '{"op":"moves","moveOp":"add","name":"试招·雨夜斩","effect":"一刀劈开雨幕"}'

# LTX 2.5 单段散文；提示词体检；模板库
node sim3d/cli.js '{"op":"ltx25","paradigm":"multi","shotList":[{"camera":"胸口高度手持跟拍中景","action":"刀客横扫，剑客格挡后反击"}]}'
node sim3d/cli.js '{"op":"lint","text":"...","mode":"final"}'
node sim3d/cli.js '{"op":"templates","id":"live_hand-duel-high"}'
```

Python 侧同样直接可用：

```python
from wushu_sim import bridge
r = bridge.run("simulate", seed=7, duration=10,
               fighterA="太刀|7|男性，黑发披散|过肩劈,横扫", fighterB="刀|5|灰发束髻|撩刀")
print(r["prompt"][:200])
print(r["moveLib"])          # 招式库统计：used/added/total
```

## 自检与排错

```bash
python tools/selftest.py                 python tools/selftest.py --src /path/to/simulator   # 临时改用开发目录里的内核
```

| 现象 | 原因与处理 |
|---|---|
| 桥接状态节点显示 `ok=False` | 缺 node 或缺内核：先 `node -v`，再设 `H3WUSHU_SIM_ROOT` 指向含 `sim3d/` 的目录 |
| `Invalid image file` | LoadImage 只认 input 根目录文件名（子目录要写 `子目录/文件名`） |
| 换了大模型后像没生效 | ComfyUI 缓存：本包会在候选里注入 nonce；手工排查可改一个无关键参数 |
| 中文乱码 | `.py` 用 UTF-8；Windows 下 `set PYTHONIOENCODING=utf-8` |

## 内核快照与升级

> **快照更新（2026-10-02）**：同步自 H3 武斗模拟器 v9.12 的最新内核 ——
> 新增/变更：**御空飞行档位**（角色卡「专飞」＝不论等级按飞行档结算：真悬停 / 空中招数 / 滞空预算）、
> **H 系机检 8 条**（首镜时间戳、时间码递增、`<Subject N>` 定义超限或未引用、否定式、画外声闭口证据、并列主体、悬空指代）、
> 招式/套路/模板库与 `combat-logic`、`pipeline`、`rig` 的同步更新。
> 快照清单与逐文件 sha256 见 `wushu_sim/js/MANIFEST.json`。

内核 JS 随包发布（`wushu_sim/js/`，含 `MANIFEST.json` 记录每个文件的 sha256 与版本）：

```bash
python tools/sync_js.py --src /path/to/simulator   # 单向只读同步（不改源目录）
python tools/sync_js.py --check                    # 只比对是否最新
```

也可以不拷贝，直接指向开发目录：

```bash
export H3WUSHU_SIM_ROOT=/path/to/simulator
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `H3WUSHU_SIM_ROOT` | JS 内核根目录（默认包内 `wushu_sim/js`） |
| `H3WUSHU_SIM_NODE` | node 可执行文件（默认从 PATH 找） |
| `H3WUSHU_SIM_TIMEOUT` | 单次调用超时秒数（默认 120） |

## 已知边界

* 内核按 **KO 结算**，实际时长可能略长于「时长秒」（该参数是目标成片时长）；
* `prompt` 里的 `lint_errors` 是原始素材的体检分，不是成品稿分数；
* 3D 预览（three.js）与文戏 AI 面板在**桌面版模拟器**里，不在本包；
* 招式库的"库外自动入库"依赖写权限：EXE/命令行写 `sim3d/moves-user.json`，浏览器写 localStorage。

## 许可与来源

* 本包：MIT（见 `LICENSE`）。
* `wushu_sim/js/` 是 **H3 武斗模拟器内核**的只读快照（同一作者作品）——由 `tools/sync_js.py`
  生成，`MANIFEST.json` 记录来源与校验值。内核不依赖本包，本包也不修改内核。

---

## 安装来源（本地 / Hugging Face / GitHub）

三种装法任选，装到 `ComfyUI/custom_nodes/` 下并重启 ComfyUI 即可。

**① 从 Hugging Face 克隆**（本仓库默认**私有**，需要你的 HF 令牌）

```bash
# 私有仓库要先带令牌（把 <TOKEN> 换成你的 HF read 令牌）
git clone https://Jojocodex:<TOKEN>@huggingface.co/Jojocodex/ComfyUI-H3-WushuSim.git
# 或者先登录一次，之后 git 会记住凭据
pip install -U huggingface_hub && huggingface-cli login
git clone https://huggingface.co/Jojocodex/ComfyUI-H3-WushuSim.git
```

**② 从 GitHub 克隆**（公开，无需令牌）

```bash
git clone https://github.com/314899085-dotcom/ComfyUI-H3-WushuSim.git
```

**③ 下载 ZIP**：在本页右上角 **Files** 里下载整仓打包，解压后放进 `custom_nodes/` 亦可。

**想把它变公开**：Hugging Face 仓库页 → **Settings** → *Change visibility* → Public（GitHub 侧的私有/公开在仓库 Settings → Danger Zone）。

## Install sources (local / Hugging Face / GitHub)

Pick any of the three; put the folder under `ComfyUI/custom_nodes/` and restart ComfyUI.

**① Clone from Hugging Face** (this repo is **private** by default — your HF token is required)

```bash
git clone https://Jojocodex:<TOKEN>@huggingface.co/Jojocodex/ComfyUI-H3-WushuSim.git
# or log in once and let git remember the credential
pip install -U huggingface_hub && huggingface-cli login
git clone https://huggingface.co/Jojocodex/ComfyUI-H3-WushuSim.git
```

**② Clone from GitHub** (public, no token needed)

```bash
git clone https://github.com/314899085-dotcom/ComfyUI-H3-WushuSim.git
```

**③ ZIP download**: use **Files** on this page to download the repo as an archive, then unzip into `custom_nodes/`.

**Make it public**: Hugging Face repo page → **Settings** → *Change visibility* → Public.


---

# English

**English** | [中文](#comfyui-h3-wushusim)

ComfyUI nodes for the **H3 Wushu Duel Simulator's** 60 Hz fight kernel: run a **deterministic** duel and get
**frame-by-frame evidence + an action-timing ledger + move-library lookups + prompts you can feed straight to a model**
(H3 shot shell / LTX 2.5 single-paragraph prose).

> Companion packs: **ComfyUI-H3-WushuBridge** (semantic bridge / prompt lint / training side) and
> **ComfyUI-JEV-Orchestrator** (JEV orchestrates the whole execution). This pack decides *what the fight is*.

## Features & how it works

Fight choreography is the hard part for video models: who attacks, at which second, how the recovery works,
what happens after a block. This pack plugs a **60 Hz continuous-time combat kernel** (metric space, fixed step,
swept-blade active frames, geometric hit detection, utility-based AI) into ComfyUI:

* **Same seed ⇒ bit-identical frames** — the prompt is *simulated*, not improvised;
* **Actions have duration** — windup / active / recovery are given as **ranges**, not instant flashes;
* **Moves come from a library** — 40+ built-in moves (each with prep, execution, flourish, timing, range, arc);
  unknown moves are **auto-catalogued and persisted**, then reused by name next time;
* **Zero GPU cost** — choreography is computed on CPU in milliseconds; the GPU only renders.

## The five nodes

| Node | Purpose | Outputs |
|---|---|---|
| **H3 Wushu Simulate (60 Hz kernel)** | One call returns prompt, frame evidence, action timing, logic audit, lint error count | `prompt` `evidence` `timeline_text` `audit` `lint_errors` |
| **H3 Wushu · LTX 2.5 Prompt** | Emits LTX 2.5-conformant **single-paragraph prose** (six elements, four cut items, in-line audio, no-music wording) | `prompt` `request_params` `verdict` |
| **H3 Wushu · Action Timing** | Per-action start→end (duration), phase totals (windup/active/recovery), idle & airborne share, counter-after-block rate | `timeline_text` |
| **H3 Wushu · Templates** | 208 fight + 154 drama skeletons (beat-by-beat, with the core fight logic inside) | `skeleton` `id_list` `count` |
| **H3 Wushu · Bridge Status** | Is node present, where is the kernel, does the self-test pass | `status` `ok` |

## Install

```text
Copy the whole ComfyUI-H3-WushuSim folder into:
    ComfyUI/custom_nodes/ComfyUI-H3-WushuSim/
Restart ComfyUI → nodes appear under “MiniMax H3/Wushu Sim”
```

Requirements: **Python standard library only** on the Python side; the kernel runs on **Node.js ≥ 18**.

```bash
conda install -y -c conda-forge nodejs
ln -sf "$(dirname "$(which node)")/node" /usr/local/bin/node   # make sure ComfyUI's PATH finds it
```

## Quick start (3 steps)

1. Add **H3 Wushu Simulate**, fill the fighter cards (`weapon|tier|look|moves`), pick seed and duration;
2. Wire `prompt` → **CLIPTextEncode** → your sampler; watch `timeline_text` / `audit` in a text node;
3. (Optional) `prompt` → **H3 Wushu Lint** (WushuBridge) for a score; `evidence` → **semantic bridge** to push logic into conditioning.

## Fighter card syntax

```
weapon|tier|look|move1,move2,move3
```

* **weapon**: `dao` `jian` `qiang` `gun` `bang` `nodachi` `pu` `duangun` `duanren` `none` (Chinese names also accepted)
* **tier** 1–9: power, speed, reaction, mobility (jump / wall-run / flight / hover / landing shockwave)
* **look**: one line of appearance, written into the prompt
* **moves**: optional. Names are looked up in the **move library**; unknown names are auto-catalogued with a flourish description.

## Command line (without ComfyUI)

```bash
node sim3d/cli.js '{"op":"selftest"}'
node sim3d/cli.js '{"op":"simulate","seed":7,"duration":10,"fighterA":"太刀|7|…|过肩劈,横扫","fighterB":"刀|5|…|撩刀"}'
node sim3d/cli.js '{"op":"moves","moveOp":"get","name":"降龙十八掌"}'
node sim3d/cli.js '{"op":"ltx25","paradigm":"multi","shotList":[{"camera":"chest-height handheld medium","action":"slash, block, counter"}]}'
```

```python
from wushu_sim import bridge
r = bridge.run("simulate", seed=7, duration=10, fighterA="太刀|7|…", fighterB="刀|5|…")
print(r["prompt"][:200], r["moveLib"])
```

## Self-test & troubleshooting

```bash
python tools/selftest.py
```

| Symptom | Fix |
|---|---|
| Status node shows `ok=False` | No node or no kernel: check `node -v`, set `H3WUSHU_SIM_ROOT` to a folder containing `sim3d/` |
| `Invalid image file` | `LoadImage` only accepts root-level names (sub-folder needs `subfolder/name`) |
| Change seems ignored | ComfyUI caching: this pack injects a nonce; nudge any harmless parameter when debugging |

## Kernel snapshot & upgrade

```bash
python tools/sync_js.py --src /path/to/simulator   # one-way read-only sync
python tools/sync_js.py --check                    # compare only
export H3WUSHU_SIM_ROOT=/path/to/simulator         # or point at the source tree
```

## Environment variables

`H3WUSHU_SIM_ROOT` (JS kernel root) · `H3WUSHU_SIM_NODE` (node binary) · `H3WUSHU_SIM_TIMEOUT` (seconds, default 120)

## Known limits

* The kernel settles on **KO**, so real length can exceed the requested duration;
* `lint_errors` on the `prompt` output grades **raw material**, not a finished prompt;
* The 3D preview (three.js) and the drama AI panel live in the **desktop simulator**, not in this pack.

## License & provenance

* This pack: MIT (see `LICENSE`).
* `wushu_sim/js/` is a read-only snapshot of the **H3 Wushu Simulator kernel** (same author), produced by
  `tools/sync_js.py`; `MANIFEST.json` records source and checksums. The kernel does not depend on this pack,
  and this pack never modifies the kernel.
