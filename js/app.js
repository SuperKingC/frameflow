// FrameSpine - 应用状态与 UI 接线
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const state = {
    frames: [],
    videoInfo: null,
    loops: [],
    selection: { start: 0, end: 0 },
    charId: 'hero_v01',
    key: { mode: 'green', color: [0, 255, 70], tol: 0.3, spill: 0.7, edges: false },
    dedupeThreshold: 2,
    exportScale: 1,
    maxWidth: 2048,
    showBBox: false,
    bbox: null,
    brush: { mode: 'erase', r: 18 },
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
      state.loops = [];
      state.bbox = null;
      const result = await FS.extractFrames(file, fps, 400, function (i, n) {
        progress('拆帧中 ' + i + '/' + n);
      });
      state.frames = result.frames;
      state.videoInfo = result;
      state.selection = { start: 0, end: Math.max(0, result.frames.length - 1) };
      $('#videoInfo').textContent = result.videoW + '×' + result.videoH + ' · ' + result.duration.toFixed(2) + 's · ' + result.frames.length + ' 帧 @' + fps + 'fps';
      status('拆帧完成,正在抠图…');
      await keyAll();
      status('完成。点击色块可重新取键色;拖动"容差"后点【重新抠图】。');
      renderAll();
    } catch (e) {
      status('导入失败:' + e.message, true);
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
    playPos = s;
    state.playing = true;
    playTimer = setInterval(function () {
      drawCenter(state.frames[playPos]);
      highlightThumb(playPos);
      playPos++;
      if (playPos > e) playPos = s;
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
      view.setPointerCapture(e.pointerId);
      painting = { mode: state.brush.mode, r: state.brush.r, pts: [p] };
      const f = state.frames[state.currentFrame];
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
    const r = await FS.exportSpritesheet(loops, state.bbox, state.exportScale, state.maxWidth);
    FS.downloadBlob(r.pngBlob, state.charId + '_sheet.png');
    FS.downloadBlob(FS.makeTextBlob(r.metaText), state.charId + '_sheet_meta.json');
    status('已导出精灵图集 ' + r.width + '×' + r.height + '(PNG+描述文件)。');
  }

  async function exportFramesZip() {
    const loops = exportLoops();
    const zip = await FS.exportFramesZip(state.charId, loops, state.bbox, state.exportScale);
    FS.downloadBlob(zip, state.charId + '_frames.zip');
    status('已导出序列帧 ZIP。');
  }

  async function exportSpineZip() {
    const loops = exportLoops();
    const r = await FS.exportSpine(state.charId, loops, state.bbox, state.exportScale, state.maxWidth);
    const zip = await FS.exportSpineZip(r, state.charId);
    FS.downloadBlob(zip, state.charId + '_spine.zip');
    status('已导出 Spine 三件套 ZIP:' + state.charId + '.json / .atlas.txt / .png + meta.json。');
  }

  // ---------- 生视频(桥接 miniapp-kit anim/gen.mjs) ----------
  const gen = { refDataUrl: null, refName: '', jobId: null, pollTimer: null, busy: false };

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.json();
  }

  function genLogShow(text) {
    const box = $('#genLog');
    box.hidden = false;
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  }

  async function genDryRun() {
    if (gen.busy) return;
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

  function genPoll() {
    if (!gen.jobId) return;
    fetch('/api/gen/status?job=' + gen.jobId)
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { status('生视频任务查询失败:' + r.error, true); stopGenPoll(); return; }
        genLogShow('已运行 ' + r.elapsedSec + 's(' + Math.round(r.elapsedSec / 60 * 10) / 10 + ' 分钟)\n' + r.tail);
        if (r.state === 'done') {
          stopGenPoll();
          renderGenResults(r);
          status('生视频完成:' + (r.videos || []).join(', ') + (r.winner ? ' | $' + (+r.winner.cost).toFixed(2) + ' 循环PSNR ' + r.winner.finalLoopPsnr + 'dB' : ''));
        } else if (r.state === 'error') {
          stopGenPoll();
          status('生视频失败,详见日志。', true);
        }
      })
      .catch(function () { /* 网络抖动,下轮重试 */ });
  }

  function stopGenPoll() {
    if (gen.pollTimer) clearInterval(gen.pollTimer);
    gen.pollTimer = null;
    $('#genStartBtn').disabled = false;
  }

  function renderGenResults(r) {
    const box = $('#genResults');
    box.innerHTML = '';
    (r.videos || []).forEach(function (name) {
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
          const resp = await fetch('/api/gen/video?job=' + gen.jobId + '&video=' + encodeURIComponent(name));
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
    if (gen.busy || gen.pollTimer) return;
    if (!gen.refDataUrl) { status('生视频:请先选择首帧图。', true); return; }
    if (!$('#genPrompt').value.trim()) { status('生视频:请填写运动提示词。', true); return; }
    gen.busy = true;
    $('#genStartBtn').disabled = true;
    genLogShow('提交生成任务…');
    try {
      const r = await genApi(genPayload(false));
      if (!r.ok) throw new Error(r.error || '未知错误');
      gen.jobId = r.jobId;
      status('生成任务已提交(' + gen.jobId + '),约 5 分钟/条,期间可继续手动流程。');
      gen.pollTimer = setInterval(genPoll, 3000);
      genPoll();
    } catch (e) {
      status('生视频提交失败:' + e.message, true);
      genLogShow('提交失败:' + e.message);
      $('#genStartBtn').disabled = false;
    } finally {
      gen.busy = false;
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
    bindBrush();
    updateKeySwatch();
    drawCenter();
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
