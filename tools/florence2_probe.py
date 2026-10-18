# -*- coding: utf-8 -*-
"""Florence-2-base 四任务能力探测(v3: builtin 模型 + 手工 input_ids + builtin 后解析)。

加载配方(transformers 5.15 兼容,绕开 remote processor 的两个雷点):
  - tokenizer: AutoTokenizer(RobertaTokenizer) + 手工补 1024 个扩展 token
    (官方 processor 添加顺序: od/ocr×4 + loc×1000 + cap..and×20 → id 50265..51088,
     与模型训练词表 51289 完全对齐)
  - 图像: CLIPImageProcessor(768×768 bicubic + ImageNet 归一化, 与官方一致)
  - 模型: 5.x 内置 Florence2ForConditionalGeneration(原生支持该 checkpoint,
    按 input_ids==image_token_id 把占位符位置替换成图像特征)
  - 文本编码不走 processor: input_ids = [1]*577 + [0] + prompt_ids + [2]
    (1=<pad> 当图像占位符; prompt 文本不会出现 pad; 布局=图像特征前置,与训练一致)
  - 后解析: builtin Florence2PostProcessor 直接实例化(绕过 Processor 的
    tokenizer.image_token 检查; 反量化 (bin+0.5)*size/1000)

任务: <OD> / <DENSE_REGION_CAPTION> / <MORE_DETAILED_CAPTION> / <CAPTION_TO_PHRASE_GROUNDING>
用法: venv/python tools/florence2_probe.py [图片路径]
"""
import sys, os, json, time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

MD = os.environ.get("FLORENCE2_DIR") or r"D:\Pet10-tools\florence2\Florence-2-base-native"  # 转换版权重;可用 FLORENCE2_DIR 覆盖
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch
from PIL import Image
import transformers
from transformers import AutoTokenizer, CLIPImageProcessor
try:
    from transformers import Florence2ForConditionalGeneration
except ImportError:
    from transformers.models.florence2.modeling_florence2 import Florence2ForConditionalGeneration
from transformers.models.florence2.processing_florence2 import Florence2PostProcessor

# 官方扩展 token(顺序 = remote processor __init__,对齐训练 id)
EXTENSION_TOKENS = (
    ["<od>", "</od>", "<ocr>", "</ocr>"]
    + [f"<loc_{i}>" for i in range(1000)]
    + ["<cap>", "</cap>", "<ncap>", "</ncap>", "<dcap>", "</dcap>",
       "<grounding>", "</grounding>", "<seg>", "</seg>", "<sep>",
       "<region_cap>", "</region_cap>", "<region_to_desciption>", "</region_to_desciption>",
       "<proposal>", "</proposal>", "<poly>", "</poly>", "<and>"]
)

# 指令句(官方 _construct_prompts 映射;任务 token 本身不在词表,是 BPE 明文)
PROMPTS_NO_INPUT = {
    "<OD>": "Locate the objects with category name in the image.",
    "<DENSE_REGION_CAPTION>": "Locate the objects in the image, with their descriptions.",
    "<CAPTION>": "What does the image describe?",
    "<DETAILED_CAPTION>": "Describe in detail what is shown in the image.",
    "<MORE_DETAILED_CAPTION>": "Describe in detail what is shown in the image.",
}
PROMPTS_WITH_INPUT = {
    "<CAPTION_TO_PHRASE_GROUNDING>": "Locate the phrases in the caption: {input}",
}
TASK_PARSE_TYPE = {
    "<OD>": "description_with_bboxes",
    "<DENSE_REGION_CAPTION>": "description_with_bboxes",
    "<MORE_DETAILED_CAPTION>": "pure_text",
    "<CAPTION_TO_PHRASE_GROUNDING>": "phrase_grounding",
}

IMAGE_SEQ_LEN = 577
IMG_TOKEN_ID = 1  # <pad> 当图像占位符 id(builtin 模型按它替换图像特征)

PARSE_CONFIG = {
    "description_with_bboxes": {},
    "phrase_grounding": {},
    "pure_text": {},
    "ocr": {"PATTERN": None},
}


