# v4.3 视频重生成(全部双锚):
#   idle    ← idle_v2 首尾同锚(提示词加"中途舔一次嘴+前脚动一下,结束回原姿")
#   sleep   ← sleep_pose_v3 首尾同锚(呼吸+爪微抽)
#   toSleep ← idle_v2 → sleep_pose_v3
#   wakeUp  ← sleep_pose_v3 → idle_v2
# 用法: python tools/duoli_v43_videos.py
import base64
import json
import os
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
V3 = ROOT / "genwork" / "duoli_v3"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
VID_MODEL = "kwaivgi/kling-v3.0-std"

IDLE = V3 / "idle_v2.png"
SLEEP = V3 / "sleep_pose_v3.png"

JOBS = {
    "idle": {"out": V3 / "v43_idle.mp4",
             "prompt": ("这只坐着的狗轻轻呼吸起伏;中途快速舔一下嘴巴(舌头伸出舔嘴一圈马上收回),"
                        "偶尔一只前脚轻轻挪动一下小幅度调整坐姿;尾巴缓慢摇摆两下。"
                        "所有动作幅度都很小,做完后完全回到与开头一模一样的坐姿(循环用)。"
                        "镜头固定,不切换镜头,不运镜,不新增元素,背景不变。"),
             "first": IDLE, "last": IDLE},
    "sleep": {"out": V3 / "v43_sleep.mp4",
              "prompt": ("四脚朝天仰躺睡觉的狗保持姿势,肚皮随呼吸轻轻起伏,四只爪子轻微抽动两下(做梦),"
                         "耳朵微微颤动,睡得很沉;动作结束后完全回到与开头一模一样的姿势(循环用)。"
                         "动作幅度很小很缓慢,镜头固定,不切换镜头,不运镜,背景不变。"),
              "first": SLEEP, "last": SLEEP},
    "toSleep": {"out": V3 / "v43_toSleep.mp4",
                "prompt": ("这只坐着的狗打了个哈欠,侧身慢慢躺下,翻身变成四脚朝天仰躺,四爪放松微开,"
                           "闭上眼睛入睡,最后保持与画面定格完全一致的仰躺姿势。动作慵懒缓慢自然,"
                           "一镜到底连续完成。镜头固定,不切换镜头,不运镜,背景不变。"),
                "first": IDLE, "last": SLEEP},
    "wakeUp": {"out": V3 / "v43_wakeUp.mp4",
               "prompt": ("四脚朝天睡觉的狗醒过来:爪子伸个懒腰,翻身爬起坐好,吐了下舌头精神抖擞,"
                          "最后保持与画面定格完全一致的端坐姿势。动作慵懒缓慢自然,一镜到底连续完成。"
                          "镜头固定,不切换镜头,不运镜,背景不变。"),
               "first": SLEEP, "last": IDLE},
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
    frames = [{"type": "image_url",
               "image_url": {"url": "data:image/png;base64," + base64.b64encode(cfg["first"].read_bytes()).decode("ascii")},
               "frame_type": "first_frame"},
              {"type": "image_url",
               "image_url": {"url": "data:image/png;base64," + base64.b64encode(cfg["last"].read_bytes()).decode("ascii")},
               "frame_type": "last_frame"}]
    body = {"model": VID_MODEL, "prompt": cfg["prompt"], "duration": 3,
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
            print("下载为空", out.name)
            return
        if status in ("failed", "cancelled"):
            print("生成失败", out.name, json.dumps(poll, ensure_ascii=False)[:300])
            return
    print("轮询超时", out.name)


def main():
    key = load_key()
    for name in ("idle", "sleep", "toSleep", "wakeUp"):
        print("==", name)
        gen_one(JOBS[name], key)


if __name__ == "__main__":
    main()
