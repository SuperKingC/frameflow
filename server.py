"""FrameFlow 本地服务器 + 生视频桥接。

用法:
    python server.py [--port 8437] [--no-browser] [--genmjs 路径]

功能:
1. 静态站点(http://127.0.0.1:<port>/),所有拆帧/抠图/导出处理在浏览器本地完成。
2. 生视频桥接:复用 miniapp-kit/anim/gen.mjs(可灵·ApiRouter)。
   默认找同级目录 ../miniapp-kit/anim/gen.mjs,可用环境变量 FRAMEFLOW_GENMJS
   或 --genmjs 覆盖。按 miniapp-kit 接入铁律不改其代码,差异全走配置/参数。
   密钥从环境变量(CODEX_API_KEY / APIROUTER_KEY)或 miniapp-kit/.env 读取,不落任何文件。
   /api/gen/* 与生图工作台共用同一把邀请码门禁(见 3);未设码时仅本机可用。
3. 生图/生视频工作台(gen.html):移植自 Pet10 工作台(同一 ApiRouter 上游)。
   邀请码门禁(GEN_INVITE_CODE,页面不存码,Bearer 携带;一天错满 3 次锁到明天);
   未设码时仅本机(127.0.0.1)免码直进、非本机来源拒绝——公网/局域网部署务必设码。
   任务提交后台并行跑、内存暂存 30 分钟;额度每分钟 3 次/图 100 张/视频 30 个。
4. 短剧工作台(drama.html):剧本→分镜(LLM)→角色定妆→逐镜首帧/成片→ffmpeg 合成。
   项目落盘 genwork/drama/<id>/(project.json + 素材文件,重启不丢);生成复用生图工作台的
   /api/studio/tasks(前端拿到成品后把素材 POST 回 /api/drama/* 落盘),同一把邀请码门禁。
5. 全站门禁:打开首页即要求邀请码(js/gate.js);绕过首页直开任一工具页同样要码。
   /api/studio/*、/api/gen/*、/api/drama/*、/api/compress/*、/api/sam/*、/api/matting/* 服务端全部鉴权,
   未设码时仅本机直连放行(反代注入 X-Forwarded-For 的请求视为公网来源,需码)。
6. 静态白名单:仅托管 *.html/*.css/*.js,目录列表关闭——源码/文档/.git/生成产物等一律 404,
   nginx 漏配保护也有兜底。真实客户端 IP 自动取 X-Forwarded-For(对端为回环且带该头,或设
   FRAMEFLOW_TRUST_PROXY=1),额度与锁定按真实 IP 计;模型目录接口仅对已验证者公开。
"""
import argparse
import base64
import datetime
import hashlib
import hmac
import http.server
import io
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
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
# 生成产物根目录:环境变量 FRAMEFLOW_GENWORK_DIR 可指到任意文件夹(如 D:\AI产出);
# 生视频桥接任务在 <root>/<jobId>,生图工作台结果在 <root>/studio/
GENWORK = Path(os.environ.get("FRAMEFLOW_GENWORK_DIR") or (ROOT / "genwork"))
TINIFY_URL = "https://api.tinify.com/shrink"
TINIFY_KEY_ENVS = ["TINYPNG_API_KEY", "TINYPNG_API_KEY_2", "TINYPNG_API_KEY_3", "TINYPNG_API_KEY_4", "TINYPNG_API_KEY_5"]
OXIPNG_EXE = ROOT / "tools" / "oxipng" / "oxipng.exe"
# 反代部署标记(FRAMEFLOW_TRUST_PROXY=1):前置 nginx 且只监听 127.0.0.1 时设,
# 无条件按 X-Forwarded-For 取真实客户端 IP;未设置时会自动识别(见 _client_ip)
TRUST_PROXY = os.environ.get("FRAMEFLOW_TRUST_PROXY", "").strip().lower() in ("1", "true", "yes")

_JOBS = {}
_JOBS_LOCK = threading.Lock()

# ---------- 生图/生视频工作台(移植自 Pet10,同一 ApiRouter 上游) ----------
def _dur(lo, hi):
    """连续时长区间展开成列表(视频模型 supported_durations,来自中转 /videos/models)。"""
    return list(range(lo, hi + 1))


GEN_STUDIO = {
    "invite_code": "",        # GEN_INVITE_CODE;为空时仅本机免码直进,非本机来源拒绝
    "upstream_key": "",       # IMAGE_UPSTREAM_API_KEY > CODEX_API_KEY > APIROUTER_KEY
    "rate_per_minute": 3,
    "image_daily": 100,
    "video_daily": 30,
    "invite_max_failures": 3,
    "max_prompt": 4000,
    "prompt_model": "openai/gpt-5.4-mini",
    # 2026-10-13 全量实测(OpenRouter 目录逐个真跑,工具 tools/probe_models.py):
    # chat+modalities 生图与 /videos 生视频均按实测通过与否收录;fit 是用途描述
    # (适合什么场景,人工按质量口碑+实测定位);durations 为各视频模型支持时长。
    "models": [
        # ---- 生图(chat 多模态;纯生图模型无 /images 端点走不通,不收录) ----
        {"id": "google/gemini-3-pro-image", "kind": "image", "fit": "质量标杆:海报/封面/重要产出,细节与文字渲染最强", "label": "Gemini 3 Pro 生图(正式版,≈$0.14/张)"},
        {"id": "openai/gpt-5-image", "kind": "image", "fit": "高质量通用:复杂场景与精确指令遵循,贵但稳", "label": "GPT-5 Image 高质量(≈$0.19/张)"},
        {"id": "openai/gpt-5.4-image-2", "kind": "image", "fit": "日常首选:质量与价格均衡,支持比例/尺寸参数", "label": "GPT-5.4 Image(推荐)"},
        {"id": "black-forest-labs/flux.2-max", "kind": "image", "fit": "艺术风格与写实人像,画面质感突出", "label": "FLUX.2 Max 生图(≈$0.07/张)"},
        {"id": "google/gemini-3.1-flash-image", "kind": "image", "fit": "高质量快速出图:迭代探索、批量草稿", "label": "Gemini 3.1 Flash 生图(正式版,≈$0.07/张)"},
        {"id": "bytedance-seed/seedream-4.5", "kind": "image", "fit": "性价比之选:日常出图便宜够用", "label": "Seedream 4.5 生图(≈$0.04/张)"},
        {"id": "google/gemini-3-pro-image-preview", "kind": "image", "fit": "同正式版,预览通道(偶有行为变动)", "label": "Gemini 3 Pro 生图(预览版)"},
        {"id": "openai/gpt-5-image-mini", "kind": "image", "fit": "便宜的 GPT 系:日常出图、批量尝试", "label": "GPT-5 Image Mini(≈$0.04/张)"},
        {"id": "black-forest-labs/flux.2-pro", "kind": "image", "fit": "写实与设计稿,FLUX 系性价比档", "label": "FLUX.2 Pro 生图(≈$0.03/张)"},
        {"id": "google/gemini-3.1-flash-image-preview", "kind": "image", "fit": "同正式版,预览通道(更便宜偶有变动)", "label": "Gemini 3.1 Flash 生图(预览版)"},
        {"id": "recraft/recraft-v4.1-pro-vector", "kind": "image", "fit": "矢量 SVG:logo/图标/插画,可无损缩放", "label": "Recraft 4.1 Pro 矢量SVG(≈$0.30/张)"},
        {"id": "microsoft/mai-image-2.5-pro", "kind": "image", "fit": "文字排版图:海报/广告图里写字最可靠", "label": "MAI Image 2.5 Pro 生图(≈$0.11/张)"},
        {"id": "black-forest-labs/flux.2-flex", "kind": "image", "fit": "宽松可控:提示词随意写也能出好图", "label": "FLUX.2 Flex 生图(≈$0.05/张)"},
        {"id": "microsoft/mai-image-2.6", "kind": "image", "fit": "日常出图:便宜稳定", "label": "MAI Image 2.6 生图(≈$0.04/张)"},
        {"id": "recraft/recraft-v4-pro-vector", "kind": "image", "fit": "矢量 SVG 上一代,logo/图标备用", "label": "Recraft 4 Pro 矢量SVG(≈$0.30/张)"},
        {"id": "openai/gpt-5.5", "kind": "image", "fit": "多模态闲聊式生图:边聊边改图", "label": "GPT-5.5 多模态生图"},
        {"id": "google/gemini-2.5-flash-image", "kind": "image", "fit": "极致省钱:批量跑量(偶尔回文本自动重试)", "label": "Gemini 2.5 Flash 生图(≈$0.04/张,偶尔回文本自动重试)"},
        {"id": "recraft/recraft-v4.1-pro", "kind": "image", "fit": "高保真位图:品牌/印刷级素材", "label": "Recraft 4.1 Pro 位图(≈$0.21/张)"},
        {"id": "x-ai/grok-imagine-image-quality", "kind": "image", "fit": "写实抓拍感:照片级人像/场景", "label": "Grok Imagine 生图·高质量(≈$0.05/张)"},
        {"id": "microsoft/mai-image-2.6-flash", "kind": "image", "fit": "最便宜的稳定款:大量草稿迭代", "label": "MAI Image 2.6 Flash 生图(≈$0.02/张)"},
        {"id": "recraft/recraft-v4-vector", "kind": "image", "fit": "矢量 SVG 入门档", "label": "Recraft 4 矢量SVG(≈$0.08/张)"},
        {"id": "recraft/recraft-v4-pro", "kind": "image", "fit": "位图上一代 Pro", "label": "Recraft 4 Pro 位图(≈$0.25/张)"},
        {"id": "recraft/recraft-v4.1", "kind": "image", "fit": "位图标准档:日常设计素材", "label": "Recraft 4.1 位图(≈$0.035/张)"},
        {"id": "microsoft/mai-image-2.5", "kind": "image", "fit": "日常出图备用", "label": "MAI Image 2.5 生图(≈$0.05/张)"},
        {"id": "x-ai/grok-imagine-image-2.0", "kind": "image", "fit": "写实抓拍感标准档", "label": "Grok Imagine 生图·标准(≈$0.04/张)"},
        {"id": "recraft/recraft-v4.1-utility-pro", "kind": "image", "fit": "设计图专用:UI 稿/图表/版式", "label": "Recraft 4.1 Utility Pro 设计图(≈$0.21/张)"},
        {"id": "recraft/recraft-v4.1-flash", "kind": "image", "fit": "最便宜探索档:量大地草稿", "label": "Recraft 4.1 Flash 位图(≈$0.01/张)"},
        {"id": "recraft/recraft-v4", "kind": "image", "fit": "位图入门档", "label": "Recraft 4 位图(≈$0.04/张)"},
        {"id": "google/gemini-3.1-flash-lite-image", "kind": "image", "fit": "轻量快速:跑量草稿(jpeg 输出)", "label": "Gemini 3.1 Flash Lite 生图(≈$0.03/张,jpeg)"},
        {"id": "recraft/recraft-v4.1-utility", "kind": "image", "fit": "设计图标准档:线框/示意图", "label": "Recraft 4.1 Utility 设计图(≈$0.035/张)"},
        {"id": "black-forest-labs/flux.2-klein-4b", "kind": "image", "fit": "超便宜 experimenting:风格试验用", "label": "FLUX.2 Klein 4B 生图(≈$0.014/张)"},
        {"id": "recraft/recraft-v3", "kind": "image", "fit": "老将备用:风格稳定", "label": "Recraft V3 位图(≈$0.04/张)"},
        {"id": "sourceful/riverflow-v2-pro", "kind": "image", "fit": "艺术flow 风格试验(注意:回 webp 错标 png,已自动嗅探)", "label": "RiverFlow v2 Pro 生图(≈$0.15/张)"},
        {"id": "sourceful/riverflow-v2-fast", "kind": "image", "fit": "艺术flow 快速档", "label": "RiverFlow v2 Fast 生图(≈$0.02/张)"},
        # ---- 生视频(文生视频;/videos 实测通过) ----
        {"id": "google/veo-3.1", "kind": "video", "fit": "质量标杆:重要镜头/成片,画面与音频俱佳(自动带声音)", "label": "Veo 3.1 视频(≈$3.2/5s,默认带音频)", "durations": [4, 6, 8]},
        {"id": "google/veo-3.1-fast", "kind": "video", "fit": "Veo 快速档:重要镜头的快速迭代", "label": "Veo 3.1 Fast 视频(≈$0.96/5s)", "durations": [4, 6, 8]},
        {"id": "kwaivgi/kling-v3.0-pro", "kind": "video", "fit": "动作自然:人物表演/首尾帧衔接首选", "label": "可灵 3.0 Pro 视频", "durations": _dur(3, 15)},
        {"id": "bytedance/seedance-2.5", "kind": "video", "fit": "运动与节奏感强:舞蹈/动作戏", "label": "Seedance 2.5 视频(≈$1.17/5s)", "durations": _dur(4, 30)},
        {"id": "kwaivgi/kling-video-o1", "kind": "video", "fit": "可灵推理档:复杂动作理解", "label": "可灵 O1 视频(≈$0.56/5s)", "durations": [5, 10]},
        {"id": "alibaba/wan-3.0-prime", "kind": "video", "fit": "超长镜头:最长 30 秒的叙事段", "label": "Wan 3.0 Prime 视频(≈$1.4/5s)", "durations": _dur(2, 30)},
        {"id": "minimax/hailuo-3-max", "kind": "video", "fit": "电影感运镜:氛围/情绪镜头", "label": "海螺 3 Max 视频(≈$0.4/5s)", "durations": _dur(5, 15)},
        {"id": "runway/gen-4.5", "kind": "video", "fit": "风格化镜头:影视级质感控制", "label": "Runway Gen-4.5 视频(≈$0.6/5s)", "durations": _dur(2, 10)},
        {"id": "minimax/hailuo-3", "kind": "video", "fit": "2K 高清输出:清晰度优先的镜头", "label": "海螺 3 视频(2K 高清)", "durations": _dur(5, 15)},
        {"id": "alibaba/wan-3.0", "kind": "video", "fit": "长镜头:最长 30 秒,叙事段备用", "label": "Wan 3.0 视频(≈$0.85/5s)", "durations": _dur(2, 30)},
        {"id": "bytedance/seedance-2.0", "kind": "video", "fit": "动作戏标准档", "label": "Seedance 2.0 视频(≈$0.76/5s)", "durations": _dur(4, 15)},
        {"id": "black-forest-labs/flux-3-video", "kind": "video", "fit": "FLUX 美学延续:艺术风格视频", "label": "FLUX.3 视频(≈$0.85/5s)", "durations": _dur(5, 20)},
        {"id": "google/veo-3.1-lite", "kind": "video", "fit": "Veo 省钱档:日常镜头", "label": "Veo 3.1 Lite 视频(≈$0.64/5s)", "durations": [4, 6, 8]},
        {"id": "kwaivgi/kling-v3.0-std", "kind": "video", "fit": "性价比首选:日常图生视频/测试", "label": "可灵 3.0 标准视频", "durations": _dur(3, 15)},
        {"id": "alibaba/wan-2.7", "kind": "video", "fit": "阿里系均衡档", "label": "Wan 2.7 视频(≈$0.6/5s)", "durations": _dur(2, 10)},
        {"id": "x-ai/grok-imagine-video-1.5", "kind": "video", "fit": "秒级到 15 秒:短镜头快速出", "label": "Grok Imagine 1.5 视频(≈$0.4/5s)", "durations": _dur(1, 15)},
        {"id": "alibaba/happyhorse-1.1", "kind": "video", "fit": "阿里系新档备用", "label": "HappyHorse 1.1 视频(≈$0.64/5s)", "durations": _dur(3, 15)},
        {"id": "bytedance/seedance-2.0-fast", "kind": "video", "fit": "动作戏快速迭代", "label": "Seedance 2.0 Fast 视频(≈$0.46/5s)", "durations": _dur(4, 15)},
        {"id": "alibaba/wan-2.6", "kind": "video", "fit": "阿里系省钱档", "label": "Wan 2.6 视频(≈$0.4/5s)", "durations": [5, 10]},
        {"id": "minimax/hailuo-2.3", "kind": "video", "fit": "1080p 高清短镜头(仅 6/10 秒)", "label": "海螺 2.3 视频(1080p,≈$0.49/6s)", "durations": [6, 10]},
        {"id": "x-ai/grok-imagine-video-1.5-lite", "kind": "video", "fit": "最便宜探索:大量试镜头(1~15 秒)", "label": "Grok Imagine 1.5 Lite 视频(≈$0.1/5s)", "durations": _dur(1, 15)},
        {"id": "alibaba/happyhorse-1.0", "kind": "video", "fit": "阿里系上一代备用", "label": "HappyHorse 1.0 视频(≈$0.85/5s)", "durations": _dur(3, 15)},
        {"id": "bytedance/seedance-1-5-pro", "kind": "video", "fit": "动作戏省钱档", "label": "Seedance 1.5 Pro 视频(≈$0.26/5s)", "durations": _dur(4, 12)},
        {"id": "heygen/heygen-video-1", "kind": "video", "fit": "口播/说话人物(强制带声音)", "label": "HeyGen 视频(强制带声音,≈$0.08/5s)", "durations": _dur(5, 15)},
        {"id": "x-ai/grok-imagine-video", "kind": "video", "fit": "Grok 上一代便宜试错", "label": "Grok Imagine 视频(≈$0.25/5s)", "durations": _dur(1, 15)},
        {"id": "bytedance/seedance-2.0-mini", "kind": "video", "fit": "动作戏最便宜试错", "label": "Seedance 2.0 Mini 视频(≈$0.38/5s)", "durations": _dur(4, 15)},
    ],
}
GEN_ASPECT_RATIOS = {"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9", "auto"}
GEN_IMAGE_SIZES = {"1K", "2K"}
GEN_VIDEO_RESOLUTIONS = {"720p", "1080p"}
GEN_VIDEO_DURATIONS = {5, 10}
GEN_VIDEO_TIMEOUT_S = 15 * 60
GEN_TASK_TTL_S = 30 * 60   # 仅约束 running 任务(轮询访问即续期);终态结果由磁盘保留期管理
GEN_TASK_MAX = 200         # 任务池上限(快照已瘦身,不含 base64);满时只淘汰终态,全是 running 则拒绝提交
GEN_LIST_MAX = 60          # 任务列表接口最多返回最近 N 条(更早的仍在磁盘,凭 id 可查)
GEN_STUDIO_DIR = GENWORK / "studio"  # 生图工作台结果目录:<root>/studio/<taskId>/
GEN_STUDIO_RETENTION_DAYS = float(os.environ.get("GEN_STUDIO_RETENTION_DAYS") or 7)
GEN_REF_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$")
GEN_MAX_REF_BYTES = 2 * 1024 * 1024
GEN_MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
                "image/gif": "gif", "image/svg+xml": "svg", "video/mp4": "mp4"}
