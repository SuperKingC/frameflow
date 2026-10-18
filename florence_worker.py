# -*- coding: utf-8 -*-
"""Florence-2 语义拆件 worker(FrameFlow 图层分离 v3)。

由 server.py 用 matting venv python 启动(需 transformers 5.x + torch,模型常驻 fp16 ~0.5GB 显存)。
权重: FLORENCE2_DIR(tools/florence2_convert.py 转换出的 native 键名版;
加载配方与 tools/florence2_probe.py 一致,经四任务实测)。

stdio 协议(每行一个 JSON):
  -> {"cmd":"ping"}                          <- {"ok":true,"device":"cuda","model":"Florence-2-base"}
  -> {"cmd":"load_image","image_b64":"..."}   <- {"ok":true,"width":w,"height":h}
      # 同图(md5)重复 load 只换引用不重预处理
  -> {"cmd":"instances"}                      <- {"ok":true,"instances":[{"label","bbox":[x1,y1,x2,y2],"task":"od|dense"}]}
      # OD + DENSE_REGION_CAPTION 两路生成合并;>98% 全图框与 <8px 碎框剔除
  -> {"cmd":"ground","phrase":"dog"}          <- {"ok":true,"phrase":"...","instances":[...]}
  -> {"cmd":"quit"}
"""
import base64
import hashlib
import io
import json
import os
import re
import sys
from pathlib import Path

# 自动加载仓库根 .env(与 sam_worker 同规则:进程环境变量优先)
_ENV = Path(__file__).resolve().parent.parent / "miniapp-kit" / ".env"
if _ENV.exists():
    for _line in _ENV.read_text(encoding="utf-8").splitlines():
        _m = __import__("re").match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", _line)
        if _m and _m.group(1) not in os.environ:
            os.environ[_m.group(1)] = _m.group(2).strip().strip("'\"")

MD = os.environ.get("FLORENCE2_DIR", "")
if not MD or not Path(MD).is_dir():
    print(json.dumps({"ok": False,
                      "error": "FLORENCE2_DIR 未设置或目录不存在(先运行 tools/florence2_convert.py)"}), flush=True)
    sys.exit(0)

import torch
from PIL import Image
import transformers
from transformers import AutoTokenizer, CLIPImageProcessor
try:
    from transformers import Florence2ForConditionalGeneration
except ImportError:
    from transformers.models.florence2.modeling_florence2 import Florence2ForConditionalGeneration
from transformers.models.florence2.processing_florence2 import Florence2PostProcessor

DEVICE = "cuda" if (torch.cuda.is_available() and os.environ.get("FORCE_CPU") != "1") else "cpu"

EXTENSION_TOKENS = (
    ["<od>", "</od>", "<ocr>", "</ocr>"]
    + [f"<loc_{i}>" for i in range(1000)]
    + ["<cap>", "</cap>", "<ncap>", "</ncap>", "<dcap>", "</dcap>",
       "<grounding>", "</grounding>", "<seg>", "</seg>", "<sep>",
       "<region_cap>", "</region_cap>", "<region_to_desciption>", "</region_to_desciption>",
       "<proposal>", "</proposal>", "<poly>", "</poly>", "<and>"]
)

OD_PROMPT = "Locate the objects with category name in the image."
DENSE_PROMPT = "Locate the objects in the image, with their descriptions."
GROUND_PROMPT = "Locate the phrases in the caption: {input}"
IMG_TOKEN_ID = 1  # <pad> 作图像占位符(config.json 已设,生成时被图像特征替换)
IMAGE_SEQ_LEN = 577

PARSE_CONFIG = {"description_with_bboxes": {}, "phrase_grounding": {}, "pure_text": {},
                "ocr": {"PATTERN": None}}

_tok = _imgp = _model = _pp = None
_img_sig = None
_pv = None          # 预处理后的 pixel_values(fp16, cuda)
_img_size = None    # (w, h)


def _load():
    global _tok, _imgp, _model, _pp
    if _model is not None:
        return
    _tok = AutoTokenizer.from_pretrained(MD)
    _tok.add_tokens(EXTENSION_TOKENS, special_tokens=True)
    _imgp = CLIPImageProcessor.from_pretrained(MD)
    dv = "dtype" if int(transformers.__version__.split(".")[0]) >= 5 else "torch_dtype"
    _model = Florence2ForConditionalGeneration.from_pretrained(MD, **{dv: torch.float16})
    _model.config.image_token_id = IMG_TOKEN_ID
    _model = _model.to(DEVICE).eval()
    _pp = Florence2PostProcessor(config=PARSE_CONFIG, tokenizer=_tok)


