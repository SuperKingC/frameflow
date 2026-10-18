// FrameFlow - 内容运营工作台(ops.html)v2
// 三 tab:创作(人设卡→选题→LLM 文案→建帖→配图/视频→发布包)/ 排期(周历+复盘)/ 调研(直达+对标+拆解)。
// 后端 /api/ops/* 与生图工作台同一把邀请码门禁;生成复用 /api/studio/tasks(额度零改动)。
// 发布是人工流程:复制文案 + 下载 zip,不做任何平台自动化。
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // ---------- API ----------
  function AUTH() {
    return { 'content-type': 'application/json',
             authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') };
  }
  function unwrap(r) {
    return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, p: p }; });
  }
  function oGET(path) {
    return fetch('/api/ops' + path, { headers: AUTH() }).then(unwrap);
  }
  function oPOST(path, body) {
    return fetch('/api/ops' + path, { method: 'POST', headers: AUTH(),
                                      body: JSON.stringify(body || {}) }).then(unwrap);
  }
  function studioSubmit(body) {
    return fetch('/api/studio/tasks', { method: 'POST', headers: AUTH(),
                                        body: JSON.stringify(body) }).then(unwrap);
  }
  function studioGet(taskId) {
    return fetch('/api/studio/tasks/' + taskId, { headers: AUTH() }).then(unwrap);
  }

  var ERRORS = {
    invalid_invite_code: '邀请码不正确',
    invite_locked: '邀请码错误次数过多,今天已锁定',
    rate_limit_exceeded: '触发频率限制,请稍后再试',
    invalid_prompt: '请先填写选题',
    invalid_platform: '平台不合法',
    upstream_unavailable: '生成服务不可用(未配置上游 key 或来源受限)',
    upstream_rejected: '上游拒绝了这次请求,稍后重试',
    upstream_invalid_response: '上游返回异常,重试一次看看',
    task_pool_full: '任务池已满,稍后再试',
  };
  function errMsg(p) {
    var e = p && p.error;
    if (ERRORS[e]) return ERRORS[e];
    return typeof e === 'string' && e ? e : '请求失败,请重试';
  }
  function status(msg, isErr) {
    var s = $('#status');
    s.textContent = msg;
    s.classList.toggle('error', !!isErr);
  }

  // ---------- 状态 ----------
  var META = null;
  var PERSONAS = [];
  var CUR = null;           // 当前人设 id
  var COPIES = [];
  var POSTS = [];           // 完整帖子记录(含 assets/scheduleAt/stats)
  var CURPOST = null;
  var TOPICS = [];
  var RESEARCH = [];
  var LIB = [];
  var MODELS = [];
  var GENREFS = [];
  var GENOWNER = {};        // taskId -> postId
  var GENRESULTS = {};      // taskId -> 快照
  var POLL = {};            // taskId -> true(轮询中)
  var tagPlat = 'xhs';
  var libMode = 'asset';
  var libPicked = {};
  var saveTimer = null;
  var statsTimer = null;
  var ACCT_FILTER = '';
  var STATUS_FILTER = '';
  var RF_FILTER = '';
  var WEEK_OFFSET = 0;      // 0=本周,±N 周
  var KIND_SEL = 'image';

  function currentPersona() {
    for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === CUR) return PERSONAS[i];
    return null;
  }
  function platformLabel(k) {
    return (META && META.platforms[k] && META.platforms[k].label) || k;
  }
  function statusLabel(id) {
    if (!META) return id;
    for (var i = 0; i < META.statuses.length; i++) {
      if (META.statuses[i].id === id) return META.statuses[i].label;
    }
    return id;
  }
  function personaName(id) {
    for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === id) return PERSONAS[i].name;
    return '?';
  }

  // ---------- 工具 ----------
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { status('已复制到剪贴板'); },
                                                        function () { fallbackCopy(text); });
    }
    fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); status('已复制到剪贴板'); }
    catch (e) { status('复制失败,请手动选择文本复制', true); }
    document.body.removeChild(ta);
  }
  function blobToDataURL(b) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error('读取失败')); };
      r.readAsDataURL(b);
    });
  }
  function libraryDataURL(name) {
    return fetch('/api/ops/library/file/' + encodeURIComponent(name), { headers: AUTH() })
      .then(function (r) {
        if (!r.ok) throw new Error('素材获取失败');
        return r.blob();
      }).then(blobToDataURL);
  }
  function tagLine(tags) {
    return (tags || []).map(function (t) { return '#' + t; }).join(' ');
  }
  function composedText(post) {
    var c = (post && post.chosen) || {};
    var parts = [];
    if (c.title) parts.push(c.title);
    if (c.body) parts.push(c.body);
    if (c.tags && c.tags.length) parts.push(tagLine(c.tags));
    return parts.join('\n\n');
  }
  function fmtDate(iso) {
    return (iso || '').replace('T', ' ').slice(0, 16);
  }
  function dayISO(d) {
    function z(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  function openLightbox(src, isVideo) {
    var img = $('#lightboxImg'), vid = $('#lightboxVideo');
    if (isVideo) {
      img.hidden = true;
      vid.hidden = false;
      vid.src = src;
    } else {
      vid.hidden = true;
      vid.removeAttribute('src');
      img.hidden = false;
      img.src = src;
    }
    $('#lightbox').style.display = 'flex';
  }
  function closeLightbox() {
    $('#lightbox').style.display = 'none';
    $('#lightboxVideo').pause && $('#lightboxVideo').pause();
  }

  // ---------- 启动 ----------
  var boot = setInterval(function () {
    if (window.FFGate && FFGate.ok) {
      clearInterval(boot);
      $('#bootHint').hidden = true;
      $('#app').hidden = false;
      init();
    }
  }, 200);

  function init() {
    wireStatic();
    loadMeta().then(function () {
      return Promise.all([loadPersonas(), loadModels(), loadLibrary()]);
    }).then(function () {
      return Promise.all([loadTopics(), loadResearch(), loadPosts()]);
    }).then(function () {
      renderAll();
      setInterval(pollLoop, 3000);
      status('就绪。选题 → 文案 → 配图/视频 → 排期 → 人工发布。');
    }).catch(function (e) {
      status('初始化失败:' + (e && e.message || e), true);
    });
  }

  function wireStatic() {
    $('#tabCreate').addEventListener('click', function () { switchTab('create'); });
    $('#tabSched').addEventListener('click', function () { switchTab('sched'); });
    $('#tabResearch').addEventListener('click', function () { switchTab('research'); });
    document.querySelectorAll('.ops-card-head[data-fold]').forEach(function (h) {
      h.addEventListener('click', function () {
        var body = document.getElementById(h.getAttribute('data-fold'));
        var card = h.parentElement;
        var fold = h.querySelector('.fold');
        var nowHidden = body.hidden;
        body.hidden = !nowHidden;
        card.classList.toggle('folded', !nowHidden);
        fold.textContent = nowHidden ? '收起 ▴' : '展开 ▾';
      });
    });
    $('#dueBanner').addEventListener('click', function () {
      WEEK_OFFSET = 0;
      switchTab('sched');
    });
    $('#personaSel').addEventListener('change', function () {
      CUR = this.value;
      COPIES = [];
      $('#copyList').innerHTML = '';
      fillPersonaForm();
      renderTags();
    });
    $('#btnSavePersona').addEventListener('click', savePersona);
    $('#tagPlat').addEventListener('change', function () { tagPlat = this.value; renderTags(); });
    $('#btnTagAdd').addEventListener('click', addTag);
    $('#tagNew').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTag(); });
    $('#kindSel').addEventListener('change', function () { KIND_SEL = this.value; });
    $('#btnGenCopy').addEventListener('click', genCopy);
    $('#btnNewPost').addEventListener('click', newEmptyPost);
    $('#acctFilter').addEventListener('change', function () { ACCT_FILTER = this.value; renderPostList(); });
    $('#statusFilter').addEventListener('change', function () { STATUS_FILTER = this.value; renderPostList(); });
    $('#wkPrev').addEventListener('click', function () { WEEK_OFFSET--; renderSched(); });
    $('#wkNext').addEventListener('click', function () { WEEK_OFFSET++; renderSched(); });
    $('#wkToday').addEventListener('click', function () { WEEK_OFFSET = 0; renderSched(); });
    $('#btnXhsSearch').addEventListener('click', function () { openLink('xhsSearch'); });
    $('#btnDySearch').addEventListener('click', function () { openLink('dySearch'); });
    $('#btnXhsExplore').addEventListener('click', function () { openLink('xhsExplore'); });
    $('#btnDyHot').addEventListener('click', function () { openLink('dyHot'); });
    $('#rfAcctFilter').addEventListener('change', function () { RF_FILTER = this.value; renderResearch(); });
    $('#btnResearchAdd').addEventListener('click', addResearch);
    $('#btnAnalyze').addEventListener('click', analyze);
    $('#btnTopicAdd').addEventListener('click', addTopicManual);
    $('#lightbox').addEventListener('click', closeLightbox);
    $('#libModal').addEventListener('click', function (e) {
      if (e.target === this) this.style.display = 'none';
    });
    $('#optModal').addEventListener('click', function (e) {
      if (e.target === this) this.style.display = 'none';
    });
    $('#btnPersonaOptimize').addEventListener('click', function () {
      if (!$('#pfPositioning').value.trim() && !$('#pfVisual').value.trim() &&
          !$('#pfTone').value.trim() && !$('#pfTaboos').value.trim()) {
        status('先填一点人设内容再优化(定位/视觉/语气任一)', true);
        return;
      }
      opsOptimize(this, 'persona', personaText(), adoptPersona);
    });
  }

  function switchTab(name) {
    $('#paneCreate').hidden = name !== 'create';
    $('#paneSched').hidden = name !== 'sched';
    $('#paneResearch').hidden = name !== 'research';
    $('#tabCreate').classList.toggle('active', name === 'create');
    $('#tabSched').classList.toggle('active', name === 'sched');
    $('#tabResearch').classList.toggle('active', name === 'research');
    if (name === 'sched') renderSched();
  }

  function openLink(kind) {
    var tpl = META && META.links && META.links[kind];
    if (!tpl) { status('链接模板缺失', true); return; }
    var kw = ($('#kwInput').value || '').trim();
    if (tpl.indexOf('{kw}') >= 0 && !kw) { status('先输入关键词', true); return; }
    window.open(tpl.replace('{kw}', encodeURIComponent(kw)), '_blank', 'noopener');
  }

  // ---------- 加载 ----------
  function loadMeta() {
    return oGET('/meta').then(function (r) {
      if (!r.ok) throw new Error(errMsg(r.p));
      META = r.p;
      var sel = $('#pillarSel');
      sel.innerHTML = '';
      META.pillars.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p; o.textContent = p;
        sel.appendChild(o);
      });
      var sf = $('#statusFilter');
      sf.innerHTML = '';
      var all = document.createElement('option');
      all.value = ''; all.textContent = '全部状态';
      sf.appendChild(all);
      META.statuses.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id; o.textContent = s.label;
        sf.appendChild(o);
      });
    });
  }
  function loadModels() {
    return fetch('/api/studio/models', { headers: AUTH() }).then(unwrap).then(function (r) {
      MODELS = ((r.p && r.p.models) || []).filter(function (m) { return m.kind === 'image'; });
    });
  }
  function loadLibrary() {
    return oGET('/library').then(function (r) {
      LIB = (r.p && r.p.items) || [];
    });
  }
  function loadPersonas() {
    return oGET('/personas').then(function (r) {
      if (!r.ok) throw new Error(errMsg(r.p));
      PERSONAS = r.p.personas || [];
      if (!CUR && PERSONAS.length) CUR = PERSONAS[0].id;
      renderAcctSelects();
    });
  }
  function renderAcctSelects() {
    [['#acctFilter', '全部账号', ACCT_FILTER, function (v) { ACCT_FILTER = v; renderPostList(); }],
     ['#rfAccount', null, CUR, null],
     ['#rfAcctFilter', '全部账号', RF_FILTER, function (v) { RF_FILTER = v; renderResearch(); }]
    ].forEach(function (cfg) {
      var sel = $(cfg[0]);
      if (!sel) return;
      sel.innerHTML = '';
      if (cfg[1]) {
        var all = document.createElement('option');
        all.value = ''; all.textContent = cfg[1];
        sel.appendChild(all);
      }
      PERSONAS.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.value = cfg[2] || '';
    });
  }
  function loadTopics() {
    return oGET('/topics').then(function (r) { TOPICS = (r.p && r.p.topics) || []; });
  }
  function loadResearch() {
    return oGET('/research').then(function (r) { RESEARCH = (r.p && r.p.items) || []; });
  }
  function loadPosts() {
    return oGET('/posts').then(function (r) {
      if (!r.ok) throw new Error(errMsg(r.p));
      POSTS = (r.p && r.p.posts) || [];
    });
  }

  function renderAll() {
    renderPersonaSel();
    fillPersonaForm();
    renderTags();
    renderTopicChips();
    renderTopicList();
    renderResearch();
    renderAcctSelects();
    renderPostList();
    renderDueBanner();
  }

  // ---------- 人设卡 ----------
  function renderPersonaSel() {
    var sel = $('#personaSel');
    sel.innerHTML = '';
    PERSONAS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      if (p.id === CUR) o.selected = true;
      sel.appendChild(o);
    });
  }
  function fillPersonaForm() {
    var p = currentPersona();
    if (!p) return;
    $('#pfName').value = p.name || '';
    $('#pfPositioning').value = p.persona.positioning || '';
    $('#pfAudience').value = p.persona.audience || '';
    $('#pfTone').value = p.persona.tone || '';
    $('#pfCatchphrase').value = p.persona.catchphrase || '';
    $('#pfVisual').value = p.persona.visual || '';
    $('#pfTaboos').value = p.persona.taboos || '';
  }
  function savePersona() {
    if (!CUR) { status('没有账号', true); return; }
    var p = currentPersona();
    oPOST('/personas/' + CUR + '/update', {
      name: $('#pfName').value,
      persona: {
        positioning: $('#pfPositioning').value,
        audience: $('#pfAudience').value,
        tone: $('#pfTone').value,
        catchphrase: $('#pfCatchphrase').value,
        visual: $('#pfVisual').value,
        taboos: $('#pfTaboos').value,
        pillars: p.persona.pillars,
      },
      tags: p.tags,
    }).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return; }
      for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === CUR) PERSONAS[i] = r.p.persona;
      fillPersonaForm();
      renderTags();
      status('人设卡已保存:后续文案与配图都按它生成');
    });
  }
  function patchPersonaTags(tags) {
    return oPOST('/personas/' + CUR + '/update', { tags: tags }).then(function (r) {
      if (r.ok) {
        for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === CUR) PERSONAS[i] = r.p.persona;
      }
      return r;
    });
  }

  // ---------- 标签库 ----------
  function renderTags() {
    var box = $('#tagCloud');
    box.innerHTML = '';
    var p = currentPersona();
    if (!p) return;
    (p.tags[tagPlat] || []).forEach(function (t, idx) {
      var chip = el('span', 'ops-tag');
      chip.appendChild(el('span', 'g g-' + t.group, t.group));
      chip.appendChild(el('span', null, '#' + t.name));
      var x = el('span', 'x', '×');
      x.title = '从标签库删除';
      x.addEventListener('click', function () {
        var tags = JSON.parse(JSON.stringify(p.tags));
        tags[tagPlat].splice(idx, 1);
        patchPersonaTags(tags).then(function (r) {
          if (r.ok) { renderTags(); status('已删除标签'); } else status(errMsg(r.p), true);
        });
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }
  function addTag() {
    var name = ($('#tagNew').value || '').trim().replace(/^#/, '');
    if (!name) { status('先填标签名', true); return; }
    var p = currentPersona();
    var group = $('#tagGroup').value;
    var tags = JSON.parse(JSON.stringify(p.tags));
    tags[tagPlat] = tags[tagPlat] || [];
    for (var i = 0; i < tags[tagPlat].length; i++) {
      if (tags[tagPlat][i].name === name) { status('标签已存在', true); return; }
    }
    tags[tagPlat].push({ name: name, group: group });
    patchPersonaTags(tags).then(function (r) {
      if (r.ok) { $('#tagNew').value = ''; renderTags(); status('标签已入库'); }
      else status(errMsg(r.p), true);
    });
  }
  function tagsInLibrary(plat) {
    var p = currentPersona();
    var set = {};
    ((p && p.tags && p.tags[plat]) || []).forEach(function (t) { set[t.name] = true; });
    return set;
  }

  // ---------- 选题 ----------
  function renderTopicChips() {
    var box = $('#topicChips');
    box.innerHTML = '';
    TOPICS.forEach(function (t) {
      var chip = el('button', 'chip-btn' + (t.used ? ' used' : ''), (t.used ? '✓ ' : '') + t.text);
      chip.type = 'button';
      chip.title = '支柱:' + t.pillar + (t.used ? '(已用过)' : '');
      chip.addEventListener('click', function () {
        $('#topicInput').value = t.text;
        $('#pillarSel').value = t.pillar;
        if (!t.used) oPOST('/topics/' + t.id + '/update', { used: true }).then(refreshTopics);
        status('选题已填入:' + t.text);
      });
      box.appendChild(chip);
    });
  }
  function refreshTopics() {
    loadTopics().then(function () { renderTopicChips(); renderTopicList(); });
  }
  function renderTopicList() {
    var box = $('#topicList');
    box.innerHTML = '';
    TOPICS.forEach(function (t) {
      var row = el('div', 'topic-row' + (t.used ? ' used' : ''));
      row.appendChild(el('span', 't-src s-' + t.source,
        t.source === 'seed' ? '预置' : (t.source === 'research' ? '拆解' : '手动')));
      row.appendChild(el('span', 't-pillar', t.pillar));
      row.appendChild(el('span', 't-text', t.text));
      var use = el('button', 'btn', '用此选题');
      use.type = 'button';
      use.addEventListener('click', function () {
        switchTab('create');
        $('#topicInput').value = t.text;
        $('#pillarSel').value = t.pillar;
        if (!t.used) oPOST('/topics/' + t.id + '/update', { used: true }).then(refreshTopics);
        status('选题已填入创作面板');
      });
      row.appendChild(use);
      var del = el('button', 'btn', '删');
      del.type = 'button';
      del.addEventListener('click', function () {
        oPOST('/topics/' + t.id + '/delete').then(refreshTopics);
      });
      row.appendChild(del);
      box.appendChild(row);
    });
  }
  function addTopicManual() {
    var text = window.prompt('新选题(一句话)');
    if (!text || !text.trim()) return;
    oPOST('/topics', { text: text.trim(), pillar: $('#pillarSel').value, source: 'manual' })
      .then(function (r) {
        if (r.ok) refreshTopics(); else status(errMsg(r.p), true);
      });
  }
  function saveTopicsFromList(ideas) {
    return Promise.all(ideas.map(function (text) {
      return oPOST('/topics', { text: text, pillar: $('#pillarSel').value, source: 'research' });
    })).then(refreshTopics);
  }

  // ---------- 文案生成 ----------
  function selectedPlatforms() {
    var ps = [];
    if ($('#platXhs').checked) ps.push('xhs');
    if ($('#platDy').checked) ps.push('dy');
    return ps;
  }
  function genCopy() {
    var topic = ($('#topicInput').value || '').trim();
    if (!CUR) { status('还没有账号人设', true); return; }
    if (!topic) { status('先写一句话选题', true); return; }
    var ps = selectedPlatforms();
    if (!ps.length) { status('至少勾选一个平台', true); return; }
    var platform = ps[0];
    KIND_SEL = $('#kindSel').value;
    var btn = $('#btnGenCopy');
    btn.disabled = true;
    status('正在按「' + currentPersona().name + '」人设生成 ' + platformLabel(platform) +
           (KIND_SEL === 'video' ? ' 视频帖' : ' 图文') + ' 文案…(10~30 秒)');
    oPOST('/copy', { personaId: CUR, topic: topic, pillar: $('#pillarSel').value,
                     platform: platform, kind: KIND_SEL }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { status(errMsg(r.p), true); return; }
      COPIES = r.p.copies || [];
      renderCopies(platform);
      status('已生成 ' + COPIES.length + ' 版文案;点 tag 增删,满意就「用这版」建帖');
    });
  }
  function renderCopies(platform) {
    var box = $('#copyList');
    box.innerHTML = '';
    var plat = platform || selectedPlatforms()[0] || 'xhs';
    var lib = tagsInLibrary(plat);
    COPIES.forEach(function (c, i) {
      var card = el('div', 'copy-card');
      card.appendChild(el('div', 'c-head',
        '版本 ' + (i + 1) + ' · ' + platformLabel(plat) + ' · ' + (KIND_SEL === 'video' ? '视频帖' : '图文')));
      var title = el('input', 'txt');
      title.value = c.title;
      title.addEventListener('input', function () { c.title = this.value; });
      card.appendChild(title);
      var body = el('textarea');
      body.rows = Math.min(8, Math.max(3, Math.ceil((c.body || '').length / 40)));
      body.value = c.body;
      body.addEventListener('input', function () { c.body = this.value; });
      card.appendChild(body);
      var tags = el('div', 'c-ops');
      (c.tags || []).forEach(function (t) {
        var on = lib[t];
        var chip = el('span', 'ops-tag clickable' + (on ? ' on' : ''), '#' + t);
        if (!on) chip.title = '标签库没有,建帖后可一键收进标签库';
        chip.addEventListener('click', function () {
          var idx = c.tags.indexOf(t);
          if (idx >= 0) { c.tags.splice(idx, 1); chip.classList.remove('on'); }
          else { c.tags.push(t); chip.classList.add('on'); }
        });
        tags.appendChild(chip);
      });
      card.appendChild(tags);
      var ops = el('div', 'c-ops');
      var use = el('button', 'btn primary', '用这版 → 建帖');
      use.type = 'button';
      use.addEventListener('click', function () { useThisCopy(i); });
      ops.appendChild(use);
      var cp = el('button', 'btn', '复制');
      cp.type = 'button';
      cp.addEventListener('click', function () {
        copyText([c.title, c.body, tagLine(c.tags)].filter(Boolean).join('\n\n'));
      });
      ops.appendChild(cp);
      card.appendChild(ops);
      box.appendChild(card);
    });
  }
  function useThisCopy(i) {
    var c = COPIES[i];
    if (!c) return;
    var topic = ($('#topicInput').value || '').trim();
    oPOST('/posts', { accountId: CUR, topic: topic, pillar: $('#pillarSel').value,
                      kind: $('#kindSel').value,
                      platforms: selectedPlatforms(), copies: COPIES,
                      chosen: { title: c.title, body: c.body, tags: c.tags.slice() } })
      .then(function (r) {
        if (!r.ok) { status(errMsg(r.p), true); return; }
        loadPosts().then(function () {
          openPost(r.p.post.id);
          status('帖子已建(草稿态),可以配图/挂视频或继续改文案');
        });
      });
  }

  // ---------- 帖子列表 ----------
  function filteredPosts() {
    return POSTS.filter(function (p) {
      if (ACCT_FILTER && p.accountId !== ACCT_FILTER) return false;
      if (STATUS_FILTER && p.status !== STATUS_FILTER) return false;
      return true;
    });
  }
  function renderPostList() {
    var box = $('#postList');
    box.innerHTML = '';
    var sorted = filteredPosts().sort(function (a, b) {
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    sorted.forEach(function (p) {
      var card = el('div', 'post-card' + (CURPOST && CURPOST.id === p.id ? ' sel' : ''));
      card.appendChild(el('span', 'post-dot ' + p.status));
      var main = el('div', 'p-main');
      main.appendChild(el('div', 'p-title', (p.chosen && p.chosen.title) || p.topic));
      var bits = [(p.accountName || personaName(p.accountId))];
      bits.push(p.platforms.map(platformLabel).join('/'));
      bits.push(statusLabel(p.status));
      if (p.kind === 'video') bits.push('🎬视频');
      var assetN = (p.assets || []).length;
      if (assetN) bits.push('🖼' + assetN);
      main.appendChild(el('div', 'p-meta', bits.join(' · ') + ' · ' + fmtDate(p.updatedAt)));
      card.appendChild(main);
      if (p.scheduleAt) card.appendChild(el('span', 'p-sched', p.scheduleAt.slice(5)));
      card.addEventListener('click', function () { openPost(p.id); });
      box.appendChild(card);
    });
    $('#postEmpty').hidden = sorted.length > 0;
    $('#postListView').hidden = !!CURPOST;
    $('#postDetail').hidden = !CURPOST;
    renderDueBanner();
  }
  function refreshPostRow() {
    var hidden = $('#postListView').hidden;
    var detHidden = $('#postDetail').hidden;
    renderPostList();
    $('#postListView').hidden = hidden;
    $('#postDetail').hidden = detHidden;
  }
  function openPost(pid) {
    oGET('/posts/' + pid).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return; }
      CURPOST = r.p.post;
      if (!GENREFS.length && LIB.some(function (x) { return x.name === 'probe_gpt-5_4-image-2.png'; })) {
        GENREFS.push('probe_gpt-5_4-image-2.png');  // 默认挂审定主关键帧,保形象一致(可点掉)
      }
      renderPostList();
      renderPostDetail();
    });
  }
  function closePost() {
    CURPOST = null;
    renderPostList();
  }
  function patchPost(fields) {
    if (!CURPOST) return Promise.resolve(null);
    return oPOST('/posts/' + CURPOST.id + '/update', fields).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return null; }
      CURPOST = r.p.post;
      refreshPostRow();
      return CURPOST;
    });
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!CURPOST) return;
      oPOST('/posts/' + CURPOST.id + '/update',
            { chosen: CURPOST.chosen, notes: CURPOST.notes }).then(function (r) {
        if (!r.ok) { status(errMsg(r.p), true); return; }
        CURPOST = r.p.post;
        refreshPostRow();
      });
    }, 700);
  }
  function scheduleStatsSave() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(function () {
      if (!CURPOST) return;
      oPOST('/posts/' + CURPOST.id + '/update', { stats: CURPOST.stats }).then(function (r) {
        if (!r.ok) { status(errMsg(r.p), true); return; }
        CURPOST = r.p.post;
        refreshPostRow();
      });
    }, 700);
  }

  function newEmptyPost() {
    var topic = ($('#topicInput').value || '').trim();
    if (!topic) topic = window.prompt('这条帖子讲什么(选题)');
    if (!topic) return;
    oPOST('/posts', { accountId: CUR, topic: topic, pillar: $('#pillarSel').value,
                      kind: $('#kindSel').value,
                      platforms: selectedPlatforms() }).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return; }
      loadPosts().then(function () {
        openPost(r.p.post.id);
        status('空帖已建(想法态)');
      });
    });
  }

  // ---------- 帖子详情 ----------
  var STEPS = [
    { id: 'idea', label: '想法' },
    { id: 'draft', label: '草稿' },
    { id: 'ready', label: '待发' },
    { id: 'published', label: '已发' },
  ];

  function renderPostDetail() {
    var p = CURPOST;
    if (!p) return;
    var box = $('#postDetail');
    box.innerHTML = '';
    var d = el('div', 'ops-detail');

    // ---- 头部:状态 stepper + 操作 ----
    var head = el('div', 'ops-detail-head');
    var steps = el('div', 'ops-steps');
    var curIdx = STEPS.findIndex(function (s) { return s.id === p.status; });
    STEPS.forEach(function (s, i) {
      var st = el('span', 'ops-step' + (i < curIdx ? ' done' : '') + (i === curIdx ? ' cur' : '') +
                  (i !== curIdx ? ' tok' : ''));
      st.appendChild(el('span', 'sdot'));
      st.appendChild(el('span', null, s.label));
      if (i !== curIdx) {
        st.title = '改为「' + s.label + '」';
        st.addEventListener('click', function () {
          patchPost({ status: s.id }).then(function (np) { if (np) renderPostDetail(); });
        });
      }
      steps.appendChild(st);
      if (i < STEPS.length - 1) steps.appendChild(el('span', null, '→'));
    });
    head.appendChild(steps);
    head.appendChild(el('span', 'spacer'));
    var copyBtn = el('button', 'btn primary', '📋 复制文案');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () { copyText(composedText(CURPOST)); });
    head.appendChild(copyBtn);
    var zip = el('button', 'btn', '⬇ 发布包');
    zip.type = 'button';
    zip.addEventListener('click', downloadPackage);
    head.appendChild(zip);
    var back = el('button', 'btn', '返回列表');
    back.type = 'button';
    back.addEventListener('click', closePost);
    head.appendChild(back);
    var del = el('button', 'btn', '🗑');
    del.type = 'button';
    del.title = '删除帖子';
    del.addEventListener('click', function () {
      if (!window.confirm('删除这条帖子?文案与素材一并删除,不可恢复。')) return;
      oPOST('/posts/' + p.id + '/delete').then(function () {
        CURPOST = null;
        loadPosts().then(renderPostList);
        status('帖子已删除');
      });
    });
    head.appendChild(del);
    d.appendChild(head);

    // ---- 中区:左=文案,右=标签+排期与数据 ----
    var mid = el('div', 'ops-grid2');
    var leftCol = el('div', 'ops-col');

    // 文案卡(fill:与右栏等高,正文 textarea 吃满)
    var copy = el('div', 'ops-subcard fill');
    var copyHead = el('div', 'sc-head');
    copyHead.appendChild(el('span', null, '📝 文案'));
    var kindSel = el('select');
    kindSel.style.cssText = 'width:auto;margin-left:auto;font-size:11.5px;padding:2px 6px';
    [['image', '图文'], ['video', '🎬 视频']].forEach(function (kv) {
      var o = document.createElement('option');
      o.value = kv[0]; o.textContent = kv[1];
      if (p.kind === kv[0]) o.selected = true;
      kindSel.appendChild(o);
    });
    kindSel.addEventListener('change', function () {
      patchPost({ kind: this.value });
    });
    copyHead.appendChild(kindSel);
    copy.appendChild(copyHead);
    var c = p.chosen || { title: '', body: '', tags: [] };
    var topicLine = el('div', 'hint', '选题:' + p.topic + ' · 支柱:' + p.pillar);
    topicLine.style.margin = '0 0 8px';
    copy.appendChild(topicLine);
    var plats = el('div', 'ops-row');
    plats.style.marginBottom = '6px';
    plats.appendChild(el('span', 'sc-note', '发布平台:'));
    ['xhs', 'dy'].forEach(function (k) {
      var lb = el('label', 'row');
      lb.style.margin = '0';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'pd' + k;
      cb.checked = p.platforms.indexOf(k) >= 0;
      cb.addEventListener('change', function () {
        var ps = [];
        if ($('#pdXhs').checked) ps.push('xhs');
        if ($('#pdDy').checked) ps.push('dy');
        if (!ps.length) { cb.checked = true; return; }
        patchPost({ platforms: ps }).then(function (np) { if (np) renderPostDetail(); });
      });
      lb.appendChild(cb);
      lb.appendChild(document.createTextNode(' ' + platformLabel(k)));
      plats.appendChild(lb);
    });
    copy.appendChild(plats);
    var titleLb = el('label', 'f-label');
    var titleIn = el('input', 'txt');
    titleIn.value = c.title || '';
    var titleHead = el('div', 'ops-row');
    titleHead.style.justifyContent = 'space-between';
    titleHead.appendChild(el('span', null, '标题'));
    var optTitleBtn = el('button', 'btn', '✨ 优化');
    optTitleBtn.type = 'button';
    optTitleBtn.title = '让 LLM 给几条改进版标题,采纳后替换';
    optTitleBtn.addEventListener('click', function () {
      opsOptimize(optTitleBtn, 'title', titleIn.value, function (revised) {
        titleIn.value = revised;
        bindChosen();
        CURPOST.chosen.title = revised;
        recount();
        scheduleSave();
      }, { topic: p.topic, platform: CURPOST.platforms[0] });
    });
    titleHead.appendChild(optTitleBtn);
    titleLb.appendChild(titleHead);
    titleLb.appendChild(titleIn);
    copy.appendChild(titleLb);
    var bodyLb = el('label', 'f-label grow');
    var bodyHead = el('div', 'ops-row');
    bodyHead.style.justifyContent = 'space-between';
    bodyHead.appendChild(el('span', null, '正文(标签不写进正文,复制/打包时自动拼在尾部)'));
    var optBodyBtn = el('button', 'btn', '✨ 优化');
    optBodyBtn.type = 'button';
    optBodyBtn.title = '让 LLM 给几版改进正文,采纳后替换';
    optBodyBtn.addEventListener('click', function () {
      opsOptimize(optBodyBtn, 'body', bodyTa.value, function (revised) {
        bodyTa.value = revised;
        bindChosen();
        CURPOST.chosen.body = revised;
        recount();
        scheduleSave();
      }, { topic: p.topic, platform: CURPOST.platforms[0] });
    });
    bodyHead.appendChild(optBodyBtn);
    bodyLb.appendChild(bodyHead);
    var bodyTa = el('textarea');
    bodyTa.rows = 7;
    bodyTa.value = c.body || '';
    bodyLb.appendChild(bodyTa);
    copy.appendChild(bodyLb);
    var counts = el('div', 'count-line');
    copy.appendChild(counts);
    function recount() {
      counts.innerHTML = '';
      CURPOST.platforms.forEach(function (k) {
        var m = META.platforms[k];
        var tOver = k === 'xhs' && titleIn.value.length > m.titleMax;
        var bOver = bodyTa.value.length > m.bodyMax;
        var seg = el('span', 'count-badge' + (tOver || bOver ? ' over' : ''),
                     m.label + ' 标题 ' + titleIn.value.length + '/' + m.titleMax +
                     ' · 正文 ' + bodyTa.value.length + '/' + m.bodyMax);
        counts.appendChild(seg);
      });
    }
    recount();
    function bindChosen() {
      if (!CURPOST.chosen) CURPOST.chosen = { title: '', body: '', tags: [] };
    }
    titleIn.addEventListener('input', function () {
      bindChosen();
      CURPOST.chosen.title = this.value;
      recount();
      scheduleSave();
    });
    bodyTa.addEventListener('input', function () {
      bindChosen();
      CURPOST.chosen.body = this.value;
      recount();
      scheduleSave();
    });
    leftCol.appendChild(copy);

    // ---- 右列:标签 + 排期与数据 ----
    var rightCol = el('div', 'ops-col');

    var tagCard = el('div', 'ops-subcard');
    var tagHead = el('div', 'sc-head');
    tagHead.appendChild(el('span', null, '🏷 话题标签'));
    var optTagsBtn = el('button', 'btn', '✨ 优化');
    optTagsBtn.type = 'button';
    optTagsBtn.style.marginLeft = 'auto';
    optTagsBtn.title = '让 LLM 给一套标签,采纳后并入当前标签';
    optTagsBtn.addEventListener('click', function () {
      bindChosen();
      opsOptimize(optTagsBtn, 'tags', tagLine(CURPOST.chosen.tags), function (revised) {
        var add = [];
        revised.split(/[\s,，#]+/).forEach(function (t) {
          t = t.trim();
          if (t && CURPOST.chosen.tags.indexOf(t) < 0 && add.indexOf(t) < 0) add.push(t);
        });
        if (!add.length) { status('建议里的标签都已在列表中'); return false; }
        CURPOST.chosen.tags = CURPOST.chosen.tags.concat(add);
        renderPostTags();
        scheduleSave();
        status('已并入 ' + add.length + ' 个新标签');
      }, { topic: p.topic, platform: CURPOST.platforms[0] });
    });
    tagHead.appendChild(optTagsBtn);
    tagCard.appendChild(tagHead);
    var chips = el('div', 'ops-tags');
    function renderPostTags() {
      chips.innerHTML = '';
      bindChosen();
      (CURPOST.chosen.tags || []).forEach(function (t) {
        var chip = el('span', 'ops-tag clickable on', '#' + t);
        chip.title = '点一下移除';
        chip.addEventListener('click', function () {
          var idx = CURPOST.chosen.tags.indexOf(t);
          CURPOST.chosen.tags.splice(idx, 1);
          renderPostTags();
          scheduleSave();
        });
        chips.appendChild(chip);
      });
    }
    renderPostTags();
    tagCard.appendChild(chips);
    var tagOps = el('div', 'ops-row');
    tagOps.style.marginTop = '8px';
    var tagInput = el('input', 'txt');
    tagInput.placeholder = '自定义标签(回车添加)';
    tagInput.style.cssText = 'flex:1;min-width:0';
    tagInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var name = this.value.trim().replace(/^#/, '');
      if (!name) return;
      bindChosen();
      if (CURPOST.chosen.tags.indexOf(name) < 0) CURPOST.chosen.tags.push(name);
      this.value = '';
      renderPostTags();
      scheduleSave();
    });
    tagOps.appendChild(tagInput);
    var saveLib = el('button', 'btn', '存进标签库');
    saveLib.type = 'button';
    saveLib.title = '把所选标签收进该账号标签库';
    saveLib.addEventListener('click', function () {
      var p2 = currentPersona();
      if (!p2 || !CURPOST.chosen) return;
      var plat = p2.platforms[0] || 'xhs';
      var lib = tagsInLibrary(plat);
      var tags = JSON.parse(JSON.stringify(p2.tags));
      var added = 0;
      (CURPOST.chosen.tags || []).forEach(function (t) {
        if (!lib[t]) { tags[plat].push({ name: t, group: '自定义' }); added++; }
      });
      if (!added) { status('所选标签都已在标签库'); return; }
      patchPersonaTags(tags).then(function (r) {
        if (r.ok) { renderTags(); status('已存 ' + added + ' 个标签进标签库'); }
        else status(errMsg(r.p), true);
      });
    });
    tagOps.appendChild(saveLib);
    tagCard.appendChild(tagOps);
    rightCol.appendChild(tagCard);

    // 排期与数据卡
    var schedCard = el('div', 'ops-subcard fill');
    schedCard.appendChild(el('div', 'sc-head', '🗓 排期与数据'));
    var dateLb = el('label', 'f-label', '计划发布日(到点用平台定时发)');
    var dateIn = el('input', 'txt');
    dateIn.type = 'date';
    dateIn.value = p.scheduleAt || '';
    dateIn.addEventListener('change', function () {
      patchPost({ scheduleAt: this.value || '' }).then(function () { renderDueBanner(); });
    });
    dateLb.appendChild(dateIn);
    schedCard.appendChild(dateLb);
    var statsRow = el('div', 'ops-grid3');
    statsRow.style.marginTop = '8px';
    [['views', '曝光'], ['likes', '赞'], ['saves', '藏'],
     ['comments', '评'], ['follows', '涨粉']].forEach(function (kv) {
      var lb = el('label', 'f-label');
      lb.style.marginTop = '0';
      lb.appendChild(el('span', null, kv[1]));
      var num = el('input', 'txt');
      num.type = 'number';
      num.min = '0';
      num.value = (p.stats && p.stats[kv[0]] !== undefined && p.stats[kv[0]] !== null) ? p.stats[kv[0]] : '';
      num.addEventListener('input', function () {
        bindStats();
        var v = parseInt(this.value, 10);
        CURPOST.stats[kv[0]] = isNaN(v) ? 0 : Math.max(0, v);
        scheduleStatsSave();
      });
      lb.appendChild(num);
      statsRow.appendChild(lb);
    });
    function bindStats() {
      if (!CURPOST.stats) CURPOST.stats = {};
    }
    schedCard.appendChild(statsRow);
    var notesLb = el('label', 'f-label grow', '备注(发布链接/复盘想法)');
    var notes = el('textarea');
    notes.rows = 2;
    notes.value = p.notes || '';
    notes.addEventListener('input', function () {
      CURPOST.notes = this.value;
      scheduleSave();
    });
    notesLb.appendChild(notes);
    schedCard.appendChild(notesLb);
    rightCol.appendChild(schedCard);

    mid.appendChild(leftCol);
    mid.appendChild(rightCol);
    d.appendChild(mid);

    // ---- 素材卡 ----
    var assetCard = el('div', 'ops-subcard');
    var assetHead = el('div', 'sc-head');
    assetHead.appendChild(el('span', null, '🖼 素材'));
    assetHead.appendChild(el('span', 'sc-note', '第一张即封面;视频直接挂 mp4'));
    assetCard.appendChild(assetHead);
    var strip = el('div', 'ops-assets');
    (p.assets || []).forEach(function (a, i) {
      var item = el('div', 'ops-asset');
      var isVideo = a.mime === 'video/mp4';
      var url = '/api/ops/posts/' + p.id + '/asset/' + a.file;
      if (isVideo) {
        var v = document.createElement('video');
        v.src = url;
        v.muted = true;
        v.preload = 'metadata';
        v.addEventListener('click', function () { openLightbox(url, true); });
        item.appendChild(v);
        item.appendChild(el('span', 'vmark', '▶ 视频'));
      } else {
        var img = document.createElement('img');
        img.src = url;
        img.alt = a.file;
        img.addEventListener('click', function () { openLightbox(url, false); });
        item.appendChild(img);
      }
      if (i === 0) item.appendChild(el('span', 'cover-mark', '封面'));
      var x = el('span', 'x', '×');
      x.title = '删除素材';
      x.addEventListener('click', function () {
        oPOST('/posts/' + p.id + '/assets/delete', { index: i + 1 }).then(function (r) {
          if (!r.ok) { status(errMsg(r.p), true); return; }
          CURPOST = r.p.post;
          renderPostDetail();
          refreshPostRow();
        });
      });
      item.appendChild(x);
      strip.appendChild(item);
    });
    var addUp = el('div', 'ops-asset add', '本地上传');
    addUp.addEventListener('click', pickLocalFile);
    strip.appendChild(addUp);
    var addLib = el('div', 'ops-asset add', '素材库');
    addLib.addEventListener('click', function () { openLibrary('asset'); });
    strip.appendChild(addLib);
    assetCard.appendChild(strip);
    d.appendChild(assetCard);

    // ---- AI 生图卡 ----
    var genCard = el('div', 'ops-subcard');
    genCard.appendChild(el('div', 'sc-head', '🎨 AI 生成配图'));
    genCard.appendChild(buildGenBox());
    d.appendChild(genCard);

    box.appendChild(d);
  }
  function pickLocalFile() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/jpeg,image/png,image/webp,image/gif,video/mp4';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var isVideo = f.type === 'video/mp4';
      var cap = isVideo ? 80 * 1024 * 1024 : 10 * 1024 * 1024;
      if (f.size > cap) { status((isVideo ? '视频' : '图片') + '超过 ' + (cap / 1024 / 1024) + 'MB 上限', true); return; }
      status('正在上传…');
      blobToDataURL(f).then(function (dataUrl) {
        return oPOST('/posts/' + CURPOST.id + '/assets', { dataUrl: dataUrl });
      }).then(function (r) {
        if (!r.ok) { status(errMsg(r.p), true); return; }
        CURPOST = r.p.post;
        renderPostDetail();
        refreshPostRow();
        status('素材已入库');
      });
    });
    inp.click();
  }
  function downloadPackage() {
    if (!CURPOST) return;
    status('正在打包…');
    fetch('/api/ops/posts/' + CURPOST.id + '/package', { headers: AUTH() }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (p) { status(errMsg(p), true); });
      }
      return r.blob().then(function (b) {
        var url = URL.createObjectURL(b);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ops-post-' + CURPOST.id + '.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        status('发布包已下载:文案.txt + tags.txt + 素材,去平台人工发布');
      });
    });
  }

  // ---------- AI 生成配图(复用 /api/studio/tasks) ----------
  function buildGenBox() {
    var p = CURPOST;
    var box = el('div', 'genbox');
    var opts = el('div', 'ops-row');
    opts.style.gap = '8px';
    var modelSel = el('select');
    modelSel.style.width = 'auto';
    MODELS.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      if (m.id === 'openai/gpt-5.4-image-2') o.selected = true;
      modelSel.appendChild(o);
    });
    opts.appendChild(modelSel);
    var ratioSel = el('select');
    ratioSel.style.width = 'auto';
    [['3:4', '3:4 小红书封面'], ['9:16', '9:16 抖音竖版'], ['4:5', '4:5 小红书内页'],
     ['1:1', '1:1 方图'], ['16:9', '16:9 横版']].forEach(function (r) {
      var o = document.createElement('option');
      o.value = r[0]; o.textContent = r[1];
      ratioSel.appendChild(o);
    });
    ratioSel.value = p.kind === 'video' ? '9:16' : '3:4';
    opts.appendChild(ratioSel);
    box.appendChild(opts);

    var persona = currentPersona();
    var visual = persona ? persona.persona.visual : '';
    var promptTa = el('textarea');
    promptTa.rows = 3;
    promptTa.value = (p.topic || '') + '。' + visual + '。' +
      '画面干净治愈,构图留出上方标题空间,不要出现文字。';
    var promptLb = el('label', 'f-label');
    var promptHead = el('div', 'ops-row');
    promptHead.style.justifyContent = 'space-between';
    promptHead.appendChild(el('span', null, '配图提示词(可改)'));
    var optPromptBtn = el('button', 'btn', '✨ 优化');
    optPromptBtn.type = 'button';
    optPromptBtn.title = '让 LLM 给几版更稳的生图提示词,采纳后替换';
    optPromptBtn.addEventListener('click', function () {
      opsOptimize(optPromptBtn, 'prompt', promptTa.value, function (revised) {
        promptTa.value = revised;
      }, { topic: p.topic, platform: CURPOST.platforms[0] });
    });
    promptHead.appendChild(optPromptBtn);
    promptLb.appendChild(promptHead);
    promptLb.appendChild(promptTa);
    box.appendChild(promptLb);

    var refRow = el('div', 'ref-chips');
    function renderRefs() {
      refRow.innerHTML = '';
      refRow.appendChild(el('span', 'c-head', '参考图(保形象一致,≤5张):'));
      GENREFS.forEach(function (name, i) {
        var chip = el('span', 'ops-tag on clickable',
          name.length > 18 ? name.slice(0, 16) + '…' : name);
        chip.title = name + '(点一下移除)';
        chip.addEventListener('click', function () { GENREFS.splice(i, 1); renderRefs(); });
        refRow.appendChild(chip);
      });
      var add = el('span', 'ops-tag clickable', '＋ 加参考图');
      add.addEventListener('click', function () { openLibrary('ref'); });
      refRow.appendChild(add);
    }
    renderRefs();
    box.appendChild(refRow);

    var genBtn = el('button', 'btn', '🎨 生成 1 张');
    genBtn.type = 'button';
    genBtn.addEventListener('click', function () {
      if (GENREFS.length > 5) { status('参考图最多 5 张', true); return; }
      genBtn.disabled = true;
      status('正在提交生图任务…');
      Promise.all(GENREFS.map(libraryDataURL)).then(function (refs) {
        return studioSubmit({
          prompt: promptTa.value.slice(0, 4000),
          model: modelSel.value,
          count: 1,
          aspectRatio: ratioSel.value,
          imageSize: '2K',
          referenceImages: refs,
        });
      }).then(function (r) {
        genBtn.disabled = false;
        if (!r.ok) { status(errMsg(r.p), true); return; }
        var tid = r.p.id;
        GENOWNER[tid] = p.id;
        GENRESULTS[tid] = r.p;
        POLL[tid] = true;
        renderPostDetail();
        status('生图任务已提交(' + tid.slice(0, 8) + '),每 3 秒自动查进度');
      }).catch(function (e) {
        genBtn.disabled = false;
        status('生图提交失败:' + (e && e.message || e), true);
      });
    });
    box.appendChild(genBtn);

    var res = el('div', 'gen-res');
    Object.keys(GENRESULTS).forEach(function (tid) {
      if (GENOWNER[tid] !== p.id) return;
      var snap = GENRESULTS[tid];
      var item = el('div', 'gitem');
      if (snap.status === 'running') {
        item.appendChild(el('div', 'gstat', '生成中…' + (snap.produced ? '(' + snap.produced + ')' : '')));
      } else if (snap.status === 'failed' || snap.status === 'cancelled') {
        item.appendChild(el('div', 'gstat', snap.status === 'failed' ? '失败' : '已取消'));
      } else if (snap.data && snap.data.length) {
        snap.data.forEach(function (it, idx) {
          var img = document.createElement('img');
          img.src = '/api/studio/file/' + snap.id + '/' + (idx + 1);
          img.addEventListener('click', function () { openLightbox(img.src, false); });
          item.appendChild(img);
          var pick = el('div', 'pick', '选入帖子');
          pick.addEventListener('click', function () {
            oPOST('/posts/' + p.id + '/assets', { file: { taskId: snap.id, index: idx + 1 } })
              .then(function (r) {
                if (!r.ok) { status(errMsg(r.p), true); return; }
                CURPOST = r.p.post;
                renderPostDetail();
                refreshPostRow();
                status('已选入帖子素材');
              });
          });
          item.appendChild(pick);
        });
      }
      res.appendChild(item);
    });
    if (res.children.length) {
      box.appendChild(el('div', 'c-head', '生图结果(点「选入帖子」进素材)'));
      box.appendChild(res);
    }
    return box;
  }

  function pollLoop() {
    var ids = Object.keys(POLL);
    if (!ids.length) return;
    ids.forEach(function (tid) {
      studioGet(tid).then(function (r) {
        if (!r.ok && r.p && r.p.error === 'task_not_found') {
          delete POLL[tid];
          return;
        }
        var snap = r.p;
        if (!snap || !snap.status) return;
        GENRESULTS[tid] = snap;
        if (snap.status !== 'running') {
          delete POLL[tid];
          if (snap.status === 'failed') status('一个生图任务失败了', true);
          else if (snap.status === 'succeeded') status('生图完成,点「选入帖子」加进素材');
          if (CURPOST) renderPostDetail();
        }
      });
    });
  }

  // ---------- 素材库弹窗 ----------
  function openLibrary(mode) {
    libMode = mode;
    libPicked = {};
    var box = $('#libBox');
    box.innerHTML = '';
    var head = el('div', 'lib-head');
    head.appendChild(el('strong', null,
      mode === 'asset' ? '素材库 · 点图选入帖子(图/视频)' : '素材库 · 勾选参考图(≤5,仅图片)'));
    head.appendChild(el('span', 'spacer'));
    if (mode === 'ref') {
      var ok = el('button', 'btn primary', '确定');
      ok.type = 'button';
      ok.addEventListener('click', function () {
        var names = Object.keys(libPicked);
        if (!names.length) { $('#libModal').style.display = 'none'; return; }
        GENREFS = names.slice(0, 5);
        $('#libModal').style.display = 'none';
        renderPostDetail();
      });
      head.appendChild(ok);
    }
    var close = el('button', 'btn', '关闭');
    close.type = 'button';
    close.addEventListener('click', function () { $('#libModal').style.display = 'none'; });
    head.appendChild(close);
    box.appendChild(head);
    var grid = el('div', 'ops-libgrid');
    LIB.forEach(function (item) {
      var isVideo = item.mime === 'video/mp4';
      var it = el('div', 'ops-libitem');
      if (isVideo) {
        var v = document.createElement('video');
        v.src = '/api/ops/library/file/' + encodeURIComponent(item.name);
        v.muted = true;
        v.preload = 'metadata';
        it.appendChild(v);
      } else {
        var img = document.createElement('img');
        img.src = '/api/ops/library/file/' + encodeURIComponent(item.name);
        img.loading = 'lazy';
        it.appendChild(img);
      }
      it.appendChild(el('div', 'l-name', item.name));
      it.appendChild(el('div', 'l-meta', item.group + ' · ' + Math.round(item.bytes / 1024) + 'KB' +
        (isVideo ? ' · ▶' : '')));
      it.addEventListener('click', function () {
        if (libMode === 'ref') {
          if (isVideo) { status('参考图只能选图片', true); return; }
          if (libPicked[item.name]) { delete libPicked[item.name]; it.classList.remove('sel'); }
          else {
            if (Object.keys(libPicked).length >= 5) { status('参考图最多 5 张', true); return; }
            if (item.bytes > 2 * 1024 * 1024) { status('这张超过 2MB,生图参考图上限', true); return; }
            libPicked[item.name] = true;
            it.classList.add('sel');
          }
          return;
        }
        status('正在把「' + item.name + '」加入素材…');
        libraryDataURL(item.name).then(function (dataUrl) {
          return oPOST('/posts/' + CURPOST.id + '/assets', { dataUrl: dataUrl });
        }).then(function (r) {
          if (!r.ok) { status(errMsg(r.p), true); return; }
          CURPOST = r.p.post;
          $('#libModal').style.display = 'none';
          renderPostDetail();
          refreshPostRow();
          status('素材已入库');
        });
      });
      grid.appendChild(it);
    });
    box.appendChild(grid);
    $('#libModal').style.display = 'flex';
  }

  // ---------- 排期 tab ----------
  function renderSched() {
    var start = mondayOf(new Date());
    start.setDate(start.getDate() + WEEK_OFFSET * 7);
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      days.push(d);
    }
    $('#wkLabel').textContent = dayISO(days[0]).slice(5) + ' ~ ' + dayISO(days[6]).slice(5) +
      (WEEK_OFFSET === 0 ? '(本周)' : '');
    var today = dayISO(new Date());
    var DOWS = ['一', '二', '三', '四', '五', '六', '日'];
    var grid = $('#weekGrid');
    grid.innerHTML = '';
    days.forEach(function (d, i) {
      var iso = dayISO(d);
      var cell = el('div', 'wk-cell' + (iso === today ? ' wk-today' : '') +
                    (i >= 5 ? ' wk-off' : ''));
      var dh = el('div', 'wk-date');
      dh.appendChild(el('span', 'wk-dow', '周' + DOWS[i]));
      dh.appendChild(el('span', null, iso.slice(5)));
      cell.appendChild(dh);
      POSTS.forEach(function (p) {
        if (p.scheduleAt !== iso) return;
        var chip = el('div', 'wk-chip s-' + p.status,
          (p.kind === 'video' ? '🎬 ' : '') + ((p.chosen && p.chosen.title) || p.topic));
        chip.title = statusLabel(p.status) + ' · ' + p.platforms.map(platformLabel).join('/') +
          '(点开帖子)';
        chip.addEventListener('click', function () {
          switchTab('create');
          openPost(p.id);
        });
        cell.appendChild(chip);
      });
      grid.appendChild(cell);
    });

    // 未排期 backlog
    var backlog = $('#backlogList');
    backlog.innerHTML = '';
    var pending = POSTS.filter(function (p) {
      return !p.scheduleAt && (p.status === 'draft' || p.status === 'ready');
    }).sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
    pending.forEach(function (p) {
      var row = el('div', 'backlog-row');
      row.appendChild(el('span', 'post-dot ' + p.status));
      row.appendChild(el('span', 'b-title', (p.kind === 'video' ? '🎬 ' : '') +
        ((p.chosen && p.chosen.title) || p.topic)));
      row.appendChild(el('span', 'p-meta', statusLabel(p.status)));
      var t1 = el('button', 'btn', '排今天');
      t1.type = 'button';
      t1.addEventListener('click', function () { schedQuick(p.id, today); });
      row.appendChild(t1);
      var t2 = el('button', 'btn', '排明天');
      t2.type = 'button';
      var tm = new Date();
      tm.setDate(tm.getDate() + 1);
      t2.addEventListener('click', function () { schedQuick(p.id, dayISO(tm)); });
      row.appendChild(t2);
      var open = el('button', 'btn', '详情');
      open.type = 'button';
      open.addEventListener('click', function () {
        switchTab('create');
        openPost(p.id);
      });
      row.appendChild(open);
      backlog.appendChild(row);
    });
    if (!pending.length) backlog.appendChild(el('div', 'gen-empty', '没有待排期的帖子:草稿/待发都会出现在这里。'));

    renderReview();
    renderDueBanner();
  }
  function schedQuick(pid, day) {
    oPOST('/posts/' + pid + '/update', { scheduleAt: day }).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return; }
      for (var i = 0; i < POSTS.length; i++) {
        if (POSTS[i].id === pid) POSTS[i] = r.p.post;
      }
      if (CURPOST && CURPOST.id === pid) CURPOST = r.p.post;
      renderSched();
      status('已排到 ' + day);
    });
  }

  // 复盘:按支柱聚合已发帖子的手动数据
  function renderReview() {
    var box = $('#reviewBox');
    box.innerHTML = '';
    var published = POSTS.filter(function (p) { return p.status === 'published'; });
    if (!published.length) {
      box.appendChild(el('div', 'gen-empty', '还没有已发帖子;发布后在帖子详情里填数据,这里自动聚合。'));
      return;
    }
    var byPillar = {};
    META.pillars.forEach(function (pl) { byPillar[pl] = { n: 0, views: 0, likes: 0, saves: 0, comments: 0, follows: 0 }; });
    published.forEach(function (p) {
      var b = byPillar[p.pillar] || byPillar[META.pillars[0]];
      b.n += 1;
      var s = p.stats || {};
      b.views += s.views || 0;
      b.likes += s.likes || 0;
      b.saves += s.saves || 0;
      b.comments += s.comments || 0;
      b.follows += s.follows || 0;
    });
    var grid = el('div', 'ops-review');
    var head = el('div', 'review-row head');
    ['支柱', '发帖', '曝光', '赞', '藏', '评', '涨粉'].forEach(function (h) {
      var s = el('span', null, h);
      if (h !== '支柱') s.className = 'num';
      head.appendChild(s);
    });
    grid.appendChild(head);
    var total = { n: 0, views: 0, likes: 0, saves: 0, comments: 0, follows: 0 };
    META.pillars.forEach(function (pl) {
      var b = byPillar[pl];
      if (!b.n) return;
      ['n', 'views', 'likes', 'saves', 'comments', 'follows'].forEach(function (k) { total[k] += b[k]; });
      var row = el('div', 'review-row');
      row.appendChild(el('span', null, pl));
      ['n', 'views', 'likes', 'saves', 'comments', 'follows'].forEach(function (k) {
        var s = el('span', 'num', b[k]);
        row.appendChild(s);
      });
      grid.appendChild(row);
    });
    var trow = el('div', 'review-row total');
    trow.appendChild(el('span', null, '合计'));
    ['n', 'views', 'likes', 'saves', 'comments', 'follows'].forEach(function (k) {
      trow.appendChild(el('span', 'num', total[k]));
    });
    grid.appendChild(trow);
    box.appendChild(grid);
  }

  function renderDueBanner() {
    var today = dayISO(new Date());
    var due = POSTS.filter(function (p) { return p.scheduleAt === today && p.status !== 'published'; });
    var b = $('#dueBanner');
    if (!due.length) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = '📌 今天待发 ' + due.length + ' 条:' +
      due.slice(0, 2).map(function (p) { return (p.chosen && p.chosen.title) || p.topic; }).join('、') +
      (due.length > 2 ? ' 等' : '');
  }

  // ---------- 调研:对标库 ----------
  function addResearch() {
    var url = ($('#rfUrl').value || '').trim();
    if (!url) { status('先贴对标链接', true); return; }
    oPOST('/research', {
      platform: $('#rfPlatform').value,
      group: $('#rfGroup').value,
      url: url,
      title: ($('#rfTitle').value || '').trim(),
      note: ($('#rfNote').value || '').trim(),
      accountId: $('#rfAccount').value || '',
      stats: { likes: $('#rfLikes').value, saves: $('#rfSaves').value, comments: $('#rfComments').value },
    }).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return; }
      $('#rfUrl').value = ''; $('#rfTitle').value = ''; $('#rfNote').value = '';
      $('#rfLikes').value = ''; $('#rfSaves').value = ''; $('#rfComments').value = '';
      loadResearch().then(renderResearch);
      status('已收藏到对标库');
    });
  }
  function renderResearch() {
    var box = $('#researchList');
    box.innerHTML = '';
    var list = RESEARCH.filter(function (it) {
      return !RF_FILTER || it.accountId === RF_FILTER;
    });
    list.forEach(function (it) {
      var card = el('div', 'research-card');
      var head = el('div', 'r-head');
      head.appendChild(el('span', 'r-plat p-' + it.platform, platformLabel(it.platform)));
      head.appendChild(el('span', 'r-plat', it.group));
      if (it.accountId) head.appendChild(el('span', 'r-plat', personaName(it.accountId)));
      var sp = el('span', 'spacer');
      head.appendChild(sp);
      var del = el('span', 'ops-tag clickable', '删');
      del.addEventListener('click', function () {
        oPOST('/research/' + it.id + '/delete').then(function () { loadResearch().then(renderResearch); });
      });
      head.appendChild(del);
      card.appendChild(head);
      var a = document.createElement('a');
      a.className = 'r-title';
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = it.title;
      a.title = '点开对标原文';
      card.appendChild(a);
      if (it.note) card.appendChild(el('div', 'r-note', it.note));
      card.appendChild(el('div', 'r-stats',
        '赞 ' + it.stats.likes + ' · 藏 ' + it.stats.saves + ' · 评 ' + it.stats.comments));
      box.appendChild(card);
    });
    $('#researchEmpty').hidden = list.length > 0;
  }

  // ---------- 调研:LLM 拆解 ----------
  function analyze() {
    var text = ($('#anText').value || '').trim();
    if (text.length < 20) { status('粘贴的内容太短(至少 20 字)', true); return; }
    var btn = $('#btnAnalyze');
    btn.disabled = true;
    status('正在拆解…(10~30 秒)');
    oPOST('/analyze', { platform: $('#rfPlatform').value, text: text }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { status(errMsg(r.p), true); return; }
      renderAnalyze(r.p);
      status('拆解完成:点选题旁的「存」收进选题库');
    });
  }
  function renderAnalyze(data) {
    var box = $('#analyzeResult');
    box.innerHTML = '';
    var d = el('div', 'analyze-box');
    d.appendChild(el('h4', null, '拆解:' + (data.summary || '(无摘要)')));
    [['开头钩子', data.hooks], ['结构节奏', data.structure]].forEach(function (pair) {
      if (!pair[1] || !pair[1].length) return;
      d.appendChild(el('h4', null, pair[0]));
      var ul = el('ul');
      pair[1].forEach(function (s) { ul.appendChild(el('li', null, s)); });
      d.appendChild(ul);
    });
    if (data.topicIdeas && data.topicIdeas.length) {
      d.appendChild(el('h4', null, '可复用选题'));
      var ul = el('ul');
      data.topicIdeas.forEach(function (s) {
        var li = el('li');
        li.appendChild(el('span', null, s));
        var save = el('span', 'save', '[存入选题库]');
        save.addEventListener('click', function () {
          saveTopicsFromList([s]).then(function () { save.textContent = '✓ 已存'; });
        });
        li.appendChild(save);
        ul.appendChild(li);
      });
      d.appendChild(ul);
      var all = el('button', 'btn wide', '全部存入选题库(' + data.topicIdeas.length + ' 条)');
      all.type = 'button';
      all.addEventListener('click', function () {
        saveTopicsFromList(data.topicIdeas).then(function () {
          status('已全部存入选题库');
          all.disabled = true;
        });
      });
      d.appendChild(all);
    }
    box.appendChild(d);
  }

  // ---------- 通用「✨优化」:LLM 建议弹窗 + 采纳(采纳制,绝不直接改内容) ----------
  var OPT_TARGET_LABEL = {
    persona: '人设卡优化建议', title: '标题优化建议', body: '正文优化建议',
    tags: '话题标签优化建议', prompt: '配图提示词优化建议',
  };
  var PERSONA_FIELD_MAP = [
    ['目标人群', 'pfAudience'], ['人群', 'pfAudience'], ['定位', 'pfPositioning'],
    ['语气', 'pfTone'], ['口吻', 'pfTone'], ['口头禅', 'pfCatchphrase'],
    ['视觉风格', 'pfVisual'], ['视觉', 'pfVisual'], ['禁忌', 'pfTaboos'],
  ];

  function personaText() {
    return ['定位:' + $('#pfPositioning').value, '目标人群:' + $('#pfAudience').value,
            '语气:' + $('#pfTone').value, '口头禅:' + $('#pfCatchphrase').value,
            '视觉风格:' + $('#pfVisual').value, '禁忌:' + $('#pfTaboos').value].join('\n');
  }

  function adoptPersona(revised) {
    var hit = 0;
    revised.split(/\n+/).forEach(function (line) {
      var t = line.replace(/\*\*/g, '').trim();
      if (!t) return;
      // 容忍:【字段】内容 / 字段:内容 / 1. 字段:内容 / - 字段:内容
      var m = t.match(/^(?:\d{1,2}\s*[.、)．]\s*)?(?:[-•]\s*)?(?:【\s*([^:：】]{1,8})\s*】|([^:：【】]{1,8})\s*[:：])\s*(.*)$/);
      if (!m) return;
      var label = ((m[1] || m[2]) || '').trim(), val = (m[3] || '').trim();
      if (!val) return;
      for (var i = 0; i < PERSONA_FIELD_MAP.length; i++) {
        if (label.indexOf(PERSONA_FIELD_MAP[i][0]) >= 0) {
          var input = document.getElementById(PERSONA_FIELD_MAP[i][1]);
          if (input) { input.value = val; hit++; }
          break;
        }
      }
    });
    if (!hit) { status('未能识别字段行,请手动对照弹窗文本填入', true); return false; }
    status('已填入 ' + hit + ' 个字段,记得点「保存人设」落盘');
    return true;
  }

  function opsOptimize(btn, target, text, apply, opts) {
    opts = opts || {};
    if (!CUR) { status('还没有账号人设', true); return; }
    if (!text || !text.trim()) { status('这一栏还是空的,先填点内容', true); return; }
    var payload = { target: target, text: text, personaId: CUR };
    if (opts.topic) payload.topic = opts.topic;
    if (opts.platform) payload.platform = opts.platform;
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '✨ 优化中…';
    oPOST('/optimize', payload).then(function (r) {
      btn.disabled = false;
      btn.textContent = old;
      if (!r.ok) { status(errMsg(r.p), true); return; }
      var items = (r.p && r.p.items) || [];
      if (!items.length) { status('没有给出可用建议,稍后再试', true); return; }
      showOptModal(OPT_TARGET_LABEL[target] || '优化建议', items, apply);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = old;
      status('优化请求失败:' + (e && e.message || e), true);
    });
  }

  function showOptModal(title, items, apply) {
    var box = $('#optBox');
    box.innerHTML = '';
    var head = el('div', 'lib-head');
    head.appendChild(el('strong', null, '✨ ' + title + '(点「采纳」替换当前内容;原文仍在编辑框里,可手动撤销)'));
    head.appendChild(el('span', 'spacer'));
    var close = el('button', 'btn', '关闭');
    close.type = 'button';
    close.addEventListener('click', function () { $('#optModal').style.display = 'none'; });
    head.appendChild(close);
    box.appendChild(head);
    items.forEach(function (it) {
      var card = el('div', 'ops-optitem');
      card.appendChild(el('div', 'o-problem', it.problem));
      if (it.suggestion) card.appendChild(el('div', 'o-suggest', it.suggestion));
      card.appendChild(el('div', 'o-revised', it.revised));
      var ops = el('div', 'o-ops');
      var use = el('button', 'btn primary', '采纳(替换当前内容)');
      use.type = 'button';
      use.addEventListener('click', function () {
        if (apply(it.revised) === false) return;  // 采纳失败则留在弹窗
        $('#optModal').style.display = 'none';
      });
      ops.appendChild(use);
      var cp = el('button', 'btn', '复制文本');
      cp.type = 'button';
      cp.addEventListener('click', function () { copyText(it.revised); });
      ops.appendChild(cp);
      card.appendChild(ops);
      box.appendChild(card);
    });
    $('#optModal').style.display = 'flex';
  }
})();