GEN_TASKID_RE = re.compile(r"^[a-f0-9]{32}$")

_GEN_LOCKS = threading.RLock()  # 重入锁:peek 等聚合函数会嵌套调用同锁函数
_GEN_TASKS = {}                 # id -> {"snap": snapshot, "ts": time.time()}
_GEN_QUOTA = {}                 # ip -> {"day", "minute", "minute_n", "image_n", "video_n"}
_GEN_FAILS = {}                 # ip -> {"day": "YYYY-MM-DD", "count": int}


def _gen_purge_expired():
    """running 任务闲置超 TTL 即清(线程死亡/卡死的兜底,轮询访问会续期);
    终态任务不再按 TTL 清,由磁盘保留期统一回收。调用方需持锁。"""
    now = time.time()
    for task_id in [tid for tid, t in _GEN_TASKS.items()
                    if t["snap"]["status"] == "running" and now - t["ts"] > GEN_TASK_TTL_S]:
        _GEN_TASKS.pop(task_id, None)


def _gen_evict_tasks():
    """任务池上限:满时只淘汰终态任务;全是 running 时拒绝提交——绝不删在跑的任务
    (旧实现会误删 running 快照,前端查 404、额度白扣)。调用方需持锁。"""
    _gen_purge_expired()
    while len(_GEN_TASKS) >= GEN_TASK_MAX:
        victim = next((tid for tid, t in _GEN_TASKS.items() if t["snap"]["status"] != "running"), None)
        if victim is None:
            raise GenError("pool_full")
        _GEN_TASKS.pop(victim, None)

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
        sig = hashlib.sha1(image_b64.encode("ascii")).hexdigest()  # 摘要做指纹;长度相同的不同图会误判已加载
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


# BEN2 自动抠图 worker(常驻子进程,模型驻留显存;协议见 matting_worker.py,看门狗复用 _sam_ask)
_MAT = {"proc": None, "lock": threading.Lock()}
_MAT_WORKER = ROOT / "matting_worker.py"


