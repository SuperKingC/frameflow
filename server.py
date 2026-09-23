"""FrameFlow 本地服务器 + 生视频桥接。

用法:
    python server.py [--port 8437] [--no-browser] [--genmjs 路径]

功能:
1. 静态站点(http://127.0.0.1:<port>/),所有拆帧/抠图/导出处理在浏览器本地完成。
2. 生视频桥接:复用 miniapp-kit/anim/gen.mjs(可灵·ApiRouter)。
   默认找同级目录 ../miniapp-kit/anim/gen.mjs,可用环境变量 FRAMEFLOW_GENMJS
   或 --genmjs 覆盖。按 miniapp-kit 接入铁律不改其代码,差异全走配置/参数。
   密钥从环境变量(CODEX_API_KEY / APIROUTER_KEY)或 miniapp-kit/.env 读取,不落任何文件。
"""
import argparse
import base64
import http.server
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8437
DEFAULT_GENMJS = ROOT.parent / "miniapp-kit" / "anim" / "gen.mjs"
MINIAPP_ENV = ROOT.parent / "miniapp-kit" / ".env"
GEN_BASE_URL = "https://apirouter.zhiqiteai.cn/ApiRouterServ/v1"
GEN_KEY_ENV = "CODEX_API_KEY"
GEN_PROMPT_APPEND = "镜头固定,动作幅度小而柔和,不要镜头切换,不要新增元素"
GEN_MODELS = ["kwaivgi/kling-v3.0-pro", "kwaivgi/kling-v3.0-std"]
GENWORK = ROOT / "genwork"
TINIFY_URL = "https://api.tinify.com/shrink"
TINIFY_KEY_ENVS = ["TINYPNG_API_KEY", "TINYPNG_API_KEY_2", "TINYPNG_API_KEY_3", "TINYPNG_API_KEY_4", "TINYPNG_API_KEY_5"]

_JOBS = {}
_JOBS_LOCK = threading.Lock()

# SAM2 worker(常驻子进程,模型驻留显存;协议见 sam_worker.py)
_SAM = {"proc": None, "image_sig": None, "lock": threading.Lock()}
_SAM_WORKER = ROOT / "sam_worker.py"


def _sam_python():
    _load_miniapp_env()
    return (os.environ.get("FRAMEFLOW_SAM_PYTHON")
            or os.environ.get("PYTHON_MATTING")
            or "")


def _sam_ask(proc, req, timeout_s):
    """发送一行 JSON 请求并读取一行响应(看门狗超时,超时即杀进程)。"""
    timer = threading.Timer(timeout_s, lambda: proc.kill())
    timer.start()
    try:
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("SAM2 worker 无响应(可能已退出)")
        return json.loads(line)
    finally:
        timer.cancel()


