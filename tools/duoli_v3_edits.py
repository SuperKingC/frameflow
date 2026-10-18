# v3 修型:① idle 底图修脖子(GPT 编辑,"脖子变短,头更贴近肩胸") ② 睡姿四脚朝天(从新底图编辑)
# 用法: python tools/duoli_v3_edits.py   → genwork/duoli_v3/idle_v2.png / sleep_pose.png
import base64
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDLE = ROOT / "genwork" / "duoli_final" / "gpt_idle.png"
SLEEP_REF = ROOT / "testdata" / "duoli_ref" / "duoli_4_sleep.jpg"
OUT_DIR = ROOT / "genwork" / "duoli_v3"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
MODEL = "openai/gpt-5.4-image-2"

IDENTITY = ("Reference: this image is the approved mascot illustration of 小多利 "
            "(a tan-and-white shepherd-mix dog, semi-erect forward-folded ears, fox-like muzzle, "
            "almond dark-brown eyes, narrow white blaze, fluffy up-curled tail, sitting on a plain "
            "warm-grey studio background). ")

EDIT_NECK = ("Edit: shorten the neck noticeably - move the head down and closer to the chest/shoulders "
             "so the head sits right on the shoulders with almost no visible neck (the white chest fur "
             "ruff starts right below the chin). Keep everything else identical: same pose, same face, "
             "same ears, same background, same lighting, same art style. Do not change anything else.")


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


def gen_edit(prompt, images, key):
    content = [{"type": "text", "text": prompt}]
    for b in images:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/png;base64," + base64.b64encode(b).decode("ascii")}})
    body = {"model": MODEL, "messages": [{"role": "user", "content": content}], "modalities": ["image"]}
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
    idle_v2 = OUT_DIR / "idle_v2.png"
    sleep_png = OUT_DIR / "sleep_pose.png"

    if not idle_v2.exists():
        raw = gen_edit(IDENTITY + EDIT_NECK, [IDLE.read_bytes()], key)
        idle_v2.write_bytes(raw)
        print("ok idle_v2", len(raw) // 1024, "KB")
    else:
        print("skip idle_v2")

    if not sleep_png.exists():
        # 睡姿:新底图 + 用户睡姿参考照(四脚朝天)双图编辑
        PROMPT_SLEEP = (IDENTITY +
                        "Second reference photo shows the real dog sleeping belly-up (four paws up, belly exposed). "
                        "Task: edit the illustration so the dog lies on its BACK on the ground, belly up: "
                        "four paws sticking up in the air, head tilted back sideways relaxed, eyes closed, "
                        "belly fur (white) exposed, fluffy tail draped on the ground. Same art style, same colors, "
                        "same warm-grey background. Keep the dog's identity. No text, no watermark.")
        raw = gen_edit(PROMPT_SLEEP, [idle_v2.read_bytes(), SLEEP_REF.read_bytes()], key)
        sleep_png.write_bytes(raw)
        print("ok sleep_pose", len(raw) // 1024, "KB")
    else:
        print("skip sleep_pose")


if __name__ == "__main__":
    main()
