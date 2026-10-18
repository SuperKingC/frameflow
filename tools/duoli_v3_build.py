# v3 三段装配:motion_{idle,hop,sleep}.mp4 → 拆帧 → BEN2 抠图 → 循环处理 → 多帧 WebP 合一资产
# idle: pingpong 循环;hop: 单次(首尾帧接近,直接循环也顺);sleep: pingpong 循环
# 输出: js/duoli_video.js  window.DUOLI_VIDEO = { segments: {idle, hop, sleep}, active: "idle" }
# 用法: python tools/duoli_v3_build.py
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
FRAMES_DIR = V3 / "frames"
FPS = 10
OUT_H = 224        # 资产高(显示 132 的 1.7x)
WEBP_Q = 74

SEGMENTS = {
    "idle":  {"mp4": V3 / "motion_idle.mp4",  "loop": True},
    "hop":   {"mp4": V3 / "motion_hop.mp4",   "loop": False},
    "sleep": {"mp4": V3 / "motion_sleep.mp4", "loop": True},
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
            print(f"  matte {p.name}")
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


def build_segment(name, cfg):
    out_frames = []
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
            d = seam_diff(frames[0], frames[i])
            if d < best_d:
                best_d, best_i = d, i
        seq = frames[:best_i + 1]
        if best_d > 20 and len(seq) >= 6:
            seq = seq + seq[-2:0:-1]
        print(f"  {name}: 循环 {len(seq)} 帧(接缝差 {best_d:.1f})")
    else:
        seq = frames
        print(f"  {name}: 单次 {len(seq)} 帧")

    scaled = []
    for f in seq:
        w = round(f.size[0] * OUT_H / f.size[1])
        scaled.append(f.resize((w, OUT_H), Image.LANCZOS))
    cw = max(f.size[0] for f in scaled)
    canvas = [Image.new("RGBA", (cw, OUT_H), (0, 0, 0, 0)) for _ in scaled]
    for c, f in zip(canvas, scaled):
        c.alpha_composite(f, ((cw - f.size[0]) // 2, 0))
    webp = V3 / f"seg_{name}.webp"
    canvas[0].save(webp, save_all=True, append_images=canvas[1:],
                   duration=1000 // FPS, loop=0, format="WEBP", quality=WEBP_Q, method=4)
    print(f"  {name}: {webp.name} {webp.stat().st_size // 1024}KB ({cw}x{OUT_H} x{len(canvas)})")
    return {"src": "data:image/webp;base64," + base64.b64encode(webp.read_bytes()).decode("ascii"),
            "w": cw, "h": OUT_H, "frames": len(canvas), "fps": FPS}


def main():
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    segs = {}
    for name, cfg in SEGMENTS.items():
        if not cfg["mp4"].exists():
            print(f"  跳过 {name}: 无 {cfg['mp4'].name}")
            continue
        segs[name] = build_segment(name, cfg)
    js = ROOT / "js" / "duoli_video.js"
    js.write_text(
        '// 小多利 v3 三段动画(idle/sleep 循环 + hop 单次;可灵视频→BEN2抠图→WebP) — tools/duoli_v3_build.py\n'
        'window.DUOLI_VIDEO = { "segments": ' + json.dumps(segs) + ', "active": "idle" };\n',
        encoding="utf-8")
    print(f"js/duoli_video.js {js.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
