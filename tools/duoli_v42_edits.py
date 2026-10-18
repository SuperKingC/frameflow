# v4.2:sleep_pose 重生成(腿张更开,参考照腿是分开的)+ idle/sleep 循环重生成(强锚定)
# 提示词里显式给"最后一帧回到与第一帧完全相同的姿态"约束(上游无 last_frame 参数时也生效)。
# 用法: python tools/duoli_v42_edits.py  → sleep_pose_v2 → v4.2 sleep/idle 视频
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
VID_MODEL = "kwaivgi/kling-v3.0-std"

# ---------- 图像编辑 ----------
SLEEP_V2_PROMPT = ("Reference 1: mascot illustration of 小多利 (tan-white shepherd-mix, semi-erect ears). "
                   "Reference 2: the real dog sleeping belly-up, hind legs spread wide apart. "
                   "Task: draw the dog lying flat on its BACK, belly up, in the pose of reference 2: "
                   "HIND LEGS SPREAD WIDE OPEN to both sides (clearly separated, wide V shape), "
                   "front paws curled up near its chest pointing up, head tilted back, eyes closed, "
                   "fluffy tail draped loosely on the ground. Same art style/colors as reference 1, "
                   "same warm-grey background. No text, no watermark.")


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


def gen_video(first_png: bytes, prompt: str, key: str, out: Path, last_png: bytes = None):
    if out.exists() and out.stat().st_size > 100000:
        print("skip", out.name)
        return
    frames = [{"type": "image_url",
               "image_url": {"url": "data:image/png;base64," + base64.b64encode(first_png).decode("ascii")},
               "frame_type": "first_frame"}]
    if last_png:
        frames.append({"type": "image_url",
                       "image_url": {"url": "data:image/png;base64," + base64.b64encode(last_png).decode("ascii")},
                       "frame_type": "last_frame"})
    body = {"model": VID_MODEL, "prompt": prompt, "duration": 3,
            "generate_audio": False, "frame_images": frames}
    req = urllib.request.Request(GEN_BASE_URL + "/videos",
                                 data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=120) as resp:
        created = json.loads(resp.read().decode("utf-8"))
    job_id = created.get("id") or created.get("jobId") or created.get("task_id")
    print("job", out.name, job_id)
    deadline = time.time() + 12 * 60
    while time.time() < deadline:
        time.sleep(5)
        try:
            with urllib.request.urlopen(
                    urllib.request.Request(f"{GEN_BASE_URL}/videos/{job_id}",
                                           headers={"Authorization": "Bearer " + key}),
                    timeout=60) as resp:
                poll = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print("poll err:", e)
            continue
        data = poll.get("data") if isinstance(poll.get("data"), dict) else {}
        status = poll.get("status") or poll.get("state") or data.get("status")
        if status == "completed":
            raw = b""
            try:
                with urllib.request.urlopen(
                        urllib.request.Request(f"{GEN_BASE_URL}/videos/{job_id}/content",
                                               headers={"Authorization": "Bearer " + key}),
                        timeout=300) as resp:
                    raw = resp.read()
            except Exception:
                pass
            if not raw:
                urls = poll.get("unsigned_urls")
                direct = (urls[0] if isinstance(urls, list) and urls and isinstance(urls[0], str)
                          else poll.get("url") if isinstance(poll.get("url"), str) else None)
                if direct:
                    with urllib.request.urlopen(direct, timeout=300) as resp:
                        raw = resp.read()
            if raw:
                out.write_bytes(raw)
                print("saved", out.name, len(raw) // 1024, "KB")
                return
            print("下载为空")
            return
        if status in ("failed", "cancelled"):
            print("生成失败", json.dumps(poll, ensure_ascii=False)[:300])
            return
    print("轮询超时", out.name)


import time


def main():
    key = load_key()
    sleep_v2 = V3 / "sleep_pose_v2.png"
    if not sleep_v2.exists():
        raw = gen_img(SLEEP_V2_PROMPT, [V3 / "idle_v2.png", SLEEP_REF], key)
        sleep_v2.write_bytes(raw)
        print("ok sleep_pose_v2", len(raw) // 1024, "KB")

    # sleep 循环:首帧=尾帧=腿张开睡姿;提示词强调循环回位
    gen_video(sleep_v2.read_bytes(),
              "四脚朝天仰躺的狗保持姿势,肚皮随呼吸轻轻起伏,四只爪子轻微抽动两下,耳朵微颤;"
              "动作结束后完全回到与开头一模一样的姿态(循环用)。动作很小很慢,"
              "镜头固定,不切换镜头,不运镜,背景不变。",
              key, V3 / "v42_sleep.mp4", last_png=sleep_v2.read_bytes())

    # idle 循环:首帧=尾帧=idle_v2
    gen_video((V3 / "idle_v2.png").read_bytes(),
              "这只坐着的狗轻轻呼吸起伏,体重心轻微左右转移后回正,耳朵微抖,尾巴缓慢摇摆两下;"
              "动作结束后完全回到与开头一模一样的坐姿(循环用)。动作幅度小而柔和,"
              "镜头固定,不切换镜头,不运镜,背景不变。",
              key, V3 / "v42_idle.mp4", last_png=(V3 / "idle_v2.png").read_bytes())


if __name__ == "__main__":
    main()
