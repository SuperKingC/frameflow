# SAM2 拆件:gpt_idle.png(已 BEN2 抠图的透明底版更稳:先用 duoli_sheet_gpt 的 rgba 底)
# 输入:gpt_idle.png(1024²) → 先 BEN2 全图抠(去背景),再 SAM2 点选拆五件:
#   head(含双耳)/ tail / body(躯干+前腿+胸白) —— 耳朵不单独拆(半立耳贴着头,
#   单拆边界锯齿重,动画上耳随头动即可,后端给耳单独相位的小幅 skew 补偿)
# 件间遮挡:头压着胸白(SVG z 序 body 下 head 上,拆件按原图 z 序叠回即可)
# 用法: python tools/duoli_parts_sam.py
import base64
import io
import json
import os
import subprocess
import threading
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "genwork" / "duoli_final" / "gpt_idle.png"
OUT_DIR = ROOT / "genwork" / "duoli_parts"

# 1024x1024 上的点选坐标(看图定):
# 头:眉心(520,240) 负点:胸口白毛(500,560) 把头和身体分开
# 尾:尾根上翘段(250,600) 负点:身体(500,500)
# 身体:胸腹中心(510,620) 负点:头(520,250) 尾(260,610)
PARTS = {
    "head": {"points": [[520, 240], [620, 160]], "labels": [1, 1],
             "neg": [[500, 560], [430, 420]]},
    "tail": {"points": [[255, 590], [300, 650]], "labels": [1, 1],
             "neg": [[480, 560], [400, 700]]},
    "body": {"points": [[510, 640], [430, 780], [620, 760]], "labels": [1, 1, 1],
             "neg": [[520, 250], [260, 600]]},
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


class Worker:
    """SAM2 worker 会话:load_image 一次,多次 segment。"""

    def __init__(self):
        self.proc = subprocess.Popen(
            [_py_matting(), str(ROOT / "sam_worker.py")], cwd=str(ROOT),
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
    # 底图先 BEN2 抠(同 duoli_sheet_gpt 的管线;这里是单图,复用 worker 文件按次起停)
    from duoli_sheet_gpt import ben2_matte
    rgba_full = Image.open(io.BytesIO(ben2_matte(SRC.read_bytes())))
    # SAM2 吃原图 RGB+我们的 alpha 不必传——直接在原 RGB 上分割,再把各件 mask 应用到
    # BEN2 抠好的 rgba 上(两全:SAM 管部件边界,BEN2 管外轮廓软边)
    base_rgb = Image.open(SRC).convert("RGB")
    b64 = base64.b64encode(io.BytesIO().getvalue() or _png_bytes(base_rgb)).decode("ascii")

    w = Worker()
    hello = w.ask({"cmd": "ping"}, 60)
    assert hello.get("ok"), hello
    r = w.ask({"cmd": "load_image", "image_b64": b64}, 180)
    assert r.get("ok"), r

    masks = {}
    for name, p in PARTS.items():
        pts = p["points"] + p["neg"]
        labels = p["labels"] + [0] * len(p["neg"])
        r = w.ask({"cmd": "segment", "points": pts, "labels": labels}, 120)
        assert r.get("ok"), (name, r)
        masks[name] = base64.b64decode(r["mask_b64"])
        print(f"segment {name}: score={r.get('score', 0):.3f} area={r.get('area', 0)}")
    w.close()

    # 应用:每个部件 = BEN2 rgba × SAM mask
    W, H = rgba_full.size
    for name, mask_png in masks.items():
        m = Image.open(io.BytesIO(mask_png)).convert("L").resize((W, H), Image.NEAREST)
        part = rgba_full.copy()
        pa = part.getchannel("A")
        # alpha 相乘
        from PIL import ImageChops
        part.putalpha(ImageChops.multiply(pa, m))
        bbox = part.getbbox()
        part = part.crop(bbox)
        out = OUT_DIR / f"{name}.png"
        part.save(out, optimize=True)
        print(f"part {name}: {part.size[0]}x{part.size[1]} {out.stat().st_size // 1024}KB")

    # 预览:深色底上按原始位置叠回三件(对位检查)
    canvas = Image.new("RGBA", (W, H), (19, 20, 23, 255))
    for name in ("body", "tail", "head"):  # z 序:body 底、tail 中、head 顶(贴原 z 序)
        p = Image.open(OUT_DIR / f"{name}.png")
        canvas.alpha_composite(p, (0, 0))  # 部件是整幅裁剪的?不——getbbox 裁掉了,位置丢了!
    # 注:上面合成会错位,重做:部件导出时保留整幅(不裁),预览直接叠;实际挂件也用整幅件(CSS 无需算偏移)
    canvas2 = Image.new("RGBA", (W, H), (19, 20, 23, 255))
    for name in ("body", "tail", "head"):
        m = Image.open(io.BytesIO(masks[name])).convert("L").resize((W, H), Image.NEAREST)
        part = rgba_full.copy()
        from PIL import ImageChops
        part.putalpha(ImageChops.multiply(part.getchannel("A"), m))
        canvas2.alpha_composite(part, (0, 0))
        part.save(OUT_DIR / f"{name}_full.png", optimize=True)
    prev = canvas2.convert("RGB")
    prev.save(OUT_DIR / "assembled_preview.png")
    print("preview:", OUT_DIR / "assembled_preview.png")


def _png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


if __name__ == "__main__":
    main()
