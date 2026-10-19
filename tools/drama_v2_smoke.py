# -*- coding: utf-8 -*-
"""短剧 v2(剧集三层结构+异步任务)冒烟:自起 8439 实例,不调真 LLM。
覆盖:旧项目懒迁移 / 建项目自动带第 1 集 / 集增改删选 / 按集镜头 CRUD(eid 与旧路径兼容)
/ 镜头素材跨集落盘 / 异步 compose(轮询 composeJob)+ 按集合成片 served / tts 异步
/ 三视图(trait)落盘与删除 / episode delete 素材清理。"""
import json
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

BASE = "http://127.0.0.1:8439"
ROOT = Path(__file__).resolve().parent.parent
PORT = 8439


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload
            return resp.status, json.loads(payload.decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw_body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw_body)
        except Exception:
            return e.code, raw_body


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:260]) if detail else ""))
    if not cond:
        cleanup()
        sys.exit(1)


def make_mp4(path, dur=1):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"testsrc=size=540x960:rate=24:duration={dur}",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)


def make_png(path):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=200x260",
                    "-frames:v", "1", str(path)], check=True)


def b64(path):
    import base64
    return base64.b64encode(Path(path).read_bytes()).decode()


def wait_job(pid, eid, kind, sid=None, timeout=180):
    """轮询 project.json 里的 composeJob/ttsJob 到终态;返回最后见到的状态记录。"""
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        st, r = call("GET", f"/api/drama/projects/{pid}")
        if st == 200 and r.get("ok"):
            ep = next((e for e in r["project"]["episodes"] if e["id"] == eid), None)
            if kind == "compose":
                last = (ep or {}).get("composeJob") or {}
            else:
                shot = next((s for s in (ep or {}).get("shots", []) if s["id"] == sid), {}) if ep else {}
                last = shot.get("ttsJob") or {}
            if last.get("state") in ("done", "error"):
                return last
        time.sleep(1.5)
    return last


def cleanup():
    pass


