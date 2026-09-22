# 部署记录（云主机实测）

**主机**：AutoDL `autodl-pro-788183ae9f23`（RTX 5090 32GB）· `connect.westd.seetacloud.com:50530`
**ComfyUI**：`/root/ComfyUI`，端口 `6006`（`/root/host3_restart_comfy.sh` 重启，日志 `/root/comfy2.log`）
**Python**：`/root/miniconda3/bin/python`（conda 26.7.0）

## 一、部署结果（2026-09-22 实测）

| 项目 | 结果 |
|---|---|
| Node（WushuSim 的 Node 桥依赖） | **conda-forge 装 nodejs v22.23.2** + 软链 `/usr/local/bin/node` |
| ComfyUI 能否找到 node | `shutil.which('node') = /usr/local/bin/node` ✓ |
| `ComfyUI-H3-WushuSim` | 已装；包内自检 **16/16**；5 个节点注册 ✓ |
| `ComfyUI-JEV-Orchestrator` | 已装；`test_api` **21/21**、`test_orchestrator` **29/29**；5 个节点注册 ✓ |
| 服务器节点总数 | **2907**（其中 2889 个节点有可调参数 → 这就是 JEV 的候选空间） |
| 已有 H3Wushu* 节点 | 15 个（WushuBridge 10 + WushuSim 5，未受影响） |
| 日志错误 | 本包相关 **0 条** |
| JEV 干跑（真服务器） | 基线 0.800 → 最佳 0.900（+0.100）｜8 轮｜旋钮枚举正确（text/cfg/denoise/sampler_name/scheduler/seed/steps/filename_prefix，连线型输入被排除） |

## 二、一条命令重新部署（新机器/重置后）

```bash
python _deploy/rsh.py --put ComfyUI-H3-WushuSim-0.1.0.zip /tmp/
python _deploy/rsh.py --put ComfyUI-JEV-Orchestrator-0.1.0.zip /tmp/
python _deploy/rsh.py --put _deploy/bootstrap_remote.sh /tmp/
python _deploy/rsh.py "bash /tmp/bootstrap_remote.sh"
```

`bootstrap_remote.sh` 会自动：装 node（conda-forge + 软链）→ 解压装两个包 →
跑离线自检 → 重启 ComfyUI → 用 `/object_info` 列出 10 个节点。

## 三、踩过的坑（都已在脚本里修掉）

1. **云主机没有 node** → WushuSim 的 Node 桥起不来。用 conda-forge 装（1~2 分钟），
   并**软链到 `/usr/local/bin/node`**：否则 ComfyUI 进程的 PATH 里没有 conda 目录，
   `shutil.which('node')` 返回 None（实测确认过）。
2. **`.sh` 带 BOM → `#!/bin/bash: No such file or directory`**：Windows 下生成的脚本必须
   写成 **UTF-8 无 BOM + LF**（本仓库的 `_deploy/*.sh` 已统一）。
3. **PowerShell 写 zip 用反斜杠做分隔符**（`unzip` 会给 warning 但仍能解开）；
   解压后目录名要对得上，否则 `find -maxdepth 2 -type d -name ...` 找不到。
4. PowerShell 里嵌套引号传远端命令容易崩 → 一律用 `rsh.py --script`（上传脚本再执行）。

## 四、远端已有可用的本地模型（给 JEV 裁判挑）

| 位置 | 模型 | 参数量 | 能当什么裁判 |
|---|---|---|---|
| `models/LLM/Florence-2-base` | Florence-2-base | 0.23B | 小 VLM：看图描述/检测（快，但需要专用后处理） |
| `models/text_encoders/gemma_2_2b_it_elm_bf16.safetensors` | Gemma-2-2B-it | **2B** | 文本裁判（≤2B 约束内） |
| `models/text_encoders/gemma4_e2b_it_bf16.safetensors` | Gemma-3n E2B | **≈2B** | 文本裁判 |
| `models/LLM/MiniCPMv2_6-prompt-generator` | MiniCPM-V 2.6 | 2.8B | 略超 2B |
| `models/LLM/MiniCPM-V-4-int4`、`Qwen2.5-VL-7B`、`Qwen3-4B/8B` | — | ≥4B | 超出自定上限（可选用） |

**接入方式**（三选一，随时可换）：

* **A. Ollama**（推荐）：`ollama` + `gemma2:2b` 或 `qwen2.5:1.5b`，`JEV_OLLAMA_URL` 指过去即可；
  本插件的 `llm` / `vlm` 裁判已原生支持（含图片）。
* **B. 走 ComfyUI 自身的 LLM 节点**（`ComfyUI-LLMSuite` 已装 + `models/LLM` 里的模型）：
  把 LLM 调用做成子图提交，零额外安装，但每轮多一次图执行。
* **C. transformers 直接加载** `gemma_2_2b_it`：需要 tokenizer/config（`text_encoders` 里只有权重）。
