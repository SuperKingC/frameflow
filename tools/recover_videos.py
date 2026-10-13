#!/usr/bin/env python3
"""恢复 probe_models.py 首轮误判为 FAIL 的 /videos 任务(HTTP 202 已创建但未轮询)。

读取 tools/probe_results.json 里 video_test.note 中的 gen-vid-* 任务 id,
逐个轮询到终态并下载成品,把真实结果写回 probe_results.json。
"""
import json
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "tools" / "probe_results.json"
OUTDIR = ROOT / "tools" / "probe_out"
sys.path.insert(0, str(ROOT / "tools"))
import probe_models as pm  # noqa: E402  复用 http_json/KEY 等基础设施

pm.KEY = pm.key_env()[1]
pm.load_results()

ID_RE = re.compile(r"gen-vid-\d+-[A-Za-z0-9]+")
DONE_OK = {"completed", "success", "succeed", "succeeded", "done"}
DONE_FAIL = {"failed", "fail", "error", "cancelled", "canceled", "timeout", "rejected"}
lock = threading.Lock()


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def save():
    with lock:
        pm.RESULTS.write_text(json.dumps(pm._results, ensure_ascii=False, indent=1), encoding="utf-8")


def recover(model, job_id):
    deadline = time.time() + 15 * 60
    first = True
    while time.time() < deadline:
        status, poll, cost = pm.http_json("GET", pm.BASE + "/videos/%s" % job_id, timeout=60)
        if cost:
            pm.add_cost(cost)
        if status == 0:
            time.sleep(5)
            continue
        if first:
            sample = json.dumps(poll, ensure_ascii=False)[:600] if isinstance(poll, dict) else str(poll)[:600]
            log("%s poll sample: %s" % (model, sample))
            first = False
            save()
        if not isinstance(poll, dict):
            time.sleep(5)
            continue
        data = poll.get("data") if isinstance(poll.get("data"), dict) else {}
        st = str(poll.get("status") or poll.get("state") or data.get("status") or "").lower()
        if st in DONE_OK:
            r = pm.video_download(model, job_id, poll, 0.0)
            r["done"] = True
            r["recovered"] = True
            with lock:
                pm._results["models"].setdefault(model, {})["video_test"] = r
                pm._results["cost_total_usd"] = round(pm._cost_total, 4)
            save()
            log("%s -> %s %s" % (model, "OK" if r["ok"] else "FAIL", r["note"][:110]))
            return
        if st in DONE_FAIL:
            r = {"ok": False, "done": True, "recovered": True,
                 "note": "job failed: %s" % pm.err_text(poll)}
            with lock:
                pm._results["models"].setdefault(model, {})["video_test"] = r
            save()
            log("%s -> FAILED %s" % (model, pm.err_text(poll)[:110]))
            return
        time.sleep(6)
    with lock:
        pm._results["models"].setdefault(model, {})["video_test"] = {
            "ok": False, "done": True, "recovered": True, "note": "poll timeout"}
    save()
    log("%s -> poll timeout" % model)


def main():
    jobs = []
    for model, info in pm._results.get("models", {}).items():
        vt = info.get("video_test") or {}
        if vt.get("recovered"):
            continue
        note = str(vt.get("note", ""))
        m = ID_RE.search(note)
        if m and ("HTTP 202" in note or "HTTP 200" in note):
            jobs.append((model, m.group(0)))
    log("待恢复任务 %d 个" % len(jobs))
    sem = threading.Semaphore(4)

    def worker(pair):
        with sem:
            recover(*pair)

    threads = [threading.Thread(target=worker, args=(p,)) for p in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    log("恢复完成,累计观测花费 $%.4f" % pm._cost_total)


if __name__ == "__main__":
    main()
