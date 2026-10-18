# 小多利动图视频:批准立绘(gpt_idle)当首帧 → 可灵 3.0 std 图生视频 3s(呼吸/重心/摆尾)
# 复用 server.py /videos 的直连语义(首帧 frame_images + 轮询 + /content 下载)。
# 用法: python tools/duoli_motion_video.py
import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "genwork" / "duoli_final" / "gpt_idle.png"
OUT_DIR = ROOT / "genwork" / "duoli_motion"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
MODEL = "kwaivgi/kling-v3.0-std"
DURATION = 3

PROMPT = ("这只狗保持原姿势,轻轻呼吸起伏,体重心轻微左右转移,前后腿重心随之微调,"
          "耳朵微微抖动,尾巴缓慢摇摆两下后回到初始姿态。"
          "动作幅度小而柔和,镜头固定,不切换镜头,不运镜,不新增元素,背景不变。")


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


def main():
    key = load_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mp4 = OUT_DIR / "motion.mp4"
    if mp4.exists() and mp4.stat().st_size > 100000:
        print("skip: motion.mp4 已存在")
        return
    b64 = base64.b64encode(BASE.read_bytes()).decode("ascii")
    body = {"model": MODEL, "prompt": PROMPT, "duration": DURATION,
            "generate_audio": False,
            "frame_images": [{"type": "image_url",
                              "image_url": {"url": "data:image/png;base64," + b64},
                              "frame_type": "first_frame"}]}
    req = urllib.request.Request(GEN_BASE_URL + "/videos",
                                 data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=120) as resp:
        created = json.loads(resp.read().decode("utf-8"))
    job_id = created.get("id") or created.get("jobId") or created.get("task_id")
    if not job_id:
        print("创建失败:", json.dumps(created, ensure_ascii=False)[:300])
        sys.exit(1)
    print("job:", job_id)

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
        print("status:", status)
        if status == "completed":
            raw = b""
            try:
                with urllib.request.urlopen(
                        urllib.request.Request(f"{GEN_BASE_URL}/videos/{job_id}/content",
                                               headers={"Authorization": "Bearer " + key}),
                        timeout=300) as resp:
                    raw = resp.read()
            except Exception as e:
                print("content err:", e)
            if not raw:
                direct = None
                urls = poll.get("unsigned_urls")
                if isinstance(urls, list) and urls and isinstance(urls[0], str):
                    direct = urls[0]
                elif isinstance(poll.get("url"), str):
                    direct = poll["url"]
                if direct:
                    with urllib.request.urlopen(direct, timeout=300) as resp:
                        raw = resp.read()
            if not raw:
                print("下载为空")
                sys.exit(1)
            mp4.write_bytes(raw)
            print("saved:", mp4, len(raw) // 1024, "KB")
            return
        if status in ("failed", "cancelled"):
            print("生成失败:", json.dumps(poll, ensure_ascii=False)[:400])
            sys.exit(1)
    print("轮询超时")
    sys.exit(1)


if __name__ == "__main__":
    main()