def _mat_ensure():
    """确保 BEN2 worker 就绪(ping 握手);返回 True 表示发生了新启动。"""
    proc = _MAT["proc"]
    if proc is None or proc.poll() is not None:
        py = _sam_python()  # 同一个 matting venv(torch+einops+timm+safetensors)
        if not py or not Path(py).exists():
            raise RuntimeError("未找到抠图 python 环境:请设 PYTHON_MATTING(指向带 torch 的 python,见 miniapp-kit doctor)")
        if not _MAT_WORKER.exists():
            raise RuntimeError(f"缺少 worker: {_MAT_WORKER}")
        _MAT["proc"] = subprocess.Popen(
            [py, str(_MAT_WORKER)], cwd=str(ROOT),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace")
        hello = _sam_ask(_MAT["proc"], {"cmd": "ping"}, 60)
        if not hello.get("ok"):
            raise RuntimeError("抠图 worker 握手失败: " + str(hello.get("error")))
        return True
    return False


def _mat_auto(image_b64, model="ben2"):
    """全自动抠图:worker 崩溃自动重启重试一次。返回 {"ok",rgba_b64,width,height,edge_px,seconds}。"""
    if model not in ("ben2", "briaai", "inspyrenet", "u2net", "isnet-anime"):
        raise RuntimeError("未知抠图模型")
    with _MAT["lock"]:
        for attempt in (1, 2):
            try:
                _mat_ensure()
                r = _sam_ask(_MAT["proc"], {"cmd": "matte", "model": model, "image_b64": image_b64}, 300)
                if not r.get("ok"):
                    raise RuntimeError(r.get("error", "未知错误"))
                return r
            except Exception:
                try:
                    if _MAT["proc"]:
                        _MAT["proc"].kill()
                except Exception:
                    pass
                _MAT["proc"] = None
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


def _oxipng_path():
    """oxipng 可执行文件:环境变量 FRAMEFLOW_OXIPNG > 项目 tools/ > PATH。"""
    p = os.environ.get("FRAMEFLOW_OXIPNG")
    if p and Path(p).exists():
        return Path(p)
    if OXIPNG_EXE.exists():
        return OXIPNG_EXE
    return shutil.which("oxipng")


def _oxipng_compress(image_bytes):
    """本地无损 PNG 优化(oxipng):像素 100% 不变,不剥离任何元数据块(iCCP/gAMA 保留,色彩管理不变)。
    优化结果若不小于原图则原样返回,保证"不大于原图"。返回 (bytes, note)。"""
    exe = _oxipng_path()
    if not exe:
        raise RuntimeError("未找到 oxipng:请确认 tools/oxipng/oxipng.exe 存在,或设 FRAMEFLOW_OXIPNG 指向可执行文件")
    try:
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "in.png"
            dst = Path(td) / "out.png"
            src.write_bytes(image_bytes)
            r = subprocess.run(
                [str(exe), "-q", "-o", "max", "--strip", "none", "--out", str(dst), str(src)],
                timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode != 0 or not dst.exists():
                raise RuntimeError(f"oxipng 优化失败(返回码 {r.returncode},输入是否为有效 PNG?)")
            out = dst.read_bytes()
    except subprocess.TimeoutExpired:
        raise RuntimeError("oxipng 处理超时(>300s)")
    if len(out) >= len(image_bytes):
        return image_bytes, "原图已最优,保留原文件"
    return out, ""


def _genmjs_path(override=None):
    p = Path(override or os.environ.get("FRAMEFLOW_GENMJS") or DEFAULT_GENMJS)
    return p


def _find_key():
    return os.environ.get(GEN_KEY_ENV) or os.environ.get("APIROUTER_KEY")


# ---------- 生图/生视频工作台实现(逻辑对齐 Pet10 imageGenerationService/imageTaskService) ----------
class GenError(Exception):
    """短错误码异常;_gen_error_status 映射为 HTTP 状态与公开错误码。"""

    def __init__(self, code, upstream_code=None, request_id=None, detail=""):
        super().__init__(code)
        self.code = code
        self.upstream_code = upstream_code
        self.request_id = request_id
        self.detail = detail


def _gen_studio_init():
    """启动时装配工作台配置:邀请码、上游 key(不落盘、不打印)。"""
    _load_miniapp_env()
    GEN_STUDIO["invite_code"] = (os.environ.get("GEN_INVITE_CODE")
                                 or os.environ.get("IMAGE_INVITE_CODE") or "").strip()
    GEN_STUDIO["upstream_key"] = (os.environ.get("IMAGE_UPSTREAM_API_KEY")
                                  or _find_key() or "").strip()


def _gen_day_now():
    """额度/锁定按服务器本地日期重置(UTC 要到早上 8 点才翻日,与用户直觉不符)。"""
    return datetime.datetime.now().strftime("%Y-%m-%d")


def _is_loopback(ip):
    return ip in ("127.0.0.1", "::1")


def _xff_client_ip(headers, peer):
    """真实客户端 IP:对端为回环且带 X-Forwarded-For(或 FRAMEFLOW_TRUST_PROXY=1)时,
    取 XFF 最后一个地址——nginx 追加式($proxy_add_x_forwarded_for)下真实来源在末位,
    取末位顺带免疫客户端伪造的首段(伪造头骗不了门,但仍影响额度/锁定归属);
    替换式(单元素)同样成立。额度/锁定/本机免码判定都按它计。"""
    if TRUST_PROXY or _is_loopback(peer):
        xff = headers.get("X-Forwarded-For")
        if xff:
            parts = [p.strip() for p in xff.split(",") if p.strip()]
            if parts:
                return parts[-1]
    return peer


def _pub_err(e):
    """异常转对外消息:剥掉服务器本机路径,错误串不泄露目录布局。"""
    s = str(e)
    for p in (str(ROOT), str(GENWORK), str(Path.home())):
        if p and p in s:
            s = s.replace(p, "…")
    return s or "服务器内部错误"


def _gen_authorize(invite_code, ip=None):
    """未配置邀请码 → 仅「真实 IP 与 TCP 对端都是回环」免码放行、其余拒绝(不计失败);
    配置了但对不上 → unauthorized(计失败)。经反代进来的流量即使对端是回环,
    真实 IP 是公网地址,同样要码——防 XFF 缺失时把全站误判成本机。
    比较用 compare_digest(时序安全,防逐字节探测)。"""
    if not GEN_STUDIO["invite_code"]:
        if ip and _is_loopback(ip):
            return
        raise GenError("upstream_unavailable")
    if not isinstance(invite_code, str) or not hmac.compare_digest(
            invite_code.encode("utf-8"), GEN_STUDIO["invite_code"].encode("utf-8")):
        raise GenError("unauthorized")


def _gen_locked(ip):
    with _GEN_LOCKS:
        rec = _GEN_FAILS.get(ip)
        return bool(rec and rec["day"] == _gen_day_now()
                    and rec["count"] >= GEN_STUDIO["invite_max_failures"])


def _gen_fail(ip):
    with _GEN_LOCKS:
        day = _gen_day_now()
        rec = _GEN_FAILS.get(ip)
        _GEN_FAILS[ip] = {"day": day, "count": (rec["count"] + 1) if rec and rec["day"] == day else 1}


def _gen_attempts_left(ip):
    with _GEN_LOCKS:
        rec = _GEN_FAILS.get(ip)
        used = rec["count"] if rec and rec["day"] == _gen_day_now() else 0
        return max(0, GEN_STUDIO["invite_max_failures"] - used)


def _gen_quota_allow(ip, kind, daily_n):
    """分钟池扣 1 次(图/视频共享);日额度按 kind 分池(图=按张,视频=按个)。全有或全无。"""
    minute = int(time.time() // 60)
    day = _gen_day_now()
    with _GEN_LOCKS:
        rec = _GEN_QUOTA.get(ip)
        if not rec or rec["day"] != day:
            rec = {"day": day, "minute": -1, "minute_n": 0, "image_n": 0, "video_n": 0}
            _GEN_QUOTA[ip] = rec
        if rec["minute"] != minute:
            rec["minute"] = minute
            rec["minute_n"] = 0
        cap = GEN_STUDIO["image_daily"] if kind == "image" else GEN_STUDIO["video_daily"]
        if rec["minute_n"] + 1 > GEN_STUDIO["rate_per_minute"] or rec[kind + "_n"] + daily_n > cap:
            return False
        rec["minute_n"] += 1
        rec[kind + "_n"] += daily_n
        return True


def _gen_quota_release(ip, kind, daily_n=0, minute_n=0):
    """生成失败退额度:日额度退 daily_n;全部未出时分钟额度退 minute_n。"""
    with _GEN_LOCKS:
        rec = _GEN_QUOTA.get(ip)
        if not rec:
            return
        rec[kind + "_n"] = max(0, rec[kind + "_n"] - daily_n)
        rec["minute_n"] = max(0, rec["minute_n"] - minute_n)


def _gen_quota_peek(ip):
    minute = int(time.time() // 60)
    day = _gen_day_now()
    with _GEN_LOCKS:
        rec = _GEN_QUOTA.get(ip)
        minute_n = rec["minute_n"] if rec and rec["minute"] == minute else 0
        image_n = rec["image_n"] if rec and rec["day"] == day else 0
        video_n = rec["video_n"] if rec and rec["day"] == day else 0
        return {"perMinuteLimit": GEN_STUDIO["rate_per_minute"],
                "imageDailyLimit": GEN_STUDIO["image_daily"],
                "videoDailyLimit": GEN_STUDIO["video_daily"],
                "minuteRemaining": max(0, GEN_STUDIO["rate_per_minute"] - minute_n),
                "imageRemaining": max(0, GEN_STUDIO["image_daily"] - image_n),
                "videoRemaining": max(0, GEN_STUDIO["video_daily"] - video_n),
                "retentionDays": GEN_STUDIO_RETENTION_DAYS,
                "attemptsRemaining": _gen_attempts_left(ip)}


def _gen_resolve_model(model_id):
    for m in GEN_STUDIO["models"]:
        if m["id"] == model_id:
            return m
    raise GenError("invalid_model")


def _gen_validate_refs(refs):
    if len(refs) > 5:
        raise GenError("invalid_reference_images")
    for ref in refs:
        match = GEN_REF_RE.match(ref or "")
        if not match:
            raise GenError("invalid_reference_image")
        b64 = match.group(2)
        padding = 2 if b64.endswith("==") else (1 if b64.endswith("=") else 0)
        if (len(b64) * 3 // 4) - padding > GEN_MAX_REF_BYTES:
            raise GenError("invalid_reference_image_size")


def _gen_upstream(path, body, timeout_s=300):
    """POST 上游 /chat/completions 与 /videos;网络失败/非 JSON/带 error 字段抛 GenError。"""
    req = urllib.request.Request(
        GEN_BASE_URL + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + GEN_STUDIO["upstream_key"]},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            status = resp.status
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = {}
        try:
            detail = json.loads(e.read().decode("utf-8"))
        except Exception:
            pass
        raise _gen_upstream_error(detail, e.code)
    except Exception:
        raise GenError("upstream_unavailable")
    if not isinstance(payload, dict):
        raise GenError("upstream_invalid_response", upstream_code=status)
    if payload.get("error"):
        raise _gen_upstream_error(payload, status)
    return payload, status


def _gen_upstream_error(payload, status):
    err = payload.get("error") if isinstance(payload, dict) else None
    code = err.get("code") if isinstance(err, dict) else None
    message = err.get("message") if isinstance(err, dict) else None
    req_id = (err.get("request_id") or err.get("requestId")
              or payload.get("request_id") or payload.get("requestId")) if isinstance(err, dict) else None
    try:
        code_i = int(code)
    except (TypeError, ValueError):
        code_i = status
    return GenError("upstream_unavailable" if status >= 500 or code_i >= 500 else "upstream_rejected",
                    upstream_code=code_i, request_id=req_id if isinstance(req_id, str) else None,
                    detail=str(message or ""))


def _gen_usage(payload):
    """只挑计费相关数字(cost/tokens),不透传其他内部字段。"""
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return None
    out = {}
    cost = usage.get("cost")
    if isinstance(cost, (int, float)) and cost > 0:
        out["cost"] = cost
    tokens = sum(v for k, v in usage.items()
                 if k in ("total_tokens", "prompt_tokens", "completion_tokens")
                 and isinstance(v, (int, float)) and not isinstance(v, bool))
    if tokens > 0:
        out["tokens"] = int(tokens)
    return out or None


def _gen_sniff_mime(b64_body):
    """从 base64 内容嗅探真实图片类型(上游声明的 mime 偶有错标,如 riverflow 报 png 实为 webp)。"""
    try:
        chunk = b64_body[:96]
        head = base64.b64decode(chunk + "=" * (-len(chunk) % 4))[:16]
    except Exception:
        return ""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"GIF8":
        return "image/gif"
    if head.lstrip(b" \t\r\n").startswith(b"<"):
        return "image/svg+xml"
    return ""


def _gen_image_once(prompt, model_id, aspect_ratio=None, image_size=None, refs=None):
    """单张出图:openai 系才吃 image_config;模型偶尔回文本不回图时自动重试一次。
    返回项带 mime(嗅探优先、声明次之):前端靠它拼 data URL,写死 png 会显示坏图。"""
    supports_cfg = model_id.startswith("openai/") and "image" in model_id
    content = prompt if not refs else ([{"type": "text", "text": prompt}]
                                       + [{"type": "image_url", "image_url": {"url": r}} for r in refs])
    body = {"model": model_id,
            "messages": [{"role": "user", "content": content}],
            "modalities": ["image"]}
    if supports_cfg:
        body["image_config"] = {"image_size": image_size or "2K",
                                **({} if aspect_ratio in (None, "auto") else {"aspect_ratio": aspect_ratio})}
    last_err = None
    for attempt in range(2):
        payload, status = _gen_upstream("/chat/completions", body)
        url = ""
        try:
            url = payload["choices"][0]["message"]["images"][0]["image_url"]["url"] or ""
        except (KeyError, IndexError, TypeError):
            pass
        # 空串也算没图:上游软拒绝时 images 数组存在但 url 为空,前端会拿到两手空空的项
        if not url:
            # 回 200 但没带图(常见于偶发文本回复):记脱敏日志后重试一次
            last_err = GenError("upstream_invalid_response", upstream_code=status)
            if attempt == 0:
                message = payload.get("choices", [{}])[0].get("message", {})
                print(json.dumps({"event": "gen_no_image", "status": status, "attempt": 1,
                                  "messageKeys": ",".join(message.keys()) if isinstance(message, dict) else "",
                                  "hasImages": isinstance(message, dict) and bool(message.get("images")),
                                  "emptyUrl": isinstance(message, dict) and bool(message.get("images"))}))
                continue
            raise last_err
        match = re.match(r"^data:([^;,]+);base64,(.+)$", url, re.S)
        if match:
            declared, body_b64 = match.group(1), match.group(2)
            mime = _gen_sniff_mime(body_b64) or (declared if declared.startswith("image/") else "")
            return {"data": [{"b64_json": body_b64, "mime": mime or "image/png"}], "usage": _gen_usage(payload)}
        return {"data": [{"url": url}], "usage": _gen_usage(payload)}
    raise last_err or GenError("upstream_invalid_response")


def _gen_video_once(prompt, model_id, duration=None, audio=None, frame_mode=None, refs=None,
                    resolution=None, cancel_fn=None, on_status=None):
    """视频:创建→轮询→经 /content 代理取片(unsigned_urls 直链指向上游需上游侧鉴权,拉了是空体)。
    generate_audio 必须显式发送:多数模型上游默认开声音(实测 wan/seedance/veo/flx 等均带音轨),
    不勾选也得显式关掉;heygen 强制带声音、拒绝该参数,报 audio 相关 400 时去参重试。
    cancel_fn 每轮轮询前检查(取消不撤上游单,上游可能照常计费);on_status 把排队/处理中状态透传给快照。"""
    body = {"model": model_id, "prompt": prompt}
    if duration is not None:
        body["duration"] = duration
    if resolution:
        body["resolution"] = resolution  # 仅用户显式选择才发;部分模型不吃该参数,默认自动档不传
    body["generate_audio"] = bool(audio)
    if audio:
        body["audio"] = True  # 老 kling 语义兼容
    refs = refs or []
    if refs:
        frames = [{"type": "image_url", "image_url": {"url": refs[0]}, "frame_type": "first_frame"}]
        if frame_mode == "first_last":
            if len(refs) < 2:
                raise GenError("invalid_frame_mode")
            # 首尾帧模式(实测上游支持):第 2 张参考图作尾帧
            frames.append({"type": "image_url", "image_url": {"url": refs[1]}, "frame_type": "last_frame"})
        body["frame_images"] = frames
    elif frame_mode == "first_last":
        raise GenError("invalid_frame_mode")
    for attempt in (1, 2):
        try:
            payload, _ = _gen_upstream("/videos", body, timeout_s=120)
            break
        except GenError as e:
            # 个别模型不接受 generate_audio 参数(实测 heygen):去掉音频参数重试一次
            if (attempt == 1 and e.upstream_code == 400
                    and "audio" in (e.detail or "").lower()
                    and "generate_audio" in body):
                body.pop("generate_audio", None)
                body.pop("audio", None)
                continue
            raise
    job_id = payload.get("id") or payload.get("jobId") or payload.get("job_id") or payload.get("task_id")
    if not job_id:
        raise GenError("upstream_invalid_response")
    deadline = time.time() + GEN_VIDEO_TIMEOUT_S
    first_poll = True
    while time.time() < deadline:
        if cancel_fn and cancel_fn():
            raise GenError("cancelled")
        # 首轮 3 秒(任务通常秒级入队),之后 5 秒
        time.sleep(3 if first_poll else 5)
        first_poll = False
        req = urllib.request.Request(f"{GEN_BASE_URL}/videos/{job_id}",
                                     headers={"Authorization": "Bearer " + GEN_STUDIO["upstream_key"]})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                poll = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
        if not isinstance(poll, dict):
            continue
        if poll.get("error"):
            raise GenError("upstream_rejected")
        data = poll.get("data") if isinstance(poll.get("data"), dict) else {}
        status = poll.get("status") or poll.get("state") or data.get("status")
        if on_status and isinstance(status, str) and status not in ("completed", "failed", "cancelled"):
            on_status(status)
        if status == "completed":
            direct = None
            urls = poll.get("unsigned_urls")
            if isinstance(urls, list) and urls and isinstance(urls[0], str):
                direct = urls[0]
            elif isinstance(poll.get("url"), str):
                direct = poll["url"]
            result = _gen_video_download(job_id, direct)
            result["usage"] = _gen_usage(poll)
            return result
        if status in ("failed", "cancelled"):
            raise GenError("upstream_rejected")
    raise GenError("upstream_unavailable")


def _gen_video_download(job_id, direct_url=None):
    headers = {"Authorization": "Bearer " + GEN_STUDIO["upstream_key"]}
    try:
        req = urllib.request.Request(f"{GEN_BASE_URL}/videos/{job_id}/content", headers=headers)
        with urllib.request.urlopen(req, timeout=300) as resp:
            raw = resp.read()
        if raw:
            return {"data": [{"b64_json": base64.b64encode(raw).decode("ascii"), "mime": "video/mp4"}]}
    except Exception:
        pass
    if direct_url:
        try:
            with urllib.request.urlopen(direct_url, timeout=300) as resp:
                raw = resp.read()
        except Exception:
            raise GenError("upstream_invalid_response")
        if not raw:
            raise GenError("upstream_invalid_response")
        return {"data": [{"b64_json": base64.b64encode(raw).decode("ascii"), "mime": "video/mp4"}]}
    raise GenError("upstream_invalid_response")


_GEN_OPT_SYSTEM = {
    "image": "\n".join([
        "你是文生图提示词优化专家。把用户给的简短提示词改写成可直接用于文生图模型的中文提示词:",
        "1) 保留用户的主体、意图与偏好,绝不更换或新增主体;",
        "2) 补全这些要素:主体外观与状态、动作或姿态、场景环境、艺术风格与媒介、构图与视角、光线氛围;",
        "3) 句式连贯自然,不要罗列碎片标签,总长控制在 60~200 字;",
        "4) 除非用户明确要求画面中出现文字或 logo,否则在结尾追加一句约束:「画面中不出现任何文字、字母、数字、水印或 logo」;若用户要求了文字,把那段文字原文(含标点)原样写进提示词;",
        "5) 只输出优化后的提示词本身,不要解释、不要引号、不要分点。"]),
    "image_refs": "\n".join([
        "你是文生图提示词优化专家。用户会随提示词提供参考图,参考图决定画面主体与内容基础:",
        "1) 保留用户的主体、意图与偏好,绝不更换或新增主体;不复述参考图里已能看到的主体外观细节(如发色、服装、配色),避免与参考图冲突;",
        "2) 补全参考图决定不了的要素:动作或姿态、场景环境、艺术风格与媒介、构图与视角、光线氛围;",
        "3) 句式连贯自然,不要罗列碎片标签,总长控制在 60~200 字;",
        "4) 除非用户明确要求画面中出现文字或 logo,否则在结尾追加一句约束:「画面中不出现任何文字、字母、数字、水印或 logo」;若用户要求了文字,把那段文字原文(含标点)原样写进提示词;",
        "5) 只输出优化后的提示词本身,不要解释、不要引号、不要分点。"]),
    "video_first": "\n".join([
        "你是图生视频提示词优化专家。首帧图已经决定画面外观,提示词只负责描述运动:",
        "1) 保留用户想要的动作意图,绝不更换主体或场景;",
        "2) 用一两句话描述主体的连续运动(动作幅度小而柔和)与镜头要求(默认镜头固定、不切换镜头、不新增元素;仅当用户明确要求运镜时,保留其意图但限制为小幅缓慢的推拉或摇移);",
        "3) 用户提到风格或氛围时可少量保留,不要复述首帧图里的外观细节;",
        "4) 总长控制在 30~120 字;只输出优化后的提示词本身,不要解释、不要引号、不要分点。"]),
    "video_text": "\n".join([
        "你是文生视频提示词优化专家。用户没有提供首帧图,提示词需要自己交代画面:",
        "1) 保留用户的主体、意图与偏好,绝不更换或新增主体;",
        "2) 先用一句话交代场景与主体外观(简单、色块化、便于视频模型渲染),再描述动作(动作幅度小而柔和)与镜头(默认镜头固定、不切换镜头、不新增元素;用户明确要求运镜时,保留为小幅缓慢的推拉或摇移);",
        "3) 总长控制在 60~200 字;只输出优化后的提示词本身,不要解释、不要引号、不要分点。"]),
}


def _gen_optimize(prompt, kind, has_first_frame, has_refs=False):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > GEN_STUDIO["max_prompt"]:
        raise GenError("invalid_prompt")
    if not GEN_STUDIO["upstream_key"]:
        raise GenError("upstream_unavailable")
    if kind == "image":
        system = _GEN_OPT_SYSTEM["image_refs"] if has_refs else _GEN_OPT_SYSTEM["image"]
    else:
        system = _GEN_OPT_SYSTEM["video_first"] if has_first_frame else _GEN_OPT_SYSTEM["video_text"]
    payload, _ = _gen_upstream("/chat/completions", {
        "model": GEN_STUDIO["prompt_model"],
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt.strip()}],
        "max_tokens": 800}, timeout_s=120)
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise GenError("upstream_invalid_response")
    if not isinstance(content, str) or not content.strip():
        raise GenError("upstream_invalid_response")
    return content.strip()[:GEN_STUDIO["max_prompt"]]


# ---------- 结果落盘(rerun / 重启恢复 / 保留期清理的依据) ----------
def _gen_task_dir(task_id):
    return GEN_STUDIO_DIR / task_id


def _gen_task_write_request(task_id, params, refs):
    """请求与参考图落盘(提交时调用,供 rerun 与重启恢复)。尽力而为:失败仅记日志,不阻断生成。"""
    d = _gen_task_dir(task_id)
    try:
        d.mkdir(parents=True, exist_ok=True)
        ref_files = []
        for i, ref in enumerate(refs, 1):
            m = GEN_REF_RE.match(ref or "")
            if not m:
                continue
            name = f"ref-{i}.{GEN_MIME_EXT.get('image/' + m.group(1), 'png')}"
            (d / name).write_bytes(base64.b64decode(m.group(2)))
            ref_files.append(name)
        meta = {k: v for k, v in params.items() if k != "referenceImages"}
        meta["refFiles"] = ref_files
        (d / "request.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(json.dumps({"event": "gen_persist_error", "task": task_id[:8],
                          "stage": "request", "error": str(e)}))


def _gen_task_write_outputs(task_id, data):
    """结果二进制落盘;成功返回瘦身后的 data(每项 {"file","mime"}),失败返回 None(内存兜底)。"""
    d = _gen_task_dir(task_id)
    slim = []
    try:
        d.mkdir(parents=True, exist_ok=True)
        for i, item in enumerate(data, 1):
            b64 = item.get("b64_json")
            if not b64:
                slim.append(dict(item))  # url 型结果保持原样
                continue
            mime = item.get("mime") or "image/png"
            name = f"out-{i}.{GEN_MIME_EXT.get(mime, 'png')}"
            (d / name).write_bytes(base64.b64decode(b64))
            slim.append({"file": name, "mime": mime})
        return slim
    except Exception as e:
        print(json.dumps({"event": "gen_persist_error", "task": task_id[:8],
                          "stage": "outputs", "error": str(e)}))
        return None


def _gen_task_write_meta(task_id, snapshot):
    """终态快照存 meta.json(重启恢复历史用);仅在结果已落盘或本就无产出时写。"""
    d = _gen_task_dir(task_id)
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / "meta.json").write_text(json.dumps(dict(snapshot), ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(json.dumps({"event": "gen_persist_error", "task": task_id[:8],
                          "stage": "meta", "error": str(e)}))


def _gen_restore_tasks():
    """启动时从磁盘恢复任务历史:有 meta.json 的按快照恢复;只有 request.json 的
    (重启时还没跑完)合成「中断」失败快照,参数齐全可一键重试。"""
    if not GEN_STUDIO_DIR.exists():
        return
    for d in GEN_STUDIO_DIR.iterdir():
        if not d.is_dir() or not GEN_TASKID_RE.fullmatch(d.name):
            continue
        snap = None
        meta_path = d / "meta.json"
        req_path = d / "request.json"
        if meta_path.exists():
            try:
                cand = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                cand = None
            if isinstance(cand, dict) and cand.get("id") == d.name:
                snap = cand
                if snap.get("status") == "running":
                    snap["status"] = "failed"
                    snap["error"] = "interrupted"
        if snap is None and req_path.exists():
            try:
                raw = json.loads(req_path.read_text(encoding="utf-8"))
            except Exception:
                raw = None
            if isinstance(raw, dict) and raw.get("model"):
                kind = "video" if any(k in raw for k in ("duration", "frameMode", "resolution")) else "image"
                task_params = {"kind": kind, "refCount": len(raw.get("refFiles") or [])}
                if kind == "image":
                    for k in ("count", "aspectRatio", "imageSize"):
                        if raw.get(k) is not None:
                            task_params[k] = raw[k]
                else:
                    for k in ("duration", "resolution"):
                        if raw.get(k) is not None:
                            task_params[k] = raw[k]
                    task_params["audio"] = raw.get("audio") is True
                    task_params["frameMode"] = raw.get("frameMode") or "first"
                snap = {"id": d.name, "model": raw["model"], "kind": kind,
                        "status": "failed", "error": "interrupted",
                        "createdAt": datetime.datetime.fromtimestamp(d.stat().st_mtime).isoformat(),
                        "prompt": str(raw.get("prompt") or ""), "params": task_params}
        if snap is None:
            continue
        with _GEN_LOCKS:
            _GEN_TASKS.setdefault(d.name, {"snap": snap, "ts": time.time(), "cancel": False})


def _gen_cleanup_expired_files():
    """清理超过保留期的任务目录(连同内存记录);启动时与每次提交时调用。"""
    if not GEN_STUDIO_DIR.exists():
        return
    cutoff = time.time() - GEN_STUDIO_RETENTION_DAYS * 86400
    for d in GEN_STUDIO_DIR.iterdir():
        if not d.is_dir() or not GEN_TASKID_RE.fullmatch(d.name):
            continue
        try:
            if d.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(d, ignore_errors=True)
        with _GEN_LOCKS:
            _GEN_TASKS.pop(d.name, None)


def _gen_cancel_requested(task_id):
    with _GEN_LOCKS:
        t = _GEN_TASKS.get(task_id)
        return bool(t and t.get("cancel"))


def _gen_task_set_status(task_id, value):
    """视频轮询状态透传到快照(前端显示「上游:processing」等)。"""
    with _GEN_LOCKS:
        t = _GEN_TASKS.get(task_id)
        if t:
            t["snap"]["upstreamStatus"] = value


def _gen_run_task(task_id, model, input_data, daily_take):
    """任务线程:图片 count 张并行,视频单个;生出来才扣额度,失败按张/个退日额度。
    取消:图片在等线程收尾时轮询标志,视频在轮询间隙查;取消不撤上游单,上游可能照常计费,
    已产出的部分照常落盘保留。"""
    snapshot = _GEN_TASKS[task_id]["snap"]
    ip = input_data["ip"]
    started = time.time()
    data = []
    costs = []
    token_counts = []

    def collect(result):
        data.extend(result["data"])
        usage = result.get("usage")
        if usage:
            if "cost" in usage:
                costs.append(usage["cost"])
            if "tokens" in usage:
                token_counts.append(usage["tokens"])

    def finish(status_name):
        """统一收尾:落盘(成功/取消带产出的场合)→ 退额度 → 更新快照 → meta.json。"""
        slim = _gen_task_write_outputs(task_id, data) if data else None
        if slim is not None:
            data[:] = slim  # 瘦身成功即释放内存里的 base64 大字符串
        produced = len(data)
        # 生出来才扣额度:未出的部分退日额度,全部未出时连分钟额度一起退
        _gen_quota_release(ip, model["kind"], daily_take - produced, 1 if produced == 0 else 0)
        usage = {}
        if sum(costs) > 0:
            usage["cost"] = sum(costs)
        if sum(token_counts) > 0:
            usage["tokens"] = int(sum(token_counts))
        snapshot.pop("upstreamStatus", None)
        snapshot.pop("cancelling", None)
        snapshot.update(status=status_name, durationMs=int((time.time() - started) * 1000),
                        **({"data": data} if produced else {}),
                        **({"usage": usage} if usage else {}))
        if slim is not None or not produced:
            _gen_task_write_meta(task_id, snapshot)

    try:
        if model["kind"] == "video":
            collect(_gen_video_once(input_data["prompt"], model["id"],
                                    duration=input_data.get("duration"),
                                    audio=input_data.get("audio"),
                                    frame_mode=input_data.get("frame_mode"),
                                    refs=input_data.get("refs"),
                                    resolution=input_data.get("resolution"),
                                    cancel_fn=lambda: _gen_cancel_requested(task_id),
                                    on_status=lambda s: _gen_task_set_status(task_id, s)))
            finish("succeeded")
        else:
            results = [None] * input_data["count"]
            errors = []

            def run_one(i):
                try:
                    results[i] = _gen_image_once(input_data["prompt"], model["id"],
                                                 aspect_ratio=input_data.get("aspect_ratio"),
                                                 image_size=input_data.get("image_size"),
                                                 refs=input_data.get("refs"))
                    with _GEN_LOCKS:
                        snapshot["produced"] = snapshot.get("produced", 0) + 1
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=run_one, args=(i,)) for i in range(input_data["count"])]
            for t in threads:
                t.start()
            cancelled = False
            while any(t.is_alive() for t in threads):
                if _gen_cancel_requested(task_id):
                    cancelled = True  # 在飞请求不中断:收下已完成的,丢弃未回来的
                    break
                time.sleep(0.4)
            for r in results:
                if r:
                    collect(r)
            if not data and not cancelled:
                raise (errors[0] if errors else GenError("upstream_unavailable"))
            finish("cancelled" if cancelled else "succeeded")
    except Exception as e:
        code = e.code if isinstance(e, GenError) else "upstream_unavailable"
        _gen_quota_release(ip, model["kind"], daily_take, 1)
        snapshot.pop("upstreamStatus", None)
        snapshot.pop("cancelling", None)
        if code == "cancelled":
            snapshot.update(status="cancelled", durationMs=int((time.time() - started) * 1000))
        else:
            snapshot.update(status="failed", durationMs=int((time.time() - started) * 1000), error=code)
        _gen_task_write_meta(task_id, snapshot)


