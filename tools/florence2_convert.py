# -*- coding: utf-8 -*-
"""把 microsoft/Florence-2-base 的旧版键名 checkpoint 转成 transformers 5.x 内置模型的键名。

背景:5.x 内置 Florence2ForConditionalGeneration 期望的是 HF 转换版权重
(model.* 前缀 + DaViT 算子名去掉 remote code 的 .fn. 容器包装 + image_projection 为
nn.Linear 权重),官方 microsoft 仓库仍是 remote-code 时代的旧键名,直接加载=全随机权重。
语言侧 builtin 复用原生 BartModel,键名 language_model.model.* → model.language_model.* 直通,
shared.weight 加载后经 tie 覆盖 encoder/decoder.embed_tokens 与 lm_head。

输出:D:/Pet10-tools/florence2/Florence-2-base-native/(model.safetensors + 配置文件,
config.json 补 image_token_id=1 即 <pad> 作图像占位符)。
校验不过(有键映射不上/形状不对)就拒绝落盘。
"""
import json, os, re, shutil, sys
import torch
from safetensors.torch import load_file, save_file
from transformers import Florence2Config, Florence2ForConditionalGeneration

SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\Pet10-tools\florence2\Florence-2-base"
DST = sys.argv[2] if len(sys.argv) > 2 else SRC + "-native"


def rename(k):
    if k.startswith("vision_tower.convs."):
        t = "model." + k
        return re.sub(r"convs\.(\d+)\.proj\.", r"convs.\1.conv.", t)
    if k.startswith("vision_tower."):
        t = "model." + k
        t = t.replace(".fn.dw", "").replace(".fn.net", "").replace(".fn.", ".")
        t = t.replace(".channel_attn.norm", ".norm1").replace(".window_attn.norm", ".norm1")
        t = re.sub(r"\.ffn\.norm(?=\.)", ".norm2", t)
        return t
    if k.startswith("image_pos_embed."):
        return "model.multi_modal_projector.image_position_embed." + k.split(".", 1)[1]
    if k == "image_projection":
        return "model.multi_modal_projector.image_projection.weight"
    if k.startswith(("image_proj_norm.", "visual_temporal_embed.")):
        return "model.multi_modal_projector." + k
    if k.startswith("language_model.model."):
        return "model.language_model." + k[len("language_model.model."):]
    if k.startswith("language_model."):
        return "model." + k
    return None


cfg = Florence2Config.from_pretrained(SRC)
with torch.device("meta"):
    model = Florence2ForConditionalGeneration._from_config(cfg)
tkeys = {k: tuple(v.shape) for k, v in model.state_dict().items()}

ckpt = load_file(os.path.join(SRC, "model.safetensors"))
out, unmatched, shape_bad = {}, [], []
for k, v in ckpt.items():
    t = rename(k)
    if t is None or t not in tkeys:
        unmatched.append(k)
        continue
    tv = tkeys[t]
    if tuple(v.shape) == tv:
        out[t] = v
    elif v.dim() == 2 and tuple(v.shape) == tv[::-1]:
        out[t] = v.t().contiguous()  # image_projection: 裸 Parameter[in,out] → nn.Linear[out,in]
    else:
        shape_bad.append((k, tuple(v.shape), t, tv))

# tie 键:builtin 经 shared 加载后自动覆盖;DROP:builtin 无此参数的零缓冲
TIED = {"lm_head.weight", "model.language_model.encoder.embed_tokens.weight",
        "model.language_model.decoder.embed_tokens.weight"}
DROP = {"language_model.final_logits_bias"}
covered = set(out)
missing = [k for k in tkeys if k not in covered and k not in TIED and "masked_bias" not in k]
unmatched = [k for k in unmatched if k not in DROP]

print(f"converted: {len(out)} | unmatched: {len(unmatched)} | shape_bad: {len(shape_bad)} | missing(non-tied): {len(missing)}")
for x in unmatched[:10]:
    print("  UNMATCHED:", x)
for x in shape_bad[:10]:
    print("  SHAPE:", x)
for x in missing[:10]:
    print("  MISSING:", x, tkeys.get(x))
if unmatched or shape_bad or missing:
    sys.exit("转换不完整,拒绝落盘")

os.makedirs(DST, exist_ok=True)
save_file(out, os.path.join(DST, "model.safetensors"), metadata={"format": "pt"})
print("saved model.safetensors", os.path.getsize(os.path.join(DST, "model.safetensors")) // 1024, "KB")

cfg_json = json.load(open(os.path.join(SRC, "config.json"), encoding="utf-8"))
cfg_json["image_token_id"] = 1  # <pad> 作图像占位符(位置被图像特征替换,行值不参与)
json.dump(cfg_json, open(os.path.join(DST, "config.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
for f in ("preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "vocab.json"):
    shutil.copy(os.path.join(SRC, f), os.path.join(DST, f))
print("DONE ->", DST)
