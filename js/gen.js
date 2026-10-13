// FrameFlow - 生图/生视频工作台(移植自 Pet10 工作台;同一 ApiRouter 上游)
// 门禁:邀请码只存页面内存,Bearer 携带;错满 3 次/天当天锁定。
// 任务提交后后台并行生成,页面轮询进度;结果由服务端自动落盘(默认保留 7 天),预览/下载走文件直链。
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };

  let INVITE = '';
  let MODELS = [];
  const running = {};   // taskId -> { els, snapshot }
  let refs = [];        // dataURL 列表
  // 入口 kind 参数:首页「生图」「生视频」两张卡各自进入;设置后本页只显示与提交该类型
  const PAGE_KIND = (function () {
    const m = /kind=(video|image)/.exec(location.search);
    return m ? m[1] : null;
  })();

  const ERRORS = {
    invalid_invite_code: '邀请码不正确',
    invite_locked: '邀请码错误次数过多,今日已锁定,请明天再试',
    rate_limit_exceeded: '触发限流,请稍后再试',
    invalid_prompt: '提示词为空或超过 4000 字符',
    invalid_model: '模型未启用',
    invalid_aspect_ratio: '不支持的比例',
    invalid_image_size: '不支持的尺寸(仅 1K / 2K)',
    invalid_count: '出图数量仅支持 1~4',
    invalid_duration: '不支持的视频时长(仅 5/10 秒)',
    invalid_frame_mode: '首尾帧模式需要第 1、2 两张参考图',
    invalid_reference_images: '参考图最多 5 张',
    invalid_reference_image: '参考图格式不支持,只接受 jpg/png/webp',
    invalid_reference_image_size: '参考图超过 2MB',
    invalid_resolution: '不支持的分辨率(仅 720p / 1080p)',
    task_not_found: '任务不存在(可能已超出保留期被清理)',
    task_pool_full: '任务池已满,请等部分任务完成或过期后再试',
    interrupted: '服务重启导致任务中断,可点「重试」按原参数重跑',
    image_generation_unavailable: '上游生成服务暂不可用,请稍后重试',
    upstream_rejected: '上游拒绝了本次生成',
    upstream_unavailable: '上游暂不可用',
    upstream_invalid_response: '上游响应异常',
  };

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function showSubmit(kind, text) {
    const el = $('#submitStatus');
    el.className = 'gen-status ' + kind;
    el.textContent = text;
    el.hidden = false;
  }

  // 局域网 http 是非安全上下文,clipboard API 不可用,退回 execCommand
  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  function copyText(text) {
    if (!text) { showSubmit('error', '这条任务没有提示词'); return; }
    const done = function () { showSubmit('info', '提示词已复制'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  }

  // 快照参数 → 任务卡参数行(便于复现/对比)
  function paramsText(p) {
    if (!p) return '';
    const parts = [];
    if (p.kind === 'image') {
      if (p.count) parts.push(p.count + ' 张');
      if (p.aspectRatio) parts.push(p.aspectRatio);
      if (p.imageSize) parts.push(p.imageSize);
    } else {
      if (p.duration) parts.push(p.duration + ' 秒');
      if (p.resolution) parts.push(p.resolution);
      parts.push(p.frameMode === 'first_last' ? '首尾帧' : (p.refCount ? '首帧图生视频' : '文生视频'));
      parts.push(p.audio ? '带声音' : '无声');
    }
    if (p.refCount) parts.push(p.refCount + ' 张参考图');
    return parts.join(' · ');
  }

  function currentModel() {
    return MODELS.find(function (m) { return m.id === $('#model').value; }) || null;
  }

  // 只有 openai 系生图模型(id 含 image)才吃 image_config 比例/尺寸参数
  function supportsImageParams(model) {
    return Boolean(model && model.kind === 'image' && /^openai\/.+image/.test(model.id));
  }

  function maxRefs() {
    const model = currentModel();
    return model && model.kind === 'video' ? 2 : 5;
  }

  // 时长选项按所选模型的支持集合生成(veo 只吃 4/6/8、海螺 2.3 只吃 6/10 等)
  function renderDurationOptions() {
    const model = currentModel();
    if (!model || model.kind !== 'video') return;
    const durs = (model.durations && model.durations.length) ? model.durations : [5, 10];
    const sel = $('#duration');
    const prev = Number(sel.value) || 0;
    sel.textContent = '';
    durs.forEach(function (d) {
      const option = document.createElement('option');
      option.value = d;
      option.textContent = d + ' 秒';
      sel.appendChild(option);
    });
    if (durs.indexOf(prev) >= 0) sel.value = prev;
    else sel.value = durs.indexOf(5) >= 0 ? 5 : durs[0];
  }

  function renderKindFields() {
    const model = currentModel();
    const isVideo = Boolean(model && model.kind === 'video');
    const supportsParams = supportsImageParams(model);
    $('#imageOptions').hidden = isVideo;
    $('#noParamHint').hidden = isVideo || supportsParams;
    $('#aspect').disabled = !supportsParams;
    $('#imageSize').disabled = !supportsParams;
    $('#videoOptions').hidden = !isVideo;
    if (isVideo) renderDurationOptions();
    // 视频参考图最多 2 张,切到视频时裁掉多余的
    if (isVideo && refs.length > 2) {
      refs = refs.slice(0, 2);
      renderThumbs();
      showSubmit('info', '已切到视频模型:参考图最多 2 张,多余的已移除');
    }
    renderRefLabel();
  }

  function renderRefLabel() {
    const model = currentModel();
    const isVideo = Boolean(model && model.kind === 'video');
    const el = $('#refLabel');
    if (!isVideo) {
      el.textContent = '图片模型最多 5 张;可拖入页面或粘贴截图;单张 ≤ 2MB,jpg/png/webp';
      return;
    }
    const isLast = $('#frameMode').value === 'first_last';
    el.textContent = isLast
      ? '首尾帧模式:需 2 张——第 1 张作首帧(画面从这开始),第 2 张作尾帧(落到这结束)'
      : '首帧模式:1 张作首帧(视频从这个画面开始动);建议 ≥720px,单张 ≤ 2MB';
  }

  function refreshQuota() {
    // 免码模式 INVITE 为空:Bearer 留空,服务端对本机来源照常放行,不能因此跳过
    fetch('/api/studio/quota', { headers: { authorization: 'Bearer ' + INVITE } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (payload) {
          return { ok: r.ok, status: r.status, payload: payload };
        });
      })
      .then(function (result) {
        if (result.status === 403 || result.payload.error === 'invite_locked') {
          $('#quotaLine').textContent = '今日已锁定(邀请码错误次数过多),请明天再试';
          return;
        }
        if (!result.ok) { $('#quotaLine').textContent = '剩余额度:邀请码未生效'; return; }
        let html = '剩余额度:本分钟 <b>' + result.payload.minuteRemaining
          + '/' + result.payload.perMinuteLimit + '</b> 次';
        if (!PAGE_KIND || PAGE_KIND === 'image') {
          html += ' · 图片 <b>' + result.payload.imageRemaining
            + '/' + result.payload.imageDailyLimit + '</b> 张';
        }
        if (!PAGE_KIND || PAGE_KIND === 'video') {
          html += ' · 视频 <b>' + result.payload.videoRemaining
            + '/' + result.payload.videoDailyLimit + '</b> 个';
        }
        $('#quotaLine').innerHTML = html;
      })
      .catch(function () { $('#quotaLine').textContent = '剩余额度:查询失败'; });
  }

  // 模型目录:进工作台后带码拉取(已设邀请码时服务端只对持码者返回清单)
  function loadModels() {
    return fetch('/api/studio/models', { headers: { authorization: 'Bearer ' + INVITE } })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        MODELS = payload.models || [];
      const shown = PAGE_KIND ? MODELS.filter(function (m) { return m.kind === PAGE_KIND; }) : MODELS;
      const select = $('#model');
      select.textContent = '';
      shown.forEach(function (m) {
        const option = document.createElement('option');
        option.value = m.id;
        // 服务端数组原序即推荐序;选项文案 = 名称 + 适合什么(去掉数字评分)
        option.textContent = (m.kind === 'video' && !PAGE_KIND ? '[视频] ' : '') + m.label
          + (m.fit ? ' — ' + m.fit : '');
        select.appendChild(option);
      });
      // 首页"生图/生视频"卡带 kind 参数进来:预选对应类型的第一个模型,标题同步
      const kindMatch = /kind=(video|image)/.exec(location.search);
      if (kindMatch) {
        const wantKind = kindMatch[1];
        const first = MODELS.find(function (m) { return m.kind === wantKind; });
        if (first) select.value = first.id;
        const label = wantKind === 'video' ? '生视频' : '生图';
        document.title = label + ' — KK工作台';
        const pageTitle = document.querySelector('.pagetitle');
        if (pageTitle) pageTitle.textContent = label;
        // 限额文案只讲本类型
        const limitHint = $('#limitHint');
        if (limitHint) {
          limitHint.textContent = (wantKind === 'video'
            ? '限额:每分钟 3 次提交;视频每天 30 个。'
            : '限额:每分钟 3 次提交;图片每天 100 张。')
            + '结果由服务端自动保存到硬盘,无需手动下载也不会丢;点「下载」可另存到当前设备。';
        }
      }
      renderKindFields();
    }).catch(function () {
      status('模型目录加载失败:上游不可用', true);
    });
  }

  $('#model').addEventListener('change', renderKindFields);
  $('#frameMode').addEventListener('change', renderRefLabel);

  // ---------- 门禁 ----------
  function acceptCode(code) {
    INVITE = code;
    if (code) {
      try { sessionStorage.setItem('ffGenInvite', code); } catch (e) { /* 隐私模式忽略 */ }
    }
    $('#gate').hidden = true;
    $('#app').hidden = false;
    status('就绪。提交任务后可继续挂其他任务。');
    loadModels();
    refreshQuota();
    restoreTasks();
  }

  // 服务端未设邀请码时(inviteRequired=false)本机免码直进;探测失败按需码处理
  function enterFree() {
    acceptCode('');
  }

  // 探测是否需要邀请码(该接口无码也响应,只回 inviteRequired 字段)
  function probeInviteRequired() {
    return fetch('/api/studio/models')
      .then(function (r) { return r.json(); })
      .then(function (payload) { return payload.inviteRequired !== false; });
  }

  // 从首页门禁弹窗跳转过来:sessionStorage 带码,静默复验直接进工作台
  (function autoEnter() {
    probeInviteRequired()
      .then(function (required) {
        if (!required) { enterFree(); return; }
        let saved = null;
        try { saved = sessionStorage.getItem('ffGenInvite'); } catch (e) { saved = null; }
        if (!saved) return;
        fetch('/api/studio/quota', { headers: { authorization: 'Bearer ' + saved } })
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (p) { return { ok: r.ok, payload: p }; });
          })
          .then(function (result) {
            if (result.ok) acceptCode(saved);
            else { try { sessionStorage.removeItem('ffGenInvite'); } catch (e) { /* 忽略 */ } }
          })
          .catch(function () { /* 网络抖动:留在门禁页,手动进入 */ });
      })
      .catch(function () { /* 探测失败:留门禁页兜底 */ });
  })();

  function enterWorkspace() {
    const code = $('#gateCode').value.trim();
    const errEl = $('#gateError');
    if (!code) {
      errEl.textContent = '请输入邀请码';
      errEl.hidden = false;
      return;
    }
    $('#gateGo').disabled = true;
    errEl.hidden = true;
    fetch('/api/studio/quota', { headers: { authorization: 'Bearer ' + code } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (payload) {
          return { ok: r.ok, status: r.status, payload: payload };
        });
      })
      .then(function (result) {
        $('#gateGo').disabled = false;
        if (result.status === 403 || result.payload.error === 'invite_locked') {
          errEl.textContent = '邀请码错误次数过多,今日已锁定,请明天再试';
          errEl.hidden = false;
          return;
        }
        if (!result.ok) {
          const left = result.payload.attemptsRemaining;
          errEl.textContent = '邀请码不正确' + (left !== undefined ? ',今天还可尝试 ' + left + ' 次' : '');
          errEl.hidden = false;
          return;
        }
        acceptCode(code);
      })
      .catch(function () {
        $('#gateGo').disabled = false;
        errEl.textContent = '验证请求失败,请重试';
        errEl.hidden = false;
      });
  }

  $('#gateGo').addEventListener('click', enterWorkspace);
  $('#gateCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') enterWorkspace(); });

  // ---------- 参考图 ----------
  function roleName(index) {
  const model = currentModel();
  if (!model || model.kind !== 'video') return '参考图' + (index + 1);
  if ($('#frameMode').value === 'first_last') return index === 0 ? '首帧' : '尾帧';
  return '首帧';
  }

  function renderThumbs() {
  const box = $('#thumbs');
  box.textContent = '';
  refs.forEach(function (src, index) {
    const wrap = document.createElement('span');
    wrap.className = 'gen-thumb';
    const img = document.createElement('img');
    img.src = src;
    img.alt = roleName(index);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除这张参考图';
    remove.addEventListener('click', function () {
      refs.splice(index, 1);
      renderThumbs();
    });
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = roleName(index);
    wrap.appendChild(img);
    wrap.appendChild(remove);
    wrap.appendChild(role);
    box.appendChild(wrap);
  });
  }

  function addRefFiles(fileList) {
  const files = Array.prototype.slice.call(fileList).filter(function (f) {
    return /^image\/(jpeg|png|webp)$/.test(f.type);
  });
  if (!files.length) return;
  files.forEach(function (file) {
    if (file.size > 2 * 1024 * 1024) { showSubmit('error', '参考图 ' + file.name + ' 超过 2MB'); return; }
    const reader = new FileReader();
    reader.onload = function () {
      if (refs.length >= maxRefs()) { showSubmit('error', '当前模型参考图最多 ' + maxRefs() + ' 张'); return; }
      refs.push(String(reader.result));
      renderThumbs();
      showSubmit('info', '已添加参考图 ' + refs.length + '/' + maxRefs());
    };
    reader.readAsDataURL(file);
  });
  }

  $('#refZone').addEventListener('click', function () { $('#refInput').click(); });
  $('#refInput').addEventListener('change', function (e) {
  addRefFiles(e.target.files);
  $('#refInput').value = '';
  });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
  e.preventDefault();
  if ($('#app').hidden) return;
  if (e.dataTransfer && e.dataTransfer.files.length) addRefFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', function (e) {
  if ($('#app').hidden) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
      const file = items[i].getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) addRefFiles(files);
  });

  // ---------- 提示词优化 ----------
  $('#btnOptimize').addEventListener('click', function () {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { showSubmit('error', '提示词为空,先写几个关键词再优化'); return; }
  const beforeRaw = $('#prompt').value;
  const model = currentModel();
  const isVideo = Boolean(model && model.kind === 'video');
  $('#btnOptimize').disabled = true;
  showSubmit('info', '优化中…');
  fetch('/api/studio/optimize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INVITE },
    body: JSON.stringify({ prompt: prompt, kind: isVideo ? 'video' : 'image', hasFirstFrame: isVideo && refs.length > 0, hasRefs: refs.length > 0 }),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (payload) {
      $('#btnOptimize').disabled = false;
      if (!r.ok) { showSubmit('error', '优化失败:' + (ERRORS[payload.error] || payload.error || '未知错误')); return; }
      optState = { before: beforeRaw, after: payload.prompt };
      $('#prompt').value = payload.prompt;
      renderOptCompare();
      showSubmit('info', '已优化提示词,可继续手改,或一键还原');
    });
  }).catch(function () {
    $('#btnOptimize').disabled = false;
    showSubmit('error', '优化请求失败:网络错误');
  });
  });

  // ---------- 优化对比(一键还原) ----------
  let optState = null;   // 最近一次优化的 { before, after }

  function renderOptCompare() {
  const panel = $('#optCompare');
  if (!optState) { panel.hidden = true; return; }
  const current = $('#prompt').value;
  $('#optBefore').textContent = optState.before;
  // 「优化后」一栏实时跟随输入框;被手改时在标签上标注
  $('#optAfter').textContent = current;
  $('#optAfterLabel').textContent = current === optState.after ? '优化后' : '优化后(已手改)';
  panel.hidden = false;
  }

  $('#prompt').addEventListener('input', function () {
  if (optState) renderOptCompare();
  });

  $('#btnRestore').addEventListener('click', function () {
  if (!optState) return;
  $('#prompt').value = optState.before;
  optState = null;
  renderOptCompare();
  showSubmit('info', '已还原为优化前原文;再点「✨ 优化提示词」可重新生成');
  $('#prompt').focus();
  });

  $('#optClose').addEventListener('click', function () {
  optState = null;
  renderOptCompare();
  });

  // ---------- 灯箱 ----------
  $('#lightbox').addEventListener('click', function () {
  this.style.display = 'none';
  const lv = $('#lightboxVideo');
  if (lv) { lv.pause(); lv.removeAttribute('src'); lv.load(); }
  });
  $('#lightboxVideo').addEventListener('click', function (e) { e.stopPropagation(); }); // 点控件不关灯箱

  // ---------- 任务 ----------
  function createCard(snapshot) {
  $('#genEmpty').hidden = true;
  const card = document.createElement('div');
  card.className = 'task';
  const head = document.createElement('div');
  head.className = 'task-head';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = snapshot.kind === 'video' ? '🎬' : '🖼️';
  const model = document.createElement('span');
  model.className = 'model';
  model.textContent = snapshot.model;
  const statusEl = document.createElement('span');
  statusEl.className = 'task-status';
  head.appendChild(kind); head.appendChild(model); head.appendChild(statusEl);
  const paramsLine = document.createElement('div');
  paramsLine.className = 'task-params';
  const ptxt = paramsText(snapshot.params);
  paramsLine.textContent = ptxt;
  paramsLine.hidden = !ptxt;
  const promptLine = document.createElement('div');
  promptLine.className = 'task-prompt';
  promptLine.textContent = snapshot.prompt || $('#prompt').value.trim();
  promptLine.title = promptLine.textContent;
  const result = document.createElement('div');
  result.className = 'task-result';
  const errorLine = document.createElement('div');
  errorLine.className = 'task-error';
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  card.appendChild(head); card.appendChild(paramsLine); card.appendChild(promptLine);
  card.appendChild(result); card.appendChild(errorLine); card.appendChild(actions);
  $('#taskList').insertBefore(card, $('#taskList').firstChild);
  return { status: statusEl, result: result, errorLine: errorLine, actions: actions };
  }

  // 按任务状态渲染操作按钮:running→取消;failed→重试;终态→再来一次;全部→复制提示词
  function renderActions(entry) {
  const box = entry.els.actions;
  const s = entry.snapshot;
  box.textContent = '';
  const mk = function (label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'task-btn';
    b.textContent = label;
    b.addEventListener('click', function () { fn(b); });
    box.appendChild(b);
    return b;
  };
  if (s.status === 'running') {
    mk('✕ 取消', function (b) {
      b.disabled = true;
      fetch('/api/studio/tasks/' + s.id + '/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + INVITE },
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (payload) {
          if (!r.ok) {
            b.disabled = false;
            showSubmit('error', '取消失败:' + (ERRORS[payload.error] || payload.error || '未知错误'));
            return;
          }
          showSubmit('info', '已请求取消,收尾中(上游不撤单,可能照常计费)…');
        });
      }).catch(function () {
        b.disabled = false;
        showSubmit('error', '取消请求失败:网络错误');
      });
    });
    return;
  }
  if (s.status === 'failed') {
    mk('↻ 重试', function (b) { rerunTask(entry, b); });
  } else if (s.status === 'succeeded' || s.status === 'cancelled') {
    mk('🔄 再来一次', function (b) { rerunTask(entry, b); });
  }
  mk('⧉ 复制提示词', function () { copyText(s.prompt || ''); });
  }

  // 按落盘的 request.json 原样重跑(失败重试/再来一次):服务端克隆参数与参考图
  function rerunTask(entry, btn) {
  if (btn) btn.disabled = true;
  fetch('/api/studio/tasks/' + entry.snapshot.id + '/rerun', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + INVITE },
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (payload) {
      if (btn) btn.disabled = false;
      refreshQuota();
      if (!r.ok) {
        showSubmit('error', '重跑失败:' + (ERRORS[payload.error] || payload.error || '未知错误'));
        return;
      }
      showSubmit('info', '已按原参数重新提交为新任务');
      const newEntry = { els: createCard(payload), snapshot: payload };
      running[payload.id] = newEntry;
      renderRunning(newEntry);
    });
  }).catch(function () {
    if (btn) btn.disabled = false;
    showSubmit('error', '重跑请求失败:网络错误');
  });
  }

  // b64 结果按服务端给的 mime 拼 data URL(jpeg/webp/svg 模型写死 png 会显示坏图)
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                   'image/gif': 'gif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4' };

  function renderResult(target, snapshot) {
  target.textContent = '';
  (snapshot.data || []).forEach(function (item, index) {
    const mime = item.mime || (snapshot.kind === 'video' ? 'video/mp4' : 'image/png');
    // 结果落盘后走文件直链(手机长按可存,保留期内随时可取);内存兜底/上游 url 型保持原样
    const src = item.file
      ? '/api/studio/file/' + snapshot.id + '/' + (index + 1)
      : (item.b64_json ? 'data:' + mime + ';base64,' + item.b64_json : item.url);
    const cell = document.createElement('div');
    cell.className = 'result-item';
    if (snapshot.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = src;
      cell.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.alt = '生成结果';
      img.src = src;
      img.title = '点击放大预览';
      img.addEventListener('click', function () {
        $('#lightboxImg').src = src;
        $('#lightboxImg').hidden = false;
        $('#lightboxVideo').hidden = true;
        $('#lightbox').style.display = 'flex';
      });
      cell.appendChild(img);
    }
    const download = document.createElement('a');
    download.className = 'download';
    download.textContent = '⬇ 下载';
    download.href = src;
    download.download = 'frameflow-' + snapshot.kind + '-' + snapshot.id.slice(0, 8) + '-' + (index + 1)
      + '.' + (MIME_EXT[mime] || (snapshot.kind === 'video' ? 'mp4' : 'png'));
    cell.appendChild(download);
    if (snapshot.kind === 'video') {
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'download';
      expand.textContent = '⤢ 放大播放';
      expand.addEventListener('click', function () {
        const lv = $('#lightboxVideo');
        lv.src = src;
        lv.hidden = false;
        $('#lightboxImg').hidden = true;
        $('#lightbox').style.display = 'flex';
      });
      cell.appendChild(expand);
    }
    target.appendChild(cell);
  });
  }

  function statusText(snapshot) {
  if (snapshot.status === 'succeeded') {
    let text = '完成,耗时 ' + Math.round((snapshot.durationMs || 0) / 1000) + ' 秒';
    const usage = snapshot.usage;
    if (usage) {
      if (usage.cost !== undefined) text += ' · 消耗 $' + usage.cost.toFixed(2);
      if (usage.tokens !== undefined) text += ' · ' + usage.tokens + ' tokens';
    }
    return text;
  }
  if (snapshot.status === 'cancelled') {
    let text = '已取消,耗时 ' + Math.round((snapshot.durationMs || 0) / 1000) + ' 秒';
    if ((snapshot.data || []).length) text += '(保留了已完成部分)';
    return text;
  }
  if (snapshot.status === 'failed') return '失败(' + (ERRORS[snapshot.error] || snapshot.error || '未知错误') + ')';
  let text = '生成中…';
  const p = snapshot.params || {};
  if (snapshot.kind === 'image' && p.count > 1 && snapshot.produced) {
    text += ' 已完成 ' + Math.min(snapshot.produced, p.count) + '/' + p.count;
  }
  if (snapshot.kind === 'video' && snapshot.upstreamStatus) {
    text += ' 上游:' + snapshot.upstreamStatus;
  }
  if (snapshot.cancelling) text += ' · 取消中…';
  return text + ' 已等待 ' + Math.round((Date.now() - new Date(snapshot.createdAt).getTime()) / 1000) + ' 秒';
  }

  function renderRunning(entry) {
  const s = entry.snapshot;
  entry.els.status.textContent = statusText(s);
  entry.els.status.className = 'task-status'
    + (s.status === 'succeeded' ? ' done'
      : s.status === 'failed' ? ' failed'
      : s.status === 'cancelled' ? ' cancelled' : '');
  renderActions(entry);
  }

  // 已结束任务的静态卡片(刷新恢复列表用;终态不会再变)
  function createFinishedCard(snapshot) {
  const els = createCard(snapshot);
  if ((snapshot.status === 'succeeded' || snapshot.status === 'cancelled')
      && (snapshot.data || []).length) {
    renderResult(els.result, snapshot);
  } else if (snapshot.status === 'failed') {
    els.errorLine.textContent = ERRORS[snapshot.error] || snapshot.error || '未知错误';
  }
  renderRunning({ els: els, snapshot: snapshot });
  return els;
  }

  // 刷新恢复:页面加载时拉一次任务列表(进行中的恢复轮询,已完成的直接渲染)
  function restoreTasks() {
  fetch('/api/studio/tasks', { headers: { authorization: 'Bearer ' + INVITE } })
    .then(function (r) {
      return r.json().catch(function () { return { tasks: [] }; }).then(function (payload) {
        if (!r.ok) return;
        (payload.tasks || [])
        .filter(function (t) { return !PAGE_KIND || t.kind === PAGE_KIND; })
        .forEach(function (snapshot) {
          if (running[snapshot.id]) return;
          const entry = { els: createFinishedCard(snapshot), snapshot: snapshot };
          running[snapshot.id] = entry;
          renderRunning(entry);
          if (snapshot.status !== 'running') delete running[snapshot.id];
        });
      });
    })
    .catch(function () { /* 网络抖动:下一轮轮询会补 */ });
  }

  $('#btnSubmit').addEventListener('click', function () {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { showSubmit('error', '请填写提示词'); return; }
  const model = currentModel();
  const isVideo = Boolean(model && model.kind === 'video');
  if (isVideo && $('#frameMode').value === 'first_last' && refs.length < 2) {
    showSubmit('error', '首尾帧模式需要 2 张参考图(第 1 张首帧、第 2 张尾帧)');
    return;
  }
  const body = { prompt: prompt, model: $('#model').value };
  if (isVideo) {
    body.frameMode = $('#frameMode').value;
    body.duration = Number($('#duration').value);
    body.audio = $('#audio').checked;
    const res = $('#resolution').value;
    if (res) body.resolution = res; // 「自动」不发该参数,按上游默认
    if (refs.length > 0) body.referenceImages = refs.slice(0, 2);
  } else {
    body.count = Number($('#count').value);
    if (supportsImageParams(model)) {
      body.aspectRatio = $('#aspect').value;
      body.imageSize = $('#imageSize').value;
    }
    if (refs.length > 0) body.referenceImages = refs;
  }
  $('#btnSubmit').disabled = true;
  fetch('/api/studio/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INVITE },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (payload) {
      $('#btnSubmit').disabled = false;
      refreshQuota();
      if (!r.ok) {
        showSubmit('error', '提交失败:' + (ERRORS[payload.error] || payload.error || '未知错误'));
        return;
      }
      showSubmit('info', '已提交,任务在后台生成;可以继续提交其他任务');
      const entry = { els: createCard(payload), snapshot: payload };
      running[payload.id] = entry;
      renderRunning(entry);
    });
  }).catch(function () {
    $('#btnSubmit').disabled = false;
    showSubmit('error', '请求失败:网络错误');
  });
  });

  // 轮询:3 秒一轮,只对 running 中的任务发请求
  setInterval(function () {
  if (Object.keys(running).length > 0) refreshQuota();
  Object.keys(running).forEach(function (id) {
    const entry = running[id];
    renderRunning(entry);
    fetch('/api/studio/tasks/' + id, { headers: { authorization: 'Bearer ' + INVITE } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (payload) {
          if (!r.ok) {
            entry.els.status.className = 'task-status failed';
            entry.els.status.textContent = r.status === 404
              ? '任务不存在(可能已超出保留期被清理)'
              : '查询失败:' + (ERRORS[payload.error] || payload.error || '未知错误');
            delete running[id];
            return;
          }
          entry.snapshot = payload;
          renderRunning(entry);
          if (payload.status === 'succeeded' || payload.status === 'cancelled') {
            if ((payload.data || []).length) renderResult(entry.els.result, payload);
            delete running[id];
          } else if (payload.status === 'failed') {
            entry.els.errorLine.textContent = ERRORS[payload.error] || payload.error || '未知错误';
            delete running[id];
          }
        });
      })
      .catch(function () { /* 网络抖动,下一轮再试 */ });
  });
  }, 3000);
})();
