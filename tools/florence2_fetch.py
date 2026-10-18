# -*- coding: utf-8 -*-
"""下载 Microsoft Florence-2-base(MIT)到 FLORENCE2_DIR,经 hf-mirror(主站被墙)。
用法: python tools/florence2_fetch.py [目标目录]
默认目标: D:/Pet10-tools/florence2/Florence-2-base
只下 safetensors(仓库同时有 bin/safetensors,二选一),小文件已存在则跳过,大文件支持断点续传。"""
import os
import sys
import time
import urllib.request

REPO = sys.argv[1] if len(sys.argv) > 1 else "Florence-2-base"   # 仓库名(不含 microsoft/ 前缀)
BASE = f"https://hf-mirror.com/microsoft/{REPO}/resolve/main/"
DEST = sys.argv[2] if len(sys.argv) > 2 else f"D:/Pet10-tools/florence2/{REPO}"

SMALL = ["config.json", "configuration_florence2.py", "modeling_florence2.py",
         "processing_florence2.py", "preprocessor_config.json",
         "tokenizer.json", "tokenizer_config.json", "vocab.json"]
BIG = "model.safetensors"


def fetch(name, dest_path):
    url = BASE + name
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        total = int(r.headers.get("Content-Length") or 0)
        mode = "wb"
        done = 0
        if os.path.exists(dest_path + ".part") and total:
            done = os.path.getsize(dest_path + ".part")
            if 0 < done < total:
                req.add_header("Range", f"bytes={done}-")
                mode = "ab"
            else:
                mode = "wb"
                done = 0
        n = 0
        with open(dest_path + ".part", mode) as f, r:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                n += len(chunk)
                if total and (n + done) % (64 << 20) < (1 << 20):
                    print(f"  {name}: {(done + n) / 1e6:.0f}/{total / 1e6:.0f} MB", flush=True)
    os.replace(dest_path + ".part", dest_path)
    return os.path.getsize(dest_path)


os.makedirs(DEST, exist_ok=True)
t0 = time.time()
for name in SMALL:
    p = os.path.join(DEST, name)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        print("skip", name, flush=True)
        continue
    sz = fetch(name, p)
    print(f"ok {name} {sz}B", flush=True)
p = os.path.join(DEST, BIG)
if os.path.exists(p) and os.path.getsize(p) > 1_000_000:
    print(f"skip {BIG} ({os.path.getsize(p)/1e6:.0f}MB already)", flush=True)
else:
    sz = fetch(BIG, p)
    print(f"ok {BIG} {sz/1e6:.0f}MB", flush=True)
print(f"DONE in {time.time()-t0:.0f}s -> {DEST}")
