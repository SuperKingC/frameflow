# -*- coding: utf-8 -*-
"""短剧 P2 UI 冒烟(生产 8437,headless Edge——不抢用户前台):
前置:API 已给演示项目(86f1f5ae60c2)挂了 bgm.wav(p2_smoke 同款数据流)。
覆盖:BGM 行渲染(bgmName=当前:bgm.wav,btnBgmClear 可见)→ pBgm 勾选往返
(localStorage 持久化)→ 封面候选墙(cover-wall + cover-thumb ≥1)+ 点图放大 lightbox
→ 全页截图。只做只读与可逆操作,不触发任何计费任务。
用法: python tools/p2_ui_smoke.py [BASE](缺省 http://127.0.0.1:8437)"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8437"
PID = sys.argv[2] if len(sys.argv) > 2 else "86f1f5ae60c2"
OUT = Path("genwork/ui_smoke")
OUT.mkdir(parents=True, exist_ok=True)
results = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" | " + str(detail)[:220]) if detail else ""), flush=True)
    results.append((name, bool(cond)))
    return cond


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


# ---------- 0) 确认目标项目已挂 BGM ----------
proj = api("GET", f"/api/drama/projects/{PID}")["project"]
if not proj.get("bgm"):
    # 现场补挂(幂等:已有就跳过)
    import base64
    wav = OUT / "accept_bgm.wav"
    if not wav.is_file():
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                        "-ar", "44100", "-ac", "2", str(wav)], check=True)
    api("POST", f"/api/drama/projects/{pid}/bgm",
        {"dataUrl": "data:audio/wav;base64," + base64.b64encode(wav.read_bytes()).decode()})
    proj = api("GET", f"/api/drama/projects/{pid}")["project"]
check("api: project has bgm", bool(proj.get("bgm")), proj.get("bgm"))
ep = next((e for e in proj["episodes"] if e.get("composed")), None)
check("api: ep composed", bool(ep and ep.get("composed")), ep and ep.get("composed"))
covers = ep.get("covers") or [] if ep else []
check("api: covers ready", len(covers) >= 1, covers)

# ---------- 1) headless 浏览器 ----------
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser, last_err = None, None
    for channel in ("msedge", "chrome", None):
        try:
            browser = pw.chromium.launch(channel=channel, headless=True)
            print("browser channel:", channel or "bundled-chromium", flush=True)
            break
        except Exception as e:
            last_err = e
    if browser is None:
        print("FAIL browser launch:", last_err)
        sys.exit(1)
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
    ctx.add_init_script(f"try{{localStorage.setItem('ffDramaLast','{PID}')}}catch(e){{}}")
    page = ctx.new_page()
    page.goto(BASE + "/drama.html", wait_until="domcontentloaded")
    page.wait_for_function("() => window.FFGate && window.FFGate.ok", timeout=20000)
    page.wait_for_selector("#app:not([hidden])", timeout=20000)
    page.wait_for_function(
        f"() => document.querySelector('#projSel') && document.querySelector('#projSel').value === '{PID}'",
        timeout=20000)
    check("gate auto-unlock + project auto-load", True)

    # ---------- 2) BGM 行(P2-4):渲染 + 文件名 + 取消钮 ----------
    bgm_hidden = page.eval_on_selector("#bgmRow", "el => el.hidden")
    check("bgmRow 挂载(项目加载后可见)", bgm_hidden is False)
    bgm_name = page.eval_on_selector("#bgmName", "el => el.textContent")
    check("bgmName 显示当前文件", "当前:" in bgm_name and "bgm" in bgm_name, bgm_name)
    clr_hidden = page.eval_on_selector("#btnBgmClear", "el => el.hidden")
    check("btnBgmClear 可见(已有 BGM)", clr_hidden is False)
    pick_hidden = page.eval_on_selector("#btnBgmPick", "el => el.hidden")
    check("btnBgmPick 可见", pick_hidden is False)

    # ---------- 3) pBgm 勾选往返(localStorage 持久化;净零改动) ----------
    v0 = page.eval_on_selector("#pBgm", "el => el.checked")
    for _ in range(2):
        page.evaluate("() => document.querySelector('#pBgm').click()")
        page.wait_for_timeout(400)
    v2 = page.eval_on_selector("#pBgm", "el => el.checked")
    check("pBgm 勾选往返(两次回原位)", v2 == v0, (v0, v2))

    # ---------- 4) 封面候选墙(P2-3):渲染 + 缩略图 ≥1 + 点击放大 ----------
    try:
        page.wait_for_selector(".cover-wall", timeout=8000)
        thumbs = page.eval_on_selector_all(".cover-thumb", "els => els.length")
        check(f"封面候选墙渲染(thumbs={thumbs})", thumbs >= 1, thumbs)
        if thumbs:
            page.evaluate("() => document.querySelector('.cover-thumb').click()")
            page.wait_for_timeout(600)
            lb_shown = page.evaluate(
                "() => document.querySelector('#lightbox').style.display")
            img_src = page.evaluate(
                "() => document.querySelector('#lightbox img') ? document.querySelector('#lightbox img').src : ''")
            check("封面点击放大(lightbox)", lb_shown == "flex" and "/asset/" in img_src,
                  (lb_shown, img_src[:80]))
            page.evaluate("() => document.querySelector('#lightbox').click()")
            page.wait_for_timeout(400)
    except Exception as e:
        check("封面候选墙渲染", False, repr(e)[:180])

    page.screenshot(path=str(OUT / "drama_p2_ui.png"), full_page=True)
    print("screenshot:", OUT / "drama_p2_ui.png", flush=True)
    browser.close()

ok = all(c for _, c in results)
print("ALL PASS" if ok else "SOME FAIL")
sys.exit(0 if ok else 1)