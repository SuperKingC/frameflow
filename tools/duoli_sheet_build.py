# 变体帧 → sprite sheet:抠图(色键+泛洪)→ 按不透明质心对齐 → 拼横排 sheet → 预览 GIF → js 资产
# 用法: python tools/duoli_sheet_build.py 02|03
# 产物: genwork/duoli_frames/<prefix>_sheet.png + _preview.gif + js/duoli_frames_<w>.js
import base64
import io
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "genwork" / "duoli_frames"
OUT_JS = ROOT / "js"
SHEET_H = 300  # sheet 单帧高度(显示 128px 时 2.34x,清晰)


def flood_bg_alpha(img):
    """边缘色泛洪抠背景。爪缝/浅毛保护:泛洪完只清"与边界连通"的像素;
    对已经连通进来的真爪区,用后续 tight-crop + 人工兜底也不够——这里加第二道闸:
    记录每列被清像素的最深 y,清除深度突变(爪子被钻)时不许超过主体底缘统计值。"""
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
    # 爪缝保护:清 Pixels 按行统计,若某行清除比例 >90% 但相邻行 <40%,说明清进了主体
    # (爪间浅色缝隙被穿透)。把该行以下本行的清除撤销到安全线:简单做法——把每列
    # 清除像素中"低于行密度安全线"的部分恢复 alpha。
    rows = [sum(visited[y * W + x] for x in range(W)) / W for y in range(H)]
    # 从底往上找"清除密度骤降"的行:底缘附近清除密度应当高(纯背景),
    # 密度 <0.35 的行是主体区,其下若仍有高密度清除行(>0.6)即钻入,回滚这些行
    safe_cut = None
    for y in range(H - 1, int(H * 0.5), -1):
        if rows[y] < 0.35:
            safe_cut = y
            break
    if safe_cut is not None:
        for y in range(safe_cut + 1, H):
            if rows[y] > 0.6:
                for x in range(W):
                    if visited[y * W + x]:
                        visited[y * W + x] = 0
    n = sum(visited)
    for y in range(H):
        for x in range(W):
            if visited[y * W + x]:
                px[x, y] = (0, 0, 0, 0)
    return rgba, n / (W * H)


def main():
    which = sys.argv[1:] or ["02"]
    key_hint = {"02": "fluffy_watercolor", "03": "pixar_3d"}
    for w in which:
        prefix = f"{w}_{key_hint[w]}"
        names = ["idle", "blink", "tilt", "tongue", "tail2"]
        frames = []
        for n in names:
            p = SRC_DIR / f"{prefix}_{n}.png"
            img = Image.open(p)
            rgba, frac = flood_bg_alpha(img)
            bbox = rgba.getbbox()
            rgba = rgba.crop(bbox)
            frames.append(rgba)
            print(f"  {n}: 抠掉背景 {frac:.0%}, 裁后 {rgba.size[0]}x{rgba.size[1]}")
        # 各帧独立缩放到 SHEET_H 高,再按底边居中对齐拼横排;画布宽取最宽帧
        cells = []
        cw = max(round(f.size[0] * SHEET_H / f.size[1]) for f in frames) + 6
        ch = SHEET_H + 4
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
        # 预览 GIF:blink/tongue/tilt 轮播
        seq = [cells[0], cells[1], cells[0], cells[3], cells[0], cells[2], cells[4]]
        gif = SRC_DIR / f"{prefix}_preview.gif"
        seq[0].save(gif, save_all=True, append_images=seq[1:], duration=520, loop=0, disposal=2)
        print(f"preview: {gif.name}")
        # js 资产
        buf = io.BytesIO()
        sheet.save(buf, "PNG", optimize=True)
        js = OUT_JS / f"duoli_frames_{w}.js"
        js.write_text(
            f'// 小多利 sprite sheet({key_hint[w]}) — tools/duoli_sheet_build.py 生成;5帧横排,单帧高 {SHEET_H}\n'
            f'window.DUOLI_SHEET_{w} = {{ "src": "data:image/png;base64,{base64.b64encode(buf.getvalue()).decode("ascii")}",'
            f' "frames": {len(cells)}, "w": {cw}, "h": {ch} }};\n', encoding="utf-8")
        print(f"js: {js.name} {js.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
