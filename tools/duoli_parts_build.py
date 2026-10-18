# 终版分件装配:gpt_idle → BEN2 抠图 → SAM2 拆 upper(头+胸+前腿,SAM 天然分界)/ tail(独立摆) 
# 两件 + 底图残件(整狗减去 upper/tail 的部分,当 base 静态层,保证无镂空)
# 全部整幅尺寸(1024² 不裁),CSS 直接叠,免算偏移。
# 用法: python tools/duoli_parts_build.py
import base64
import io
import json
import os
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "genwork" / "duoli_final" / "gpt_idle.png"
OUT_DIR = ROOT / "genwork" / "duoli_parts"

PTS_UPPER = {"points": [[520, 240], [620, 160], [510, 640], [430, 780]], "labels": [1, 1, 1, 1],
             "neg": []}  # 头+胸+前腿一把抓(SAM 实测把头胸白前腿视为一体,顺势用它)
PTS_TAIL = {"points": [[255, 590], [300, 650]], "labels": [1, 1],
            "neg": [[480, 560], [400, 700]]}


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
    proc = subprocess.Popen([py, str(ROOT / "matting_worker.py")], cwd=str(ROOT),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, encoding="utf-8", errors="replace")
    try:
        proc.stdin.write(json.dumps({"cmd": "ping"}) + "\n")
        proc.stdin.flush()
        json.loads(proc.stdout.readline())
        proc.stdin.write(json.dumps({"cmd": "matte", "model": "ben2", "image_b64": b64}) + "\n")
        proc.stdin.flush()
        t = threading.Timer(300, proc.kill)
        t.start()
        try:
            r = json.loads(proc.stdout.readline())
        finally:
            t.cancel()
        assert r.get("ok"), r
        return base64.b64decode(r["rgba_b64"])
    finally:
        try:
            proc.kill()
        except Exception:
            pass


class SamWorker:
    def __init__(self):
        self.proc = subprocess.Popen([_py_matting(), str(ROOT / "sam_worker.py")], cwd=str(ROOT),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, encoding="utf-8", errors="replace")

    def ask(self, req, timeout_s):
        t = threading.Timer(timeout_s, self.proc.kill)
        t.start()
        try:
            self.proc.stdin.write(json.dumps(req) + "\n")
            self.proc.stdin.flush()
            return json.loads(self.proc.stdout.readline())
        finally:
            t.cancel()

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rgba = Image.open(io.BytesIO(ben2_matte(SRC.read_bytes())))
    W, H = rgba.size
    base_rgb = Image.open(SRC).convert("RGB")
    buf = io.BytesIO()
    base_rgb.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    w = SamWorker()
    assert w.ask({"cmd": "ping"}, 60).get("ok")
    assert w.ask({"cmd": "load_image", "image_b64": b64}, 180).get("ok")

    def seg(p, timeout_s=120):
        pts = p["points"] + p["neg"]
        labels = p["labels"] + [0] * len(p["neg"])
        r = w.ask({"cmd": "segment", "points": pts, "labels": labels}, timeout_s)
        assert r.get("ok"), r
        return Image.open(io.BytesIO(base64.b64decode(r["mask_b64"]))).convert("L").resize((W, H), Image.NEAREST)

    m_upper = seg(PTS_UPPER)
    m_tail = seg(PTS_TAIL)
    w.close()

    def masked(img, m):
        out = img.copy()
        out.putalpha(ImageChops.multiply(out.getchannel("A"), m))
        return out

    upper = masked(rgba, m_upper)
    tail = masked(rgba, m_tail)
    # base = 整狗 - upper - tail(残件:后躯、后腿、前腿根部被 upper 吃掉的部分)
    inv = ImageChops.invert(ImageChops.lighter(m_upper, m_tail))
    base = masked(rgba, inv)

    js_parts = []
    for name, part in (("base", base), ("upper", upper), ("tail", tail)):
        buf = io.BytesIO()
        part.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        js_parts.append((name, base64.b64encode(data).decode("ascii")))
        out = OUT_DIR / f"part_{name}.png"
        out.write_bytes(data)
        print(f"part_{name}.png {len(data) // 1024}KB")

    # 预览:深色底叠回
    canvas = Image.new("RGBA", (W, H), (19, 20, 23, 255))
    for name, _ in js_parts:
        canvas.alpha_composite(Image.open(OUT_DIR / f"part_{name}.png"))
    canvas.convert("RGB").save(OUT_DIR / "assembled_v2.png")
    print("preview assembled_v2.png")

    js = ROOT / "js" / "duoli_parts.js"
    js.write_text(
        "// 小多利分件(base/upper/tail,整幅1024²,BEN2+SAM2) — tools/duoli_parts_build.py 生成\n"
        + "".join(f'window.DUOLI_PART_{n.upper()} = "data:image/png;base64,{b}";\n' for n, b in js_parts),
        encoding="utf-8")
    print(f"js/duoli_parts.js {js.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
