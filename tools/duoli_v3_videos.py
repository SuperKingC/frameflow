# v3 三视频:idle_v2(动作)/ hop(跳跃,单次收尾定格自然站姿)/ sleep(四脚朝天呼吸)
# 每个一段可灵 3.0 std 3s;首帧分别是 idle_v2 / idle_v2 / sleep_pose。
# 用法: python tools/duoli_v3_videos.py [idle|hop|sleep]
import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
V3 = ROOT / "genwork" / "duoli_v3"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
MODEL = "kwaivgi/kling-v3.0-std"

JOBS = {
    "idle": {"first": V3 / "idle_v2.png", "out": V3 / "motion_idle.mp4",
             "prompt": ("这只狗保持坐姿,轻轻呼吸起伏,体重心轻微左右转移,前后腿重心微调,"
                        "耳朵微微抖动,尾巴缓慢摇摆两下回到初始姿态。动作幅度小而柔和,"
                        "镜头固定,不切换镜头,不运镜,不新增元素,背景不变。")},
    "hop": {"first": V3 / "idle_v2.png", "out": V3 / "motion_hop.mp4",
            "prompt": ("这只狗原地小跳一下:先屈腿下蹲蓄力,然后四脚轻腾空跳起约半个身位,"
                       "落地时屈膝缓冲压低,再弹起站稳,最后回到初始坐姿。"
                       "动作欢快自然,只有一次跳跃。镜头固定,不切换镜头,不运镜,背景不变。")},
    "sleep": {"first": V3 / "sleep_pose.png", "out": V3 / "motion_sleep.mp4",
              "prompt": ("四脚朝天躺着睡觉的狗保持仰躺姿势,肚皮随呼吸轻轻起伏,四只爪子偶尔"
                         "轻微抽动两下(做梦),耳朵微微颤动,睡得很沉很放松。"
                         "动作幅度很小很缓慢,镜头固定,不切换镜头,不运镜,背景不变。")},
}


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


def gen_one(cfg, key):
    out = cfg["out"]
    if out.exists() and out.stat().st_size > 100000:
        print("skip", out.name)
        return
    b64 = base64.b64encode(cfg["first"].read_bytes()).decode("ascii")
    body = {"model": MODEL, "prompt": cfg["prompt"], "duration": 3, "generate_audio": False,
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
        print("创建失败", json.dumps(created, ensure_ascii=False)[:300])
        return
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
            print("下载为空", out.name)
            return
        if status in ("failed", "cancelled"):
            print("生成失败", out.name, json.dumps(poll, ensure_ascii=False)[:300])
            return
    print("轮询超时", out.name)


def main():
    key = load_key()
    which = sys.argv[1:] or list(JOBS)
    for name in which:
        print("==", name)
        gen_one(JOBS[name], key)


if __name__ == "__main__":
    main()
