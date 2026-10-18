# v4.3:① sleep_pose_v3(腿稍微收拢——v2 张太开) ② idle 循环视频带"舔嘴/脚动"小动作
# 睡姿参考照里狗的后腿是分开的,但 v2 版把"分开"执行过了头;v3 收到"自然微开"。
# 用法: python tools/duoli_v43_edits.py   (只生成图;视频在 duoli_v43_videos.py)
import base64
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
V3 = ROOT / "genwork" / "duoli_v3"
SLEEP_REF = ROOT / "testdata" / "duoli_ref" / "duoli_4_sleep.jpg"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
IMG_MODEL = "openai/gpt-5.4-image-2"

PROMPT = ("Reference 1: the mascot illustration of 小多利 lying belly-up sleeping (hind legs spread wide V). "
          "Reference 2: the real dog sleeping belly-up. "
          "Task: edit reference 1 - bring the HIND LEGS closer together, only slightly apart "
          "(they were spread too wide; make the gap between the two hind legs small, paws relaxed "
          "and close, like in reference 2). Keep everything else identical: same pose, same art style, "
          "same colors, same background. No text, no watermark.")


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


def gen_img(prompt, images, key):
    content = [{"type": "text", "text": prompt}]
    for p in images:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode("ascii")}})
    body = {"model": IMG_MODEL, "messages": [{"role": "user", "content": content}], "modalities": ["image"]}
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
    out = V3 / "sleep_pose_v3.png"
    if out.exists():
        print("skip sleep_pose_v3")
        return
    raw = gen_img(PROMPT, [V3 / "sleep_pose_v2.png", SLEEP_REF], key)
    out.write_bytes(raw)
    print("ok sleep_pose_v3", len(raw) // 1024, "KB")


if __name__ == "__main__":
    main()