def _gen(prompt, max_new, parse_type):
    ids = _tok(prompt, add_special_tokens=True)["input_ids"]
    input_ids = torch.tensor([IMG_TOKEN_ID] * IMAGE_SEQ_LEN + ids)[None].to(DEVICE)
    with torch.inference_mode():
        gen = _model.generate(input_ids=input_ids,
                              attention_mask=torch.ones_like(input_ids),
                              pixel_values=_pv,
                              max_new_tokens=max_new, num_beams=3, do_sample=False)
    text = _tok.batch_decode(gen, skip_special_tokens=False)[0]
    return _pp(text=text, image_size=_img_size, parse_tasks=[parse_type])[parse_type]


def _clean(instances, task):
    """剔空名/碎框/近全图框,bbox 转整数。"""
    w, h = _img_size
    area_img = w * h
    out = []
    for inst in instances:
        label = (inst.get("cat_name") or "").strip()
        boxes = inst.get("bbox") or []
        if isinstance(boxes[0] if boxes else None, list):
            pass  # phrase_grounding: 每条可带多框
        else:
            boxes = [boxes]
        for b in boxes:
            try:
                x1, y1, x2, y2 = [int(round(float(v))) for v in b[:4]]
            except Exception:
                continue
            x1, x2 = min(x1, x2), max(x1, x2)
            y1, y2 = min(y1, y2), max(y1, y2)
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if not label or x2 - x1 < 8 or y2 - y1 < 8:
                continue
            if (x2 - x1) * (y2 - y1) > 0.98 * area_img:
                continue  # 近全图框对拆件无意义
            out.append({"label": label, "bbox": [x1, y1, x2, y2], "task": task})
    return out


def load_image(image_b64):
    global _img_sig, _pv, _img_size
    raw = base64.b64decode(image_b64)
    sig = hashlib.md5(raw).hexdigest()
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if _img_sig != sig:
        _load()
        _pv = _imgp(images=img, return_tensors="pt")["pixel_values"].to(
            torch.float16 if DEVICE == "cuda" else torch.float32).to(DEVICE)
        _img_size = (img.width, img.height)
        _img_sig = sig
    return {"ok": True, "width": img.width, "height": img.height}


def instances():
    # OD + DENSE 两路合并;同名去重
    od = _clean(_gen(OD_PROMPT, 512, "description_with_bboxes"), "od")
    dense = _clean(_gen(DENSE_PROMPT, 512, "description_with_bboxes"), "dense")
    merged, seen = [], set()
    for inst in sorted(od + dense, key=lambda x: -((x["bbox"][2] - x["bbox"][0]) * (x["bbox"][3] - x["bbox"][1]))):
        key = inst["label"].lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(inst)
    return {"ok": True, "instances": merged[:30]}


def ground(phrase):
    phrase = (phrase or "").strip()
    if not phrase:
        return {"ok": False, "error": "phrase 为空"}
    res = _gen(GROUND_PROMPT.format(input=phrase), 256, "phrase_grounding")
    out = []
    for inst in res:
        label = (inst.get("cat_name") or phrase).strip() or phrase
        boxes = inst.get("bbox") or []
        if boxes and isinstance(boxes[0], list):
            for b in boxes:
                out.append({"label": label, "bbox": b, "task": "ground"})
        elif boxes:
            out.append({"label": label, "bbox": boxes, "task": "ground"})
    out = _clean_gen(out)
    return {"ok": True, "phrase": phrase, "instances": out[:20]}


def _clean_gen(instances):
    """ground 路径已展平,复用碎框/全图剔除(不带 task 改写)。"""
    w, h = _img_size
    area_img = w * h
    out = []
    for inst in instances:
        x1, y1, x2, y2 = inst["bbox"]
        x1, x2 = max(0, min(x1, x2)), min(w, max(x1, x2))
        y1, y2 = max(0, min(y1, y2)), min(h, max(y1, y2))
        if x2 - x1 < 8 or y2 - y1 < 8 or (x2 - x1) * (y2 - y1) > 0.98 * area_img:
            continue
        out.append({"label": inst["label"], "bbox": [x1, y1, x2, y2], "task": "ground"})
    return out


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "ping":
                resp = {"ok": True, "device": DEVICE, "model": "Florence-2-base"}
            elif cmd == "load_image":
                resp = load_image(req["image_b64"])
            elif cmd == "instances":
                if _pv is None:
                    raise RuntimeError("请先 load_image")
                resp = instances()
            elif cmd == "ground":
                if _pv is None:
                    raise RuntimeError("请先 load_image")
                resp = ground(req.get("phrase"))
            elif cmd == "quit":
                break
            else:
                resp = {"ok": False, "error": f"未知命令: {cmd}"}
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        print(json.dumps(resp, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()