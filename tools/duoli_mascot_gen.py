# 小多利吉祥物候选图生成:真照(3张)做参考 + 10 种风格提示词 → genwork/duoli_refs/
# 用法: python tools/duoli_mascot_gen.py
# 密钥走 miniapp-kit/.env(CODEX_API_KEY/APIROUTER_KEY),不落盘不打印。
import base64
import datetime
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF_DIR = ROOT / "testdata" / "duoli_ref"
OUT_DIR = ROOT / "genwork" / "duoli_refs"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
MODEL = "google/gemini-3.1-flash-image"  # 高质量快速档,支持参考图,≈$0.07/张

STYLES = [
    ("01_shiba_sticker", "日系柴犬贴纸风:扁平卡通吉祥物,粗描边,奶油色底,大圆眼,呆萌坐姿,正面全身"),
    ("02_fluffy_watercolor", "吉卜力水彩童话风:柔和笔触,暖阳逆光,毛茸茸质感,坐在草地上回头微笑"),
    ("03_pixar_3d", "皮克斯式 3D 渲染:圆润体积感,大眼睛有神,柔光棚拍,坐姿歪头看镜头"),
    ("04_chibi_anime", "日系赛璐璐动漫风:2头身Q版,明亮干净,渐变背景,活力吐舌笑,正面全身"),
    ("05_flat_vector", "极简扁平矢量插画:几何色块,无描边,品牌吉祥物风,坐姿挥手,单一浅色背景"),
    ("06_pixel_art", "复古像素画:16-bit 游戏精灵,侧面坐姿,清晰像素颗粒,透明感背景"),
    ("07_okami_ink", "和风水墨笔触:《大神》风格,白色笔触勾勒,红叶点缀,神气十足站姿"),
    ("08_clay_3d", "黏土定格动画风:手工黏土质感, fingerprints 可见,毛毡底布背景,坐姿呆萌"),
    ("09_neon_game", "游戏 UI 吉祥物立绘:赛博渐变背景,发光描边,元气站姿,适合当助手头像"),
    ("10_crayon_kids", "蜡笔手绘童趣风:儿童蜡笔画质感,粗糙纸纹,快乐奔跑,太阳白云背景"),
]

BASE_PROMPT = (
    "Reference photos: a real dog named 小多利 (Duoli) - a small fluffy dog with "
    "golden-brown curly fur, white chest/ruff/belly and white paws, upright folded "
    "triangle ears with lighter inner fur, dark round eyes, big black nose, pink tongue, "
    "white blaze between eyes. Keep the dog's identity and color pattern consistent with "
    "the reference photos. Generate ONE mascot illustration of this dog: {style}. "
    "Single character centered, full body, no text, no watermark, no logo, clean background."
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
    raise SystemExit("未找到 key:设 CODEX_API_KEY 或确认 miniapp-kit/.env")


def ref_dataurls():
    out = []
    for p in sorted(REF_DIR.glob("duoli_*.jpg")):
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        out.append("data:image/jpeg;base64," + b64)
    if not out:
        raise SystemExit("没有参考照:testdata/duoli_ref/duoli_*.jpg")
    return out


def gen_one(prompt, refs, key):
    content = [{"type": "text", "text": prompt}]
    for r in refs:
        content.append({"type": "image_url", "image_url": {"url": r}})
    body = {"model": MODEL, "messages": [{"role": "user", "content": content}],
            "modalities": ["image"]}
    req = urllib.request.Request(GEN_BASE_URL + "/chat/completions",
                                 data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    url = payload["choices"][0]["message"]["images"][0]["image_url"]["url"]
    m = url.partition(",")[2]
    return base64.b64decode(m)


def main():
    key = load_key()
    refs = ref_dataurls()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:] or None
    for name, style in STYLES:
        if only and not any(name.startswith(o) for o in only):
            continue
        out = OUT_DIR / f"{name}.png"
        if out.exists():
            print(f"skip {name} (exists)")
            continue
        t0 = datetime.datetime.now()
        try:
            raw = gen_one(BASE_PROMPT.format(style=style), refs, key)
            out.write_bytes(raw)
            print(f"ok   {name}  {len(raw)//1024}KB  {(datetime.datetime.now()-t0).total_seconds():.1f}s")
        except Exception as e:
            print(f"FAIL {name}: {e}")


if __name__ == "__main__":
    main()
