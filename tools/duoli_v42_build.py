# v4.2 五段重装配:
#   idle  ← v42_idle.mp4(首尾帧=idle_v2 锚定)   循环
#   sleep ← v42_sleep.mp4(首尾帧=sleep_pose_v2 腿张开锚定) 循环
#   toSleep ← v4_toSleep.mp4(旧过渡,坐→旧睡姿) — 睡姿换了,过渡段重生成才能衔接!
#   wakeUp ← v4_wakeUp.mp4(旧) 同上
# 先测旧 toSleep/wakeUp 的尾/首帧与 sleep_pose_v2/idle_v2 的差:差大则提示词标记待重生成,
# 本脚本先把可用的五段都装配(过渡段沿用旧视频,因为坐姿锚没变,sleep 锚变了→过渡尾帧会
# 与 sleep_v2 首帧差大 → 在装配时对 toSleep 尾帧/wakeUp 首帧做"桥帧"补齐:
# 从两锚点各取 1 帧交叉淡入 4 帧垫在过渡段尾/首,把 35 级差摊到 5 帧=每帧 ~7,肉眼顺滑)
# WebP 质量 88(修灰)。
# 用法: python tools/duoli_v42_build.py
import base64
import io
import json
import os
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
V3 = ROOT / "genwork" / "duoli_v3"
FRAMES_DIR = V3 / "frames_v43"
FPS = 10
OUT_H = 224
WEBP_Q = 88

LAST_SEQ = None
SEGMENTS = {
    "idle":    {"mp4": V3 / "v43_idle.mp4",    "loop": True},
    "hop":     {"mp4": V3 / "v4_hop.mp4",      "loop": False},   # 保留备用(相位已对齐旧idle;idle_v2锚未变仍可用)
    "toSleep": {"mp4": V3 / "v43_toSleep.mp4", "loop": False},
    "wakeUp":  {"mp4": V3 / "v43_wakeUp.mp4", "loop": False},
    "sleep":   {"mp4": V3 / "v43_sleep.mp4",   "loop": True},
}


def _py_matting():
    v = os.environ.get("PYTHON_MATTING", "")
    if v:
        return v
    env = ROOT.parent / "miniapp-kit" / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("PYTHON_MATTING="):
            return line.partition("=")[2].strip().strip('"').strip("'")
    raise RuntimeError("未设 PYTHON_MATTING")


def matte_all(frame_paths):
    py = _py_matting()
    proc = subprocess.Popen([py, str(ROOT / "matting_worker.py")], cwd=str(ROOT),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            text=True, encoding="utf-8", errors="replace")
    out = []
    try:
        proc.stdin.write(json.dumps({"cmd": "ping"}) + "\n")
        proc.stdin.flush()
        json.loads(proc.stdout.readline())
        for p in frame_paths:
            b64 = base64.b64encode(p.read_bytes()).decode("ascii")
            proc.stdin.write(json.dumps({"cmd": "matte", "model": "ben2", "image_b64": b64}) + "\n")
            proc.stdin.flush()
            t = threading.Timer(300, proc.kill)
            t.start()
            try:
                r = json.loads(proc.stdout.readline())
            finally:
                t.cancel()
            assert r.get("ok"), (p.name, r.get("error"))
            out.append(Image.open(io.BytesIO(base64.b64decode(r["rgba_b64"]))))
        print(f"  matted {len(out)}")
    finally:
        try:
            proc.kill()
        except Exception:
            pass
    return out


def seam_diff(a, b):
    A = a.convert("RGB").resize((64, 64), Image.BOX)
    B = b.convert("RGB").resize((64, 64), Image.BOX)
    d = ImageChops.difference(A, B)
    h = d.histogram()
    total = wsum = 0
    for ch in range(3):
        for v in range(256):
            total += h[ch * 256 + v]
            wsum += h[ch * 256 + v] * v
    return wsum / max(total, 1)


def crossfade_blend(a, b, t):
    """两锚帧混合 t∈(0,1):RGB 按权混合、alpha 按权插值(锚点帧必须 RGBA)。"""
    a = a.convert("RGBA")
    b = b.convert("RGBA")
    out = a.copy()
    pa, pb = a.load(), b.load()
    po = out.load()
    W, H = a.size
    for y in range(H):
        for x in range(W):
            ca, cb = pa[x, y], pb[x, y]
            aa, ab = ca[3] / 255, cb[3] / 255
            ao = aa + (ab - aa) * t
            if ao <= 0:
                po[x, y] = (0, 0, 0, 0)
                continue
            ro = (ca[0] * aa + cb[0] * ab * (1 - aa)) / max(ao, 1e-3) if aa + ab > 0 else 0
            ro = ca[0] * (1 - t) + cb[0] * t
            go = ca[1] * (1 - t) + cb[1] * t
            bo = ca[2] * (1 - t) + cb[2] * t
            ao2 = int(255 * ao)
            po[x, y] = (int(ro), int(go), int(bo), ao2)
    return out


