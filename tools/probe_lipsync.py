# -*- coding: utf-8 -*-
"""探测中转站(ApiRouter /videos)是否支持对口型/lip-sync 类参数。

可灵官方 API 形态是 /v1/videos/lip-sync(video+audio);经 OpenRouter 兼容层的中转
可能以几种方式透出:独立路径、/videos 的 task/effect 字段、或视频模型直接吃 audio 输入。
本脚本依次试探并打印响应,人工判读。
"""
import base64
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import _load_dotenv, _find_key, GEN_BASE_URL  # noqa: E402

_load_dotenv()
KEY = _find_key()
print("base:", GEN_BASE_URL, "| key:", "set" if KEY else "MISSING")


def post(path, body, timeout=60):
    req = urllib.request.Request(
        GEN_BASE_URL + path, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:300]
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def get(path, timeout=30):
    req = urllib.request.Request(GEN_BASE_URL + path,
                                 headers={"Authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


# 0) 看视频模型目录里有没有带 effect/lipsync 能力标注
st, r = get("/videos/models")
if st == 200 and isinstance(r, dict):
    models = r.get("data") or r.get("models") or []
    hit = [m for m in models if "kling" in str(m.get("id", "")).lower()]
    for m in hit[:4]:
        print("MODEL:", json.dumps(m, ensure_ascii=False)[:400])
else:
    print("/videos/models:", st, str(r)[:200])

FAKE_VIDEO = "https://example.com/v.mp4"
FAKE_AUDIO = "https://example.com/a.wav"

probes = [
    ("POST /videos/lipsync", "/videos/lipsync",
     {"model": "kwaivgi/kling-v3.0-pro", "video_url": FAKE_VIDEO, "audio_url": FAKE_AUDIO}),
    ("POST /videos lip-sync字段", "/videos",
     {"model": "kwaivgi/kling-v3.0-pro", "video_url": FAKE_VIDEO, "audio_url": FAKE_AUDIO,
      "task": "lip_sync"}),
    ("POST /videos audio参考字段", "/videos",
     {"model": "kwaivgi/kling-v3.0-pro", "prompt": "test", "audio": FAKE_AUDIO}),
    ("POST /videos input嵌套", "/videos",
     {"model": "kwaivgi/kling-v3.0-pro", "duration": 5, "prompt": "test",
      "input": {"video_url": FAKE_VIDEO, "audio_url": FAKE_AUDIO, "task": "lipsync"}}),
]
for label, path, body in probes:
    st, r = post(path, body)
    print(f"{label}: {st} | {json.dumps(r, ensure_ascii=False)[:400] if not isinstance(r, str) else r}")
