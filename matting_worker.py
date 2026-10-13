# -*- coding: utf-8 -*-
"""AI 抠图 worker(FrameFlow 抠图页「开始处理」)。

由 FrameFlow 的 server.py 用 matting venv python 启动(需 torch+einops+timm+
safetensors+cv2+transformers+rembg+onnxruntime+transparent-background,
即 miniapp-kit doctor 报告的 PYTHON_MATTING 环境 + rembg/transparent-background)。
模型常驻:每个模型首次请求时加载并驻留(CUDA),之后同进程内单张亚秒~秒级。

权重来源(BEN2 本地已有;其余首次使用时自动联网下载并缓存):
  BEN2        BEN2_WEIGHTS(kit 权重,BEN2_Base.safetensors,MIT)
  briaai      HuggingFace briaai/RMBG-1.4(转 HF 缓存)
  inspyrenet  transparent-background 包(GitHub Release best.pt)
  u2net       rembg(~/.u2net/u2net.onnx)
  isnet-anime rembg(~/.u2net/isnet-anime.onnx)

stdio 协议(每行一个 JSON):
  -> {"cmd":"ping"}                                    <- {"ok":true,"device":"cuda"}
  -> {"cmd":"matte","model":"ben2|briaai|inspyrenet|u2net|isnet-anime","image_b64":"..."}
       <- {"ok":true,"rgba_b64":"...","width":w,"height":h,"edge_px":n,"seconds":1.2}
  -> {"cmd":"quit"}                                    <- 进程退出
"""
import base64
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

# 首用下载/加载期间,第三方库的进度条与提示必须让路:stdout 只承载 JSON 协议,
# 全部重定向到 stderr(server 只读 stdout,stderr 丢弃)
sys.stdout, _protocol_stdout = sys.stderr, sys.stdout  # noqa: 先换再存,loaders 内 import 时生效
_REAL_STDOUT = _protocol_stdout

# 自动加载仓库根 .env(与 kit matting 同规则:进程环境变量优先)
_ENV = Path(__file__).resolve().parent.parent / "miniapp-kit" / ".env"
if _ENV.exists():
    for _line in _ENV.read_text(encoding="utf-8").splitlines():
        _m = __import__("re").match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", _line)
        if _m and _m.group(1) not in os.environ:
            os.environ[_m.group(1)] = _m.group(2).strip().strip("'\"")

WEIGHTS = os.environ.get("BEN2_WEIGHTS", "")
CODE_DIR = Path(os.environ.get("BEN2_CODE_DIR")
                or (Path(__file__).resolve().parent.parent / "miniapp-kit" / "matting"))

MODELS = ("ben2", "briaai", "inspyrenet", "u2net", "isnet-anime")

import torch
DEVICE = "cuda" if (torch.cuda.is_available() and os.environ.get("FORCE_CPU") != "1") else "cpu"

_loaded = {}  # model -> 各自的模型对象/会话


def _get(name):
    if name in _loaded:
        return _loaded[name]
    loader = _LOADERS[name]
    _loaded[name] = loader()
    return _loaded[name]


def _load_ben2():
    if not WEIGHTS or not Path(WEIGHTS).exists():
        raise RuntimeError(f"BEN2 权重未找到: {WEIGHTS or '(BEN2_WEIGHTS 未设置)'}(检查 miniapp-kit/.env)")
    if not (CODE_DIR / "BEN2.py").exists():
        raise RuntimeError(f"BEN2 代码未找到: {CODE_DIR / 'BEN2.py'}(可用 BEN2_CODE_DIR 指定)")
    sys.path.insert(0, str(CODE_DIR))
    from BEN2 import BEN_Base
    from safetensors.torch import load_file

    model = BEN_Base()
    p = Path(WEIGHTS)
    if p.suffix == ".safetensors":
        model.load_state_dict(load_file(str(p)), strict=True)  # 官方 loadcheckpoints 只认 .pth,safetensors 直接映射
    else:
        model.loadcheckpoints(str(p))
    model.to(DEVICE).eval()
    return model


