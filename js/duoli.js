// FrameFlow - 小多利站宠挂件(全站右下角)
// 卡通 SVG 小狗「小多利」(KK 的狗):漂浮呼吸、眨眼、摇尾、歪头、点击跳跃+冒话;
// 点开可陪聊(/api/duoli/chat,与全站同一把邀请码门禁)。样式与 SVG 全部内联注入,
// 页面只需一行 <script src="js/duoli.js"></script>。
// 状态机:idle(呼吸/眨眼/偶尔小动作) / happy(吐舌+快摇尾) / think(歪头思考) / sleep(闭眼打盹)。
// 门禁未过时挂件不出现;prefers-reduced-motion 时停掉装饰动画。
(function () {
  'use strict';

  // ---------- 页面识别与每页开场白(不发 LLM 的罐头话) ----------
  var path = location.pathname.replace(/^\//, '').toLowerCase();
  var pageKey = 'index';
  ['gen', 'cutout', 'layer', 'compress', 'spine', 'drama', 'ops'].forEach(function (k) {
    if (path.indexOf(k) === 0) pageKey = k;
  });
  var genKind = /kind=video/.test(location.search) ? 'video' : 'image';

  var PAGE_TIPS = {
    index: '汪!我是小多利,这个工作台的站宠~ 点我可以陪我聊天哦!',
    'gen:image': '汪!生图别忘了点「✨优化提示词」,句子写得越细,图越贴心思!',
    'gen:video': '汪!图生视频的口诀:图管长相,词管动作~',
    cutout: '汪!先选模型再点「开始处理」;发丝级细节用画笔慢慢修~',
    layer: '汪!在设计图上点点点,SAM2 就知道你想抠哪一层!',
    compress: '汪!把图拖进来,TinyPNG 压完看不出区别~',
    spine: '汪!视频进、资产出,一帧一帧做成 Spine 动画!',
    drama: '汪!一句话故事就能生成分镜,角色定妆还能保持一致!',
    ops: '汪!内容运营在这里:选好选题一键出文案,配图打包好去平台发!'
  };

  var BARKS = [
    '汪!', '汪汪~ 今天也要加油呀!', '*歪头* 你叫我?', '*摇尾巴* 汪汪!',
    '肚子有点饿了……有零食吗?', '汪!要不要一起去散步?', '*伸懒腰* 呼哇——',
    '你的提示词写得真棒,汪!'
  ];

  var ERR_TEXT = {
    invalid_invite_code: '呜……邀请码好像失效了,请回首页重新验证哦。',
    invite_locked: '今天验证错太多次被锁住啦,明天再来找我玩(汪呜)。',
    upstream_unavailable: '服务端还没配好上游 key,我还说不了话……等我接上大脑再聊!',
    rate_limit: '呼——让我喘口气,一分钟后再问我吧(汪)。',
    upstream_rejected: '我的大脑(上游模型)刚才打了个结,再问一次试试?',
    upstream_invalid_response: '我的大脑(上游模型)刚才打了个结,再问一次试试?'
  };

  // ---------- 样式(全部内联,免加 CSS 文件) ----------
  var CSS = [
    '.duoli-root{position:fixed;right:16px;bottom:14px;z-index:45;font:13px/1.55 "Segoe UI","Microsoft YaHei",sans-serif;',
    'opacity:0;pointer-events:none;transition:opacity .5s ease}',
    '.duoli-root.duoli-show{opacity:1;pointer-events:auto}',
    '@media (prefers-reduced-motion: reduce){.duoli-root *{animation:none!important;transition:none!important}}',

    // ---- 狗本体 ----
    '.duoli-dog{width:118px;height:118px;display:block;cursor:pointer;user-select:none;',
    'animation:duoliFloat 3.8s ease-in-out infinite alternate;-webkit-tap-highlight-color:transparent}',
    '@keyframes duoliFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
    '.duoli-dog:hover .duoli-head{transform:rotate(-5deg)}',
    '.duoli-head,.duoli-ear,.duoli-ear2,.duoli-tail,.duoli-eye,.duoli-eye2,.duoli-body,.duoli-pupils{',
    'transform-box:fill-box;transform-origin:50% 100%}',
    '.duoli-head{transition:transform .5s ease}',
    '.duoli-body{animation:duoliBreathe 2.6s ease-in-out infinite}',
    '@keyframes duoliBreathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,1.03)}}',
    '.duoli-tail{transform-origin:12% 88%;animation:duoliWag 2.2s ease-in-out infinite}',
    '@keyframes duoliWag{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(15deg)}}',
    '.duoli-happy .duoli-tail{animation-duration:.45s}',
    '.duoli-happy .duoli-ear{animation:duoliEarWiggle .5s ease-in-out 3}',
    '.duoli-ear{transform-origin:55% 92%}.duoli-ear2{transform-origin:45% 92%;animation:none}',
    '.duoli-think .duoli-ear{animation:duoliEarTwitch 1.1s ease-in-out infinite alternate}',
    '@keyframes duoliEarTwitch{0%,100%{transform:rotate(0)}50%{transform:rotate(7deg)}}',
    '@keyframes duoliEarWiggle{0%,100%{transform:rotate(0)}30%{transform:rotate(-8deg)}70%{transform:rotate(5deg)}}',
    '.duoli-eye,.duoli-eye2{transform-origin:50% 50%;animation:duoliBlink 4.4s ease-in-out infinite}',
    '.duoli-eye2{animation-delay:.06s}',
    '@keyframes duoliBlink{0%,93.5%,100%{transform:scaleY(1)}96%{transform:scaleY(.06)}}',
    '.duoli-sleep .duoli-eye,.duoli-sleep .duoli-eye2{animation:none;transform:scaleY(.05)}',
    '.duoli-sleep .duoli-dog{animation-duration:5.4s}',
    '.duoli-sleep .duoli-body{animation-duration:5.4s}',
    '.duoli-eye-closed{opacity:0}',
    '.duoli-sleep .duoli-eye-closed{opacity:1}',
    '.duoli-sleep .duoli-eye-open{opacity:0}',
    '.duoli-think .duoli-head{animation:duoliTilt 1.4s ease-in-out infinite alternate}',
    '@keyframes duoliTilt{0%{transform:rotate(-5deg)}100%{transform:rotate(6deg)}}',
    '.duoli-pupils{transform-origin:50% 50%;transition:transform .4s ease}',
    '.duoli-look .duoli-pupils{animation:duoliLook 2.2s ease-in-out}',
    '@keyframes duoliLook{0%,100%{transform:translateX(0)}30%{transform:translateX(-2.6px)}70%{transform:translateX(2.2px)}}',

    // 跳跃(点击):整个 svg/图片包一层做预备-腾空-回弹(与分层模式同一组 keyframes)
    '.duoli-dog.duoli-hop,.duoli-imgmode .duoli-dogwrap.duoli-hop{animation:duoliHop .82s ease-in-out}',
    '.duoli-imgmode .duoli-dogwrap.duoli-hopB{animation:duoliHopB .66s ease-in-out}',

    // ---- 图片模式(像素犬 DUOLI_IMG):漂浮挪到外层 wrap,本体做姿态 ----
    // 影子跟着呼吸缩放(漂浮到最高点影子最小),是"活物感"的关键一环
    '.duoli-imgmode .duoli-dogwrap{display:block;animation:duoliFloat 3.8s ease-in-out infinite alternate}',
    '@keyframes duoliFloat{0%{transform:translateY(0)}100%{transform:translateY(-7px)}}',
    '.duoli-imgmode .duoli-shadow{width:64px;height:11px;margin:-4px auto 0;border-radius:50%;',
    'background:rgba(0,0,0,.32);filter:blur(2px);transform-origin:50% 50%;',
    'animation:duoliShadow 3.8s ease-in-out infinite alternate}',
    '@keyframes duoliShadow{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(.86,.9);opacity:.62}}',
    // 跳跃时影子同步离地(变小变淡)再落回
    '.duoli-imgmode .duoli-dogwrap.duoli-hop~.duoli-shadow{animation:duoliShadowHop .82s ease-in-out}',
    '.duoli-imgmode .duoli-dogwrap.duoli-hopB~.duoli-shadow{animation:duoliShadowHop .66s ease-in-out}',
    '@keyframes duoliShadowHop{0%{transform:scale(1);opacity:.9}18%{transform:scale(1.06);opacity:1}',
    '55%{transform:scale(.72,.7);opacity:.4}100%{transform:scale(1);opacity:.9}}',
    '.duoli-imgmode .duoli-dog{width:auto;height:128px;max-width:132px;animation:none;',
    'image-rendering:pixelated;filter:drop-shadow(0 0 0 rgba(0,0,0,0));transition:transform .3s ease}',
    // hover 微歪头:不完全回正,残留 1° 更自然
    '.duoli-imgmode .duoli-dogwrap:hover .duoli-dog{transform:rotate(-4deg) translateY(-2px)}',
    // 开心:摆三下,幅度递减、带 settle 过冲(甩头落定)
    '.duoli-imgmode.duoli-happy .duoli-dog{animation:duoliWiggle .55s ease-in-out 3}',
    '@keyframes duoliWiggle{0%,100%{transform:rotate(0)}18%{transform:rotate(-7deg)}',
    '38%{transform:rotate(6.4deg)}56%{transform:rotate(-4.2deg)}76%{transform:rotate(2.6deg)}92%{transform:rotate(-1.1deg)}}',
    // 思考:幅度不对称(歪得多、回得少),像真的在琢磨
    '.duoli-imgmode.duoli-think .duoli-dog{animation:duoliThinkRock 1.5s ease-in-out infinite alternate}',
    '@keyframes duoliThinkRock{from{transform:rotate(-2deg)}45%{transform:rotate(4.6deg)}to{transform:rotate(5.4deg)}}',
    // 随机小动作:轻歪一下又回来(JS 会加 .duoli-lean)
    '.duoli-imgmode.duoli-lean .duoli-dog{animation:duoliLean 1.6s ease-in-out}',
    '@keyframes duoliLean{0%,100%{transform:rotate(0)}30%{transform:rotate(-5deg)}70%{transform:rotate(2deg)}}',
    '.duoli-imgmode.duoli-sleep .duoli-dog{filter:brightness(.96)}',
    '.duoli-imgmode.duoli-sleep .duoli-dogwrap{animation-duration:6.4s}',
    '.duoli-imgmode .duoli-sleep .duoli-shadow{animation-duration:6.4s}',
    '.duoli-imgmode .duoli-bubble{bottom:142px}',
    '.duoli-imgmode .duoli-chat{bottom:150px}',
    '.duoli-imgmode .duoli-zz{bottom:136px}',

    // ---- sprite 模式(DUOLI_SHEET_GPT):5 帧横排,JS 改 background-position 切帧 ----
    // 帧序: 0=idle 1=blink 2=tilt 3=tongue 4=paw;漂浮/影子与 imgmode 同参数
    '.duoli-spritemode .duoli-dogwrap{display:block;animation:duoliFloat 3.8s ease-in-out infinite alternate}',
    '.duoli-spritemode .duoli-shadow{width:64px;height:11px;margin:-4px auto 0;border-radius:50%;',
    'background:rgba(0,0,0,.32);filter:blur(2px);transform-origin:50% 50%;',
    'animation:duoliShadow 3.8s ease-in-out infinite alternate}',
    '.duoli-spritemode .duoli-dogwrap.duoli-hop~.duoli-shadow{animation:duoliShadowHop .82s ease-in-out}',
    '.duoli-spritemode .duoli-dogwrap.duoli-hopB~.duoli-shadow{animation:duoliShadowHop .66s ease-in-out}',
    '.duoli-spritemode .duoli-dog{height:132px;animation:none;background-repeat:no-repeat;',
    'filter:drop-shadow(0 4px 6px rgba(0,0,0,.35));transition:transform .45s cubic-bezier(.3,1.3,.45,1), filter .6s ease;will-change:transform}',
    // 头部朝向(事件感知):pupilShift 由 JS 设 --dl-head-x/--dl-head-y,歪头+微视差
    '.duoli-spritemode .duoli-dogwrap:hover .duoli-dog{transform:rotate(-2deg) translateY(-2px)}',
    '.duoli-spritemode.duoli-sleep .duoli-dog{filter:brightness(.96)}',
    '.duoli-spritemode.duoli-sleep .duoli-dogwrap{animation-duration:6.4s}',
    '.duoli-spritemode.duoli-sleep .duoli-shadow{animation-duration:6.4s}',
    '.duoli-spritemode .duoli-dogwrap.duoli-hop{animation:duoliHop .82s ease-in-out}',
    '.duoli-spritemode .duoli-dogwrap.duoli-hopB{animation:duoliHopB .66s ease-in-out}',
        // ---- 视频模式(DUOLI_VIDEO):canvas 单层逐帧渲染(ImageDecoder 预解码) ----
    // 无 img.src 切换=无解码空窗;切段=canvas 内双层混合,零叠影零闪
    '.duoli-videomode .duoli-dogwrap{position:relative;display:block;width:140px;height:132px;',
    'animation:duoliFloat 3.8s ease-in-out infinite alternate}',
    '.duoli-videomode canvas.duoli-dog{display:block;width:100%;height:100%;',
    'filter:drop-shadow(0 4px 6px rgba(0,0,0,.35));transition:filter .6s ease}',
    '.duoli-videomode .duoli-dogwrap:hover canvas.duoli-dog{filter:drop-shadow(0 6px 8px rgba(0,0,0,.45)) brightness(1.03)}',
    '.duoli-videomode.duoli-sleep canvas.duoli-dog{filter:brightness(.96)}',
    '.duoli-videomode.duoli-sleep .duoli-dogwrap{animation-duration:6.4s}',
    '.duoli-videomode .duoli-shadow{width:64px;height:11px;margin:-4px auto 0;border-radius:50%;',
    'background:rgba(0,0,0,.32);filter:blur(2px);',
    'animation:duoliShadow 3.8s ease-in-out infinite alternate}',
    '.duoli-videomode .duoli-bubble{bottom:146px}',
    '.duoli-videomode .duoli-chat{bottom:154px}',
    '.duoli-videomode .duoli-zz{bottom:140px}',

// ---- 分层模式(DUOLI_PARTS):base/upper/tail 三层连续变形,无帧切换 ----
    // 自然感三定律:平时近乎静止 / 动作以"突发段"出现(真狗不匀速循环) / 各部件相位互质
    '@property --dl-look{syntax:"<angle>";inherits:true;initial-value:0deg}',
    '.duoli-partsmode .duoli-dogwrap{position:relative;display:block;width:136px;height:136px;',
    'animation:duoliFloat 3.8s ease-in-out infinite alternate}',
    '@keyframes duoliFloat{0%{transform:translateY(0)}100%{transform:translateY(-7px)}}',
    '.duoli-partsmode .duoli-layer{position:absolute;left:0;top:0;width:100%;height:100%;',
    'background-repeat:no-repeat;background-size:contain;will-change:transform}',
    // base(后躯残件+描边):静态
    '.duoli-partsmode .duoli-layer.duoli-l-base{z-index:1}',
    // upper(头+胸+前腿):体重心转移,轴在底部中心(脚掌钉地、头动得多);视线变量平滑叠加
    '.duoli-partsmode .duoli-layer.duoli-l-upper{z-index:3;transform-origin:50% 97%;',
    'animation:dlWeight 10s ease-in-out infinite alternate;transition:--dl-look .5s ease-out}',
    '@keyframes dlWeight{from{transform:rotate(calc(-0.7deg + var(--dl-look,0deg)))}to{transform:rotate(calc(0.7deg + var(--dl-look,0deg)))}}',
    // tail:默认静止;JS 加 .dl-burst 播一段摇尾后归位(轴在尾根 95% 48%,根部不脱缝)
    '.duoli-partsmode .duoli-layer.duoli-l-tail{z-index:2;transform-origin:95% 48%}',
    '.duoli-partsmode .duoli-l-tail.dl-burst{animation:dlTailBurst 2.1s ease-in-out}',
    '@keyframes dlTailBurst{0%,100%{transform:rotate(0)}12%{transform:rotate(8deg)}26%{transform:rotate(-6deg)}',
    '40%{transform:rotate(7deg)}54%{transform:rotate(-4deg)}68%{transform:rotate(3deg)}84%{transform:rotate(-1deg)}}',
    // 开心(状态):狗开心时确实连续摇——这时持续快摇才对
    '.duoli-partsmode.duoli-happy .duoli-l-tail{animation:dlTailFast .5s ease-in-out infinite alternate}',
    '@keyframes dlTailFast{from{transform:rotate(9deg)}to{transform:rotate(-7deg)}}',
    // 思考:缓慢歪头保持(状态,连续)
    '.duoli-partsmode.duoli-think .duoli-l-upper{animation:dlThinkTilt 1.6s ease-in-out infinite alternate}',
    '@keyframes dlThinkTilt{from{transform:rotate(calc(-2.2deg + var(--dl-look,0deg)))}to{transform:rotate(calc(3.2deg + var(--dl-look,0deg)))}}',
    // 睡觉:全部灰化,摆动放更慢
    '.duoli-partsmode.duoli-sleep .duoli-layer{filter:brightness(.96)}',
    '.duoli-partsmode.duoli-sleep .duoli-l-upper{animation-duration:12s}',
    // 影子与漂浮同步(跳跃:压扁时变大、腾空时最小、落地回弹两段)
    '.duoli-partsmode .duoli-shadow{width:64px;height:11px;margin:-4px auto 0;border-radius:50%;',
    'background:rgba(0,0,0,.32);filter:blur(2px);',
    'animation:duoliShadow 3.8s ease-in-out infinite alternate}',
    '@keyframes duoliShadow{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(.86,.9);opacity:.62}}',
    '.duoli-partsmode .duoli-dogwrap.duoli-hop~.duoli-shadow{animation:duoliShadowHop .82s ease-in-out}',
    '.duoli-partsmode .duoli-dogwrap.duoli-hopB~.duoli-shadow{animation:duoliShadowHop .66s ease-in-out}',
    '@keyframes duoliShadowHop{0%{transform:scale(1);opacity:.9;animation-timing-function:ease-out}',
    '14%{transform:scale(1.09);opacity:1;animation-timing-function:cubic-bezier(.2,.6,.4,1)}',
    '48%{transform:scale(.68,.66);opacity:.34;animation-timing-function:cubic-bezier(.4,0,.7,.4)}',
    '76%{transform:scale(1.06);opacity:.98;animation-timing-function:ease-out}',
    '88%{transform:scale(.88);opacity:.6;animation-timing-function:ease-in}',
    '100%{transform:scale(1);opacity:.9}}',
    // 跳跃:预备(压扁)→腾空→落地压扁→回弹小跳→落定;每段独立缓动,影子全程同步
    '.duoli-partsmode .duoli-dogwrap.duoli-hop{animation:duoliHop .82s ease-in-out}',
    '.duoli-partsmode .duoli-dogwrap.duoli-hopB{animation:duoliHopB .66s ease-in-out}',
    '@keyframes duoliHop{0%{transform:translateY(0) scale(1,1);animation-timing-function:ease-out}',
    '14%{transform:translateY(4px) scale(1.1,.85);animation-timing-function:cubic-bezier(.2,.6,.4,1)}',
    '48%{transform:translateY(-27px) scale(.94,1.13);animation-timing-function:cubic-bezier(.4,0,.7,.4)}',
    '76%{transform:translateY(0) scale(1.07,.88);animation-timing-function:ease-out}',
    '88%{transform:translateY(-7px) scale(.97,1.05);animation-timing-function:ease-in}',
    '100%{transform:translateY(0) scale(1,1)}}',
    '@keyframes duoliHopB{0%{transform:translateY(0) scale(1,1);animation-timing-function:ease-out}',
    '16%{transform:translateY(3px) scale(1.07,.9);animation-timing-function:cubic-bezier(.2,.6,.4,1)}',
    '52%{transform:translateY(-18px) scale(.96,1.09);animation-timing-function:cubic-bezier(.4,0,.7,.4)}',
    '80%{transform:translateY(0) scale(1.05,.92);animation-timing-function:ease-out}',
    '100%{transform:translateY(0) scale(1,1)}}',
    '.duoli-partsmode .duoli-bubble{bottom:146px}',
    '.duoli-partsmode .duoli-chat{bottom:154px}',
    '.duoli-partsmode .duoli-zz{bottom:140px}',

    // 嘴/舌头:默认抿嘴笑,happy 换张嘴+吐舌
    '.duoli-mouth-open{opacity:0}',
    '.duoli-happy .duoli-mouth-open{opacity:1}',
    '.duoli-happy .duoli-mouth-smile{opacity:0}',
    '.duoli-tongue{transform-box:fill-box;transform-origin:50% 0;transform:scaleY(.4);opacity:0;transition:all .3s ease}',
    '.duoli-happy .duoli-tongue{opacity:1;transform:scaleY(1);animation:duoliTongue 1s ease-in-out infinite}',
    '@keyframes duoliTongue{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.86)}}',

    // ---- 气泡(狗说的话) ----
    '.duoli-bubble{position:absolute;right:8px;bottom:126px;max-width:240px;padding:9px 13px;',
    'background:var(--panel-2,#23262d);color:var(--text,#e8eaee);border:1px solid var(--line-strong,rgba(255,255,255,.12));',
    'border-radius:12px;border-bottom-left-radius:3px;font-size:12.5px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.35);',
    'opacity:0;transform:translateY(8px) scale(.94);transition:all .3s ease;pointer-events:none;white-space:normal}',
    '.duoli-bubble.duoli-on{opacity:1;transform:none;pointer-events:auto}',

    // ---- 聊天面板 ----
    '.duoli-chat{position:absolute;right:0;bottom:132px;width:min(88vw,320px);height:400px;',
    'background:rgba(30,32,38,.96);border:1px solid var(--line-strong,rgba(255,255,255,.12));border-radius:14px;',
    'box-shadow:0 16px 44px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;',
    'transform-origin:100% 100%;transform:translateY(14px) scale(.92);opacity:0;pointer-events:none;transition:all .28s cubic-bezier(.3,1.2,.4,1)}',
    '.duoli-chat.duoli-on{transform:none;opacity:1;pointer-events:auto}',
    '.duoli-chat-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0}',
    '.duoli-chat-title{font-weight:700;font-size:13px;color:var(--text,#e8eaee);flex:1}',
    '.duoli-chat-title small{font-weight:400;color:var(--text-3,#6d727d);margin-left:6px}',
    '.duoli-chat-btn{background:none;border:1px solid rgba(255,255,255,.12);color:var(--text-2,#a3a8b3);',
    'border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer}',
    '.duoli-chat-btn:hover{color:var(--text,#e8eaee);border-color:rgba(255,255,255,.25)}',
    '.duoli-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}',
    '.duoli-msgs::-webkit-scrollbar{width:7px}',
    '.duoli-msgs::-webkit-scrollbar-thumb{background:#33363e;border-radius:6px}',
    '.duoli-msg{max-width:82%;padding:7px 11px;border-radius:11px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
    '.duoli-msg.duoli-me{align-self:flex-end;background:linear-gradient(135deg,#34d399,#22d3ee);color:#0b1512;font-weight:600;border-bottom-right-radius:3px}',
    '.duoli-msg.duoli-dog-msg{align-self:flex-start;background:#2b2e36;color:var(--text,#e8eaee);border-bottom-left-radius:3px}',
    '.duoli-msg.duoli-err{align-self:flex-start;background:rgba(255,123,107,.14);color:#ff9d90;border:1px solid rgba(255,123,107,.3)}',
    '.duoli-typing{display:inline-flex;gap:4px;align-items:center;padding:4px 2px}',
    '.duoli-typing i{width:6px;height:6px;border-radius:50%;background:var(--accent,#34d399);opacity:.4;',
    'animation:duoliDot 1.2s ease-in-out infinite}',
    '.duoli-typing i:nth-child(2){animation-delay:.18s}.duoli-typing i:nth-child(3){animation-delay:.36s}',
    '@keyframes duoliDot{0%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',
    '.duoli-chat-foot{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.07);flex-shrink:0}',
    '.duoli-chat-input{flex:1;background:#24262d;border:1px solid rgba(255,255,255,.12);color:var(--text,#e8eaee);',
    'border-radius:9px;padding:7px 10px;font:inherit;font-size:12.5px;outline:none;min-width:0}',
    '.duoli-chat-input:focus{border-color:var(--accent,#34d399)}',
    '.duoli-chat-send{background:linear-gradient(135deg,#34d399,#22d3ee);border:none;border-radius:9px;',
    'padding:7px 14px;font-weight:700;color:#0b1512;cursor:pointer;font-size:12.5px;flex-shrink:0}',
    '.duoli-chat-send:disabled{opacity:.4;cursor:default}',
    '.duoli-zz{position:absolute;right:6px;bottom:120px;color:var(--text-2,#a3a8b3);font-size:13px;font-weight:700;',
    'letter-spacing:3px;opacity:0;transition:opacity .5s;pointer-events:none;animation:duoliZz 3s ease-in-out infinite}',
    '.duoli-sleep~.duoli-zz,.duoli-root.duoli-sleep .duoli-zz{opacity:.85}',
    '@keyframes duoliZz{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}'
  ].join('\n');

  // ---------- 小多利 SVG(照参考照片:棕卷毛/折角立耳/白围脖/黑鼻/粉舌) ----------
  var DOG_SVG = [
    '<svg class="duoli-dog" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="小多利">',
    '<defs>',
    '<radialGradient id="dlFur" cx="38%" cy="30%" r="80%">',
    '<stop offset="0%" stop-color="#d99b5e"/><stop offset="100%" stop-color="#b57a3f"/>',
    '</radialGradient>',
    '<radialGradient id="dlEar" cx="50%" cy="35%" r="75%">',
    '<stop offset="0%" stop-color="#b0743c"/><stop offset="100%" stop-color="#8f5a2b"/>',
    '</radialGradient>',
    '</defs>',
    // 地面影子(不随呼吸动)
    '<ellipse cx="100" cy="190" rx="46" ry="7" fill="rgba(0,0,0,.30)"/>',
    // 身体组(呼吸)
    '<g class="duoli-body">',
    // 尾巴(先画,压在身体后面)
    '<path class="duoli-tail" d="M136 150 C158 149 171 135 165 118 C164 115 159 115 158 119 C157 132 147 142 132 145 Z" fill="url(#dlEar)"/>',
    // 后背身体
    '<ellipse cx="100" cy="152" rx="45" ry="33" fill="url(#dlFur)"/>',
    // 白胸/围脖
    '<ellipse cx="100" cy="160" rx="30" ry="24" fill="#fff6ea"/>',
    '<ellipse cx="100" cy="134" rx="40" ry="17" fill="#fff6ea"/>',
    // 白色小爪
    '<rect x="79" y="160" width="13" height="29" rx="6.5" fill="#fff6ea"/>',
    '<rect x="108" y="160" width="13" height="29" rx="6.5" fill="#fff6ea"/>',
    // 体侧绒毛阴影
    '<path d="M62 138 C58 148 58 158 63 166" stroke="#8f5a2b" stroke-width="2" opacity=".28" fill="none" stroke-linecap="round"/>',
    '<path d="M138 138 C142 148 142 158 137 166" stroke="#8f5a2b" stroke-width="2" opacity=".28" fill="none" stroke-linecap="round"/>',
    '</g>',
    // 头组(歪头动画的支点)
    '<g class="duoli-head">',
    // 耳朵(折角立耳,先画压在头后)
    '<path class="duoli-ear" d="M62 74 C50 44 56 24 74 24 C88 25 88 46 82 70 Z" fill="url(#dlEar)"/>',
    '<path class="duoli-ear" d="M66 66 C59 46 62 33 73 32 C81 33 81 48 77 65 Z" fill="#e8b08c" opacity=".55"/>',
    '<path class="duoli-ear2" d="M138 74 C150 44 144 24 126 24 C112 25 112 46 118 70 Z" fill="url(#dlEar)"/>',
    '<path class="duoli-ear2" d="M134 66 C141 46 138 33 127 32 C119 33 119 48 123 65 Z" fill="#e8b08c" opacity=".55"/>',
    // 头
    '<ellipse cx="100" cy="86" rx="52" ry="45" fill="url(#dlFur)"/>',
    // 顶部呆毛
    '<path d="M97 42 C99 34 105 30 112 31 C106 34 104 38 103 44 Z" fill="#8f5a2b" opacity=".8"/>',
    // 白色眉心 blaze + 口鼻
    '<ellipse cx="100" cy="102" rx="17" ry="24" fill="#fff6ea"/>',
    '<ellipse cx="100" cy="112" rx="33" ry="23" fill="#fff6ea"/>',
    // 侧脸绒毛
    '<path d="M54 78 C50 88 50 98 55 106" stroke="#8f5a2b" stroke-width="2" opacity=".3" fill="none" stroke-linecap="round"/>',
    '<path d="M146 78 C150 88 150 98 145 106" stroke="#8f5a2b" stroke-width="2" opacity=".3" fill="none" stroke-linecap="round"/>',
    // 腮红
    '<ellipse cx="62" cy="106" rx="8.5" ry="5.5" fill="#f2a28c" opacity=".5"/>',
    '<ellipse cx="138" cy="106" rx="8.5" ry="5.5" fill="#f2a28c" opacity=".5"/>',
    // 眼睛:睁眼组(眨眼)/闭眼弧线(睡觉)
    '<g class="duoli-pupils">',
    '<g class="duoli-eye duoli-eye-open">',
    '<circle cx="79" cy="84" r="7.6" fill="#2a211c"/>',
    '<circle cx="76.6" cy="81.4" r="2.6" fill="#fff" opacity=".95"/>',
    '<circle cx="81.6" cy="86.6" r="1.3" fill="#fff" opacity=".55"/>',
    '</g>',
    '<g class="duoli-eye2 duoli-eye-open">',
    '<circle cx="121" cy="84" r="7.6" fill="#2a211c"/>',
    '<circle cx="118.6" cy="81.4" r="2.6" fill="#fff" opacity=".95"/>',
    '<circle cx="123.6" cy="86.6" r="1.3" fill="#fff" opacity=".55"/>',
    '</g>',
    '</g>',
    '<path class="duoli-eye-closed" d="M72 85 Q79 90 86 85" stroke="#3a2c22" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
    '<path class="duoli-eye-closed" d="M114 85 Q121 90 128 85" stroke="#3a2c22" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
    // 鼻
    '<ellipse cx="100" cy="101" rx="9.5" ry="7" fill="#2b2422"/>',
    '<ellipse cx="96.6" cy="98.8" rx="2.6" ry="1.8" fill="#fff" opacity=".35"/>',
    // 嘴:默认抿嘴笑;happy 换张嘴+舌头
    '<path class="duoli-mouth-smile" d="M100 107 L100 112 M87 114 Q100 125 113 114" stroke="#3a2c22" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
    '<g class="duoli-mouth-open">',
    '<ellipse cx="100" cy="120" rx="10" ry="8.5" fill="#5a352b"/>',
    '<g class="duoli-tongue">',
    '<rect x="94.5" y="120" width="11" height="17" rx="5.5" fill="#f2839b"/>',
    '<path d="M100 124 L100 134" stroke="#e06b86" stroke-width="1.6" stroke-linecap="round"/>',
    '</g>',
    '</g>',
    '</g>',
    // 项圈(KK 工作台主题色 + K 字吊牌)
    '<path d="M60 126 Q100 146 140 126 L140 135 Q100 155 60 135 Z" fill="#22d3ee"/>',
    '<circle cx="100" cy="147" r="6.4" fill="#34d399"/>',
    '<text x="100" y="150.5" text-anchor="middle" font-size="7.6" font-weight="800" fill="#0c1210" font-family="Segoe UI,sans-serif">K</text>',
    '</svg>'
  ].join('');

  // ---------- 组装 DOM ----------
  var STYLE_OK = false;
  function injectStyle() {
    if (STYLE_OK) return;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    STYLE_OK = true;
  }

  var root, dog, dogWrap, bubble, chat, msgsEl, inputEl, sendEl, zzEl;
  var state = 'idle';
  var stateTimer = null;
  var lastActive = Date.now();
  var chatOpen = false;
  var busy = false;
  var history = [];   // [{role, content}] 会话跟随整个站点(sessionStorage)
  // sprite 播放器(DUOLI_SHEET_GPT):frame 0..4;background-position 换帧
  var SPRITE = null;  // {src, frames, w, h}
  var spriteFrame = 0;
  var frameHold = 0;  // 当前帧保持到的时刻(ms);普通呼吸循环在帧到期才回 idle 帧
  var frameTimer = null;

  // ---- canvas 视频段播放器(DUOLI_VIDEO.segments,ImageDecoder 逐帧预解码) ----
  // 段结构 {src,poster,w,h,frames,fps,loop};渲染:单 canvas,rAF 按 fps 推进帧索引;
  // 切段:显示层做 0.45s 双帧混合(旧帧 globalAlpha 渐隐/新段帧渐显),无空窗无叠影;
  // 播放头可读(当前段+帧号),单次段播完自动接 next。
  var V = null;            // window.DUOLI_VIDEO
  var activeSeg = 'idle';  // 当前正在播的段名
  var segTimers = [];      // 段链的 setTimeout 们
  var CV = null;           // {canvas, ctx, W, H, dispW, dispH}
  var bitmaps = {};        // segName -> [ImageBitmap] 预解码帧
  var posterBitmap = {};   // segName -> ImageBitmap(首帧,混合目标用)
  var playHead = { seg: 'sleep', frame: 0 };  // 当前显示内容
  var mix = null;          // 切段混合 {fromBitmap, toSeg, t0, dur}
  var rafId = null;

  function segData(name) {
    return V && V.segments && V.segments[name];
  }

  function clearSegTimers() {
    segTimers.forEach(function (t) { clearTimeout(t); });
    segTimers = [];
  }

  // 解码一个段的全部帧(ImageDecoder 逐帧);循环复用,解码过就跳过
  function decodeSegment(name) {
    var d = segData(name);
    if (!d) return Promise.resolve();
    if (bitmaps[name]) return Promise.resolve();
    var b64 = d.src.split(',')[1];
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!('ImageDecoder' in window)) {
      // 兜底:老浏览器退回单帧 poster(静态,不播动画但不坏)
      var im = new Image();
      bitmaps[name] = null;
      return new Promise(function (res) { im.onload = res; im.onerror = res; im.src = d.src; });
    }
    var dec = new ImageDecoder({ data: bytes.buffer, type: 'image/webp' });
    return dec.tracks.ready.then(function () {
      var n = Math.min(dec.tracks.selectedTrack.frameCount, d.frames);
      var jobs = [];
      for (var f = 0; f < n; f++) {
        jobs.push(dec.decode({ frameIndex: f }).then(function (r) {
          return createImageBitmap(r.image).then(function (bm) {
            r.image.close();
            return bm;
          });
        }));
      }
      return Promise.all(jobs).then(function (list) { bitmaps[name] = list; });
    }).catch(function () {
      bitmaps[name] = null;  // 解码失败:静态兜底
    });
  }

  function getFrame(name, idx) {
    var list = bitmaps[name];
    if (!list) return null;          // 静态兜底:canvas 画不了帧,由上层画 poster img
    return list[idx % list.length];
  }

  function drawFrame(name, idx, alphaFrom, name2, idx2, alphaTo) {
    if (!CV) return;
    var ctx = CV.ctx;
    ctx.clearRect(0, 0, CV.W, CV.H);
    var a = getFrame(name, idx);
    if (a) {
      ctx.globalAlpha = alphaFrom;
      ctx.drawImage(a, 0, 0, CV.W, CV.H);
    }
    if (name2 && alphaTo > 0) {
      var b = getFrame(name2, idx2);
      if (b) {
        ctx.globalAlpha = alphaTo;
        ctx.drawImage(b, 0, 0, CV.W, CV.H);
      }
    }
    ctx.globalAlpha = 1;
  }

  // 主循环:rAF 驱动;setInterval 250ms 兜底(后台/特殊环境 rAF 冻结时画面仍推进)
  var lastTs = 0, frameAcc = 0;
  function tick(ts) {
    rafId = requestAnimationFrame(tick);
    if (!CV || tick._busy) return;
    tick._busy = true;
    try { tickBody(ts); } finally { tick._busy = false; }
  }
  function tickBody(ts) {
    var dt = lastTs ? (ts - lastTs) : 16;
    lastTs = ts;
    var d = segData(playHead.seg);
    if (!d) return;
    // 混合中:画 from 帧渐隐 + to 帧渐显
    if (mix) {
      var t = Math.min(1, (ts - mix.t0) / mix.dur);
      if (t >= 1) {
        playHead.seg = mix.toSeg;
        playHead.frame = 0;
        mix = null;
        drawFrame(playHead.seg, 0, 1);
        return;
      }
      var eased = t * t * (3 - 2 * t);  // smoothstep
      drawFrame(mix.fromSeg, mix.fromFrame, 1 - eased, mix.toSeg, 0, eased);
      return;
    }
    // 正常推进:按 fps
    frameAcc += dt;
    var step = 1000 / d.fps;
    while (frameAcc >= step) {
      frameAcc -= step;
      playHead.frame++;
      if (playHead.frame >= d.frames) {
        if (d.loop) playHead.frame = 0;
        else {
          // 单次段播完:定格最后帧,等段链定时器接下一段
          playHead.frame = d.frames - 1;
        }
      }
    }
    drawFrame(playHead.seg, playHead.frame, 1);
  }

  // 切段:发起混合(旧段当前帧 → 新段第0帧),懒解码目标段后启动
  function playSegment(name, thenPlay) {
    var d = segData(name);
    if (!d || !CV) return;
    clearSegTimers();
    activeSeg = name;
    decodeSegment(name).then(function () {
      if (!bitmaps[name]) {  // 静态兜底:直接换 img(should not happen on modern Edge)
        dog.src = d.src;
        return;
      }
      // v4.6.2:五段已首尾锚定(接缝差<1.5),段间直接切帧即无缝——去掉交叉混合的淡入感
      playHead.seg = name;
      playHead.frame = 0;
      mix = null;
      frameAcc = 0;
      drawFrame(name, 0, 1);
    });
  }

  // 播单次段后接 next
  function playOnce(name, next) {
    var d = segData(name);
    if (!d) return;
    playSegment(name);
    segTimers.push(setTimeout(function () {
      playSegment(next || 'idle');
    }, Math.round(d.frames / d.fps * 1000) + 460));
  }

  function playHopOnce() {
    if (segData('hop')) playOnce('hop', 'idle');
  }

  // 入睡链/唤醒链
  function goSleepAnim() {
    if (segData('toSleep')) playOnce('toSleep', 'sleep');
    else if (segData('sleep')) playSegment('sleep');
  }

  function wakeUpAnim() {
    if (segData('wakeUp')) playOnce('wakeUp', 'idle');
    else playSegment('idle');
  }

  function setSpriteFrame(n, holdMs) {
    if (!SPRITE) return;
    spriteFrame = n;
    frameHold = holdMs ? Date.now() + holdMs : 0;
    dog.style.backgroundPosition = (-n * SPRITE.w) + 'px center';
    if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
    if (holdMs) {
      frameTimer = setTimeout(function () {
        if (state !== 'sleep') setSpriteFrame(0, 0);  // 动作帧结束回 idle
      }, holdMs);
    }
  }

  // 呼吸循环:idle 帧随机时长,偶尔插一个 blink/tilt 小动作,像活物不走表
  function spriteBreathLoop() {
    if (!SPRITE) return;
    var wait = 2200 + Math.random() * 2600;
    setTimeout(function () {
      if (!SPRITE) return;
      if (state === 'sleep') { spriteBreathLoop(); return; }  // 睡觉不打断,由唤醒恢复
      if (Date.now() < frameHold) { spriteBreathLoop(); return; }  // 动作帧还没放完
      var r = Math.random();
      if (r < 0.62) setSpriteFrame(1, 320);          // 眨眼(高频,招牌)
      else if (r < 0.82) setSpriteFrame(2, 1100);    // 轻歪头
      else if (r < 0.92) setSpriteFrame(4, 1000);    // 抬爪打招呼
      // 剩 8% 什么都不做,黑一下再回来更自然
      spriteBreathLoop();
    }, wait);
  }

  function build() {
    injectStyle();
    root = document.createElement('div');
    root.className = 'duoli-root';
    // 形象优先级:视频循环(DUOLI_VIDEO) > 分层部件 > sprite sheet > 像素单图 > 手绘 SVG
    var MODE = window.DUOLI_VIDEO ? 'video'
             : window.DUOLI_PARTS ? 'parts'
             : window.DUOLI_SHEET_GPT ? 'sprite'
             : window.DUOLI_IMG ? 'img' : 'svg';
    var chatHead =
        '<div class="duoli-chat-head">' +
        '<span class="duoli-chat-title">小多利<small>站宠助手</small></span>' +
        '<button class="duoli-chat-btn" id="duoliClear" title="清空聊天记录">清空</button>' +
        '<button class="duoli-chat-btn" id="duoliClose" title="收起">×</button>' +
        '</div>';
    var chatBody =
        '<div class="duoli-msgs" aria-live="polite"></div>' +
        '<div class="duoli-chat-foot">' +
        '<input class="duoli-chat-input" id="duoliInput" placeholder="跟小多利说点什么…" maxlength="600">' +
        '<button class="duoli-chat-send" id="duoliSend">发送</button>' +
        '</div>';
    if (MODE === 'video') {
      V = window.DUOLI_VIDEO;
      root.innerHTML =
        '<div class="duoli-chat" role="dialog" aria-label="和小多利聊天">' + chatHead + chatBody + '</div>' +
        '<div class="duoli-bubble"></div>' +
        '<div class="duoli-zz">Z z z…</div>' +
        '<span class="duoli-dogwrap" role="img" aria-label="小多利">' +
        '<canvas class="duoli-dog" width="224" height="224"></canvas></span>' +
        '<span class="duoli-shadow"></span>';
      root.classList.add('duoli-videomode');
    } else if (MODE === 'parts') {
      root.innerHTML =
        '<div class="duoli-chat" role="dialog" aria-label="和小多利聊天">' +
        '<div class="duoli-chat-head">' +
        '<span class="duoli-chat-title">小多利<small>站宠助手</small></span>' +
        '<button class="duoli-chat-btn" id="duoliClear" title="清空聊天记录">清空</button>' +
        '<button class="duoli-chat-btn" id="duoliClose" title="收起">×</button>' +
        '</div>' +
        '<div class="duoli-msgs" aria-live="polite"></div>' +
        '<div class="duoli-chat-foot">' +
        '<input class="duoli-chat-input" id="duoliInput" placeholder="跟小多利说点什么…" maxlength="600">' +
        '<button class="duoli-chat-send" id="duoliSend">发送</button>' +
        '</div></div>' +
        '<div class="duoli-bubble"></div>' +
        '<div class="duoli-zz">Z z z…</div>' +
        '<span class="duoli-dogwrap" role="img" aria-label="小多利">' +
        '<span class="duoli-layer duoli-l-base"></span>' +
        '<span class="duoli-layer duoli-l-tail"></span>' +
        '<span class="duoli-layer duoli-l-upper"></span>' +
        '</span>' +
        '<span class="duoli-shadow"></span>';
      root.classList.add('duoli-partsmode');
    } else if (MODE === 'sprite') {
      SPRITE = window.DUOLI_SHEET_GPT;
      root.innerHTML =
        '<div class="duoli-chat" role="dialog" aria-label="和小多利聊天">' + chatHead + chatBody + '</div>' +
        '<div class="duoli-bubble"></div>' +
        '<div class="duoli-zz">Z z z…</div>' +
        '<span class="duoli-dogwrap"><span class="duoli-dog" role="img" aria-label="小多利"></span></span>' +
        '<span class="duoli-shadow"></span>';
      root.classList.add('duoli-spritemode');
    } else {
      var dogMarkup = window.DUOLI_IMG
        ? '<span class="duoli-dogwrap"><img class="duoli-dog" alt="小多利" src="' + window.DUOLI_IMG + '"></span>' +
          '<span class="duoli-shadow"></span>'
        : DOG_SVG;
      root.innerHTML =
        '<div class="duoli-chat" role="dialog" aria-label="和小多利聊天">' + chatHead + chatBody + '</div>' +
        '<div class="duoli-bubble"></div>' +
        '<div class="duoli-zz">Z z z…</div>' +
        dogMarkup;
      if (window.DUOLI_IMG) root.classList.add('duoli-imgmode');
    }
    document.body.appendChild(root);
    dog = root.querySelector('.duoli-dog');
    dogWrap = root.querySelector('.duoli-dogwrap');
    if (MODE === 'video' && V) {
      var cvEl = root.querySelector('canvas.duoli-dog');
      CV = { canvas: cvEl, ctx: cvEl.getContext('2d'), W: 224, H: 224 };
      playHead = { seg: 'sleep', frame: 0 };
      decodeSegment('sleep').then(function () {
        drawFrame('sleep', 0, 1);
        rafId = requestAnimationFrame(tick);
        setInterval(function () { tick(performance.now()); }, 250);  // rAF 冻结兜底
      });
      // 点击热区:canvas 上(旧 img 绑定点同样用 dog=canvas,无需改)
    }
    if (MODE === 'parts') {
      // 分层模式:部件按 512 画布坐标绝对定位到 136px 显示尺寸;dog 指 upper 层(事件感知操作它)
      var P = window.DUOLI_PARTS;
      var disp = 136, scale = disp / 512;
      var layers = {
        base: root.querySelector('.duoli-l-base'),
        upper: root.querySelector('.duoli-l-upper'),
        tail: root.querySelector('.duoli-l-tail')
      };
      Object.keys(layers).forEach(function (k) {
        var p = P[k];
        layers[k].style.backgroundImage = 'url("' + p.src + '")';
        layers[k].style.left = (p.x * scale) + 'px';
        layers[k].style.top = (p.y * scale) + 'px';
        layers[k].style.width = (p.w * scale) + 'px';
        layers[k].style.height = (p.h * scale) + 'px';
      });
      dog = layers.upper;  // 视线跟随等事件感知直接操作 upper 层
      dogWrap = root.querySelector('.duoli-dogwrap');
    }
    if (SPRITE) {
      dog.style.backgroundImage = 'url("' + SPRITE.src + '")';
      dog.style.backgroundSize = (SPRITE.w * SPRITE.frames) + 'px ' + SPRITE.h + 'px';
      // 高 132px 显示,按显示比例换算 background-position 单位
      var scale = 132 / SPRITE.h;
      dog.style.backgroundSize = (SPRITE.w * SPRITE.frames * scale) + 'px 132px';
      var sw = SPRITE.w * scale;
      setSpriteFrame(0, 0);
      // 切帧坐标用显示宽度
      var _origSetFrame = setSpriteFrame;
      setSpriteFrame = function (n, holdMs) {
        spriteFrame = n;
        frameHold = holdMs ? Date.now() + holdMs : 0;
        dog.style.backgroundPosition = (-n * sw) + 'px center';
        if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
        if (holdMs) {
          frameTimer = setTimeout(function () {
            if (state !== 'sleep') { spriteFrame = 0; frameHold = 0; dog.style.backgroundPosition = '0px center'; }
          }, holdMs);
        }
      };
      spriteBreathLoop();
    }
    bubble = root.querySelector('.duoli-bubble');
    chat = root.querySelector('.duoli-chat');
    msgsEl = root.querySelector('.duoli-msgs');
    inputEl = root.querySelector('#duoliInput');
    sendEl = root.querySelector('#duoliSend');
    zzEl = root.querySelector('.duoli-zz');
    zzEl.style.display = 'none';

    dog.addEventListener('click', onDogClick);
    root.querySelector('#duoliClose').addEventListener('click', toggleChat);
    root.querySelector('#duoliClear').addEventListener('click', clearHistory);
    sendEl.addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    root.addEventListener('pointerdown', touch);

    restoreHistory();
    scheduleIdleFun();
    scheduleSleepCheck();
    attachAwareness();  // 事件感知:视线跟鼠标/打字抬头(快档的灵魂)
  }

  // ---------- 状态机 ----------
  function setState(name, holdMs) {
    state = name;
    root.classList.remove('duoli-happy', 'duoli-think', 'duoli-sleep', 'duoli-look', 'duoli-lean');
    if (name !== 'idle') root.classList.add('duoli-' + name);
    zzEl.style.display = name === 'sleep' ? 'block' : 'none';
    if (V && segData('idle')) {
      // canvas 播放器:过渡链切段——睡=toSleep→sleep,醒/其他=wakeUp 或直接 idle
      if (name === 'sleep') {
        goSleepAnim();
      } else if (playHead.seg === 'sleep' || playHead.seg === 'toSleep') {
        wakeUpAnim();
      } else if (playHead.seg !== 'idle' && playHead.seg !== 'hop') {
        playSegment('idle');
      }
    }
    if (SPRITE) {
      // sprite 模式:状态直接驱动帧(think→tilt 常驻、happy→tongue、sleep→idle 帧+灰化)
      if (name === 'think') setSpriteFrame(2, 0);
      else if (name === 'happy') setSpriteFrame(3, 0);
      else if (name === 'sleep') { setSpriteFrame(0, 0); dog.style.transform = ''; }
      else setSpriteFrame(0, 0);
    }
    // partsmode:姿态全由 CSS 类驱动(上面已加/去 duoli-* 类);视线跟随的内联 transform 要清
    if (window.DUOLI_PARTS) {
      if (name === 'sleep') {
        dog.style.setProperty('--dl-look', '0deg');
        if (burstTimer) { clearTimeout(burstTimer); burstTimer = null; }
        var t = root.querySelector('.duoli-l-tail');
        if (t) t.classList.remove('dl-burst');
      }
      dog.style.transform = '';
    }
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    if (holdMs) {
      stateTimer = setTimeout(function () { setState('idle'); }, holdMs);
    }
  }

  function touch() { lastActive = Date.now(); }  // v4.1:唤醒只由点击触发(onDogClick→awaken)

  // ---------- 事件感知(主流桌宠的灵魂:它知道你在干什么) ----------
  var AWAKENED_TIP_SHOWN = false;
  function awaken(reason) {
    lastActive = Date.now();
    if (state === 'sleep') {
      // v4.1:唤醒只起身不乱跳;wakeUp 链(仰躺→爬起→坐)由 setState('idle') 触发;
      // happy 兴奋态去掉(用户:起来后就是和现在一样的坐着状态)
      setState('idle');
      if (!AWAKENED_TIP_SHOWN && reason === 'click') {
        AWAKENED_TIP_SHOWN = true;
        say('汪!有什么想问的?', 3400);
      }
    }
  }

  function attachAwareness() {
    if (!V && !window.DUOLI_PARTS && !SPRITE) return;  // 旧形象保持原样
    var rafPending = false;
    var lastLook = 0;

    // 1) 视线跟随:video/partsmode 改 CSS 变量 --dl-look;spritemode 内联 transform
    //    v4.1:mousemove 不再刷新 lastActive(不点就不醒),也不唤醒睡觉
    document.addEventListener('mousemove', function (e) {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        if (state === 'sleep') return;
        var r = root.getBoundingClientRect();
        var dx = e.clientX - (r.left + r.width / 2);
        var nx = Math.max(-1, Math.min(1, dx / 320));
        if (window.DUOLI_PARTS) {
          var look = nx * 2.6;  // 分层:叠加在呼吸摆上
          if (Math.abs(look - lastLook) > 0.25) {
            lastLook = look;
            dog.style.setProperty('--dl-look', look.toFixed(2) + 'deg');
          }
        } else if (SPRITE) {
          var rot = nx * 4.2;
          var lift = -1;
          if (Math.abs(rot - lastLook) > 0.35) {
            lastLook = rot;
            dog.style.transform = 'rotate(' + rot.toFixed(1) + 'deg) translateY(' + lift + 'px)';
          }
        }
      });
    }, { passive: true });

    // 2) 打字抬头:partsmode 切 think 类(upper 歪头姿态 1.6s);spritemode 切 tilt 帧
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var isInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!isInput) return;
      if (t === inputEl) return;  // 跟小多利自己聊天时不用反应
      // v4.1:打字不唤醒睡狗;醒着时也不额外打扰(安静坐着)
      if (state === 'sleep') return;
      if (window.DUOLI_PARTS) {
        if (state === 'idle') {
          setState('think');
          clearTimeout(attachAwareness._tt);
          attachAwareness._tt = setTimeout(function () { if (state === 'think') setState('idle'); }, 1700);
        }
      } else if (SPRITE) {
        if (Date.now() >= frameHold && spriteFrame !== 2) setSpriteFrame(2, 1400);
        dog.style.transform = 'rotate(0deg) translateY(-4px)';
        clearTimeout(attachAwareness._tt);
        attachAwareness._tt = setTimeout(function () {
          if (state === 'idle') dog.style.transform = '';
        }, 1600);
      }
    }, true);

    // v4.1:focus 不再唤醒(不点默认睡)
  }

  // v4.2.2:醒着 20 秒没人理 → 重新躺下睡;聊天面板开着不睡。
  // lastActive 只被 点击(onDogClick→touch/awaken) 刷新——鼠标移动/打字都不算"有动静"
  function scheduleSleepCheck() {
    setInterval(function () {
      if (state === 'idle' && !chatOpen && Date.now() - lastActive > 20000) {
        console.log('[duoli] 20s 冷落 → 入睡');
        setState('sleep');
        if (SPRITE) setSpriteFrame(0, 0);
      }
    }, 2000);
  }

  function onDogClick() {
    touch();
    if (chatOpen) { toggleChat(); return; }
    // v4.1 行为:点击 = 摸摸头唤醒——睡着则起身(wakeUp→idle 坐姿);醒着则开聊天面板
    if (state === 'sleep') {
      awaken('click');
      return;
    }
    toggleChat(true);
    if (SPRITE) setSpriteFrame(3, 2200);
    if (window.DUOLI_PARTS) tailBurst();
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  var bubbleTimer = null;
  function say(text, holdMs) {
    bubble.textContent = text;
    bubble.classList.add('duoli-on');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    if (holdMs) bubbleTimer = setTimeout(function () { bubble.classList.remove('duoli-on'); }, holdMs);
  }

  // ---------- 尾巴爆发段:加 .dl-burst 播一段摇尾(2.1s)后自动归位 ----------
  var burstTimer = null;
  function tailBurst() {
    if (!window.DUOLI_PARTS || state === 'sleep') return;
    var t = root.querySelector('.duoli-l-tail');
    if (!t) return;
    t.classList.remove('dl-burst');
    void t.offsetWidth;
    t.classList.add('dl-burst');
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = setTimeout(function () { t.classList.remove('dl-burst'); }, 2150);
  }

  // ---------- 视线变量微调(临时看向某处再回正) ----------
  var lookNudgeTimer = null;
  function lookNudge(deg, holdMs) {
    if (!window.DUOLI_PARTS) return;
    dog.style.setProperty('--dl-look', deg.toFixed(1) + 'deg');
    if (lookNudgeTimer) clearTimeout(lookNudgeTimer);
    lookNudgeTimer = setTimeout(function () {
      if (state === 'idle') dog.style.setProperty('--dl-look', '0deg');
    }, holdMs || 1400);
  }

  // v4.1:闲时小动作停用(醒着=安静坐姿,视频循环自带呼吸);函数保留防旧引用
  function scheduleIdleFun() { return; /* v4.1 */
    setTimeout(function () {
      if (state === 'idle' && !chatOpen && Date.now() - lastActive > 12000) {
        if (window.DUOLI_PARTS) {
          var r = Math.random();
          if (r < 0.5) tailBurst();                              // 摇一小段尾巴
          else if (r < 0.72) lookNudge((Math.random() - 0.5) * 3.6);  // 朝旁边看一眼
          else if (r < 0.9) setState('happy', 2000);             // 兴奋一下(快摇)
          else say(pick(BARKS), 3000);
        } else {
          var r2 = Math.random();
          if (r2 < 0.3) {
            root.classList.add('duoli-look');
            setTimeout(function () { root.classList.remove('duoli-look'); }, 2400);
          } else if (r2 < 0.55) {
            root.classList.add('duoli-lean');
            setTimeout(function () { root.classList.remove('duoli-lean'); }, 1700);
          } else if (r2 < 0.75) {
            setState('happy', 2200);
          } else {
            say(pick(BARKS), 3000);
          }
        }
      }
      scheduleIdleFun();
    }, 9000 + Math.random() * 14000);
  }

  // ---------- 聊天面板 ----------
  function toggleChat(force) {
    touch();
    var want = typeof force === 'boolean' ? force : !chatOpen;
    if (want === chatOpen) return;
    chatOpen = want;
    chat.classList.toggle('duoli-on', chatOpen);
    if (chatOpen) {
      bubble.classList.remove('duoli-on');
      setState('happy', 2000);
      renderHistory();
      if (!history.length) {
        var tip = PAGE_TIPS[pageKey === 'gen' ? 'gen:' + genKind : pageKey];
        addMsg('duoli-dog-msg', tip || PAGE_TIPS.index);
      }
      setTimeout(function () { inputEl.focus(); }, 320);
    }
  }

  function restoreHistory() {
    try {
      var raw = sessionStorage.getItem('ffDuoliChat');
      if (raw) history = JSON.parse(raw) || [];
    } catch (e) { history = []; }
    if (!Array.isArray(history)) history = [];
  }

  function saveHistory() {
    try {
      if (history.length > 30) history = history.slice(-30);
      sessionStorage.setItem('ffDuoliChat', JSON.stringify(history));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function clearHistory() {
    history = [];
    saveHistory();
    msgsEl.innerHTML = '';
    addMsg('duoli-dog-msg', '聊天的记忆清空啦!我们重新开始,汪~');
  }

  function renderHistory() {
    msgsEl.innerHTML = '';
    history.forEach(function (m) {
      addMsg(m.role === 'user' ? 'duoli-me' : 'duoli-dog-msg', m.content, true);
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function addMsg(cls, text, silent) {
    var div = document.createElement('div');
    div.className = 'duoli-msg ' + cls;
    div.textContent = text;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    if (!silent && cls === 'duoli-dog-msg') {
      history.push({ role: 'assistant', content: text });
      saveHistory();
    }
    return div;
  }

  function errMsgFor(code) {
    return ERR_TEXT[code] || ('呜……出了点小状况(' + code + '),稍后再试?');
  }

  function send() {
    if (busy) return;
    var text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    touch();
    addMsg('duoli-me', text);
    history.push({ role: 'user', content: text });
    saveHistory();

    busy = true;
    sendEl.disabled = true;
    setState('think');
    var typing = document.createElement('div');
    typing.className = 'duoli-msg duoli-dog-msg';
    typing.innerHTML = '<span class="duoli-typing"><i></i><i></i><i></i></span>';
    msgsEl.appendChild(typing);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    // 邀请码:gate.js 页在 window.FFGate.code;gen.html 页存 sessionStorage,同一把码
    var code = '';
    try {
      code = (window.FFGate && window.FFGate.code) || sessionStorage.getItem('ffGenInvite') || '';
    } catch (e) { /* 忽略 */ }

    fetch('/api/duoli/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authorization': 'Bearer ' + code },
      body: JSON.stringify({
        messages: history.slice(-16),
        page: (pageKey === 'gen' ? 'gen:' + genKind : pageKey)
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (payload) {
        return { ok: r.ok, status: r.status, payload: payload };
      });
    }).then(function (result) {
      typing.remove();
      busy = false;
      sendEl.disabled = false;
      var p = result.payload || {};
      if (result.ok && p.ok && p.reply) {
        addMsg('duoli-dog-msg', p.reply);
        setState('happy', 4000);
      } else if (result.status === 401 || p.error === 'invalid_invite_code') {
        addMsg('duoli-err', errMsgFor('invalid_invite_code'));
        setState('idle');
      } else if (result.status === 403 || p.error === 'invite_locked') {
        addMsg('duoli-err', errMsgFor('invite_locked'));
        setState('idle');
      } else if (p.error === 'rate_limit') {
        addMsg('duoli-dog-msg', errMsgFor('rate_limit'));
        setState('idle');
      } else {
        addMsg('duoli-dog-msg', errMsgFor(p.error || ('http_' + result.status)));
        setState('idle');
      }
    }).catch(function () {
      typing.remove();
      busy = false;
      sendEl.disabled = false;
      addMsg('duoli-dog-msg', '呜……网络打了个喷嚏,没听清你说什么,再说一遍?');
      setState('idle');
    });
  }

  // ---------- 等门禁过了再露面 ----------
  // index:#appMain;gen/drama:#app;cutout/layer/compress/spine:内容常显、门禁是覆盖层,
  // 看 #gateOverlay 是否已被 gate.js 收起。
  function pageReady() {
    var a = document.getElementById('appMain');
    if (a && !a.hidden) return true;
    var b = document.getElementById('app');
    if (b && !b.hidden) return true;
    var overlay = document.getElementById('gateOverlay');
    if (overlay) return overlay.hidden === true;
    return false;
  }

  var shown = false;
  var probeTimer = setInterval(function () {
    if (!pageReady()) return;
    clearInterval(probeTimer);
    if (shown) return;
    shown = true;
    build();
    // 同步加显示类;进场即睡觉(v4.1 行为:点了才起来)
    root.classList.add('duoli-show');
    setState('sleep');
    setTimeout(function () {
      var tip = PAGE_TIPS[pageKey === 'gen' ? 'gen:' + genKind : pageKey];
      say(tip || PAGE_TIPS.index, 9000);
    }, 1200);
  }, 400);
})();