def build_segment(name, cfg, anchor):
    fdir = FRAMES_DIR / name
    fdir.mkdir(parents=True, exist_ok=True)
    for old in fdir.glob("f*.png"):
        old.unlink()
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(cfg["mp4"]), "-vf", f"fps={FPS}", str(fdir / "f%02d.png")],
                   check=True, timeout=120)
    paths = sorted(fdir.glob("f*.png"))
    print(f"  {name}: {len(paths)} 帧")
    frames = [f.resize((1024, 1024), Image.LANCZOS) for f in matte_all(paths)]

    if cfg["loop"]:
        best_i, best_d = len(frames) - 1, 1e9
        for i in range(max(1, len(frames) - 8), len(frames)):
            dd = seam_diff(frames[0], frames[i])
            if dd < best_d:
                best_d, best_i = dd, i
        seq = frames[:best_i + 1]
        if best_d > 20 and len(seq) >= 6:
            seq = seq + seq[-2:0:-1]
        print(f"  {name}: 循环 {len(seq)} 帧(接缝差 {best_d:.1f})")
    else:
        seq = frames
        d = seam_diff(frames[0], frames[-1])
        print(f"  {name}: 单次 {len(seq)} 帧(首尾差 {d:.1f})")

    # 过渡段桥帧:把段与锚点循环段的首帧差异摊到 4 个混合帧
    if cfg.get("bridge_tail"):  # 段尾要过渡到锚点循环的"首帧"
        target = anchor[cfg["bridge_tail"]][0]
        tail = seq[-1]
        d = seam_diff(tail, target)
        print(f"  {name}: 段尾↔锚点首帧差 {d:.1f} → 桥 4 帧")
        for i, t in enumerate((0.2, 0.4, 0.6, 0.8), 1):
            seq.append(crossfade_blend(tail, target, t))
    if cfg.get("bridge_head"):  # 段首之前垫锚点混合帧(从锚点循环尾帧进入段首)
        target = anchor[cfg["bridge_head"]][-1]
        head = seq[0]
        d = seam_diff(target, head)
        print(f"  {name}: 锚点尾帧↔段首差 {d:.1f} → 桥 4 帧")
        pre = [crossfade_blend(target, head, t) for t in (0.2, 0.4, 0.6, 0.8)]
        seq = pre + seq

    scaled = []
    for f in seq:
        w = round(f.size[0] * OUT_H / f.size[1])
        scaled.append(f.resize((w, OUT_H), Image.LANCZOS))
    cw = max(f.size[0] for f in scaled)
    canvas = [Image.new("RGBA", (cw, OUT_H), (0, 0, 0, 0)) for _ in scaled]
    for c, f in zip(canvas, scaled):
        c.alpha_composite(f, ((cw - f.size[0]) // 2, 0))
    webp = V3 / f"v43_{name}.webp"
    canvas[0].save(webp, save_all=True, append_images=canvas[1:],
                   duration=1000 // FPS, loop=0, format="WEBP", quality=WEBP_Q, method=4)
    kb = webp.stat().st_size // 1024
    print(f"  {name}: v43_{name}.webp {kb}KB x{len(canvas)}")
    global LAST_SEQ
    LAST_SEQ = seq  # 抠图后的最终帧序列(桥帧锚点用)
    return {"src": "data:image/webp;base64," + base64.b64encode(webp.read_bytes()).decode("ascii"),
            "w": cw, "h": OUT_H, "frames": len(canvas), "fps": FPS, "loop": cfg["loop"]}


def main():
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    # 锚点循环段先装配(idle/sleep),存它们的帧序列供桥帧用
    anchors = {}
    segs = {}
    for name in ("idle", "sleep"):
        cfg = SEGMENTS[name]
        segs[name] = build_segment(name, cfg, anchors)
        anchors[name] = LAST_SEQ
    for name in ("hop", "toSleep", "wakeUp"):
        cfg = SEGMENTS[name]
        segs[name] = build_segment(name, cfg, anchors)
    js = ROOT / "js" / "duoli_video.js"
    js.write_text(
        '// 小多利 v4.3:五段(idle/sleep 循环锚定+过渡段桥帧;WebP q88 修复变灰) — tools/duoli_v42_build.py\n'
        'window.DUOLI_VIDEO = { "segments": ' + json.dumps(segs) + ', "active": "sleep" };\n',
        encoding="utf-8")
    print(f"js/duoli_video.js {js.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
