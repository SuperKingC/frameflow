# -*- coding: utf-8 -*-
"""matting_worker 五模型冒烟测试:stdio 协议跑 ping + 每模型一张 matte + quit。"""
import base64
import json
import subprocess
import sys

B64 = base64.b64encode(open("testdata/ref_cat.png", "rb").read()).decode()
PY = "D:/Pet10-tools/sam2/.venv/Scripts/python.exe"

models = sys.argv[1].split(",") if len(sys.argv) > 1 else ["ben2", "briaai", "inspyrenet", "u2net", "isnet-anime"]
lines = [{"cmd": "ping"}]
for m in models:
    lines.append({"cmd": "matte", "model": m, "image_b64": B64})
lines.append({"cmd": "quit"})
inp = "\n".join(json.dumps(l) for l in lines) + "\n"

p = subprocess.run([PY, "matting_worker.py"], input=inp, capture_output=True,
                   text=True, encoding="utf-8", errors="replace", timeout=1200)
ok = 0
for line in p.stdout.splitlines():
    if not line.strip():
        continue
    try:
        r = json.loads(line)
    except Exception:
        print("NON-JSON STDOUT:", line[:160])
        continue
    if r.get("rgba_b64"):
        r.pop("rgba_b64")
    print(json.dumps(r, ensure_ascii=False))
    if r.get("ok"):
        ok += 1
print(f"--- {ok}/{len(models)+1} ok")
