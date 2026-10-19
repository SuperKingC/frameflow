# -*- coding: utf-8 -*-
"""短剧工作台 API 回归(v2 剧集三层结构 + 异步任务)。
用法: python tools/drama_api_test.py [BASE](缺省 http://127.0.0.1:8437)
真 LLM 用例(storyboard/reprompt/brainstorm/withLines/lines-ideas)走 ip+":opt" 宽松额度
(3 次/分钟),撞 429 等 65s 重试;其余用例零成本。
覆盖:建剧自动带第 1 集 / eps 增改选删 / 按集镜头 CRUD(eid 与旧路径兼容)/ 素材跨集落盘
/ 三视图 / 异步 compose(轮询 composeJob)+ 按集成片 + warnings / 异步 tts / 章节分镜 /
灵感现编 / shots/clear / 集删除素材清理。"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8437"
# 文件存在性检查必须指向被测实例的落盘区:8439 等测试实例由 FRAMEFLOW_GENWORK_DIR 重定向
GEN = Path("genwork/.drama_test") if ":8439" in BASE else Path("genwork")


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
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:220]) if detail else ""))
    if not cond:
        sys.exit(1)


def ep_of(proj, eid):
    return next(e for e in proj["episodes"] if e["id"] == eid)


def cur_ep(proj):
    return ep_of(proj, proj["currentEpisode"])


def shot_of(proj, eid, sid):
    return next(s for s in ep_of(proj, eid)["shots"] if s["id"] == sid)


def poll_job(pid, eid, kind, sid=None, timeout=240):
    """轮询 composeJob/ttsJob 到终态,返回 (最后状态, 最后一次 project 快照)。"""
    deadline = time.time() + timeout
    job, proj = {}, None
    while time.time() < deadline:
        st, r = call("GET", f"/api/drama/projects/{pid}")
        if st == 200 and r.get("ok"):
            proj = r["project"]
            ep = ep_of(proj, eid)
            job = (ep.get("composeJob") if kind == "compose"
                   else next((s.get("ttsJob") for s in ep.get("shots", []) if s["id"] == sid), None)) or {}
            if job.get("state") in ("done", "error"):
                return job, proj
        time.sleep(1.5)
    return job, proj


def make_media(pid, name, size, dur=None):
    """ffmpeg 生成测试图/视频并 b64;真产物保证 mime 判断与合成链路真实。"""
    out = GEN / "drama" / pid / name
    out.parent.mkdir(parents=True, exist_ok=True)
    if dur:
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", f"testsrc=size={size}:rate=24:duration={dur}",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True)
    else:
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", f"testsrc=size={size}", "-frames:v", "1",
                        str(out)], check=True)
    return base64.b64encode(out.read_bytes()).decode()


# ---------- 1. 建项目(自动带第 1 集) ----------
st, r = call("POST", "/api/drama/projects", {"title": "接口联调短剧", "aspect": "9:16",
             "logline": "深夜便利店,一只会说话的猫告诉打工女孩,明天世界会重置一次",
             "style": "日系赛璐璐动漫,柔和光影"})
check("create project", st == 200 and r.get("ok") and r["project"]["id"], r)
pid = r["project"]["id"]
proj = r["project"]
e1 = proj["currentEpisode"]
check("create has ep1", len(proj["episodes"]) == 1 and proj["episodes"][0]["shots"] == []
      and proj["episodes"][0]["id"] == e1, proj["episodes"])
check("create ep shape", e1.startswith("e") and len(e1) == 12, e1)

# ---------- 2. 列表 / 读取 / 更新 ----------
st, r = call("GET", "/api/drama/projects")
mine = next((p for p in r["projects"] if p["id"] == pid), {})
check("list projects", st == 200 and mine.get("episodeCount") == 1, {"found": bool(mine), **mine})
st, r = call("GET", f"/api/drama/projects/{pid}")
check("get project", st == 200 and r["project"]["title"] == "接口联调短剧", r)
st, r = call("POST", f"/api/drama/projects/{pid}/update", {"style": "日系赛璐璐动漫,柔和光影,霓虹夜色"})
check("update project", st == 200 and r["project"]["style"].endswith("霓虹夜色"), r)
st, r = call("POST", f"/api/drama/projects/{pid}/update", {"beat": "twist"})
check("beat set", st == 200 and r["project"]["beat"] == "twist", r.get("project", {}).get("beat"))
st, r = call("POST", f"/api/drama/projects/{pid}/update", {"beat": "bogus"})
check("beat invalid cleared", st == 200 and r["project"]["beat"] == "", r.get("project", {}).get("beat"))

# ---------- 3. 集增改选 ----------
st, r = call("POST", f"/api/drama/projects/{pid}/eps/add", {"synopsis": "第二集:黑猫揭示真相"})
check("eps add", st == 200 and r.get("ok") and len(r["project"]["episodes"]) == 2
      and r["project"]["episodes"][1]["title"] == "第 2 集", r.get("project", {}).get("episodes"))
e2 = r["episodeId"]
check("eps add becomes current", r["project"]["currentEpisode"] == e2, e2)
st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/update",
             {"title": "第二集·夜", "synopsis": "第二集:黑猫揭示便利店重置的真相"})
check("eps update", st == 200 and ep_of(r["project"], e2)["title"] == "第二集·夜"
      and "真相" in ep_of(r["project"], e2)["synopsis"], r.get("project", {}).get("episodes"))
st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e1}/select", {})
check("eps select", st == 200 and r["project"]["currentEpisode"] == e1, r.get("project", {}).get("currentEpisode"))

# ---------- 4. 角色 ----------
st, r = call("POST", f"/api/drama/projects/{pid}/chars/add", {"name": "小满", "desc": "22岁打工女孩,短发,便利店制服"})
check("char add", st == 200 and len(r["project"]["chars"]) == 1, r)
cid = r["project"]["chars"][0]["id"]
check("char v2 fields", r["project"]["chars"][0]["traits"] == [] and "traitTaskId" in r["project"]["chars"][0],
      r["project"]["chars"][0])
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/update", {"name": "小满"})
check("char update", st == 200 and r["project"]["chars"][0]["name"] == "小满", r)

# ---------- 5. 镜头增改排删(eid 与旧路径兼容) ----------
st, r = call("POST", f"/api/drama/projects/{pid}/shots/add",
             {"scene": "夜·便利店门口", "desc": "小满瘫坐在台阶上,猫突然开口说话",
              "firstPrompt": "深夜便利店门口,打工女孩坐在台阶上,一只黑猫蹲在她面前开口说话",
              "motionPrompt": "女孩惊讶抬头,黑猫尾巴轻摆", "duration": 5})
check("shot add (current ep)", st == 200 and len(cur_ep(r["project"])["shots"]) == 1, r)
s1 = cur_ep(r["project"])["shots"][0]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/add", {"scene": "夜·店内", "desc": "第二镜"})
check("shot add 2", st == 200 and len(cur_ep(r["project"])["shots"]) == 2, r)
s2 = cur_ep(r["project"])["shots"][1]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/add", {"eid": e2, "scene": "夜·天台", "desc": "反转"})
check("shot add with eid", st == 200 and len(ep_of(r["project"], e2)["shots"]) == 1
      and len(ep_of(r["project"], e1)["shots"]) == 2, r)
s3 = ep_of(r["project"], e2)["shots"][0]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/update", {"duration": 60})
check("duration clamped (legacy path)", st == 200
      and shot_of(r["project"], e1, s1)["duration"] == 30, r)
st, r = call("POST", f"/api/drama/projects/{pid}/shots/reorder",
             {"eid": e1, "order": [s2, s1]})
check("shot reorder", st == 200 and [s["id"] for s in ep_of(r["project"], e1)["shots"]] == [s2, s1], r)

# ---------- 6. 素材落盘:角色定妆 / 三视图 / 逐镜成片(跨集) ----------
png_b64 = make_media(pid, "test_char.png", "360x480")
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "char", "id": cid, "kind": "portrait", "dataUrl": "data:image/png;base64," + png_b64})
check("char portrait asset", st == 200 and r["project"]["chars"][0]["asset"] == f"chars/{cid}.png", r)

trait_b64 = make_media(pid, "test_trait.png", "200x260")
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "char", "id": cid, "kind": "trait", "dataUrl": "data:image/png;base64," + trait_b64})
check("trait add", st == 200 and r["project"]["chars"][0]["traits"] == [f"chars/{cid}_trait1.png"], r)
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "char", "id": cid, "kind": "trait", "dataUrl": "data:image/png;base64," + trait_b64})
check("trait add 2", st == 200 and len(r["project"]["chars"][0]["traits"]) == 2, r)
st, body = call("GET", f"/api/drama/projects/{pid}/asset/chars/{cid}_trait2.png", raw=True)
check("trait served", st == 200 and len(body) > 100 and body[:4] == b"\x89PNG", (st, len(body)))
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/traits/delete", {"index": 1})
check("trait delete", st == 200 and r["project"]["chars"][0]["traits"] == [f"chars/{cid}_trait2.png"], r)

for sid, eid in ((s2, e1), (s3, e2)):  # s2 在 ep1、s3 在 ep2,跨集各落一个
    b64 = make_media(pid, f"c_{sid}.mp4", "540x960", dur=1)
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "shot", "id": sid, "kind": "clip", "dataUrl": "data:video/mp4;base64," + b64})
    check(f"shot clip asset {sid[:6]}", st == 200 and shot_of(r["project"], eid, sid)["clip"], r)

# ---------- 6.5 关键镜抽卡(P1.2)+ 成本累计(P1.3) ----------
b64b = make_media(pid, f"c_{s2}_b.mp4", "540x960", dur=1)
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "shot", "id": s2, "kind": "clip", "cost": 0.25,
              "dataUrl": "data:video/mp4;base64," + b64b})
proj = r["project"]
s2now = shot_of(proj, e1, s2)
takes_c = [t for t in (s2now.get("takes") or []) if t.get("kind") == "clip"]
check("take 2 appended", st == 200 and len(takes_c) == 2
      and str(s2now.get("clipTakeSel")).startswith("t2") and s2now["clip"] == takes_c[-1]["rel"],
      {"takes": len(takes_c), "sel": s2now.get("clipTakeSel")})
check("cost accumulated", (s2now.get("cost") or 0) >= 0.25, s2now.get("cost"))
t1rel = takes_c[0]["rel"]
t1id = takes_c[0]["id"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s2}/update", {"clipTakeSel": t1id})
if not (isinstance(r, dict) and r.get("project")):
    print("FAIL take switch request |", r); sys.exit(1)
s2now = shot_of(r["project"], e1, s2)
check("take switch to t1", st == 200 and s2now["clip"] == t1rel
      and s2now.get("clipTakeSel") == t1id, {"clip": s2now.get("clip")})

# ---------- 7. 素材读取 / 非法路径 / 缺键报错 ----------
st, body = call("GET", f"/api/drama/projects/{pid}/asset/composed.mp4", raw=True)  # 旧片不存在,404 可
st, r = call("GET", f"/api/drama/projects/{pid}/asset/../project.json", raw=True)
check("traversal rejected", st in (400, 404), st)
st, r = call("POST", f"/api/drama/projects/{pid}/asset", {"target": "shot", "id": s1, "kind": "first"})
check("asset missing keys err", st == 400 and "keys=[target,id,kind]" in r.get("error", ""), r)

# ---------- 8. meta + 角色参考图 ----------
st, r = call("GET", "/api/drama/meta")
check("meta styles/ideas", st == 200 and r.get("ok") and len(r.get("styles", [])) >= 8
      and len(r.get("ideas", [])) >= 1 and all("logline" in x for x in r["ideas"]),
      {"styles": len(r.get("styles", [])), "idea0": (r.get("ideas") or [{}])[0].get("title")})
for i in (1, 2):
    up = make_media(pid, f"up{i}.png", "200x260")
    st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/refs/add",
                 {"dataUrl": "data:image/png;base64," + up})
    check(f"char ref add {i}", st == 200 and len(r["project"]["chars"][0]["refs"]) == i, r)
refs = r["project"]["chars"][0]["refs"]
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/refs/delete", {"index": 1})
check("char ref delete", st == 200 and len(r["project"]["chars"][0]["refs"]) == 1
      and not Path(str(GEN / "drama") + f"/{pid}/{refs[0]}").exists(), r)

# ---------- 9. portraitTaskId 清除 ----------
st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/update", {"portraitTaskId": "abc123"})
check("portraitTaskId set", st == 200 and r["project"]["chars"][0]["portraitTaskId"] == "abc123", r)
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "char", "id": cid, "kind": "portrait", "dataUrl": "data:image/png;base64," + png_b64})
check("portrait asset clears taskId", st == 200 and r["project"]["chars"][0]["portraitTaskId"] is None
      and r["project"]["chars"][0]["asset"].startswith("chars/"), r)

# ---------- 10. 异步 compose(无 eid → 当前集)→ 轮询 → 按集成片 served + warnings ----------
st, r = call("POST", f"/api/drama/projects/{pid}/compose", {})
check("compose start async", st == 200 and r.get("ok")
      and (cur_ep(r["project"]).get("composeJob") or {}).get("state") == "running", r)
job, proj = poll_job(pid, e1, "compose")
check("compose done", job.get("state") == "done", job)
check("composed rel", proj and cur_ep(proj)["composed"] == f"composed_{e1}.mp4",
      proj and cur_ep(proj)["composed"])
st, body = call("GET", f"/api/drama/projects/{pid}/asset/composed_{e1}.mp4", raw=True)
check("composed served", st == 200 and len(body) > 10000 and body[4:8] == b"ftyp", (st, len(body)))
st, r = call("GET", f"/api/drama/projects/{pid}/warnings?eid={e1}")
check("warnings endpoint", st == 200 and r.get("ok") and isinstance(r.get("warnings"), list), r)

# ---------- 10.5 compose e2 + 全剧重混(P2.6) ----------
st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/compose", {"burnSubs": False})
check("compose e2 start", st == 200 and r.get("ok"), r)
job, proj = poll_job(pid, e2, "compose")
check("compose e2 done", job.get("state") == "done", job)
st, r = call("POST", f"/api/drama/projects/{pid}/remix", {})
check("remix start", st == 200 and r.get("ok")
      and (r["project"].get("remixJob") or {}).get("state") == "running", r)
deadline = time.time() + 240
rj = {}
while time.time() < deadline:
    st, r = call("GET", f"/api/drama/projects/{pid}")
    rj = (r.get("project", {}).get("remixJob") or {}) if isinstance(r, dict) else {}
    if rj.get("state") in ("done", "error"):
        break
    time.sleep(2)
check("remix done", rj.get("state") == "done", rj)
st, body = call("GET", f"/api/drama/projects/{pid}/asset/series.mp4", raw=True)
check("series served", st == 200 and len(body) > 10000 and body[4:8] == b"ftyp", (st, len(body)))

# ---------- 11. 台词/TTS 异步 ----------
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s2}/update",
             {"lines": "小满:今天怎么不进来?\n黑猫:在等你换班。"})
check("lines update", st == 200 and "换班" in shot_of(r["project"], e1, s2)["lines"], r)
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/tts", {})
check("tts no lines rejected", st == 400 and "对白" in r.get("error", ""), r)
st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s2}/tts", {})
check("tts start async", st == 200 and r.get("ok"), r)
job, proj = poll_job(pid, e1, "tts", sid=s2, timeout=120)
check("tts done", job.get("state") == "done", job)
s2cur = shot_of(proj, e1, s2)
check("tts attached", bool(s2cur["tts"]) and (s2cur.get("ttsDur") or 0) > 0, s2cur.get("tts"))
st, body = call("GET", f"/api/drama/projects/{pid}/asset/{s2cur['tts']}", raw=True)
check("tts served", st == 200 and len(body) > 5000 and body[:4] == b"RIFF", (st, len(body)))

# ---------- 12. 分镜 LLM(真实调用;opt 档 3 次/分钟,撞 429 等 65s) ----------
added = []
for attempt in (1, 2):
    st, r = call("POST", f"/api/drama/projects/{pid}/storyboard", {"nShots": 4})
    added = (r.get("added") or []) if isinstance(r, dict) else []
    if st == 200 and r.get("ok") and len(added) >= 4 and all(s.get("firstPrompt") for s in added):
        break
    if st == 429 and attempt == 1:
        time.sleep(65)
check("storyboard", st == 200 and r.get("ok") and len(added) >= 4
      and all(s.get("firstPrompt") for s in added)
      and added[0].get("key") is True and added[-1].get("key") is True,
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r,
       "added": len(added), "noPrompt": sum(1 for s in added if not s.get("firstPrompt"))})
st, r = call("GET", f"/api/drama/projects/{pid}")
check("storyboard landed in ep1", len(ep_of(r["project"], e1)["shots"]) == 6, r)

# 13. reprompt(真 LLM)
for attempt in (1, 2):
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s3}/reprompt",
                 {"desc": "小满在天台吹风,黑猫说出重置的秘密"})
    if st == 200 and r.get("ok"):
        break
    if st == 429 and attempt == 1:
        time.sleep(65)
rp = shot_of(r["project"], e2, s3) if isinstance(r, dict) and r.get("project") else {}
check("shot reprompt", st == 200 and r.get("ok") and rp.get("firstPrompt") and rp.get("motionPrompt"),
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r})

# 14. brainstorm(真 LLM)
for attempt in (1, 2):
    st, r = call("POST", "/api/drama/brainstorm", {"seed": "便利店"})
    if st == 200 and r.get("ok"):
        break
    if st == 429 and attempt == 1:
        time.sleep(65)
ideas = r.get("ideas", []) if isinstance(r, dict) else []
check("brainstorm", st == 200 and len(ideas) >= 1 and all(x.get("logline") for x in ideas),
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r})

# 15. withLines 章节分镜(真 LLM)
added = []
for attempt in (1, 2):
    st, r = call("POST", f"/api/drama/projects/{pid}/storyboard", {"nShots": 4, "withLines": True})
    proj = r.get("project", {}) if isinstance(r, dict) else {}
    shots = ep_of(proj, e1)["shots"] if proj else []
    added = [s for s in shots if s.get("lines") and len(s["scene"]) > 1 and s["scene"][0] in "起承转合"]
    if st == 200 and r.get("ok") and len(added) >= 2:
        break
    if st == 429 and attempt == 1:
        time.sleep(65)
check("storyboard withLines", st == 200 and r.get("ok") and len(added) >= 2,
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r,
       "chapters": [s["scene"][:12] for s in added][:4]})

# 16. lines-ideas(真 LLM)
for attempt in (1, 2):
    st, r = call("POST", f"/api/drama/projects/{pid}/lines-ideas", {"seed": "小满在收银台打瞌睡"})
    if st == 200 and r.get("ok") and r.get("ideas"):
        break
    if st == 429 and attempt == 1:
        time.sleep(65)
check("lines ideas", st == 200 and r.get("ok") and r.get("ideas")
      and all(x.get("lines") for x in r["ideas"]),
      {"st": st, "err": r.get("error") if isinstance(r, dict) else r})

# ---------- 17. shots/clear(eid;素材删,角色/定妆保留) ----------
clip_path = Path(str(GEN / "drama") + f"/{pid}/shots/{s2}_clip.mp4")
tts_path = Path(str(GEN / "drama") + f"/{pid}/shots/{s2}_tts.wav")
char_path = Path(str(GEN / "drama") + f"/{pid}/chars/{cid}.png")
st, r = call("POST", f"/api/drama/projects/{pid}/shots/clear", {"eid": e1})
proj = r.get("project", {})
check("shots clear", st == 200 and ep_of(proj, e1)["shots"] == []
      and not clip_path.exists() and not tts_path.exists() and char_path.exists(),
      {"st": st, "shots": len(ep_of(proj, e1)["shots"]) if proj else -1,
       "clipGone": not clip_path.exists(), "ttsGone": not tts_path.exists(),
       "charKept": char_path.exists()})

# ---------- 18. 集删除(素材清理) ----------
st, r = call("POST", f"/api/drama/projects/{pid}/eps/add", {"title": "待删集"})
e3 = r["episodeId"]
st, r = call("POST", f"/api/drama/projects/{pid}/shots/add",
             {"eid": e3, "scene": "x", "desc": "待删"})
s4 = ep_of(r["project"], e3)["shots"][0]["id"]
b64 = make_media(pid, f"c_{s4}.mp4", "540x960", dur=1)
st, r = call("POST", f"/api/drama/projects/{pid}/asset",
             {"target": "shot", "id": s4, "kind": "clip", "dataUrl": "data:video/mp4;base64," + b64})
check("ep3 clip asset", st == 200, r)
st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e3}/delete", {})
check("episode delete", st == 200 and all(e["id"] != e3 for e in r["project"]["episodes"])
      and not Path(str(GEN / "drama") + f"/{pid}/shots/{s4}_clip.mp4").exists(),
      {"eps": len(r["project"]["episodes"])})
st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/select", {})
check("select after delete", st == 200 and r["project"]["currentEpisode"] == e2, r)

# ---------- 19. 清理 ----------
st, r = call("POST", f"/api/drama/projects/{pid}/delete")
check("delete project", st == 200 and r.get("ok"), r)
st, r = call("GET", f"/api/drama/projects/{pid}")
check("deleted gone", st == 404, st)

print("ALL PASS")
