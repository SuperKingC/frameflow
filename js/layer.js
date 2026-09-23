// FrameFlow - 图层分离页(SAM2 点选:正/负点 → 掩码预览 → 收下为图层 → 导出 ZIP)
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const st = {
    canvas: null,        // 原图画布
    name: '',
    points: [],          // {x, y, label:1|0}
    preview: null,       // {maskData: ImageData(L), score, area}
    layers: [],          // {name, canvas(RGBA), area, bbox}
    busy: false,
  };
  const MASK_KEY = 'layermask';
  let imageB64 = null;

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }
  function setBusy(b) { st.busy = b; document.body.classList.toggle('busy', b); }

  function maskColor() { return $('#maskColor').value; }

  // ---------- 加载 ----------
  function load(file) {
    if (!file || !/^image\//.test(file.type)) { status('请选择图片文件。', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      st.canvas = canvas;
      st.name = file.name.replace(/\.[^.]+$/, '');
      st.points = [];
      st.preview = null;
      st.layers = [];
      renderLayers();
      drawView();
      $('#imgInfo').textContent = file.name + ' · ' + canvas.width + '×' + canvas.height;
      URL.revokeObjectURL(url);
      status('已加载。左键点元素本体,Shift/右键点排除区;每次点击自动算掩码。');
    };
    img.onerror = function () { status('图片无法解码:' + file.name, true); };
    img.src = url;
  }

  // ---------- 视图 ----------
  function fit() {
    const view = $('#view');
    const f = st.canvas;
    if (!f) return { k: 1, ox: 0, oy: 0 };
    const k = Math.min(view.width / f.width, view.height / f.height) * 0.98;
    return { k: k, ox: (view.width - f.width * k) / 2, oy: (view.height - f.height * k) / 2 };
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

  function drawView() {
    const view = $('#view');
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    if (!st.canvas) {
      ctx.fillStyle = '#6d727d';
      ctx.font = '14px sans-serif';
      ctx.fillText('拖入设计图,然后用点把每个元素标出来', 24, 40);
      return;
    }
    const { k, ox, oy } = fit();
    ctx.drawImage(st.canvas, ox, oy, st.canvas.width * k, st.canvas.height * k);
    // 掩码叠加
    if (st.preview) {
      const mc = hexToRgb(maskColor());
      const md = st.preview.maskData;
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = 'rgb(' + mc.r + ',' + mc.g + ',' + mc.b + ')';
      const W = st.canvas.width;
      for (let y = 0; y < st.canvas.height; y++) {
        let runStart = -1;
        for (let x = 0; x <= W; x++) {
          const on = x < W && md[y * W + x] > 0;
          if (on && runStart < 0) runStart = x;
          if (!on && runStart >= 0) {
            ctx.fillRect(ox + runStart * k, oy + y * k, (x - runStart) * k + 0.5, k + 0.5);
            runStart = -1;
          }
        }
      }
      ctx.restore();
    }
    // 点
    st.points.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(ox + p.x * k, oy + p.y * k, 5, 0, Math.PI * 2);
      ctx.fillStyle = p.label === 1 ? '#34d399' : '#ff7b6b';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#101215';
      ctx.stroke();
    });
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }

  function viewToImg(e) {
    const view = $('#view');
    const rect = view.getBoundingClientRect();
    const { k, ox, oy } = fit();
    const x = Math.round(((e.clientX - rect.left) * (view.width / rect.width) - ox) / k);
    const y = Math.round(((e.clientY - rect.top) * (view.height / rect.height) - oy) / k);
    if (!st.canvas || x < 0 || y < 0 || x >= st.canvas.width || y >= st.canvas.height) return null;
    return [x, y];
  }

  // ---------- SAM2 分割 ----------
  async function segment() {
    if (!st.canvas || st.busy || !st.points.length) return;
    setBusy(true);
    try {
      if (!imageB64) {
        imageB64 = await FS.blobToBase64(await FS.canvasToBlobPng(st.canvas));
      }
      const resp = await fetch('/api/sam/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: 'data:image/png;base64,' + imageB64,
          points: st.points.map(function (p) { return [p.x, p.y]; }),
          labels: st.points.map(function (p) { return p.label; }),
        }),
      });
      const r = await resp.json();
      if (!r.ok) throw new Error(r.error || 'HTTP ' + resp.status);
      // mask_b64 → 单通道数据
      const maskImg = new Image();
      await new Promise(function (resolve, reject) {
        maskImage.onload = resolve;
        maskImage.onerror = function () { reject(new Error('掩码解码失败')); };
        maskImage.src = 'data:image/png;base64,' + r.mask_b64;
      });
      maskCanvas.width = st.canvas.width;
      maskCanvas.height = st.canvas.height;
      const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
      mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      mctx.drawImage(maskImage, 0, 0);
      const md = mctx.getImageData(0, 0, st.canvas.width, st.canvas.height).data;
      const alpha = new Uint8Array(st.canvas.width * st.canvas.height);
      for (let i = 0; i < st.canvas.width * st.canvas.height; i++) alpha[i] = md[i * 4];
      st.preview = { maskData: alpha, score: r.score, area: r.area };
      $('#keepBtn').disabled = false;
      const warn = r.score < 0.5 ? ' score 较低(' + r.score + '),建议补点。' : '';
      status('掩码已更新 score=' + r.score + ',面积 ' + r.area + ' px。' + warn);
      drawView();
    } catch (e) {
      status('SAM2 分割失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  const maskCanvas = document.createElement('canvas');
  const maskImage = new Image();

  // ---------- 收下图层 ----------
  function keepLayer() {
    if (!st.preview) return;
    const mc = maskCanvas.getContext('2d');
    const md = mc.getImageData(0, 0, st.canvas.width, st.canvas.height).data;
    const layer = document.createElement('canvas');
    layer.width = st.canvas.width;
    layer.height = st.canvas.height;
    const lctx = layer.getContext('2d');
    const out = lctx.createImageData(st.canvas.width, st.canvas.height);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, area = 0;
    const src = st.canvas.getContext('2d').getImageData(0, 0, st.canvas.width, st.canvas.height).data;
    for (let i = 0, n = st.canvas.width * st.canvas.height; i < n; i++) {
      const a = md[i * 4];
      if (a > 0) {
        area++;
        const x = i % st.canvas.width, y = (i / st.canvas.width) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        out.data[i * 4] = src[i * 4];
        out.data[i * 4 + 1] = src[i * 4 + 1];
        out.data[i * 4 + 2] = src[i * 4 + 2];
        out.data[i * 4 + 3] = Math.max(a, 0);
      }
    }
    lctx.putImageData(out, 0, 0);
    const name = '图层' + (st.layers.length + 1);
    st.layers.push({ name: name, canvas: layer, area: area, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
    st.points = [];
    st.preview = null;
    renderLayers();
    drawView();
    $('#keepBtn').disabled = true;
    status('已收下「' + name + '」(' + area + ' px)。继续点下一个元素。');
  }

  // ---------- 图层列表 ----------
  function renderLayers() {
    const box = $('#layerList');
    box.innerHTML = '';
    $('#layerCount').textContent = st.layers.length;
    st.layers.forEach(function (l, i) {
      const row = document.createElement('div');
      row.className = 'row';
      const th = document.createElement('canvas');
      th.width = 40; th.height = 40;
      const tctx = th.getContext('2d');
      drawChecker(tctx, 40, 40, 8);
      const kk = Math.max(l.canvas.width, l.canvas.height);
      tctx.drawImage(l.canvas, 0, 0, kk, kk, 0, 0, 40, 40);
      const name = document.createElement('input');
      name.className = 'txt';
      name.value = l.name;
      name.style.width = '76px';
      name.addEventListener('change', function () { l.name = name.value.trim() || l.name; });
      const up = document.createElement('button');
      up.className = 'btn'; up.textContent = '↑'; up.disabled = i === 0;
      up.addEventListener('click', function () {
        [st.layers[i - 1], st.layers[i]] = [st.layers[i], st.layers[i - 1]];
        renderLayers();
      });
      const down = document.createElement('button');
      down.className = 'btn'; down.textContent = '↓'; down.disabled = i === st.layers.length - 1;
      down.addEventListener('click', function () {
        [st.layers[i], st.layers[i + 1]] = [st.layers[i + 1], st.layers[i]];
        renderLayers();
      });
      const del = document.createElement('button');
      del.className = 'btn'; del.textContent = '✕';
      del.addEventListener('click', function () {
        st.layers.splice(i, 1);
        renderLayers();
      });
      row.appendChild(th);
      row.appendChild(name);
      row.appendChild(up); row.appendChild(down); row.appendChild(del);
      box.appendChild(row);
    });
    $('#dlZip').disabled = !st.layers.length;
    $('#dlOverlay').disabled = !st.layers.length;
    $('#layerCount').textContent = st.layers.length;
  }

  // ---------- 导出 ----------
  async function exportZip() {
    if (!st.layers.length || !st.canvas) return;
    setBusy(true);
    try {
      const files = [];
      st.layers.forEach(function (l, i) {
        files.push({ name: 'layers/' + String(i + 1).padStart(2, '0') + '_' + FS.sanitizeName(l.name, 'layer') + '.png', data: null });
      });
      // canvas → PNG 需逐层编码
      const manifest = {
        format: 'frameflow-layers',
        source: st.name,
        width: st.canvas.width,
        height: st.canvas.height,
        layers: st.layers.map(function (l, i) { return { order: i, name: l.name, file: '', bbox: l.bbox, area: l.area }; }),
      };
      for (let i = 0; i < st.layers.length; i++) {
        const blob = await FS.canvasToBlobPng(st.layers[i].canvas);
        const fname = String(i + 1).padStart(2, '0') + '_' + FS.sanitizeName(st.layers[i].name, 'layer') + '.png';
        st.layers[i].file = fname;
        manifest.layers[i].file = fname;
        files[i] = { name: 'layers/' + fname, data: await FS.blobToUint8(blob) };
      }
      // 叠加预览
      const overlay = document.createElement('canvas');
      overlay.width = st.canvas.width; overlay.height = st.canvas.height;
      const octx = overlay.getContext('2d');
      octx.drawImage(st.canvas, 0, 0);
      st.layers.forEach(function (l, i) {
        octx.globalAlpha = 0.35;
        const hues = ['#22d3ee', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#f87171', '#4ade80', '#60a5fa'];
        const tmp = document.createElement('canvas');
        tmp.width = st.canvas.width; tmp.height = st.canvas.height;
        const tctx = tmp.getContext('2d');
        tctx.drawImage(l.canvas, 0, 0);
        tctx.globalCompositeOperation = 'source-in';
        tctx.fillStyle = hues[i % hues.length];
        tctx.fillRect(0, 0, tmp.width, tmp.height);
        octx.drawImage(tmp, 0, 0);
      });
      octx.globalAlpha = 1;
      files.push({ name: 'overlay_preview.png', data: await FS.blobToUint8(await FS.canvasToBlobPng(overlay)) });
      files.push({ name: 'manifest.json', data: await FS.blobToUint8(FS.makeTextBlob(JSON.stringify(manifest, null, 2))) });
      FS.downloadBlob(FS.makeZip(files), st.name + '_layers.zip');
      status('已导出 ' + st.layers.length + ' 个图层 ZIP。');
    } catch (e) {
      status('导出失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  function exportOverlay() {
    const view = $('#view');
    const c = document.createElement('canvas');
    c.width = st.canvas.width; c.height = st.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(st.canvas, 0, 0);
    // 简版预览:当前掩码叠加
    if (st.preview) {
      const mc = hexToRgb(maskColor());
      const md = st.preview.maskData;
      const im = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < st.canvas.width * st.canvas.height; i++) {
        if (md[i] > 0) {
          im.data[i * 4] = im.data[i * 4] * 0.5 + mc.r * 0.5;
          im.data[i * 4 + 1] = im.data[i * 4 + 1] * 0.5 + mc.g * 0.5;
          im.data[i * 4 + 2] = im.data[i * 4 + 2] * 0.5 + mc.b * 0.5;
        }
      }
      ctx.putImageData(im, 0, 0);
    }
    c.toBlob(function (b) { FS.downloadBlob(b, st.name + '_mask_preview.png'); }, 'image/png');
  }

  // ---------- 绑定 ----------
  function viewPoint(e) {
    const view = $('#view');
    const rect = view.getBoundingClientRect();
    const { k, ox, oy } = fit();
    const x = Math.round(((e.clientX - rect.left) * (view.width / rect.width) - ox) / k);
    const y = Math.round(((e.clientY - rect.top) * (view.height / rect.height) - oy) / k);
    if (!st.canvas || x < 0 || y < 0 || x >= st.canvas.width || y >= st.canvas.height) return null;
    return [x, y];
  }

  function bind() {
    $('#imgBtn').addEventListener('click', function () { $('#imgInput').click(); });
    $('#imgInput').addEventListener('change', function (e) {
      if (e.target.files[0]) load(e.target.files[0]);
      e.target.value = '';
    });
    const view = $('#view');
    view.addEventListener('dragover', function (e) { e.preventDefault(); });
    view.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
    });
    view.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    view.addEventListener('pointerdown', function (e) {
      const p = viewPoint(e);
      if (!p) return;
      const label = (e.shiftKey || e.button === 2) ? 0 : 1;
      if (st.busy) return;
      st.points.push({ x: p[0], y: p[1], label: label });
      drawView();
      segment();
    });
    $('#clearPts').addEventListener('click', function () {
      st.points = [];
      st.preview = null;
      $('#keepBtn').disabled = true;
      drawView();
    });
    $('#keepBtn').addEventListener('click', keepLayer);
    $('#dlZip').addEventListener('click', exportZip);
    $('#dlOverlay').addEventListener('click', exportOverlay);
    $('#maskColor').addEventListener('input', drawView);
    drawView();
  }

  document.addEventListener('DOMContentLoaded', bind);
})();