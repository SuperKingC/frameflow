# 图层分离(设计稿 → 独立图层)方案思考

> 2026-09-23。目标:给定一张设计图(如角色立绘、场景概念图),把其中的各个元素(角色、武器、配饰、道具、背景块)分离成独立图层,输出每层一张透明 PNG,供再装配/单独生视频/编辑使用。

## 一、可选路线(按确定性排序)

| 路线 | 做法 | 质量 | 成本 | 结论 |
| --- | --- | --- | --- | --- |
| 1. 空间连通域分块 | 已有(autoSlice):按 alpha 连通域切分 | 只能分开**互不接触**的元素;接触/重叠元素会粘成一块 | 零(确定性) | 已实现,作兜底 |
| 2. 颜色聚类分层 | k-means(RGB + 空间位置权重)→ 聚类 → 每簇一个图层 + 形态学清理 | **平涂/描边风格**(本项目猫咪美术正是此类)效果好;渐变写实风会碎 | 低(纯前端可做) | **MVP 首选** |
| 3. 点选式 SAM2 半自动 | 用户在设计图上给每个元素点一个点(或框)→ SAM2 出该元素 mask → 逐层导出 | 高,人工可控 | 中:需本地 Python 服务加载 SAM2 权重(miniapp-kit/matting 已有 SAM2±ViTMatte 基础,但当前是"整图主体"用法,需扩展成 point-prompt 接口) | **二期主方案** |
| 4. AI 图像编辑模型自由拆件 | 提示词让图像编辑模型输出"拆开/分层"的图 | 已被社区反复证伪(视觉大模型不懂图像坐标,部件对位必然错) | 高 | ❌ 不做 |

关键依据(晨风工坊/罗培羽复盘):**几何/位置问题必须由人或确定性算法钉死,AI 只负责语义与颜色**。所以路线 4 排除,路线 2 是纯算法,路线 3 是"人给语义、AI 给边界"的正确分工。

## 二、推荐分两期落地

### v0:颜色聚类分层(纯前端,零依赖,可先做)
1. 输入设计图 → 采样像素(RGB + 归一化坐标,k-means,K 可自动估计:色块直方图峰值)。
2. 每个聚类生成 mask → 形态学开闭清理 + 小区域并入邻近大簇 → 连通域再细分(不接触的簇内块拆成独立图层,如"两只耳朵")。
3. 每层输出:透明 PNG(整图层) + 整图预览(逐层高亮) + 图层清单(名称=主导色/簇号,面积占比)。
4. 交互:层数滑杆 + "合并/拆分"手动微调(点两个簇合并、点一簇二分)。
5. 导出:ZIP(每层 PNG + manifest:层级顺序/包围盒/平均色)。
- 已有资产可复用:quantizeCanvas 的调色板、autoSliceImage 的连通域、checker 预览、ZIP 打包。
- 风险:描边/渐变多的图会碎层 → 用"空间权重 + 最小层面积"缓解,并把碎片并入相邻大层。

### v1:SAM2 点选式(本地 Python 服务)
1. `server.py` 增 `/api/sam/segment`:接收图 + 点集(正/负点),调 miniapp-kit matting 的 SAM2(需把现有 solid_bg_matting.py 扩展出 point-prompt 调用;权重下载走 doctor 流程)。
2. 前端:画布上点击 → 出 mask 预览 → "保存为图层 N";图层列表可删/改名/排序。
3. 每层 = 用户点选 + SAM2 边界,质量接近手工抠图;操作成本 = 每元素点一下。

#### SAM2 实测记录(2026-09-23,kit 环境 sam2.1_hiera_small + CUDA)

测试对象:`Assets/Art/Concept/VisualDirection/art_concept_worker_generalist_v02.png`(橘猫工人设计图,1536×1024,米色纯底)。

单点实验(每元素 1 个正点,multimask 取最高分):

| 元素 | score | 结果 |
| --- | --- | --- |
| 围巾 | 0.954 | ✅ 边界精确,不向脸/衬衫泄漏 |
| 衬衫(含双袖) | 0.843 | 完整覆盖,停在围巾/背带裤边界 |
| 右手套 | 0.879 | 单个手套,干净 |
| 左靴 | 0.972 | 只取了点所在的那只靴,未带另一只(正确的"元素"行为) |
| 尾巴 | 0.952 | 卷尾全覆盖 |
| 头 | **0.213** ❌ | 被吸到左眼(显著子特征) |
| 背带裤 | **0.620** ❌ | 被吸到腰带扣 |

