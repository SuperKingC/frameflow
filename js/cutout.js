// FrameFlow - 抠图工具页(独立):上传 → 选模型版本 → 开始处理 → 修边 → 透明底下载
// 全部走服务端 AI 抠图(matting_worker 五模型);画笔/魔棒修边复用 pipeline.js,按记录重放
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const MODEL_DESC = {
    ben2: '通用全自动单主体抠图,质量与速度均衡,默认首选。',
    briaai: '适合前景和背景区分明显的图片,速度快。',
    inspyrenet: '适合前景和背景?较强的图片,如人物发丝等精细内容抠除,速度慢。',
    u2net: '对质量要求不极致、更在意速度和轻量的场景。',
    'isnet-anime': '动漫插画、二次元角色、手绘风格图片的抠图。',
  };
  MODEL_DESC.inspyrenet = '适合前景和背景层级较强的图片,如人物发丝等精细内容抠除,速度慢。';

  const st = {
    frame: null,          // {orig, proc, strokes}
    name: '',
    matting: false,       // 是否已做过模型抠图(未处理时 proc 就是原图)
    brush: { mode: 'erase', r: 20, tol: 0.15 },
    trim: false,          // 贴边剪裁:下载时裁掉透明边
  };
  let painting = null;
  let busy = false;

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function load(file) {
    if (!file || !/^image\//.test(file.type)) { status('请选择图片文件(PNG/JPEG/WebP)。', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      const orig = document.createElement('canvas');
      orig.width = img.naturalWidth;
      orig.height = img.naturalHeight;
      orig.getContext('2d').drawImage(img, 0, 0);
      const proc = document.createElement('canvas');
      proc.width = orig.width; proc.height = orig.height;
      proc.getContext('2d', { willReadFrequently: true }).drawImage(orig, 0, 0);
      st.frame = { id: 0, orig: orig, proc: proc, strokes: [], clean: null };
      st.name = file.name.replace(/\.[^.]+$/, '');
      st.matting = false;
      $('#cutInfo').textContent = file.name + ' · ' + orig.width + '×' + orig.height;
      $('#dlPng').disabled = true;
      $('#dlWebp').disabled = true;
      URL.revokeObjectURL(url);
      drawView();
      status('图片已加载,点「开始处理」抠图。');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      status('图片无法解码:' + file.name, true);
    };
    img.src = url;
  }

  function drawView() {
    const view = $('#view');
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    const f = st.frame;
    if (!f) {
      ctx.fillStyle = '#6d727d';
      ctx.font = '14px sans-serif';
      ctx.fillText('把图片拖到这里,或点左侧「选择图片」', 24, 40);
      return;
    }
    const k = Math.min(view.width / f.proc.width, view.height / f.proc.height) * 0.98;
    const w = f.proc.width * k, h = f.proc.height * k;
    drawChecker(ctx, view.width, view.height, 12);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(f.proc, (view.width - w) / 2, (view.height - h) / 2, w, h);
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

  function viewToFrame(e) {
    const view = $('#view');
    const rect = view.getBoundingClientRect();
    const f = st.frame;
    if (!f) return null;
    const k = Math.min(view.width / f.proc.width, view.height / f.proc.height) * 0.98;
    const x = Math.round((e.clientX - rect.left) * (view.width / rect.width) - (view.width - f.proc.width * k) / 2) / k;
    const y = Math.round((e.clientY - rect.top) * (view.height / rect.height) - (view.height - f.proc.height * k) / 2) / k;
    if (x < 0 || y < 0 || x >= f.proc.width || y >= f.proc.height) return null;
    return [Math.round(x), Math.round(y)];
  }

  function bindBrush() {
    const view = $('#view');
    view.addEventListener('pointerdown', function (e) {
      if (!st.frame) return;
      const p = viewToFrame(e);
      if (!p) return;
      if (st.brush.mode === 'wand') {
        const stroke = { mode: 'wand', tol: st.brush.tol, pts: [p] };
        const n = FS.wandRemove(st.frame, p[0], p[1], st.brush.tol);
        st.frame.strokes.push(stroke);
        drawView();
        status('魔棒清除了 ' + n + ' 个像素。');
        return;
      }
      view.setPointerCapture(e.pointerId);
      painting = { mode: st.brush.mode, r: st.brush.r, pts: [p] };
      FS.applyStroke(st.frame, { mode: painting.mode, r: painting.r, pts: painting.pts });
      drawView();
    });
    view.addEventListener('pointermove', function (e) {
      if (!painting) return;
      const p = viewToFrame(e);
      if (!p) return;
      const last = painting.pts[painting.pts.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < painting.r / 2) return;
      painting.pts.push(p);
      FS.applyStroke(st.frame, { mode: painting.mode, r: painting.r, pts: [p] });
      drawView();
    });
    view.addEventListener('pointerup', function () {
      if (!painting) return;
      st.frame.strokes.push(painting);
      painting = null;
    });
  }

  // ---------- 模型抠图 ----------
  async function matting() {
    if (!st.frame || busy) return;
    busy = true;
    const btn = $('#runBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '⏳ 处理中…';
    try {
      const b64 = await FS.blobToBase64(await FS.canvasToBlobPng(st.frame.orig));
      const resp = await fetch('/api/matting/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
        body: JSON.stringify({ image: 'data:image/png;base64,' + b64, model: $('#matModel').value }),
      });
      const r = await resp.json();
      if (!r.ok) throw new Error(r.error ? FS.gateError(r.error) : 'HTTP ' + resp.status);
      const img = new Image();
      await new Promise(function (resolve, reject) {
        img.onload = resolve;
        img.onerror = function () { reject(new Error('结果解码失败')); };
        img.src = r.image;
      });
      const proc = st.frame.proc;
      const ctx = proc.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, proc.width, proc.height);
      ctx.drawImage(img, 0, 0);
      // 干净副本:撤销/清空修边时回到这个状态再重放剩余画笔
      const clean = document.createElement('canvas');
      clean.width = proc.width; clean.height = proc.height;
      clean.getContext('2d').drawImage(proc, 0, 0);
      st.frame.clean = clean;
      st.matting = true;
      // 修边记录跨版本保留:新基底上按记录重放,与「撤销/清空按记录重放」语义一致
      st.frame.strokes.forEach(function (s) { FS.applyStroke(st.frame, s); });
      drawView();
      $('#dlPng').disabled = false;
      $('#dlWebp').disabled = false;
      status('抠图完成(' + r.model + ',' + r.seconds + 's,半透明边缘 ' + r.edgePx + ' px)。可用画笔/魔棒修边后下载。');
    } catch (e) {
      status('抠图失败:' + e.message, true);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function download(kind) {
    if (!st.frame || !st.matting) return;
    let c = st.frame.proc;
    if (st.trim) {
      const bbox = FS.contentBBoxOf(c);
      if (bbox) {
        const t = document.createElement('canvas');
        t.width = bbox.w; t.height = bbox.h;
        t.getContext('2d').drawImage(c, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
        c = t;
      }
    }
    const suffix = st.trim ? '_cutout_trim' : '_cutout';
    if (kind === 'png') {
      FS.downloadBlob(await FS.canvasToBlobPng(c), st.name + suffix + '.png');
      status('透明 PNG 已下载。');
    } else {
      FS.downloadBlob(await FS.canvasToBlobWebp(c, 0.9), st.name + suffix + '.webp');
      status('透明 WebP 已下载(q90,有损)。');
    }
  }

  function bind() {
    $('#cutBtn').addEventListener('click', function () { $('#cutInput').click(); });
    $('#cutInput').addEventListener('change', function (e) {
      if (e.target.files[0]) load(e.target.files[0]);
      e.target.value = '';
    });
    // 拖拽到画布
    const view = $('#view');
    view.addEventListener('dragover', function (e) { e.preventDefault(); });
    view.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
    });
    $('#matModel').addEventListener('change', function () {
      const v = $('#matModel').value;
      $('#modelDesc').textContent = MODEL_DESC[v] || '';
    });
    $('#modelDesc').textContent = MODEL_DESC[$('#matModel').value] || '';
    $('#trimToggle').addEventListener('change', function () { st.trim = $('#trimToggle').checked; });
    $('#runBtn').addEventListener('click', matting);
    $('#brushMode').addEventListener('change', function () { st.brush.mode = $('#brushMode').value; });
    $('#brushR').addEventListener('input', function () { st.brush.r = parseFloat($('#brushR').value); $('#brushRVal').textContent = st.brush.r; });
    $('#wandTol').addEventListener('input', function () { st.brush.tol = parseFloat($('#wandTol').value); $('#wandTolVal').textContent = st.brush.tol.toFixed(2); });
    $('#undoStroke').addEventListener('click', function () {
      if (!st.frame || !st.frame.strokes.length) return;
      st.frame.strokes.pop();
      replayForUndo();
      drawView();
    });
    $('#clearStrokes').addEventListener('click', function () {
      if (!st.frame) return;
      st.frame.strokes = [];
      replayForUndo();
    });
    $('#dlPng').addEventListener('click', function () { download('png'); });
    $('#dlWebp').addEventListener('click', function () { download('webp'); });
    bindBrush();
    drawView();
  }

  // 修边重放:回到模型抠图刚出图的状态(clean 干净副本),再重放剩余画笔记录
  function replayForUndo() {
    if (!st.frame || !st.matting) return;
    if (st.frame.clean) {
      const ctx = st.frame.proc.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, st.frame.proc.width, st.frame.proc.height);
      ctx.drawImage(st.frame.clean, 0, 0);
      st.frame.strokes.forEach(function (s) { FS.applyStroke(st.frame, s); });
    }
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
