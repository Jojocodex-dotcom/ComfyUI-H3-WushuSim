# -*- coding: utf-8 -*-
"""ComfyUI-H3-WushuSim：把「H3 武斗模拟器」的 60Hz 内核做成 ComfyUI 节点。

与 ``ComfyUI-H3-WushuBridge``（语义桥/体检/训练侧）配合使用：本包负责**打什么**，
它负责**怎么说得像武打**。
"""

from .wushu_sim.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS  # noqa: F401

__version__ = "0.1.0"
WEB_DIRECTORY = None

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "__version__"]