多点+负点精修实验:头 = 2 正点(额头+腮)+ 1 负点(眼)+ 1 负点(背景)→ score 0.82 全头覆盖;背带裤 = 2 正点(裤腿+胸袋)+ 1 负点(腰带扣)→ score 0.78 整体覆盖(皮带处少量泄漏,再加 1 负点可清)。

**结论:SAM2 对平涂设计稿的元素级切割可用且质量高,但"一次点击"只对视觉显著元素可靠;通用部位(头/裤子)会被吸到显著子特征(眼/扣)上,必须配交互式精修(补正点+负点)。v1 的核心交互因此确定为:点击 → 看掩码 → 补点修正 → 收下图层,每元素约 1–4 次点击。** 低 score(<0.5)可作为"需要精修"的自动提示。二值 mask 对切层足够(平涂无毛发),可选 ViTMatte 只在毛发/软边场景开启。

产物:`genwork/sam2_point_test/`(overlay.png / refine_overlay.png / 每元素 layer_*.png)。

#### 更强工具对比(同一接口下的升级项)

| 工具 | 相对 kit 现用 sam2.1_hiera_small | 评估 |
| --- | --- | --- |
| SAM2.1 **hiera_large** | +边界质量与复杂结构,~900MB,更慢 | 直接换 ckpt,接口不变;精修收不敛时换它 |
| **HQ-SAM2**(2024 底) | HQ token 显著改善细结构边界(尾尖/围巾穗) | 需另下权重;细结构成痛点时上 |
| **Grounded-SAM2**(文本→框→SAM2) | 文本提示自动出元素框 | 风格化美术上文本 grounding 不稳,只作"自动提议候选点"辅助 |
| **BEN2**(kit 已带权重,MIT) | 全自动单主体 matting,kit 实测首选 | 角色=单主体场景用它全自动;**逐元素分层仍需 SAM2 交互** |
| ISNet/DIS(rembg isnet) | 高保真边界,风格化图友好 | 同 BEN2 定位,备用 |
| ViTMatte(kit 已支持) | mask→软 alpha 精修 | 毛发/软边才需要,平涂可省 |
| **LayerD**(SIGGRAPH Asia 2024,研究) | 直接把栅格设计稿优化分解成图层 | 学术重、面向平面设计,作研究参考不落地 |
| Florence-2 / GroundingDINO | 自动"元素提议框" | v1 可选加速:自动出候选元素框供用户确认,省点击 |

**v1 落地判断:SAM2 交互点选成立**(kit 的 venv/权重/CUDA 全部就绪,PYTHON_MATTING 环境可直接用);hiera_large 与 HQ-SAM2 作为质量升级旋钮,BEN2 作为"整图单主体"自动通道并存。

### 输出契约(与生态对齐)
- 图层 PNG 命名 `<图名>_L01_腰身色.png` 这类;manifest 记录 draw order(按平均色/面积启发式,可手动调)。
- 可直接接回 Spine 工作流:每层可选"送入生视频首帧"或"作为帧部件"。
- 微信小游戏侧注意:层数建议 ≤8,单层图 ≤1024²(内存)。

## 三、为什么不做"全自动语义分层"
- 设计图的"元素"是语义概念(围巾/锤子/耳朵),纯算法只能近似;SAM2 点选把决定权留给人,把精确边界交给模型,是社区验证过的正确姿势(对比:全自由拆件已被证伪)。
- v0 聚类先行还有个附带收益:它同时是"切图"的增强版,能处理布局复杂的雪碧图。

## 四、2026-10-18 主流做法调研与 v2 优化方案

> 背景:小多利站宠挂件已用 v1 产出(base/upper/tail 三件,264KB),实测痛点是每元素 1–4 次点击 + 二值硬边。本节调研 2024–2026 主流做法后给出 v2 方案。
> 核实说明:本机网络 GitHub/HF 主站不可达(RST/超时),仅 hf-mirror.com 镜像可达;**SAM 3 已通过镜像核实**,HQ-SAM2 权重、LayerD 等开源状态未能核实,落地前逐项复核。

