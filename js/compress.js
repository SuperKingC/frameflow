// FrameFlow - 图片压缩工具页(独立工具,与 Spine 工作流无关)
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const st = { canvas: null, name: '', origBytes: 0, pngBlob: null, webpBlob: null };
  let rerenderTimer = null;

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function drawTo(canvas, source) {
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
  }

  function buildCompressed() {
    const colors = parseInt($('#czipColors').value) || 0;
    const dither = $('#czipDither').checked;
    const work = document.createElement('canvas');
    work.width = st.canvas.width;
    work.height = st.canvas.height;
    work.getContext('2d').drawImage(st.canvas, 0, 0);
    if (colors >= 2) FS.quantizeCanvas(work, colors, dither);
    return work;
  }

  async function render() {
    if (!st.canvas) return;
    const colors = parseInt($('#czipColors').value) || 0;
    const dither = $('#czipDither').checked;
    $('#czipEmpty').hidden = true;
    $('#czipCompare').hidden = false;
    drawTo($('#pvOrig'), st.canvas);
    const work = buildCompressed();
    drawTo($('#pvComp'), work);
    st.pngBlob = await FS.canvasToBlobPng(work);
    st.webpBlob = await FS.canvasToBlobWebp(work, FS.clamp((parseInt($('#czipWebpQ').value) || 85) / 100, 0.1, 1));
    $('#origSize').textContent = FS.formatBytes(st.origBytes);
    const savedPct = st.origBytes && st.pngBlob.size < st.origBytes
      ? '(-' + Math.round((1 - st.pngBlob.size / st.origBytes) * 100) + '%)' : '';
    $('#compSize').textContent = 'PNG ' + FS.formatBytes(st.pngBlob.size) + savedPct + ' · WebP ' + FS.formatBytes(st.webpBlob.size);
    $('#czipPngBtn').disabled = false;
    $('#czipWebpBtn').disabled = false;
    status(st.name + ' · ' + st.canvas.width + '×' + st.canvas.height + ' · 原文件 ' + FS.formatBytes(st.origBytes) + ' → ' +
      (colors >= 2 ? colors + ' 色量化 PNG ' + FS.formatBytes(st.pngBlob.size) : 'PNG ' + FS.formatBytes(st.pngBlob.size)));
  }

  function scheduleRender() {
    if (!st.canvas) return;
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(render, 250);
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
      URL.revokeObjectURL(url);
      render();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      status('图片无法解码:' + file.name, true);
    };
    img.src = url;
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
    $('#czipColors').addEventListener('change', scheduleRender);
    $('#czipDither').addEventListener('change', scheduleRender);
    $('#czipWebpQ').addEventListener('change', scheduleRender);
    $('#czipPngBtn').addEventListener('click', function () {
      if (st.pngBlob) FS.downloadBlob(st.pngBlob, st.name + '_compressed.png');
    });
    $('#czipWebpBtn').addEventListener('click', function () {
      if (st.webpBlob) FS.downloadBlob(st.webpBlob, st.name + '.webp');
    });
  }

  document.addEventListener('DOMContentLoaded', bind);
})();