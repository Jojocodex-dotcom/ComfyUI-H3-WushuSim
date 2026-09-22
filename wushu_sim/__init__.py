# -*- coding: utf-8 -*-
"""wushu_sim —— H3 武斗模拟器的内核桥（ComfyUI 侧）。

* ``bridge``：调用 ``sim3d/cli.js``（Node 内核）的唯一入口，接口与后端解耦
* ``nodes`` ：5 个 ComfyUI 节点（模拟／LTX 2.5／动作时间账／模板库／状态）

后端可换：今天走 Node 桥，将来把内核移植成纯 Python 时，只要 ``bridge.run``
的行为不变，节点代码无需改动。
"""

from . import bridge  # noqa: F401
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS  # noqa: F401

__version__ = "0.1.0"

__all__ = ["bridge", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "__version__"]
