# 社媒运营工作台(ops)设计文档

> 2026-10-18 v1 上线。定位:小红书/抖音的**内容工厂**——人设卡驱动文案与配图,发布是人工流程,
> 平台数据走人工调研。不做任何平台自动化(两平台均无个人发布 API,详见「平台现实约束」)。

## 一、范围决策(与 KK 拍板结论)

| 决策点 | 结论 |
|---|---|
| 第一个账号 | 小多利(KK 的真狗·中华田园犬混血,站宠 IP),主线=日常治愈,穿插工具彩蛋 |
| 发布方式 | 全手动:只做内容生产 + 素材打包(zip),不做发布自动化/平台跳转 |
| 视频内容 | P2 再接(素材库预留 mp4/webp 位);P1 图文跑通 |
| 热度数据 | 直达链接 + 人工记录(无服务端抓取) |

## 二、平台现实约束(为什么不做自动发布)

- 小红书笔记发布 API 仅面向企业认证主体;抖音开放平台视频发布权限近年收紧,个人开发者拿不到。
- 两平台热榜/搜索页均为强反爬 + JS 渲染 + 登录墙,服务端抓取不可靠且有风控风险。
- 因此「一键发布」v1 落地为:**复制文案 + 下载素材包 zip + 人工去创作者中心发布**,零封号风险。

## 三、数据模型(genwork/ops/,均不入 git)

```
genwork/ops/
├── personas/<12hex>.json   # 人设卡 + tags:{xhs:[{name,group}],dy:[…]}
├── posts/<12hex>/post.json # 帖子:copies(3版)/chosen/assets/status/notes
│   └── assets/a<N>.<ext>   # 素材文件(第一张即封面)
├── topics/<12hex>.json     # 选题库:{text,pillar,source:seed|research|manual,used}
└── research/<12hex>.json   # 对标库:{platform,url,title,note,stats{likes,saves,comments},group}
```

- 人设字段:positioning / audience / tone / catchphrase / visual(配图提示词基调)/ taboos / pillars(日常治愈、工具彩蛋、幕后花絮)。
- 首次启动 `_ops_ensure_seed()` 自动播种「小多利」人设(形象=校准后田园犬相:直毛/狐狸脸/半立耳,
  取自 tools/duoli_likeness_probe.py)+ 10 条预置选题 + 双平台预置标签库。
- 顺手修正:`_DUOLI_SYSTEM` 站宠对白人设「棕色卷毛」→「直毛狐狸脸」(形象校准后的人设滞后)。

## 四、后端 /api/ops/*(server.py,照 _drama_route 前缀模块模式)

- 门禁:每端点先 `_gen_gate()`(本机免码直进;公网需邀请码),**先鉴权再读体**。
- 文案生成 `/api/ops/copy` 与拆解 `/api/ops/analyze` 走 `ip+":opt"` 宽松额度池(同 brainstorm,
  不占生图/视频日额度);配图生成完全复用 `/api/studio/tasks`(额度零改动)。