### 1. SAM 3 已发布,是本功能最大的变量(已核实)

facebook/sam3(HF,~0.9B 参数,3.4GB F32 safetensors,月下载 2.01M):统一可提示分割基础模型,四种模式——
- **SAM3**:概念级全实例分割(Promptable Concept Segmentation)。短文本词组或 exemplar 示例框 → 找出图中该概念的**全部实例**(SA-CO 基准达人类 75–80%)。
- **SAM3 Tracker**:点/框/mask 交互分割,**官方定位是 SAM 2 的直接替代(drop-in replacement)**。
- SAM3 Video / SAM3 Tracker Video:视频侧同源能力。
- 另支持正/负框、语义分割输出、混合批量提示;transformers 已有集成(mask-generation pipeline)。
- ⚠️ 许可:HF 卡面 license 为自定义(other)且权重 **gated 需手动同意**;GitHub 侧许可未能核实。**落地前必须先过许可关**。

对项目的意义:
1. Tracker 模式可整体替换 sam_worker 里的 SAM2.1(点/框/mask 提示全兼容);
2. 概念模式是**雪碧图/多同类元素批量拆件的最大杠杆**——"框一个元素→找出全部同类"或"输入'按钮'→全部按钮",把每元素 1–4 次点击压到 0–1 次;
3. 分工不变:概念/检测负责"找齐",Tracker 点/框负责"边界精修"。

### 2. 其余主流做法(知识库整理,未联网核实)

| 线 | 代表 | 对 v2 的价值 | 落地难度 |
| --- | --- | --- | --- |
| 模型升级 | SAM2.1 hiera_large(2.0→2.1 直接换 ckpt)、HQ-SAM2(hq_hiera_large:细长结构/图标边缘显著更好,延迟 +10~20%) | 直接提升边界质量,代码几乎不改 | 低;需核实 HQ-SAM2 对 2.1 的权重就绪度 |
| 开放词汇提议 | Grounding DINO、Florence-2(MIT,0.77B,可顺带给图层起名) | 文本→框→SAM2 出候选层,点击从 5–10 次降到 0–2 次 | 中 |
| 全自动分层 | LayerD(SIGGRAPH Asia 2024,动漫/平面 artwork 逐层剥离+深度序)、LICA(CVPR 2025,Adobe,未见开源权重) | 思路可借鉴;工程化尚不达设计级精度 | 高,观察项 |
| 高质量 matting | BiRefNet(MIT,商用最安全的 SOTA)、BRIA RMBG-2.0(年收入<$1M 免费)、BEN2(已在用) | 一键主体层(0 点击基线)+ 局部软边精修 | 低(BEN2 已就绪) |
| 性能 | fp16/autocast 官方支持、torch.compile +20–40%、decoder 官方 ONNX | large fp16 <8GB;点击只跑 decoder(<10ms),瓶颈在首图 encoder | 低 |

UX 范式(Photoshop 对象选择 / remove.bg / Canva Magic Grab / Figma):**先给结果、用户只改错**优于"先让用户点";图层树/命名/可编辑性与分割质量同等重要。

### 3. v2 优化方案(按优先级,贴合现有架构)

P0 — 立即可做,零训练,纯代码:
1. **一键主体层**:进图即调 matting_worker(BEN2,`/api/matting/auto` 已有)出第一层,点选只做增量纠错——"先给结果再改错"。
2. **box 提示**:sam_worker 的 segment 加 `box=[x0,y0,x1,y1]` 参数(拖框=一次手势框定元素,对"两只靴"类双实例远优于多点);框提示时 `multimask_output=False`。
3. **模型双档**:hiera_small(草稿快)/ hiera_large 或 HQ-SAM2(终稿精)下拉,与抠图页五模型一致;fp16 常驻。
4. **边缘与收尾**:收层时 1–2px 羽化替代二值硬边;加"未覆盖像素"开关层(各层叠加后高亮没被任何层收走的像素,肉眼自查漏收)。
5. **图片句柄化**:`/api/sam/load` 先传图返回 image_id(md5),后续 segment 只传 id+点集——现在每次点击都重传整图 base64。
6. **缓存键修复**:sam_worker `load_image` 现以字节数 `len(raw)` 判定是否重编码,同长不同图会出错误掩码;换 md5。

