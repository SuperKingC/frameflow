# -*- coding: utf-8 -*-
"""社媒运营工作台 API 联调脚本(自起服务器;python urllib 保证 UTF-8)。

用法:python tools/ops_api_test.py
覆盖:meta / 人设卡 CRUD + 标签库归一 / 选题库 / 对标库 / 帖子 CRUD + 状态流转 /
素材落盘与回读 / 发布包 zip / 素材库 / LLM 文案与拆解(真实调用,上游未配则跳过)。
"""
import io
import json
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8531
BASE = "http://127.0.0.1:%d" % PORT

# 1x1 透明 PNG(合法最小图,不依赖 ffmpeg)
TINY_PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
                "AAAABJRU5ErkJggg==")


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload, dict(resp.headers)
            return resp.status, json.loads(payload.decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body
        if raw:
            return e.code, body.encode("utf-8", "replace"), dict(e.headers)
        return e.code, parsed


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:220]) if detail else ""))
    if not cond:
        stop_server()
        sys.exit(1)


_proc = None


def stop_server():
    global _proc
    if _proc:
        _proc.terminate()
        try:
            _proc.wait(timeout=10)
        except Exception:
            _proc.kill()
        _proc = None


def free_port(start):
    p = start
    while True:
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                p += 1


def main():
    global BASE, _proc
    port = free_port(PORT)
    BASE = "http://127.0.0.1:%d" % port
    _proc = subprocess.Popen(
        [sys.executable, "-u", str(ROOT / "server.py"), "--port", str(port), "--no-browser"],
        cwd=str(ROOT), stdout=open(ROOT / "genwork" / "ops_test_srv.log", "w"),
        stderr=subprocess.STDOUT)
    deadline = time.time() + 30
    ready = False
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + "/api/ops/meta", timeout=2) as r:
                if r.status == 200:
                    ready = True
                    break
        except Exception:
            time.sleep(0.5)
    check("server ready", ready, BASE)
    import os as _os
    print("ENV parent: CODEX_API_KEY=%s IMAGE_UPSTREAM=%s" % (
        "set" if _os.environ.get("CODEX_API_KEY") else "MISSING",
        "set" if _os.environ.get("IMAGE_UPSTREAM_API_KEY") else "MISSING"))

    # 1. meta
    st, r = call("GET", "/api/ops/meta")
    check("meta", st == 200 and r.get("ok") and set(r["platforms"]) == {"xhs", "dy"}
          and len(r["pillars"]) == 3 and "xhsSearch" in r["links"], r)

    # 2. 人设:播种/已有 → 至少 1 个
    st, r = call("GET", "/api/ops/personas")
    check("personas list", st == 200 and r.get("ok") and len(r["personas"]) >= 1, r)

    # 3. 建测试人设(标签归一:去#、白名单分组)
    st, r = call("POST", "/api/ops/personas", {
        "name": "联调账号", "platforms": ["xhs", "bogus"],
        "persona": {"positioning": "联调定位", "visual": "测试视觉风格词",
                    "catchphrase": "测试!", "pillars": ["日常治愈", "乱写的"]},
        "tags": {"xhs": [{"name": "#测试 ", "group": "乱写"}, {"name": "测试", "group": "自定义"}],
                 "dy": "不是数组"}})
    check("persona create", st == 200 and r.get("ok") and r["persona"]["platforms"] == ["xhs"], r)
    persona = r["persona"]
    pid_ = persona["id"]
    check("persona tag normalized",
          [t["name"] for t in persona["tags"]["xhs"]] == ["测试"]
          and persona["tags"]["xhs"][0]["group"] == "自定义"
          and persona["tags"]["dy"] == [], persona["tags"])
    check("persona pillars normalized", persona["persona"]["pillars"] == ["日常治愈"],
          persona["persona"]["pillars"])

    # 4. 人设更新(标签库追加 + 字段)
    tags = persona["tags"]
    tags["xhs"].append({"name": "新标签", "group": "流量"})
    st, r = call("POST", "/api/ops/personas/%s/update" % pid_,
                 {"catchphrase_note": "x", "persona": {"tone": "更新后的语气"}, "tags": tags})
    persona = r["persona"]
    check("persona update", st == 200 and persona["persona"]["tone"] == "更新后的语气"
          and [t["name"] for t in persona["tags"]["xhs"]] == ["测试", "新标签"], r)

    # 5. 选题库
    st, r = call("POST", "/api/ops/topics", {"text": "联调选题一", "pillar": "日常治愈", "source": "manual"})
    check("topic create", st == 200 and r["topic"]["text"] == "联调选题一" and not r["topic"]["used"], r)
    tid = r["topic"]["id"]
    st, r = call("POST", "/api/ops/topics/%s/update" % tid, {"used": True})
    check("topic used", st == 200 and r["topic"]["used"] is True, r)
    st, r = call("GET", "/api/ops/topics")
    check("topic in list", any(t["id"] == tid for t in r["topics"]), r)
    st, r = call("POST", "/api/ops/topics/%s/delete" % tid)
    check("topic delete", st == 200 and r.get("ok"), r)

    # 6. 对标库
    st, r = call("POST", "/api/ops/research", {"platform": "dy", "url": "https://www.douyin.com/video/x",
                                               "title": "联调对标", "note": "钩子很稳",
                                               "accountId": pid_,
                                               "stats": {"likes": "12", "saves": None, "comments": "abc"}})
    check("research create", st == 200 and r["item"]["stats"] == {"likes": 12, "saves": 0, "comments": 0}
          and r["item"]["accountId"] == pid_, r)
    rid = r["item"]["id"]
    st, r = call("POST", "/api/ops/research", {"platform": "xhs", "url": "ftp://bad"})
    check("research bad url", st == 400 and "http" in r.get("error", ""), r)
    st, r = call("POST", "/api/ops/research", {"platform": "xhs", "url": "https://ok.example/a",
                                               "accountId": "zzz"})
    check("research bad accountId cleared", st == 200 and r["item"]["accountId"] == "", r)
    call("POST", "/api/ops/research/%s/delete" % r["item"]["id"])
    st, r = call("GET", "/api/ops/research")
    check("research in list", any(x["id"] == rid for x in r["items"]), r)
    st, r = call("POST", "/api/ops/research/%s/delete" % rid)
    check("research delete", st == 200 and r.get("ok"), r)

    # 7. 帖子:建(带 chosen)+ 状态流转
    st, r = call("POST", "/api/ops/posts", {
        "accountId": pid_, "topic": "联调帖子选题", "pillar": "工具彩蛋",
        "platforms": ["xhs", "dy"],
        "copies": [{"title": "版本一", "body": "正文一", "tags": ["#带井号", "测试"]}],
        "chosen": {"title": "联调标题", "body": "联调正文", "tags": ["#联调", "测试"]}})
    check("post create", st == 200 and r["post"]["status"] == "draft", r)
    post = r["post"]
    ppid = post["id"]
    check("post chosen normalized", post["chosen"]["tags"] == ["联调", "测试"], post["chosen"])
    check("post copies normalized", post["copies"][0]["tags"] == ["带井号", "测试"], post["copies"])
    st, r = call("POST", "/api/ops/posts/%s/update" % ppid, {"status": "ready"})
    check("post ready", st == 200 and r["post"]["status"] == "ready", r)
    st, r = call("POST", "/api/ops/posts/%s/update" % ppid, {"status": "published", "notes": "已发链接 x"})
    check("post published stamps", st == 200 and r["post"]["status"] == "published"
          and r["post"]["publishedAt"], r)

    # 7.5 排期与复盘数据(P3):合法日期落、非法清空、stats 白名单整数合并
    st, r = call("POST", "/api/ops/posts/%s/update" % ppid,
                 {"scheduleAt": "2026-10-20", "stats": {"likes": "5", "views": None, "bogus": 9}})
    check("schedule+stats set", st == 200 and r["post"]["scheduleAt"] == "2026-10-20"
          and r["post"]["stats"] == {"likes": 5, "views": 0}, r)
    st, r = call("POST", "/api/ops/posts/%s/update" % ppid,
                 {"scheduleAt": "2026/10/20", "stats": {"comments": "-3"}})
    check("schedule invalid cleared + stats clamped",
          st == 200 and r["post"]["scheduleAt"] is None
          and r["post"]["stats"].get("comments") == 0
          and r["post"]["stats"].get("likes") == 5, r)
    st, r = call("GET", "/api/ops/posts")
    row = next((x for x in r["posts"] if x["id"] == ppid), {})
    check("post list joined", row.get("accountName") == "联调账号", row)

    # 8. 素材:dataURL 落盘 → 回读 → 删除
    st, r = call("POST", "/api/ops/posts/%s/assets" % ppid,
                 {"dataUrl": "data:image/png;base64," + TINY_PNG_B64, "kind": "image"})
    check("asset add", st == 200 and len(r["post"]["assets"]) == 1
          and r["post"]["assets"][0]["file"] == "a1.png", r)
    st, body, headers = call("GET", "/api/ops/posts/%s/asset/a1.png" % ppid, raw=True)
    check("asset served", st == 200 and body[:4] == b"\x89PNG"
          and headers.get("Content-Type") == "image/png", (st, len(body)))
    check("asset on disk", (ROOT / "genwork" / "ops" / "posts" / ppid / "assets" / "a1.png").is_file())
    st, r = call("POST", "/api/ops/posts/%s/assets" % ppid, {"dataUrl": "data:text/html;base64,xxx"})
    check("asset bad mime", st == 400 and "不支持" in r.get("error", ""), r)
    st, r = call("POST", "/api/ops/posts/%s/assets/delete" % ppid, {"index": 1})
    check("asset delete", st == 200 and r["post"]["assets"] == [], r)
    check("asset file gone", not (ROOT / "genwork" / "ops" / "posts" / ppid / "assets" / "a1.png").is_file())

    # 8.5 视频素材(P2):ffmpeg 产 0.3s 小 mp4 → dataURL(kind 自动判 video)→ 落盘/回读/删除
    import base64 as _b64
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=24:duration=0.3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(ROOT / "genwork" / "ops" / "_test_vid.mp4")], check=True)
    vid_b64 = _b64.b64encode((ROOT / "genwork" / "ops" / "_test_vid.mp4").read_bytes()).decode()
    (ROOT / "genwork" / "ops" / "_test_vid.mp4").unlink()
    st, r = call("POST", "/api/ops/posts/%s/assets" % ppid,
                 {"dataUrl": "data:video/mp4;base64," + vid_b64})
    check("video asset add", st == 200 and r["post"]["assets"][0]["file"] == "a1.mp4"
          and r["post"]["assets"][0]["kind"] == "video"
          and r["post"]["assets"][0]["mime"] == "video/mp4", r)
    st, body, headers = call("GET", "/api/ops/posts/%s/asset/a1.mp4" % ppid, raw=True)
    check("video asset served", st == 200 and headers.get("Content-Type") == "video/mp4"
          and len(body) > 500, (st, len(body)))
    st, r = call("POST", "/api/ops/posts/%s/assets/delete" % ppid, {"index": 1})
    check("video asset delete", st == 200 and r["post"]["assets"] == [], r)

    # 9. 发布包 zip:文案.txt(带 BOM)+ tags.txt + assets
    st, r = call("POST", "/api/ops/posts/%s/assets" % ppid,
                 {"dataUrl": "data:image/png;base64," + TINY_PNG_B64})
    st, body, headers = call("GET", "/api/ops/posts/%s/package" % ppid, raw=True)
    check("package zip", st == 200 and headers.get("Content-Type") == "application/zip"
          and headers.get("Content-Disposition") == 'attachment; filename="ops-post-%s.zip"' % ppid, st)
    z = zipfile.ZipFile(io.BytesIO(body))
    names = z.namelist()
    check("package contents", "文案.txt" in names and "tags.txt" in names
          and any(n.startswith("assets/") for n in names), names)
    txt = z.read("文案.txt")
    check("package copy bom", txt[:3] == b"\xef\xbb\xbf", txt[:8])
    check("package copy text", "联调标题".encode("utf-8") in txt and "话题标签:#联调 #测试".encode("utf-8") in txt,
          txt.decode("utf-8-sig")[:120])
    st, r = call("POST", "/api/ops/posts/%s/assets/delete" % ppid, {"index": 1})
    check("asset cleanup", st == 200 and r["post"]["assets"] == [], r)

    # 10. 素材库(P2:视频项 + 短剧挂接)
    drama_pid = "ab12cd34ef56"
    drama_dir = ROOT / "genwork" / "drama" / drama_pid
    (drama_dir / "shots").mkdir(parents=True, exist_ok=True)
    fake_mp4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 600
    (drama_dir / "composed.mp4").write_bytes(fake_mp4)
    (drama_dir / "shots" / "ab12cd34ef56_clip.mp4").write_bytes(fake_mp4)
    st, r = call("GET", "/api/ops/library")
    lib_names = [x["name"] for x in r.get("items", [])]
    check("library list", st == 200 and r.get("ok") and len(r["items"]) >= 1
          and all({"name", "group", "mime", "bytes"} <= set(x) for x in r["items"]),
          len(r.get("items", [])))
    check("library has video", any(x["mime"] == "video/mp4" for x in r["items"]),
          [x["name"] for x in r["items"] if x["mime"] == "video/mp4"][:3])
    check("library drama hooked", f"drama-{drama_pid}-composed.mp4" in lib_names
          and f"drama-{drama_pid}-shot-ab12cd34ef56.mp4" in lib_names,
          [n for n in lib_names if n.startswith("drama-")])
    st, body, _ = call("GET", "/api/ops/library/file/drama-%s-composed.mp4" % drama_pid, raw=True)
    check("library drama served", st == 200 and body[:8] == fake_mp4[:8], (st, len(body)))
    st, body, _ = call("GET", "/api/ops/library/file/drama-%s-shot-zzzz.mp4" % drama_pid, raw=True)
    check("library drama bad name 404", st in (400, 404), st)
    lib_name = r["items"][0]["name"]
    st, body, _ = call("GET", "/api/ops/library/file/" + urllib.request.quote(lib_name), raw=True)
    check("library file served", st == 200 and len(body) > 100, (st, len(body)))
    st, body, _ = call("GET", "/api/ops/library/file/no_such.png", raw=True)
    check("library missing 404", st == 404, st)
    shutil.rmtree(drama_dir, ignore_errors=True)  # 短剧挂接夹具清理

    # 11. 防穿越与未知端点
    st, r = call("GET", "/api/ops/posts/%s/asset/..%%2fpost.json" % ppid)
    check("traversal rejected", st in (400, 404), st)
    st, r = call("POST", "/api/ops/bogus", {})
    check("unknown endpoint", st == 404 and r.get("error") == "unknown endpoint", r)

    # 12. LLM 文案(真实调用;上游未配或瞬时 5xx 重试一次,再不行则跳过;opt 档撞 429 等下一分钟)
    copy_body = {"personaId": pid_, "topic": "小多利偷吃了一块饼干",
                 "pillar": "日常治愈", "platform": "xhs", "kind": "video"}
    st, r = call("POST", "/api/ops/copy", copy_body)
    for attempt in (1, 2, 3):
        if st == 429 and attempt < 3:
            time.sleep(65)
            st, r = call("POST", "/api/ops/copy", copy_body)
            continue
        if st >= 500 and attempt < 3 and isinstance(r, dict) \
                and r.get("error") in ("upstream_unavailable", "image_generation_unavailable"):
            time.sleep(5)
            st, r = call("POST", "/api/ops/copy", copy_body)
            continue
        break
    if isinstance(r, dict) and r.get("error") in ("upstream_unavailable", "image_generation_unavailable"):
        log = (ROOT / "genwork" / "ops_test_srv.log")
        tail = log.read_text(encoding="utf-8", errors="replace")[-600:] if log.exists() else "(无日志)"
        print("SKIP copy(analyze)——上游暂不可用: st=%s err=%s | srv_tail=%s" % (st, r.get("error"), tail))
    else:
        copies = r.get("copies", []) if isinstance(r, dict) else []
        check("copy gen", st == 200 and r.get("ok") and len(copies) >= 2
              and all(c.get("title") and c.get("body") for c in copies),
              {"st": st, "err": r.get("error") if isinstance(r, dict) else r,
               "n": len(copies), "t0": copies[0]["title"][:30] if copies else ""})

        an_body = {
            "platform": "xhs",
            "text": "标题:我家狗子会自己开笼子\n\n正文:今天下班回家,发现笼子门开着,狗子端坐门口摇尾巴,"
                    "像在等我表扬。后来翻监控才发现,它先用爪子拨了三下卡扣,再一拱就开了。"
                    "养狗的快乐就是这么朴实无华。\n\n#中华田园犬 #狗狗日常 #治愈系"}
        st, r = call("POST", "/api/ops/analyze", an_body)
        for attempt in (1, 2, 3):
            if st == 429 and attempt < 3:
                time.sleep(65)
                st, r = call("POST", "/api/ops/analyze", an_body)
                continue
            if st >= 500 and attempt < 3 and isinstance(r, dict) \
                    and r.get("error") in ("upstream_unavailable", "image_generation_unavailable"):
                time.sleep(5)
                st, r = call("POST", "/api/ops/analyze", an_body)
                continue
            break
        check("analyze", st == 200 and r.get("ok") and r.get("summary")
              and isinstance(r.get("topicIdeas"), list),
              {"st": st, "err": r.get("error") if isinstance(r, dict) else r})

    # 13. 清理
    st, r = call("POST", "/api/ops/posts/%s/delete" % ppid)
    check("post delete", st == 200 and r.get("ok"), r)
    st, r = call("GET", "/api/ops/posts/%s" % ppid)
    check("post gone", st == 404, st)
    st, r = call("POST", "/api/ops/personas/%s/delete" % pid_)
    check("persona delete", st == 200 and r.get("ok"), r)
    st, r = call("GET", "/api/ops/personas")
    check("persona gone", st == 200 and not any(p["id"] == pid_ for p in r["personas"]), r)

    stop_server()
    print("ALL PASS")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        stop_server()
        sys.exit(130)
    except BaseException:
        stop_server()  # 任何异常都要收掉服务器,避免留下孤儿进程占端口
        raise