- 关键端点:personas CRUD(+tags 归一:去#、分组白名单)、topics CRUD、research CRUD、
  posts CRUD + 状态流转(idea→draft→ready→published,publishedAt 自动盖章)、
  assets(dataURL ≤10MB 或 studio 任务磁盘直读 `file:{taskId,index}`)、
  `GET /<pid>/package` → zip(`文案.txt` UTF-8 带 BOM + `tags.txt` + assets/)、
  `GET /library`(小多利资产白名单扫描:姿势图/风格图/关键帧/真狗实拍)、`GET /meta`。
- 文案 system prompt = 人设卡 + 平台规格(小红书标题≤20/正文≤1000,抖音≤300)+ 该平台标签库,
  要求 LLM 输出 3 版 `{title,body,tags}`;max_tokens=4000(2500 会截断长正文导致 JSON 断尾,已踩坑)。
- 并发:`_OPS_LOCK`(RLock)全程读改写;id=uuid4().hex[:12];路径一律正则白名单防穿越。

## 五、前端(ops.html + js/ops.js + css/ops.css)

- 骨架照 drama.html:gate 兜底 + `#bootHint→#app` 揭示 + duoli 挂件;`AUTH()` Bearer 封装照 drama.js。
- 创作 tab:人设卡编辑 + 标签库(平台/分组 chips)→ 选题(选题库 chips 点选)→ ✨生成 3 版文案
  (tag chips 点选增删、复制)→ 用这版建帖 → 帖子详情(标题/正文可编辑即存 + 双平台字数计数警告
  + 标签 chips/自定义标签/一键存进标签库 + 素材条(本地上传/素材库/AI 生图)+ 状态流转
  + 复制文案/下载 zip)。
- AI 生图:模型(/api/studio/models)+比例预设(3:4 封面/9:16 竖版…)+提示词(人设 visual 自动拼)
  +参考图(默认挂审定主关键帧 probe_gpt-5_4-image-2.png,保形象一致,≤5张)→ 提交 studio 任务
  → 3 秒轮询 → 「选入帖子」落盘。
- 调研 tab:平台直达(搜索/热榜 deep-link,URL 模板由 /meta 下发,关键词 encodeURIComponent)
  → 对标库收藏(手动录 赞/藏/评,链接直达原文)→ 对标拆解(粘贴文字→LLM 拆钩子/结构/选题
  → 一键存入选题库)→ 选题库管理。
- index.html 加「内容运营」工具卡;js/duoli.js pageKey 加 'ops' + PAGE_TIPS 问候。

## 六、测试与验证

- `tools/ops_api_test.py`(自起服务器,镜像 drama_api_test 模式):meta/人设/标签归一/选题/对标/
  帖子状态流转/素材落盘回读/zip 内容+BOM/素材库/防穿越/未知端点/真实 LLM 文案与拆解 —— ALL PASS。
  注意:LLM 上游偶发 503/截断,脚本带重试;`subprocess.Popen` 子进程 stdout 块缓冲会被 terminate
  吞掉,排障时给服务器加 `-u`。
- 浏览器冒烟(IAB):gate 直进、三 tab、直达链接 URL 编码、生成文案→建帖→标题计数警告→
  自定义标签回车入库→zip(PK 魔数)→素材库选入(图+视频)→AI 生图→选入素材→排期/复盘,全链路实测通过。
- **2026-10-18 下午 P2+P3 落地并复测 ALL PASS**:视频素材(mp4 dataURL ≤80MB,kind 自动判)、
  素材库开放视频(99 件:动画循环/短剧成片挂接 drama-<pid>-composed|shot-<sid>.mp4)、
  文案视频帖模板(kind 参数)、帖子 kind/scheduleAt/stats 字段、对标 accountId 隔离;
  前端 v2 重排(三 tab + 卡片化 + 折叠 + 状态 stepper),浏览器三 tab 截图验收通过。

## 七、路线状态

- ✅ P2 视频(2026-10-18):素材库 mp4/webp 进白名单(动画循环 + 短剧成片/镜头挂接)、
  帖子素材 video 类型(≤80MB)、文案 kind=image|video 两模板、发布包带视频。
- ✅ P3 运营闭环(2026-10-18):排期日历(周视图 + 未排期 backlog + 一键排今天/明天 +
  「今天待发」横幅;到点发布用平台自带定时)、复盘(帖子详情手填 曝光/赞/藏/评/涨粉 →
  按支柱聚合表)、多账号(账号筛选 + 对标按账号隔离)。
- 待办:P2 备注里的「对标截图上传 LLM 看图拆解」、复盘按封面表现归因、企业认证后接官方 API。
- 布局坑(记录):body 是纵向 flex,main 加 `margin:0 auto` 会让子项退出 stretch 收缩成
  fit-content——`.ops-shell` 必须显式 `width:100%`。
- 若后续办下企业认证:发布层留了 adapter 空间,可接官方 API。