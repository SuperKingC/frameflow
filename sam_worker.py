# -*- coding: utf-8 -*-
"""SAM2 交互分割 worker(FrameFlow 图层分离 v2)。

由 FrameFlow 的 server.py 用 miniapp-kit 的 venv python 启动
(需 torch+sam2,权重走环境变量 SAM2_CHECKPOINT;hiera_large 走 SAM2_CHECKPOINT_LARGE,
缺省自动找 sam2.1_hiera_small.pt 同目录的 sam2.1_hiera_large.pt)。
模型常驻:同档位同图只 set_image 一次,后续逐请求点/框提示分割,单次亚秒级;
CUDA 下全程 bfloat16 autocast(官方 demo 同款,省显存提速度)。单槽换档:
切换 small/large 会重建 predictor(换档后首图重新编码,属预期)。

stdio 协议(每行一个 JSON):
  -> {"cmd":"ping"}                                   <- {"ok":true,"device":"cuda","tiers":["large","small"]}
  -> {"cmd":"load_image","image_b64":"...","model":"small|large"}
      <- {"ok":true,"width":w,"height":h}
  -> {"cmd":"segment","points":[[x,y],...],"labels":[1|0,...],"box":[x0,y0,x1,y1] 或 null}
      <- {"ok":true,"score":0.95,"area":1234,"mask_b64":"..."}  # 单通道 PNG,255=选中
      # 框提示:points 可为空,box 单独成提示,此时 multimask_output=False(一次钉死目标)
  -> {"cmd":"quit"}                                   <- 进程退出
"""
import base64
import hashlib
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

# 自动加载仓库根 .env(与 kit matting 同规则:进程环境变量优先)
_ENV = Path(__file__).resolve().parent.parent / "miniapp-kit" / ".env"
if _ENV.exists():
    for _line in _ENV.read_text(encoding="utf-8").splitlines():
        _m = __import__("re").match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", _line)
        if _m and _m.group(1) not in os.environ:
            os.environ[_m.group(1)] = _m.group(2).strip().strip("'\"")

import torch
DEVICE = "cuda" if (torch.cuda.is_available() and os.environ.get("FORCE_CPU") != "1") else "cpu"
_BF16 = DEVICE == "cuda" and torch.cuda.is_bf16_supported()

_CKPT_SMALL = os.environ.get("SAM2_CHECKPOINT", "")


def _large_ckpt():
    p = os.environ.get("SAM2_CHECKPOINT_LARGE", "")
    if p:
        return p
    if _CKPT_SMALL:
        sib = Path(_CKPT_SMALL).with_name("sam2.1_hiera_large.pt")
        if sib.exists():
            return str(sib)
    return ""


TIERS = {
    "small": ("configs/sam2.1/sam2.1_hiera_s.yaml", _CKPT_SMALL,
              "hiera_small 权重未找到(检查 SAM2_CHECKPOINT)"),
    "large": ("configs/sam2.1/sam2.1_hiera_l.yaml", _large_ckpt(),
              "hiera_large 权重未找到:从 https://hf-mirror.com/facebook/sam2.1-hiera-large "
              "下载 sam2.1_hiera_large.pt 放到 sam2.1_hiera_small.pt 同目录(或设 SAM2_CHECKPOINT_LARGE)"),
}

_predictor = None
_tier = None
_sig = None


def _autocast():
    return torch.autocast("cuda", dtype=torch.bfloat16, enabled=_BF16)


def _build(tier):
    cfg, ckpt, miss = TIERS[tier]
    if not ckpt or not Path(ckpt).exists():
        raise RuntimeError(miss)
    return SAM2ImagePredictor(build_sam2(cfg, ckpt, device=DEVICE))


def load_image(image_b64, model="small"):
    global _predictor, _tier, _sig
    if model not in TIERS:
        raise RuntimeError(f"未知模型档位: {model}")
    raw = base64.b64decode(image_b64)
    sig = hashlib.md5(raw).hexdigest()  # 内容指纹;v1 用字节数判缓存,同长不同图会出错误掩码
    if _predictor is None or _tier != model:
        if _predictor is not None:
            del _predictor  # 单槽切换:换档重建,避免双模型常驻挤爆小显存
            _predictor = None
            if DEVICE == "cuda":
                torch.cuda.empty_cache()
        _predictor = _build(model)
        _tier = model
        _sig = None
    if _sig != sig:
        with _autocast():
            _predictor.set_image(np.array(Image.open(io.BytesIO(raw)).convert("RGB")))
        _sig = sig
    img = Image.open(io.BytesIO(raw))
    return {"ok": True, "width": img.width, "height": img.height}


def segment(points, labels, box=None):
    if _predictor is None:
        raise RuntimeError("请先 load_image")
    box_arr = None
    if box and len(box) == 4:
        box_arr = np.array(box, dtype=np.float32)
    pts = np.array(points, dtype=np.float32).reshape(-1, 2)
    labels_arr = np.array(labels, dtype=np.int32)
    if not len(pts) and box_arr is None:
        raise RuntimeError("点/框提示为空")
    with _autocast():
        masks, scores, _ = _predictor.predict(
            point_coords=pts if len(pts) else None,
            point_labels=labels_arr if len(pts) else None,
            box=box_arr,
            multimask_output=box_arr is None)  # 框提示一次钉死目标,不再多路猜测
    i = int(np.argmax(scores))
    m = np.asarray(masks[i]).astype(bool)
    png = Image.fromarray((m * 255).astype(np.uint8), mode="L")
    buf = io.BytesIO()
    png.save(buf, "PNG", optimize=True)
    return {
        "ok": True,
        "score": round(float(scores[i]), 3),
        "area": int(m.sum()),
        "mask_b64": base64.b64encode(buf.getvalue()).decode(),
    }


def main():
    if not _CKPT_SMALL:
        print(json.dumps({"ok": False, "error": "SAM2_CHECKPOINT 未设置"}), flush=True)
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "ping":
                resp = {"ok": True, "device": DEVICE, "tiers": sorted(TIERS)}
            elif cmd == "load_image":
                resp = load_image(req["image_b64"], req.get("model") or "small")
            elif cmd == "segment":
                resp = segment(req.get("points") or [], req.get("labels") or [], req.get("box"))
            elif cmd == "quit":
                break
            else:
                resp = {"ok": False, "error": f"未知命令: {cmd}"}
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
