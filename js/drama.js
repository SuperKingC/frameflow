// FrameFlow - 短剧工作台:剧本→分镜(LLM)→角色定妆→逐镜首帧/成片→ffmpeg 合成
// 门禁复用 gate.js(与生图/生视频同一把码,sessionStorage 静默直进)。
// 生成走 /api/studio/tasks(额度/重试语义零改动):提交后把任务 id 挂到镜头/角色上,轮询成功后
// 立刻把素材 POST 回 /api/drama/projects/<pid>/asset 落盘。studio v0.5 成功快照的 data 项是
// {"file","mime"}(结果已在本机磁盘),落盘时带 taskId/index 让服务端直读磁盘——不能拼回环
// URL 让服务端自取(会被代取的 SSRF 防护拒绝);兼容旧形状(b64_json / url)。
// 素材统一从 /api/drama/projects/<pid>/asset/<rel> 提供。
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };
  let BUSY = false;   // 分镜等长 LLM 请求进行中:锁全部生成入口,防误触中断导致"网络错误"

  function setBusy(on, msg) {
    BUSY = on;
    ['btnStoryboard', 'btnRunAll', 'btnCompose', 'btnNew', 'btnDelProj', 'btnAddShot', 'btnAddChar',
     'btnIdea', 'btnBrainstorm', 'btnClearShots', 'projSel']
      .forEach(function (id) {
        const elx = $('#' + id);
        if (elx) elx.disabled = !!on;
      });
    if (on && msg) status(msg + '(期间已锁定其它操作,请稍候)');
  }
  const IMG_MODEL = 'openai/gpt-5.4-image-2';
  const VID_MODEL = 'kwaivgi/kling-v3.0-pro';

  let PROJECTS = [];
  let CUR = null;        // 当前项目(服务端全量快照;剧→集→镜三层,shots 挂在 episodes[].shots)
  let CUR_EP = null;     // 当前集 id(localStorage 按项目记忆)
  let META = { styles: [], ideas: [], linesIdeas: [], voices: [] };
  let VID_DURATIONS = [5, 10];   // 当前视频模型的 supported_durations(动态更新)
  const poll = {};       // studio taskId -> { kind:'first'|'clip'|'portrait'|'trait', id, startedAt }
  const COLLAPSED = new Set();   // 收起状态的镜头 id(会话级:刷新恢复展开)
  const LOGS = [];               // 任务进度日志(所有 status 同步进这里,面板可展开看全部)
  let LOG_OPEN = false;          // 展开态(localStorage 记忆)
  let pendingRender = false;
  let jobTimer = null;           // 服务端后台任务(compose/tts)轮询定时器
  const SUB_TIMES = [];          // 提交时间戳(串跑滑窗限流:opt 池 3 次/分钟)
  let charRefTarget = null;   // 文件选择器当前服务的角色 id
  let charRefInput = null;    // 由 init 创建(drama.html 中声明)

  const ERRORS = {
    invalid_invite_code: '邀请码不正确',
    invite_locked: '今日已锁定,请明天再试',
    rate_limit_exceeded: '触发限流,请稍后再试',
    invalid_prompt: '提示词为空或超长',
    invalid_model: '模型未启用',
    invalid_aspect_ratio: '不支持的比例',
    invalid_image_size: '不支持的尺寸',
    invalid_duration: '不支持的视频时长',
    invalid_resolution: '不支持的分辨率',
    invalid_frame_mode: '首帧模式需要 1 张参考图',
    invalid_reference_images: '参考图最多 5 张',
    invalid_reference_image: '参考图格式不支持',
    invalid_reference_image_size: '参考图超过 2MB',
    task_not_found: '任务不存在或已过期',
    task_pool_full: '任务池已满,请稍后再试',
    upstream_rejected: '上游拒绝了本次生成',
    upstream_unavailable: '上游暂不可用',
    upstream_invalid_response: '上游响应异常',
    interrupted: '服务重启导致任务中断,请重试',
  };

  function status(msg, isError) {
    const elx = $('#status');
    elx.textContent = msg;
    elx.classList.toggle('error', !!isError);
    log(msg, isError);
  }

  // 任务进度:status 每次都会把消息带时间戳写进 LOGS;面板常显最新一条,可展开看全部
  function log(msg, isError) {
    LOGS.push({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                msg: msg, err: !!isError });
    if (LOGS.length > 80) LOGS.shift();
    renderLog();
  }

  function renderLog() {
    const panel = $('#logPanel');
    if (!panel) return;
    const latest = LOGS[LOGS.length - 1];
    const latestEl = $('#logLatest');
    latestEl.textContent = latest ? (latest.t + '  ' + latest.msg) : '就绪';
    latestEl.classList.toggle('err', !!(latest && latest.err));
    $('#logCount').textContent = LOGS.length ? ('(共 ' + LOGS.length + ' 条)') : '';
    $('#logToggle').textContent = LOG_OPEN ? '收起 ▴' : '展开 ▾';
    panel.classList.toggle('open', LOG_OPEN);
    const list = $('#logList');
    list.textContent = '';
    if (LOG_OPEN) {
      LOGS.slice().reverse().forEach(function (l) {
        const line = el('div', 'log-line' + (l.err ? ' err' : ''));
        line.appendChild(el('span', 't', l.t));
        line.appendChild(document.createTextNode(l.msg));
        list.appendChild(line);
      });
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function AUTH() {
    return { 'content-type': 'application/json',
             authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') };
  }

  function assetURL(rel) {
    return '/api/drama/projects/' + CUR.id + '/asset/' + rel;
  }

  // 当前集:CUR_EP 指向有效集,失效回退第 1 集;切换时记 localStorage(按项目隔离)
  function curEp() {
    if (!CUR) return null;
    const eps = CUR.episodes || [];
    let ep = eps.find(function (e) { return e.id === CUR_EP; });
    if (!ep) {
      ep = eps[0] || null;
      CUR_EP = ep ? ep.id : null;
    }
    return ep;
  }

  function rememberEp() {
    if (CUR && CUR_EP) {
      try { localStorage.setItem('ffDramaEp:' + CUR.id, CUR_EP); } catch (e) { /* 隐私模式 */ }
    }
  }

  function totalShots() {
    return (CUR && CUR.episodes || []).reduce(function (n, e) { return n + (e.shots || []).length; }, 0);
  }

  // 跨集找镜头(单镜接口服务端也跨集定位;前端查找用于状态/索引)
  function findShotEverywhere(sid) {
    for (const e of (CUR && CUR.episodes || [])) {
      const s = (e.shots || []).find(function (x) { return x.id === sid; });
      if (s) return { ep: e, shot: s };
    }
    return { ep: null, shot: null };
  }

  function dGET(path) {
    return fetch('/api/drama/projects' + path, { headers: AUTH() })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
      });
  }

  function dPOST(path, body) {
    return fetch('/api/drama/projects' + path, {
      method: 'POST', headers: AUTH(), body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
    });
  }

  function studioSubmit(body) {
    return fetch('/api/studio/tasks', {
      method: 'POST', headers: AUTH(), body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
    });
  }

  function refreshQuota() {
    fetch('/api/studio/quota', { headers: AUTH() })
      .then(function (r) { return r.json(); })
      .then(function (q) {
        if (!q || q.error) return;
        $('#quotaLine').innerHTML = '剩余额度:图 <b>' + q.imageRemaining + '</b>/日 · 视频 <b>'
          + q.videoRemaining + '</b>/日 · 本分钟 <b>' + q.minuteRemaining + '/' + q.perMinuteLimit + '</b>';
      }).catch(function () { /* 静默 */ });
  }

  // 渲染保护:用户正在输入(text/select 类元素持焦点)时不整树重渲染,失焦后补。
  // 注意:按钮焦点不算"输入"——否则点折叠钮等只读控件会被误判挂起,看起来"点了没反应"。
  function editingBusy() {
    const ae = document.activeElement;
    return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')
      && ($('#shotList').contains(ae) || $('#charList').contains(ae) || $('#projForm').contains(ae)));
  }

  function safeRender() {
    if (editingBusy()) { pendingRender = true; return; }
    pendingRender = false;
    renderAll();
  }

  document.addEventListener('focusout', function () {
    if (!pendingRender) return;
    setTimeout(function () { if (!editingBusy()) safeRender(); }, 80);
  });

  function applyP(res, okMsg) {
    if (!res || !res.ok || !res.p.ok || !res.p.project) {
      status('操作失败:' + ((res && res.p && res.p.error) || '未知错误'), true);
      return;
    }
    CUR = res.p.project;
    safeRender();
    syncSelTitle();
    if (okMsg) status(okMsg);
  }

  function syncSelTitle() {
    if (!CUR) return;
    const o = $('#projSel').querySelector('option[value="' + CUR.id + '"]');
    if (o) o.textContent = CUR.title + '(' + (CUR.episodes || []).length + '集'
      + totalShots() + '镜)';
  }

  // ---------- 项目 ----------
  function loadProjects(selectId) {
    dGET('').then(function (res) {
      if (!res.ok || !res.p.ok) { status('项目列表加载失败:' + (res.p.error || ''), true); return; }
      PROJECTS = res.p.projects || [];
      const sel = $('#projSel');
      sel.textContent = '';
      PROJECTS.forEach(function (p) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.title + '(' + (p.episodeCount || 1) + '集/' + p.shotCount + '镜)';
        sel.appendChild(o);
      });
      // 记住最后打开的项目:刷新后回到刚才在编辑的那部剧,而不是列表第一个
      let lastId = null;
      try { lastId = localStorage.getItem('ffDramaLast'); } catch (e) { lastId = null; }
      const want = selectId
        || (lastId && PROJECTS.some(function (x) { return x.id === lastId; }) ? lastId : null)
        || (PROJECTS[0] && PROJECTS[0].id);
      if (want) {
        sel.value = want;
        loadProject(want);
      } else {
        CUR = null;
        renderAll();
        status('还没有项目:点「新建」开始一部短剧');
      }
    }).catch(function () { status('项目列表加载失败:网络错误', true); });
  }

  function loadProject(pid) {
    try { localStorage.setItem('ffDramaLast', pid); } catch (e) { /* 隐私模式忽略 */ }
    dGET('/' + pid).then(function (res) {
      if (!res.ok || !res.p.ok) { status('项目加载失败:' + (res.p.error || ''), true); return; }
      CUR = res.p.project;
      // 恢复上次编辑的集(按项目记忆;失效由 curEp() 回退第 1 集)
      try { CUR_EP = localStorage.getItem('ffDramaEp:' + pid) || null; } catch (e) { CUR_EP = null; }
      const ep = curEp();
      if (ep) rememberEp();
      renderAll();
      status('已加载「' + CUR.title + '」' + (ep ? ' · ' + ep.title : ''));
    }).catch(function () { status('项目加载失败:网络错误', true); });
  }

  function saveProj(opts) {
    if (!CUR) return Promise.resolve(null);
    // 本集梗概随项目信息一起保存(当前集存在时);失败不挡剧级保存
    const ep = curEp();
    const epSync = (ep && $('#epSynopsis') && $('#epSynopsis').value.trim() !== (ep.synopsis || ''))
      ? dPOST('/' + CUR.id + '/eps/' + ep.id + '/update', { synopsis: $('#epSynopsis').value })
      : Promise.resolve(null);
    return epSync.then(function () {
      return dPOST('/' + CUR.id + '/update', {
        title: $('#pTitle').value, logline: $('#pLogline').value,
        style: $('#pStyle').value, aspect: $('#pAspect').value, beat: $('#pBeat').value,
      });
    }).then(function (res) {
      if (!res || !res.ok || !res.p.ok) {
        if (res) status('保存失败:' + (res.p.error || ''), true);
        return null;
      }
      CUR = res.p.project;
      syncSelTitle();
      if (!opts || !opts.silent) { status('项目信息已保存'); }
      return CUR;
    });
  }

  // 高级模式:默认开(露出首帧/运动提示词框);关掉只留画面描述,改描述时自动 reprompt 派生
  let ADVANCED = true;
  try { ADVANCED = localStorage.getItem('ffDramaAdvanced') !== '0'; } catch (e) { /* 无痕模式 */ }

  // ---------- 渲染 ----------
  function renderAll() {
    const has = !!CUR;
    $('#projForm').hidden = !has;
    ['btnAddChar', 'btnCompose', 'btnPlayAll', 'btnAddShot', 'btnStoryboard', 'btnDelProj', 'btnIdea', 'btnRunAll', 'btnClearShots', 'btnRemix']
      .forEach(function (id) { $('#' + id).hidden = !has; });
    $('#epTabs').hidden = !has;
    $('#epSynRow').hidden = !has;
    const empty = $('#shotEmpty');
    if (!has) {
      $('#charList').textContent = '';
      $('#epTabs').textContent = '';
      $('#shotList').textContent = '';
      $('#composedBox').textContent = '';
      $('#epSynopsis').value = '';
      empty.hidden = false;
      empty.textContent = '还没有项目:点左侧「新建」开始一部短剧。';
      return;
    }
    $('#pTitle').value = CUR.title || '';
    $('#pLogline').value = CUR.logline || '';
    $('#pStyle').value = CUR.style || '';
    $('#pAspect').value = CUR.aspect || '9:16';
    $('#pBeat').value = CUR.beat || '';
    $('#pNShots').value = String($('#pNShots').value || '6');
    $('#pAdvanced').checked = ADVANCED;
    // pWithLines 不由 renderAll 重置:它是「本次起草」选项,勾选态只在页面加载时默认开
    const ep = curEp();
    $('#epSynopsis').value = (ep && ep.synopsis) || '';
    // P0-4: 前情提要展示(下集分镜自动注入)+ 手改入口(空串=清除,重生成走 LLM)
    const rc = $('#epRecapLine');
    if (rc) {
      rc.textContent = '';
      if (ep && ep.recap) {
        rc.hidden = false;
        rc.appendChild(document.createTextNode('前情提要(下集分镜自动注入):' + ep.recap));
        const edit = el('button', 'btn', '✎');
        edit.style.marginLeft = '6px';
        edit.title = '手改/清空本集前情提要;清空后点此重填会重新用 AI 压缩';
        edit.addEventListener('click', function () {
          if (!CUR || !ep) return;
          const t = prompt('手改本集前情提要(留空则清除;清除后再点「✎」会重新用 AI 生成)', ep.recap || '');
          if (t === null) return;
          dPOST('/' + CUR.id + '/recap', { eid: ep.id, text: t }).then(function (res) {
            if (res.ok && res.p.ok) { CUR = res.p.project; safeRender(); status(t.trim() ? '前情提要已保存' : '前情提要已清除'); }
            else status('前情提要保存失败:' + (res.p.error || ''), true);
          });
        });
        rc.appendChild(edit);
      } else {
        rc.hidden = true;
      }
    }
    empty.hidden = !!(ep && ep.shots.length > 0);
    empty.textContent = '本集还没有镜头:填好左侧「一句话故事/本集梗概」后点「✨ 生成分镜」,或「+ 手动加镜」。';
    renderStyleChips();
    renderEpTabs();
    renderChars();
    renderShots();
    renderComposed();
    renderRemix();
    renderCostLine();
    // 恢复进行中的 studio 任务(全剧集扫一遍;素材落盘跨集定位)
    (CUR.episodes || []).forEach(function (e) {
      (e.shots || []).forEach(function (s) {
        if (s.firstTaskId && !poll[s.firstTaskId]) poll[s.firstTaskId] = { kind: 'first', id: s.id, startedAt: Date.now() };
        if (s.clipTaskId && !poll[s.clipTaskId]) poll[s.clipTaskId] = { kind: 'clip', id: s.id, startedAt: Date.now() };
      });
    });
    (CUR.chars || []).forEach(function (c) {
      if (c.portraitTaskId && !poll[c.portraitTaskId]) poll[c.portraitTaskId] = { kind: 'portrait', id: c.id, startedAt: Date.now() };
      if (c.traitTaskId && !poll[c.traitTaskId]) poll[c.traitTaskId] = { kind: 'trait', id: c.id, startedAt: Date.now() };
    });
    // 恢复服务端后台任务轮询(compose/tts 现在异步,状态在 project.json 里)
    pollDramaJobs();
  }

  // ---------- 剧集 tabs(剧→集→镜) ----------
  function renderEpTabs() {
    const box = $('#epTabs');
    box.textContent = '';
    const ep = curEp();
    (CUR.episodes || []).forEach(function (e, i) {
      const t = el('button', 'ep-tab' + (ep && e.id === ep.id ? ' on' : ''));
      t.type = 'button';
      t.appendChild(el('b', null, e.title || ('第' + (i + 1) + '集')));
      t.appendChild(el('span', 'n', (e.shots || []).length + '镜' + (e.composed ? ' · 已合成' : '')));
      t.addEventListener('click', function () {
        if (CUR_EP === e.id) return;
        CUR_EP = e.id;
        rememberEp();
        safeRender();
      });
      box.appendChild(t);
    });
    const add = el('button', 'ep-tab add', '+ 新集');
    add.type = 'button';
    add.title = '新建一集(角色库与全剧设定自动复用)';
    add.addEventListener('click', function () {
      dPOST('/' + CUR.id + '/eps/add', {}).then(function (res) {
        if (!res.ok || !res.p.ok) { status('新建集失败:' + (res.p.error || ''), true); return; }
        CUR = res.p.project;
        CUR_EP = res.p.episodeId;
        rememberEp();
        safeRender();
        status('已新建 ' + (CUR.episodes.length) + ' 集所在:填本集梗概后直接「✨ 生成分镜」,角色自动沿用');
      });
    });
    box.appendChild(add);
    // P0-3: 生成分集大纲——按全剧梗概一次产出 N 集,批量建集+填梗概(逐集可再手改)
    const ol = el('button', 'ep-tab ops', '⚡ 生成分集大纲');
    ol.type = 'button';
    ol.title = '按全剧梗概一次性生成 N 集大纲(每集标题+梗概),批量建集;每集可再手改后分镜';
    ol.addEventListener('click', function () {
      if (!CUR || BUSY) return;
      if (!$('#pLogline').value.trim() && !(CUR.logline || '').trim()) {
        status('先填一句话故事(全剧梗概),才能生成分集大纲', true); return;
      }
      const nStr = prompt('要生成几集的大纲?(2~20)', '6');
      if (nStr === null) return;
      const n = Math.max(2, Math.min(20, parseInt(nStr, 10) || 6));
      saveProj({ silent: true }).then(function (cur) {
        if (!cur) return;
        ol.disabled = true;
        status('AI 生成分集大纲中…(N=' + n + ',约 10~30 秒)');
        return fetch('/api/drama/projects/' + CUR.id + '/outline', {
          method: 'POST', headers: AUTH(), body: JSON.stringify({ nEps: n }),
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
        });
      }).then(function (res) {
        ol.disabled = false;
        if (!res) return;
        if (!res.ok || !res.p.ok) { status('分集大纲失败:' + (res.p.error || '未知错误'), true); return; }
        const eps = res.p.eps || [];
        if (!eps.length) { status('大纲为空:再试一次', true); return; }
        // 已有多集时询问:追加还是覆盖(保留第 1 集的已生成内容)
        const have = (CUR.episodes || []).length;
        let startIdx = 0;
        if (have > 1 && !confirm('项目已有 ' + have + ' 集。点「确定」把大纲填进这些集(覆盖标题/梗概,镜头保留);点「取消」改为追加新集。')) {
          startIdx = have;
        }
        // 串行建集/更新(每集一次请求;失败继续后面的)
        let done = 0; let fail = 0;
        const apply = function (i) {
          if (i >= eps.length) {
            safeRender();
            status('分集大纲完成:共 ' + done + ' 集填好标题/梗概' + (fail ? '(' + fail + ' 集失败,可手改补)' : '')
              + ';逐集检查后点「✨ 生成分镜」展开');
            return;
          }
          const e = eps[i];
          const pid = CUR.id;
          const then = function (res) {
            if (res && res.ok && res.p && res.p.ok) { CUR = res.p.project; done++; }
            else fail++;
            apply(i + 1);
          };
          if (startIdx + i < have) {
            const epId = (CUR.episodes || [])[startIdx + i].id;
            dPOST('/' + pid + '/eps/' + epId + '/update', { title: e.title, synopsis: e.synopsis }).then(then);
          } else {
            dPOST('/' + pid + '/eps/add', {}).then(function (res) {
              if (!res.ok || !res.p.ok) { fail++; apply(i + 1); return; }
              CUR = res.p.project;
              const newEp = (CUR.episodes || [])[startIdx + i] || CUR.episodes[CUR.episodes.length - 1];
              dPOST('/' + pid + '/eps/' + newEp.id + '/update', { title: e.title, synopsis: e.synopsis }).then(then);
            });
          }
        };
        apply(0);
      }).catch(function () {
        ol.disabled = false;
        status('分集大纲请求失败:网络错误', true);
      });
    });
    box.appendChild(ol);
    if (ep) {
      const rename = el('button', 'ep-tab ops', '✎');
      rename.type = 'button';
      rename.title = '重命名本集 / 编辑本集梗概(梗概会注入分镜)';
      rename.addEventListener('click', function () {
        const t = prompt('本集标题', ep.title || '');
        if (t === null) return;
        const syn = prompt('本集梗概(可空;分镜起草时会注入,衔接全剧)', ep.synopsis || '');
        dPOST('/' + CUR.id + '/eps/' + ep.id + '/update', { title: t, synopsis: syn || '' })
          .then(function (res) { applyP(res, '本集信息已保存'); });
      });
      box.appendChild(rename);
      if ((CUR.episodes || []).length > 1) {
        const del = el('button', 'ep-tab ops', '🗑');
        del.type = 'button';
        del.title = '删除本集(镜头与素材一并删除;角色库保留)';
        del.addEventListener('click', function () {
          if (!confirm('删除「' + (ep.title || '本集') + '」及其中全部镜头素材?不可恢复!')) return;
          dPOST('/' + CUR.id + '/eps/' + ep.id + '/delete', {}).then(function (res) {
            if (!res.ok || !res.p.ok) { status('删除失败:' + (res.p.error || ''), true); return; }
            CUR = res.p.project;
            CUR_EP = null;  // 回退到第 1 集
            curEp();
            rememberEp();
            safeRender();
            status('集已删除');
          });
        });
        box.appendChild(del);
      }
    }
  }

  function renderStyleChips() {
    const box = $('#styleChips');
    if (!box) return;
    box.textContent = '';
    META.styles.forEach(function (s) {
      const chip = el('button', 'tag chip-btn', s.split(',')[0]);
      chip.type = 'button';
      chip.title = s;
      chip.addEventListener('click', function () {
        $('#pStyle').value = s;
        saveProj();
      });
      box.appendChild(chip);
    });
  }

  function shotBadge(s) {
    const parts = [];
    if (s.firstTaskId) parts.push('首帧中');
    else if (s.firstFrame) parts.push('首帧✓');
    if (s.clipTaskId) parts.push('成片中');
    else if (s.clip) parts.push('成片✓');
    return parts.join(' · ') || '待生成';
  }

  function renderChars() {
    const box = $('#charList');
    box.textContent = '';
    (CUR.chars || []).forEach(function (c) {
      const row = el('div', 'char');
      row.dataset.id = c.id;
      if (c.asset) {
        const img = el('img', 'char-face');
        img.src = assetURL(c.asset);
        img.title = '点击放大';
        img.addEventListener('click', function () {
          $('#lightboxImg').src = img.src;
          $('#lightbox').style.display = 'flex';
        });
        row.appendChild(img);
      }
      const main = el('div', 'char-main');
      const name = el('input');
      name.value = c.name;
      name.placeholder = '角色名';
      name.addEventListener('change', function () {
        dPOST('/' + CUR.id + '/chars/' + c.id + '/update', { name: name.value });
      });
      const desc = el('textarea');
      desc.rows = 2;
      desc.value = c.desc || '';
      desc.placeholder = '外观设定(发型/服装/年龄/气质…),定妆照与分镜都会参考';
      desc.addEventListener('change', function () {
        dPOST('/' + CUR.id + '/chars/' + c.id + '/update', { desc: desc.value });
      });

      // 参考图缩略条:上传后生成定妆照以 refs 保脸;点击「+」选文件
      const refBar = el('div', 'char-refs');
      (c.refs || []).forEach(function (rel, i) {
        const wrap = el('span', 'char-ref');
        const t = el('img');
        t.src = assetURL(rel);
        t.title = '参考图' + (i + 1);
        const x = el('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = '移除这张参考图';
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          dPOST('/' + CUR.id + '/chars/' + c.id + '/refs/delete', { index: i + 1 })
            .then(function (res) { applyP(res, '已移除参考图'); });
        });
        wrap.appendChild(t);
        wrap.appendChild(x);
        refBar.appendChild(wrap);
      });
      if ((c.refs || []).length < 5) {
        const add = el('span', 'char-ref add', '+');
        add.title = '上传参考图(jpg/png/webp,≤2MB;可作定妆照的长相参考)';
        add.addEventListener('click', function () { pickCharRef(c); });
        refBar.appendChild(add);
      }
      if (refBar.children.length) main.appendChild(refBar);

      // 三视图缩略条(角色圣经资产,全剧集复用;traitTaskId 轮询)
      const traits = c.traits || [];
      if (traits.length || c.asset) {
        const trBar = el('div', 'char-refs');
        if (c.asset) {
          const wrap0 = el('span', 'char-ref main-face');
          const t0 = el('img');
          t0.src = assetURL(c.asset);
          t0.title = '定妆照(长相主参考)';
          wrap0.appendChild(t0);
          trBar.appendChild(wrap0);
        }
        traits.forEach(function (rel, i) {
          const wrap = el('span', 'char-ref');
          const t = el('img');
          t.src = assetURL(rel);
          t.title = '三视图 ' + (i + 1) + '(跨集复用)';
          const x = el('button');
          x.type = 'button';
          x.textContent = '×';
          x.title = '移除这张三视图';
          x.addEventListener('click', function (e) {
            e.stopPropagation();
            dPOST('/' + CUR.id + '/chars/' + c.id + '/traits/delete', { index: i + 1 })
              .then(function (res) { applyP(res, '已移除三视图'); });
          });
          wrap.appendChild(t);
          wrap.appendChild(x);
          trBar.appendChild(wrap);
        });
        main.appendChild(trBar);
      }

      // 配音音色:角色专属;台词按「角色名」匹配到这个音色
      const voiceRow = el('div', 'char-ops');
      const vLabel = el('span', 'muted', '配音音色');
      const vSel = el('select');
      (META.voices || []).forEach(function (v) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.label;
        if ((c.voice || 'default') === v.id) o.selected = true;
        vSel.appendChild(o);
      });
      vSel.addEventListener('change', function () {
        dPOST('/' + CUR.id + '/chars/' + c.id + '/update', { voice: vSel.value });
        status('已把「' + c.name + '」的配音音色改为「' + vSel.options[vSel.selectedIndex].text + '」;重新点「生成配音」生效');
      });
      voiceRow.appendChild(vLabel); voiceRow.appendChild(vSel);
      main.appendChild(voiceRow);

      const ops = el('div', 'char-ops');
      const gen = el('button', 'btn', c.asset ? '重roll定妆照' : '生成定妆照');
      gen.addEventListener('click', function () { genPortrait(c); });
      // 三视图追加:同一角色多角度资产(跨集复用;第二张起带已有定妆保脸)
      const poseSel = el('select');
      poseSel.title = '追加角色资产视图(生成后所有集的镜头都能引用)';
      [['side', '侧面全身'], ['back', '背面全身'], ['full', '正面全身'], ['closeup', '面部特写']]
        .forEach(function (p) {
          const o = document.createElement('option');
          o.value = p[0];
          o.textContent = '+' + p[1];
          poseSel.appendChild(o);
        });
      poseSel.addEventListener('change', function () {
        if (poseSel.value) genTrait(c, poseSel.value);
        poseSel.value = 'side';
      });
      const del = el('button', 'btn', '删除');
      del.addEventListener('click', function () {
        if (!confirm('删除角色「' + c.name + '」及其定妆照?')) return;
        dPOST('/' + CUR.id + '/chars/' + c.id + '/delete').then(function (res) { applyP(res, '角色已删除'); });
      });
      const st = el('span', 'char-status');
      if (c.portraitTaskId) st.textContent = '定妆照生成中…';
      if (c.traitTaskId) st.textContent = '三视图生成中…';
      ops.appendChild(gen); ops.appendChild(poseSel); ops.appendChild(del); ops.appendChild(st);
      main.appendChild(name); main.appendChild(desc); main.appendChild(ops);
      row.appendChild(main);
      // 拖拽图片到角色行直接加参考图
      row.addEventListener('dragover', function (e) { e.preventDefault(); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files.length) addCharRefFiles(c, e.dataTransfer.files);
      });
      box.appendChild(row);
    });
  }

  function addCharRefFiles(ch, fileList) {
    const files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /^image\/(jpeg|png|webp)$/.test(f.type);
    });
    if (!files.length) { status('参考图只接受 jpg/png/webp', true); return; }
    const room = 5 - (ch.refs || []).length;
    if (files.length > room) { status('参考图最多 5 张(还可加 ' + room + ' 张)', true); return; }
    files.forEach(function (file) {
      if (file.size > 2 * 1024 * 1024) { status('参考图 ' + file.name + ' 超过 2MB', true); return; }
      const reader = new FileReader();
      reader.onload = function () {
        dPOST('/' + CUR.id + '/chars/' + ch.id + '/refs/add', { dataUrl: String(reader.result) })
          .then(function (res) {
            if (!res.ok || !res.p.ok) { status('参考图上传失败:' + (res.p.error || ''), true); return; }
            CUR = res.p.project;
            safeRender();
          });
      };
      reader.readAsDataURL(file);
    });
  }

  function pickCharRef(ch) {
    charRefTarget = ch.id;
    charRefInput.value = '';
    charRefInput.click();
  }

  function renderShots() {
    const list = $('#shotList');
    list.textContent = '';
    const ep = curEp();
    if (!ep) return;
    // 章节分组:scene 字段「起·第1章:场景」按「·」前缀聚合(无前缀的进「其他」)
    const groups = [];
    ep.shots.forEach(function (s, i) {
      const m = /^[起承转合]\s*[·•]/.exec(s.scene || '');
      const g = m ? m[0].slice(0, -1) : '';
      let bucket = groups.find(function (x) { return x.name === g; });
      if (!bucket) { bucket = { name: g, items: [] }; groups.push(bucket); }
      bucket.items.push({ s: s, i: i });
    });
    const flat = groups.length <= 1;
    groups.forEach(function (g) {
      if (!flat) {
        const head = el('div', 'chapter-head', g.name + ' 章(' + g.items.length + '镜)');
        list.appendChild(head);
      }
      g.items.forEach(function (pair) { list.appendChild(buildShotCard(pair.s, pair.i)); });
    });
  }

  function buildShotCard(s, i) {
    const card = el('div', 'shot');
    card.dataset.id = s.id;

    const head = el('div', 'shot-head');
    head.appendChild(el('span', 'idx', '第' + (i + 1) + '镜'));
    const scene = el('input', 'scene');
    scene.value = s.scene || '';
    scene.placeholder = '场景(如:夜晚·天台)';
    scene.addEventListener('change', function () { patchShot(s.id, { scene: scene.value }); });
    head.appendChild(scene);
    head.appendChild(el('span', 'st', shotBadge(s)));
    // 折叠钮:收起后只留首行,长剧浏览不滚屏;本地瞬时 toggle(不依赖整树重渲染)
    const fold = el('button', 'btn fold', COLLAPSED.has(s.id) ? '▸' : '▾');
    fold.type = 'button';
    fold.title = COLLAPSED.has(s.id) ? '展开本镜' : '收起本镜(只留场景行)';
    fold.addEventListener('click', function () {
      if (COLLAPSED.has(s.id)) COLLAPSED.delete(s.id); else COLLAPSED.add(s.id);
      const collapsed = COLLAPSED.has(s.id);
      fold.textContent = collapsed ? '▸' : '▾';
      fold.title = collapsed ? '展开本镜' : '收起本镜(只留场景行)';
      card.classList.toggle('collapsed', collapsed);
    });
    head.appendChild(fold);
    if (COLLAPSED.has(s.id)) card.classList.add('collapsed');
    card.appendChild(head);

    const dLabel = el('label', 'f-label', '画面描述');
    const dTxt = el('textarea');
    dTxt.rows = 2;
    dTxt.value = s.desc || '';
    dTxt.placeholder = ADVANCED
      ? '这一镜发生了什么(可空)'
      : '一句话写清画面:谁在哪做什么。改动后约 2 秒自动重写下方提示词(不占生图额度)';
    let rpTimer = null;
    dTxt.addEventListener('change', function () {
      patchShot(s.id, { desc: dTxt.value });
      // 简单模式:desc 是唯一输入源,防抖 2 秒调 reprompt 自动重写首帧/运动提示词
      if (!ADVANCED) {
        if (rpTimer) clearTimeout(rpTimer);
        rpTimer = setTimeout(function () {
          const v = dTxt.value.trim();
          if (!v) { status('画面描述为空,跳过提示词派生'); return; }
          status('提示词派生中…(小模型重写,约 2~5 秒)');
          dPOST('/' + CUR.id + '/shots/' + s.id + '/reprompt', { desc: v })
            .then(function (res) {
              if (!res.ok || !res.p.ok) { status('提示词派生失败:' + (res.p.error || '未知错误'), true); return; }
              CUR = res.p.project;
              safeRender();
              status('提示词已按画面描述重写(可在高级模式下微调)');
            }).catch(function () { status('提示词派生失败:网络错误', true); });
        }, 2000);
      }
    });
    dLabel.appendChild(dTxt);
    card.appendChild(dLabel);

    if (ADVANCED) {
      const fLabel = el('label', 'f-label', '首帧提示词(文生图,含角色外观与场景)');
      const fTxt = el('textarea');
      fTxt.rows = 2;
      fTxt.value = s.firstPrompt || '';
      fTxt.addEventListener('change', function () { patchShot(s.id, { firstPrompt: fTxt.value }); });
      fLabel.appendChild(fTxt);
      card.appendChild(fLabel);

      const mLabel = el('label', 'f-label', '运动提示词(图生视频,只写动作与镜头)');
      const mTxt = el('textarea');
      mTxt.rows = 2;
      mTxt.value = s.motionPrompt || '';
      mTxt.addEventListener('change', function () { patchShot(s.id, { motionPrompt: mTxt.value }); });
      mLabel.appendChild(mTxt);
      card.appendChild(mLabel);
    }

    // 对白区:角色名:台词,一行一句;生成配音按钮 + 台词灵感
    const lRow = el('div', 'label-row');
    lRow.appendChild(el('label', null, '台词(一行一句「角色名:台词」;合成时自动配音+字幕)'));
    const bTtsIdea = el('button', 'btn', '💬');
    bTtsIdea.type = 'button';
    bTtsIdea.title = '台词灵感(先给通用示范,几秒后按本项目角色现编)';
    bTtsIdea.addEventListener('click', function () { showLineIdeas(s); });
    lRow.appendChild(bTtsIdea);
    card.appendChild(lRow);
    const lTxt = el('textarea');
    lTxt.rows = 2;
    lTxt.value = s.lines || '';
    lTxt.placeholder = '例如:\n小满:今天怎么不进来?\n黑猫:在等你换班。';
    lTxt.addEventListener('change', function () { patchShot(s.id, { lines: lTxt.value }); });
    card.appendChild(lTxt);

    const ops = el('div', 'shot-ops');
    const stSel = el('select');
    stSel.title = '镜型(P1-1):固定=稳定防崩;推近/横移/手持=运镜镜(自动派海螺3Max);特写=关键情绪点。分镜 AI 自动标注,可手改';
    [['static', '固定机位'], ['push', '缓慢推近'], ['pan', '横向平移'],
     ['handheld', '手持跟拍'], ['closeup', '面部特写']].forEach(function (pair) {
      const o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      if ((s.shotType || 'static') === pair[0]) o.selected = true;
      stSel.appendChild(o);
    });
    stSel.addEventListener('change', function () {
      patchShot(s.id, { shotType: stSel.value });
    });
    const vModel = el('select');
    vModel.title = '本镜视频模型;留空用自动分派(开口→Veo / 运镜镜→海螺3Max / ⭐关键镜→可灵Pro / 过场→可灵Std)';
    [[null, '自动(按镜分派)'], ['kwaivgi/kling-v3.0-pro', '可灵 3.0 Pro(强制)'],
     ['kwaivgi/kling-v3.0-std', '可灵 3.0 标准(强制)'],
     ['google/veo-3.1-fast', 'Veo 3.1 Fast(强制)']].forEach(function (pair) {
      const o = document.createElement('option');
      o.value = pair[0] || '';
      o.textContent = pair[1];
      if ((s.videoModel || '') === (pair[0] || '')) o.selected = true;
      vModel.appendChild(o);
    });
    vModel.addEventListener('change', function () {
      patchShot(s.id, { videoModel: vModel.value || null });
    });
    const keyChk = document.createElement('input');
    keyChk.type = 'checkbox';
    keyChk.checked = !!s.key;
    keyChk.title = '⭐ 关键镜:一键成片时自动抽 2 候选择优,并用可灵 Pro(更贵更稳)';
    const keyLabel = el('label', null, '⭐');
    keyLabel.insertBefore(keyChk, keyLabel.firstChild);
    keyLabel.title = keyChk.title;
    keyChk.addEventListener('change', function () {
      patchShot(s.id, { key: keyChk.checked });
    });
    const chChk = document.createElement('input');
    chChk.type = 'checkbox';
    chChk.checked = s.chain !== false;   // 缺省开:首尾帧硬衔接
    chChk.title = '🔗 首尾帧衔接:下一镜已有首帧时,把本镜结尾焊到下一镜开头(需要下一镜先出首帧)';
    const chLabel = el('label', null, '🔗');
    chLabel.insertBefore(chChk, chLabel.firstChild);
    chLabel.title = chChk.title;
    chChk.addEventListener('change', function () {
      patchShot(s.id, { chain: chChk.checked });
    });
    const ndChk = document.createElement('input');
    ndChk.type = 'checkbox';
    ndChk.checked = !!s.nativeDialog;
    ndChk.title = '台词写进提示词,模型直接生成人物开口说话(带口型与声音);无需再点配音';
    const ndLabel = el('label', null, '开口');
    ndLabel.insertBefore(ndChk, ndLabel.firstChild);
    ndLabel.title = '原生对白(零新增开销):用中转的 Veo 3.1 fast,人物真开口+口型同步;时长自动取 4/6/8s 档';
    ndChk.addEventListener('change', function () {
      patchShot(s.id, { nativeDialog: ndChk.checked });
      status(ndChk.checked
        ? '已勾「开口」:点「生视频」时台词会写进提示词,人物直接开口说'
        : '已取消「开口」,恢复静音生成+后期配音');
    });
    const dur = el('select');
    VID_DURATIONS.forEach(function (d) {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d + ' 秒';
      if ((s.duration || 5) === d) o.selected = true;
      dur.appendChild(o);
    });
    if (!Array.prototype.includes.call(VID_DURATIONS, s.duration || 5)) {
      const o = document.createElement('option');
      o.value = s.duration || 5;
      o.textContent = (s.duration || 5) + ' 秒(该模型不支持)';
      dur.insertBefore(o, dur.firstChild);
      dur.value = String(s.duration || 5);
    }
    dur.title = '可视频模型的 supported_durations(可灵 3.0 为 3~15 秒)';
    dur.addEventListener('change', function () { patchShot(s.id, { duration: Number(dur.value) }); });
    const bTts = el('button', 'btn', s.tts ? '🔁 重做配音' : '🎙 生成配音');
    bTts.addEventListener('click', function () { genTts(s); });
    const bLip = el('button', 'btn', '👄 对口型');
    bLip.title = '有成片+有配音时可用:调可灵官方对口型,让人物按台词动嘴(约0.7积分/镜,1~3分钟)';
    bLip.addEventListener('click', function () { genLipsync(s, bLip); });
    const bFrame = el('button', 'btn', s.firstFrame ? '🎲 重roll首帧' : '🖼 生首帧');
    bFrame.addEventListener('click', function () { genFirstFrame(s); });
    const bClip = el('button', 'btn', s.clip ? '🎬 重roll成片' : '🎬 生视频');
    bClip.addEventListener('click', function () { genClip(s); });
    const up = el('button', 'btn', '↑');
    up.title = '上移';
    up.addEventListener('click', function () { moveShot(s.id, -1); });
    const down = el('button', 'btn', '↓');
    down.title = '下移';
    down.addEventListener('click', function () { moveShot(s.id, 1); });
    const del = el('button', 'btn', '删除');
    del.addEventListener('click', function () {
      if (!confirm('删除第' + (i + 1) + '镜及其素材?')) return;
      dPOST('/' + CUR.id + '/shots/' + s.id + '/delete').then(function (res) { applyP(res, '镜头已删除'); });
    });
    ops.appendChild(stSel); ops.appendChild(vModel); ops.appendChild(keyLabel); ops.appendChild(chLabel); ops.appendChild(ndLabel);
    ops.appendChild(dur);
    // 开口镜头人声由模型生成,配音/对口型不参与——不渲染(取消「开口」即回到配音路线)
    if (!s.nativeDialog) { ops.appendChild(bTts); ops.appendChild(bLip); }
    ops.appendChild(bFrame); ops.appendChild(bClip);
    ops.appendChild(up); ops.appendChild(down); ops.appendChild(del);
    card.appendChild(ops);

    const media = el('div', 'shot-media');
    if (s.firstFrame) {
      const img = el('img', 'frame');
      img.src = assetURL(s.firstFrame);
      img.alt = '首帧';
      img.title = '点击放大';
      img.addEventListener('click', function () {
        $('#lightboxImg').src = img.src;
        $('#lightbox').style.display = 'flex';
      });
      media.appendChild(img);
    }
    if (s.tts) {
      const au = document.createElement('audio');
      au.controls = true;
      au.preload = 'none';
      au.style.width = '150px';
      au.src = assetURL(s.tts);
      au.title = '本镜配音';
      media.appendChild(au);
    }
    if (s.clip) {
      const v = document.createElement('video');
      v.controls = true;
      v.preload = 'metadata';
      v.src = assetURL(s.clip);
      media.appendChild(v);
    }
    if (media.children.length) card.appendChild(media);

    // 候片墙(P1.2):首帧/成片的多候选缩略条,点选切换(服务端 takes + TakeSel)
    const takeStrips = el('div', 'take-strips');
    [['first', '首帧候选'], ['clip', '成片候选']].forEach(function (pair) {
      const kind = pair[0];
      const takes = (s.takes || []).filter(function (t) { return t.kind === kind; });
      if (takes.length < 2) return;
      const selField = kind === 'first' ? 'firstTakeSel' : 'clipTakeSel';
      const selId = s[selField];
      const strip = el('div', 'take-strip');
      strip.appendChild(el('span', 'take-label', pair[1]));
      takes.forEach(function (t) {
        const b = el('button', 'take-thumb' + (selId === t.id ? ' on' : ''));
        b.type = 'button';
        b.title = '候选 ' + t.id + (selId === t.id ? '(当前)' : '(点击切换)');
        if (kind === 'first') {
          const img = document.createElement('img');
          img.src = assetURL(t.rel);
          b.appendChild(img);
        } else {
          const v = document.createElement('video');
          v.src = assetURL(t.rel);
          v.preload = 'metadata';
          v.muted = true;
          b.appendChild(v);
        }
        b.addEventListener('click', function () {
          const field = kind === 'first' ? 'firstTakeSel' : 'clipTakeSel';
          patchShot(s.id, (function () { const o = {}; o[field] = t.id; return o; })());
          status('已切换本镜' + pair[1] + '到 ' + t.id + ';重新点「合成成片」用新候选出片');
        });
        strip.appendChild(b);
      });
      takeStrips.appendChild(strip);
    });
    if (takeStrips.children.length) card.appendChild(takeStrips);
    if (s.cost > 0) {
      card.appendChild(el('span', 'shot-cost', '累计成本 $' + Number(s.cost).toFixed(2)));
    }

    card.appendChild(el('div', 'shot-status', ''));
    return card;
  }

  // ---------- 台词灵感 ----------
  // 弹窗先展示通用灵感库(即时可用),同时按当前项目角色 LLM 现编 3 组;
  // 现编回来刷新弹窗(已关闭则忽略),失败静默保留通用灵感。
  function showLineIdeas(shot) {
    const box = $('#ideaBox');
    const renderIdeas = function (ideas, custom) {
      if (!ideas || !ideas.length) return;
      box.textContent = '';
      box.dataset.for = shot.id;
      box.appendChild(el('h3', null, custom ? '按本项目角色现编的台词(点击卡片填入本镜)'
                                            : '台词灵感(通用示范,点击卡片填入本镜)'));
      ideas.forEach(function (idea) {
        const card = el('div', 'idea-card');
        card.appendChild(el('span', 'idea-style', idea.mood));
        card.appendChild(el('p', null, idea.lines));
        card.addEventListener('click', function () {
          patchShot(shot.id, { lines: idea.lines });
          $('#ideaModal').style.display = 'none';
          status('已填入台词灵感,可继续手改');
        });
        box.appendChild(card);
      });
    };
    renderIdeas(META.linesIdeas, false);
    $('#ideaModal').style.display = 'flex';
    if (!CUR) return;
    const shotNow = findShotEverywhere(shot.id).shot;
    fetch('/api/drama/projects/' + CUR.id + '/lines-ideas', {
      method: 'POST', headers: AUTH(),
      body: JSON.stringify({ seed: (shotNow && shotNow.lines) || '' }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
    }).then(function (res) {
      if (!res.ok || !res.p.ok || !(res.p.ideas || []).length) return;
      // 弹窗仍开着且还是发起现编的那一镜才刷新(用户可能已选通用灵感/换镜重开)
      if ($('#ideaModal').style.display !== 'flex' || box.dataset.for !== shot.id) return;
      if (!box.textContent.includes('通用示范')) return;
      renderIdeas(res.p.ideas, true);
    }).catch(function () { /* 现编失败静默:通用灵感仍可用 */ });
  }

  // 服务端后台任务(compose/tts)轮询:project.json 里的 composeJob/ttsJob 有 running 时每 2s 拉一次
  function pollDramaJobs() {
    if (jobTimer) return;   // 已有轮询在跑
    jobTimer = setInterval(function () {
      if (!CUR) { clearInterval(jobTimer); jobTimer = null; return; }
      dGET('/' + CUR.id).then(function (res) {
        if (!res.ok || !res.p.ok) return;
        const before = CUR;
        CUR = res.p.project;
        const running = [];
        (CUR.episodes || []).forEach(function (e) {
          const j = e.composeJob || {};
          if (j.state === 'running' || j.state === 'queued') running.push(e.id);
          (e.shots || []).forEach(function (s) {
            const tj = s.ttsJob || {};
            if (tj.state === 'running') running.push('tts:' + s.id);
          });
        });
        const rj = CUR.remixJob || {};
        if (rj.state === 'running') running.push('remix');
        if (!running.length) {
          clearInterval(jobTimer);
          jobTimer = null;
          if (before !== CUR) {
            // 某个 job 落地:如果是本集 compose,顺带报结果
            const ep = curEp();
            const rjNow = CUR.remixJob || {};
            const j = ep && ep.composeJob;
            if (rjNow.state === 'done') status('全剧重混完成!series.mp4 已可在「全剧重混」区预览/下载');
            else if (rjNow.state === 'error') status('全剧重混失败:' + (rjNow.error || ''), true);
            else if (j && j.state === 'done') status('合成完成!「成片」区已可预览/下载本集成片');
            else if (j && j.state === 'error') status('合成失败:' + (j.error || ''), true);
            else status('后台任务已完成');
            if (ep && ep.composeJob && ep.composeJob.state === 'done') {
              dGET('/' + CUR.id + '/warnings?eid=' + ep.id).then(function (wres) {
                if (!wres.ok || !wres.p.ok) return;
                const w = wres.p.warnings || [];
                if (w.length) status('合成完成;⚠ ' + w.length + ' 镜台词比画面长被截断:'
                  + w.map(function (x) { return x.scene; }).join('、'), true);
              });
            }
          }
        }
        safeRender();
      }).catch(function () { /* 网络抖动下一轮再试 */ });
    }, 2000);
  }

  function renderComposed() {
    const box = $('#composedBox');
    box.textContent = '';
    const ep = curEp();
    if (!ep) return;
    // 异步合成状态:queued/running 显示进度;done 渲染成片;error 报错
    const job = ep.composeJob || {};
    if (job.state === 'running' || job.state === 'queued') {
      const t = Date.now();
      if (!renderComposed._t0 || renderComposed._ep !== ep.id) renderComposed._t0 = t;
      renderComposed._ep = ep.id;
      const sec = Math.round((t - renderComposed._t0) / 1000);
      box.appendChild(el('p', 'hint', (job.state === 'queued' ? '合成排队中' : 'ffmpeg 合成中…')
        + '(已 ' + sec + ' 秒;镜头越多越久,可先编辑其他集)'));
      return;
    }
    renderComposed._t0 = 0;
    if (job.state === 'error') {
      box.appendChild(el('p', 'hint err', '上次合成失败:' + (job.error || '') + '(点「合成成片」重试)'));
    }
    if (!ep.composed) return;
    const v = document.createElement('video');
    v.controls = true;
    v.src = assetURL(ep.composed);
    box.appendChild(v);
    const a = el('a', 'download', '⬇ 下载本集成片');
    a.href = assetURL(ep.composed);
    a.download = ((CUR.title || 'drama') + '-' + (ep.title || 'ep') + '.mp4');
    box.appendChild(a);
  }

  // 全剧重混(P2.6):remixJob 状态轮询 + series.mp4 播放
  function renderRemix() {
    const box = $('#remixBox');
    if (!box) return;
    box.textContent = '';
    if (!CUR) return;
    const job = CUR.remixJob || {};
    if (job.state === 'running') {
      box.appendChild(el('p', 'hint', '全剧重混中…(逐集 loudnorm 响度归一→拼 series,可先做别的事)'));
      return;
    }
    if (job.state === 'error') {
      box.appendChild(el('p', 'hint err', '上次重混失败:' + (job.error || '') + '(再点一次重试)'));
    }
    if (job.state !== 'done') return;
    const v = document.createElement('video');
    v.controls = true;
    v.src = assetURL('series.mp4');
    box.appendChild(v);
    const a = el('a', 'download', '⬇ 下载全剧(series.mp4)');
    a.href = assetURL('series.mp4');
    a.download = ((CUR.title || 'drama') + '-全剧.mp4');
    box.appendChild(a);
  }

  // 成本透明化(P1.3):本集/全剧累计生成花费(镜头 cost 由素材落盘时累计)
  function renderCostLine() {
    const line = $('#costLine');
    if (!line) return;
    if (!CUR) { line.textContent = ''; return; }
    const ep = curEp();
    const sum = function (shots) {
      return (shots || []).reduce(function (n, s) { return n + (Number(s.cost) || 0); }, 0);
    };
    const epCost = ep ? sum(ep.shots) : 0;
    const all = (CUR.episodes || []).reduce(function (n, e) { return n + sum(e.shots); }, 0);
    const parts = [];
    if (epCost > 0) parts.push('本集 $' + epCost.toFixed(2));
    if (all > 0) parts.push('全剧 $' + all.toFixed(2));
    line.textContent = parts.length ? '生成成本:' + parts.join(' · ') + '(按镜头累计)' : '';
  }

  function patchShot(sid, fields) {
    dPOST('/' + CUR.id + '/shots/' + sid + '/update', fields).then(function (res) {
      if (!res.ok || !res.p.ok) { status('保存失败:' + (res.p.error || ''), true); return; }
      CUR = res.p.project;
      const s = findShotEverywhere(sid).shot;
      const badge = document.querySelector('.shot[data-id="' + sid + '"] .st');
      if (badge && s) badge.textContent = shotBadge(s);
    });
  }

  function moveShot(sid, delta) {
    const ep = curEp();
    if (!ep) return;
    const ids = ep.shots.map(function (s) { return s.id; });
    const i = ids.indexOf(sid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    dPOST('/' + CUR.id + '/shots/reorder', { eid: ep.id, order: ids }).then(function (res) { applyP(res); });
  }

  // ---------- 生成 ----------
  function styleSuffix() {
    return '。统一画面风格:' + ((CUR.style || '').trim() || '电影感写实')
      + ',全剧画面风格与角色形象保持一致;画面中不出现任何文字、字幕、水印、logo。';
  }

  // P1-1 运镜指令:按 shotType 注入不同运镜(固定镜保留防崩词;运镜镜换「单镜内完成,无剪辑」)
  function motionSuffix(shot) {
    const t = (shot && shot.shotType) || 'static';
    const tail = '不要新增元素,与全剧其他镜头风格保持一致。';
    if (t === 'push') return '。动作幅度小而柔和,镜头缓慢向前推近,单镜内完成,无剪辑,' + tail;
    if (t === 'pan') return '。动作幅度小而柔和,镜头缓慢横向平移跟随主体,单镜内完成,无剪辑,' + tail;
    if (t === 'handheld') return '。动作幅度小而柔和,手持跟拍视角带轻微自然晃动,单镜内完成,无剪辑,' + tail;
    if (t === 'closeup') return '。动作幅度小而柔和,固定特写机位聚焦微表情与眼神,不要切换镜头,' + tail;
    return '。动作幅度小而柔和,镜头固定,不要切换镜头,' + tail;
  }

  // 角色定妆照 → 压缩成 studio 允许的参考图 dataURL(≤2MB 由 canvas 重采样保证)
  function fileToDataURL(rel, maxDim) {
    return fetch(assetURL(rel), { headers: AUTH() })
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          const img = new Image();
          img.onload = function () {
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(img.src);
            resolve(cv.toDataURL('image/jpeg', 0.9));
          };
          img.onerror = function () { URL.revokeObjectURL(img.src); reject(new Error('素材解码失败')); };
          img.src = URL.createObjectURL(blob);
        });
      });
  }

  function genPortrait(ch) {
    if (!CUR) return;
    if (ch.portraitTaskId) { status('这一角色的定妆照正在生成中', true); return; }
    const needLook = (ch.refs || []).length > 0;
    const prompt = '角色定妆照:' + ((ch.desc || '').trim() || ch.name)
      + (needLook ? '。严格按参考图保持人物长相、发型与服装一致' : '')
      + '。单人正面半身像,完整面部与发型,表情自然,光线均匀,纯色简洁背景'
      + styleSuffix();
    // 参考优先级:用户上传的 refs > 旧定妆照(重roll保脸)> 纯文字
    const refRels = needLook ? ch.refs.slice(0, 5) : (ch.asset ? [ch.asset] : []);
    Promise.all(refRels.map(function (rel) { return fileToDataURL(rel, 1024); }))
      .then(function (refs) {
        const body = { model: IMG_MODEL, prompt: prompt, aspectRatio: '3:4', imageSize: '1K' };
        if (refs.length) body.referenceImages = refs;
        return studioSubmit(body);
      })
      .then(function (res) {
        if (!res.ok) { status('定妆照提交失败:' + (ERRORS[res.p.error] || res.p.error || '未知错误'), true); return; }
        poll[res.p.id] = { kind: 'portrait', id: ch.id, startedAt: Date.now() };
        dPOST('/' + CUR.id + '/chars/' + ch.id + '/update', { portraitTaskId: res.p.id });
        const badge = document.querySelector('.char[data-id="' + ch.id + '"] .char-status');
        if (badge) badge.textContent = '定妆照生成中…';
        status('定妆照任务已提交,生成中(一般 10~60 秒)');
        refreshQuota();
      })
      .catch(function (e) {
        status('定妆照提交失败:' + (e && e.message ? e.message : '参考图读取失败'), true);
      });
  }

  // 追加三视图:同一角色的多角度资产(全剧集复用)。pose ∈ side|back|full|closeup。
  // 参考图优先级:用户 refs > 已有定妆照+三视图(保脸保风格)> 纯文字。
  const TRAIT_POSES = {
    side: '同一角色的侧面全身像,完整身形与服装,侧面视角,光线均匀,纯色简洁背景',
    back: '同一角色的背面全身像,完整身形与服装(发色/服装颜色与参考图一致),纯色简洁背景',
    full: '同一角色的正面全身像,从头到脚完整身形与服装,站姿自然,纯色简洁背景',
    closeup: '同一角色的面部特写,五官清晰,表情自然,纯色简洁背景',
  };
  function genTrait(ch, pose) {
    if (!CUR) return;
    if (ch.traitTaskId) { status('这一角色的三视图正在生成中', true); return; }
    const look = (ch.desc || '').trim() || ch.name;
    const prompt = '角色设定图:' + look + '。' + (TRAIT_POSES[pose] || TRAIT_POSES.full)
      + '。必须与参考图是同一个人物:长相、发型、发色、服装风格严格一致'
      + styleSuffix();
    const refs = (ch.refs && ch.refs.length ? ch.refs.slice(0, 3)
                  : [ch.asset].concat(ch.traits || []).filter(Boolean).slice(0, 3));
    Promise.all(refs.map(function (rel) { return fileToDataURL(rel, 1024); }))
      .then(function (imgs) {
        const body = { model: IMG_MODEL, prompt: prompt, aspectRatio: '3:4', imageSize: '1K' };
        const frames = imgs.filter(Boolean);
        if (frames.length) body.referenceImages = frames;
        return studioSubmit(body);
      })
      .then(function (res) {
        if (!res.ok) { status('三视图提交失败:' + (ERRORS[res.p.error] || res.p.error || '未知错误'), true); return; }
        poll[res.p.id] = { kind: 'trait', id: ch.id, startedAt: Date.now() };
        dPOST('/' + CUR.id + '/chars/' + ch.id + '/update', { traitTaskId: res.p.id });
        const badge = document.querySelector('.char[data-id="' + ch.id + '"] .char-status');
        if (badge) badge.textContent = '三视图生成中…';
        status('三视图任务已提交(一般 10~60 秒);完成后全剧集的镜头首帧都会引用它');
        refreshQuota();
      })
      .catch(function (e) {
        status('三视图提交失败:' + (e && e.message ? e.message : '参考图读取失败'), true);
      });
  }

  // 首帧参考图构成(E·一致性三板斧):[上一镜首帧=相邻场景衔接] + [第1镜首帧=全剧风格锚]
  // + [定妆照=角色锁脸],去重后 ≤5(上游上限)。返回 [{rel, role}]。
  function firstFrameRefs(shot) {
    const ep = curEp();
    if (!ep) return [];
    const idx = ep.shots.indexOf(shot);
    const out = [];
    const seen = {};
    const pushRel = function (rel, role) {
      if (!rel || seen[rel] || out.length >= 5) return;
      seen[rel] = true;
      out.push({ rel: rel, role: role });
    };
    const prev = idx > 0 ? ep.shots[idx - 1] : null;
    if (prev && prev.firstFrame) pushRel(prev.firstFrame, 'prev');
    if (idx > 0 && ep.shots[0].firstFrame) pushRel(ep.shots[0].firstFrame, 'anchor');
    const charSlots = out.length ? 3 : 5;   // 有画面锚时角色资产最多 3 张,留位给衔接
    (CUR.chars || []).forEach(function (c) {
      // 定妆照 + 三视图一起进参考池(先主定妆,再三视图;同角色只占一个槽位组)
      [c.asset].concat(c.traits || []).filter(Boolean)
        .slice(0, Math.max(1, Math.floor(charSlots / Math.max(1, (CUR.chars || []).filter(function (x) { return x.asset; }).length))))
        .forEach(function (rel) { pushRel(rel, 'char'); });
    });
    return out;
  }

  // 提交首帧生成。返回 Promise<{ok, error?}> 供串跑判断;手动按钮同样可用。
  // 滑窗限流(P2.5):分钟池 3 次/分钟,自留 1 次余量给灵感/分镜等 LLM 调用;
  // 提交间隔 <22s 时等待,保证串跑/一键成片不会瞬间撞 429。
  function throttleSubmit() {
    const WINDOW_MS = 60000, LIMIT = 2, SPACING = 22000;
    const now = Date.now();
    while (SUB_TIMES.length && now - SUB_TIMES[0] > WINDOW_MS) SUB_TIMES.shift();
    let wait = 0;
    if (SUB_TIMES.length >= LIMIT) {
      wait = Math.max(0, WINDOW_MS - (now - SUB_TIMES[0])) + 500;
    } else if (SUB_TIMES.length) {
      const since = now - SUB_TIMES[SUB_TIMES.length - 1];
      if (since < SPACING) wait = SPACING - since;
    }
    if (wait > 0) status('限额排队中,约 ' + Math.ceil(wait / 1000) + ' 秒后提交…');
    return new Promise(function (resolve) {
      setTimeout(function () { SUB_TIMES.push(Date.now()); resolve(); }, wait);
    });
  }

  function genFirstFrame(shot) {
    if (!CUR) return Promise.resolve({ ok: false, error: '项目未加载' });
    if (shot.firstTaskId) { status('这一镜的首帧正在生成中', true); return Promise.resolve({ ok: false, error: '该镜首帧已在生成中' }); }
    if (!shot.firstPrompt.trim()) { status('先填首帧提示词', true); return Promise.resolve({ ok: false, error: '首帧提示词为空' }); }
    const ep = curEp();
    if (!ep) return Promise.resolve({ ok: false, error: '项目未加载' });
    const idx = ep.shots.indexOf(shot);
    const refs = firstFrameRefs(shot);
    const hasPrev = refs.some(function (r) { return r.role === 'prev'; });
    const hasAnchor = refs.some(function (r) { return r.role === 'anchor'; });
    // 参考图语义声明:告诉模型每张图管什么(衔接/画风锚/长相)
    let hint = '';
    if (hasPrev && hasAnchor) {
      hint = '第 1 张参考图是上一镜画面:延续它的色调、光线与画风(本镜场景按提示词安排);'
        + '第 2 张是全剧第 1 镜画面:整体画风以它为准防漂移;'
        + '其余为角色定妆照:严格保持长相一致。';
    } else if (hasPrev) {
      hint = '第 1 张参考图是上一镜画面:延续它的色调、光线与画风(本镜场景按提示词安排);'
        + '其余参考图为角色定妆照:严格保持长相一致。';
    } else if (hasAnchor) {
      hint = '第 1 张参考图是全剧第 1 镜画面:整体画风与色调以它为准(本镜场景按提示词安排);'
        + '其余参考图为角色定妆照:严格保持长相一致。';
    } else if (refs.length) {
      hint = '参考图为角色定妆照:严格保持长相一致。';
    }
    const prompt = hint + shot.firstPrompt.trim() + styleSuffix();
    status('正在提交首帧生成…' + (hasPrev ? '(已锚定上一镜画面)' : ''));
    return Promise.all(refs.map(function (r) { return fileToDataURL(r.rel, 1024); }))
      .catch(function () { return []; })   // 参考图取不到就不带,别挡生成
      .then(function (frames) {
        return throttleSubmit().then(function () { return frames; });
      })
      .then(function (frames) {
        const body = { model: IMG_MODEL, prompt: prompt,
                       aspectRatio: CUR.aspect || '9:16', imageSize: '1K' };
        const imgs = frames.filter(Boolean);
        if (imgs.length) body.referenceImages = imgs;
        return studioSubmit(body);
      })
      .then(function (res) {
        if (!res.ok) {
          const msg = ERRORS[res.p.error] || res.p.error || '未知错误';
          status('首帧提交失败:' + msg, true);
          return { ok: false, error: msg };
        }
        poll[res.p.id] = { kind: 'first', id: shot.id, startedAt: Date.now() };
        patchShot(shot.id, { firstTaskId: res.p.id });
        status('首帧任务已提交,后台生成中' + (hasPrev ? '(已锚定上一镜画面)' : ''));
        refreshQuota();
        return { ok: true };
      });
  }

  // 原生对白提示词:模型自己出声+口型;台词用引号包住并注明语言
  function voiceHintOf(name) {
    const ch = (CUR.chars || []).find(function (c) { return (c.name || '').trim() === name; });
    if (!ch) return '';
    const preset = (META.voices || []).find(function (v) { return v.id === (ch.voice || 'default'); });
    return preset && preset.hint ? (name + ' 的声音:' + preset.hint) : '';
  }

  function nativePrompt(shot) {
    const fmt = (shot.lines || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
      .map(function (l) {
        const who = l.indexOf(':') > 0 ? l.slice(0, l.indexOf(':')) : '';
        const say = l.indexOf(':') > 0 ? l.slice(l.indexOf(':') + 1) : l;
        return who ? (who + ' 用中文说: "' + say + '"') : ('说: "' + say + '"');
      });
    const lines = fmt.join(' 然后 ');
    const speakers = [];
    fmt.forEach(function (l) {
      const who = l.indexOf(' ') > 0 ? l.slice(0, l.indexOf(' ')).trim() : '';
      if (who && speakers.indexOf(who) < 0) speakers.push(who);
    });
    const hints = speakers.map(voiceHintOf).filter(Boolean);
    return (shot.motionPrompt.trim() || '人物面对镜头自然对话') + '。' + lines
      + (hints.length ? '。' + hints.join(';') : '')
      + '。口型与台词精确同步,声画同步,不加字幕,不出现文字。';
  }

  // 模型自动分派(P1.3):开口→Veo 原生对白;⭐关键镜→可灵 pro;过场→可灵 std。
  // P1-1: 运镜镜(push/pan/handheld)→ 海螺 3 Max(电影感运镜,目录标注氛围/情绪镜头)。
  // 用户手动选了本镜模型(videoModel)则尊重手选。
  function autoModelFor(shot, native) {
    if (native) return 'google/veo-3.1-fast';
    if (shot.videoModel) return shot.videoModel;
    if (shot.shotType === 'push' || shot.shotType === 'pan' || shot.shotType === 'handheld') {
      return 'minimax/hailuo-3-max';
    }
    return shot.key ? 'kwaivgi/kling-v3.0-pro' : 'kwaivgi/kling-v3.0-std';
  }

  const MODEL_DURS = {
    'kwaivgi/kling-v3.0-pro': (function () { const a = []; for (let i = 3; i <= 15; i++) a.push(i); return a; })(),
    'kwaivgi/kling-v3.0-std': (function () { const a = []; for (let i = 3; i <= 15; i++) a.push(i); return a; })(),
    'google/veo-3.1-fast': [4, 6, 8],
    'minimax/hailuo-3-max': [5, 10],
  };

  function genClip(shot) {
    if (!CUR) return;
    const ep = curEp();
    if (!ep) return;
    if (shot.clipTaskId) { status('这一镜的成片正在生成中', true); return; }
    if (!shot.firstFrame) { status('先为这一镜生成首帧', true); return; }
    const native = shot.nativeDialog && shot.lines.trim();
    if (!native && !shot.motionPrompt.trim()) { status('先填运动提示词(或勾选「人物开口说台词」)', true); return; }
    const model = autoModelFor(shot, native);
    // 开口镜头:Veo 3.1 fast 原生对白(音画一体,人物真开口);时长落到其支持档 4/6/8
    const NATIVE_DURS = [4, 6, 8];
    let dur = shot.duration || 5;
    if (native) {
      const need = shot.ttsDur ? Math.ceil(shot.ttsDur + 1.2) : dur;  // 台词时长(秒)+呼吸
      dur = NATIVE_DURS.find(function (d) { return d >= need; })
        || NATIVE_DURS[NATIVE_DURS.length - 1];
    }
    // 时长兜底:模型不吃该时长就取最近支持档(自动分派 std/pro 后常见 16~30s 镜头)
    const durs = MODEL_DURS[model];
    if (durs && durs.indexOf(dur) < 0) {
      dur = durs.reduce(function (a, b) { return Math.abs(b - dur) < Math.abs(a - dur) ? b : a; }, durs[0]);
    }
    // P1.1 首尾帧硬衔接:下一镜已有首帧且本镜非开口时,把本镜结尾"焊"到下一镜开头。
    // 链接仅对 Kling 模型启用(2026-10-18 直连实测 shape 只验证过可灵/veo 系;
    // 海螺 3 Max 未实测 first_last,若上游不认会静默 failed——运镜镜统一只吃首帧)。
    const idx = ep.shots.indexOf(shot);
    const next = idx + 1 < ep.shots.length ? ep.shots[idx + 1] : null;
    const chainableModel = model === 'kwaivgi/kling-v3.0-pro' || model === 'kwaivgi/kling-v3.0-std';
    const chain = chainableModel && !native && next && next.firstFrame && shot.chain !== false;
    status(chain ? '正在提交视频生成…(🔗 已链下一镜首帧作尾帧,模型 ' + model + ')'
                 : '正在提交视频生成…(模型 ' + model + ')');
    const frameLoads = [fileToDataURL(shot.firstFrame, 1280)];
    if (chain) frameLoads.push(fileToDataURL(next.firstFrame, 1280));
    return throttleSubmit().then(function () {
      return Promise.all(frameLoads);
    }).then(function (imgs) {
      const body = { model: model,
                     prompt: native ? nativePrompt(shot) : shot.motionPrompt.trim() + motionSuffix(shot),
                     frameMode: chain ? 'first_last' : 'first', duration: dur,
                     referenceImages: imgs.filter(Boolean) };
      if (native) { body.audio = true; body.resolution = '720p'; }
      return studioSubmit(body);
    }).then(function (res) {
      if (!res.ok) { status('视频提交失败:' + (ERRORS[res.p.error] || res.p.error || '未知错误'), true); return { ok: false, error: 'submit' }; }
      poll[res.p.id] = { kind: 'clip', id: shot.id, startedAt: Date.now() };
      patchShot(shot.id, { clipTaskId: res.p.id });
      status('视频任务已提交,后台生成中(可灵一般 1~5 分钟)');
      refreshQuota();
      return { ok: true };
    }).catch(function (e) {
      status('视频提交失败:' + (e && e.message ? e.message : '首帧读取失败'), true);
      return { ok: false, error: 'network' };
    });
  }

  function entryLabel(kind) {
    return kind === 'portrait' ? '定妆照' : (kind === 'trait' ? '三视图'
      : (kind === 'first' ? '首帧' : '成片'));
  }

  function clearTaskRef(entry) {
    if (!CUR) return;
    if (entry.kind === 'portrait' || entry.kind === 'trait') {
      const c = CUR.chars.find(function (x) { return x.id === entry.id; });
      if (c) dPOST('/' + CUR.id + '/chars/' + entry.id + '/update',
                   entry.kind === 'portrait' ? { portraitTaskId: '' } : { traitTaskId: '' });
      return;
    }
    const field = entry.kind === 'first' ? 'firstTaskId' : 'clipTaskId';
    const body = {};
    body[field] = null;
    patchShot(entry.id, body);
  }

  // studio 成功快照 data 项 → 素材落盘参数。v0.5: {"file","mime"}(结果在本机磁盘),
  // 直接带任务号让服务端按 taskId/index 直读磁盘落盘——不能拼 /api/studio/file 直链让
  // 服务端自取,那会被素材代取的 SSRF 防护按回环地址拒绝;兼容 b64_json / url 旧形状。
  function assetPayload(item, kind, taskId, index) {
    if (!item || typeof item !== 'object') return null;
    if (item.b64_json) {
      const mime = item.mime || (kind === 'clip' ? 'video/mp4' : 'image/png');
      return { dataUrl: 'data:' + mime + ';base64,' + item.b64_json };
    }
    if (item.file) return { file: { taskId: taskId, index: index + 1 } };
    if (typeof item.url === 'string' && item.url) return { url: item.url };
    return null;
  }

  function settle(tid, project, errMsg) {
    const entry = poll[tid];
    if (!entry) return;
    delete poll[tid];
    const label = entryLabel(entry.kind);
    if (errMsg) {
      status(label + '生成失败:' + errMsg, true);
      clearTaskRef(entry);
      safeRender();
      return;
    }
    CUR = project;
    safeRender();
    syncSelTitle();
    status(label + '已生成并保存到项目');
  }

  // 轮询:3 秒一轮,只对进行中的 studio 任务发请求;成功即把素材搬回短剧项目落盘
  setInterval(function () {
    Object.keys(poll).forEach(function (tid) {
      const entry = poll[tid];
      fetch('/api/studio/tasks/' + tid, { headers: AUTH() })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (p) {
            return { status: r.status, ok: r.ok, p: p };
          });
        })
        .then(function (res) {
          if (res.status === 404) { settle(tid, null, '任务已过期(结果只保留 30 分钟),请重新生成'); return; }
          if (!res.ok) { settle(tid, null, ERRORS[res.p.error] || res.p.error || '查询失败'); return; }
          if (res.p.status === 'running') {
            const sec = Math.round((Date.now() - entry.startedAt) / 1000);
            const text = entryLabel(entry.kind) + '生成中… 已等待 ' + sec + ' 秒';
if (entry.kind === 'portrait' || entry.kind === 'trait') {
            const badge = document.querySelector('.char[data-id="' + entry.id + '"] .char-status');
            if (badge) badge.textContent = text;
          } else {
              const line = document.querySelector('.shot[data-id="' + entry.id + '"] .shot-status');
              if (line) line.textContent = text;
              const st = document.querySelector('.shot[data-id="' + entry.id + '"] .st');
              if (st) { st.textContent = shotBadge({ firstTaskId: entry.kind === 'first' ? tid : null,
                                                     clipTaskId: entry.kind === 'clip' ? tid : null });
                        st.classList.add('busy'); }
            }
            return;
          }
          if (res.p.status === 'failed') { settle(tid, null, ERRORS[res.p.error] || res.p.error || '生成失败'); return; }
          const item = (res.p.data || [])[0];
          const payload = assetPayload(item, entry.kind, tid, 0);
          if (!payload) {
            settle(tid, null, '上游未返回素材:' + JSON.stringify(item).slice(0, 200));
            return;
          }
          const body = Object.assign({
            target: (entry.kind === 'portrait' || entry.kind === 'trait') ? 'char' : 'shot',
            id: entry.id, kind: entry.kind,
          }, payload);
          if (res.p.usage && typeof res.p.usage.cost === 'number' && res.p.usage.cost > 0) {
            body.cost = res.p.usage.cost;   // 成本透明化:随素材落盘累计到镜头
          }
          dPOST('/' + CUR.id + '/asset', body).then(function (up) {
            if (!up.ok || !up.p.ok) { settle(tid, null, '素材落盘失败:' + (up.p.error || '')); return; }
            settle(tid, up.p.project, null);
          });
        })
        .catch(function () { /* 网络抖动,下一轮再试 */ });
    });
  }, 3000);

  // ---------- 成片 ----------
  function playAll() {
    if (!CUR) return;
    const ep = curEp();
    if (!ep) return;
    const clips = ep.shots.filter(function (s) { return s.clip; });
    if (!clips.length) { status('本集还没有镜头成片,先生成视频', true); return; }
    const box = $('#playBox');
    box.textContent = '';
    const v = document.createElement('video');
    v.controls = true;
    v.autoplay = true;
    let i = 0;
    v.addEventListener('ended', function () {
      i += 1;
      if (i < clips.length) { v.src = assetURL(clips[i].clip); v.play(); }
    });
    v.src = assetURL(clips[0].clip);
    box.appendChild(v);
    box.appendChild(el('p', 'hint', '连播预览:共 ' + clips.length + ' 镜,按镜头顺序自动接播;点击空白处关闭。'));
    $('#playModal').style.display = 'flex';
  }

  // ---------- 灵感库 ----------
  function fillIdea(idea) {
    $('#pTitle').value = idea.title || '';
    $('#pLogline').value = idea.logline || '';
    if (idea.style) $('#pStyle').value = idea.style;
    saveProj();
  }

  $('#btnIdea').addEventListener('click', function () {
    if (!CUR) return;
    fillIdea(META.ideas[Math.floor(Math.random() * Math.max(1, META.ideas.length))] || {});
    status('已填入灵感点子(可手改);不满意再点一次换一个');
  });

  $('#btnBrainstorm').addEventListener('click', function () {
    const seed = ($('#pLogline') && $('#pLogline').value.trim()) || '';
    $('#btnBrainstorm').disabled = true;
    status('AI 现编剧本点子中…(约 5~20 秒)');
    fetch('/api/drama/brainstorm', {
      method: 'POST', headers: AUTH(), body: JSON.stringify({ seed: seed }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
    }).then(function (res) {
      $('#btnBrainstorm').disabled = false;
      if (!res.ok || !res.p.ok) { status('现编失败:' + (ERRORS[res.p.error] || res.p.error || '未知错误'), true); return; }
      showIdeaModal(res.p.ideas || []);
    }).catch(function () {
      $('#btnBrainstorm').disabled = false;
      status('现编请求失败:网络错误', true);
    });
  });

  function showIdeaModal(ideas) {
    const box = $('#ideaBox');
    box.textContent = '';
    const h = el('h3', null, 'AI 现编的点子(点击卡片直接填入)');
    box.appendChild(h);
    ideas.forEach(function (idea) {
      const card = el('div', 'idea-card');
      card.appendChild(el('b', null, idea.title || '未命名'));
      card.appendChild(el('p', null, idea.logline || ''));
      if (idea.style) card.appendChild(el('span', 'idea-style', idea.style));
      card.addEventListener('click', function () {
        fillIdea(idea);
        $('#ideaModal').style.display = 'none';
        status('已填入「' + (idea.title || '点子') + '」,可手改后生成分镜');
      });
      box.appendChild(card);
    });
    $('#ideaModal').style.display = 'flex';
  }

  function genTts(shot) {
    if (!CUR) return;
    if (!shot.lines.trim()) { status('先在台词区写对白(一行一句「角色名:台词」)', true); return; }
    dPOST('/' + CUR.id + '/shots/' + shot.id + '/tts', {}).then(function (res) {
      if (!res.ok || !res.p.ok) { status('配音失败:' + (res.p.error || ''), true); return; }
      CUR = res.p.project;
      safeRender();
      status('配音任务已提交,后台合成中(完成后该镜状态更新);「合成成片」现在也会烧字幕');
    });
  }

  // 单镜异步 TTS 任务:提交→轮询 ttsJob 到终态(串跑用,超时 120s)
  function runTtsJob(shot) {
    return new Promise(function (resolve) {
      const fail = function (msg) { if (msg) status(msg, true); resolve(false); };
      dPOST('/' + CUR.id + '/shots/' + shot.id + '/tts', {}).then(function (res) {
        if (!res.ok || !res.p.ok) { fail('配音提交失败:' + (res.p.error || '')); return; }
        CUR = res.p.project;
        const started = Date.now();
        const timer = setInterval(function () {
          if (Date.now() - started > 120000) { clearInterval(timer); fail(); return; }
          dGET('/' + CUR.id).then(function (r2) {
            if (!r2.ok || !r2.p.ok) return;
            CUR = r2.p.project;
            const cur = findShotEverywhere(shot.id).shot;
            const job = cur && cur.ttsJob;
            if (cur && (cur.tts || (job && (job.state === 'done' || job.state === 'error')))) {
              clearInterval(timer);
              if (job && job.state === 'error') fail('配音失败:' + job.error);
              else resolve(true);
            }
          });
        }, 2500);
      }).catch(function () { fail('配音提交网络中断'); });
    });
  }

  function genLipsync(shot, btn) {
    if (!CUR) return;
    if (!shot.clip) { status('先为这一镜生成成片(🎬)', true); return; }
    if (!shot.tts) { status('先生成配音(🎙):对口型需要台词音频', true); return; }
    btn.disabled = true;
    status('对口型提交中…(可灵官方,约 1~3 分钟,期间勿关页面)');
    const line = document.querySelector('.shot[data-id="' + shot.id + '"] .shot-status');
    if (line) line.textContent = '对口型进行中…';
    dPOST('/' + CUR.id + '/shots/' + shot.id + '/lipsync', {}).then(function (res) {
      btn.disabled = false;
      if (!res.ok || !res.p.ok) { status('对口型失败:' + (res.p.error || ''), true); safeRender(); return; }
      CUR = res.p.project;
      safeRender();
      syncSelTitle();
      status('对口型完成:人物已按台词动嘴,成片已替换(重新合成即可出片)');
    }).catch(function () {
      btn.disabled = false;
      status('对口型请求失败:网络错误', true);
    });
  }

  // ---------- 一键串跑:找全缺首帧/成片的镜头,限流排队自动补 ----------
  async function runAll() {
    if (!CUR || BUSY) return;
    setBusy(true, '一键串跑执行中');
    const btn = $('#btnRunAll');
    try {
      let pass = 0;
      const fails = [];
      // 对白先行:有台词没配音的镜先生成配音(TTS 异步任务,这里轮询到 done/error);
      // 失败不再静默吞:记录并在结尾汇报(否则用户以为"有台词就该有配音",合成时才发现缺)
      const epRun = curEp();
      for (const s of epRun.shots) {
        if (s.lines && s.lines.trim() && !s.tts) {
          status('串跑:生成第 ' + (epRun.shots.indexOf(s) + 1) + ' 镜配音(对白先行)…');
          await runTtsJob(s).then(function (ok) {
            if (ok) pass++;
            else fails.push('第' + (epRun.shots.indexOf(s) + 1) + '镜配音:失败/超时');
          });
        }
      }
      // 并行生成首帧(受上游并发限制,这里用 Promise.all 让所有缺首帧的镜同时提交)
      const firstFramePromises = [];
      epRun.shots.forEach((s) => {
        if (!s.firstFrame) {
          firstFramePromises.push(genFirstFrameAwait(s));
        }
      });
      if (firstFramePromises.length) status('串跑:并行生成 ' + firstFramePromises.length + ' 镜首帧…');
      await Promise.all(firstFramePromises);
      pass += firstFramePromises.length;

      // 首帧全部就绪后,并行生成成片(自动续跑:next 镜首帧链依赖已满足)
      const clipPromises = [];
      epRun.shots.forEach((s) => {
        if (s.firstFrame && !s.clip) {
          clipPromises.push(genClipAwait(s));
        }
      });
      if (clipPromises.length) status('一键成片:并行生成 ' + clipPromises.length + ' 镜成片…');
      await Promise.all(clipPromises);
      pass += clipPromises.length;

      // 关键镜抽卡(P1.2):⭐镜已有 1 候选时自动再抽一条,成片后到候片墙择优
      const keyShots = [];
      const epNow = curEp();
      epNow.shots.forEach(function (s) {
        const clipTakes = (s.takes || []).filter(function (t) { return t.kind === 'clip'; });
        if (s.key && s.clip && clipTakes.length < 2) keyShots.push(s);
      });
      if (keyShots.length) {
        status('一键成片:为 ' + keyShots.length + ' 个 ⭐关键镜再抽一条候选…');
        for (const s of keyShots) {
          await genClipAwait(s);
          pass++;
        }
      }

      // 自动合成(两道卡点之间全自动;终片审在合成后手动做)
      if (!fails.length) {
        const epFinal = curEp();
        const pending = epFinal.shots.filter(function (s) { return !s.clip; }).length;
        if (!pending) {
          status('一键成片:全部镜头就绪,自动开始本集合成…');
          await dPOST('/' + CUR.id + '/compose', { burnSubs: $('#pBurnSubs').checked, eid: epFinal.id })
            .then(function (res) {
              if (res.ok && res.p.ok) { CUR = res.p.project; pollDramaJobs(); }
              return null;
            });
        } else {
          fails.push(pending + ' 镜仍无成片,跳过自动合成');
        }
      }
      if (fails.length) status('一键成片完成,但有失败(其余 ' + pass + ' 个任务正常):' + fails.join(';'), true);
      else status('一键成片完成:' + pass + ' 个任务已执行,合成在后台跑;完成后在「成片」区终审,可到候片墙换候选');
      // P0-4: 一键成片成功后自动刷新本集前情提要(不阻塞收尾,静默失败)
      if (!fails.length) genRecap(epRun.id);
    } catch (e) {
      status('一键成片中断:' + (e && e.message ? e.message : '网络错误') + '。已生成的部分保留,再点一次会从缺的地方继续', true);
    } finally {
      setBusy(false);
    }
  }

  // P0-4: 前情提要——把本集分镜压缩成摘要存 ep.recap;下一集分镜时自动注入
  function genRecap(epId) {
    if (!CUR || !epId) return;
    dPOST('/' + CUR.id + '/recap', { eid: epId }).then(function (res) {
      if (res.ok && res.p.ok) {
        CUR = res.p.project;
        safeRender();
        status('前情提要已更新(本集摘要已存,下集分镜会自动注入)');
      }
    }).catch(function () { /* 静默失败:不影响主流程 */ });
  }

  function genFirstFrameAwait(shot) {
    return new Promise(function (resolve) {
      const orig = settle;
      // 简化实现:提交后每 20 秒查一次镜头状态,直到 firstFrame 出现或失败
      genFirstFrame(shot);
      const started = Date.now();
      const timer = setInterval(() => {
        if (shot.firstFrame || Date.now() - started > 180000) { clearInterval(timer); resolve(); return; }
        dGET('/' + CUR.id).then(res => {
          if (res.ok && res.p.ok) {
            CUR = res.p.project;
            const cur = findShotEverywhere(shot.id).shot;
            if (cur && (cur.firstFrame || (!cur.firstTaskId && !cur.firstFrame))) {
              clearInterval(timer);
              resolve();
            }
          }
        });
      }, 20000);
    });
  }

  function genClipAwait(shot) {
    return new Promise(function (resolve) {
      genClip(shot);
      const started = Date.now();
      const timer = setInterval(() => {
        if (shot.clip || Date.now() - started > 900000) { clearInterval(timer); resolve(); return; }
        dGET('/' + CUR.id).then(res => {
          if (res.ok && res.p.ok) {
            CUR = res.p.project;
            const cur = findShotEverywhere(shot.id).shot;
            if (cur && (cur.clip || (!cur.clipTaskId && !cur.clip))) {
              clearInterval(timer);
              resolve();
            }
          }
        });
      }, 20000);
    });
  }

  // ---------- 事件绑定 ----------
  // 任务进度面板:点头部展开/收起(记忆到 localStorage);默认收起只显最新一条
  try { LOG_OPEN = localStorage.getItem('ffDramaLogOpen') === '1'; } catch (e) { /* 无痕模式 */ }
  $('#logHead').addEventListener('click', function () {
    LOG_OPEN = !LOG_OPEN;
    try { localStorage.setItem('ffDramaLogOpen', LOG_OPEN ? '1' : '0'); } catch (e) { /* 忽略 */ }
    renderLog();
  });
  renderLog();

  $('#projSel').addEventListener('change', function () { loadProject(this.value); });

  $('#btnNew').addEventListener('click', function () {
    dPOST('', { title: '未命名短剧' }).then(function (res) {
      if (!res.ok || !res.p.ok) { status('新建失败:' + (res.p.error || ''), true); return; }
      loadProjects(res.p.project.id);
      status('已新建项目:点「🎲 来个灵感」或直接填故事,然后「✨ 生成分镜」');
    });
  });

  $('#btnDelProj').addEventListener('click', function () {
    if (!CUR) return;
    if (!confirm('删除项目「' + CUR.title + '」及其全部素材?不可恢复。')) return;
    dPOST('/' + CUR.id + '/delete').then(function (res) {
      if (!res.ok || !res.p.ok) { status('删除失败:' + (res.p.error || ''), true); return; }
      CUR = null;
      loadProjects();
      status('项目已删除');
    });
  });

  $('#btnSaveProj').addEventListener('click', function () { saveProj(); });

  $('#btnClearShots').addEventListener('click', function () {
    if (!CUR) return;
    const ep = curEp();
    if (!ep || !ep.shots.length) { status('本集没有镜头'); return; }
    if (!confirm('清空「' + (ep.title || '本集') + '」全部 ' + ep.shots.length + ' 个镜头(连同首帧/成片/配音素材)?\n角色库与其它集保留。不可恢复!')) return;
    COLLAPSED.clear();
    dPOST('/' + CUR.id + '/shots/clear', { eid: ep.id }).then(function (res) {
      if (!res.ok || !res.p.ok) { status('清空失败:' + (res.p.error || ''), true); return; }
      CUR = res.p.project;
      safeRender();
      status('已清空本集分镜:改好本集梗概后点「✨ 生成分镜」重新起草');
    });
  });

  // 本集梗概:失焦即保存(分镜起草时注入;改动不打断编辑流)
  $('#epSynopsis').addEventListener('change', function () {
    if (!CUR) return;
    const ep = curEp();
    if (!ep) return;
    const v = this.value;
    if (v.trim() === (ep.synopsis || '')) return;
    dPOST('/' + CUR.id + '/eps/' + ep.id + '/update', { synopsis: v })
      .then(function (res) {
        if (!res.ok || !res.p.ok) { status('本集梗概保存失败:' + (res.p.error || ''), true); return; }
        CUR = res.p.project;
        status('本集梗概已保存;生成分镜时会自动注入衔接全剧');
      });
  });

  $('#pAdvanced').addEventListener('change', function () {
    ADVANCED = this.checked;
    try { localStorage.setItem('ffDramaAdvanced', ADVANCED ? '1' : '0'); } catch (e) { /* 无痕模式 */ }
    safeRender();
    status(ADVANCED ? '高级模式:已显示首帧/运动提示词编辑框(可手改)'
                    : '简单模式:每镜只写画面描述,提示词改动后 2 秒自动重写');
  });

  $('#pWithLines').addEventListener('change', function () {
    status(this.checked ? '生成分镜时将按起/承/转/合章节起草并带台词'
                        : '生成分镜时不写台词(纯画面分镜)');
  });

  $('#pBeat').addEventListener('change', function () {
    const opt = this.options[this.selectedIndex];
    status('剧本模板:' + (opt ? opt.textContent : '默认') + '(点「保存项目信息」或直接生成分镜后生效)');
  });

  $('#btnStoryboard').addEventListener('click', function () {
    if (!CUR || BUSY) return;
    if (!$('#pLogline').value.trim()) { status('先填一句话故事', true); return; }
    // 查重:90 秒内刚成功加过分镜,提醒防止上次"网络错误"但实际成功造成的重复
    const epSb = curEp();
    const recent = (CUR.updatedAt && (Date.now() - new Date(CUR.updatedAt).getTime()) < 90000
      && epSb && epSb.shots.length > 0);
    if (recent && !confirm('这个项目 90 秒内刚更新过(上次分镜可能已成功生成)。再点会追加新镜头,继续吗?(不确定就先刷新页面看看镜头数)')) return;
    const withLines = $('#pWithLines').checked;
    setBusy(true, '保存项目信息并起草分镜…(约 10~30 秒' + (withLines ? ',带台词' : '') + ')');
    saveProj({ silent: true }).then(function (cur) {
      if (!cur) { setBusy(false); return; }
      return dPOST('/' + CUR.id + '/storyboard', {
        nShots: Number($('#pNShots').value) || 6, withLines: withLines });
    }).then(function (res) {
      setBusy(false);
      if (!res) return;
      if (!res.ok || !res.p.ok) { status('分镜失败:' + (res.p.error || '未知错误'), true); return; }
      CUR = res.p.project;
      safeRender();
      syncSelTitle();
      const added = res.p.added || [];
      const withL = added.filter(function (s) { return s.lines; }).length;
      status('已生成 ' + added.length + ' 个镜头'
        + (withL ? '(其中 ' + withL + ' 镜带台词,新镜头在对应章节分组下)' : '')
        + ':提示词/台词可手改,满意后逐镜生成或一键串跑');
    }).catch(function () {
      setBusy(false);
      // 请求层中断(连接断/超时)≠ 确定失败:LLM 在服务端跑完落盘才回包,可能已加上
      status('分镜请求中断(连接超时或断开)。镜头可能已在后台生成——先刷新页面核对镜头数,确认没加上再重试', true);
    });
  });

  $('#btnAddShot').addEventListener('click', function () {
    if (!CUR) return;
    dPOST('/' + CUR.id + '/shots/add', { scene: '', desc: '', firstPrompt: '', motionPrompt: '' })
      .then(function (res) { applyP(res, '已加一镜,填好提示词后生成'); });
  });

  $('#btnAddChar').addEventListener('click', function () {
    if (!CUR) return;
    dPOST('/' + CUR.id + '/chars/add', { name: '', desc: '' })
      .then(function (res) { applyP(res, '已加角色:填外观设定后点「生成定妆照」'); });
  });

  $('#btnCompose').addEventListener('click', function () {
    if (!CUR) return;
    const ep = curEp();
    if (!ep) return;
    $('#btnCompose').disabled = true;
    const burn = $('#pBurnSubs').checked;
    status('已提交合成任务…(ffmpeg 后台运行,镜头越多越久' + (burn ? ';烧录字幕' : ';不烧字幕') + ')');
    dPOST('/' + CUR.id + '/compose', { burnSubs: burn, eid: ep.id }).then(function (res) {
      $('#btnCompose').disabled = false;
      if (!res.ok || !res.p.ok) { status('合成提交失败:' + (res.p.error || ''), true); return; }
      CUR = res.p.project;
      safeRender();
      // 拉取合成前预警(台词比成片长的镜头,合成时会被截断)
      dGET('/' + CUR.id + '/warnings?eid=' + ep.id).then(function (wres) {
        if (!wres.ok || !wres.p.ok) return;
        const w = wres.p.warnings || [];
        if (w.length) {
          status('合成进行中;⚠ ' + w.length + ' 镜台词比画面长,会被截断:' +
            w.map(function (x) { return x.scene; }).join('、'), true);
        }
      });
    }).catch(function () {
      $('#btnCompose').disabled = false;
      status('合成提交网络中断;后台可能已在跑,稍后刷新页面看「成片」区', true);
    });
  });

  $('#btnRemix').addEventListener('click', function () {
    if (!CUR) return;
    const eps = (CUR.episodes || []).filter(function (e) { return e.composed; });
    if (!eps.length) { status('还没有任何集成片:先逐集(或一键成片)合成', true); return; }
    if (!confirm('全剧重混:对 ' + eps.length + ' 个已合成集逐集响度归一(loudnorm),再拼成 series.mp4(含片头片尾字卡)?\nffmpeg 后台运行,时长约等于全部成片总长。')) return;
    dPOST('/' + CUR.id + '/remix', {}).then(function (res) {
      if (!res.ok || !res.p.ok) { status('重混提交失败:' + (res.p.error || ''), true); return; }
      CUR = res.p.project;
      safeRender();
      pollDramaJobs();
      status('全剧重混已提交,后台运行中…');
    });
  });

  $('#btnPlayAll').addEventListener('click', playAll);
  $('#btnRunAll').addEventListener('click', function () {
    if (!CUR || BUSY) return;
    if (!confirm('一键成片:自动为全部缺首帧/成片的镜头生成,⭐关键镜自动再抽一条候选,最后自动合成出本集成片。\n全程按限额排队(约每 22 秒一单),期间请勿手动提交任务。')) return;
    runAll();
  });
  $('#playModal').addEventListener('click', function (e) { if (e.target === this) this.style.display = 'none'; });
  $('#ideaModal').addEventListener('click', function (e) { if (e.target === this) this.style.display = 'none'; });
  $('#lightbox').addEventListener('click', function () { this.style.display = 'none'; });

  // ---------- 启动:等 gate.js 解锁后再拉项目 ----------
  function init() {
    $('#bootHint').hidden = true;
    $('#app').hidden = false;
    // 隐藏的参考图文件选择器(角色行「+」触发)
    charRefInput = document.createElement('input');
    charRefInput.type = 'file';
    charRefInput.accept = 'image/jpeg,image/png,image/webp';
    charRefInput.hidden = true;
    charRefInput.addEventListener('change', function () {
      if (!charRefTarget || !charRefInput.files || !charRefInput.files.length) return;
      const ch = (CUR.chars || []).find(function (c) { return c.id === charRefTarget; });
      if (ch) addCharRefFiles(ch, charRefInput.files);
    });
    document.body.appendChild(charRefInput);
    fetch('/api/drama/meta', { headers: AUTH() })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        if (p && p.ok) {
          META.styles = p.styles || [];
          META.ideas = p.ideas || [];
          META.linesIdeas = p.linesIdeas || [];
          META.voices = p.voices || [];
          renderStyleChips();
          $('#brainHint').hidden = false;
        }
      }).catch(function () { /* 样式 chips/灵感按钮静默降级 */ });
    // 视频模型时长表:取默认视频模型的 supported_durations(kling v3.0 = 3~15)
    fetch('/api/studio/models', { headers: AUTH() })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        const m = (p.models || []).find(function (x) { return x.id === VID_MODEL; });
        if (m && Array.isArray(m.durations) && m.durations.length) {
          VID_DURATIONS = m.durations.filter(function (d) { return d >= 2 && d <= 30; });
          safeRender();
        }
      }).catch(function () { /* 保持默认 5/10 */ });
    loadProjects();
    refreshQuota();
  }
  // ---------- P0-1: 一句话开拍全自动入口 ----------
  // 串接:角色定妆 → 等待全部完成 → 分镜 → 一键成片。
  // 用法:浏览器控制台执行 startAutoFilming();或绑定到 UI 按钮。
  async function startAutoFilming() {
    if (!CUR) { status('请先选择或创建一个项目', true); return; }
    if (BUSY) { status('当前有任务正在执行,请稍后再试', true); return; }
    status('🚀 一句话开拍:流程启动…');
    const chars = (CUR.chars || []);
    if (!chars.length) { status('请先添加角色', true); return; }
    // 1. 触发所有缺定妆照的角色生成
    let triggered = 0;
    chars.forEach(function (ch) {
      if (!ch.portraitTaskId) { genPortrait(ch); triggered++; }
    });
    if (!triggered) status('角色定妆照已就绪,跳过定妆阶段');
    else status('已提交 ' + triggered + ' 个角色定妆任务,等待完成…');
    // 2. 轮询等待所有定妆照完成(3s 一查,最长等 10 分钟)
    const MAX_WAIT = 10 * 60 * 1000;
    const startT = Date.now();
    const waitForPortraits = new Promise(function (resolve) {
      const timer = setInterval(function () {
        const active = Object.keys(poll).filter(function (tid) { return poll[tid].kind === 'portrait'; });
        if (active.length === 0 || Date.now() - startT > MAX_WAIT) {
          clearInterval(timer);
          resolve();
        }
      }, 3000);
    });
    await waitForPortraits;
    status('✅ 角色定妆阶段结束,开始生成分镜…');
    // 3. 生成分镜(模拟点击 btnStoryboard 触发其内部逻辑:保存项目信息并 POST)
    $('#btnStoryboard').click();
    // 4. 轮询等待分镜完成(BUSY 状态解除即代表分镜动作结束)
    const waitForStoryboard = new Promise(function (resolve) {
      const timer = setInterval(function () {
        if (!BUSY) { clearInterval(timer); resolve(); }
      }, 5000);
    });
    await waitForStoryboard;
    status('✅ 分镜完成,开始一键成片(自动配音/首帧/成片/合成)…');
    // 5. 一键成片(直接调用 runAll 绕过 confirm 弹窗)
    try { await runAll(); } catch (e) { status('一键成片执行异常:' + (e && e.message ? e.message : ''), true); }
    status('🎉 一句话开拍流程全部完成!');
  }
  window.startAutoFilming = startAutoFilming;

  const boot = setInterval(function () {
    if (window.FFGate && FFGate.ok) { clearInterval(boot); init(); }
  }, 200);
})();