def _gen_submit(params, ip, invite_code):
    """校验→扣额度→后台线程(提交即返回);与 Pet10 imageTaskService.submit 对齐。"""
    if _gen_locked(ip):
        raise GenError("invite_locked")
    _gen_authorize(invite_code, ip)  # 错码由调用方记失败次数
    prompt = params.get("prompt") if isinstance(params.get("prompt"), str) else ""
    if not prompt.strip() or len(prompt) > GEN_STUDIO["max_prompt"]:
        raise GenError("invalid_prompt")
    model = _gen_resolve_model(params.get("model"))
    count = params.get("count") if params.get("count") is not None else 1
    try:
        count = int(count)
    except (TypeError, ValueError):
        raise GenError("invalid_count")
    if count < 1 or count > 4 or (model["kind"] == "video" and count > 1):
        raise GenError("invalid_count")
    aspect_ratio = params.get("aspectRatio")
    if aspect_ratio is not None and (model["kind"] != "image" or aspect_ratio not in GEN_ASPECT_RATIOS):
        raise GenError("invalid_aspect_ratio")
    image_size = params.get("imageSize")
    if image_size is not None and (model["kind"] != "image" or image_size not in GEN_IMAGE_SIZES):
        raise GenError("invalid_image_size")
    resolution = params.get("resolution")
    if resolution is not None and (model["kind"] != "video" or resolution not in GEN_VIDEO_RESOLUTIONS):
        raise GenError("invalid_resolution")
    duration = params.get("duration")
    if duration is not None:
        if model["kind"] != "video":
            raise GenError("invalid_duration")
        try:
            duration = int(duration)
        except (TypeError, ValueError):
            raise GenError("invalid_duration")
        # 时长按模型各自支持集合校验(来自中转 /videos/models;如 veo 只吃 4/6/8)
        if duration not in (model.get("durations") or GEN_VIDEO_DURATIONS):
            raise GenError("invalid_duration")
    frame_mode = params.get("frameMode")
    if frame_mode is not None and (model["kind"] != "video" or frame_mode not in ("first", "first_last")):
        raise GenError("invalid_frame_mode")
    refs = params.get("referenceImages")
    refs = refs if (isinstance(refs, list) and all(isinstance(r, str) for r in refs)) else []
    _gen_validate_refs(refs)
    if frame_mode == "first_last" and len(refs) < 2:
        raise GenError("invalid_frame_mode")
    if not GEN_STUDIO["upstream_key"]:
        raise GenError("upstream_unavailable")
    # 校验全部通过才扣额度:分钟池共享一次;图片按张、视频按个走各自日额度
    daily_take = count if model["kind"] == "image" else 1
    if not _gen_quota_allow(ip, model["kind"], daily_take):
        raise GenError("rate_limit")
    _gen_cleanup_expired_files()
    with _GEN_LOCKS:
        _gen_evict_tasks()
        task_id = uuid.uuid4().hex
        # 快照带全量参数(prompt 不再截断):前端渲染参数行、rerun 原样重跑都靠它
        task_params = {"kind": model["kind"], "refCount": len(refs)}
        if model["kind"] == "image":
            task_params["count"] = count
            if aspect_ratio:
                task_params["aspectRatio"] = aspect_ratio
            if image_size:
                task_params["imageSize"] = image_size
        else:
            if duration:
                task_params["duration"] = duration
            task_params["audio"] = params.get("audio") is True
            task_params["frameMode"] = frame_mode or "first"
            if resolution:
                task_params["resolution"] = resolution
        snapshot = {"id": task_id, "model": model["id"], "kind": model["kind"],
                    "status": "running", "createdAt": datetime.datetime.now().isoformat(),
                    "prompt": prompt, "params": task_params}
        _GEN_TASKS[task_id] = {"snap": snapshot, "ts": time.time(), "cancel": False}
    input_data = {"prompt": prompt, "aspect_ratio": aspect_ratio, "image_size": image_size,
                  "count": count, "duration": duration, "resolution": resolution,
                  "audio": True if params.get("audio") is True else None,
                  "frame_mode": frame_mode, "refs": refs, "ip": ip}
    _gen_task_write_request(task_id, params, refs)  # 请求+参考图落盘(供 rerun/重启恢复;尽力而为)
    threading.Thread(target=_gen_run_task, args=(task_id, model, input_data, daily_take),
                     daemon=True).start()
    return dict(snapshot)


def _gen_task_get(task_id):
    with _GEN_LOCKS:
        _gen_purge_expired()
        task = _GEN_TASKS.get(task_id)
        return dict(task["snap"]) if task else None


def _gen_task_list():
    """任务快照(旧→新,最多最近 GEN_LIST_MAX 条,更早的仍在磁盘);刷新页面后恢复列表用。"""
    with _GEN_LOCKS:
        _gen_purge_expired()
        snaps = [dict(t["snap"]) for _, t in sorted(_GEN_TASKS.items(), key=lambda kv: kv[1]["ts"])]
        return snaps[-GEN_LIST_MAX:]


def _gen_task_touch(task_id):
    """刷新任务 TTL(有结果被再次访问时续期,仍看完 30 分钟后再清)。"""
    with _GEN_LOCKS:
        task = _GEN_TASKS.get(task_id)
        if task:
            task["ts"] = time.time()


def _gen_set_prompt(task_id, prompt):
    """快照附提示词(列表恢复时渲染卡片用)。"""
    with _GEN_LOCKS:
        task = _GEN_TASKS.get(task_id)
        if task:
            task["snap"]["prompt"] = prompt[:200]


def _gen_task_cancel(task_id):
    """请求取消:置标志即返回(任务线程在轮询/收尾间隙响应);已结束任务幂等返回快照。"""
    with _GEN_LOCKS:
        t = _GEN_TASKS.get(task_id)
        if not t:
            raise GenError("task_not_found")
        if t["snap"]["status"] == "running":
            t["cancel"] = True
            t["snap"]["cancelling"] = True
        return dict(t["snap"])


def _gen_task_rerun(task_id, ip, invite_code):
    """按落盘的 request.json 原样重跑(失败重试/再来一次):走完整校验+额度,生成新任务。"""
    if not GEN_TASKID_RE.fullmatch(task_id or ""):
        raise GenError("task_not_found")
    d = _gen_task_dir(task_id)
    try:
        raw = json.loads((d / "request.json").read_text(encoding="utf-8"))
    except Exception:
        raise GenError("task_not_found")
    if not isinstance(raw, dict):
        raise GenError("task_not_found")
    refs = []
    for name in raw.pop("refFiles", None) or []:
        if not isinstance(name, str) or not re.fullmatch(r"ref-\d+\.(?:png|jpg|webp|gif|svg)", name):
            continue
        p = d / name
        if not p.is_file():
            continue
        mime = {"png": "png", "jpg": "jpeg", "webp": "webp", "gif": "gif", "svg": "svg"}[name.rsplit(".", 1)[1]]
        refs.append("data:image/" + mime + ";base64," + base64.b64encode(p.read_bytes()).decode("ascii"))
    if refs:
        raw["referenceImages"] = refs
    return _gen_submit(raw, ip, invite_code)


def _gen_task_file(task_id, index):
    """结果文件 (绝对路径, mime);index 从 1 起。仅限瘦身后带 file 引用的项。"""
    if not GEN_TASKID_RE.fullmatch(task_id or ""):
        raise GenError("task_not_found")
    snap = _gen_task_get(task_id)
    if not snap or snap.get("status") not in ("succeeded", "cancelled"):
        raise GenError("task_not_found")
    items = snap.get("data") or []
    if not isinstance(index, int) or index < 1 or index > len(items):
        raise GenError("task_not_found")
    item = items[index - 1] or {}
    name = item.get("file")
    # 文件名只可能是服务端自己生成的 out-N.<ext>,防目录穿越
    if not isinstance(name, str) or not re.fullmatch(r"out-\d+\.(?:png|jpg|jpeg|webp|gif|svg|mp4)", name):
        raise GenError("task_not_found")
    p = _gen_task_dir(task_id) / name
    if not p.is_file():
        raise GenError("task_not_found")
    return p, item.get("mime") or "application/octet-stream"


