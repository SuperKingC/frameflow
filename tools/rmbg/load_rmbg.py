# -*- coding: utf-8 -*-
"""零 transformers 依赖加载官方 briaai/RMBG-1.4(briarmbg.py)。

官方 briarmbg.py 只用到 PreTrainedModel 的三件事:__init__(config) 调 super、
save_pretrained 相关钩子、config 传递;推理纯 nn.Module。这里用 stub 满足前两者,
绕开新版 transformers 的 all_tied_weights_keys 兼容问题(2026-10 实测 from_pretrained 报错)。
"""
import sys
import types
from pathlib import Path

import torch
import torch.nn as nn


class _StubPreTrainedModel(nn.Module):
    def __init__(self, config=None, *args, **kwargs):
        super().__init__()
        self.config = config


def _install_stubs(module):
    import transformers  # 仅取已有依赖;版本无关的 stub 注入

    module.PreTrainedModel = _StubPreTrainedModel
    if not hasattr(transformers, "PreTrainedModel"):
        transformers.PreTrainedModel = _StubPreTrainedModel


def load_bria_rmbg(weights_path, device):
    """返回加载完权重的 BriaRMBG(nn.Module,eval 模式,已 to(device))。"""
    code_dir = Path(weights_path).resolve().parent
    if str(code_dir) not in sys.path:
        sys.path.insert(0, str(code_dir))
    # MyConfig.py 依赖 PretrainedConfig:同样 stub
    import transformers
    if not hasattr(transformers, "PretrainedConfig"):
        class _StubConfig:
            def __init__(self, *a, **k):
                self.in_ch = 3
                self.out_ch = 1
        transformers.PretrainedConfig = _StubConfig

    import importlib.util
    # briarmbg.py 的 `from .MyConfig import` 是包内相对导入;单文件加载前改写成顶层导入。
    # 注意:SourceFileLoader.exec_module 会自行从磁盘重读原文件,替换必须走 compile+exec
    src = (code_dir / "briarmbg.py").read_text(encoding="utf-8")
    src = src.replace("from .MyConfig import", "from MyConfig import")
    spec = importlib.util.spec_from_file_location("briarmbg", str(code_dir / "briarmbg.py"))
    briarmbg = importlib.util.module_from_spec(spec)
    sys.modules["briarmbg"] = briarmbg
    _install_stubs(briarmbg)
    exec(compile(src, str(code_dir / "briarmbg.py"), "exec"), briarmbg.__dict__)

    model = briarmbg.BriaRMBG()
    state = torch.load(str(weights_path), map_location="cpu", weights_only=True)
    missing, unexpected = model.load_state_dict(state, strict=False)  # 官方权重允许少量非推理键
    if missing:
        raise RuntimeError(f"RMBG-1.4 权重缺键: {missing[:4]}…(共 {len(missing)})")
    model.to(device).eval()
    return model