#!/usr/bin/env python3
"""探测中转站(ApiRouterServ)对 OpenRouter 模型名(图像/视频输出)的实际支持度。

用法: python tools/probe_models.py [--only image|video] [--limit N]

流程:
1. 拉取 OpenRouter 目录(output_modalities=image / video)得到候选模型名;
2. 每个候选先做 1-token chat 存在性探测(成本≈0),并混入两个假模型名做对照:
   若假名也"探测成功",说明中转不校验模型名,真实生成测试全部跳过只出报告;
3. 对探测通过的生图模型:POST /chat/completions + modalities:["image"] 实测单张出图;
4. 对探测通过的生视频模型:POST /videos 创建任务(最短 5s)并轮询到完成,下载留存。
结果实时写入 tools/probe_results.json,重复运行自动跳过已完成的项。
"""
import argparse
import base64
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
RESULTS = ROOT / "tools" / "probe_results.json"
OUTDIR = ROOT / "tools" / "probe_out"
OR_CATALOG = "https://openrouter.ai/api/v1/models?output_modalities={kind}"

# server.py 已配置、视为可用基线(不重复实测)
CONFIGURED = {
    "openai/gpt-5.4-image-2", "openai/gpt-5.5",
    "google/gemini-3.1-flash-image-preview", "google/gemini-3-pro-image-preview",
    "kwaivgi/kling-v3.0-pro", "kwaivgi/kling-v3.0-std",
}
FAKE_MODELS = ["nonexistent/fake-model-x1", "nonexistent/fake-model-y2"]
# 中转 /models 列表里的文本模型,顺带探测能否出图(生图新候选)
EXTRA_IMAGE_CANDIDATES = [
    "google/gemini-3.8-flash", "google/gemini-3.7-flash", "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-pro", "google/gemini-2.5-flash-lite", "google/gemini-3.1-flash-lite",
    "x-ai/grok-4.6", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol",
]
NOT_FOUND_PAT = re.compile(
    r"no (endpoints|providers|allowed providers)|model not (found|exist)|invalid model|"
    r"unknown model|no such model|unrecognized|not a valid model|model_not_found|"
    r"does not exist|unsupported model|no available (provider|channel)", re.I)
COST_CAP_USD = 15.0  # 观测到的累计花费超过此值则不再发起新的真实测试
VIDEO_POLL_TIMEOUT = 12 * 60
VIDEO_CONCURRENCY = 3

_lock = threading.Lock()
_results = {}
_cost_total = 0.0


def log(msg):
    with _lock:
        print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def save():
    with _lock:
        RESULTS.write_text(json.dumps(_results, ensure_ascii=False, indent=1), encoding="utf-8")


def load_results():
    global _results
    if RESULTS.exists():
        _results = json.loads(RESULTS.read_text(encoding="utf-8"))
    else:
        _results = {"cost_total_usd": 0.0, "models": {}}


def key_env():
    for k in ("CODEX_API_KEY", "APIROUTER_KEY", "IMAGE_UPSTREAM_API_KEY"):
        if os.environ.get(k, "").strip():
            return k, os.environ[k].strip()
    env_file = ROOT.parent / "miniapp-kit" / ".env"
    if env_file.exists():
        vals = {}
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                vals[k.strip()] = v.strip().strip('"').strip("'")
        for k in ("CODEX_API_KEY", "APIROUTER_KEY", "IMAGE_UPSTREAM_API_KEY"):
            if vals.get(k):
                return k, vals[k]
    raise SystemExit("未找到上游 key(CODEX_API_KEY 等)")


_KEY_NAME, KEY = None, ""


