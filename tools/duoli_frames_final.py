# 终版帧组:以 probe_gpt-5_4-image-2.png(A,用户批准)为底图,编辑 5 帧。
# GPT-5.4 Image 的一致性保持好;每帧只改一个特征。
# 用法: python tools/duoli_frames_final.py
import base64
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "genwork" / "duoli_probe" / "probe_gpt-5_4-image-2.png"
OUT_DIR = ROOT / "genwork" / "duoli_final"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
MODEL = "openai/gpt-5.4-image-2"

IDENTITY = (
    "Reference: this image is the approved mascot illustration of 小多利 "
    "(a tan-and-white shepherd-mix dog, semi-erect forward-folded ears, fox-like long muzzle, "
    "almond dark-brown eyes, narrow white blaze between brows, fluffy up-curled tail, "
    "sitting on a plain warm-grey studio background). "
)

FRAMES = [
    ("idle",   "Reproduce this exact image unchanged, identical in every detail."),
    ("blink",  "Edit: close both eyes into happy curved shut eyes (as if mid-blink or content). "
               "Everything else stays pixel-identical: same pose, same head angle, same background, same lighting."),
    ("tilt",   "Edit: tilt the head about 10 degrees toward its right (viewer's left); ears follow naturally; "
               "eyes stay open looking at viewer. Everything else identical."),
    ("tongue", "Edit: open the mouth with pink tongue lolling out, panting happily; mouth corners back. "
               "Everything else identical: same pose, same background."),
    ("paw",    "Edit: raise the right front paw (viewer's left) slightly off the ground in a gentle paw-up gesture, "
               "as if greeting; head stays same angle, eyes open. Everything else identical."),
]

PROMPT = IDENTITY + "Task: {task}. Output the edited image only. No text, no watermark, no frame border."


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


def gen_edit(png: bytes, prompt: str, key: str) -> bytes:
    b64 = base64.b64encode(png).decode("ascii")
    content = [{"type": "text", "text": prompt},
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]
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
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base_png = BASE.read_bytes()
    for name, task in FRAMES:
        out = OUT_DIR / f"gpt_{name}.png"
        if out.exists():
            print("skip", out.name)
            continue
        try:
            raw = gen_edit(base_png, PROMPT.format(task=task), key)
            out.write_bytes(raw)
            print("ok", out.name, len(raw) // 1024, "KB")
        except Exception as e:
            print("FAIL", out.name, ":", e)


if __name__ == "__main__":
    main()