def _load_briaai():
    # RMBG-1.4:不走 transformers AutoModel(新版不兼容官方自定义代码,实测报
    # all_tied_weights_keys),用 tools/rmbg/load_rmbg.py 的 stub 加载官方 nn.Module;
    # 权重 tools/rmbg/model.pth(hf-mirror 下载,176MB)
    code = Path(__file__).resolve().parent / "tools" / "rmbg"
    weights = code / "model.pth"
    if not weights.exists():
        raise RuntimeError(
            f"未找到 RMBG-1.4 模型: {weights}(从 https://hf-mirror.com/briaai/RMBG-1.4 下载 model.pth 放入 tools/rmbg/)")
    if str(code) not in sys.path:
        sys.path.insert(0, str(code))
    from load_rmbg import load_bria_rmbg
    model = load_bria_rmbg(weights, DEVICE)

    def prep(pil_img):
        # 官方 MyPipe.py 同款预处理:原始 0-255 双线性缩到 1024 → /255 → normalize(0.5/1.0)
        # (不是 ImageNet 均值方差;实测喂错归一化参数会让背景 alpha 抬到 10~40,全图半透明)
        import torch.nn.functional as F
        from torchvision.transforms.functional import normalize
        im = np.array(pil_img)
        t = torch.tensor(im, dtype=torch.float32).permute(2, 0, 1).unsqueeze(0)
        t = F.interpolate(t, size=(1024, 1024), mode="bilinear")
        t = torch.divide(t, 255.0)
        return normalize(t, [0.5, 0.5, 0.5], [1.0, 1.0, 1.0]).to(DEVICE)

    return {"model": model, "prep": prep}


def _load_inspyrenet():
    from transparent_background.Remover import Remover
    return Remover()  # 默认 base(InSPyReNet);权重首用自动下载


def _load_rembg(name):
    from rembg import new_session
    return new_session(name)


_LOADERS = {
    "ben2": _load_ben2,
    "briaai": _load_briaai,
    "inspyrenet": _load_inspyrenet,
    "u2net": lambda: _load_rembg("u2net"),
    "isnet-anime": lambda: _load_rembg("isnet-anime"),
}


def _rgba_from_alpha(img_rgb, alpha_u8):
    h, w = alpha_u8.shape[:2]
    rgba = np.dstack([np.array(img_rgb), alpha_u8])
    return Image.fromarray(rgba, "RGBA")


def matte(image_b64, model):
    started = time.time()
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    m = _get(model)
    if model == "ben2":
        with torch.no_grad():
            out = m.inference(img)
        rgba = out[0] if isinstance(out, list) else out
    elif model == "briaai":
        import torch.nn.functional as F
        x = m["prep"](img)
        with torch.no_grad():
            preds = m["model"](x)[0]  # 官方 forward 返回 ([6 个 sigmoid side], features)
        d1 = preds[0].cpu()
        pred = F.interpolate(d1, size=img.size[::-1], mode="bilinear", align_corners=False)
        pred = torch.squeeze(pred, 0).squeeze(0).numpy()
        # 官方 postprocess 同款 min-max 归一
        pred = (pred - pred.min()) / max(pred.max() - pred.min(), 1e-6)
        rgba = _rgba_from_alpha(img, (pred * 255).clip(0, 255).astype(np.uint8))
    elif model == "inspyrenet":
        rgba = m.process(img, type="rgba")
    else:  # u2net / isnet-anime(onnxruntime,CPU 推理)
        from rembg import remove
        rgba = remove(img, session=m)
    if rgba.mode != "RGBA":
        rgba = rgba.convert("RGBA")
    if rgba.size != img.size:
        rgba = rgba.resize(img.size, Image.LANCZOS)  # 保险:回原尺寸,保证前端画布逐像素对齐
    alpha = np.array(rgba.getchannel("A"))
    edge_px = int(((alpha > 8) & (alpha < 247)).sum())
    buf = io.BytesIO()
    rgba.save(buf, "PNG", optimize=True)
    return {
        "ok": True,
        "rgba_b64": base64.b64encode(buf.getvalue()).decode(),
        "width": rgba.width,
        "height": rgba.height,
        "edge_px": edge_px,
        "seconds": round(time.time() - started, 2),
    }


def main():
    out = _REAL_STDOUT  # 模块顶部已把 sys.stdout 换成 stderr(吞第三方日志);协议走保留的真实通道
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "ping":
                resp = {"ok": True, "device": DEVICE}
            elif cmd == "matte":
                model = req.get("model") or "ben2"
                if model not in MODELS:
                    resp = {"ok": False, "error": f"未知模型: {model}"}
                else:
                    resp = matte(req["image_b64"], model)
            elif cmd == "quit":
                break
            else:
                resp = {"ok": False, "error": f"未知命令: {cmd}"}
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        out.write(json.dumps(resp) + "\n")
        out.flush()


if __name__ == "__main__":
    main()