def _gen_error_status(code):
    if code == "unauthorized":
        return 401, "invalid_invite_code"
    if code == "invite_locked":
        return 403, "invite_locked"
    if code == "rate_limit":
        return 429, "rate_limit_exceeded"
    if code == "pool_full":
        return 429, "task_pool_full"
    if code == "task_not_found":
        return 404, "task_not_found"
    if code.startswith("invalid"):
        return 400, code
    if code == "upstream_rejected":
        return 502, "upstream_rejected"
    return 503, "image_generation_unavailable"


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


# ---------- 短剧工作台(/api/drama/*;项目落盘 genwork/drama/,与生图工作台同一门禁) ----------
# 定位:编排层。生成始终走 /api/studio/tasks(额度/重试/上游语义零改动),前端拿到成品素材后
# 立刻 POST 回 /api/drama/projects/<pid>/asset 落盘——短剧项目与素材不受 30 分钟 TTL 限制。
DRAMA_DIR = GENWORK / "drama"  # 随 FRAMEFLOW_GENWORK_DIR;剧本/素材绝不能放在站点根下被静态托管
DRAMA_STORY_MODEL = GEN_STUDIO["prompt_model"]
DRAMA_ASPECTS = ("9:16", "16:9", "1:1", "4:3")
DRAMA_ASSET_MAX_BYTES = 80 * 1024 * 1024
DRAMA_PID_RE = re.compile(r"^[a-f0-9]{12}$")
DRAMA_REL_RE = re.compile(r"^(?:composed\.mp4|(?:chars|shots)/[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp|mp4|wav))$")
DRAMA_DATAURL_RE = re.compile(r"^data:(image/(?:png|jpeg|webp)|video/mp4);base64,([A-Za-z0-9+/=]+)$")
DRAMA_MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4"}
_DRAMA_LOCK = threading.Lock()  # project.json 读改写全程持锁,避免并发丢更新(项目量小,文件 IO 快)

# 风格快选(填进项目「画面风格」,仍可手改;会经 styleSuffix 进所有镜头/定妆提示词)
DRAMA_STYLES = [
    "日系赛璐璐动漫,柔和光影",
    "吉卜力水彩,温暖笔触",
    "美漫硬朗,粗黑描边",
    "国风水墨,留白意境",
    "皮克斯式 3D,圆润材质",
    "真实电影感,浅景深",
    "赛博朋克霓虹,湿润街道",
    "复古胶片,颗粒质感",
    "极简扁平插画,几何色块",
    "港漫热血,浓墨锐利",
]

# 剧本灵感库:题名 + 一句话梗概 + 建议风格(meta 随机抽 3 条下发)
DRAMA_IDEAS = [
    {"title": "重置夜", "logline": "深夜便利店,会说话的黑猫告诉打工女孩,凌晨世界会重置一次,两人用最后的夜晚做完最遗憾的事", "style": "日系赛璐璐动漫,柔和光影"},
    {"title": "电梯里的一百层", "logline": "加班族深夜搭电梯回家,电梯却一直下行,每层开门都是他人生里一个没说出口的告别", "style": "真实电影感,浅景深"},
    {"title": "外卖骑士与龙", "logline": "外卖骑士接到的最后一单,顾客是城堡里被困的龙——deadline 是天亮前送达", "style": "美漫硬朗,粗黑描边"},
    {"title": "旧城的钟表匠", "logline": "全城的钟都停在 3:07,修表老人发现每修好一座钟,就有一段记忆从街上消失", "style": "复古胶片,颗粒质感"},
    {"title": "奶奶的食谱", "logline": "孙女照奶奶的菜谱做菜,每做对一道,就多想起一段她没讲过的往事,最后一页是留给她的", "style": "吉卜力水彩,温暖笔触"},
    {"title": "云上出租车", "logline": "出租车司机接单到一朵云,乘客是一阵风,想在天黑前绕城一圈看看它吹过的所有人", "style": "吉卜力水彩,温暖笔触"},
    {"title": "第七次相亲", "logline": "相亲对象每次都不同,却总在同一句话后说出同一个口癖——原来她也在重置里找一个人", "style": "都市轻喜剧,日系赛璐璐动漫"},
    {"title": "充电桩花园", "logline": "城市里所有共享充电桩一夜之间开出了花,机器人快递员要护送最后一株没有花的桩回山上", "style": "皮克斯式 3D,圆润材质"},
    {"title": "镜面咖啡厅", "logline": "咖啡厅的镜子照出的不是你,而是三年后的你——但只在你点最便宜的那杯时开口", "style": "赛博朋克霓虹,湿润街道"},
    {"title": "留白", "logline": "画师画什么都自动留出一块空白,直到他画下那杯没来得及递给她的茶,空白里浮出了字", "style": "国风水墨,留白意境"},
    {"title": "末班地铁地图", "logline": "末班地铁多出一个不存在的站,站台牌上写着乘客们最想念的人的名字,车只停一次", "style": "极简扁平插画,几何色块"},
    {"title": "雨停营业中", "logline": "只有下雨才营业的小酒馆,客人进来要交一件心事当酒钱,打烊时老板把它们酿成了明天的晴天", "style": "复古胶片,颗粒质感"},
    {"title": "AI 与拾荒者", "logline": "报废的陪护机器人在废土上捡到了还能用的旧电池,用它照亮的不是自己,是给走失孩子留下的路标", "style": "美漫硬朗,粗黑描边"},
    {"title": "一觉醒来 taller", "logline": "社恐男孩一觉醒来发现自己变成了巨人,只能蹲在天台上和楼下送伞的女孩说话", "style": "皮克斯式 3D,圆润材质"},
    {"title": "雪人邮差", "logline": "雪人替冬天的孩子送信,春天将至,它必须在融化前把最后一封信送到", "style": "吉卜力水彩,温暖笔触"},
    {"title": " neon 灯下的刀客", "logline": "赛博城市最后的线下当铺只收「回忆」当「银票」,今晚来了个刀客,要当掉杀过人的那只右手", "style": "港漫热血,浓墨锐利"},
    {"title": "海的补习班", "logline": "老渔民给一只不会捕鱼的鹭上补习班,一个暑假后,鹭学会了捕鱼,老人学会了告别", "style": "吉卜力水彩,温暖笔触"},
    {"title": "照片里的第四个人", "logline": "三个好友翻看毕业合照,发现每张合影都多出一个谁也不认识的脸,而它越来越清晰", "style": "悬疑惊悚,真实电影感"},
    {"title": "噪音收藏家", "logline": "少女收集城市里即将消失的声音:老磨坊、爆米花机、妈妈的缝纫机——直到收藏到自己的心跳", "style": "极简扁平插画,几何色块"},
    {"title": "加班楼里的怪兽", "logline": "加班到深夜的人偶尔会在消防通道遇见一只怪兽,它不吃人,只吃没说完的那句「我想回家」", "style": "日系赛璐璐动漫,柔和光影"},
]


def _drama_now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _drama_new_id():
    return uuid.uuid4().hex[:12]


def _drama_read(pid):
    """读取项目(仅读);项目不存在抛 RuntimeError。"""
    with _DRAMA_LOCK:
        path = DRAMA_DIR / pid / "project.json"
        if not path.exists():
            raise RuntimeError("项目不存在")
        return json.loads(path.read_text(encoding="utf-8"))


def _drama_mutate(pid, fn):
    """读改写全程持锁;fn(data) 内可抛异常终止保存。返回快照副本。"""
    with _DRAMA_LOCK:
        path = DRAMA_DIR / pid / "project.json"
        if not path.exists():
            raise RuntimeError("项目不存在")
        data = json.loads(path.read_text(encoding="utf-8"))
        fn(data)
        data["updatedAt"] = _drama_now()
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return json.loads(json.dumps(data))


def _drama_list():
    if not DRAMA_DIR.exists():
        return []
    out = []
    for d in sorted(DRAMA_DIR.iterdir(), key=lambda p: p.name):
        if not d.is_dir() or not DRAMA_PID_RE.fullmatch(d.name):
            continue
        try:
            data = _drama_read(d.name)
        except Exception:
            continue
        out.append({"id": data["id"], "title": data.get("title", ""),
                    "updatedAt": data.get("updatedAt", ""),
                    "shotCount": len(data.get("shots", [])),
                    "clipCount": sum(1 for s in data.get("shots", []) if s.get("clip"))})
    return out


def _drama_create(params):
    title = (params.get("title") or "").strip() or "未命名短剧"
    aspect = params.get("aspect") if params.get("aspect") in DRAMA_ASPECTS else "9:16"
    data = {"id": _drama_new_id(), "title": title[:60],
            "logline": (params.get("logline") or "").strip()[:600],
            "style": (params.get("style") or "").strip()[:120],
            "aspect": aspect, "createdAt": _drama_now(), "updatedAt": _drama_now(),
            "chars": [], "shots": [], "composed": None}
    with _DRAMA_LOCK:
        d = DRAMA_DIR / data["id"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "project.json").write_text(json.dumps(data, ensure_ascii=False, indent=2),
                                        encoding="utf-8")
    return data


def _drama_delete(pid):
    with _DRAMA_LOCK:
        d = DRAMA_DIR / pid
        if not d.exists():
            raise RuntimeError("项目不存在")
        shutil.rmtree(d)


def _drama_project_update(pid, params):
    def apply(d):
        if isinstance(params.get("title"), str):
            d["title"] = params["title"].strip()[:60] or d["title"]
        if isinstance(params.get("logline"), str):
            d["logline"] = params["logline"].strip()[:600]
        if isinstance(params.get("style"), str):
            d["style"] = params["style"].strip()[:120]
        if params.get("aspect") in DRAMA_ASPECTS:
            d["aspect"] = params["aspect"]
    return _drama_mutate(pid, apply)


_DRAMA_STORY_SYSTEM = "\n".join([
    "你是短剧分镜师。根据故事梗概、画面风格与角色设定,把故事拆成指定数量的连续镜头。",
    "只输出一个 JSON 数组,不要解释、不要 markdown 代码块。数组每项必须是对象:",
    '{"scene":"第X镜·场景地点与时间","desc":"画面描述:景别、人物、动作、情绪,60字内",'
    '"firstPrompt":"文生图提示词:该镜首帧画面,交代场景环境与人物外观位置,60~150字",'
    '"motionPrompt":"图生视频提示词:只描述主体连续动作与镜头要求,30~80字"}',
    "要求:1) 镜头按时间顺序连续推进,覆盖起承转合,结尾镜头给出收束感;",
    "2) 角色名字、外观与角色设定严格一致,不同镜头里同一角色的外观描述保持一致;",
    "3) 提示词里不出现任何文字、字幕、水印、logo;",
    "4) 每镜只讲一个动作,动作幅度小而柔和,镜头固定不切换。"])


def _drama_storyboard(pid, params):
    """LLM 起草分镜:输入项目里的梗概/风格/角色,追加 N 个镜头;分镜表可再手改。
    withLines=true 时按章节(起/承/转/合)分组起草,并给每镜写对白(lines 字段)。"""
    try:
        n = int(params.get("nShots") or 6)
    except (TypeError, ValueError):
        raise GenError("invalid_prompt")
    n = max(1, min(24, n))
    with_lines = params.get("withLines") is True
    data = _drama_read(pid)
    logline = (params.get("logline") if isinstance(params.get("logline"), str) else data.get("logline")) or ""
    style = (params.get("style") if isinstance(params.get("style"), str) else data.get("style")) or ""
    if not logline.strip():
        raise RuntimeError("故事梗概为空:先在项目里填一句话故事")
    if not GEN_STUDIO["upstream_key"]:
        raise GenError("upstream_unavailable")
    char_lines = "\n".join(f"- {c.get('name', '?')}:{c.get('desc', '')}"
                           for c in data.get("chars", []) if (c.get("name") or c.get("desc")))
    user = (f"故事梗概:{logline.strip()}\n画面风格:{style.strip() or '电影感写实'}\n"
            f"画幅:{data.get('aspect', '9:16')}\n镜头数:{n}")
    if char_lines:
        user += "\n角色设定:\n" + char_lines
    if with_lines:
        user += ("\n额外要求:1) 按四章节把镜头分组:起(铺垫)/承(推进)/转(反转或高潮)/合(收束),"
                 "scene 字段写成「起·第1章:场景」这样的格式;"
                 "2) 有对话的镜头在 lines 字段写对白,格式「角色名:台词」一行一句"
                 "(可多句,合计 ≤40 字,念白时长要能放进该镜时长里;无对话就留空);"
                 "3) 对白口语化、符合角色身份,不要书面腔。")
    payload, _ = _gen_upstream("/chat/completions", {
        "model": DRAMA_STORY_MODEL,
        "messages": [{"role": "system", "content": _DRAMA_STORY_SYSTEM},
                     {"role": "user", "content": user}],
        "max_tokens": 6000}, timeout_s=180)
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise GenError("upstream_invalid_response")
    fence = re.search(r"\[.*\]", content, re.S)  # 容忍 ```json 围栏,直接抓最外层数组
    if not fence:
        raise GenError("upstream_invalid_response")
    try:
        arr = json.loads(fence.group(0))
    except Exception:
        raise GenError("upstream_invalid_response")
    if not isinstance(arr, list):
        raise GenError("upstream_invalid_response")
    added = []
    for item in arr[:n]:
        if not isinstance(item, dict):
            continue
        try:
            dur = int(item.get("duration") or 5)
        except (TypeError, ValueError):
            dur = 5
        added.append({"id": _drama_new_id(), "scene": str(item.get("scene") or "")[:60],
                      "desc": str(item.get("desc") or "")[:300],
                      "firstPrompt": str(item.get("firstPrompt") or "")[:1200],
                      "motionPrompt": str(item.get("motionPrompt") or "")[:1200],
                      "lines": str(item.get("lines") or "")[:2000] if with_lines else "",
                      "voice": "default", "audio": False, "tts": None,
                      "duration": max(2, min(30, dur)),
                      "firstFrame": None, "clip": None,
                      "firstTaskId": None, "clipTaskId": None})
    if not added:
        raise GenError("upstream_invalid_response")

    def apply(d):
        d["shots"].extend(added)
    return _drama_mutate(pid, apply), added


_DRAMA_BRAINSTORM_SYSTEM = "\n".join([
    "你是短剧创意顾问。根据用户给的种子(可为空)现编 3 个一句话短剧点子。",
    "只输出一个 JSON 数组,不要解释、不要 markdown 代码块。数组每项必须是对象:",
    '{"title":"短剧名(6字内)","logline":"一句话梗概(40~70字,有反转或钩子,适合 6 镜短剧)",'
    '"style":"建议画面风格(12字内,如:日系赛璐璐动漫)"}',
    "要求:1) 题材多样(都市奇幻/悬疑/温情/科幻/轻喜剧都行),不要与种子雷同;",
    "2) 主角具体、可视觉化,梗概里最好有一个能视觉化的画面;",
    "3) 不要出现任何文字、字幕、水印、logo 的描述。"])


