# -*- coding: utf-8 -*-
"""短剧工作台 API 联调脚本(python urllib,保证 UTF-8;curl 在 Git Bash 下会把中文变 GBK)。"""
import base64
import json
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

BASE = "http://127.0.0.1:8438"


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


# 1. 建项目
st, r = call("POST", "/api/drama/projects", {"title": "接口联调短剧", "aspect": "9:16",
             "logline": "深夜便利店,一只会说话的猫告诉打工女孩,明天世界会重置一次",
             "style": "日系赛璐璐动漫,柔和光影"})
check("create project", st == 200 and r.get("ok") and r["project"]["id"], r)
pid = r["project"]["id"]

# 2. 列表 / 读取 / 更新
st, r = call("GET", "/api/drama/projects")
check("list projects", st == 200 and any(p["id"] == pid for p in r["projects"]), r)
st, r = call("GET", f"/api/drama/projects/{pid}")
check("get project", st == 200 and r["project"]["title"] == "接口联调短剧", r)
st, r = call("POST", f"/api/drama/projects/{pid}/update", {"style": "日系赛璐璐动漫,柔和光影,霓虹夜色"})
check("update project", st == 200 and r["project"]["style"].endswith("霓虹夜色"), r)

# 3. 角色
st, r = call("POST", f"/api/drama/projects/{pid}/chars/add", {"name": "小满", "desc": "22岁打工女孩,短发,便利店制服"})
check("char add", st == 200 and len(r["project"]["chars"]) == 1, r)
cid = r["project"]["chars"][0]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/update", {"name": "小满"})
check("char update", st == 200 and r["project"]["chars"][0]["name"] == "小满", r)

# 4. 镜头增改排删
st, r = call("POST", f"/api/drama/projects/{pid}/shots/add",
             {"scene": "夜·便利店门口", "desc": "小满瘫坐在台阶上,猫突然开口说话",
              "firstPrompt": "深夜便利店门口,打工女孩坐在台阶上,一只黑猫蹲在她面前开口说话",
              "motionPrompt": "女孩惊讶抬头,黑猫尾巴轻摆", "duration": 5})
check("shot add", st == 200 and len(r["project"]["shots"]) == 1, r)
s1 = r["project"]["shots"][0]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/add", {"scene": "夜·店内", "desc": "第二镜"})
check("shot add 2", st == 200 and len(r["project"]["shots"]) == 2, r)
s2 = r["project"]["shots"][1]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/update", {"duration": 10, "desc": "小满瘫坐在台阶上,黑猫开口:明天世界重置"})
check("shot update", st == 200 and r["project"]["shots"][0]["duration"] == 10, r)
st, r = call("POST", f"/api/drama/projects/{pid}/shots/reorder", {"order": [s2, s1]})
check("shot reorder", st == 200 and r["project"]["shots"][0]["id"] == s2, r)

# 5. 素材落盘:ffmpeg 生成真实 PNG + 两个测试 mp4(1 秒 540x960)
subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=360x480",
                "-frames:v", "1", f"genwork/drama/{pid}/test_char.png"], check=True)
raw_png = open(f"genwork/drama/{pid}/test_char.png", "rb").read()
check("png size>100", len(raw_png) > 100, len(raw_png))
png_b64 = base64.b64encode(raw_png).decode()
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "char", "id": cid, "kind": "portrait", "dataUrl": "data:image/png;base64," + png_b64})
check("char portrait asset", st == 200 and r["project"]["chars"][0]["asset"] == f"chars/{cid}.png", r)

for sid in (s1, s2):
    out = f"genwork/drama/{pid}/testsrc_{sid}.mp4"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=540x960:rate=24:duration=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", out], check=True)
    b64 = base64.b64encode(open(out, "rb").read()).decode()
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "shot", "id": sid, "kind": "clip", "dataUrl": "data:video/mp4;base64," + b64})
    check(f"shot clip asset {sid[:6]}", st == 200 and r["project"]["shots"][[x["id"] for x in r["project"]["shots"]].index(sid)]["clip"], r)

# 6. 素材读取
st, body = call("GET", f"/api/drama/projects/{pid}/asset/composed.mp4", raw=True)
st, r = call("POST", f"/api/drama/projects/{pid}/compose")
check("compose", st == 200 and r["project"]["composed"] == "composed.mp4", r)
st, body = call("GET", f"/api/drama/projects/{pid}/asset/composed.mp4", raw=True)
check("composed served", st == 200 and len(body) > 10000 and body[4:8] == b"ftyp", (st, len(body)))

# 7. 非法路径拒绝
st, r = call("GET", f"/api/drama/projects/{pid}/asset/../project.json", raw=True)
check("traversal rejected", st in (400, 404), st)

# 7.5 meta(styles + ideas)
st, r = call("GET", "/api/drama/meta")
check("meta styles/ideas", st == 200 and r.get("ok") and len(r.get("styles", [])) >= 8
      and len(r.get("ideas", [])) >= 1 and all("logline" in x for x in r["ideas"]),
      {"styles": len(r.get("styles", [])), "idea0": (r.get("ideas") or [{}])[0].get("title")})

