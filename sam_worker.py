# -*- coding: utf-8 -*-
"""SAM2 交互分割 worker(FrameFlow 图层分离 v1)。

由 FrameFlow 的 server.py 用 miniapp-kit 的 venv python 启动
(需 torch+sam2,权重走环境变量 SAM2_CHECKPOINT,与 matting/solid_bg_matting.py 的 sam2 方法同源)。
模型常驻内存:同一张图只 set_image 一次,后续逐请求点提示分割,单次亚秒级。

stdio 协议(每行一个 JSON):
  -> {"cmd":"ping"}                                   <- {"ok":true}
  -> {"cmd":"load_image","image_b64":"..."}           <- {"ok":true,"width":w,"height":h}
  -> {"cmd":"segment","points":[[x,y],...],"labels":[1|0,...]}
      <- {"ok":true,"score":0.95,"area":1234,"mask_b64":"..."}  # 单通道 PNG,255=选中
  -> {"cmd":"quit"}                                   <- 进程退出
"""
import base64
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

CKPT = os.environ.get("SAM2_CHECKPOINT", "")
import torch
DEVICE = "cuda" if (torch.cuda.is_available() and os.environ.get("FORCE_CPU") != "1") else "cpu"
CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"

_predictor = None
_sig = None


def load_image(image_b64):
    global _predictor, _sig
    raw = base64.b64decode(image_b64)
    sig = str(len(raw))
    if _predictor is None or _sig != sig:
        if _predictor is None:
            _predictor = SAM2ImagePredictor(build_sam2(CONFIG, CKPT, device=DEVICE))
        _predictor.set_image(np.array(Image.open(io.BytesIO(raw)).convert("RGB")))
        _sig = sig
    img = Image.open(io.BytesIO(raw))
    return {"ok": True, "width": img.width, "height": img.height}


def segment(points, labels):
    if _predictor is None:
        raise RuntimeError("请先 load_image")
    pts = np.array(points, dtype=np.float32)
    if pts.ndim == 1:
        pts = pts.reshape(1, 2)
    labels_arr = np.array(labels, dtype=np.int32)
    masks, scores, _ = _predictor.predict(
        point_coords=pts, point_labels=labels_arr, multimask_output=True)
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
    if not CKPT:
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
                resp = {"ok": True, "device": DEVICE}
            elif cmd == "load_image":
                resp = load_image(req["image_b64"])
            elif cmd == "segment":
                resp = segment(req["points"], req["labels"])
            elif cmd == "quit":
                break
            else:
                resp = {"ok": False, "error": f"未知命令: {cmd}"}
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()