def _drama_brainstorm(params):
    """LLM 现编 3 条剧本点子;走 ip+":opt" 宽松额度,不占生图额度。"""
    seed = (params.get("seed") or "").strip()[:200]
    if not GEN_STUDIO["upstream_key"]:
        raise GenError("upstream_unavailable")
    user = "种子(参考即可,不必拘泥):" + (seed or "随便给 3 个有趣的点子")
    payload, _ = _gen_upstream("/chat/completions", {
        "model": DRAMA_STORY_MODEL,
        "messages": [{"role": "system", "content": _DRAMA_BRAINSTORM_SYSTEM},
                     {"role": "user", "content": user}],
        "max_tokens": 1500}, timeout_s=120)
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise GenError("upstream_invalid_response")
    fence = re.search(r"\[.*\]", content, re.S)
    if not fence:
        raise GenError("upstream_invalid_response")
    try:
        arr = json.loads(fence.group(0))
    except Exception:
        raise GenError("upstream_invalid_response")
    ideas = []
    for item in arr if isinstance(arr, list) else []:
        if isinstance(item, dict) and (item.get("title") or item.get("logline")):
            ideas.append({"title": str(item.get("title") or "未命名")[:30],
                          "logline": str(item.get("logline") or "")[:400],
                          "style": str(item.get("style") or "")[:60]})
    if not ideas:
        raise GenError("upstream_invalid_response")
    return ideas[:3]


# 配音音色(Windows SAPI 实测可用;default=按角色名匹配,/auto 只给旁白)
DRAMA_VOICES = [
    {"id": "default", "label": "自动(按角色性别)"},
    {"id": "female", "label": "女声(慧慧)"},
    {"id": "male", "label": "英文(试验)"},
]

# 台词灵感库:按情绪场景分类的一组示范对白(meta 抽 4 条下发;可直接填进镜头 lines)
DRAMA_LINES_IDEAS = [
    {"mood": "开场钩子", "lines": "黑猫:明天凌晨三点,这个世界会重置一次。\n小满:……你刚才是不是说话了?"},
    {"mood": "悬念反问", "lines": "黑猫:你有没有什么话,是拖到今天还没说出口的?"},
    {"mood": "下决心", "lines": "小满:那就趁今晚。反正明天一过,谁也不记得谁。"},
    {"mood": "温情告白", "lines": "小满:其实我一直想说——谢谢你,陪我把这条街走完了。"},
    {"mood": "反转揭示", "lines": "黑猫:重置的不是世界,是记得的人。\n小满:那你会记得我吗?"},
    {"mood": "收束独白", "lines": "小满:便利店打烊了,而我们,才算刚刚开门。"},
    {"mood": "日常斗嘴", "lines": "小满:关东煮最后一份,让给你。\n黑猫:哼,这可是你欠我的。"},
    {"mood": "危机提醒", "lines": "黑猫:三点还有十分钟!想做的事,现在就去做!"},
]


def _sapi_tts(text, voice, out_path):
    """Windows SAPI 文本转语音(Zh CN Huihui / en-US Zira),输出 16k 单声道 wav。零依赖。"""
    import tempfile
    body = text.replace("\r", "").replace('"', "'").strip()
    if not body:
        raise RuntimeError("台词为空")
    vs = {"default": "", "female": "Microsoft Huihui Desktop", "male": "Microsoft Zira Desktop"}
    v = vs.get((voice or "default"), "")
    pick = f'$s.SelectVoice("{v}")' if v else ""
    out = Path(out_path).resolve().as_posix()
    ps = "\n".join([
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        pick,
        f'$s.SetOutputToWaveFile("{out}", ',
        "  (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, ",
        "  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, ",
        "  [System.Speech.AudioFormat.AudioChannel]::Mono)))",
        f'$s.Speak(@"\n{body}\n"@)',
        "$s.Dispose()",
    ])
    with tempfile.NamedTemporaryFile(suffix=".ps1", delete=False, mode="w", encoding="utf-8-sig") as f:
        f.write(ps)
        script = f.name
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
                           capture_output=True, timeout=120)
    finally:
        try:
            os.unlink(script)
        except OSError:
            pass
    if r.returncode != 0 or not Path(out).exists() or Path(out).stat().st_size < 1000:
        err = r.stderr.decode("gbk", "replace")[-200:]
        raise RuntimeError("TTS 生成失败" + (f":{err}" if err else ""))


def _drama_shot_tts(pid, sid, params=None):
    """为镜头生成配音:lines 按「角色名:台词」解析,逐句 TTS 后用 ffmpeg concat 成一条,
    存 shots/<sid>_tts.wav;失败/空台词清理旧文件。返回项目快照。"""
    data = _drama_read(pid)
    shot = next((s for s in data["shots"] if s["id"] == sid), None)
    if not shot:
        raise RuntimeError("镜头不存在")
    lines = [l.strip() for l in (shot.get("lines") or "").splitlines() if l.strip()]
    if not lines:
        raise RuntimeError("这一镜没有对白:先在台词区写几句(格式「角色名:台词」)")
    proj_dir = DRAMA_DIR / pid
    parts = []
    for i, line in enumerate(lines, 1):
        who, _, say = line.partition(":")
        voice = "default"
        for c in data.get("chars", []):
            if who and who.strip() and who.strip() == (c.get("name") or "").strip():
                voice = c.get("voice") or "default"
                break
        part = proj_dir / f"shots/{sid}_tts_part{i}.wav"
        _sapi_tts(say or line, voice, part)
        parts.append(part)
    out = proj_dir / f"shots/{sid}_tts.wav"
    if len(parts) == 1:
        shutil.copyfile(parts[0], out)
    else:
        lst = proj_dir / f"shots/{sid}_tts.txt"
        lst.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in parts), encoding="utf-8")
        r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                            "-f", "concat", "-safe", "0", "-i", lst.as_posix(),
                            "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", out.as_posix()],
                           timeout=300, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            lst.unlink()
        except OSError:
            pass
        if r.returncode != 0 or not out.exists():
            raise RuntimeError("配音拼接失败")
    for p in parts:
        if p != out:
            try:
                p.unlink()
            except OSError:
                pass
    rel = f"shots/{sid}_tts.wav"

    def apply(d):
        it = next((s for s in d["shots"] if s["id"] == sid), None)
        if not it:
            raise RuntimeError("镜头已被删除")
        it["tts"] = rel
    return _drama_mutate(pid, apply)


def _drama_char_add(pid, params):
    name = (params.get("name") or "").strip() or "新角色"
    def apply(d):
        d["chars"].append({"id": _drama_new_id(), "name": name[:30],
                           "desc": (params.get("desc") or "").strip()[:400],
                           "voice": "default", "refs": [], "asset": None, "portraitTaskId": None})
    return _drama_mutate(pid, apply)


def _drama_char_update(pid, cid, params):
    def apply(d):
        it = next((c for c in d["chars"] if c["id"] == cid), None)
        if not it:
            raise RuntimeError("角色不存在")
        if isinstance(params.get("name"), str):
            it["name"] = params["name"].strip()[:30] or it["name"]
        if isinstance(params.get("desc"), str):
            it["desc"] = params["desc"].strip()[:400]
        if isinstance(params.get("voice"), str):
            it["voice"] = params["voice"].strip()[:30] or "default"
        if "portraitTaskId" in params:
            v = params["portraitTaskId"]
            it["portraitTaskId"] = v.strip()[:64] if isinstance(v, str) and v.strip() else None
    return _drama_mutate(pid, apply)


def _drama_char_delete(pid, cid):
    data = _drama_read(pid)
    it = next((c for c in data["chars"] if c["id"] == cid), None)
    if not it:
        raise RuntimeError("角色不存在")
    data = _drama_mutate(pid, lambda d: d["chars"].remove(next(c for c in d["chars"] if c["id"] == cid)))
    if it.get("asset"):
        try:
            (DRAMA_DIR / pid / it["asset"]).unlink()
        except OSError:
            pass
    return data


def _drama_shot_add(pid, params):
    def norm(p):
        try:
            dur = int(p.get("duration") or 5)
        except (TypeError, ValueError):
            dur = 5
        return {"id": _drama_new_id(), "scene": str(p.get("scene") or "")[:60],
                "desc": str(p.get("desc") or "")[:300],
                "firstPrompt": str(p.get("firstPrompt") or "")[:1200],
                "motionPrompt": str(p.get("motionPrompt") or "")[:1200],
                "lines": str(p.get("lines") or "")[:2000],
                "voice": str(p.get("voice") or "default")[:30],
                "duration": max(2, min(30, dur)),
                "audio": p.get("audio") is True,
                "tts": None,   # 该镜配音文件(相对路径);合成时混入
                "firstFrame": None, "clip": None, "firstTaskId": None, "clipTaskId": None}
    incoming = params.get("shots") if isinstance(params.get("shots"), list) else [params]
    incoming = [p for p in incoming if isinstance(p, dict)][:20]

    def apply(d):
        d["shots"].extend(norm(p) for p in incoming)
    return _drama_mutate(pid, apply)


def _drama_shot_update(pid, sid, params):
    def apply(d):
        it = next((s for s in d["shots"] if s["id"] == sid), None)
        if not it:
            raise RuntimeError("镜头不存在")
        for k in ("scene", "desc", "firstPrompt", "motionPrompt", "lines", "voice"):
            if isinstance(params.get(k), str):
                it[k] = params[k].strip()[:2000 if k == "lines" else (1200 if k.endswith("Prompt") else (60 if k == "voice" else 300))]
        try:
            dur = int(params.get("duration"))
        except (TypeError, ValueError):
            dur = None
        if dur is not None:
            it["duration"] = max(2, min(30, dur))
        if "audio" in params:
            it["audio"] = params.get("audio") is True
        for k in ("firstTaskId", "clipTaskId"):
            if k in params:
                v = params[k]
                it[k] = v.strip()[:64] if isinstance(v, str) and v.strip() else None
    return _drama_mutate(pid, apply)


def _drama_shot_delete(pid, sid):
    data = _drama_read(pid)
    it = next((s for s in data["shots"] if s["id"] == sid), None)
    if not it:
        raise RuntimeError("镜头不存在")
    data = _drama_mutate(pid, lambda d: d["shots"].remove(next(s for s in d["shots"] if s["id"] == sid)))
    for rel in (it.get("firstFrame"), it.get("clip")):
        if rel:
            try:
                (DRAMA_DIR / pid / rel).unlink()
            except OSError:
                pass
    return data


def _drama_shot_reorder(pid, params):
    order = params.get("order")
    if not isinstance(order, list) or not all(isinstance(x, str) for x in order):
        raise RuntimeError("order 必须是镜头 id 数组")

    def apply(d):
        idx = {s["id"]: s for s in d["shots"]}
        arranged = [idx[i] for i in order if i in idx]
        tail = [s for s in d["shots"] if s["id"] not in set(order)]
        d["shots"] = arranged + tail
    return _drama_mutate(pid, apply)


def _drama_url_guard(url):
    """素材代取的 SSRF 防护:仅 http/https,且主机不得解析到回环/私网/链路本地/保留地址
    (防 file:// 读本地文件、防借服务器探测内网)。"""
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https"):
        raise RuntimeError("素材 URL 仅支持 http/https")
    host = p.hostname or ""
    if not host:
        raise RuntimeError("素材 URL 缺少主机名")
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        raise RuntimeError("素材 URL 主机无法解析")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if getattr(ip, "ipv4_mapped", None) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if (ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_reserved or ip.is_unspecified or ip.is_multicast):
            raise RuntimeError("素材 URL 指向内网/保留地址,已拒绝")


