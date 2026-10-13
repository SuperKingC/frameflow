# -*- coding: utf-8 -*-
"""端到端:HTTP /api/matting/auto 五模型逐个调用,校验返回 PNG 的 alpha。"""
import base64
import io
import json
import urllib.request

B64 = base64.b64encode(open("testdata/ref_cat.png", "rb").read()).decode()

for model in ["ben2", "briaai", "inspyrenet", "u2net", "isnet-anime"]:
    body = json.dumps({"image": "data:image/png;base64," + B64, "model": model}).encode()
    req = urllib.request.Request("http://127.0.0.1:8439/api/matting/auto", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            r = json.loads(resp.read().decode())
    except Exception as e:
        print(f"{model:12s} HTTP FAIL: {e}")
        continue
    if not r.get("ok"):
        print(f"{model:12s} API FAIL: {r.get('error')}")
        continue
    raw = base64.b64decode(r["image"].split(",", 1)[1])
    im = Image.open(io.BytesIO(raw)) if False else None
    from PIL import Image
    im = Image.open(io.BytesIO(raw))
    a = im.getchannel("A")
    lo, hi = a.getextrema()
    print(f"{model:12s} ok {r['seconds']:>6}s edge={r['edgePx']:>6} mode={im.mode} alpha=({lo},{hi})")
