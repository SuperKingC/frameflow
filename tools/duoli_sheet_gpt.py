# 终版 sprite sheet:genwork/duoli_final/gpt_*.png(5帧)→ BEN2 抠图 → 对齐拼横排 → js 资产 + 预览 GIF
# 用法: python tools/duoli_sheet_gpt.py
import base64
import io
import json
import os
import subprocess
import threading
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "genwork" / "duoli_final"
OUT_JS = ROOT / "js"
SHEET_H = 300
NAMES = ["idle", "blink", "tilt", "tongue", "paw"]


def _py_matting():
    v = os.environ.get("PYTHON_MATTING", "")
    if v:
        return v
    env = ROOT.parent / "miniapp-kit" / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("PYTHON_MATTING="):
            return line.partition("=")[2].strip().strip('"').strip("'")
    raise RuntimeError("未设 PYTHON_MATTING")


def ben2_matte(png_bytes: bytes) -> bytes:
    py = _py_matting()
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


def main():
    frames = []
    for n in NAMES:
        p = SRC_DIR / f"gpt_{n}.png"
        rgba = Image.open(io.BytesIO(ben2_matte(p.read_bytes())))
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
    out = SRC_DIR / "gpt_sheet.png"
    sheet.save(out, optimize=True)
    print(f"sheet: {out.name} {sheet.size[0]}x{sheet.size[1]} {out.stat().st_size // 1024}KB")

    # 预览 GIF:idle/blink/tilt/tongue/paw 轮播
    seq = [cells[0], cells[1], cells[0], cells[2], cells[3], cells[0], cells[4], cells[0]]
    gif = SRC_DIR / "gpt_preview.gif"
    seq[0].save(gif, save_all=True, append_images=seq[1:], duration=560, loop=0, disposal=2)

    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    js = OUT_JS / "duoli_frames_gpt.js"
    js.write_text(
        f'// 小多利终版 sprite sheet(GPT-5.4 立绘,BEN2 抠图) — tools/duoli_sheet_gpt.py 生成;5帧横排,单帧高 {SHEET_H}\n'
        f'// 帧序: 0=idle 1=blink 2=tilt 3=tongue 4=paw\n'
        f'window.DUOLI_SHEET_GPT = {{ "src": "data:image/png;base64,{base64.b64encode(buf.getvalue()).decode("ascii")}",'
        f' "frames": {len(cells)}, "w": {cw}, "h": {ch} }};\n', encoding="utf-8")
    print(f"js: {js.name} {js.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
