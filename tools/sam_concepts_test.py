# -*- coding: utf-8 -*-
"""语义概念拆件 API 联调(/api/sam/concepts,依赖 florence_worker.py + 转换版权重)。
需 server.py 已启动;首次请求会拉起 Florence-2 worker(约 10~20s 加载模型)。"""
import base64
import io
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8437"


def call(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:200]) if detail else ""))
    if not cond:
        sys.exit(1)


def make_test_png():
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (480, 320), (245, 240, 230))
    d = ImageDraw.Draw(img)
    d.rectangle([40, 60, 170, 190], fill=(60, 120, 220))     # 蓝方块
    d.ellipse([260, 60, 400, 200], fill=(220, 60, 60))       # 红圆
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# 1. meta:concepts 可用性
st, r = call("GET", "/api/sam/meta")
check("meta concepts available", st == 200 and r.get("ok") and r.get("concepts", {}).get("available") is True, r.get("concepts"))

# 2. 真图候选:duoli_2.jpg(实例合并 + 全图框已滤)
try:
    raw = open(r"D:\Mine\frameflow\testdata\duoli_ref\duoli_2.jpg", "rb").read()
except OSError:
    raw = make_test_png()
b64 = base64.b64encode(raw).decode()
st, r = call("POST", "/api/sam/load", {"image": "data:image/jpeg;base64," + b64})
check("sam load", st == 200 and r.get("ok") and r.get("imageId"), r)
img_id = r["imageId"]

st, r = call("POST", "/api/sam/concepts", {"imageId": img_id})
inst = r.get("instances") or []
check("concepts instances", st == 200 and r.get("ok") and len(inst) >= 1,
      {"count": len(inst), "labels": [i.get("label") for i in inst[:5]]})
check("concepts fields", all(("label" in i and "bbox" in i and len(i["bbox"]) == 4 and "task" in i) for i in inst),
      inst[:2])

# 3. 按词拆:ground "dog"
st, r = call("POST", "/api/sam/concepts", {"imageId": img_id, "phrase": "dog"})
g = r.get("instances") or []
check("concepts ground dog", st == 200 and r.get("ok") and r.get("phrase") == "dog" and len(g) >= 1
      and g[0]["bbox"][2] - g[0]["bbox"][0] > 50, g[:2])

# 4. 错误路径:句柄失效 / 概念词过长
st, r = call("POST", "/api/sam/concepts", {"imageId": "deadbeef" * 4})
check("concepts stale handle", st == 400 and "句柄" in r.get("error", ""), r)
st, r = call("POST", "/api/sam/concepts", {"imageId": img_id, "phrase": "x" * 61})
check("concepts phrase too long", st == 400 and "60" in r.get("error", ""), r)

print("ALL PASS")
