# -*- coding: utf-8 -*-
"""图层分离 v2 SAM2 API 联调脚本(python urllib;覆盖 /api/sam/meta、/api/sam/load、
/api/sam/segment 的点/框/双档模型/句柄失效兜底)。需 server.py 已在 8437 启动。"""
import base64
import io
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8437"


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload
            return resp.status, json.loads(payload.decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:200]) if detail else ""))
    if not cond:
        sys.exit(1)


def make_test_png():
    """生成确定性测试图:米色底 + 蓝方块 + 红圆(400x300)。"""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        sys.exit("PIL 不可用,无法生成测试图")
    img = Image.new("RGB", (400, 300), (240, 230, 210))
    d = ImageDraw.Draw(img)
    d.rectangle([60, 80, 180, 220], fill=(60, 120, 220))
    d.ellipse([240, 80, 360, 220], fill=(220, 60, 60))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


raw = make_test_png()
b64 = base64.b64encode(raw).decode()

# 1. meta:模型档位清单(small 必可用,large 视权重而定)
st, r = call("GET", "/api/sam/meta")
check("meta ok", st == 200 and r.get("ok") and len(r.get("models", [])) == 2, r)
models = {m["id"]: m for m in r["models"]}
check("meta small available", models["small"]["available"] is True, models)
print("   large available:", models["large"]["available"])

# 2. load:注册句柄 + 尺寸解析
st, r = call("POST", "/api/sam/load", {"image": "data:image/png;base64," + b64})
check("sam load", st == 200 and r.get("ok") and r.get("imageId") and r.get("width") == 400
      and r.get("height") == 300, r)
img_id = r["imageId"]

# 3. 重复注册:同图返回同句柄(不新增槽位)
st, r2 = call("POST", "/api/sam/load", {"image": "data:image/png;base64," + b64})
check("sam load dedup", st == 200 and r2.get("imageId") == img_id, r2)

# 4. segment:点提示(small 档)——蓝方块中心
st, r = call("POST", "/api/sam/segment",
             {"imageId": img_id, "model": "small", "points": [[120, 150]], "labels": [1]})
check("seg point small", st == 200 and r.get("ok") and r.get("area", 0) > 1000
      and r.get("score", 0) > 0.5 and len(r.get("mask_b64", "")) > 100, r)

# 5. segment:框提示(应比点更整;multimask 关闭)
st, r = call("POST", "/api/sam/segment",
             {"imageId": img_id, "model": "small", "box": [60, 80, 180, 220], "points": []})
check("seg box", st == 200 and r.get("ok") and r.get("area", 0) > 1000, r)

# 6. segment:句柄失效兜底(随机 id 报错)
st, r = call("POST", "/api/sam/segment",
             {"imageId": "deadbeef" * 4, "model": "small", "points": [[120, 150]], "labels": [1]})
check("seg stale handle", st == 400 and "句柄" in r.get("error", ""), r)

# 7. segment:v1 兼容路径(直接传 image 整图)
st, r = call("POST", "/api/sam/segment",
             {"image": "data:image/png;base64," + b64, "model": "small",
              "points": [[120, 150]], "labels": [1]})
check("seg v1 compat", st == 200 and r.get("ok") and r.get("area", 0) > 1000, r)

# 8. segment:参数校验(box 类型错 / 点框全空)
st, r = call("POST", "/api/sam/segment",
             {"imageId": img_id, "model": "small", "box": "notalist"})
check("seg bad box", st == 400, r)
st, r = call("POST", "/api/sam/segment", {"imageId": img_id, "model": "small"})
check("seg empty prompt", st == 400 and "提示" in r.get("error", ""), r)

# 9. segment:large 档(若权重在;否则应报权重缺失)
if models["large"]["available"]:
    st, r = call("POST", "/api/sam/segment",
                 {"imageId": img_id, "model": "large", "box": [60, 80, 180, 220], "points": []})
    check("seg box large", st == 200 and r.get("ok") and r.get("area", 0) > 1000
          and r.get("model") == "large", r)
else:
    print("SKIP seg box large (large weights missing)")

# 10. matting/auto(一键主体层链路):ben2
st, r = call("POST", "/api/matting/auto", {"image": "data:image/png;base64," + b64, "model": "ben2"})
check("matting auto ben2", st == 200 and r.get("ok") and r.get("image", "").startswith("data:image/png"),
      {k: r.get(k) for k in ("ok", "width", "height", "seconds")})

print("ALL PASS")