def _sam_ensure(image_b64=None):
    """确保 worker 就绪;image_b64 非空时保证模型已加载该图。返回 True 表示发生了新加载。"""
    proc = _SAM["proc"]
    if proc is None or proc.poll() is not None:
        py = _sam_python()
        if not py or not Path(py).exists():
            raise RuntimeError("未找到 SAM2 python 环境:请设 PYTHON_MATTING(指向带 torch+sam2 的 python,见 miniapp-kit doctor)")
        if not _SAM_WORKER.exists():
            raise RuntimeError(f"缺少 worker: {_SAM_WORKER}")
        _SAM["proc"] = subprocess.Popen(
            [py, str(_SAM_WORKER)], cwd=str(ROOT),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace")
        proc = _SAM["proc"]
        _SAM["image_sig"] = None
        hello = _sam_ask(proc, {"cmd": "ping"}, 30)
        if not hello.get("ok"):
            raise RuntimeError("SAM2 worker 握手失败: " + str(hello.get("error")))
    if image_b64 is not None:
        sig = str(len(image_b64))
        if _SAM["image_sig"] != sig:
            r = _sam_ask(proc, {"cmd": "load_image", "image_b64": image_b64}, 180)
            if not r.get("ok"):
                raise RuntimeError("SAM2 加载图片失败: " + str(r.get("error")))
            _SAM["image_sig"] = sig
            return True
    return False


def _sam_segment(points, labels, image_b64):
    """点提示分割;worker 崩溃自动重启重试一次。返回 {"ok",score,area,mask_b64}。"""
    with _SAM["lock"]:
        for attempt in (1, 2):
            try:
                _sam_ensure(image_b64)
                proc = _SAM["proc"]
                r = _sam_ask(proc, {"cmd": "segment", "points": points, "labels": labels}, 120)
                if not r.get("ok"):
                    raise RuntimeError(r.get("error", "未知错误"))
                return r
            except Exception:
                try:
                    if _SAM["proc"]:
                        _SAM["proc"].kill()
                except Exception:
                    pass
                _SAM["proc"] = None
                _SAM["image_sig"] = None
                if attempt == 2:
                    raise


def _load_miniapp_env():
    """加载 miniapp-kit/.env 的 KEY=VALUE(进程环境优先);不记录值,仅注入 os.environ。"""
    if not MINIAPP_ENV.exists():
        return
    try:
        for line in MINIAPP_ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and os.environ.get(k) is None:
                os.environ[k] = v
    except Exception:
        pass


def _tinify_keys():
    _load_miniapp_env()
    return [os.environ[n].strip() for n in
            ("TINYPNG_API_KEY", "TINYPNG_API_KEY_2", "TINYPNG_API_KEY_3", "TINYPNG_API_KEY_4", "TINYPNG_API_KEY_5")
            if os.environ.get(n, "").strip()]


def _tinify_compress(image_bytes):
    """TinyPNG 智能压缩(视觉无差的 PNG 智能有损;彩度差异肉眼不可辨)。
    多 key 轮换:401/429 换下一个。返回 (bytes, input_bytes, note)。"""
    import base64
    keys = _tinify_keys()
    if not keys:
        raise RuntimeError("未找到 TinyPNG key:请设置环境变量 TINYPNG_API_KEY,或确认 miniapp-kit/.env 存在")
    dead = []
    last_err = None
    for key in keys:
        if key in dead:
            continue
        auth = "Basic " + base64.b64encode(f"api:{key}".encode()).decode()
        try:
            req = urllib.request.Request(
                TINIFY_URL, data=image_bytes, method="POST",
                headers={"Authorization": auth, "Content-Type": "application/octet-stream"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            out_url = body.get("output", {}).get("url")
            if not out_url:
                raise RuntimeError("TinyPNG 响应缺少 output.url")
            with urllib.request.urlopen(urllib.request.Request(out_url, headers={"Authorization": auth}), timeout=120) as dl:
                out = dl.read()
            if len(out) >= len(image_bytes) * 0.98:
                return image_bytes, len(image_bytes), "压缩收益<2%,保留原图"
            return out, len(image_bytes), ""
        except urllib.error.HTTPError as e:
            if e.code in (401, 429):
                dead.append(key)
                last_err = e
                continue
            raise RuntimeError(f"TinyPNG HTTP {e.code}")
        except Exception as e:
            last_err = e
            break
    raise RuntimeError(f"TinyPNG 压缩失败:{last_err}")


def _genmjs_path(override=None):
    p = Path(override or os.environ.get("FRAMEFLOW_GENMJS") or DEFAULT_GENMJS)
    return p


def _find_key():
    return os.environ.get(GEN_KEY_ENV) or os.environ.get("APIROUTER_KEY")


def _start_job(params, genmjs):
    genmjs = Path(genmjs or DEFAULT_GENMJS)
    if not genmjs.exists():
        raise RuntimeError(
            f"未找到 gen.mjs: {genmjs}(用 --genmjs 或环境变量 FRAMEFLOW_GENMJS 指定 miniapp-kit/anim/gen.mjs)")
    name = params.get("name") or "action"
    name = "".join(c if (c.isalnum() and c.isascii()) or c in "_-" else "_" for c in name).strip("_") or "action"
    prompt = (params.get("prompt") or "").strip()
    if not prompt:
        raise RuntimeError("运动提示词为空")
    ref_b64 = params.get("refImage") or ""
    if "," in ref_b64:
        meta, _, ref_b64 = ref_b64.partition(",")
    else:
        meta = "data:image/png;base64"
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(meta[5:meta.find(";")] if meta.startswith("data:") else "png", "png")
    try:
        ref_bytes = base64.b64decode(ref_b64)
    except Exception:
        raise RuntimeError("首帧图数据无法解码(dataURL)")
    if len(ref_bytes) < 100:
        raise RuntimeError("首帧图为空")

    model = params.get("model") if params.get("model") in GEN_MODELS else None
    candidates = max(1, min(int(params.get("candidates") or 1), 4))
    resolution = params.get("resolution") if params.get("resolution") in ("720p", "1080p") else "720p"
    loop = params.get("loop") if params.get("loop") in ("pingpong", "raw", "off") else "pingpong"
    dry_run = bool(params.get("dryRun"))

    job_id = uuid.uuid4().hex[:12]
    workdir = GENWORK / job_id
    outdir = workdir / "out"
    outdir.mkdir(parents=True, exist_ok=True)
    ref_path = workdir / f"ref.{ext}"
    ref_path.write_bytes(ref_bytes)
    config = {
        "api": {"baseUrl": GEN_BASE_URL, "keyEnv": GEN_KEY_ENV, "models": GEN_MODELS, "concurrency": 1},
        "video": {"resolution": resolution, "candidates": candidates, "pollMs": 4000, "timeoutMin": 15, "loop": loop},
        "transcode": {"crf": 24, "preset": "medium"},
        "prompt": {"append": GEN_PROMPT_APPEND},
        "output": {"dir": str(outdir)},
    }
    (workdir / "anim.config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    prompts_path = workdir / "prompts.txt"
    prompts_path.write_text(f"{name}|{ref_path}|{prompt}\n", encoding="utf-8")

    args = ["node", str(genmjs), "-c", str(workdir / "anim.config.json"), "-p", str(prompts_path)]
    if model:
        args += ["--model", model]
    if dry_run:
        args += ["--dry-run"]

    env = dict(os.environ)
    key = _find_key()
    if key:
        env[GEN_KEY_ENV] = key

    job = {"id": job_id, "name": name, "workdir": workdir, "outdir": outdir,
           "state": "running" if not dry_run else "dryrun", "dryRun": dry_run,
           "output": [], "startedAt": time.time(), "prompt": prompt}
    with _JOBS_LOCK:
        _JOBS[job_id] = job

    def run_proc():
        try:
            proc = subprocess.Popen(args, cwd=str(workdir), env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
            job["proc"] = proc
            for line in proc.stdout:
                job["output"].append(line.rstrip())
                if len(job["output"]) > 500:
                    del job["output"][:250]
            rc = proc.wait()
            job["rc"] = rc
            if rc == 0:
                job["state"] = "done" if not dry_run else "drydone"
            else:
                job["state"] = "error"
        except Exception as e:
            job["state"] = "error"
            job["output"].append(f"[bridge] {e}")
            job["rc"] = -1

    threading.Thread(target=run_proc, daemon=True).start()
    return job


def _final_videos(job):
    """输出目录里最新的成品 mp4(排除 *_cK_master.mp4 母带),按修改时间倒序。"""
    outdir = job["outdir"]
    if not outdir.exists():
        return []
    vids = []
    for f in outdir.glob("*.mp4"):
        if "_c" in f.stem and f.stem.endswith("_master"):
            continue
        vids.append(f)
    vids.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return vids


def _job_status(job):
    tail = "\n".join(job["output"][-25:])
    st = {"id": job["id"], "state": job["state"], "tail": tail[-2400:],
          "elapsedSec": int(time.time() - job["startedAt"]), "name": job["name"]}
    if job["state"] == "done":
        vids = _final_videos(job)
        st["videos"] = [v.name for v in vids]
        manifest = job["outdir"] / "manifest.json"
        if manifest.exists():
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                recs = [r for r in data.get("items", []) if r.get("name") == job["name"] and r.get("winner")]
                if recs:
                    w = recs[-1]["winner"]
                    st["winner"] = {k: w.get(k) for k in
                                    ("file", "cost", "loopPsnr", "finalLoopPsnr", "treatment", "loopOk", "durationSec", "width", "height")}
            except Exception:
                pass
    return st


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, genmjs=None, **kwargs):
        self.genmjs = genmjs or DEFAULT_GENMJS
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):  # 静默静态访问日志
        pass

    # ---------- helpers ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 64 * 1024 * 1024:
            raise RuntimeError(f"请求体异常({length})")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _q(self):
        return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))

    # ---------- API ----------
    def do_POST(self):
        if self.path.rstrip("/") == "/api/sam/segment":
            try:
                params = self._read_json()
                data_url = params.get("image") or ""
                if "," in data_url:
                    _, _, b64 = data_url.partition(",")
                else:
                    b64 = data_url
                if len(b64) < 100:
                    raise RuntimeError("图片数据为空")
                points = params.get("points") or []
                labels = params.get("labels") or []
                if not points or len(points) != len(labels):
                    raise RuntimeError("点集/标签为空或数量不一致")
                r = _sam_segment(points, labels, b64)
                self._json({"ok": True, **r})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/compress/tinypng":
            try:
                params = self._read_json()
                data_url = params.get("image") or ""
                if "," in data_url:
                    _, _, b64 = data_url.partition(",")
                else:
                    b64 = data_url
                import base64 as _b64
                raw = _b64.b64decode(b64)
                if len(raw) < 100:
                    raise RuntimeError("图片数据为空")
                out, in_bytes, note = _tinify_compress(raw)
                b64out = _b64.b64encode(out).decode()
                self._json({"ok": True, "image": "data:image/png;base64," + b64out,
                            "inputBytes": in_bytes, "outputBytes": len(out), "note": note})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/gen/start":
            try:
                params = self._read_json()
                job = _start_job(params, self.genmjs)
                if job["dryRun"]:
                    # dry-run 等待退出(秒级),直接回结果
                    deadline = time.time() + 60
                    while job["state"] == "dryrun" and time.time() < deadline:
                        time.sleep(0.3)
                    st = _job_status(job)
                    self._json({"ok": job["state"] == "drydone", "tail": st["tail"], "state": job["state"]})
                else:
                    self._json({"ok": True, "jobId": job["id"]})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 400)
            return
        self._json({"ok": False, "error": "unknown endpoint"}, 404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/gen/status":
            q = self._q()
            job = _JOBS.get(q.get("job", ""))
            if not job:
                self._json({"ok": False, "error": "job 不存在"}, 404)
                return
            self._json({"ok": True, **_job_status(job)})
            return
        if parsed.path == "/api/gen/video":
            q = self._q()
            job = _JOBS.get(q.get("job", ""))
            name = q.get("video", "")
            if not job:
                self._json({"ok": False, "error": "job 不存在"}, 404)
                return
            vids = _final_videos(job)
            target = next((v for v in vids if v.name == name), vids[0] if vids else None)
            if not target:
                self._json({"ok": False, "error": "尚无成品视频"}, 404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--genmjs", default=None,
                        help="miniapp-kit/anim/gen.mjs 路径(默认同级 ../miniapp-kit,或环境变量 FRAMEFLOW_GENMJS)")
    args = parser.parse_args()
    genmjs = _genmjs_path(args.genmjs)

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True

    def factory(*handler_args):
        return NoCacheHandler(*handler_args, genmjs=str(genmjs))

    server = Server(("127.0.0.1", args.port), factory)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"FrameFlow 已启动: {url}")
    print(f"生视频引擎: {genmjs}({'✓ 存在' if genmjs.exists() else '✗ 未找到,生视频功能不可用,其余功能正常'})")
    print("Ctrl+C 退出。")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("已退出。")


if __name__ == "__main__":
    main()