def _drama_asset_bytes(params):
    """素材二进制:dataURL 直接解码;URL 由服务端代取(上游回 URL 时前端无需下载)。"""
    data_url = params.get("dataUrl") if isinstance(params.get("dataUrl"), str) else None
    url = params.get("url") if isinstance(params.get("url"), str) else None
    if data_url:
        m = DRAMA_DATAURL_RE.match(data_url)
        if not m:
            raise RuntimeError("dataURL 格式不支持(仅 jpg/png/webp/mp4)")
        mime, b64 = m.group(1), m.group(2)
        padding = 2 if b64.endswith("==") else (1 if b64.endswith("=") else 0)
        if (len(b64) * 3 // 4) - padding > DRAMA_ASSET_MAX_BYTES:
            raise RuntimeError("素材超过 80MB 上限")
        return base64.b64decode(b64), DRAMA_MIME_EXT[mime]
    if url:
        _drama_url_guard(url)  # SSRF:仅 http(s),拒绝回环/私网/保留地址
        req = urllib.request.Request(url)
        for attempt in (1, 2):
            try:
                if attempt == 2:
                    req = urllib.request.Request(url, headers={
                        "Authorization": "Bearer " + GEN_STUDIO["upstream_key"]})  # 上游直链可能需鉴权
                with urllib.request.urlopen(req, timeout=120) as resp:
                    ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                    raw = resp.read(DRAMA_ASSET_MAX_BYTES + 1)
                break
            except Exception:
                if attempt == 2:
                    raise RuntimeError("素材 URL 下载失败(含带鉴权重试)")
                continue
        if not raw or len(raw) > DRAMA_ASSET_MAX_BYTES:
            raise RuntimeError("素材为空或超过 80MB 上限")
        ext = (DRAMA_MIME_EXT.get(ctype)
               or {"png": "png", "jpg": "jpg", "jpeg": "jpg", "webp": "webp", "mp4": "mp4"}.get(
                   Path(urllib.parse.urlparse(url).path).suffix.lstrip(".").lower()))
        if not ext:
            raise RuntimeError("素材 URL 类型不支持(jpg/png/webp/mp4)")
        return raw, ext
    raise RuntimeError("缺少 dataUrl 或 url(收到 keys=[" + ",".join(
        str(k) for k in (params.keys() if isinstance(params, dict) else [])) + "])")


def _drama_asset_store(pid, params):
    """把成品素材挂到镜头(kind=first/clip)或角色(kind=portrait)上并落盘;旧素材文件清理。"""
    target, kind = params.get("target"), params.get("kind")
    if target not in ("char", "shot") or (target == "char" and kind != "portrait") \
            or (target == "shot" and kind not in ("first", "clip")):
        raise RuntimeError("target/kind 不合法")
    item_id = str(params.get("id") or "")
    field = "asset" if target == "char" else {"first": "firstFrame", "clip": "clip"}[kind]
    raw, ext = _drama_asset_bytes(params)
    rel = (f"chars/{item_id}.{ext}" if target == "char" else f"shots/{item_id}_{kind}.{ext}")
    data = _drama_read(pid)
    items = data["chars"] if target == "char" else data["shots"]
    item = next((x for x in items if x["id"] == item_id), None)
    if not item:
        raise RuntimeError("角色不存在" if target == "char" else "镜头不存在")
    old = item.get(field)
    path = DRAMA_DIR / pid / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    if old and old != rel:
        try:
            (DRAMA_DIR / pid / old).unlink()
        except OSError:
            pass

    def apply(d):
        it = next((x for x in (d["chars"] if target == "char" else d["shots"]) if x["id"] == item_id), None)
        if not it:
            raise RuntimeError("目标已被删除")
        it[field] = rel
        if target == "shot":
            it["firstTaskId" if kind == "first" else "clipTaskId"] = None
        else:
            it["portraitTaskId"] = None
    return _drama_mutate(pid, apply)


def _drama_char_refs_add(pid, cid, params):
    """角色参考图上传:dataURL 存储(≤5 张、单张 ≤2MB,jpg/png/webp);命名 <cid>_ref<i>.<ext>。"""
    data_url = params.get("dataUrl") if isinstance(params.get("dataUrl"), str) else ""
    m = re.match(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$", data_url)
    if not m:
        raise RuntimeError("参考图格式不支持,只接受 jpg/png/webp 的 dataURL")
    b64 = m.group(2)
    padding = 2 if b64.endswith("==") else (1 if b64.endswith("=") else 0)
    if (len(b64) * 3 // 4) - padding > GEN_MAX_REF_BYTES:
        raise RuntimeError("参考图超过 2MB")
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[m.group(1)]
    raw = base64.b64decode(b64)

    def apply(d):
        it = next((c for c in d["chars"] if c["id"] == cid), None)
        if not it:
            raise RuntimeError("角色不存在")
        refs = [r for r in it.get("refs", []) if r]
        if len(refs) >= 5:
            raise RuntimeError("参考图最多 5 张")
        used = {Path(r).stem.rsplit("_ref", 1)[-1] for r in refs}
        name = None
        for i in range(1, 6):
            if str(i) not in used:
                cand = f"chars/{cid}_ref{i}.{ext}"
                if not any(r == cand for r in refs):
                    name = cand
                    break
        if not name:
            raise RuntimeError("参考图位已满")
        (DRAMA_DIR / pid / name).parent.mkdir(parents=True, exist_ok=True)
        (DRAMA_DIR / pid / name).write_bytes(raw)
        it["refs"] = refs + [name]
    return _drama_mutate(pid, apply)


def _drama_char_refs_delete(pid, cid, params):
    """删除第 index 张参考图(1 起);文件一并清理。"""
    try:
        index = int(params.get("index"))
    except (TypeError, ValueError):
        raise RuntimeError("index 必须是数字")
    data = _drama_read(pid)
    it = next((c for c in data["chars"] if c["id"] == cid), None)
    if not it:
        raise RuntimeError("角色不存在")
    refs = [r for r in it.get("refs", []) if r]
    if index < 1 or index > len(refs):
        raise RuntimeError("参考图序号不存在")
    rel = refs[index - 1]
    try:
        (DRAMA_DIR / pid / rel).unlink()
    except OSError:
        pass

    def apply(d):
        it2 = next((c for c in d["chars"] if c["id"] == cid), None)
        if not it2:
            raise RuntimeError("角色不存在")
        it2["refs"] = [r for r in (it2.get("refs") or []) if r and r != rel]
    return _drama_mutate(pid, apply)


def _ffprobe_duration(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", Path(path).as_posix()],
                           timeout=60, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return float(r.stdout.decode("utf-8", "replace").strip() or 0)
    except Exception:
        return 0.0


def _ffprobe_size(path):
    """首视频流宽高(取偶数,libx264 要求);失败返回 (0, 0)。"""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height", "-of", "csv=p=0",
                            Path(path).as_posix()],
                           timeout=60, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        w, h = r.stdout.decode("utf-8", "replace").strip().split(",")[:2]
        return int(w) - int(w) % 2, int(h) - int(h) % 2
    except Exception:
        return 0, 0


def _ffprobe_has_audio(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                            "-show_entries", "stream=codec_name", "-of", "csv=p=0",
                            Path(path).as_posix()],
                           timeout=60, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return bool(r.stdout.decode("utf-8", "replace").strip())
    except Exception:
        return False


def _drama_compose(pid, burn_subs=False):
    """拼接全部已生成镜头成片。
    1) 无配音需求时:流复制(-c copy)秒拼零转码——但 concat demuxer 拼部分 H.264 流
       (实测可灵成片,B 帧/访问单元边界问题)会把视频流拼坏:包数缺失、pts 拉长
       (5×5s 拼出 37s 视频+25s 音频),故拼完必须校验总时长;
    2) 校验不过退级 concat filter 重编码:统一缩放/加黑边到首镜画幅,音轨齐就连音一起拼;
    3) 有镜头生成过配音(tts wav)或要烧字幕时:走逐镜 amix 重编码——每镜先把配音
       (adelay 起始 0.5s)混入原音轨(视频够长就截断配音、不够则音频延到片尾淡出),
       再 concat;burn_subs 同时把该镜 lines 烧成底部字幕。"""
    data = _drama_read(pid)
    shots = [s for s in data["shots"] if s.get("clip")]
    clips = [DRAMA_DIR / pid / s["clip"] for s in shots]
    clips = [p for p in clips if p.exists()]
    if not clips:
        raise RuntimeError("还没有任何镜头成片,先生成视频")
    proj_dir = DRAMA_DIR / pid
    out = proj_dir / "composed.mp4"
    tts_list = [DRAMA_DIR / pid / s["tts"] for s in shots if s.get("tts")]
    tts_list = [p for p in tts_list if p.exists()]
    need_mix = bool(tts_list) or burn_subs
    expect = sum(_ffprobe_duration(p) for p in clips)
    ok = False
    if not need_mix and len(clips) > 1:
        lst = proj_dir / "concat.txt"
        lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in clips), encoding="utf-8")
        base = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", lst.as_posix()]
        try:
            r = subprocess.run(base + ["-c", "copy", out.as_posix()],
                               timeout=600, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except subprocess.TimeoutExpired:
            r = None
        ok = bool(r and r.returncode == 0 and out.exists() and out.stat().st_size > 1000
                  and expect > 0 and abs(_ffprobe_duration(out) - expect) < 0.5)
    if not ok:
        if _ffprobe_duration(clips[0]) <= 0:
            raise RuntimeError("成片文件无法读取(可能已损坏),请重roll该镜")
        if len(clips) == 1 and not need_mix:
            shutil.copyfile(clips[0], out)  # 单镜直接取该镜成片
        else:
            w, h = _ffprobe_size(clips[0])
            if not w or not h:
                raise RuntimeError("无法读取首镜画幅,合成中止")
            n = len(clips)
            with_audio = all(_ffprobe_has_audio(p) for p in clips)
            inputs = []
            for p in clips:
                inputs += ["-i", p.as_posix()]
            tts_inputs = []
            for s in shots:
                if s.get("tts") and (DRAMA_DIR / pid / s["tts"]).exists():
                    tts_inputs.append(s["id"])
                    inputs += ["-i", (DRAMA_DIR / pid / s["tts"]).as_posix()]
            chain = ""
            # tts 输入序号 = 1..n 视频之后的偏移(仅 when need_mix)
            tts_idx = {sid: n + 1 + i for i, sid in enumerate(tts_inputs)}
            for i, s in enumerate(shots):
                chain += (f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
                          f"setpts=PTS-STARTPTS[v{i}];")
                if need_mix:
                    vd = _ffprobe_duration(clips[i])
                    sid = s["id"]
                    if s.get("tts") and s["id"] in tts_idx:
                        ti = tts_idx[sid]
                        # 配音延迟 0.5s 起;按镜头时长裁剪(cover 整镜,不够则整段保留)
                        chain += (f"[{ti}:a]aformat=sample_rates=44100,apad,atrim=0:{max(vd, 0.6):.3f},"
                                  f"adelay=500|500,volume=1.6[vo{i}];")
                    else:
                        chain += f"anullsrc=r=44100:cl=stereo,atrim=0:{max(vd, 0.6):.3f}[vo{i}];"
                    if with_audio:
                        chain += (f"[{i}:a]aformat=sample_rates=44100:channel_layouts=stereo,"
                                  f"apad,atrim=0:{max(vd, 0.6):.3f},volume=1.0[wa{i}];")
                        chain += f"[wa{i}][vo{i}]amix=inputs=2:duration=first:dropout_transition=0[a{i}];"
                    else:
                        chain += f"[vo{i}]anull[a{i}];"
            if need_mix:
                graph = (chain + "".join(f"[v{i}][a{i}]" for i in range(n))
                         + f"concat=n={n}:v=1:a=1[v][a]")
                maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "160k"]
            elif with_audio:
                for i in range(n):
                    chain += f"[{i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a{i}];"
                graph = (chain + "".join(f"[v{i}][a{i}]" for i in range(n))
                         + f"concat=n={n}:v=1:a=1[v][a]")
                maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "160k"]
            else:
                graph = (chain + "".join(f"[v{i}]" for i in range(n))
                         + f"concat=n={n}:v=1:a=0[v]")
                maps = ["-map", "[v]"]
            burn_chain = ""
            if burn_subs:
                # 烧字幕:按 shots 顺序逐镜台词,起始时间按前面镜头时长累计
                t0 = 0.0
                srt_lines = []
                for i2, s2 in enumerate(shots):
                    lines2 = [l.strip() for l in (s2.get("lines") or "").splitlines() if l.strip()]
                    if lines2:
                        vd2 = _ffprobe_duration(clips[i2]) or 5
                        per = max(1.0, (vd2 - 0.5) / len(lines2))
                        for j2, line in enumerate(lines2):
                            who, _, say = line.partition(":")
                            say = (say or line).strip()
                            st_ = t0 + 0.5 + j2 * per
                            srt_lines.append("%d\n%s --> %s\n%s\n" % (
                                len(srt_lines) + 1,
                                _srt_ts(st_), _srt_ts(min(st_ + per - 0.1, t0 + vd2)),
                                (who.strip() + ":" + say).strip()))
                    t0 += _ffprobe_duration(clips[i2]) or 5
                if srt_lines:
                    srt = proj_dir / "subs.srt"
                    srt.write_text("\n".join(srt_lines), encoding="utf-8")
                    fi = n + len(tts_inputs)
                    inputs += ["-i", srt.as_posix()]
                    srt_esc = srt.resolve().as_posix().replace(":", r"\:").replace("'", r"\'")
                    burn_chain = f"[{fi}:v]subtitles='{srt_esc}'[vb];"
            # 字幕烧录:把 concat 输出标号从 [v] 改为 [vc],接 subtitles 滤镜后输出 [vout],
            # maps 里的 [v] 相应换成 [vout](音频图不动)
            burn_chain = ""
            if burn_subs:
                t0 = 0.0
                srt_lines = []
                for i2, s2 in enumerate(shots):
                    lines2 = [l.strip() for l in (s2.get("lines") or "").splitlines() if l.strip()]
                    if lines2:
                        vd2 = _ffprobe_duration(clips[i2]) or 5
                        per = max(1.0, (vd2 - 0.5) / len(lines2))
                        for j2, line in enumerate(lines2):
                            who, _, say = line.partition(":")
                            say = (say or line).strip()
                            st_ = t0 + 0.5 + j2 * per
                            srt_lines.append("%d\n%s --> %s\n%s\n" % (
                                len(srt_lines) + 1,
                                _srt_ts(st_), _srt_ts(min(st_ + per - 0.1, t0 + vd2)),
                                (who.strip() + ":" + say).strip()))
                    t0 += _ffprobe_duration(clips[i2]) or 5
                if srt_lines:
                    srt = proj_dir / "subs.srt"
                    srt.write_text("\n".join(srt_lines), encoding="utf-8")
                    fi = n + len(tts_inputs)
                    inputs += ["-i", srt.as_posix()]
                    srt_esc = srt.resolve().as_posix().replace(":", r"\:").replace("'", r"\'")
                    burn_chain = f"[{fi}:v]subtitles='{srt_esc}'[vout];"
            if burn_chain:
                # concat 的视频输出标号 [v] 改名 [vc],接字幕滤镜输出 [vout];音频 [a] 不动
                if "[v][a]" in graph:
                    graph = graph.replace("[v][a]", "[vc][a]", 1)
                else:
                    graph = graph[:-3] + "[vc]"       # a=0[v] 纯视频
                graph += ";" + burn_chain
                maps = [m if m != "[v]" else "[vout]" for m in maps]
            cmd = (["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + inputs
                   + ["-filter_complex", graph] + maps
                   + ["-c:v", "libx264", "-crf", "20", "-preset", "medium", out.as_posix()])
            try:
                r = subprocess.run(cmd, timeout=900, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            except subprocess.TimeoutExpired:
                raise RuntimeError("ffmpeg 重编码合成超时")
            if r.returncode != 0 or not out.exists() or out.stat().st_size < 1000:
                err = (r.stderr if r else b"").decode("utf-8", "replace")[-300:]
                raise RuntimeError("ffmpeg 重编码合成失败" + (f":{err}" if err else ""))
        if expect > 0 and abs(_ffprobe_duration(out) - expect) >= 0.8:
            raise RuntimeError("合成结果时长异常,请检查各镜成片是否可播")
    return _drama_mutate(pid, lambda d: d.__setitem__("composed", "composed.mp4"))


def _srt_ts(sec):
    """秒 → SRT 时间戳 00:00:00,000。"""
    ms = int(round(sec * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, genmjs=None, **kwargs):
        self.genmjs = genmjs or DEFAULT_GENMJS
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- 静态白名单 ----------
    # SimpleHTTPRequestHandler 默认会:列出目录内容、托管文件系统里的一切(源码/.git/genwork/)。
    # 这里重写 send_head:仅放行 *.html / *.css / *.js(带路径穿越兜底),其余一律 404。
    _STATIC_SUFFIXES = (".html", ".css", ".js")
    _STATIC_RE = re.compile(r"^(?:[A-Za-z0-9_\-]+/)?[A-Za-z0-9_\-]+\.(?:html|css|js)$")

    def send_head(self):
        path = urllib.parse.urlparse(self.path).path
        name = urllib.parse.unquote(path)
        name = name.replace("\\", "/").lstrip("/")
        if name == "":
            name = "index.html"  # 站点根
        if (not self._STATIC_RE.fullmatch(name)
                or not name.lower().endswith(self._STATIC_SUFFIXES)
                or ".." in name.split("/")):
            self.send_error(404, "File not found")
            return None
        self.path = "/" + name
        return super().send_head()

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
    def _bearer(self):
        auth = self.headers.get("Authorization") or ""
        return auth[7:].strip() if auth.lower().startswith("bearer ") else ""

    def _client_ip(self):
        return _xff_client_ip(self.headers,
                              self.client_address[0] if self.client_address else "unknown")

    def _gen_err(self, e, record_failure=False):
        """GenError → HTTP 响应;错码时记失败次数并附剩余尝试次数。"""
        if isinstance(e, GenError):
            if record_failure and e.code == "unauthorized":
                ip = self._client_ip()
                _gen_fail(ip)
                status, pub = _gen_error_status(e.code)
                self._json({"error": pub, "attemptsRemaining": _gen_attempts_left(ip)}, status)
                return
            status, pub = _gen_error_status(e.code)
            extra = {"upstreamCode": e.upstream_code, "requestId": e.request_id} if e.upstream_code else {}
            self._json({"error": pub, **extra}, status)
            return
        self._json({"error": "image_generation_unavailable"}, 503)

    def _gen_guard(self, ip):
        if _gen_locked(ip):
            self._json({"error": "invite_locked"}, 403)
            return True
        return False

    def _gen_gate(self, record_failure=False):
        """/api/gen/* 的邀请码门禁:与生图工作台同一把码;未通过时写好错误响应并返回 True。
        错码是否记失败由调用方定(start 是用户输码入口要记;status/video 是轮询不记)。"""
        ip = self._client_ip()
        if _gen_locked(ip):
            self._json({"ok": False, "error": "invite_locked"}, 403)
            return True
        try:
            _gen_authorize(self._bearer(), ip)
        except GenError as e:
            if e.code == "unauthorized":
                if record_failure:
                    _gen_fail(ip)
                self._json({"ok": False, "error": "invalid_invite_code",
                            "attemptsRemaining": _gen_attempts_left(ip)}, 401)
            elif e.code == "upstream_unavailable":
                # 未设邀请码且来源非本机:拒绝且不计失败(与生图工作台语义一致)
                self._json({"ok": False, "error": "upstream_unavailable"}, 503)
            else:
                status, pub = _gen_error_status(e.code)
                self._json({"ok": False, "error": pub}, status)
            return True
        return False

    # ---------- 短剧工作台 ----------
    def _drama_route(self):
        """/api/drama/*:与生图工作台同一把邀请码门禁(本机免码直进);错码不计失败——码在进页时已验。"""
        if self._gen_gate():
            return
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        try:
            if path == "/api/drama/projects":
                self._json({"ok": True, "project": _drama_create(self._read_json())})
                return
            m = re.fullmatch(r"/api/drama/projects/([a-f0-9]{12})/(.+)", path)
            if not m:
                self._json({"ok": False, "error": "unknown endpoint"}, 404)
                return
            pid, sub = m.group(1), m.group(2)
            if sub == "delete":
                _drama_delete(pid)
                self._json({"ok": True})
                return
            if sub == "compose":
                # burn_subs=1 时烧录字幕(有台词的镜头);TTS 配音有就自动混
                self._json({"ok": True, "project": _drama_compose(pid, burn_subs=True)})
                return
            params = self._read_json()
            if sub == "update":
                self._json({"ok": True, "project": _drama_project_update(pid, params)})
            elif sub == "storyboard":
                # 分镜 LLM 走提示词优化那条独立宽松额度(ip+":opt"),不占生图额度
                ip = self._client_ip()
                if not _gen_quota_allow(ip + ":opt", "image", 0):
                    raise GenError("rate_limit")
                self._json({"ok": True, "project": _drama_storyboard(pid, params)[0]})
            elif sub == "asset":
                self._json({"ok": True, "project": _drama_asset_store(pid, params)})
            elif sub == "shots/add":
                self._json({"ok": True, "project": _drama_shot_add(pid, params)})
            elif sub == "shots/reorder":
                self._json({"ok": True, "project": _drama_shot_reorder(pid, params)})
            elif sub == "chars/add":
                self._json({"ok": True, "project": _drama_char_add(pid, params)})
            elif sub.startswith("shots/") or sub.startswith("chars/"):
                m2 = re.fullmatch(r"(shots|chars)/([a-f0-9]{12})/(update|delete|refs/add|refs/delete|tts)", sub)
                if not m2:
                    self._json({"ok": False, "error": "unknown endpoint"}, 404)
                    return
                kind, item_id, action = m2.group(1), m2.group(2), m2.group(3)
                if kind == "shots":
                    if action == "tts":
                        project = _drama_shot_tts(pid, item_id)
                    else:
                        project = (_drama_shot_update(pid, item_id, params) if action == "update"
                                   else _drama_shot_delete(pid, item_id))
                elif action == "refs/add":
                    project = _drama_char_refs_add(pid, item_id, params)
                elif action == "refs/delete":
                    project = _drama_char_refs_delete(pid, item_id, params)
                else:
                    project = (_drama_char_update(pid, item_id, params) if action == "update"
                               else _drama_char_delete(pid, item_id))
                self._json({"ok": True, "project": project})
            else:
                self._json({"ok": False, "error": "unknown endpoint"}, 404)
        except GenError as e:
            self._gen_err(e)
        except Exception as e:
            self._json({"ok": False, "error": _pub_err(e)}, 400)

    def do_POST(self):
        if self.path.rstrip("/") == "/api/sam/segment":
            if self._gen_gate():
                return
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
                self._json({"ok": False, "error": _pub_err(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/matting/auto":
            if self._gen_gate():
                return
            try:
                params = self._read_json()
                data_url = params.get("image") or ""
                if "," in data_url:
                    _, _, b64 = data_url.partition(",")
                else:
                    b64 = data_url
                if len(b64) < 100:
                    raise RuntimeError("图片数据为空")
                model = params.get("model") or "ben2"
                r = _mat_auto(b64, model)
                self._json({"ok": True, "image": "data:image/png;base64," + r["rgba_b64"],
                            "model": model, "width": r.get("width"), "height": r.get("height"),
                            "edgePx": r.get("edge_px"), "seconds": r.get("seconds")})
            except Exception as e:
                self._json({"ok": False, "error": _pub_err(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/compress/tinypng":
            if self._gen_gate():
                return
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
                self._json({"ok": False, "error": _pub_err(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/compress/oxipng":
            if self._gen_gate():
                return
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
                out, note = _oxipng_compress(raw)
                b64out = _b64.b64encode(out).decode()
                self._json({"ok": True, "image": "data:image/png;base64," + b64out,
                            "inputBytes": len(raw), "outputBytes": len(out), "note": note})
            except Exception as e:
                self._json({"ok": False, "error": _pub_err(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/gen/start":
            if self._gen_gate(record_failure=True):
                return
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
                self._json({"ok": False, "error": _pub_err(e)}, 400)
            return
        if self.path.rstrip("/") == "/api/studio/optimize":
            # 提示词优化:锁定→鉴权(错码计失败)→独立宽松限额
            ip = self._client_ip()
            try:
                if _gen_locked(ip):
                    raise GenError("invite_locked")
                try:
                    _gen_authorize(self._bearer(), self._client_ip())
                except GenError as e:
                    if e.code == "unauthorized":
                        _gen_fail(ip)
                        raise
                if not _gen_quota_allow(ip + ":opt", "image", 0):
                    raise GenError("rate_limit")
                params = self._read_json()
                prompt = params.get("prompt") if isinstance(params.get("prompt"), str) else ""
                kind = "video" if params.get("kind") == "video" else "image"
                optimized = _gen_optimize(prompt, kind, params.get("hasFirstFrame") is True, params.get("hasRefs") is True)
                self._json({"prompt": optimized})
            except GenError as e:
                self._gen_err(e, record_failure=False)  # 失败已在上面对错码记过
            except Exception:
                self._json({"error": "image_generation_unavailable"}, 503)
            return
        if self.path.rstrip("/") == "/api/studio/tasks":
            # 先鉴权再读体:未持码者不该能免费消耗 64MB 读入(内存 DoS 面)
            if self._gen_gate(record_failure=True):
                return
            ip = self._client_ip()
            try:
                params = self._read_json()
                snapshot = _gen_submit(params, ip, self._bearer())
                self._json(snapshot, 202)
            except GenError as e:
                self._gen_err(e, record_failure=True)
            except Exception:
                self._json({"error": "image_generation_unavailable"}, 503)
            return
        m = re.fullmatch(r"/api/studio/tasks/([a-f0-9]{32})/(cancel|rerun)", self.path.rstrip("/"))
        if m:
            task_id, action = m.group(1), m.group(2)
            ip = self._client_ip()
            try:
                if _gen_locked(ip):
                    raise GenError("invite_locked")
                _gen_authorize(self._bearer(), ip)
                if action == "cancel":
                    self._json(_gen_task_cancel(task_id))
                else:
                    new_snapshot = _gen_task_rerun(task_id, ip, self._bearer())
                    self._json(new_snapshot, 202)
            except GenError as e:
                self._gen_err(e)
            except Exception:
                self._json({"error": "image_generation_unavailable"}, 503)
            return
        if self.path.rstrip("/") == "/api/drama/brainstorm":
            ip = self._client_ip()
            try:
                if _gen_locked(ip):
                    raise GenError("invite_locked")
                try:
                    _gen_authorize(self._bearer(), ip)
                except GenError as e:
                    if e.code == "unauthorized":
                        _gen_fail(ip)
                        raise
                if not _gen_quota_allow(ip + ":opt", "image", 0):
                    raise GenError("rate_limit")
                params = self._read_json()
                self._json({"ok": True, "ideas": _drama_brainstorm(params)})
            except GenError as e:
                self._gen_err(e, record_failure=False)
            except Exception:
                self._json({"ok": False, "error": "image_generation_unavailable"}, 503)
            return
        if self.path.startswith("/api/drama/"):
            self._drama_route()
            return
        self._json({"ok": False, "error": "unknown endpoint"}, 404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/drama/meta":
            if self._gen_gate():
                return
            import random
            self._json({"ok": True,
                        "styles": DRAMA_STYLES,
                        "ideas": random.sample(DRAMA_IDEAS, min(3, len(DRAMA_IDEAS))),
                        "linesIdeas": random.sample(DRAMA_LINES_IDEAS, min(4, len(DRAMA_LINES_IDEAS))),
                        "voices": DRAMA_VOICES})
            return
        if parsed.path == "/api/studio/models":
            # 模型目录:已设邀请码时仅对持码者返回清单;无码只回 inviteRequired(探测不计失败)。
            # 免码本机模式(inviteRequired=false)返回完整目录。模型单价标签不再公网裸奔。
            ip = self._client_ip()
            if not GEN_STUDIO["invite_code"]:
                try:
                    _gen_authorize("", ip)
                except GenError:
                    self._json({"inviteRequired": True})
                    return
            elif self._bearer() != GEN_STUDIO["invite_code"]:
                self._json({"inviteRequired": True})
                return
            self._json({"inviteRequired": bool(GEN_STUDIO["invite_code"]),
                        "models": [dict({"id": m["id"], "kind": m["kind"], "label": m["label"],
                                         "fit": m.get("fit", "")},
                                        **({"durations": m["durations"]} if m.get("durations") else {}))
                                   for m in GEN_STUDIO["models"]]})
            return
        if parsed.path == "/api/studio/quota":
            # 剩余额度 + 邀请码门禁校验:门禁页的验证入口;错码记失败
            ip = self._client_ip()
            try:
                if _gen_locked(ip):
                    raise GenError("invite_locked")
                _gen_authorize(self._bearer(), ip)  # 免码模式下公网来源也要拦(quota 只剩额度数字,也不该外泄)
                self._json(_gen_quota_peek(ip))
            except GenError as e:
                if e.code == "unauthorized":
                    _gen_fail(ip)  # 错码计失败(输码入口语义,勿丢)
                    self._json({"error": "invalid_invite_code",
                                "attemptsRemaining": _gen_attempts_left(ip)}, 401)
                else:
                    self._gen_err(e)
            except Exception:
                self._json({"error": "image_generation_unavailable"}, 503)
            return
        if parsed.path == "/api/studio/tasks":
            # 任务快照(旧→新,最多 GEN_LIST_MAX 条):页面刷新后恢复列表;含进行中与已完成的
            ip = self._client_ip()
            try:
                if _gen_locked(ip):
                    raise GenError("invite_locked")
                _gen_authorize(self._bearer(), self._client_ip())
                self._json({"tasks": _gen_task_list()})
            except GenError as e:
                self._gen_err(e)
            except Exception:
                self._json({"error": "image_generation_unavailable"}, 503)
            return
        m = re.fullmatch(r"/api/studio/file/([a-f0-9]{32})/(\d+)", parsed.path)
        if m:
            # 结果文件直链:预览/下载用真实 URL(手机长按可存);id 为 32 位 uuid 不可猜,不设鉴权
            try:
                path, mime = _gen_task_file(m.group(1), int(m.group(2)))
                data = path.read_bytes()
            except GenError as e:
                self._gen_err(e)
                return
            except Exception:
                self._json({"error": "task_not_found"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parsed.path.startswith("/api/studio/tasks/"):
            task_id = parsed.path[len("/api/studio/tasks/"):]
            ip = self._client_ip()
            try:
                if _gen_locked(ip):
                    raise GenError("invite_locked")
                _gen_authorize(self._bearer(), self._client_ip())
                _gen_task_touch(task_id)  # 结果被再次查看时续 TTL
                snapshot = _gen_task_get(task_id)
                if not snapshot:
                    self._json({"error": "task_not_found"}, 404)
                    return
                self._json(snapshot)
            except GenError as e:
                self._gen_err(e, record_failure=True)
            except Exception:
                self._json({"error": "image_generation_unavailable"}, 503)
            return
        if parsed.path == "/api/gen/status":
            if self._gen_gate():
                return
            q = self._q()
            job = _JOBS.get(q.get("job", ""))
            if not job:
                self._json({"ok": False, "error": "job 不存在"}, 404)
                return
            self._json({"ok": True, **_job_status(job)})
            return
        if parsed.path == "/api/gen/video":
            if self._gen_gate():
                return
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
        if parsed.path == "/api/drama/projects":
            if self._gen_gate():
                return
            self._json({"ok": True, "projects": _drama_list()})
            return
        m = re.fullmatch(r"/api/drama/projects/([a-f0-9]{12})/asset/(.+)", parsed.path)
        if m:
            if self._gen_gate():
                return
            name = urllib.parse.unquote(m.group(2))
            if not DRAMA_REL_RE.fullmatch(name):
                self._json({"ok": False, "error": "素材路径不合法"}, 400)
                return
            f = DRAMA_DIR / m.group(1) / name
            if not f.is_file():
                self._json({"ok": False, "error": "素材不存在"}, 404)
                return
            ctype = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                     "webp": "image/webp", "mp4": "video/mp4"}[f.suffix.lstrip(".")]
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        m = re.fullmatch(r"/api/drama/projects/([a-f0-9]{12})", parsed.path)
        if m:
            if self._gen_gate():
                return
            try:
                self._json({"ok": True, "project": _drama_read(m.group(1))})
            except Exception:
                self._json({"ok": False, "error": "项目不存在"}, 404)
            return
        return super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址;公网部署用 0.0.0.0(建议前置 nginx,且务必设 GEN_INVITE_CODE)")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--genmjs", default=None,
                        help="miniapp-kit/anim/gen.mjs 路径(默认同级 ../miniapp-kit,或环境变量 FRAMEFLOW_GENMJS)")
    args = parser.parse_args()
    genmjs = _genmjs_path(args.genmjs)
    _gen_studio_init()
    _gen_restore_tasks()          # 磁盘历史恢复进内存(重启前的 running 标记为中断)
    _gen_cleanup_expired_files()  # 清掉超过保留期的结果目录

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True

    def factory(*handler_args):
        return NoCacheHandler(*handler_args, genmjs=str(genmjs))

    server = Server((args.host, args.port), factory)
    url = f"http://{args.host}:{args.port}/"
    print(f"FrameFlow 已启动: {url}")
    print(f"生成结果目录: {GEN_STUDIO_DIR}(环境变量 FRAMEFLOW_GENWORK_DIR 可改;保留 {GEN_STUDIO_RETENTION_DAYS:g} 天)")
    print(f"生视频引擎: {genmjs}({'✓ 存在' if genmjs.exists() else '✗ 未找到,生视频功能不可用,其余功能正常'})")
    if GEN_STUDIO["invite_code"]:
        gen_state = "✓ 已开放(gen.html + spine.html,邀请码门禁)"
    elif GEN_STUDIO["upstream_key"]:
        gen_state = "✓ 已开放:本机免码直进(gen.html/spine.html);公网/局域网部署务必设 GEN_INVITE_CODE"
    else:
        gen_state = "✗ 未开放:缺上游 key(CODEX_API_KEY / APIROUTER_KEY / miniapp-kit/.env)"
    print(f"生图工作台: {gen_state}")
    ff = shutil.which("ffmpeg")
    print(f"短剧工作台: genwork/drama/ 项目落盘;合成依赖 ffmpeg({'✓ ' + ff if ff else '✗ 未找到,无法合成'})")
    ox = _oxipng_path()
    print(f"本地无损优化: {ox if ox else ''}{'✓' if ox else '✗ 未找到 oxipng,「本地无损压缩」退回浏览器编码'}")
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
