# -*- coding: utf-8 -*-
"""短剧 P2 冒烟:自起 8440 实例,不调真 LLM。
覆盖:BGM 上传(wav 合法 / 扩展名拒绝 / clear 清除落盘)→ compose 带 BGM(-12dB 垫底,
ffprobe 验音轨)与 bgm:false 对照(无音轨)→ 封面抽取(3 帧 cover_<eid>_<1..3>.jpg,
资产端点 served)→ 封面直通 ops 素材库(/api/ops/library 列表 + file 直链取回)→
全剧重混 remix(series.mp4 served,时长 > 单集)。"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8440"
ROOT = Path(__file__).resolve().parent.parent
PORT = 8440
TMP = ROOT / "genwork" / "_p2_smoke"


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
        raw_body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw_body)
        except Exception:
            return e.code, raw_body


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:260]) if detail else ""), flush=True)
    if not cond:
        cleanup()
        sys.exit(1)


def b64(path):
    return base64.b64encode(Path(path).read_bytes()).decode()


def make_mp4(path, dur=1):
    """无音轨测试视频(testsrc 纯视频)。"""
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"testsrc=size=540x960:rate=24:duration={dur}",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)


def make_wav(path, dur=2):
    """测试 BGM:440Hz 正弦波 wav。"""
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
                    "-ar", "44100", "-ac", "2", str(path)], check=True)


def ffprobe_has_audio(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=codec_name", "-of", "csv=p=0",
                        str(path)], capture_output=True)
    return bool(r.stdout.decode("utf-8", "replace").strip())


def ffprobe_duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(path)], capture_output=True)
    try:
        return float(r.stdout.decode().strip())
    except ValueError:
        return 0.0


def wait_job(pid, eid, kind, timeout=180):
    """轮询 composeJob/remixJob 到终态;返回最后状态。"""
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        st, r = call("GET", f"/api/drama/projects/{pid}")
        if st == 200 and r.get("ok"):
            proj = r["project"]
            if kind == "compose":
                ep = next((e for e in proj["episodes"] if e["id"] == eid), None) or {}
                last = ep.get("composeJob") or {}
            else:
                last = proj.get("remixJob") or {}
            if last.get("state") in ("done", "error"):
                return last
        time.sleep(1.5)
    return last


def cleanup():
    pass


# ---------- 0. 起 8440 实例 ----------
print("booting server on", PORT, flush=True)
proc = subprocess.Popen([sys.executable, "server.py", "--port", str(PORT), "--no-browser"],
                        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
TMP.mkdir(parents=True, exist_ok=True)
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

    # ---------- 1. 建项目(2 集) ----------
    st, r = call("POST", "/api/drama/projects",
                 {"title": "P2冒烟短剧", "aspect": "9:16",
                  "logline": "P2 功能冒烟:BGM/封面/重混全链路",
                  "style": "日系赛璐璐动漫,柔和光影"})
    check("create project", st == 200 and r.get("ok"), r)
    pid = r["project"]["id"]
    e1 = r["project"]["currentEpisode"]
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/add", {"synopsis": "第二集:bgm 对照"})
    check("eps add", st == 200 and r.get("ok"), r)
    e2 = r["episodeId"]

    # ---------- 2. 镜头 + 无音轨 clip 落盘 ----------
    shots = {}
    for eid, n in ((e1, 2), (e2, 1)):
        for i in range(n):
            st, r = call("POST", f"/api/drama/projects/{pid}/shots/add",
                         {"eid": eid, "scene": f"镜{i + 1}", "desc": "冒烟镜头", "duration": 3})
            check(f"shot add ep{'12'[0 if eid == e1 else 1]}-{i}", st == 200, r)
            sid = next(e for e in r["project"]["episodes"] if e["id"] == eid)["shots"][i]["id"]
            mp4 = TMP / f"c_{sid}.mp4"
            make_mp4(mp4, dur=2)
            st, r = call("POST", f"/api/drama/projects/{pid}/asset",
                         {"target": "shot", "id": sid, "kind": "clip",
                          "dataUrl": "data:video/mp4;base64," + b64(mp4)})
            check(f"clip asset {sid[:6]}", st == 200, r)
            shots[sid] = eid

    # ---------- 3. BGM 上传 ----------
    wav = TMP / "bgm_test.wav"
    make_wav(wav, dur=2)
    st, r = call("POST", f"/api/drama/projects/{pid}/bgm",
                 {"dataUrl": "data:audio/wav;base64," + b64(wav)})
    check("bgm upload", st == 200 and r.get("ok") and r["project"].get("bgm") == "bgm.wav", r)
    check("bgm file on disk", (ROOT / "genwork" / "drama" / pid / "bgm.wav").is_file())

    # 非法扩展名拒绝(png 冒充音频)
    png = TMP / "fake.png"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=60x60", "-frames:v", "1", str(png)], check=True)
    st, r = call("POST", f"/api/drama/projects/{pid}/bgm",
                 {"dataUrl": "data:image/png;base64," + b64(png)})
    check("bgm invalid ext rejected", st == 400 and "mp3" in r.get("error", ""), (st, r))

    # ---------- 4. compose ep1(默认带 BGM + 烧字幕) ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e1}/compose",
                 {"burnSubs": True})  # bgm 不传 → 默认 true
    check("compose ep1 start", st == 200 and r.get("ok"), r)
    job = wait_job(pid, e1, "compose")
    check("compose ep1 done", job.get("state") == "done", job)
    composed1 = ROOT / "genwork" / "drama" / pid / f"composed_{e1}.mp4"
    check("composed ep1 exists", composed1.is_file())
    check("composed ep1 has audio(BGM 垫底)", ffprobe_has_audio(composed1),
          ffprobe_duration(composed1))
    check("composed ep1 duration ok", abs(ffprobe_duration(composed1) - 4.0) < 0.8,
          ffprobe_duration(composed1))

    # ---------- 5. 封面抽取(P2-3) ----------
    st, r = call("GET", f"/api/drama/projects/{pid}")
    ep1 = next(e for e in r["project"]["episodes"] if e["id"] == e1)
    expect_covers = [f"cover_{e1}_{i}.jpg" for i in (1, 2, 3)]
    check("ep1 covers in project", ep1.get("covers") == expect_covers, ep1.get("covers"))
    for cn in expect_covers:
        cf = ROOT / "genwork" / "drama" / pid / cn
        check(f"cover file {cn}", cf.is_file() and cf.stat().st_size > 1000, cf.stat().st_size if cf.is_file() else -1)
        st, body = call("GET", f"/api/drama/projects/{pid}/asset/{cn}", raw=True)
        check(f"cover served {cn}", st == 200 and body[:3] == b"\xff\xd8\xff", (st, len(body)))

    # ---------- 6. compose ep2(bgm:false 对照;burnSubs:false) ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/eps/{e2}/compose",
                 {"burnSubs": False, "bgm": False})
    check("compose ep2 start", st == 200 and r.get("ok"), r)
    job = wait_job(pid, e2, "compose")
    check("compose ep2 done", job.get("state") == "done", job)
    composed2 = ROOT / "genwork" / "drama" / pid / f"composed_{e2}.mp4"
    check("composed ep2 exists", composed2.is_file())
    check("composed ep2 NO audio(bgm:false,clip 无音轨)", not ffprobe_has_audio(composed2),
          ffprobe_duration(composed2))
    st, r = call("GET", f"/api/drama/projects/{pid}")
    ep2 = next(e for e in r["project"]["episodes"] if e["id"] == e2)
    check("ep2 covers extracted", len(ep2.get("covers") or []) == 3, ep2.get("covers"))

    # ---------- 7. 封面直通 ops 素材库 ----------
    st, r = call("GET", "/api/ops/library")
    check("ops library scan", st == 200 and r.get("ok") and isinstance(r.get("items"), list), r)
    lib_names = [x["name"] for x in r.get("items", [])]
    want = [f"drama-{pid}-cover-{e1}-{i}.jpg" for i in (1, 2, 3)]
    got = [n for n in want if n in lib_names]
    check("covers in ops library", len(got) == 3, {"want": want, "got": got})
    st, body = call("GET", f"/api/ops/library/file/{want[0]}", raw=True)
    check("ops cover served", st == 200 and body[:3] == b"\xff\xd8\xff", (st, len(body)))

    # ---------- 8. BGM 清除 ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/bgm", {"clear": True})
    check("bgm clear", st == 200 and r.get("ok") and not r["project"].get("bgm"), r)
    check("bgm file removed", not (ROOT / "genwork" / "drama" / pid / "bgm.wav").is_file())

    # ---------- 9. 全剧重混(P2.5/2.6) ----------
    st, r = call("POST", f"/api/drama/projects/{pid}/remix", {})
    check("remix start", st == 200 and r.get("ok")
          and (r["project"].get("remixJob") or {}).get("state") == "running", r)
    rj = wait_job(pid, e1, "remix")
    check("remix done", rj.get("state") == "done", rj)
    series = ROOT / "genwork" / "drama" / pid / "series.mp4"
    check("series.mp4 exists", series.is_file())
    st, body = call("GET", f"/api/drama/projects/{pid}/asset/series.mp4", raw=True)
    check("series served", st == 200 and body[4:8] == b"ftyp", (st, len(body)))
    d_series = ffprobe_duration(series)
    d_e1 = ffprobe_duration(composed1)
    d_e2 = ffprobe_duration(composed2)
    check("series duration > 单集(含字卡)", d_series > max(d_e1, d_e2),
          {"series": d_series, "e1": d_e1, "e2": d_e2})

    # ---------- 10. 清理 ----------
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
