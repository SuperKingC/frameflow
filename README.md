# FrameFlow — AI视频 → 游戏帧动画 工作台

AI 图生视频的**后处理工作台**:视频 → 拆帧 → 键控抠图 → 画笔修边 → 循环检测/减帧 → 导出 **Spine 三件套**(json+atlas+png 帧动画)或精灵图集/序列帧。内置可灵生视频(桥接 miniapp-kit)。全部处理在浏览器本地完成,视频不上传。

配套生态:首帧图来自 `miniapp-kit/art/` 生图流水线,生视频桥接 `miniapp-kit/anim/gen.mjs`(可灵 · ApiRouter),导出的三件套直接进游戏项目(如 Meowblade)的 Resources。

## 启动

```powershell
python server.py
# 浏览器打开 http://127.0.0.1:8437/
```

可选:`--port 9000`、`--genmjs <miniapp-kit>/anim/gen.mjs`(默认找同级 `../miniapp-kit`,或环境变量 `FRAMEFLOW_GENMJS`)。

依赖:Node.js + ffmpeg(仅生视频桥接需要;拆帧/抠图/导出纯浏览器,零依赖)。测试样例:`testdata/test_green_cat_h264.mp4`(绿幕白猫循环)。

## 页面流程(①–⑧)

### ① 生视频(可灵 · ApiRouter,可选)
选首帧图(角色定稿图,**图管长相**)→ 填运动提示词(**只写运动,词管动作**,不复述外观)→ 可 dry-run 看最终提示词 → 生成。约 5 分钟/条(Pro 档实测 $0.84);`pingpong` 自动处理无缝循环(实测提示词 seamless loop 不被服从);候选>1 按首尾帧 PSNR 挑优。密钥走环境变量 `CODEX_API_KEY` 或 `APIROUTER_KEY`,或 `miniapp-kit/.env`(自动加载),不落文件。生成完点【→ 导入拆帧流程】。

### ② 切图(雪碧图/大图 → 帧)
三种方式:**自动空白切帧**(8 连通域标记,任意布局自动分开,需透明通道)、**网格均分**(行列参数,非空格裁到内容包围盒)、**单图单帧**(整图作为一帧,如概念图)。切完进入同一流程:可再抠图 → 减帧 → 找循环 → 导出。

### ③ 抠图
键控模式:绿幕/白底/黑底/Alt+点击取样;容差与溢出抑制滑杆;边缘泛洪(白底/纯色背景更稳);**边缘处理**:羽化 1px / 收缩 1px(去毛边)/ 扩张 1px(补缺口)。画笔三模式:**擦除** / **恢复(从原图)** / **魔棒**(点击清除同色连通区,容差可调,Alt+点击为取色)。全部帧一键重抠,画笔(含魔棒)自动重放。

### ④ 减帧
感知哈希自动剔除过近帧 + 缩略图手动勾选。**要在"添加为动画"之前做。**

### ⑤ 循环检测
自动找循环帧(候选列表点击即预览);手动起止兜底。

### ⑥ 添加为动画
命名(idle/attack/hit…)+ fps + 是否循环;可添加多个动作,一次导出。

### ⑦ 导出
- **Spine 三件套 ZIP**(主按钮):`<角色id>.json` / `.atlas.txt` / `.png` + `meta.json`
- 精灵图集(PNG + 描述 JSON)/ 序列帧 ZIP(每帧独立 PNG)
- **图片压缩**(导出前勾选):调色板量化(中位切分,64/128/256 色可选 + Floyd–Steinberg 抖动),alpha 保留连续值。实测:游戏风格图 512² 193KB→72KB(128 色,-63%);抖动适合渐变图,纯色图慎用(体积反而变大)。

### ⑧ 图片压缩工具(单图)
独立小工具:任选一张图 → 量化(色数/抖动)下载压缩 PNG,或转 WebP(质量可调,适合通用素材;Spine 图集仍用 PNG)。显示压缩前后体积。

## Spine 三件套规格

- 结构:`root` 骨架 + `body` 槽(帧换附件时间线,附件名 `<动作>_f00…`)+ `fx` 槽(`hit_anchor` point 锚点,画面高度 55%)。
- 原点:每帧**底部中心**(region `x=0, y=H/2`),适合落地对齐。
- 图集:预乘 alpha,`pma:true`(匹配 spine-unity SkeletonGraphic 默认材质),2px 间距防出血,尺寸取偶。
- `meta.json` 记录每个动作的 fps/循环/帧数;循环由运行时控制(如 `SpineCharacterAnimator`)。
- 兼容 Spine 4.2+ 运行时(项目内已对照 spine-csharp 4.3.23 解析器逐字段验证)。

## 接入游戏项目(以 Meowblade 为例)

1. 解压三件套 ZIP 到 `Assets/Resources/Art/SpineHeroes/<角色>/`。
2. Unity 菜单 Spine → Import Package(或 json+atlas+png 自动导入)生成 `*_Atlas.asset`、`*_Material.mat`、`*_SkeletonData.asset`。
3. `ArtLibrary.HeroSkeletonPaths` 改一行指向新 SkeletonData;契约测试补上路径与动画名断言。

## 技术要点与已知限制

- 拆帧用 `<video>` seek 抽帧,依赖浏览器解码(Chrome/Edge 桌面版 H.264/VP9/VP8 均可;WebView/受限浏览器可能解不了,请用系统浏览器)。
- ZIP 为 store 打包(PNG 自带压缩);纯前端零依赖,离线可用。
- 上限 400 帧/视频;调色、GIF 导出、sequence attachments 原生格式为后续增强项。
- 生视频桥接不改 miniapp-kit 代码:参数落到 `genwork/<任务id>/`(anim.config.json + prompts.txt + 首帧图),子进程执行 gen.mjs;`genwork/` 已 gitignore。

## 交接与协作

- `git` 仓库建议:本项目可独立 `git init` 打 tag;genwork/testdata 可 ignore(testdata 样例保留亦可)。
- 修改抠图/循环/导出算法在 `js/pipeline.js`、`js/exporter.js`;Spine JSON 结构变更需同步跑一遍 testdata 样例回归。