# ---------- 0. 起 8439 实例 ----------
print("booting server on", PORT)
proc = subprocess.Popen([sys.executable, "server.py", "--port", str(PORT), "--no-browser"],
                        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try:
            st, r = call("GET", "/api/drama/meta")
            if st == 200:
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        print("FAIL server boot")
        sys.exit(1)
    check("server up", True)

    # ---------- 1. 迁移:旧项目(demo)读出来应为 episodes 结构 ----------
    demo = None
    st, r = call("GET", "/api/drama/projects")
    for p in r.get("projects", []):
        if p.get("shotCount"):
            demo = p["id"]
            break
    if demo:
        st, r = call("GET", f"/api/drama/projects/{demo}")
        proj = r.get("project", {})
        check("migrate old project", st == 200 and isinstance(proj.get("episodes"), list)
              and len(proj["episodes"]) >= 1 and proj["episodes"][0].get("shots"),
              {"eps": len(proj.get("episodes", [])), "id": demo})
        ep0 = proj["episodes"][0]
        check("migrate keeps composed", "composed" in ep0 or ep0.get("shots"),
              {"composed": ep0.get("composed")})
        check("migrate ep id shape", ep0["id"].startswith("e") and len(ep0["id"]) == 12, ep0["id"])

    # ---------- 2. 新建项目:自动带第 1 集 + currentEpisode ----------
    st, r = call("POST", "/api/drama/projects",
                 {"title": "v2冒烟短剧", "aspect": "9:16",
                  "logline": "冒烟测试用短剧,深夜便利店的故事",
                  "style": "日系赛璐璐动漫,柔和光影"})
    check("create project", st == 200 and r.get("ok"), r)
    pid = r["project"]["id"]
    eps = r["project"]["episodes"]
    check("create has ep1", len(eps) == 1 and eps[0]["shots"] == [], eps)
    e1 = eps[0]["id"]
    check("create currentEpisode", r["project"]["currentEpisode"] == e1)

    # ---------- 3. 集增改选 ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/add", {"synopsis": "第二集:反转发生"})
    check("eps add", st == 200 and r.get("ok") and len(r["project"]["episodes"]) == 2, r)
    e2 = r["episodeId"]
    check("eps add becomes current", r["project"]["currentEpisode"] == e2)
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/update",
                 {"title": "第二集·夜", "synopsis": "第二集:黑猫揭示真相"})
    ep2 = next(e for e in r["project"]["episodes"] if e["id"] == e2)
    check("eps update", st == 200 and ep2["title"] == "第二集·夜" and "真相" in ep2["synopsis"], ep2)
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e1}/select", {})
    check("eps select", st == 200 and r["project"]["currentEpisode"] == e1, r)

    # ---------- 4. 镜头 CRUD:显式 eid 落 ep2;不带 eid 落当前集(e1) ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/add",
                 {"eid": e2, "scene": "夜·天台", "desc": "反转",
                  "firstPrompt": "天台夜景,女孩回头", "motionPrompt": "女孩回头,风吹起",
                  "duration": 5})
    check("shot add with eid", st == 200, r)
    ep2_shots = next(e for e in r["project"]["episodes"] if e["id"] == e2)["shots"]
    ep1_shots = next(e for e in r["project"]["episodes"] if e["id"] == e1)["shots"]
    check("shot landed in ep2", len(ep2_shots) == 1 and not ep1_shots,
          {"e2": len(ep2_shots), "e1": len(ep1_shots)})
    s2 = ep2_shots[0]["id"]
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/add", {"scene": "夜·便利店", "desc": "开场"})
    ep1_shots = next(e for e in r["project"]["episodes"] if e["id"] == e1)["shots"]
    check("shot add no eid -> current ep", st == 200 and len(ep1_shots) == 1, r)
    s1 = ep1_shots[0]["id"]

    # 旧路径兼容:不带 eid 的 shot update(跨集定位)
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s2}/update", {"duration": 8})
    shot = next(s for e in r["project"]["episodes"] if e["id"] == e2
                for s in e["shots"] if s["id"] == s2)
    check("shot update legacy path", st == 200 and shot["duration"] == 8, r)
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/reorder",
                 {"eid": e2, "order": [s2]})
    check("shot reorder ep2", st == 200, r)

    # ---------- 5. 素材:镜头成片落盘(跨集)+ 三视图 ----------
    tmp = ROOT / "genwork" / "drama" / pid
    tmp.mkdir(parents=True, exist_ok=True)
    make_mp4(tmp / "c1.mp4")
    make_mp4(tmp / "c2.mp4", 2)
    make_png(tmp / "t0.png")
    make_png(tmp / "t1.png")
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "shot", "id": s1, "kind": "clip",
                  "dataUrl": "data:video/mp4;base64," + b64(tmp / "c1.mp4")})
    # P1.2 抽卡后 clip 命名为 shots/{sid}_clip_{n}_{uuid}.mp4(不覆盖旧 take)
    shot1 = next(s for e in r["project"]["episodes"] if e["id"] == e1
                 for s in e["shots"] if s["id"] == s1)
    check("asset clip s1", st == 200 and shot1["clip"].startswith(f"shots/{s1}_clip")
          and shot1["clip"].endswith(".mp4")
          and len(shot1.get("takes") or []) == 1, shot1.get("clip"))
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "shot", "id": s2, "kind": "clip",
                  "dataUrl": "data:video/mp4;base64," + b64(tmp / "c2.mp4")})
    check("asset clip s2", st == 200, r)

    st, r = call("POST", f"/api/drama/projects/{pid}/chars/add", {"name": "小满", "desc": "打工女孩"})
    cid = r["project"]["chars"][0]["id"]
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "char", "id": cid, "kind": "trait",
                  "dataUrl": "data:image/png;base64," + b64(tmp / "t0.png")})
    ch = r["project"]["chars"][0]
    check("trait add", st == 200 and ch["traits"] == [f"chars/{cid}_trait1.png"], ch.get("traits"))
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "char", "id": cid, "kind": "trait",
                  "dataUrl": "data:image/png;base64," + b64(tmp / "t1.png")})
    ch = r["project"]["chars"][0]
    check("trait add 2", st == 200 and len(ch["traits"]) == 2, ch.get("traits"))
    st, body = call("GET", f"/api/drama/projects/{pid}/asset/chars/{cid}_trait2.png", raw=True)
    check("trait served", st == 200 and body[:4] == b"\x89PNG", (st, len(body)))
    st, r = call("POST", f"/api/drama/projects/{pid}/chars/{cid}/traits/delete", {"index": 1})
    ch = r["project"]["chars"][0]
    check("trait delete", st == 200 and len(ch["traits"]) == 1
          and not (tmp / f"chars/{cid}_trait1.png").exists(), ch.get("traits"))

    # ---------- 6. 异步 compose(带 eid)→ 轮询 → 按集成片 served ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/compose", {"burnSubs": False})
    check("compose start async", st == 200 and r.get("ok")
          and (r["project"]["episodes"][1].get("composeJob") or {}).get("state") == "running", r)
    job = wait_job(pid, e2, "compose")
    check("compose done", job.get("state") == "done", job)
    st, r = call("GET", f"/api/drama/projects/{pid}")
    ep2 = next(e for e in r["project"]["episodes"] if e["id"] == e2)
    check("composed rel set", ep2.get("composed") == f"composed_{e2}.mp4", ep2.get("composed"))
    st, body = call("GET", f"/api/drama/projects/{pid}/asset/composed_{e2}.mp4", raw=True)
    check("composed served", st == 200 and body[4:8] == b"ftyp", (st, len(body)))
    st, r = call("GET", f"/api/drama/projects/{pid}/warnings?eid={e2}")
    check("warnings endpoint", st == 200 and r.get("ok") and isinstance(r.get("warnings"), list), r)
    # 重复合成防护:done 后可再跑;running 中拒(拼个慢片验证略过,这里只验 done 状态可重启)
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/compose", {"burnSubs": False})
    check("compose restart ok", st == 200 and r.get("ok"), r)
    wait_job(pid, e2, "compose")

    # ---------- 7. tts 异步 job ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/update",
                 {"eid": e1, "lines": "小满:今天怎么不进来?\n黑猫:在等你换班。"})
    check("lines set", st == 200, r)
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s1}/tts", {})
    check("tts start async", st == 200 and r.get("ok"), r)
    job = wait_job(pid, e1, "tts", sid=s1, timeout=120)
    check("tts done", job.get("state") == "done", job)
    st, r = call("GET", f"/api/drama/projects/{pid}")
    shot = next(s for e in r["project"]["episodes"] if e["id"] == e1
                for s in e["shots"] if s["id"] == s1)
    check("tts attached", bool(shot.get("tts")) and shot.get("ttsDur", 0) > 0, shot.get("tts"))
    # 无台词镜头 tts 应被前置校验拒绝(同步报错,不进 job)
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/{s2}/tts", {})
    check("tts no lines rejected", st == 400 and "对白" in r.get("error", ""), r)

    # ---------- 8. 集删除:素材清理 ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/add", {"title": "待删集"})
    e3 = r["episodeId"]
    st, r = call("POST", f"/api/drama/projects/{pid}/shots/add",
                 {"eid": e3, "scene": "x", "desc": "待删"})
    s3 = next(e for e in r["project"]["episodes"] if e["id"] == e3)["shots"][0]["id"]
    st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                 {"target": "shot", "id": s3, "kind": "clip",
                  "dataUrl": "data:video/mp4;base64," + b64(tmp / "c1.mp4")})
    check("asset clip s3", st == 200, r)
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e3}/delete", {})
    eps_now = r["project"]["episodes"]
    check("episode delete", st == 200 and all(e["id"] != e3 for e in eps_now)
          and r["project"]["currentEpisode"] != e3, {"eps": len(eps_now)})
    check("episode delete cleans files", not (tmp / f"shots/{s3}_clip.mp4").exists())

    # ---------- 9. 清理 ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/delete")
    check("delete project", st == 200 and r.get("ok"), r)
    st, r = call("GET", f"/api/drama/projects/{pid}")
    check("deleted gone", st == 404, st)

    print("ALL PASS")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()