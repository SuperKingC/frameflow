# -*- coding: utf-8 -*-
"""P1.1 探测:中转站 /videos 的 first_last(首尾帧)图生视频是否真支持。
两个纯色方块 PNG 作首帧/尾帧,kling-v3.0-std 5s;成功→首尾帧接力路线可行。
本机回环免码直进;预算 ≈$0.1~0.2。"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8437"
TMP = Path("genwork/probe_fl")
TMP.mkdir(parents=True, exist_ok=True)


def png_of(color):
    """纯色 128x224(9:16)PNG。"""
    out = TMP / f"{color}.png"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"color=c={color}:s=128x224",
                    "-frames:v", "1", str(out)], check=True)
    return "data:image/png;base64," + base64.b64encode(out.read_bytes()).decode()


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


print("[1] submit first_last task (kling-v3.0-std, 5s)")
st, r = post("/api/studio/tasks", {
    "model": "kwaivgi/kling-v3.0-std",
    "prompt": "纯色背景上,一个红色方块从画面左侧匀速移动到画面右侧并停住,镜头固定,无其他元素",
    "duration": 5, "frameMode": "first_last",
    "referenceImages": [png_of("red"), png_of("blue")]})
print("submit:", st, json.dumps(r, ensure_ascii=False)[:300])
if st not in (200, 202) or not r.get("id"):
    print("PROBE FAIL: submit rejected —", r if isinstance(r, str) else r.get("error"))
    sys.exit(1)
tid = r["id"]

print("[2] poll", tid)
deadline = time.time() + 480
while time.time() < deadline:
    time.sleep(6)
    try:
        with urllib.request.urlopen(f"{BASE}/api/studio/tasks/{tid}", timeout=60) as resp:
            snap = json.loads(resp.read().decode())
    except Exception as e:
        print("poll err:", e)
        continue
    print("  status:", snap.get("status"), snap.get("upstreamStatus") or "")
    if snap.get("status") in ("succeeded", "failed", "cancelled"):
        print("[3] result:", json.dumps({k: snap.get(k) for k in
              ("status", "error", "usage", "params")}, ensure_ascii=False))
        if snap.get("status") == "succeeded":
            print("PROBE OK: first_last 被上游接受且出片 —— 首尾帧接力路线可行")
        else:
            print("PROBE FAIL: 任务失败 —", snap.get("error"))
        sys.exit(0 if snap.get("status") == "succeeded" else 1)
print("PROBE FAIL: 超时")
sys.exit(1)
