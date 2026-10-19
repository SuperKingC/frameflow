# -*- coding: utf-8 -*-
"""drama UI 冒烟(生产 8437,headless Edge——不抢用户前台):
门禁自动解锁 → 🚀一键成片/🎬全剧重混按钮渲染 → 🔗开关切换往返 →
API 造 2 个 clip 候选 → 候片墙渲染+点选切换 → 成本行/角标 → compose(ffmpeg-only)
→ 两个 confirm 弹窗出现并取消(不触发任何计费任务)→ 全页截图。
只做加法与可逆操作:候选/成本是加法演示数据;🔗 往返拨回;两个大按钮都在 confirm 处取消。
用法: python tools/drama_ui_smoke.py [BASE](缺省 http://127.0.0.1:8437)"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8437"
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
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


# ---------- 0) 选目标项目:优先演示项目,否则第一个有镜头的 ----------
projects = api("GET", "/api/drama/projects")["projects"]
demo = next((p for p in projects if p["id"] == "86f1f5ae60c2"), None)
target = demo or next((p for p in projects if p.get("shotCount", 0) > 0), projects[0] if projects else None)
if not target:
    print("FAIL no project on server")
    sys.exit(1)
pid = target["id"]
print("target project:", pid, target.get("title", ""), flush=True)


def make_clip(tag, hue):
    out = OUT / f"{tag}.mp4"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=270x480:rate=12:duration=1",
                    "-vf", f"hue=h={hue}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(out)], check=True)
    return "data:video/mp4;base64," + base64.b64encode(out.read_bytes()).decode()


# ---------- 1) 造 2 个 clip 候选(加法;候片墙要 ≥2 才渲染) ----------
proj = api("GET", f"/api/drama/projects/{pid}")["project"]
ep = proj["episodes"][0]
shot0 = ep["shots"][0]


def clip_takes():
    return [t for t in (shot0.get("takes") or []) if t.get("kind") == "clip"]


while len(clip_takes()) < 2:
    i = len(clip_takes())
    api("POST", f"/api/drama/projects/{pid}/asset",
        {"target": "shot", "id": shot0["id"], "kind": "clip", "cost": 0.25,
         "dataUrl": make_clip(f"smoke{i}", 40 * i)})
    proj = api("GET", f"/api/drama/projects/{pid}")["project"]
    ep = proj["episodes"][0]
    shot0 = ep["shots"][0]
check("api: 2 clip takes ready", len(clip_takes()) >= 2, [t["id"] for t in clip_takes()])

# ---------- 2) compose 本集(ffmpeg-only,零 LLM/生成成本),让 remix 的 confirm 可达 ----------
if not ep.get("composed"):
    api("POST", f"/api/drama/projects/{pid}/compose", {"burnSubs": False, "eid": ep["id"]})
    j = {}
    for _ in range(90):
        p2 = api("GET", f"/api/drama/projects/{pid}")["project"]
        e2 = p2["episodes"][0]
        j = e2.get("composeJob") or {}
        if j.get("state") in ("done", "error"):
            break
        time.sleep(1)
    check("api: episode composed", j.get("state") == "done", j)

# ---------- 3) headless 浏览器(Edge 通道,失败退 chrome/默认) ----------
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
    ctx.add_init_script(f"try{{localStorage.setItem('ffDramaLast','{pid}')}}catch(e){{}}")
    page = ctx.new_page()
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message or ""), d.dismiss()))
    page.goto(BASE + "/drama.html", wait_until="domcontentloaded")
    page.wait_for_function("() => window.FFGate && window.FFGate.ok", timeout=20000)
    page.wait_for_selector("#app:not([hidden])", timeout=20000)
    page.wait_for_function(
        f"() => document.querySelector('#projSel') && document.querySelector('#projSel').value === '{pid}'",
        timeout=20000)
    check("gate auto-unlock + project auto-load", True)

    # ---------- 4) 新按钮渲染 ----------
    run_txt = page.eval_on_selector("#btnRunAll", "el => el.textContent")
    check("🚀 一键成片 button", not page.eval_on_selector("#btnRunAll", "el => el.hidden")
          and "一键成片" in run_txt, run_txt)
    check("🎬 全剧重混 button", not page.eval_on_selector("#btnRemix", "el => el.hidden"))

    # ---------- 5) 🔗 首尾帧开关:往返拨动(净零改动) ----------
    def chain_checked():
        return page.evaluate("""() => {
          const card = document.querySelector('.shot');
          if (!card) return null;
          const l = [...card.querySelectorAll('.shot-ops label')]
            .find(x => x.textContent.includes('🔗'));
          return l ? l.querySelector('input').checked : null;
        }""")

    v0 = chain_checked()
    if v0 is None:
        check("🔗 toggle roundtrip", False, "no shot card rendered")
    else:
        for _ in range(2):
            page.evaluate("""() => {
              const card = document.querySelector('.shot');
              const l = [...card.querySelectorAll('.shot-ops label')]
                .find(x => x.textContent.includes('🔗'));
              l.querySelector('input').click();
            }""")
            page.wait_for_timeout(800)
        v2 = chain_checked()
        check("🔗 toggle roundtrip(拨动两次回原位)", v2 == v0, (v0, v2))

    # ---------- 6) 候片墙(P1.2):成片候选 ≥2 渲染 + 点选切换 ----------
    try:
        page.wait_for_selector(".take-strip", timeout=8000)
        thumbs = page.eval_on_selector_all(
            ".take-strip .take-thumb", "els => els.length")
        check("take-strips rendered", thumbs >= 2, thumbs)
        page.evaluate("""() => {
          const strip = [...document.querySelectorAll('.take-strip')]
            .find(s => s.querySelector('.take-label').textContent.includes('成片候选'));
          const on = strip.querySelector('.take-thumb.on');
          const other = [...strip.querySelectorAll('.take-thumb')].find(t => t !== on);
          other.click();
        }""")
        page.wait_for_timeout(1200)
        switched = page.evaluate("""() => {
          const strip = [...document.querySelectorAll('.take-strip')]
            .find(s => s.querySelector('.take-label').textContent.includes('成片候选'));
          const thumbs = [...strip.querySelectorAll('.take-thumb')];
          return thumbs.filter(t => t.classList.contains('on')).length === 1;
        }""")
        check("take thumb switch(选中态唯一)", switched is True)
        # 切回最新候选(恢复点「一键成片」前的默认态)
        page.evaluate("""() => {
          const strip = [...document.querySelectorAll('.take-strip')]
            .find(s => s.querySelector('.take-label').textContent.includes('成片候选'));
          const thumbs = [...strip.querySelectorAll('.take-thumb')];
          thumbs[thumbs.length - 1].click();
        }""")
        page.wait_for_timeout(800)
    except Exception as e:
        check("take-strips rendered", False, repr(e)[:180])

    # ---------- 7) 成本显示(P1.3) ----------
    cost_txt = page.eval_on_selector("#costLine", "el => el.textContent")
    check("costLine 本集/全剧成本", ("$" in cost_txt) or ("成本" in cost_txt and "0" not in cost_txt) or bool(cost_txt.strip()) and "$" in cost_txt, cost_txt)
    badges = page.eval_on_selector_all(".shot-cost", "els => els.length")
    check("shot cost badge", badges >= 1, badges)

    # ---------- 8) 🚀 一键成片:confirm 出现即取消(不计费) ----------
    n0 = len(dialogs)
    page.evaluate("() => document.querySelector('#btnRunAll').click()")
    page.wait_for_timeout(600)
    check("🚀 confirm dialog + 已取消", len(dialogs) > n0
          and any("一键成片" in m for m in dialogs[n0:]), dialogs[n0:])

    # ---------- 9) 🎬 全剧重混:confirm 出现即取消 ----------
    n1 = len(dialogs)
    page.evaluate("() => document.querySelector('#btnRemix').click()")
    page.wait_for_timeout(600)
    check("🎬 confirm dialog + 已取消", len(dialogs) > n1
          and any("全剧重混" in m for m in dialogs[n1:]), dialogs[n1:])

    page.screenshot(path=str(OUT / "drama_ui.png"), full_page=True)
    print("screenshot:", OUT / "drama_ui.png", flush=True)
    browser.close()

ok = all(c for _, c in results)
print("ALL PASS" if ok else "SOME FAIL")
sys.exit(0 if ok else 1)