def http_json(method, url, body=None, timeout=120):
    """返回 (status, payload_or_text, cost)。cost 从 usage.cost 提取(没有则 0)。"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    except Exception as e:
        return 0, "NETWORK: %s" % e, 0.0
    try:
        payload = json.loads(raw)
    except Exception:
        payload = raw[:400]
    cost = 0.0
    if isinstance(payload, dict):
        usage = payload.get("usage")
        if isinstance(usage, dict) and isinstance(usage.get("cost"), (int, float)):
            cost = float(usage["cost"])
    return status, payload, cost


def err_text(payload):
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            return str(err.get("code") or "") + " | " + str(err.get("message") or "")[:220]
        if err:
            return str(err)[:220]
        return json.dumps(payload, ensure_ascii=False)[:220]
    return str(payload)[:220]


def looks_not_found(status, payload):
    text = err_text(payload)
    return status in (400, 403, 404) and NOT_FOUND_PAT.search(text)


def chat_probe(model):
    """1-token 存在性探测。返回 ('ok'|'no', detail, cost)。"""
    status, payload, cost = http_json("POST", BASE + "/chat/completions",
                                      {"model": model,
                                       "messages": [{"role": "user", "content": "hi"}],
                                       "max_tokens": 1}, timeout=60)
    if status == 200 and isinstance(payload, dict):
        echoed = payload.get("model", "")
        if echoed and str(echoed).split(":")[0] != model.split(":")[0]:
            return "redirected", "echo=%s" % echoed, cost
        return "ok", "", cost
    if looks_not_found(status, payload):
        return "no", err_text(payload), cost
    if status == 0:
        return "net", str(payload)[:120], cost
    # 4xx/5xx 但报错不像"模型不存在"(可能是其它限制)→ 视为存在,值得实测
    return "maybe", "HTTP %s %s" % (status, err_text(payload)), cost


def image_test(model):
    """modalities:["image"] 实测;不支持该参数时去掉参数再试一次。"""
    prompt = "画一张红色苹果的照片,纯白背景,居中"
    for use_mod in (True, False):
        body = {"model": model,
                "messages": [{"role": "user", "content": prompt}]}
        if use_mod:
            body["modalities"] = ["image"]
        status, payload, cost = http_json("POST", BASE + "/chat/completions", body, timeout=300)
        add_cost(cost)
        if status != 200 or not isinstance(payload, dict):
            if looks_not_found(status, payload):
                return {"ok": False, "note": "not_found: " + err_text(payload), "cost": cost}
            if use_mod:
                log("%s: 带 modalities 失败(HTTP %s %s),去参重试" % (model, status, err_text(payload)[:120]))
                continue
            return {"ok": False, "note": "HTTP %s: %s" % (status, err_text(payload)), "cost": cost}
        try:
            url = payload["choices"][0]["message"]["images"][0]["image_url"]["url"]
        except (KeyError, IndexError, TypeError):
            msg = payload.get("choices", [{}])[0].get("message", {})
            keys = list(msg.keys()) if isinstance(msg, dict) else type(msg).__name__
            content = (msg.get("content") or "")[:80] if isinstance(msg, dict) else ""
            return {"ok": False, "note": "no_image msgKeys=%s content=%r" % (keys, content), "cost": cost}
        if isinstance(url, str) and url.startswith("data:image/"):
            b64 = url.split(",", 1)[1] if "," in url else ""
            return {"ok": True, "note": "b64 %s ~%.0fKB" % (url[5:30].rstrip(";base64"), len(b64) * 3 / 4 / 1024), "cost": cost}
        return {"ok": True, "note": "url=%s" % str(url)[:120], "cost": cost}
    return {"ok": False, "note": "unreachable", "cost": 0}


def add_cost(cost):
    global _cost_total
    if cost:
        with _lock:
            _cost_total += cost
            _results["cost_total_usd"] = round(_cost_total, 4)


DONE_OK = {"completed", "success", "succeed", "succeeded", "done", "finished", "ok"}
DONE_FAIL = {"failed", "fail", "error", "cancelled", "canceled", "timeout", "rejected"}


def video_test(model):
    """创建 5s 任务并轮询到完成;4xx 时去 duration 再试一次。完成后下载留档。"""
    prompt = "一只橘猫缓慢向前走两步,镜头固定,动作幅度小"
    job_id = None
    cost = 0.0
    for with_dur in (True, False):
        body = {"model": model, "prompt": prompt}
        if with_dur:
            body["duration"] = 5
        status, payload, c = http_json("POST", BASE + "/videos", body, timeout=120)
        cost += c
        add_cost(c)
        if status in (200, 202) and isinstance(payload, dict):
            job_id = payload.get("id") or payload.get("jobId") or payload.get("job_id") or payload.get("task_id")
            if job_id:
                break
            return {"ok": False, "note": "created_no_id: " + json.dumps(payload, ensure_ascii=False)[:200], "cost": cost}
        if looks_not_found(status, payload):
            return {"ok": False, "note": "not_found: " + err_text(payload), "cost": cost}
        if with_dur and status in (400, 422):
            log("%s: 带 duration 失败(%s),去参重试" % (model, err_text(payload)[:120]))
            continue
        return {"ok": False, "note": "HTTP %s: %s" % (status, err_text(payload)), "cost": cost}
    if not job_id:
        return {"ok": False, "note": "no job id", "cost": cost}
    deadline = time.time() + VIDEO_POLL_TIMEOUT
    first_poll = True
    while time.time() < deadline:
        time.sleep(6)
        status, poll, c = http_json("GET", BASE + "/videos/%s" % job_id, timeout=60)
        cost += c
        add_cost(c)
        if first_poll and isinstance(poll, dict):
            _results["models"].setdefault(model, {})["poll_sample"] = json.dumps(poll, ensure_ascii=False)[:500]
            first_poll = False
            save()
        if not isinstance(poll, dict):
            continue
        if poll.get("error"):
            return {"ok": False, "note": "poll error: " + err_text(poll), "cost": cost}
        data = poll.get("data") if isinstance(poll.get("data"), dict) else {}
        st = str(poll.get("status") or poll.get("state") or data.get("status") or "").lower()
        if st in DONE_OK:
            return video_download(model, job_id, poll, cost)
        if st in DONE_FAIL:
            return {"ok": False, "note": "job failed: " + err_text(poll), "cost": cost}
    return {"ok": False, "note": "poll timeout(>12min)", "cost": cost}


def video_download(model, job_id, poll, cost):
    raw = b""
    try:
        req = urllib.request.Request(BASE + "/videos/%s/content" % job_id,
                                     headers={"Authorization": "Bearer " + KEY})
        with urllib.request.urlopen(req, timeout=300) as resp:
            raw = resp.read()
    except Exception:
        pass
    if not raw:
        urls = poll.get("unsigned_urls") or ([poll["url"]] if isinstance(poll.get("url"), str) else [])
        for u in urls:
            if isinstance(u, str) and u:
                try:
                    with urllib.request.urlopen(u, timeout=300) as resp:
                        raw = resp.read()
                    if raw:
                        break
                except Exception:
                    continue
    if not raw:
        return {"ok": False, "note": "completed but download empty", "cost": cost}
    OUTDIR.mkdir(parents=True, exist_ok=True)
    fn = OUTDIR / (re.sub(r"[^A-Za-z0-9._-]", "_", model) + ".mp4")
    fn.write_bytes(raw)
    return {"ok": True, "note": "mp4 %.1fMB -> %s" % (len(raw) / 1048576, fn.name), "cost": cost}


def or_candidates(kind):
    req = urllib.request.Request(OR_CATALOG.format(kind=kind), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.loads(r.read().decode("utf-8"))
    return [m["id"] for m in payload.get("data", [])]


def probe_all(ids):
    """存在性探测 + 假名对照。relay_validates 为 False 时中转不校验模型名。"""
    controls = 0
    for m in FAKE_MODELS:
        verdict, detail, cost = chat_probe(m)
        add_cost(cost)
        _results["models"][m] = {"probe": verdict, "probe_detail": detail}
        if verdict in ("ok", "maybe"):
            controls += 1
        log("对照假名 %s -> %s %s" % (m, verdict, detail[:100]))
    save()
    for i, m in enumerate(ids):
        if m in _results["models"] and "probe" in _results["models"][m]:
            continue
        verdict, detail, cost = chat_probe(m)
        add_cost(cost)
        _results["models"][m] = {"probe": verdict, "probe_detail": detail}
        save()
        log("(%d/%d) 探测 %s -> %s %s" % (i + 1, len(ids), m, verdict, detail[:100]))
    _results["relay_validates"] = controls < len(FAKE_MODELS)
    save()
    return _results["relay_validates"]


def run_pool(items, worker, n):
    sem = threading.Semaphore(n)
    threads = []
    for it in items:
        def run(item=it):
            with sem:
                worker(item)
        t = threading.Thread(target=run)
        t.start()
        threads.append(t)
    for t in threads:
        t.join()


def main():
    global KEY
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["image", "video"])
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    _KEY_NAME, KEY = key_env()
    log("上游: %s (key=%s,***)" % (BASE, _KEY_NAME))
    load_results()
    kinds = [k for k in ("image", "video") if not args.only or k == args.only]

    image_ids, video_ids = [], []
    for kind in kinds:
        ids = or_candidates(kind)
        log("OpenRouter %s 候选 %d 个(不含已配置基线)" % (kind, len([i for i in ids if i not in CONFIGURED])))
        if kind == "image":
            image_ids = [i for i in ids if i not in CONFIGURED] + \
                        [i for i in EXTRA_IMAGE_CANDIDATES if i not in CONFIGURED]
        else:
            video_ids = [i for i in ids if i not in CONFIGURED]
    if args.limit:
        image_ids = image_ids[:args.limit]
        video_ids = video_ids[:args.limit]
    all_ids = image_ids + video_ids

    log("---- 阶段1: 存在性探测(含假名对照) ----")
    relay_validates = probe_all(all_ids)
    log("中转校验模型名: %s" % ("是" if relay_validates else "否(假名也通过,只出探测报告,跳过真实测试)"))

    if "image" in kinds and relay_validates:
        todo = [m for m in image_ids
                if _results["models"].get(m, {}).get("probe") in ("ok", "maybe")
                and not _results["models"].get(m, {}).get("image_test", {}).get("done")]
        log("---- 阶段2: 生图实测 %d 个 ----" % len(todo))
        def img_worker(m):
            if _cost_total > COST_CAP_USD:
                log("花费超过上限 $%.0f,跳过 %s" % (COST_CAP_USD, m))
                return
            log("生图实测 %s …" % m)
            r = image_test(m)
            r["done"] = True
            _results["models"].setdefault(m, {})["image_test"] = r
            save()
            log("生图实测 %s -> %s %s ($%.4f)" % (m, "OK" if r["ok"] else "FAIL", r["note"][:90], r.get("cost", 0)))
        run_pool(todo, img_worker, 3)

    if "video" in kinds:
        # /videos 端点不看 chat 探测结果(视频模型不是 chat 模型,探测必失败);
        # 用假模型名做 /videos 对照:若假名也能创建任务,说明中转不校验,真实测试全跳过
        ctrl = _results["models"].get(FAKE_MODELS[0], {}).get("video_test")
        if not ctrl:
            log("生视频假名对照 %s(/videos)…" % FAKE_MODELS[0])
            ctrl = video_test(FAKE_MODELS[0])
            ctrl["done"] = True
            ctrl["control"] = True
            _results["models"].setdefault(FAKE_MODELS[0], {})["video_test"] = ctrl
            save()
            log("生视频假名对照 -> %s %s" % ("OK" if ctrl["ok"] else "FAIL", ctrl["note"][:100]))
        ctrl_ok = ctrl.get("ok") or "created_no_id" in ctrl.get("note", "") or "job failed" in ctrl.get("note", "")
        todo = []
        if not ctrl_ok:
            todo = [m for m in video_ids
                    if not _results["models"].get(m, {}).get("video_test", {}).get("done")]
            log("---- 阶段3: 生视频实测 %d 个(并发%d,5s 最短;被拒绝不产生费用) ----" % (len(todo), VIDEO_CONCURRENCY))
        else:
            log("中转 /videos 不校验模型名(假名也能建任务),跳过全部真实视频测试")
        _results["relay_video_validates"] = not ctrl_ok
        save()
        def vid_worker(m):
            if _cost_total > COST_CAP_USD:
                log("花费超过上限 $%.0f,跳过 %s" % (COST_CAP_USD, m))
                return
            log("生视频实测 %s …" % m)
            r = video_test(m)
            r["done"] = True
            _results["models"].setdefault(m, {})["video_test"] = r
            save()
            log("生视频实测 %s -> %s %s ($%.4f)" % (m, "OK" if r["ok"] else "FAIL", r["note"][:90], r.get("cost", 0)))
        run_pool(todo, vid_worker, VIDEO_CONCURRENCY)

    log("---- 汇总 ----")
    for m in sorted(_results["models"]):
        info = _results["models"][m]
        line = "%-42s probe=%s" % (m, info.get("probe"))
        if info.get("image_test"):
            t = info["image_test"]
            line += " | image=%s(%s)" % ("OK" if t["ok"] else "FAIL", t["note"][:60])
        if info.get("video_test"):
            t = info["video_test"]
            line += " | video=%s(%s)" % ("OK" if t["ok"] else "FAIL", t["note"][:60])
        log(line)
    log("累计观测花费: $%.4f" % _cost_total)


if __name__ == "__main__":
    main()
