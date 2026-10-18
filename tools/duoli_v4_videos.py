# v4 衔接版:全部段首尾帧锚定同一"标准坐姿"(idle_v2),段间切换零跳变。
#   idle : first=idle_v2, last=idle_v2 → 呼吸一圈回到原姿态(直接无缝循环)
#   hop  : first=idle_v2, last=idle_v2 → 跳出去跳回来,播完切 idle 零跳变
#   toSleep : first=idle_v2, last=sleep_pose → 坐姿翻身躺下(入睡过渡)
#   wakeUp  : first=sleep_pose, last=idle_v2 → 翻身坐起(醒来过渡)
#   sleep   : first=sleep_pose, last=sleep_pose → 仰躺呼吸循环
# 首尾同图生成一致性最好;toSleep/wakeUp 两个过渡是"锚点→锚点"的补间。
# 用法: python tools/duoli_v4_videos.py [idle|hop|toSleep|wakeUp|sleep]
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

IDLE_PNG = V3 / "idle_v2.png"
SLEEP_PNG = V3 / "sleep_pose.png"

JOBS = {
    "idle": {"out": V3 / "v4_idle.mp4",
             "prompt": ("这只狗保持坐姿,轻轻呼吸起伏,体重心轻微左右转移,前后腿重心微调,"
                        "耳朵微微抖动,尾巴缓慢摇摆两下。动作幅度小而柔和,镜头固定,"
                        "不切换镜头,不运镜,不新增元素,背景不变。") , "first": IDLE_PNG, "last": IDLE_PNG},
    "hop": {"out": V3 / "v4_hop.mp4",
            "prompt": ("这只狗原地小跳一下:先屈腿下蹲蓄力,四脚轻腾空跳起约半个身位,"
                       "落地屈膝缓冲,再弹起站稳,稳稳回到与开头完全相同的坐姿。"
                       "动作欢快自然,只有一次跳跃。镜头固定,不切换镜头,背景不变。"),
            "first": IDLE_PNG, "last": IDLE_PNG},
    "toSleep": {"out": V3 / "v4_toSleep.mp4",
                "prompt": ("这只坐着的狗打了个哈欠,侧身慢慢躺下,翻身变成四脚朝天仰躺,"
                           "四爪朝天放松伸开,闭上眼睛入睡。动作慵懒缓慢自然,"
                           "一镜到底连续完成。镜头固定,不切换镜头,背景不变。"),
                "first": IDLE_PNG, "last": SLEEP_PNG},
    "wakeUp": {"out": V3 / "v4_wakeUp.mp4",
               "prompt": ("四脚朝天睡觉的狗醒过来:爪子伸个懒腰,翻身爬起,回到端坐姿势,"
                          "吐了下舌头精神抖擞。动作慵懒缓慢自然,一镜到底连续完成。"
                          "镜头固定,不切换镜头,背景不变。"),
               "first": SLEEP_PNG, "last": IDLE_PNG},
    "sleep": {"out": V3 / "v4_sleep.mp4",
              "prompt": ("四脚朝天躺着睡觉的狗保持仰躺姿势,肚皮随呼吸轻轻起伏,"
                         "四只爪子偶尔轻微抽动两下(做梦),耳朵微微颤动,睡得很沉。"
                         "动作幅度很小很缓慢,镜头固定,不切换镜头,背景不变。"),
              "first": SLEEP_PNG, "last": SLEEP_PNG},
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
    def frame(p):
        return {"type": "image_url",
                "image_url": {"url": "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode("ascii")}}
    frames = [{"type": "image_url", "image_url": frame(cfg["first"])["image_url"], "frame_type": "first_frame"}]
    body = {"model": MODEL, "prompt": cfg["prompt"], "duration": 3, "generate_audio": False,
            "frame_images": frames}
    # 尾帧:非同图时加 last_frame(上游语义同首帧;同图就不发,让模型自然回位)
    if cfg["last"] != cfg["first"]:
        frames.append({"type": "image_url", "image_url": frame(cfg["last"])["image_url"], "frame_type": "last_frame"})
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
