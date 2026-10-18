// FrameSpine - 应用状态与 UI 接线
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  // 邀请码门禁(js/gate.js 解锁后置 window.FFGate):/api/gen/* 与生图工作台同一把码
  function gateReady() { return Boolean(window.FFGate && window.FFGate.ok); }
  function gateAuth() { return { authorization: 'Bearer ' + ((window.FFGate && window.FFGate.code) || '') }; }
  const GATE_ERRORS = {
    invalid_invite_code: '邀请码不正确',
    invite_locked: '邀请码错误次数过多,今日已锁定,请明天再试',
    upstream_unavailable: '服务端未设邀请码且当前来源非本机,已拒绝(公网部署需设 GEN_INVITE_CODE)',
  };
  function gateGuard(label) {
    if (gateReady()) return true;
    status(label + ':请先输入邀请码进入工作台。', true);
    return false;
  }

  const state = {
    frames: [],
    videoInfo: null,
    loops: [],
    selection: { start: 0, end: 0 },
    charId: 'hero_v01',
    key: { mode: 'green', color: [0, 255, 70], tol: 0.3, spill: 0.7, edges: false, edgeMode: 'none' },
    dedupeThreshold: 2,
    dedupe: { frames: true, perceptual: false, phashThr: 8 },
    exportScale: 1,
    maxWidth: 16384,
    compress: { mode: 'tinypng' },
    showBBox: false,
    bbox: null,
    brush: { mode: 'erase', r: 18, tol: 0.15 },
    currentFrame: 0,
    playing: false,
  };

  window.FSApp = { state: state };

  // ---------- 状态栏 ----------
  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    if (isError) console.error(msg);
  }
  function progress(msg) { $('#status').textContent = msg; }

  function setBusy(b) {
    document.body.classList.toggle('busy', b);
  }

  // ---------- 导入与拆帧 ----------
  async function importFile(file) {
    if (!file) return;
    setBusy(true);
    try {
      status('正在拆帧…');
      const fps = FS.clamp(parseFloat($('#extractFps').value) || 10, 1, 30);
      state.frames = [];
      state.bbox = null; // state.loops 跨视频保留:逐条导入动作视频,攒成完整角色
      const result = await FS.extractFrames(file, fps, 400, function (i, n) {
        progress('拆帧中 ' + i + '/' + n);
      });
      state.frames = result.frames;
      state.videoInfo = result;
      state.selection = { start: 0, end: Math.max(0, result.frames.length - 1) };
      $('#videoInfo').textContent = result.videoW + '×' + result.videoH + ' · ' + result.duration.toFixed(2) + 's · ' + result.frames.length + ' 帧 @' + fps + 'fps';
      status('拆帧完成,正在抠图…');
      const detected = autoDetectKey(result.frames[0]);
      await keyAll();
      const kept = state.loops.length ? ' 已保留 ' + state.loops.length + ' 个已添加动画,可继续选段添加下一个动作。' : '';
      status((detected
        ? '完成。已自动检测背景色并抠图;不满意可调容差/勾"边缘泛洪"后点【重新抠图】。'
        : '完成。背景色不明显,当前为默认绿幕键控;请选键色模式并点【重新抠图】。') + kept);
      renderAll();
    } catch (e) {
      status('导入失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- 切图:雪碧图/大图 → 帧 ----------
  async function importImageSlices(file) {
    if (!file) return;
    setBusy(true);
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); };
      img.src = url;
      await new Promise(function (resolve, reject) {
        img.onload = resolve;
        img.onerror = function () { reject(new Error('图片无法解码')); };
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const mode = $('#sliceMode').value;
      let result;
      if (mode === 'grid') {
        result = FS.gridSliceImage(canvas, FS.clamp(parseInt($('#sliceCols').value) || 4, 1, 32), FS.clamp(parseInt($('#sliceRows').value) || 2, 1, 32));
      } else if (mode === 'single') {
        result = { rects: [{ x: 0, y: 0, w: canvas.width, h: canvas.height }] };
      } else {
        result = FS.autoSliceImage(canvas, FS.clamp(parseInt($('#sliceMin').value) || 12, 2, 256));
        if (result.error) throw new Error(result.error);
      }
      if (!result.rects.length) throw new Error('没有切出任何帧(检查最小块设置或图片是否有透明内容)');
      const rects = result.rects.slice(0, 200);
      state.frames = rects.map(function (r, i) {
        const orig = document.createElement('canvas');
        orig.width = r.w; orig.height = r.h;
        orig.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        const proc = document.createElement('canvas');
        proc.width = r.w; proc.height = r.h;
        proc.getContext('2d', { willReadFrequently: true }).drawImage(orig, 0, 0);
        return { id: i, orig: orig, proc: proc, strokes: [], dropped: false, hash: null };
      });
      state.bbox = null;
      state.selection = { start: 0, end: state.frames.length - 1 };
      $('#videoInfo').textContent = file.name + ' · ' + canvas.width + '×' + canvas.height + ' · 切出 ' + state.frames.length + ' 帧';
      computeBBox();
      renderAll();
      const kept = state.loops.length ? ' 已保留 ' + state.loops.length + ' 个已添加动画。' : '';
      status('切图完成:' + state.frames.length + ' 帧。' + (mode === 'auto' ? '' : '(非透明图可再走③抠图)') + kept);
    } catch (e) {
      status('切图失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- 抠图 ----------
  async function keyAll() {
    setBusy(true);
    try {
      const n = state.frames.length;
      for (let i = 0; i < n; i++) {
        FS.applyKey(state.frames[i], state.key);
        if (i % 10 === 0) { progress('抠图中 ' + (i + 1) + '/' + n); await FS.sleep(0); }
      }
      computeBBox();
      renderStrip();
      drawCenter();
      status('抠图完成(' + n + ' 帧)。');
    } finally {
      setBusy(false);
    }
  }

  function keyColorFromMode() {
    const mode = state.key.mode;
    if (mode === 'green') return [0, 255, 70];
    if (mode === 'white') return [255, 255, 255];
    if (mode === 'black') return [0, 0, 0];
    return state.key.color;
  }

  // 取色:点击预览图任意位置,把该像素设为键色(仅 custom 模式生效)
  function pickColorAt(x, y) {
    const f = state.frames[state.currentFrame];
    if (!f) return;
    const d = f.orig.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    state.key.color = [d[0], d[1], d[2]];
    state.key.mode = 'custom';
    $('#keyMode').value = 'custom';
    updateKeySwatch();
    status('键色已取样 rgb(' + d[0] + ',' + d[1] + ',' + d[2] + '),点击【重新抠图】应用。');
  }

  // 导入后自动检测背景色:画面边缘 8 个采样点颜色一致(离散小)才采用,
  // 用于黑/白/绿等纯色底 AI 素材,免去手动选键色
  function autoDetectKey(f) {
    if (!f) return false;
    const w = f.orig.width, h = f.orig.height;
    const d = f.orig.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const pts = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [w >> 1, 1], [w >> 1, h - 2], [1, h >> 1], [w - 2, h >> 1]];
    let r = 0, g = 0, b = 0;
    const cols = pts.map(function (p) {
      const i = (p[1] * w + p[0]) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2];
      return [d[i], d[i + 1], d[i + 2]];
    });
    r /= cols.length; g /= cols.length; b /= cols.length;
    let maxDist = 0;
    cols.forEach(function (c) {
      const dr = (c[0] - r) / 255, dg = (c[1] - g) / 255, db = (c[2] - b) / 255;
      maxDist = Math.max(maxDist, Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3));
    });
    if (maxDist >= 0.12) return false;
    state.key = { mode: 'custom', color: [Math.round(r), Math.round(g), Math.round(b)], tol: 0.3, spill: 0.7, edges: false, edgeMode: 'none' };
    $('#keyMode').value = 'custom';
    updateKeySwatch();
    return true;
  }

  // ---------- 对齐框 ----------
  function computeBBox() {
    state.bbox = FS.computeUnionBBox(state.frames.filter(function (f) { return !f.dropped; }));
    return state.bbox;
  }

  // ---------- 循环检测 ----------
  function detectLoops() {
    if (!state.frames.length) return;
    const cands = FS.detectLoops(state.frames);
    const box = $('#loopCandidates');
    box.innerHTML = '';
    if (!cands.length) { box.innerHTML = '<div class="muted">未找到候选循环,请手动选段。</div>'; return; }
    cands.forEach(function (c) {
      const div = document.createElement('button');
      div.className = 'cand';
      div.textContent = '第 ' + c.start + '–' + c.end + ' 帧(长 ' + c.len + ',差异 ' + c.dist + ')';
      div.addEventListener('click', function () {
        state.selection = { start: c.start, end: c.end };
        $('#selStart').value = c.start;
        $('#selEnd').value = c.end;
        startPreview();
      });
      box.appendChild(div);
    });
    status('找到 ' + cands.length + ' 个候选循环,点击即可预览。');
  }

  // ---------- 添加动画 ----------
  function addLoopFromSelection() {
    if (!state.frames.length) return;
    const s = FS.clamp(parseInt($('#selStart').value) || 0, 0, state.frames.length - 1);
    const e = FS.clamp(parseInt($('#selEnd').value) || 0, s, state.frames.length - 1);
    let name = FS.sanitizeName($('#loopName').value || 'idle');
    while (state.loops.some(function (l) { return l.name === name; })) name = name + '_2';
    const fps = FS.clamp(parseFloat($('#loopFps').value) || 10, 1, 30);
    const frames = state.frames.slice(s, e + 1).filter(function (f) { return !f.dropped; });
    if (!frames.length) { status('选段内没有保留帧。', true); return; }
    state.loops.push({ name: name, frames: frames, fps: fps, loop: $('#loopFlag').checked });
    renderLoops();
    status('已添加动画「' + name + '」(' + frames.length + ' 帧 @' + fps + 'fps)。可继续添加其他动作,或直接导出。');
  }

  function removeLoop(name) {
    state.loops = state.loops.filter(function (l) { return l.name !== name; });
    renderLoops();
  }

  // ---------- 减帧 ----------
  function autoDrop() {
    if (!state.frames.length) return;
    const count = FS.autoDrop(state.frames, state.dedupeThreshold);
    computeBBox();
    renderStrip();
    drawCenter();
    status('自动剔除了 ' + count + ' 帧过近帧。可点缩略图下的勾选框手动改,再点【重新抠图】会保留勾选结果。');
  }

  // ---------- 预览播放 ----------
  let playTimer = null;
  let playPos = 0;

  function startPreview() {
    stopPreview();
    if (!state.frames.length) return;
    const fps = FS.clamp(parseFloat($('#previewFps').value) || 10, 1, 30);
    const s = state.selection.start, e = state.selection.end;
    const list = [];
    for (let i = s; i <= e; i++) if (state.frames[i] && !state.frames[i].dropped) list.push(i);
    if (!list.length) return;
    playPos = list[0];
    let pos = 0;
    state.playing = true;
    playTimer = setInterval(function () {
      drawCenter(state.frames[playPos]);
      highlightThumb(playPos);
      pos = (pos + 1) % list.length;
      playPos = list[pos];
    }, 1000 / fps);
    $('#playBtn').textContent = '⏸ 停止预览';
  }

  function stopPreview() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    state.playing = false;
    const b = $('#playBtn');
    if (b) b.textContent = '▶ 预览选段';
  }

  // ---------- 渲染 ----------
  function renderAll() {
    renderStrip();
    renderLoops();
    updateKeySwatch();
    drawCenter();
  }

  function renderStrip() {
    const strip = $('#strip');
    strip.innerHTML = '';
    state.frames.forEach(function (f, i) {
      const cell = document.createElement('div');
      cell.className = 'thumb' + (f.dropped ? ' dropped' : '') + (i === state.currentFrame ? ' current' : '');
      cell.dataset.idx = i;
      const c = document.createElement('canvas');
      const tw = 72, th = Math.max(40, Math.round(72 * f.proc.height / f.proc.width));
      c.width = tw; c.height = th;
      const ctx = c.getContext('2d');
      drawChecker(ctx, c.width, c.height, 6);
      ctx.drawImage(f.proc, 0, 0, c.width, c.height);
      const label = document.createElement('div');
      label.className = 'tl';
      label.textContent = i;
      const keep = document.createElement('input');
      keep.type = 'checkbox';
      keep.checked = !f.dropped;
      keep.title = '勾选=保留,取消=剔除';
      keep.addEventListener('change', function () {
        f.dropped = !keep.checked;
        cell.classList.toggle('dropped', f.dropped);
        computeBBox();
      });
      c.addEventListener('click', function () { selectFrame(i); });
      label.addEventListener('click', function () { selectFrame(i); });
      cell.appendChild(c);
      cell.appendChild(label);
      cell.appendChild(keep);
      strip.appendChild(cell);
    });
  }

  function highlightThumb(i) {
    const cells = $('#strip').children;
    for (let k = 0; k < cells.length; k++) {
      cells[k].classList.toggle('current', k === i);
    }
  }

  function selectFrame(i) {
    if (state.playing) stopPreview();
    state.currentFrame = i;
    highlightThumb(i);
    drawCenter();
  }

  function drawChecker(ctx, w, h, size) {
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#464646';
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        if (((x / size) | 0) % 2 === ((y / size) | 0) % 2) ctx.fillRect(x, y, size, size);
      }
    }
  }

  function drawCenter(forced) {
    const view = $('#view');
    const ctx = view.getContext('2d');
    const f = forced || state.frames[state.currentFrame];
    ctx.clearRect(0, 0, view.width, view.height);
    if (!f) {
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.fillText('先导入 AI 生成的动作视频(MP4/WebM),建议纯色背景、无投影', 24, 40);
      return;
    }
    const fit = fitRect(f.proc.width, f.proc.height, view.width, view.height);
    drawChecker(ctx, view.width, view.height, 12);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(f.proc, fit.x, fit.y, fit.w, fit.h);
    if (state.showBBox && state.bbox) {
      const k = fit.w / f.proc.width;
      ctx.strokeStyle = '#4dd2ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(fit.x + state.bbox.x * k, fit.y + state.bbox.y * k, state.bbox.w * k, state.bbox.h * k);
    }
  }

  function fitRect(sw, sh, dw, dh) {
    const k = Math.min(dw / sw, dh / sh) * 0.98;
    const w = sw * k, h = sh * k;
    return { x: (dw - w) / 2, y: (dh - h) / 2, w: w, h: h, k: k };
  }

  function renderLoops() {
    const box = $('#loopList');
    box.innerHTML = '';
    state.loops.forEach(function (l) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = l.name + '(' + l.frames.length + 'f@' + l.fps + (l.loop ? ',循环' : '') + ')';
      const x = document.createElement('button');
      x.textContent = '×';
      x.addEventListener('click', function () { removeLoop(l.name); });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  function updateKeySwatch() {
    const c = keyColorFromMode();
    $('#keySwatch').style.background = 'rgb(' + c.join(',') + ')';
  }

  // ---------- 画笔 ----------
  let painting = null;
  function viewToFrame(e) {
    const view = $('#view');
    const rect = view.getBoundingClientRect();
    const f = state.frames[state.currentFrame];
    if (!f) return null;
    const fit = fitRect(f.proc.width, f.proc.height, view.width, view.height);
    const x = Math.round((e.clientX - rect.left) * (view.width / rect.width) - fit.x) / fit.k;
    const y = Math.round((e.clientY - rect.top) * (view.height / rect.height) - fit.y) / fit.k;
    if (x < 0 || y < 0 || x >= f.proc.width || y >= f.proc.height) return null;
    return [Math.round(x), Math.round(y)];
  }

  function bindBrush() {
    const view = $('#view');
    view.addEventListener('pointerdown', function (e) {
      if (e.altKey) {
        const p = viewToFrame(e);
        if (p) pickColorAt(p[0], p[1]);
        return;
      }
      const p = viewToFrame(e);
      if (!p) return;
      const f = state.frames[state.currentFrame];
      if (state.brush.mode === 'wand') {
        // 魔棒:单击清除同色连通区
        const stroke = { mode: 'wand', tol: state.brush.tol, pts: [p] };
        const n = FS.wandRemove(f, p[0], p[1], state.brush.tol);
        f.strokes.push(stroke);
        drawCenter();
        computeBBox();
        status('魔棒清除了 ' + n + ' 个像素。');
        return;
      }
      view.setPointerCapture(e.pointerId);
      painting = { mode: state.brush.mode, r: state.brush.r, pts: [p] };
      FS.applyStroke(f, { mode: painting.mode, r: painting.r, pts: painting.pts });
      drawCenter();
    });
    view.addEventListener('pointermove', function (e) {
      if (!painting) return;
      const p = viewToFrame(e);
      if (!p) return;
      const last = painting.pts[painting.pts.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < painting.r / 2) return;
      painting.pts.push(p);
      const f = state.frames[state.currentFrame];
      FS.applyStroke(f, { mode: painting.mode, r: painting.r, pts: [p] });
      drawCenter();
    });
    view.addEventListener('pointerup', function () {
      if (!painting) return;
      const f = state.frames[state.currentFrame];
      f.strokes.push(painting);
      painting = null;
      computeBBox();
    });
  }

  // ---------- 导出 ----------
  function exportLoops() {
    if (state.loops.length) return state.loops;
    // 未添加任何动画时,把当前选段作为 idle 导出
    const s = FS.clamp(parseInt($('#selStart').value) || 0, 0, state.frames.length - 1);
    const e = FS.clamp(parseInt($('#selEnd').value) || 0, s, state.frames.length - 1);
    const fps = FS.clamp(parseFloat($('#loopFps').value) || 10, 1, 30);
    const frames = state.frames.slice(s, e + 1).filter(function (f) { return !f.dropped; });
    return [{ name: FS.sanitizeName($('#loopName').value || 'idle'), frames: frames, fps: fps, loop: true }];
  }

  async function exportSpritesheet() {
    const loops = exportLoops();
    const r = await FS.exportSpritesheet(loops, state.bbox, state.exportScale, state.maxWidth, state.compress);
    FS.downloadBlob(r.pngBlob, state.charId + '_sheet.png');
    FS.downloadBlob(FS.makeTextBlob(r.metaText), state.charId + '_sheet_meta.json');
    status('已导出精灵图集 ' + r.width + '×' + r.height + ' ' + FS.formatBytes(r.pngBlob.size) + '(PNG+描述文件)。'
      + (r.overBudget ? ' ⚠ 图集超出 16384 上限,建议调低导出缩放。' : ''));
  }

  async function exportFramesZip() {
    const loops = exportLoops();
    const zip = await FS.exportFramesZip(state.charId, loops, state.bbox, state.exportScale, state.compress);
    FS.downloadBlob(zip, state.charId + '_frames.zip');
    status('已导出序列帧 ZIP ' + FS.formatBytes(zip.size) + '。');
  }

  async function exportSpineZip() {
    const loops = exportLoops();
    try {
      const r = await FS.exportSpine(state.charId, loops, state.bbox, state.exportScale, state.maxWidth, state.compress, {
        dedupe: state.dedupe.frames,
        perceptual: state.dedupe.perceptual,
        phashThr: state.dedupe.phashThr,
      });
      const zip = await FS.exportSpineZip(r, state.charId);
      FS.downloadBlob(zip, state.charId + '_spine.zip');
      const s = r.stats;
      const dedupMsg = s.dedupe
        ? '去重 ' + s.totalFrames + '→' + s.uniqueFrames + ' 帧(精确 ' + s.exactMerged + (s.perceptualMerged ? ',近似 ' + s.perceptualMerged : '') + ')'
        : '未去重';
      status('已导出 Spine 三件套 ZIP ' + FS.formatBytes(zip.size) + ':' + state.charId + '.json / .atlas.txt / .png(图集 ' + FS.formatBytes(r.pngBlob.size) + ',' + dedupMsg + ')'
        + (r.overBudget ? ' ⚠ 图集超出 16384 上限,建议调低导出缩放。' : '。'));
    } catch (e) {
      status('导出失败:' + e.message, true);
    }
  }

  // ---------- 生视频(内置 anim/gen.mjs,服务端 node 桥接) ----------
  const gen = { refDataUrl: null, refName: '', busy: false, batchStop: false };

  // 战斗五件套提示词模板:只写运动(图管长相,词管动作);
  // idle/attack/hit/ult 统一「起手收手=自然站姿」→ 跨动作首尾帧接近,导出可去重复用;
  // move 用原地循环跑(pingpong 会倒放,跑步循环用 raw)
  const battleTemplates = [
    { key: 'idle', label: '待机 idle', loop: 'pingpong',
      prompt: '角色保持自然站姿,轻轻呼吸,肩膀微微起伏,头部与尾巴小幅摆动,起始帧和结束帧都是同一个自然站姿' },
    { key: 'attack', label: '普通攻击 attack', loop: 'off',
      prompt: '角色从自然站姿发力,快速挥出一记近战挥砍,干净利落只出一招,收招后回到与起始相同的自然站姿' },
    { key: 'hit', label: '受击 hit', loop: 'off',
      prompt: '角色保持自然站姿时突然被正面击中,上半身后仰、踉跄半步,随后重新站稳回到自然站姿' },
    { key: 'move', label: '移动 move', loop: 'raw',
      prompt: '角色原地跑步,前后摆臂,步伐均匀有力,起点和终点姿态一致,可无缝循环' },
    { key: 'ult', label: '大招 ult', loop: 'off',
      prompt: '角色从自然站姿下蹲蓄力,然后爆发释放大招,动作大开大合,最后收势回到自然站姿' },
  ];

  function genRefFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      gen.refDataUrl = reader.result;
      gen.refName = file.name;
      const img = $('#genRefThumb');
      img.src = gen.refDataUrl;
      img.hidden = false;
      $('#genRefBtn').textContent = '首帧图: ' + file.name;
    };
    reader.readAsDataURL(file);
  }

  function genPayload(dryRun) {
    return {
      refImage: gen.refDataUrl || '',
      name: state.charId + '_' + ($('#loopName').value || 'action'),
      prompt: $('#genPrompt').value,
      model: $('#genModel').value,
      resolution: $('#genRes').value,
      loop: $('#genLoop').value,
      candidates: parseInt($('#genCandidates').value) || 1,
      dryRun: dryRun,
    };
  }

  async function genApi(payload) {
    const resp = await fetch('/api/gen/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...gateAuth() },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!data.ok && GATE_ERRORS[data.error]) data.error = GATE_ERRORS[data.error];
    return data;
  }

  function genLogShow(text) {
    const box = $('#genLog');
    box.hidden = false;
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  }

  async function genDryRun() {
    if (gen.busy) return;
    if (!gateGuard('生视频')) return;
    if (!gen.refDataUrl) { status('生视频:请先选择首帧图。', true); return; }
    if (!$('#genPrompt').value.trim()) { status('生视频:请填写运动提示词。', true); return; }
    gen.busy = true;
    genLogShow('dry-run 中…');
    try {
      const r = await genApi(genPayload(true));
      genLogShow((r.tail || '') + (r.ok ? '\n[dry-run 通过]' : '\n[dry-run 失败]'));
      status(r.ok ? 'dry-run 完成,最终提示词见日志。' : 'dry-run 失败:' + (r.tail || '').split('\n').pop(), !r.ok);
    } catch (e) {
      genLogShow('dry-run 请求失败:' + e.message);
      status('dry-run 失败:' + e.message, true);
    } finally {
      gen.busy = false;
    }
  }

  // 轮询生成任务直到 done;网络抖动自动重试,连续失败 10 次才报错
  async function pollJob(jobId, onTick) {
    let fails = 0;
    for (;;) {
      await FS.sleep(3000);
      let s = null;
      try {
        s = await (await fetch('/api/gen/status?job=' + jobId, { headers: gateAuth() })).json();
      } catch (e) { /* 网络抖动,下轮重试 */ }
      if (!s || !s.ok) {
        if (++fails >= 10) throw new Error((s && (GATE_ERRORS[s.error] || s.error)) || '任务状态查询连续失败');
        continue;
      }
      fails = 0;
      if (onTick) onTick(s);
      if (s.state === 'done') return s;
      if (s.state === 'error') throw new Error('生成失败,详见日志');
    }
  }

  // 结果行(可累加,批量模式每个动作一行);label 传动作名/null
  function renderResultRow(label, jobId, videos, winner) {
    const box = $('#genResults');
    if (label) {
      const head = document.createElement('div');
      head.className = 'row';
      head.textContent = '【' + label + '】' + (winner && winner.cost != null ? '($' + (+winner.cost).toFixed(2) + ')' : '');
      box.appendChild(head);
    }
    (videos || []).forEach(function (name) {
      const row = document.createElement('div');
      row.className = 'row';
      const info = document.createElement('span');
      info.textContent = name;
      const btn = document.createElement('button');
      btn.textContent = '→ 导入拆帧流程';
      btn.className = 'primary';
      btn.addEventListener('click', async function () {
        setBusy(true);
        try {
          status('正在下载生成视频…');
          const resp = await fetch('/api/gen/video?job=' + jobId + '&video=' + encodeURIComponent(name), { headers: gateAuth() });
          if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
          await importFile(await resp.blob());
        } catch (e) {
          status('导入生成视频失败:' + e.message, true);
        } finally {
          setBusy(false);
        }
      });
      row.appendChild(info);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  async function genStart() {
    if (gen.busy) return;
    if (!gateGuard('生视频')) return;
    if (!gen.refDataUrl) { status('生视频:请先选择首帧图。', true); return; }
    if (!$('#genPrompt').value.trim()) { status('生视频:请填写运动提示词。', true); return; }
    gen.busy = true;
    $('#genStartBtn').disabled = true;
    $('#genBatchBtn').disabled = true;
    genLogShow('提交生成任务…');
    const payload = genPayload(false);
    try {
      const r = await genApi(payload);
      if (!r.ok) throw new Error(r.error || '未知错误');
      status('生成任务已提交(' + r.jobId + '),约 5 分钟/条,期间可继续手动流程。');
      const done = await pollJob(r.jobId, function (s) {
        genLogShow('已运行 ' + s.elapsedSec + 's(' + Math.round(s.elapsedSec / 60 * 10) / 10 + ' 分钟)\n' + s.tail);
      });
      renderResultRow(payload.name, r.jobId, done.videos, done.winner);
      status('生视频完成:' + (done.videos || []).join(', ') + (done.winner ? ' | $' + (+done.winner.cost).toFixed(2) + ' 循环PSNR ' + done.winner.finalLoopPsnr + 'dB' : ''));
    } catch (e) {
      status('生视频失败:' + e.message, true);
      genLogShow('失败:' + e.message);
    } finally {
      gen.busy = false;
      $('#genStartBtn').disabled = false;
      $('#genBatchBtn').disabled = false;
    }
  }

  // 一键生成战斗五件套:五条动作视频按顺序提交(串行,避免并发挤兑 API),
  // 单条失败跳过继续;完成后逐条在结果区给「→ 导入拆帧流程」入口
  async function genBatch() {
    if (gen.busy) return;
    if (!gateGuard('一键生成')) return;
    if (!gen.refDataUrl) { status('一键生成:请先选择首帧图(角色定稿图)。', true); return; }
    gen.busy = true;
    gen.batchStop = false;
    $('#genStartBtn').disabled = true;
    const batchBtn = $('#genBatchBtn');
    batchBtn.textContent = '⏹ 停止批量(当前条完成后停)';
    genLogShow('=== 一键生成战斗五件套:约 ' + battleTemplates.length * 5 + ' 分钟 ===');
    const t0 = Date.now();
    try {
      for (const t of battleTemplates) {
        if (gen.batchStop) { genLogShow('[批量] 已停止,未开始的动作不再提交。'); break; }
        const payload = genPayload(false);
        payload.prompt = t.prompt;
        payload.loop = t.loop;
        payload.name = state.charId + '_' + t.key;
        genLogShow('[' + t.label + '] 提交…');
        try {
          const r = await genApi(payload);
          if (!r.ok) throw new Error(r.error || '未知错误');
          const done = await pollJob(r.jobId, function (s) {
            genLogShow('[' + t.label + '] 已运行 ' + Math.round(s.elapsedSec / 60 * 10) / 10 + ' 分钟\n' + s.tail);
          });
          renderResultRow(t.label, r.jobId, done.videos, done.winner);
          genLogShow('[' + t.label + '] 完成:' + (done.videos || []).join(', '));
          status('一键生成:『' + t.label + '』完成,累计 ' + Math.round((Date.now() - t0) / 60000) + ' 分钟。');
        } catch (e) {
          genLogShow('[' + t.label + '] 失败:' + e.message + '(跳过,继续下一个)');
          status('一键生成:『' + t.label + '』失败已跳过。', true);
        }
      }
    } finally {
      gen.busy = false;
      gen.batchStop = false;
      $('#genStartBtn').disabled = false;
      batchBtn.textContent = '⚔ 一键生成战斗五件套';
      genLogShow('=== 批量结束,总耗时 ' + Math.round((Date.now() - t0) / 60000) + ' 分钟;逐条「→ 导入拆帧流程」并添加动画 ===');
    }
  }

  Object.assign(window.FSApp, {
    exportSpritesheet: exportSpritesheet,
    exportFramesZip: exportFramesZip,
    exportSpineZip: exportSpineZip,
    genDryRun: genDryRun,
    genStart: genStart,
  });
  window.FSApp.importFile = importFile;
  window.FSApp.keyAll = keyAll;
  window.FSApp.detectLoops = detectLoops;
  window.FSApp.addLoopFromSelection = addLoopFromSelection;
  window.FSApp.computeBBox = computeBBox;
  window.FSApp.autoDrop = autoDrop;
  window.FSApp.exportSpineData = async function () {
    const loops = exportLoops();
    return FS.exportSpine(state.charId, loops, state.bbox, state.exportScale, state.maxWidth);
  };

  // ---------- 绑定 UI ----------
  function bind() {
    $('#importBtn').addEventListener('click', function () { $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function (e) {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#rekeyBtn').addEventListener('click', keyAll);
    $('#keyMode').addEventListener('change', function () { state.key.mode = $('#keyMode').value; updateKeySwatch(); });
    $('#keyTol').addEventListener('input', function () { state.key.tol = parseFloat($('#keyTol').value); $('#keyTolVal').textContent = state.key.tol.toFixed(2); });
    $('#keySpill').addEventListener('input', function () { state.key.spill = parseFloat($('#keySpill').value); $('#keySpillVal').textContent = state.key.spill.toFixed(2); });
    $('#keyEdges').addEventListener('change', function () { state.key.edges = $('#keyEdges').checked; });
    $('#edgeMode').addEventListener('change', function () { state.key.edgeMode = $('#edgeMode').value; });
    $('#sliceBtn').addEventListener('click', function () { $('#sliceInput').click(); });
    $('#sliceInput').addEventListener('change', function (e) {
      if (e.target.files[0]) importImageSlices(e.target.files[0]);
      e.target.value = '';
    });
    $('#pngCompress').addEventListener('change', function () { state.compress.mode = $('#pngCompress').value; });
    $('#dedupeFrames').addEventListener('change', function () { state.dedupe.frames = $('#dedupeFrames').checked; });
    $('#dedupePerceptual').addEventListener('change', function () { state.dedupe.perceptual = $('#dedupePerceptual').checked; });
    $('#dedupePhashThr').addEventListener('change', function () { state.dedupe.phashThr = FS.clamp(parseInt($('#dedupePhashThr').value) || 0, 0, 20); });
    $('#wandTol').addEventListener('input', function () { state.brush.tol = parseFloat($('#wandTol').value); $('#wandTolVal').textContent = state.brush.tol.toFixed(2); });
    $('#charId').addEventListener('change', function () { state.charId = FS.sanitizeName($('#charId').value, 'hero_v01'); $('#charId').value = state.charId; });
    $('#detectBtn').addEventListener('click', detectLoops);
    $('#selStart').addEventListener('change', function () { state.selection.start = FS.clamp(parseInt($('#selStart').value) || 0, 0, state.frames.length - 1); });
    $('#selEnd').addEventListener('change', function () { state.selection.end = FS.clamp(parseInt($('#selEnd').value) || 0, 0, state.frames.length - 1); });
    $('#addLoopBtn').addEventListener('click', addLoopFromSelection);
    $('#autoDropBtn').addEventListener('click', autoDrop);
    $('#dedupeThr').addEventListener('input', function () { state.dedupeThreshold = parseFloat($('#dedupeThr').value); $('#dedupeThrVal').textContent = state.dedupeThreshold; });
    $('#playBtn').addEventListener('click', function () { state.playing ? stopPreview() : startPreview(); });
    $('#brushMode').addEventListener('change', function () { state.brush.mode = $('#brushMode').value; });
    $('#brushR').addEventListener('input', function () { state.brush.r = parseFloat($('#brushR').value); $('#brushRVal').textContent = state.brush.r; });
    $('#undoStroke').addEventListener('click', function () {
      const f = state.frames[state.currentFrame];
      if (!f || !f.strokes.length) return;
      f.strokes.pop();
      FS.applyKey(f, state.key);
      drawCenter();
    });
    $('#clearStrokes').addEventListener('click', function () {
      const f = state.frames[state.currentFrame];
      if (!f) return;
      f.strokes = [];
      FS.applyKey(f, state.key);
      drawCenter();
    });
    $('#showBBox').addEventListener('change', function () { state.showBBox = $('#showBBox').checked; drawCenter(); });
    $('#recomputeBBox').addEventListener('click', function () { computeBBox(); status('对齐框:' + (state.bbox ? ('x' + state.bbox.x + ' y' + state.bbox.y + ' ' + state.bbox.w + '×' + state.bbox.h) : '无内容')); drawCenter(); });
    $('#exportScale').addEventListener('input', function () { state.exportScale = parseFloat($('#exportScale').value) || 1; $('#exportScaleVal').textContent = state.exportScale; });
    $('#btnSheet').addEventListener('click', exportSpritesheet);
    $('#btnFrames').addEventListener('click', exportFramesZip);
    $('#btnSpine').addEventListener('click', exportSpineZip);
    $('#genRefBtn').addEventListener('click', function () { $('#genRefInput').click(); });
    $('#genRefInput').addEventListener('change', function (e) {
      if (e.target.files[0]) genRefFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#genDryBtn').addEventListener('click', genDryRun);
    $('#genStartBtn').addEventListener('click', genStart);
    $('#genBatchBtn').addEventListener('click', function () {
      if (gen.busy) { gen.batchStop = true; status('将在当前条完成后停止批量,未开始的动作不再提交。'); return; }
      genBatch();
    });
    $('#genTemplate').addEventListener('change', function () {
      const t = battleTemplates.find(function (x) { return x.key === $('#genTemplate').value; });
      if (!t) return;
      $('#genPrompt').value = t.prompt;
      $('#genLoop').value = t.loop;
      status('已填入「' + t.label + '」运动提示词,可再手改;循环模式已设为 ' + t.loop + '。');
    });
    bindBrush();
    updateKeySwatch();
    drawCenter();
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
