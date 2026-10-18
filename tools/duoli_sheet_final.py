# 终版 sprite sheet 构建:
# - 02 水彩:BEN2 AI 抠图(matting_worker,软边适合水彩;泛洪会吃掉浅色毛发)
# - 03 皮克斯:色键泛洪(背景纯灰)+ 爪缝保护(清除深度骤停线)+ 底条裁切
# 用法: python tools/duoli_sheet_final.py 02|03|both
import base64
import io
import json
import os
import subprocess
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "genwork" / "duoli_frames"
OUT_JS = ROOT / "js"
SHEET_H = 300
MATTING_PY = os.environ.get("PYTHON_MATTING", "")


def ben2_matte(png_bytes: bytes) -> bytes:
    """调 BEN2 worker 抠图(matting_worker.py 常驻协议)。返回 PNG bytes。"""
    py = MATTING_PY or _py_from_doctor()
    b64 = base64.b64encode(png_bytes).decode("ascii")
    proc = subprocess.Popen(
        [py, str(ROOT / "matting_worker.py")], cwd=str(ROOT),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", errors="replace")
    try:
        proc.stdin.write(json.dumps({"cmd": "ping"}) + "\n")
        proc.stdin.flush()
        if not json.loads(proc.stdout.readline()).get("ok"):
            raise RuntimeError("worker 握手失败")
        proc.stdin.write(json.dumps({"cmd": "matte", "model": "ben2", "image_b64": b64}) + "\n")
        proc.stdin.flush()
        timer_done = []

        import threading
        t = threading.Timer(300, proc.kill)
        t.start()
        try:
            r = json.loads(proc.stdout.readline())
        finally:
            t.cancel()
        if not r.get("ok"):
            raise RuntimeError(r.get("error", "抠图失败"))
        return base64.b64decode(r["rgba_b64"])
    finally:
        try:
            proc.kill()
        except Exception:
            pass


def _py_from_doctor():
    """miniapp-kit doctor 的 PYTHON_MATTING 路径(.env 里找)。"""
    env = ROOT.parent / "miniapp-kit" / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("PYTHON_MATTING="):
                return line.partition("=")[2].strip().strip('"').strip("'")
    raise RuntimeError("未设 PYTHON_MATTING,找不到带 torch 的 python")


def flood_bg_alpha(img):
    """03 用:边缘色泛洪 + 爪缝保护(清除深度骤停线以下的高密度清除行回滚)。"""
    rgba = img.convert("RGBA")
    W, H = rgba.size
    px = rgba.load()
    edge = []
    for x in range(0, W, 8):
        edge += [px[x, 0], px[x, H - 1]]
    for y in range(0, H, 8):
        edge += [px[0, y], px[W - 1, y]]

    def near_bg(c):
        return min(abs(c[0] - s[0]) + abs(c[1] - s[1]) + abs(c[2] - s[2]) for s in edge) < 60

    visited = bytearray(W * H)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if near_bg(px[x, y]) and not visited[y * W + x]:
                visited[y * W + x] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if near_bg(px[x, y]) and not visited[y * W + x]:
                visited[y * W + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and not visited[ny * W + nx] and near_bg(px[nx, ny]):
                visited[ny * W + nx] = 1
                q.append((nx, ny))
    rows = [sum(visited[y * W + x] for x in range(W)) / W for y in range(H)]
    safe_cut = None
    for y in range(H - 1, int(H * 0.5), -1):
        if rows[y] < 0.35:
            safe_cut = y
            break
    if safe_cut is not None:
        for y in range(safe_cut + 1, H):
            if rows[y] > 0.6:
                for x in range(W):
                    visited[y * W + x] = 0
    n = sum(visited)
    for y in range(H):
        for x in range(W):
            if visited[y * W + x]:
                px[x, y] = (0, 0, 0, 0)
    return rgba, n / (W * H)


def bottom_strip_cut(rgba):
    """底部背景横条:检测底部 12% 里整行都接近纯白/纯灰的横条并裁掉。"""
    W, H = rgba.size
    px = rgba.load()
    cut = 0
    for y in range(H - 1, int(H * 0.82), -1):
        vals = [px[x, y] for x in range(0, W, 4)]
        solid = sum(1 for c in vals if c[3] > 200 and min(c[0], c[1], c[2]) > 200) / len(vals)
        if solid > 0.92:
            cut = y
        else:
            break
    if cut:
        rgba = rgba.crop((0, 0, W, cut))
    return rgba


def build(prefix, cut_fn):
    names = ["idle", "blink", "tilt", "tongue", "tail2"]
    frames = []
    for n in names:
        p = SRC_DIR / f"{prefix}_{n}.png"
        rgba = cut_fn(p.read_bytes())
        bbox = rgba.getbbox()
        rgba = rgba.crop(bbox)
        frames.append(rgba)
        print(f"  {n}: {rgba.size[0]}x{rgba.size[1]}")
    cw = max(round(f.size[0] * SHEET_H / f.size[1]) for f in frames) + 6
    ch = SHEET_H + 4
    cells = []
    for f in frames:
        scale = SHEET_H / f.size[1]
        f2 = f.resize((max(1, round(f.size[0] * scale)), SHEET_H), Image.LANCZOS)
        cell = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        cell.paste(f2, ((cw - f2.size[0]) // 2, 2), f2)
        cells.append(cell)
    sheet = Image.new("RGBA", (cw * len(cells), ch), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        sheet.paste(c, (i * cw, 0))
    out = SRC_DIR / f"{prefix}_sheet.png"
    sheet.save(out, optimize=True)
    print(f"sheet: {out.name} {sheet.size[0]}x{sheet.size[1]} {out.stat().st_size // 1024}KB")
    seq = [cells[0], cells[1], cells[0], cells[3], cells[0], cells[2], cells[4]]
    gif = SRC_DIR / f"{prefix}_preview.gif"
    seq[0].save(gif, save_all=True, append_images=seq[1:], duration=520, loop=0, disposal=2)
    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    js = OUT_JS / f"duoli_frames_{prefix.split('_')[0]}.js"
    js.write_text(
        f'// 小多利 sprite sheet({prefix}) — tools/duoli_sheet_final.py 生成;5帧横排,单帧高 {SHEET_H}\n'
        f'window.DUOLI_SHEET_{prefix.split("_")[0]} = {{ "src": "data:image/png;base64,{base64.b64encode(buf.getvalue()).decode("ascii")}",'
        f' "frames": {len(cells)}, "w": {cw}, "h": {ch} }};\n', encoding="utf-8")
    print(f"js: {js.name} {js.stat().st_size // 1024}KB")


def main():
    which = sys.argv[1:] or ["both"]
    if "02" in which or "both" in which:
        print("== 02 水彩:BEN2 AI 抠图 ==")
        build("02_fluffy_watercolor", lambda b: Image.open(io.BytesIO(ben2_matte(b))))
    if "03" in which or "both" in which:
        print("== 03 皮克斯:泛洪+爪缝保护+底条裁切 ==")
        build("03_pixar_3d", lambda b: bottom_strip_cut(flood_bg_alpha(Image.open(io.BytesIO(b)))[0]))


if __name__ == "__main__":
    main()
