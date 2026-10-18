# 动图装配:motion.mp4 → 10fps 拆帧 → BEN2 逐帧抠图 → 循环点检测 → 透明 WebP 循环 → js 资产
# 循环检测:首帧与后段各帧在 alpha>128 区内做 RGB 平均差,选差最小的切点;
# 差仍大(动作没收回到初始态)就 pingpong(正放+倒放)保无缝。
# 用法: python tools/duoli_motion_build.py
import base64
import io
import json
import os
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "genwork" / "duoli_motion" / "motion.mp4"
FRAMES_DIR = ROOT / "genwork" / "duoli_motion" / "frames"
OUT_DIR = ROOT / "genwork" / "duoli_motion"
FPS = 10
OUT_H = 300          # 资产高度(显示 132px 的 2.3x,retina 充足)


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
    """BEN2 worker 会话:ping 一次,逐帧 matte。返回 [RGBA Image]。"""
    py = _py_matting()
    proc = subprocess.Popen([py, str(ROOT / "matting_worker.py")], cwd=str(ROOT),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            text=True, encoding="utf-8", errors="replace")
    out = []
    try:
        proc.stdin.write(json.dumps({"cmd": "ping"}) + "\n")
        proc.stdin.flush()
        if not json.loads(proc.stdout.readline()).get("ok"):
            raise RuntimeError("worker 握手失败")
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
            if not r.get("ok"):
                raise RuntimeError(f"{p.name}: {r.get('error')}")
            out.append(Image.open(io.BytesIO(base64.b64decode(r["rgba_b64"]))))
            print(f"  matte {p.name}")
    finally:
        try:
            proc.kill()
        except Exception:
            pass
    return out


def seam_diff(a, b):
    """两帧在共同不透明区的 RGB 平均差(0~255,缩到 64px 抗噪)。"""
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


def main():
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    for old in FRAMES_DIR.glob("f*.png"):
        old.unlink()
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(SRC), "-vf", f"fps={FPS}", str(FRAMES_DIR / "f%02d.png")],
                   check=True, timeout=120)
    paths = sorted(FRAMES_DIR.glob("f*.png"))
    print(f"拆帧: {len(paths)} 张 @ {FPS}fps")

    frames = matte_all(paths)
    # 全部统一到 1024² 画布(与逐帧输出尺寸一致;resize 到资产高前先统一)
    frames = [f.resize((1024, 1024), Image.LANCZOS) if f.size != (1024, 1024) else f for f in frames]

    # 循环点:找与首帧最像的尾段帧
    f0 = frames[0]
    best_i, best_d = len(frames) - 1, 1e9
    for i in range(max(1, len(frames) - 8), len(frames)):
        d = seam_diff(f0, frames[i])
        print(f"  seam f0~f{i}: {d:.1f}")
        if d < best_d:
            best_d, best_i = d, i
    seq = frames[:best_i + 1]
    mode = "direct"
    if best_d > 20 and len(seq) >= 6:  # 收不回来 → pingpong
        seq = seq + seq[-2:0:-1]
        mode = "pingpong"
    print(f"循环: {len(seq)} 帧, 模式 {mode}, 接缝差 {best_d:.1f}")

    # 缩放到资产高
    scaled = []
    for f in seq:
        w = round(f.size[0] * OUT_H / f.size[1])
        scaled.append(f.resize((w, OUT_H), Image.LANCZOS))
    cw = max(f.size[0] for f in scaled)
    canvas_frames = [Image.new("RGBA", (cw, OUT_H), (0, 0, 0, 0)) for _ in scaled]
    for c, f in zip(canvas_frames, scaled):
        c.alpha_composite(f, ((cw - f.size[0]) // 2, 0))

    webp = OUT_DIR / "duoli_idle.webp"
    canvas_frames[0].save(webp, save_all=True, append_images=canvas_frames[1:],
                          duration=1000 // FPS, loop=0, format="WEBP",
                          quality=82, method=4)
    print(f"webp: {webp.name} {webp.stat().st_size // 1024}KB ({cw}x{OUT_H} x{len(canvas_frames)}帧)")

    # 深色底预览 GIF
    prev = []
    for f in canvas_frames[::2]:
        bg = Image.new("RGBA", f.size, (19, 20, 23, 255))
        bg.alpha_composite(f)
        prev.append(bg.convert("RGB"))
    gif = OUT_DIR / "idle_preview.gif"
    prev[0].save(gif, save_all=True, append_images=prev[1:], duration=200, loop=0, disposal=2)
    print("preview:", gif.name)

    js = ROOT / "js" / "duoli_video.js"
    buf = io.BytesIO()
    buf.write(webp.read_bytes())
    js.write_text(
        f'// 小多利连续动画(可灵3s视频→拆帧→BEN2抠图→无缝{mode}循环) — tools/duoli_motion_build.py 生成\n'
        f'window.DUOLI_VIDEO = {{ "src": "data:image/webp;base64,{base64.b64encode(buf.getvalue()).decode("ascii")}",'
        f' "w": {cw}, "h": {OUT_H}, "frames": {len(canvas_frames)}, "fps": {FPS}, "loop": "{mode}" }};\n',
        encoding="utf-8")
    print(f"js/duoli_video.js {js.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
