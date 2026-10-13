# FrameFlow 部署指南(公网 / 局域网)

面向 api.pet10kk.com 这类"nginx 终结 TLS + 反代本机 Python 服务"的部署形态。
所有配置均为环境变量 + nginx 配置,无代码改动。

## 环境变量

| 变量 | 必须 | 说明 |
| --- | --- | --- |
| `GEN_INVITE_CODE` | **公网必设** | 全站邀请码。**未设码时:真实 IP 为本机(含经反代但头缺失的请求)一律免码直进——等于全站裸奔**。设长随机串(≥20 位),拿到码就能烧中转站余额。 |
| `CODEX_API_KEY` / `APIROUTER_KEY` | 生成功能需要 | 上游 ApiRouter key;也可放同级 `miniapp-kit/.env`。仅存服务端环境,不落前端、不打日志。 |
| `TINYPNG_API_KEY`~`_5` | 压缩页需要 | 多 key 轮换;同样只在服务端。 |
| `FRAMEFLOW_GENWORK_DIR` | 公网建议设 | 生成产物/短剧项目根目录。**务必指到站点根之外**(如 `D:\AI产出`):生图结果与短剧剧本/素材都会写到这里,放站点根下会被静态通道枚举下载。 |
| `FRAMEFLOW_TRUST_PROXY` | 反代时建议设 | 设为 `1` 后无条件按 `X-Forwarded-For` 取真实客户端 IP(额度/锁定/本机判定都按它)。未设时服务端也会自动识别:对端是回环且带 XFF 就取 XFF——nginx 标准反代下无需设置。 |
| `PYTHON_MATTING` | 抠图/图层页需要 | 带 torch+sam2 的 python 解释器(GPU 机器才配)。 |
| `FRAMEFLOW_OXIPNG` / `FRAMEFLOW_GENMJS` | 可选 | oxipng 与 gen.mjs 路径覆盖。 |

## 启动与 nginx

```bash
# Linux 服务器示例
export GEN_INVITE_CODE="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
export FRAMEFLOW_GENWORK_DIR=/srv/frameflow-data   # 站点根之外!
python3 server.py --host 127.0.0.1 --port 8437 --no-browser
```

```nginx
server {
    listen 443 ssl;
    server_name api.pet10kk.com;
    # ……现有证书与 access_log 配置(日志保持开启,便于事后追溯)

    # 服务端静态白名单已兜底(仅 *.html/css/js,其余 404),这里再拦一道防止直连回源
    location ~ ^/(genwork|\.git|\.zcode|docs|tests|testdata|tools|__pycache__|server\.py|sam_worker\.py|matting_worker\.py|README\.md) {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:8437;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;      # 生成/合成长请求
        client_max_body_size 100m;    # 短剧素材 dataURL 上传
    }
}
```

## 防线分层(改了什么、为什么)

1. **静态白名单(server.py,2026-10-13)**:`SimpleHTTPRequestHandler` 只放行
   `*.html` / `*.css` / `*.js`(带穿越兜底),目录列表关闭,`server.py`、`.git/`、
   `genwork/`、`docs/`、`tools/` 等一律 404;站点根 `/` 正常回 `index.html`。
   nginx 漏配也不会裸奔。
2. **产物目录外移**:`DRAMA_DIR` 已随 `FRAMEFLOW_GENWORK_DIR`(此前短剧目录写死在站点根下)。
3. **真实客户端 IP**:XFF 自动识别 + `FRAMEFLOW_TRUST_PROXY` 显式开关,取 XFF **末位**
   (nginx `$proxy_add_x_forwarded_for` 追加式,末位才是真实来源,顺带免疫客户端伪造首段)。
   反代下额度(3 次/分、100 图/30 视频每天)与"错 3 次锁一天"按真实 IP 计。
4. **本机免码收紧**:未设邀请码时,"本机" = 真实 IP 与 TCP 对端**都**是回环。经反代
   进来的公网请求即使对端是 127.0.0.1 也要码(防 XFF 缺失时全站误判本机)。
5. **`/api/studio/models` 收敛**:已设邀请码时仅持码者能拉模型目录(含上游单价标签);
   无码只回 `inviteRequired: true`(探测不计失败)。js/gate.js、js/gen.js 已适配。
6. **quota 接口不再返回 `storageDir`**(服务器路径不外泄)。
7. **二轮加固(2026-10-13 晚)**:
   - 邀请码比较改 `hmac.compare_digest`(时序安全);
   - 短剧素材 URL 代取加 SSRF 防护 `_drama_url_guard`:仅 http/https、
     拒绝解析到回环/私网/链路本地/保留地址的主机(防 file://、防探测内网);
   - `/api/studio/tasks` POST 先鉴权再读请求体(未持码者不能白耗 64MB 读入);
   - API 错误回显统一过 `_pub_err`,剥掉服务器本机路径(目录布局不外泄)。
8. **XFF 取末位的含义**:公网直连(Python 不经反代、 attacker 伪造 XFF)时伪造头
   不会生效——`_is_loopback(peer)` 对公网对端为假,XFF 根本不被信任;只有经回环
   反代的请求才信任该头,而那一段由 nginx 追加、可信。

## 已知可接受项

- **`/api/studio/file/<32位id>/<n>` 不鉴权**:id 为 uuid4 不可枚举;语义是"分享链接即
  公开"。介意可加过期签名链接(未做)。
- **前端源码公开**:HTML/JS/CSS 本来就发给浏览器,无任何秘密(码/key 全在服务端环境)。
- **邀请码防爆破按 IP 计(XFF 末位)**:伪造 XFF 可绕过按 IP 锁定换着 IP 继续试,
  真正的防线是码要长随机(≥20 位,穷举不可行)。可选增强:全局每日失败上限、
  多码分人可吊销(未做)。
- **本机免码模式对 DNS rebinding 未设防**:恶意网页理论上可绑定域名打到 127.0.0.1
  并以同源身份调本地接口;设码部署不受影响,免码本地使用介意可加 Host 白名单(未做)。
- **内容流向**:TinyPNG 与生图/分镜上游会收到用户素材/提示词;oxipng、SAM2、BEN2、
  拆帧、导出全部纯本地。
- **本机部署包**:从这台开发机传代码走 git,别直接拷文件(亿赛通透明加密可能产出密文)。