P1 — 手感与互操作(1–2 周):
7. 画布 zoom/pan(滚轮缩放+空格拖移)+ 撤销栈(点集/图层两级);高分辨率稿精修刚需。
8. PSD 导出:浏览器端 ag-psd 写多图层(层序/命名),直通 Photoshop/Krita;ZIP+manifest 保留。
9. 自动命名:Florence-2 对每层 bbox 出短语当图层名(可选,失败退回主导色命名)。
10. 会话持久化:点集+图层落盘 genwork,刷新可恢复(照抄生图 v0.5 模式)。

P2 — 探索性:
11. **SAM 3 接入**(许可过关后):概念词/示例框 → 全实例候选层勾选确认;Tracker 兼做精修后端。这是 v2 之后最重要的增量。
12. Grounding DINO/Florence-2 自动提议层(风格化美术不稳,仅作候选)。
13. LayerD 式全自动分层:持续跟踪新工作,暂不落地。

### 4. 落地前必核清单(断网/被墙未验)
- SAM 3:GitHub 仓库许可条款(是否 Apache-2.0)、gated 权重获取方式、显存占用(fp16 预计 ~2–3GB)、transformers 版本要求
- HQ-SAM2:是否已有基于 SAM2.1 的权重与配套代码
- BEN2/BRIA 商用条款复核;BiRefNet(MIT)作安全底座
- ag-psd 浏览器端写层能力(层序/命名/不透明度)

### 5. P0 落地实测(2026-10-18,全部通过)

P0 六件已实现并回归:
- **md5 缓存键修复**:`_sam_ensure` 与 sam_worker 都改按图像内容 md5 指纹,server 与 worker 双侧一致;同长不同图不再误判已加载。
- **box 提示**:`/api/sam/segment` 接受 `box:[x0,y0,x1,y1]`(自动归一化),框提示时 `multimask_output=False`;前端拖框>4px 触发,一次手势钉死目标。
- **双档模型**:`model=small|large`;large 权重已从 hf-mirror 下载(898MB,放 sam2.1_hiera_small.pt 同目录即被自动发现);CUDA 下 bfloat16 autocast;切换档位重建 predictor,单槽不双驻留;`/api/sam/meta` 返回双档可用性(仅查文件,不拉模型)。
- **句柄化**:`/api/sam/load` 注册 md5→b64(LRU 4 张),segment 只传 imageId;句柄失效/被淘汰自动重注册兜底;v1 整图传法仍兼容。
- **一键主体层**:前端「一键主体层(BEN2)」按钮接 `/api/matting/auto`,结果整层收下,点选只做增量纠错。
- **羽化 + 漏收自检**:收层可开 2px 盒式羽化(硬边→8~247 渐变);「未覆盖像素自检」把各层叠加未覆盖处用品红高亮、已覆盖处压暗,新窗口查看。

回归结果(`tools/sam_api_test.py`,12 项全过):meta/load 去重/点提示(small, score 0.992)/框提示(面积 17056≈理论 121×141=17061)/句柄失效报错/v1 兼容/box 类型校验/空提示报错/large 档(score 0.996)/matting ben2(6.1s)。
踩坑:server.py 用户并发编辑过,`_sam_ensure` 已从 sha1(旧)改 md5,我方编辑以最新版为准;双实例同端口时请求路由到旧代码进程——改 server.py 后必须 `python tools/restart_ff.py 8437` 干净重启。

### 6. 语义拆件落地(Florence-2,2026-10-18,端到端全通)

P2 第 12 条提前落地(Florence-2 替代 Grounding DINO,MIT 许可干净)。链路:**Florence-2 定位/命名 → 实例包围盒作 box 提示 → SAM2 出精确掩码 → 收层自动以概念词命名**。分工与文档既有结论一致:开放词汇负责"找齐+起名",SAM 负责"边界"。

