# -*- coding: utf-8 -*-
"""短剧素材落盘 file 引用路径联调(自起 8439 实例):

studio v0.5 成品在本机磁盘,短剧落盘应带 taskId/index 让服务端直读,而不是拼
/api/studio/file 回环直链(会被代取的 SSRF 防护按回环地址拒绝)。

前置:伪造一个已完成的 studio 任务(genwork/studio/<32hex>/meta.json + out-1.png),
服务端启动恢复进内存后,file 引用即可直读。跑完自动清理项目与伪造任务。
"""
import base64
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8439"


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
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
        proc.terminate()
        sys.exit(1)


# 1. 伪造已完成 studio 任务
tid = uuid.uuid4().hex
tdir = ROOT / "genwork" / "studio" / tid
tdir.mkdir(parents=True, exist_ok=True)
subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=360x480",
                "-frames:v", "1", str(tdir / "out-1.png")], check=True)
png_bytes = (tdir / "out-1.png").read_bytes()
(tdir / "meta.json").write_text(json.dumps(
    {"id": tid, "model": "test", "kind": "image", "status": "succeeded",
     "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
     "data": [{"file": "out-1.png", "mime": "image/png"}]}, ensure_ascii=False), encoding="utf-8")

# 2. 起服务(恢复任务进内存)
proc = subprocess.Popen([sys.executable, "server.py", "--port", "8439", "--no-browser"], cwd=ROOT)
for _ in range(60):
    time.sleep(0.5)
    try:
        urllib.request.urlopen(BASE + "/api/drama/meta", timeout=2)
        break
    except Exception:
        continue
else:
    proc.terminate()
    sys.exit("server did not start")

try:
    # 3. 建项目 + 角色
    st, r = call("POST", "/api/drama/projects", {"title": "file引用联调", "aspect": "9:16"})
    check("create project", st == 200 and r.get("ok"), r)
    pid = r["project"]["id"]
    st, r = call("POST", f"/api/drama/projects/{pid}/chars/add", {"name": "小满", "desc": "test"})
    check("char add", st == 200 and r.get("ok"), r)
    cid = r["project"]["chars"][0]["id"]

    # 4. file 引用落盘(修复路径)
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "char", "id": cid, "kind": "portrait", "file": {"taskId": tid, "index": 1}})
    check("file-ref asset stored", st == 200 and r.get("ok")
          and r["project"]["chars"][0]["asset"] == f"chars/{cid}.png", (st, r))
    stored = (ROOT / "genwork" / "drama" / pid / "chars" / f"{cid}.png").read_bytes()
    check("file-ref bytes match", stored == png_bytes, len(stored))
    st, body = call("GET", f"/api/drama/projects/{pid}/asset/chars/{cid}.png", raw=True)
    check("stored asset served", st == 200 and body[:8][:4] == b"\x89PNG", (st, len(body)))

    # 5. 负例:不存在的任务号 → task_not_found(404)
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "char", "id": cid, "kind": "portrait", "file": {"taskId": "0" * 32, "index": 1}})
    check("bad task 404", st == 404 and r.get("error") == "task_not_found", (st, r))

    # 6. 回归:回环 URL 仍被 SSRF 防护拒绝(不允许绕 HTTP 回环自取)
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "char", "id": cid, "kind": "portrait",
                  "url": BASE + "/api/studio/file/" + tid + "/1"})
    check("loopback url still rejected", st == 400 and "内网/保留地址" in r.get("error", ""), (st, r))

    # 7. 清理
    st, r = call("POST", f"/api/drama/projects/{pid}/delete")
    check("delete project", st == 200 and r.get("ok"), r)
    print("ALL PASS")
finally:
    proc.terminate()
    shutil.rmtree(tdir, ignore_errors=True)
