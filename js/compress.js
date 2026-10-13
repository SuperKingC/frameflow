// FrameFlow - 图片压缩工具页(独立工具)
// 只保留 TinyPNG 在线压缩(经本地服务器代理,色彩不变)。
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
      $('#compSize').textContent = '点「TinyPNG 在线压缩」';
      $('#origSize').textContent = fmt(st.origBytes) + ' · ' + canvas.width + '×' + canvas.height;
      URL.revokeObjectURL(url);
      status(st.name + ' 已加载(' + fmt(st.origBytes) + ')。点「TinyPNG 在线压缩」开始。');
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
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
        body: JSON.stringify({ image: 'data:image/png;base64,' + await FS.blobToBase64(blob) }),
      });
      const r = await resp.json();
      if (!r.ok) throw new Error(r.error ? FS.gateError(r.error) : 'HTTP ' + resp.status);
      const outBlob = await (await fetch(r.image)).blob();
      addResult('tinypng', 'TinyPNG', outBlob, st.name + '_tiny.png');
      status('TinyPNG 完成:' + fmt(r.inputBytes) + ' → ' + fmt(r.outputBytes) + (r.note ? '(' + r.note + ')' : ''));
    } catch (e) {
      status('TinyPNG 压缩失败:' + e.message, true);
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
  }

  document.addEventListener('DOMContentLoaded', bind);
})();