def load():
    tok = AutoTokenizer.from_pretrained(MD)
    added = tok.add_tokens(EXTENSION_TOKENS, special_tokens=True)
    assert added == 1024 and len(tok) == 51289, (added, len(tok))
    assert tok.convert_tokens_to_ids("<od>") == 50265, tok.convert_tokens_to_ids("<od>")
    assert tok.convert_tokens_to_ids("<loc_999>") == 51268, tok.convert_tokens_to_ids("<loc_999>")
    print(f"[tok] {type(tok).__name__} +1024 扩展token, 词表 {len(tok)} ✓")

    imgp = CLIPImageProcessor.from_pretrained(MD)
    print(f"[imgproc] {type(imgp).__name__} size={imgp.size}")

    dv = "dtype" if int(transformers.__version__.split(".")[0]) >= 5 else "torch_dtype"
    model = Florence2ForConditionalGeneration.from_pretrained(MD, **{dv: torch.float16})
    model.config.image_token_id = IMG_TOKEN_ID
    model = model.cuda().eval()
    print(f"[model] {type(model).__name__} fp16 cuda ✓ vram={torch.cuda.memory_allocated()/1e9:.2f}GB")

    pp = Florence2PostProcessor(config=PARSE_CONFIG, tokenizer=tok)
    return tok, imgp, model, pp


def run(model, tok, imgp, pp, image, task, phrase="", max_new=1024, beams=3):
    prompt = (PROMPTS_WITH_INPUT[task].format(input=phrase) if task in PROMPTS_WITH_INPUT
              else PROMPTS_NO_INPUT[task])
    ids = tok(prompt, add_special_tokens=True)["input_ids"]
    input_ids = torch.tensor([IMG_TOKEN_ID] * IMAGE_SEQ_LEN + ids)[None].cuda()
    am = torch.ones_like(input_ids)
    pv = imgp(images=image, return_tensors="pt")["pixel_values"].to(torch.float16).cuda()
    t0 = time.time()
    with torch.inference_mode():
        gen = model.generate(input_ids=input_ids, attention_mask=am, pixel_values=pv,
                             max_new_tokens=max_new, num_beams=beams, do_sample=False)
    secs = time.time() - t0
    text = tok.batch_decode(gen, skip_special_tokens=False)[0]
    parsed = pp(text=text, image_size=(image.width, image.height),
                parse_tasks=[TASK_PARSE_TYPE[task]])[TASK_PARSE_TYPE[task]]
    return prompt, text, parsed, secs


def show(task, prompt, text, parsed, secs):
    print(f"\n== {task}  ({secs:.2f}s)")
    print("   prompt:", prompt[:100])
    print("   raw:", text[:240])
    if isinstance(parsed, str):
        print("   parsed:", parsed[:400])
        return
    # list[instance]:{bbox, cat_name};phrase_grounding 的 bbox 是框列表
    flat = []
    for inst in parsed:
        bboxes = inst["bbox"] if isinstance(inst["bbox"][0], list) else [inst["bbox"]]
        for b in bboxes:
            flat.append((inst["cat_name"], b))
    print(f"   parsed: {len(flat)} boxes")
    for lb, b in flat[:20]:
        print(f"     {lb}  {[round(x) for x in b]}")


def main():
    img_path = sys.argv[1] if len(sys.argv) > 1 else r"D:\Mine\frameflow\testdata\duoli_ref\duoli_2.jpg"
    image = Image.open(img_path).convert("RGB")
    print(f"[image] {img_path} {image.width}x{image.height}")
    tok, imgp, model, pp = load()

    # 冒烟:OD 小输出先验证链路
    try:
        show("<OD>", *run(model, tok, imgp, pp, image, "<OD>", max_new=256, beams=1))
    except Exception as e:
        import traceback; traceback.print_exc()
        print("SMOKE FAILED, abort"); return

    dense_labels = None
    for task, kw in [("<DENSE_REGION_CAPTION>", {}), ("<MORE_DETAILED_CAPTION>", {})]:
        try:
            prompt, text, parsed, secs = run(model, tok, imgp, pp, image, task, **kw)
            show(task, prompt, text, parsed, secs)
            if task == "<DENSE_REGION_CAPTION>" and isinstance(parsed, list) and parsed:
                dense_labels = [i["cat_name"] for i in parsed]
        except Exception as e:
            import traceback; traceback.print_exc()

    phrase = (dense_labels[0] if dense_labels else "the dog")[:60]
    try:
        show("<CAPTION_TO_PHRASE_GROUNDING>",
             *run(model, tok, imgp, pp, image, "<CAPTION_TO_PHRASE_GROUNDING>", phrase=phrase, max_new=256))
    except Exception as e:
        import traceback; traceback.print_exc()

    print("\nPROBE DONE")


if __name__ == "__main__":
    main()