**权重转换(必须)**:microsoft/Florence-2-base 官方 safetensors 是 remote-code 旧键名,5.x 内置 Florence2ForConditionalGeneration 直接加载=键名全不匹配→**静默全随机权重**(输出乱码但不报错!)。`tools/florence2_convert.py` 一次性转换+全量校验(665/665):
- 语言侧:builtin 复用原生 BartModel,`language_model.model.* → model.language_model.*` 直通,shared.weight 加载后经 tie 覆盖 encoder/decoder.embed_tokens 与 lm_head;`final_logits_bias` 是 builtin 没有的零缓冲,丢弃。
- 视觉侧(DaViT):remote 把算子包在 `.fn.` 容器里 → 剥离(`conv1.fn.dw`→`conv1`、`ffn.fn.net.fcN`→`ffn.fcN`、`*.fn.proj`→`*.proj`);`channel_attn.norm/window_attn.norm→norm1`(注意力前)、`ffn.norm→norm2`(FFN 前),两者形状相同映射错了会静默出错;`convs.N.proj→convs.N.conv`;裸 Parameter `image_projection [1024,768]` 转置成 nn.Linear 权重 `[768,1024]`。
- 产物 `D:/Pet10-tools/florence2/Florence-2-base-native/`(config.json 补 `image_token_id:1`)。

**加载配方**(florence_worker.py 与 tools/florence2_probe.py 同源,四任务实测通过):
- tokenizer:AutoTokenizer 得到 RobertaTokenizer(5.x 把 Bart tokenizer 合并进来了,`additional_special_tokens` 属性缺失),**手工补 1024 个扩展 token**(od/ocr×4 + loc_0..999 + cap..and×20,官方 processor 的添加顺序)→ id 50265..51288,与模型 51289 训练词表严丝合缝。
- 图像:CLIPImageProcessor(768²,bicubic,ImageNet 归一化,image_seq_length=577)。
- 模型:内置 Florence2ForConditionalGeneration fp16(显存 0.47GB),`config.image_token_id=1`(<pad> 作占位,生成时被图像特征替换)。
- 文本编码不走 processor:`input_ids=[1]*577 + <s>指令句</s>`(图像特征前置,与训练布局一致);任务 token 不在词表,靠指令句映射("Locate the objects with category name in the image." / "Locate the phrases in the caption: {input}" 等)。
- 后解析:builtin `Florence2PostProcessor` 直接实例化(绕过 Processor 的 tokenizer.image_token 检查),反量化 `(bin+0.5)*size/1000`。

**服务与前端**:
- `florence_worker.py`:stdio 协议 ping/load_image(md5 缓存)/instances(OD+DENSE 两路生成合并,同名去重,>98% 全图框与 <8px 碎框剔除)/ground(按词定位);单任务 0.3~0.8s。
- `POST /api/sam/concepts`:imageId 句柄(可兜底整图)+可选 phrase;`/api/sam/meta` 增 `concepts.available`(仅查文件)。
- 前端 layer 页:「AI 概念候选」按钮(没装 Florence-2 时自动隐藏)→ chips 列表 → 点 chip 按词拆 → 概念词记入 `st.pendingGround`,收层时作为图层名,manifest 增 `grounded` 字段;手动拖框/点选会清掉 pendingGround(新意图不再沿用旧命名)。
- 回归:`tools/sam_concepts_test.py` 7 项全过(meta 可用性/真图候选 3 实例/字段/ground "dog"/句柄失效/词长校验);`sam_api_test.py` 12 项无回归;浏览器 E2E(注入真图→候选→按词拆→收层,掩码 score 0.906/530193px)截图确认。

**新踩坑备忘**:
1. builtin 模型加载"成功"≠权重进去了——键名不匹配只报 warning(被 DEVNULL 吞掉),必须用 meta 设备 diff state_dict 键集验证。
2. remote `processing_florence2.py` 的 OD 正则是 `r'\\d'` 双转义(官方 bug),解析永远空;直接实例化 builtin Florence2PostProcessor 绕过。
3. 前端 chip 文案用了 `inst.score`,但 instances 响应没有该字段 → "·NaN%";渲染前判空。
4. 本机 grep/cat 在 D:\Pet10-tools 与 venv site-packages 读到密文(python 读同一文件正常)—— remote code 检索一律用 python 或 Read 工具。