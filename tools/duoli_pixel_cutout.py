# 像素犬抠图:06_pixel_art.png → 透明底精灵 → js/duoli_dog.js(内嵌 dataURL)
# 策略:背景是浅灰棋盘格,狗有闭合黑描边——从四边泛洪填充,只删"与边框连通的浅色",
# 深色描边挡住填充,狗内部白色不受影响(AI 抠图会产生软边,毁像素风,不用)。
# 之后检测原生像素格(16/8/4),缩到原生网格再裁边,PNG 小到几 KB。
import io
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "genwork" / "duoli_refs" / "06_pixel_art.png"
OUT_PNG = ROOT / "genwork" / "duoli_refs" / "06_pixel_art_cutout.png"
PREVIEW = ROOT / "genwork" / "duoli_refs" / "06_pixel_art_dark.png"
OUT_JS = ROOT / "js" / "duoli_dog.js"

img = Image.open(SRC).convert("RGB")
W, H = img.size
px = img.load()

# 1) 采样四边颜色当背景参考(棋盘格两种灰都在边上出现)
samples = []
for x in range(0, W, 5):
    samples += [px[x, 0], px[x, H - 1]]
for y in range(0, H, 5):
    samples += [px[0, y], px[W - 1, y]]

def is_bg(c):
    return any(abs(c[0] - s[0]) + abs(c[1] - s[1]) + abs(c[2] - s[2]) < 110 for s in samples)

# 2) 从边界泛洪(4连通):只删与边界连通的背景色
visited = bytearray(W * H)
q = deque()
for x in range(W):
    for y in (0, H - 1):
        if is_bg(px[x, y]) and not visited[y * W + x]:
            visited[y * W + x] = 1
            q.append((x, y))
for y in range(H):
    for x in (0, W - 1):
        if is_bg(px[x, y]) and not visited[y * W + x]:
            visited[y * W + x] = 1
            q.append((x, y))
while q:
    x, y = q.popleft()
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < W and 0 <= ny < H and not visited[ny * W + nx] and is_bg(px[nx, ny]):
            visited[ny * W + nx] = 1
            q.append((nx, ny))

rgba = img.convert("RGBA")
rp = rgba.load()
removed = 0
for y in range(H):
    for x in range(W):
        if visited[y * W + x]:
            rp[x, y] = (0, 0, 0, 0)
            removed += 1
print(f"背景去除: {removed / (W * H):.1%} 像素")

# 3) 压体积:缩到高 256(浏览器里按 0.5× 整数倍 pixelated 显示),宽裁成偶数
W2 = round(W * 256 / H)
if W2 % 2:
    W2 += 1
rgba = rgba.resize((W2, 256), Image.BOX)

# 4) 裁掉透明边
bbox = rgba.getbbox()
rgba = rgba.crop(bbox)
if rgba.size[0] % 2 or rgba.size[1] % 2:
    rgba = rgba.crop((0, 0, rgba.size[0] - rgba.size[0] % 2, rgba.size[1] - rgba.size[1] % 2))
print(f"裁边后: {rgba.size[0]}x{rgba.size[1]}")
rgba.save(OUT_PNG, optimize=True)
print(f"RGBA PNG: {OUT_PNG.stat().st_size // 1024}KB")

# 4b) 调色板量化(P 模式,像素画颜色少,体积再砍)
quant = rgba.convert("RGB").quantize(colors=96, method=Image.MEDIANCUT)
# 把 alpha 写回:量化图不保 alpha,用 RGBA 另存——像素画 RGBA 已够小,只对比一下
rgba.save(OUT_PNG, optimize=True)
print(f"PNG 大小: {OUT_PNG.stat().st_size // 1024}KB")

# 5) 深色底预览(工作台是深色主题,放大 3 倍看边缘)
bg = Image.new("RGBA", (rgba.size[0] * 3 + 40, rgba.size[1] * 3 + 40), (19, 20, 23, 255))
big = rgba.resize((rgba.size[0] * 3, rgba.size[1] * 3), Image.NEAREST)
bg.alpha_composite(big, (20, 20))
bg.convert("RGB").save(PREVIEW)

# 6) 内嵌成 js 资产(页面在 duoli.js 之前引一行即可)
import base64
buf = io.BytesIO()
rgba.save(buf, "PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode("ascii")
OUT_JS.write_text(
    '// 小多利像素形象(用户选定 06_pixel_art,抠图透明底) — 由 tools/duoli_pixel_cutout.py 生成\n'
    f'window.DUOLI_IMG = "data:image/png;base64,{b64}";\n',
    encoding="utf-8")
print(f"js/duoli_dog.js: {OUT_JS.stat().st_size // 1024}KB")