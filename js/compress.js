// FrameFlow - 图片压缩工具页(独立工具)
// 无损优先(色彩不变):TinyPNG 在线(经本地服务器代理)+ 本地无损重压;量化/WebP 为有损选项。
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const st = {
    canvas: null,
    name: '',
    origBytes: 0,
    results: new Map(), // key -> {label, blob, canvas, bytes}
  };
  let busy = false;

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function setBusy(b) {
    busy = b;
    document.body.classList.toggle('busy', b);
  }

  function drawTo(canvas, source) {
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
  }

  function fmt(n) { return FS.formatBytes(n); }

  function showResult(key) {
    const r = st.results.get(key);
    if (!r) return;
    $('#czipEmpty').hidden = true;
    $('#czipCompare').hidden = false;
    drawTo($('#pvOrig'), st.canvas);
    const comp = $('#pvComp');
    if (r.canvas) drawTo(comp, r.canvas);
    else comp.width = 0, comp.height = 0; // 无画布结果(TinyPNG)时保留上次预览
    $('#resultLabel').textContent = r.label;
    $('#compSize').textContent = fmt(r.bytes) + (st.origBytes && r.bytes < st.origBytes
      ? '(-' + Math.round((1 - r.bytes / st.origBytes) * 100) + '%)' : '');
    renderLinks();
    $('#czipCompare').hidden = false;
  }

  function renderLinks() {
    const box = $('#resultLinks');
    box.innerHTML = '';
    st.results.forEach(function (r, key) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '下载:' + r.label + ' ' + fmt(r.bytes);
      btn.addEventListener('click', function () { FS.downloadBlob(r.blob, r.filename); });
      box.appendChild(btn);
    });
  }

  function addResult(key, label, blob, filename, canvas) {
    st.results.set(key, { label: label, blob: blob, filename: filename, canvas: canvas || null, bytes: blob.size });
    renderLinks();
    showResult(key);
  }

  function load(file) {
    if (!file || !/^image\//.test(file.type)) { status('请选择图片文件(PNG/JPEG/WebP)。', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      st.canvas = canvas;
      st.name = file.name.replace(/\.[^.]+$/, '');
      st.origBytes = file.size;
      st.results.clear();
      renderLinks();
      $('#czipEmpty').hidden = true;
      $('#czipCompare').hidden = false;
      drawTo($('#pvOrig'), canvas);
      $('#resultLabel').textContent = '结果';
      $('#compSize').textContent = '选择一种压缩方式';
      $('#origSize').textContent = fmt(st.origBytes) + ' · ' + canvas.width + '×' + canvas.height;
      URL.revokeObjectURL(url);
      status(st.name + ' 已加载(' + fmt(st.origBytes) + ')。推荐先点「TinyPNG 在线压缩」。');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      status('图片无法解码:' + file.name, true);
    };
    img.src = url;
  }

  // TinyPNG 在线(经本地服务器代理,key 不进浏览器)
  async function runTinypng() {
    if (!st.canvas || busy) return;
    setBusy(true);
    status('TinyPNG 压缩中…');
    try {
      const blob = await FS.canvasToBlobPng(st.canvas);
      const resp = await fetch('/api/compress/tinypng', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'data:image/png;base64,' + await FS.blobToBase64(blob) }),
      });
      const r = await resp.json();
      if (!r.ok) throw new Error(r.error || 'HTTP ' + resp.status);
      const outBlob = await (await fetch(r.image)).blob();
      addResult('tinypng', 'TinyPNG', outBlob, st.name + '_tiny.png');
      status('TinyPNG 完成:' + fmt(r.inputBytes) + ' → ' + fmt(r.outputBytes) + (r.note ? '(' + r.note + ')' : ''));
    } catch (e) {
      status('TinyPNG 压缩失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  // 本地无损重压:canvas 重新 PNG 编码,像素 100% 不变
  async function lossless() {
    if (!st.canvas || busy) return;
    setBusy(true);
    try {
      const blob = await FS.canvasToBlobPng(st.canvas);
      addResult('lossless', '本地无损', blob, st.name + '_lossless.png', st.canvas);
      status('本地无损重压完成:' + fmt(st.origBytes) + ' → ' + fmt(blob.size) + '(像素 100% 不变)。');
    } finally {
      setBusy(false);
    }
  }

  // 量化(有损,会改变色彩)
  async function quant() {
    if (!st.canvas || busy) return;
    const colors = parseInt($('#czipColors').value) || 0;
    if (colors < 2) { status('已选择"不量化",请先选一个色数。', true); return; }
    setBusy(true);
    try {
      const work = document.createElement('canvas');
      work.width = st.canvas.width; work.height = st.canvas.height;
      work.getContext('2d').drawImage(st.canvas, 0, 0);
      FS.quantizeCanvas(work, colors, $('#czipDither').checked);
      const blob = await FS.canvasToBlobPng(work);
      addResult('quant', colors + ' 色量化', blob, st.name + '_q' + colors + '.png', work);
      status('量化压缩完成(' + colors + ' 色):' + fmt(st.origBytes) + ' → ' + fmt(blob.size) + '(有损,色彩已改变)。');
    } finally {
      setBusy(false);
    }
  }

  // WebP(有损)
  async function toWebp() {
    if (!st.canvas || busy) return;
    setBusy(true);
    try {
      const q = FS.clamp((parseInt($('#czipWebpQ').value) || 85) / 100, 0.1, 1);
      const blob = await FS.canvasToBlobWebp(st.canvas, q);
      addResult('webp', 'WebP q' + Math.round(q * 100), blob, st.name + '.webp', st.canvas);
      status('WebP 已生成:' + fmt(blob.size) + '(有损,适合通用素材)。');
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    const dz = $('#dropzone');
    dz.addEventListener('click', function () { $('#czipInput').click(); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('over');
      if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
    });
    $('#czipInput').addEventListener('change', function (e) {
      if (e.target.files[0]) load(e.target.files[0]);
      e.target.value = '';
    });
    $('#btnTinypng').addEventListener('click', runTinypng);
    $('#btnLossless').addEventListener('click', lossless);
    $('#btnQuant').addEventListener('click', quant);
    $('#btnWebp').addEventListener('click', toWebp);
  }

  document.addEventListener('DOMContentLoaded', bind);
})();