# 7.6 角色参考图:上传 2 张、删除第 1 张、校验文件
for i in (1, 2):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"testsrc=size=200x260", "-frames:v", "1",
                    f"genwork/drama/{pid}/up{i}.png"], check=True)
    b64 = base64.b64encode(open(f"genwork/drama/{pid}/up{i}.png", "rb").read()).decode()
    st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/refs/add",
                 {"dataUrl": "data:image/png;base64," + b64})
    check(f"char ref add {i}", st == 200 and r.get("ok") and len(r["project"]["chars"][0]["refs"]) == i, r)
refs = r["project"]["chars"][0]["refs"]
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/refs/delete", {"index": 1})
check("char ref delete", st == 200 and len(r["project"]["chars"][0]["refs"]) == 1
      and r["project"]["chars"][0]["refs"][0] != refs[0], r)
gone = not (Path(f"genwork/drama/{pid}/{refs[0]}").exists())
check("char ref file deleted", gone, refs[0])
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/refs/add", {"dataUrl": "data:text/html;base64,xxx"})
check("char ref bad mime", st == 400 and "不支持" in r.get("error", ""), r)

# 7.7 portraitTaskId 清除:上传 asset 后应清空
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/update", {"portraitTaskId": "abc123"})
check("portraitTaskId set", st == 200 and r["project"]["chars"][0]["portraitTaskId"] == "abc123", r)
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "char", "id": cid, "kind": "portrait", "dataUrl": "data:image/png;base64," + png_b64})
check("portrait asset clears taskId", st == 200 and r["project"]["chars"][0]["portraitTaskId"] is None
      and r["project"]["chars"][0]["asset"].startswith("chars/"), r)

# 7.8 缺键报错带键名
st, r = call("POST", f"/api/drama/projects/{pid}/asset", {"target": "shot", "id": s1, "kind": "first"})
check("asset missing keys err", st == 400 and "keys=[target,id,kind]" in r.get("error", ""), r)

# 7.9 台词/TTS:写对白 → 生成配音(SAPI 真跑)→ 校验 tts wav 落盘
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/update",
             {"lines": "小满:今天怎么不进来?\n黑猫:在等你换班。"})
check("lines update", st == 200 and "换班" in r["project"]["shots"][0]["lines"], r)
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/tts", {})
check("shot tts", st == 200 and r.get("ok") and r["project"]["shots"][0]["tts"], r)
tts_rel = r["project"]["shots"][0]["tts"]
st, body = call("GET", f"/api/drama/projects/{pid}/asset/{tts_rel}", raw=True)
check("tts served", st == 200 and len(body) > 5000 and body[:4] == b"RIFF", (st, len(body)))

# 7.10 时长范围(2~30)截断
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s2}/update", {"duration": 60})
check("duration clamped", st == 200 and r["project"]["shots"][1]["duration"] == 30, r)

# 8. 分镜 LLM(真实调用一次,验证解析链路)
st, r = call("POST", f"/api/drama/projects/{pid}/storyboard", {"nShots": 4})
shots = r.get("project", {}).get("shots", []) if isinstance(r, dict) else []
check("storyboard", st == 200 and r.get("ok") and len(shots) >= 4 and all(s.get("firstPrompt") for s in shots[-4:]),
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r,
       "first": {k: shots[-4][k][:40] for k in ("scene", "desc")} if len(shots) >= 4 else r})

# 8.5 brainstorm 现编(真实调用一次)
st, r = call("POST", "/api/drama/brainstorm", {"seed": "便利店"})
ideas = r.get("ideas", []) if isinstance(r, dict) else []
check("brainstorm", st == 200 and r.get("ok") and len(ideas) >= 1
      and all(x.get("logline") for x in ideas),
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r,
       "t0": ideas[0].get("title") if ideas else r})

# 8.6 带台词章节分镜(withLines=true;真实调用一次,验证 lines/章节 scene)
st, r = call("POST", f"/api/drama/projects/{pid}/storyboard", {"nShots": 4, "withLines": True})
shots = r.get("project", {}).get("shots", []) if isinstance(r, dict) else []
last4 = shots[-4:] if len(shots) >= 4 else []
check("storyboard withLines", st == 200 and r.get("ok") and len(last4) == 4
      and all(s.get("firstPrompt") for s in last4)
      and all(s.get("lines") for s in last4)
      and all(s["scene"][:1] in "起承转合" for s in last4),
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r,
       "sample": {k: (last4[0][k][:40] if last4 else "") for k in ("scene", "lines")}})

# 9. 清理:删除联调项目
st, r = call("POST", f"/api/drama/projects/{pid}/delete")
check("delete project", st == 200 and r.get("ok"), r)
st, r = call("GET", f"/api/drama/projects/{pid}")
check("deleted gone", st == 404, st)

print("ALL PASS")
