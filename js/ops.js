// FrameFlow - 内容运营工作台(ops.html)
// 两 tab:创作(人设卡→选题→LLM 文案 3 版→建帖→配图→发布包)/ 调研(平台直达→对标库→LLM 拆解→选题库)。
// 后端 /api/ops/* 与生图工作台同一把邀请码门禁;配图生成复用 /api/studio/tasks(额度零改动)。
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
  var META = null;          // {platforms, pillars, tagGroups, statuses, links}
  var PERSONAS = [];
  var CUR = null;           // 当前人设 id
  var COPIES = [];          // 最近一次生成的文案(可编辑)
  var POSTS = [];
  var CURPOST = null;       // 当前打开帖子的完整 json
  var TOPICS = [];
  var RESEARCH = [];
  var LIB = [];             // 素材库清单
  var MODELS = [];          // 可用生图模型
  var GENREFS = [];         // 生图参考图(素材库文件名,≤5)
  var GENOWNER = {};        // taskId -> postId(归属,结束后保留,结果不丢)
  var GENRESULTS = {};      // taskId -> 快照
  var POLL = {};            // taskId -> true(仍在轮询)
  var tagPlat = 'xhs';
  var libMode = 'asset';    // 素材库弹窗用途:asset=选入素材 ref=参考图
  var libPicked = {};
  var saveTimer = null;

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
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
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
      status('就绪。选题 → 文案 → 配图 → 发布包;发布在平台人工完成。');
    }).catch(function (e) {
      status('初始化失败:' + (e && e.message || e), true);
    });
  }

  function wireStatic() {
    $('#tabCreate').addEventListener('click', function () { switchTab('create'); });
    $('#tabResearch').addEventListener('click', function () { switchTab('research'); });
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
    $('#btnGenCopy').addEventListener('click', genCopy);
    $('#btnNewPost').addEventListener('click', newEmptyPost);
    $('#btnXhsSearch').addEventListener('click', function () { openLink('xhsSearch'); });
    $('#btnDySearch').addEventListener('click', function () { openLink('dySearch'); });
    $('#btnXhsExplore').addEventListener('click', function () { openLink('xhsExplore'); });
    $('#btnDyHot').addEventListener('click', function () { openLink('dyHot'); });
    $('#btnResearchAdd').addEventListener('click', addResearch);
    $('#btnAnalyze').addEventListener('click', analyze);
    $('#btnTopicAdd').addEventListener('click', addTopicManual);
    $('#lightbox').addEventListener('click', function () { this.style.display = 'none'; });
    $('#libModal').addEventListener('click', function (e) {
      if (e.target === this) this.style.display = 'none';
    });
  }

  function switchTab(name) {
    $('#paneCreate').hidden = name !== 'create';
    $('#paneResearch').hidden = name !== 'research';
    $('#tabCreate').classList.toggle('active', name === 'create');
    $('#tabResearch').classList.toggle('active', name === 'research');
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
    renderPostList();
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
    var body = {
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
    };
    oPOST('/personas/' + CUR + '/update', body).then(function (r) {
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
    var btn = $('#btnGenCopy');
    btn.disabled = true;
    status('正在按「' + currentPersona().name + '」人设生成 ' + platformLabel(platform) + ' 文案…(10~30 秒)');
    oPOST('/copy', { personaId: CUR, topic: topic, pillar: $('#pillarSel').value,
                     platform: platform }).then(function (r) {
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
      card.appendChild(el('div', 'c-head', '版本 ' + (i + 1) + ' · ' + platformLabel(plat)));
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
        if (!on) chip.title = '标签库没有,「用这版」后可一键收进标签库';
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
      var regen = el('button', 'btn', '再生成');
      regen.type = 'button';
      regen.addEventListener('click', genCopy);
      ops.appendChild(regen);
      card.appendChild(ops);
      box.appendChild(card);
    });
  }
  function useThisCopy(i) {
    var c = COPIES[i];
    if (!c) return;
    var topic = ($('#topicInput').value || '').trim();
    oPOST('/posts', { accountId: CUR, topic: topic, pillar: $('#pillarSel').value,
                      platforms: selectedPlatforms(), copies: COPIES,
                      chosen: { title: c.title, body: c.body, tags: c.tags.slice() } })
      .then(function (r) {
        if (!r.ok) { status(errMsg(r.p), true); return; }
        loadPosts().then(function () {
          openPost(r.p.post.id);
          status('帖子已建(草稿态),可以配图或继续改文案');
        });
      });
  }

  // ---------- 帖子 ----------
  function summaryOf(full) {
    return { id: full.id, accountId: full.accountId, accountName: full.accountName,
             topic: full.topic, pillar: full.pillar, platforms: full.platforms,
             chosen: full.chosen, status: full.status, createdAt: full.createdAt,
             updatedAt: full.updatedAt };
  }
  function renderPostList() {
    var box = $('#postList');
    box.innerHTML = '';
    var sorted = POSTS.slice().sort(function (a, b) {
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    sorted.forEach(function (p) {
      var card = el('div', 'post-card' + (CURPOST && CURPOST.id === p.id ? ' sel' : ''));
      card.appendChild(el('span', 'post-dot ' + p.status));
      card.appendChild(el('span', 'p-title', (p.chosen && p.chosen.title) || p.topic));
      card.appendChild(el('span', 'p-meta',
        (p.accountName || '?') + ' · ' + p.platforms.map(platformLabel).join('/') +
        ' · ' + statusLabel(p.status) + ' · ' + fmtDate(p.updatedAt)));
      card.addEventListener('click', function () { openPost(p.id); });
      box.appendChild(card);
    });
    $('#postEmpty').hidden = sorted.length > 0;
    $('#postListView').hidden = !!CURPOST;
    $('#postDetail').hidden = !CURPOST;
  }
  function refreshPostRow() {
    if (!CURPOST) return;
    var s = summaryOf(CURPOST);
    for (var i = 0; i < POSTS.length; i++) {
      if (POSTS[i].id === s.id) { POSTS[i] = s; break; }
    }
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

  function newEmptyPost() {
    var topic = ($('#topicInput').value || '').trim();
    if (!topic) topic = window.prompt('这条帖子讲什么(选题)');
    if (!topic) return;
    oPOST('/posts', { accountId: CUR, topic: topic, pillar: $('#pillarSel').value,
                      platforms: selectedPlatforms() }).then(function (r) {
      if (!r.ok) { status(errMsg(r.p), true); return; }
      loadPosts().then(function () {
        openPost(r.p.post.id);
        status('空帖已建(想法态)');
      });
    });
  }

  function renderPostDetail() {
    var p = CURPOST;
    if (!p) return;
    var box = $('#postDetail');
    box.innerHTML = '';
    var d = el('div', 'ops-detail');

    // 头部:状态 + 流转 + 返回/删除
    var head = el('div', 'd-head');
    head.appendChild(el('span', 'post-dot ' + p.status));
    head.appendChild(el('span', 'status-pill', statusLabel(p.status)));
    if (p.status === 'idea') flowBtn(head, '转草稿', 'draft');
    if (p.status === 'draft') flowBtn(head, '标记待发', 'ready');
    if (p.status === 'ready') flowBtn(head, '标记已发', 'published');
    if (p.status === 'published') {
      head.appendChild(el('span', 'p-meta', '发布于 ' + fmtDate(p.publishedAt)));
      flowBtn(head, '退回草稿', 'draft');
    }
    var spacer = el('span', 'spacer');
    head.appendChild(spacer);
    var back = el('button', 'btn', '← 返回列表');
    back.type = 'button';
    back.addEventListener('click', closePost);
    head.appendChild(back);
    var del = el('button', 'btn', '🗑 删除');
    del.type = 'button';
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

    // 选题行
    d.appendChild(el('div', 'label-row', '选题:' + p.topic + '  ·  支柱:' + p.pillar));

    // 平台勾选
    var plats = el('div', 'label-row');
    plats.appendChild(el('span', 'c-head', '发布平台:'));
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
    d.appendChild(plats);

    // 文案
    var c = p.chosen || { title: '', body: '', tags: [] };
    var titleLb = el('label', 'f-label', '标题');
    var titleIn = el('input', 'txt');
    titleIn.value = c.title || '';
    titleLb.appendChild(titleIn);
    d.appendChild(titleLb);
    var bodyLb = el('label', 'f-label', '正文(标签不写进正文,复制/打包时自动拼在尾部)');
    var bodyTa = el('textarea');
    bodyTa.rows = 6;
    bodyTa.value = c.body || '';
    bodyLb.appendChild(bodyTa);
    d.appendChild(bodyLb);
    var counts = el('div', 'count-line');
    d.appendChild(counts);
    function recount() {
      counts.innerHTML = '';
      CURPOST.platforms.forEach(function (k) {
        var m = META.platforms[k];
        var tOver = k === 'xhs' && titleIn.value.length > m.titleMax;
        var bOver = bodyTa.value.length > m.bodyMax;
        var seg = el('span', null, (m.label + ' 标题 ' + titleIn.value.length + '/' + m.titleMax +
                                    ' · 正文 ' + bodyTa.value.length + '/' + m.bodyMax + '   '));
        if (tOver || bOver) seg.className = 'over';
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

    // 标签 chips(点 = 增/删这篇的标签;发布拼接在复制/打包时自动做)
    var tagRow = el('div', null);
    tagRow.appendChild(el('div', 'c-head', '话题标签(点标签增删)'));
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
    tagRow.appendChild(chips);
    var tagOps = el('div', 'label-row');
    tagOps.style.marginTop = '6px';
    var tagInput = el('input', 'txt');
    tagInput.placeholder = '自定义标签(不带#)后回车';
    tagInput.style.cssText = 'width:auto;flex:1;min-width:120px';
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
    var saveLib = el('button', 'btn', '把所选标签存进标签库');
    saveLib.type = 'button';
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
    tagRow.appendChild(tagOps);
    d.appendChild(tagRow);

    // 备注
    var notesLb = el('label', 'f-label', '备注(发布链接/复盘想法)');
    var notes = el('textarea');
    notes.rows = 2;
    notes.value = p.notes || '';
    notes.addEventListener('input', function () {
      CURPOST.notes = this.value;
      scheduleSave();
    });
    notesLb.appendChild(notes);
    d.appendChild(notesLb);

    // 素材条
    d.appendChild(el('div', 'label-row', '素材(第一张即封面)'));
    var strip = el('div', 'ops-assets');
    (p.assets || []).forEach(function (a, i) {
      var item = el('div', 'ops-asset');
      var img = document.createElement('img');
      img.src = '/api/ops/posts/' + p.id + '/asset/' + a.file;
      img.alt = a.file;
      img.addEventListener('click', function () {
        $('#lightboxImg').src = img.src;
        $('#lightbox').style.display = 'flex';
      });
      item.appendChild(img);
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
    d.appendChild(strip);

    // 生成配图
    d.appendChild(buildGenBox());

    // 底部操作
    var foot = el('div', 'c-ops');
    var copyBtn = el('button', 'btn primary', '📋 复制文案');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () { copyText(composedText(CURPOST)); });
    foot.appendChild(copyBtn);
    var zip = el('button', 'btn', '⬇ 下载素材包(zip)');
    zip.type = 'button';
    zip.addEventListener('click', downloadPackage);
    foot.appendChild(zip);
    d.appendChild(foot);

    box.appendChild(d);
  }
  function flowBtn(parent, label, to) {
    var b = el('button', 'btn', label);
    b.type = 'button';
    b.addEventListener('click', function () {
      patchPost({ status: to }).then(function (np) { if (np) renderPostDetail(); });
    });
    parent.appendChild(b);
  }
  function pickLocalFile() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/jpeg,image/png,image/webp,image/gif';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 10 * 1024 * 1024) { status('图片超过 10MB,请先压缩', true); return; }
      blobToDataURL(f).then(function (dataUrl) {
        return oPOST('/posts/' + CURPOST.id + '/assets', { dataUrl: dataUrl, kind: 'image' });
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
    var head = el('div', 'label-row');
    head.appendChild(el('label', null, 'AI 生成配图(走生图工作台额度)'));
    box.appendChild(head);

    var opts = el('div', 'label-row');
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
    opts.appendChild(ratioSel);
    box.appendChild(opts);

    var persona = currentPersona();
    var visual = persona ? persona.persona.visual : '';
    var promptTa = el('textarea');
    promptTa.rows = 3;
    promptTa.value = (p.topic || '') + '。' + visual + '。' +
      '画面干净治愈,构图留出上方标题空间,不要出现文字。';
    var promptLb = el('label', 'f-label', '配图提示词(可改)');
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

    // 本帖的生成结果与进行中状态
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
          img.addEventListener('click', function () {
            $('#lightboxImg').src = img.src;
            $('#lightbox').style.display = 'flex';
          });
          item.appendChild(img);
          var pick = el('div', 'pick', '选入帖子');
          pick.addEventListener('click', function () {
            oPOST('/posts/' + p.id + '/assets', { file: { taskId: snap.id, index: idx + 1 }, kind: 'image' })
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
    head.appendChild(el('strong', null, mode === 'asset' ? '素材库 · 点图选入帖子' : '素材库 · 勾选参考图(≤5)'));
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
      var it = el('div', 'ops-libitem');
      var img = document.createElement('img');
      img.src = '/api/ops/library/file/' + encodeURIComponent(item.name);
      img.loading = 'lazy';
      it.appendChild(img);
      it.appendChild(el('div', 'l-name', item.name));
      it.appendChild(el('div', 'l-meta', item.group + ' · ' + Math.round(item.bytes / 1024) + 'KB'));
      it.addEventListener('click', function () {
        if (libMode === 'ref') {
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
          return oPOST('/posts/' + CURPOST.id + '/assets', { dataUrl: dataUrl, kind: 'image' });
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
    RESEARCH.forEach(function (it) {
      var card = el('div', 'research-card');
      var head = el('div', 'r-head');
      head.appendChild(el('span', 'r-plat p-' + it.platform, platformLabel(it.platform)));
      head.appendChild(el('span', 'r-plat', it.group));
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
    $('#researchEmpty').hidden = RESEARCH.length > 0;
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
})();