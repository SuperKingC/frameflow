# 小多利相似度攻坚:修正特征描述(田园犬相,非卷毛蓬松犬)+ 强模型 + 真实比例。
# 先 probe 两张(两个模型同提示词),人工比对参考照后再批量。
# 用法: python tools/duoli_likeness_probe.py
import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF_DIR = ROOT / "testdata" / "duoli_ref"
OUT_DIR = ROOT / "genwork" / "duoli_probe"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"

PROBE_MODELS = ["google/gemini-3-pro-image", "openai/gpt-5.4-image-2"]

STYLE = ("皮克斯式半写实渲染:保持真实犬类比例与结构,只做轻度萌化(眼睛可稍大一点,毛发稍柔),"
         "坐姿正面微微歪头,柔光棚拍,浅暖灰纯色背景")

PROMPT = (
    "Reference photos: 这三张照片是同一只真实的狗「小多利」——中华田园犬(土狗)混血,中型犬。"
    "必须保留的可识别特征:"
    "1) 毛色:驼色黄棕(鹿色),胸腹与四爪白色,眉间一条窄白线,吻部两侧白;"
    "2) 毛质:中长直毛不是卷毛,耳缘与胸前有羽状饰毛,尾巴蓬松上翘;"
    "3) 头型:狐狸相,瘦长不扁,吻部中等长度——绝不许画成短吻扁脸;"
    "4) 耳朵:半立耳,耳根立起、耳尖向前微折,耳内浅色;"
    "5) 眼睛:深棕杏形眼,中等大小,温和——不要画成网红狗式巨大圆眼;"
    "6) 鼻子大而黑;张嘴时粉舌,嘴角向后咧;"
    "7) 体型紧凑,胸深,坐姿端正。"
    "\n\n任务:画这张狗的{style}。"
    "硬性要求:保持真实犬类头身比例(坐姿约1:1.2),不许Q版化、不许缩短吻部、不许放大眼睛;"
    "与参考照是同一只狗,相似度优先于画风美化。"
    "单只居中,全身,纯色背景,画面无文字无水印。"
)


def load_key():
    for name in ("CODEX_API_KEY", "APIROUTER_KEY"):
        v = os.environ.get(name, "").strip()
        if v:
            return v
    env = ROOT.parent / "miniapp-kit" / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            if k.strip() in ("CODEX_API_KEY", "APIROUTER_KEY"):
                return v.strip().strip('"').strip("'")
    raise SystemExit("未找到 key")


def ref_dataurls():
    out = []
    for p in sorted(REF_DIR.glob("duoli_*.jpg")):
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        out.append("data:image/jpeg;base64," + b64)
    return out


def gen(prompt, refs, model, key):
    content = [{"type": "text", "text": prompt}]
    for r in refs:
        content.append({"type": "image_url", "image_url": {"url": r}})
    body = {"model": model, "messages": [{"role": "user", "content": content}],
            "modalities": ["image"]}
    req = urllib.request.Request(GEN_BASE_URL + "/chat/completions",
                                 data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    url = payload["choices"][0]["message"]["images"][0]["image_url"]["url"]
    return base64.b64decode(url.partition(",")[2])


def main():
    key = load_key()
    refs = ref_dataurls()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    prompt = PROMPT.format(style=STYLE)
    for model in PROBE_MODELS:
        tag = model.split("/")[-1].replace(".", "_")
        out = OUT_DIR / f"probe_{tag}.png"
        try:
            raw = gen(prompt, refs, model, key)
            out.write_bytes(raw)
            print("ok", out.name, len(raw) // 1024, "KB")
        except Exception as e:
            print("FAIL", model, ":", e)


if __name__ == "__main__":
    main()
