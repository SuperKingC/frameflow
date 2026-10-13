# -*- coding: utf-8 -*-
"""干净重启 FrameFlow 实例:杀光指定端口的监听进程,再起一个,健康检查。
背景:Windows 下 TaskStop/kill 只杀 bash 外壳,python 孤儿会和新实例同时 LISTEN 同端口,
请求被路由到旧代码进程(已踩两次)。本脚本用 taskkill /T 连树杀,并断言端口只剩一个监听者。

用法: python tools/restart_ff.py 8438   (可选第二个参数 --genwork 指定 FRAMEFLOW_GENWORK_DIR)
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

port = sys.argv[1] if len(sys.argv) > 1 else "8438"
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def listeners(port_):
    r = subprocess.run(["netstat", "-ano"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    pids = set()
    for line in r.stdout.decode("gbk", "replace").splitlines():
        if f":{port_}" in line and "LISTENING" in line:
            pids.add(line.split()[-1])
    return pids


# 1) 全杀(连树)
for pid in listeners(port):
    subprocess.run(["taskkill", "/F", "/T", "/PID", pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
left = listeners(port)
if left:
    print("FAIL: port still held by", left)
    sys.exit(1)

# 2) 起一个(独立进程组,脱离本脚本树,避免被 shell 回收)
env = dict(os.environ)
env["PYTHONIOENCODING"] = "utf-8"
proc = subprocess.Popen(
    [sys.executable, "server.py", "--port", port, "--no-browser"],
    cwd=root, env=env,
    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
print("started pid", proc.pid)

# 3) 健康检查(等它起来;确认只有一个监听者)
ok = False
for _ in range(20):
    time.sleep(0.5)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/studio/models", timeout=3) as r:
            json.loads(r.read().decode("utf-8"))
        ok = True
        break
    except Exception:
        continue
final = listeners(port)
print("healthy:", ok, "| listeners:", final)
if not ok or len(final) != 1:
    sys.exit(1)
print(f"READY http://127.0.0.1:{port}/")
