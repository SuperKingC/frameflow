// FrameFlow - 抠图工具页(独立):单图 → 透明底
// 复用 pipeline.js:FS.applyKey(键色+溢出抑制+边缘泛洪+边缘处理+画笔重放)、FS.wandRemove
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const st = {
    frame: null,          // {orig, proc, strokes}
    name: '',
    key: { mode: 'green', color: [0, 255, 70], tol: 0.3, spill: 0.7, edges: false, edgeMode: 'none' },
    brush: { mode: 'erase', r: 20, tol: 0.15 },
    ready: false,
  };
  let painting = null;

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function keyColorFromMode() {
    if (st.key.mode === 'green') return [0, 255, 70];
    if (st.key.mode === 'white') return [255, 255, 255];
    if (st.key.mode === 'black') return [0, 0, 0];
    return st.key.color;
  }

  function updateSwatch() {
    $('#keySwatch').style.background = 'rgb(' + keyColorFromMode().join(',') + ')';
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
      st.frame = { id: 0, orig: orig, proc: proc, strokes: [] };
      st.name = file.name.replace(/\.[^.]+$/, '');
      $('#cutInfo').textContent = file.name + ' · ' + orig.width + '×' + orig.height;
      $('#dlPng').disabled = false;
      $('#dlWebp').disabled = false;
      URL.revokeObjectURL(url);
      drawView();
      keyAll();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      status('图片无法解码:' + file.name, true);
    };
    img.src = url;
  }

  function keyAll() {
    if (!st.frame) return;
    FS.applyKey(st.frame, st.key);
    drawView();
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

  function pickColorAt(x, y) {
    const d = st.frame.orig.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    st.key.color = [d[0], d[1], d[2]];
    st.key.mode = 'custom';
    $('#keyMode').value = 'custom';
    updateSwatch();
    status('键色已取样 rgb(' + d.join(',') + '),点「抠图」应用。');
  }

  function bindBrush() {
    const view = $('#view');
    view.addEventListener('pointerdown', function (e) {
      if (!st.frame) return;
      const p = viewToFrame(e);
      if (!p) return;
      if (e.altKey) { pickColorAt(p[0], p[1]); return; }
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

  async function download(kind) {
    if (!st.frame) return;
    const c = st.frame.proc;
    if (kind === 'png') {
      FS.downloadBlob(await FS.canvasToBlobPng(c), st.name + '_cutout.png');
      status('透明 PNG 已下载。');
    } else {
      FS.downloadBlob(await FS.canvasToBlobWebp(c, 0.9), st.name + '_cutout.webp');
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
    $('#keyMode').addEventListener('change', function () { st.key.mode = $('#keyMode').value; updateSwatch(); });
    $('#keyTol').addEventListener('input', function () { st.key.tol = parseFloat($('#keyTol').value); $('#keyTolVal').textContent = st.key.tol.toFixed(2); });
    $('#keySpill').addEventListener('input', function () { st.key.spill = parseFloat($('#keySpill').value); $('#keySpillVal').textContent = st.key.spill.toFixed(2); });
    $('#keyEdges').addEventListener('change', function () { st.key.edges = $('#keyEdges').checked; });
    $('#edgeMode').addEventListener('change', function () { st.key.edgeMode = $('#edgeMode').value; });
    $('#keyBtn').addEventListener('click', function () {
      if (!st.frame) { status('请先选择图片。', true); return; }
      keyAll();
      status('抠图完成。边缘不理想可换"边缘处理"再点一次;残余背景用魔棒/擦除修。');
    });
    $('#brushMode').addEventListener('change', function () { st.brush.mode = $('#brushMode').value; });
    $('#brushR').addEventListener('input', function () { st.brush.r = parseFloat($('#brushR').value); $('#brushRVal').textContent = st.brush.r; });
    $('#wandTol').addEventListener('input', function () { st.brush.tol = parseFloat($('#wandTol').value); $('#wandTolVal').textContent = st.brush.tol.toFixed(2); });
    $('#undoStroke').addEventListener('click', function () {
      if (!st.frame || !st.frame.strokes.length) return;
      st.frame.strokes.pop();
      FS.applyKey(st.frame, st.key);
      drawView();
    });
    $('#clearStrokes').addEventListener('click', function () {
      if (!st.frame) return;
      st.frame.strokes = [];
      FS.applyKey(st.frame, st.key);
      drawView();
    });
    $('#dlPng').addEventListener('click', function () { download('png'); });
    $('#dlWebp').addEventListener('click', function () { download('webp'); });
    bindBrush();
    updateSwatch();
    drawView();
  }

  document.addEventListener('DOMContentLoaded', bind);
})();