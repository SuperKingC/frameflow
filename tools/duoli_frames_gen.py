# 小多利变体帧生成:以候选立绘(02 水彩 / 03 皮克斯3D)为底图,编辑出 sprite 帧组。
# 原则:每帧只改一个东西(眨眼/歪头/吐舌/尾巴角度),其余像素级不变——帧间切换才稳。
# 用法: python tools/duoli_frames_gen.py [02|03]
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF_DIR = ROOT / "genwork" / "duoli_refs"
OUT_DIR = ROOT / "genwork" / "duoli_frames"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
MODEL = "google/gemini-3.1-flash-image"

# 每套 5 帧:idle(基准) / blink / tilt / tongue / tail2
FRAMES = [
    ("idle",   "Keep this exact dog illustration unchanged. Output it as-is, identical image."),
    ("blink",  "Edit this dog illustration: eyes fully closed (happy curved closed eyes), everything else pixel-identical: same pose, same background, same lighting, same style."),
    ("tilt",   "Edit this dog illustration: head tilted about 8 degrees to its right (viewer's left), ears follow the tilt naturally, everything else identical: same pose, same background, same style."),
    ("tongue", "Edit this dog illustration: mouth open with pink tongue out panting happily, everything else identical: same pose, same background, same style."),
    ("tail2",  "Edit this dog illustration: tail raised higher and curled up (tail wag up position), body and pose otherwise identical, same background, same style."),
]


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


def gen_edit(base_png: bytes, prompt: str, key: str) -> bytes:
    b64 = base64.b64encode(base_png).decode("ascii")
    content = [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
    ]
    body = {"model": MODEL, "messages": [{"role": "user", "content": content}],
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
    which = sys.argv[1:] or ["02"]
    jobs = []
    for w in which:
        src = next(REF_DIR.glob(f"{w}_*.png"))
        stem = src.stem.split("_", 1)[1]
        for name, prompt in FRAMES:
            jobs.append((src, f"{w}_{stem}", name, prompt))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for src, prefix, name, prompt in jobs:
        out = OUT_DIR / f"{prefix}_{name}.png"
        if out.exists():
            print("skip", out.name)
            continue
        try:
            raw = gen_edit(src.read_bytes(), prompt, key)
            out.write_bytes(raw)
            print("ok  ", out.name, len(raw) // 1024, "KB")
        except Exception as e:
            print("FAIL", out.name, ":", e)


if __name__ == "__main__":
    main()
