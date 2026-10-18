// FrameFlow - 图层分离页 v2(SAM2 点选/拖框:一键主体 → 掩码预览 → 收下为图层 → 导出 ZIP)
// v2:一键主体层(BEN2)、box 拖框提示、模型双档(草稿 small/终稿 large)、收层羽化、未覆盖像素自检
(function () {
  'use strict';

  const FS = window.FS;
  const $ = function (sel) { return document.querySelector(sel); };

  const st = {
    canvas: null,        // 原图画布
    name: '',
    points: [],          // {x, y, label:1|0}
    box: null,           // {x0,y0,x1,y1} 拖框提示(与点互斥使用)
    dragging: null,      // 拖框中的实时矩形
    preview: null,       // {maskData: Uint8Array(L), score, area, kind:'points'|'box'}
    layers: [],          // {name, canvas(RGBA), area, bbox, feather}
    busy: false,
    imageId: null,       // /api/sam/load 句柄(点击只传 id,不传整图)
    samModel: localStorage.getItem('layerSamModel') || 'small',
    concepts: [],        // Florence-2 候选实例 [{label,score,bbox}]
    pendingGround: null, // 刚按词拆分的概念词(收层时作为图层名)
  };
  let imageB64 = null; // 兜底:句柄失效时重注册用

  function status(msg, isError) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }
  function setBusy(b) { st.busy = b; document.body.classList.toggle('busy', b); }

  const MASK_TINT = { r: 34, g: 211, b: 238 }; // 预览掩码叠加色(固定青色,与 UI 主色一致)

  // ---------- 加载 ----------
  function load(file) {
    if (!file || !/^image\//.test(file.type)) { status('请选择图片文件。', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      st.canvas = canvas;
      st.name = file.name.replace(/\.[^.]+$/, '');
      st.points = [];
      st.box = null;
      st.dragging = null;
      st.preview = null;
      st.layers = [];
      st.imageId = null;
      imageB64 = null;
      renderLayers();
      drawView();
      $('#imgInfo').textContent = file.name + ' · ' + canvas.width + '×' + canvas.height;
      URL.revokeObjectURL(url);
      status('已加载。拖框或点选元素,SAM2 出精确边界;或先「一键主体层」。');
      // 预注册句柄(后台进行,不阻塞;失败静默,点击时兜底重传)
      registerImage().catch(function () { });
    };
    img.onerror = function () { status('图片无法解码:' + file.name, true); };
    img.src = url;
  }

  async function ensureImageB64() {
    if (!imageB64) imageB64 = await FS.blobToBase64(await FS.canvasToBlobPng(st.canvas));
    return imageB64;
  }

  async function registerImage() {
    if (!st.canvas) return null;
    const b64 = await ensureImageB64();
    const resp = await fetch('/api/sam/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
      body: JSON.stringify({ image: 'data:image/png;base64,' + b64 }),
    });
    const r = await resp.json();
    if (!r.ok) throw new Error(r.error ? FS.gateError(r.error) : 'HTTP ' + resp.status);
    st.imageId = r.imageId;
    return r.imageId;
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
      ctx.fillText('拖入设计图,然后拖框或点选每个元素', 24, 40);
      return;
    }
    const { k, ox, oy } = fit();
    ctx.drawImage(st.canvas, ox, oy, st.canvas.width * k, st.canvas.height * k);
    // 掩码叠加
    if (st.preview) {
      const mc = MASK_TINT;
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
    // 拖框(进行中或已提交)
    const b = st.dragging || st.box;
    if (b) {
      const x0 = ox + b.x0 * k, y0 = oy + b.y0 * k;
      const w = (b.x1 - b.x0) * k, h = (b.y1 - b.y0) * k;
      ctx.save();
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x0, y0, w, h);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.12)';
      ctx.fillRect(x0, y0, w, h);
      ctx.restore();
    }
  }

  function viewPoint(e) {
    const view = $('#view');
    const rect = view.getBoundingClientRect();
    const { k, ox, oy } = fit();
    const x = Math.round(((e.clientX - rect.left) * (view.width / rect.width) - ox) / k);
    const y = Math.round(((e.clientY - rect.top) * (view.height / rect.height) - oy) / k);
    if (!st.canvas || x < 0 || y < 0 || x >= st.canvas.width || y >= st.canvas.height) return null;
    return [x, y];
  }

  // ---------- 工具请求(带鉴权 + 句柄失效自动重注册) ----------
  async function samFetch(path, body) {
    if (!st.imageId) await registerImage();
    body.imageId = st.imageId;
    let resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
      body: JSON.stringify(body),
    });
    let r = await resp.json();
    if (!r.ok && /句柄已失效/.test(r.error || '')) {
      // LRU 淘汰兜底:重新注册再试一次
      await registerImage();
      body.imageId = st.imageId;
      resp = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
        body: JSON.stringify(body),
      });
      r = await resp.json();
    }
    if (!r.ok) throw new Error(r.error ? FS.gateError(r.error) : 'HTTP ' + resp.status);
    return r;
  }

  // ---------- SAM2 分割 ----------
  async function segment() {
    if (!st.canvas || st.busy) return;
    const hasBox = st.box && (st.box.x1 - st.box.x0) > 2 && (st.box.y1 - st.box.y0) > 2;
    if (!st.points.length && !hasBox) return;
    setBusy(true);
    try {
      const body = {
        model: st.samModel,
        points: st.points.map(function (p) { return [p.x, p.y]; }),
        labels: st.points.map(function (p) { return p.label; }),
      };
      if (hasBox) {
        body.box = [st.box.x0, st.box.y0, st.box.x1, st.box.y1];
        body.points = []; // 框提示独立成提示,点集清空(一次手势钉死目标)
      }
      const r = await samFetch('/api/sam/segment', body);
      const alpha = await decodeMask(r.mask_b64);
      st.preview = { maskData: alpha, score: r.score, area: r.area, kind: hasBox ? 'box' : 'points' };
      $('#keepBtn').disabled = false;
      const warn = r.score < 0.5 ? ' score 较低(' + r.score + '),建议精修。' : '';
      status('掩码已更新(' + (hasBox ? '框' : '点') + ') score=' + r.score + ',面积 ' + r.area + ' px。' + warn);
      drawView();
    } catch (e) {
      status('SAM2 分割失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function decodeMask(maskB64) {
    const maskImg = new Image();
    await new Promise(function (resolve, reject) {
      maskImg.onload = resolve;
      maskImg.onerror = function () { reject(new Error('掩码解码失败')); };
      maskImg.src = 'data:image/png;base64,' + maskB64;
    });
    maskCanvas.width = st.canvas.width;
    maskCanvas.height = st.canvas.height;
    const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    mctx.drawImage(maskImg, 0, 0);
    const md = mctx.getImageData(0, 0, st.canvas.width, st.canvas.height).data;
    const alpha = new Uint8Array(st.canvas.width * st.canvas.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = md[i * 4];
    return alpha;
  }

  const maskCanvas = document.createElement('canvas');

  // ---------- 一键主体层(BEN2) ----------
  async function autoSubject() {
    if (!st.canvas || st.busy) return;
    setBusy(true);
    try {
      const b64 = await ensureImageB64();
      const resp = await fetch('/api/matting/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
        body: JSON.stringify({ image: 'data:image/png;base64,' + b64, model: 'ben2' }),
      });
      const r = await resp.json();
      if (!r.ok) throw new Error(r.error ? FS.gateError(r.error) : 'HTTP ' + resp.status);
      const rgba = await decodeRgba(r.image);
      const area = keepFromRgba(rgba, '主体', 0);
      status('已收下一键主体层(BEN2,' + area + ' px)。继续拖框/点选其余元素。');
    } catch (e) {
      status('一键主体失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function decodeRgba(dataUrl) {
    const img = new Image();
    await new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = function () { reject(new Error('抠图结果解码失败')); };
      img.src = dataUrl;
    });
    const c = document.createElement('canvas');
    c.width = st.canvas.width; c.height = st.canvas.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  // ---------- 语义概念拆分(Florence-2 定位 → SAM2 精确掩码) ----------
  async function conceptInstances() {
    if (!st.canvas || st.busy) return;
    setBusy(true);
    try {
      const r = await samFetch('/api/sam/concepts', {});
      renderChips(r.instances || []);
      const n = (r.instances || []).length;
      status(n ? '概念候选 ' + n + ' 个:点 chip 直接按词拆出掩码;也可在下面输入自定义词。'
               : '没拆出候选实例;直接在下面输入概念词(如 主角、猫、招牌),或拖框点选。');
    } catch (e) {
      status('概念候选失败:' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  function renderChips(instances) {
    const box = $('#conceptChips');
    box.innerHTML = '';
    st.concepts = instances.slice();
    if (!instances.length) { box.style.display = 'none'; return; }
    instances.forEach(function (inst, i) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = (inst.label || '实例' + (i + 1)) + (inst.score != null ? ' ·' + Math.round(inst.score * 100) + '%' : '');
      b.title = 'bbox x=' + inst.bbox[0] + ' y=' + inst.bbox[1] + ' w=' + inst.bbox[2] + ' h=' + inst.bbox[3];
      b.addEventListener('click', function () { conceptGround(inst.label); });
      box.appendChild(b);
    });
    box.style.display = 'flex';
  }

  async function conceptGround(phrase) {
    phrase = (phrase || '').trim();
    if (!st.canvas || st.busy || !phrase) return;
    setBusy(true);
    try {
      let query = phrase;
      if (/[\u4e00-\u9fff]/.test(query)) {
        // 语义拆分模型只认英文:中文词先走 LLM 翻译(不可用则退回原词)
        status('「' + phrase + '」翻译成英文中…');
        try {
          const t = await samFetch('/api/sam/translate', { text: query });
          if (t.en) { status('「' + phrase + '」→ "' + t.en + '"'); query = t.en; }
        } catch (e) { /* 翻译不可用,用原词碰运气 */ }
      }
      const r = await samFetch('/api/sam/concepts', { phrase: query });
      const list = r.instances || [];
      if (!list.length) {
        status('没找到「' + phrase + '」对应的元素;换个英文词试试,或直接拖框/点选。', true);
        return;
      }
      const feather = $('#featherToggle').checked ? 2 : 0;
      if (list.length === 1) {
        // 单实例:进预览流程,可继续补点精修,收层时以概念词命名
        const inst = list[0];
        st.box = { x0: inst.bbox[0], y0: inst.bbox[1], x1: inst.bbox[0] + inst.bbox[2] - 1, y1: inst.bbox[1] + inst.bbox[3] - 1 };
        st.points = [];
        st.dragging = null;
        st.pendingGround = phrase;
        drawView();
      } else {
        // 多实例:全部直接拆成图层(先给结果再改错),命名 词-1..N
        let n = 0;
        for (let i = 0; i < list.length; i++) {
          const b = list[i].bbox;
          try {
            const seg = await samFetch('/api/sam/segment', {
              model: st.samModel, points: [], labels: [],
              box: [b[0], b[1], b[0] + b[2] - 1, b[1] + b[3] - 1],
            });
            maskToLayer(await decodeMask(seg.mask_b64), phrase + '-' + (i + 1), feather, phrase);
            n++;
          } catch (e) { /* 单框失败跳过 */ }
        }
        st.points = []; st.box = null; st.dragging = null; st.pendingGround = null;
        status('「' + phrase + '」拆出 ' + n + ' 个实例图层' + (n < list.length ? '(' + (list.length - n) + ' 框分割失败已跳过)' : '') + ';不合适的在图层列表 ✕ 删除。');
        return;
      }
    } catch (e) {
      status('按词拆失败:' + e.message, true);
      return;
    } finally {
      setBusy(false);
    }
    await segment();
    if (st.preview) {
      status('「' + phrase + '」已定位出掩码 score=' + st.preview.score + ',面积 ' + st.preview.area + ' px;满意点「收下」,不满意继续补点。');
    }
  }

  // ---------- 收层 ----------
  function featherAlpha(alpha, w, h, radius) {
    // 盒式模糊近似高斯:横向+纵向两趟,半径 1~2px;把 0/255 硬边变 8→247 渐变
    if (!radius) return alpha;
    let a = alpha;
    for (let pass = 0; pass < 2; pass++) {
      const out = new Uint8Array(a.length);
      const r = radius;
      // 横向
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let s = 0, c = 0;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w) { s += a[row + xx]; c++; }
          }
          out[row + x] = s / c;
        }
      }
      // 纵向
      const out2 = new Uint8Array(a.length);
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          let s = 0, c = 0;
          for (let dy = -r; dy <= r; dy++) {
            const yy = y + dy;
            if (yy >= 0 && yy < h) { s += out[yy * w + x]; c++; }
          }
          out2[y * w + x] = s / c;
        }
      }
      a = out2;
    }
    return a;
  }

  function maskToLayer(alpha, name, featherPx, grounded) {
    // 掩码 → RGBA 图层(核心收层);不碰 points/box/preview,单收与批量拆件共用
    if (featherPx) alpha = featherAlpha(alpha, st.canvas.width, st.canvas.height, featherPx);
    const layer = document.createElement('canvas');
    layer.width = st.canvas.width;
    layer.height = st.canvas.height;
    const lctx = layer.getContext('2d');
    const out = lctx.createImageData(st.canvas.width, st.canvas.height);
    const orig = st.canvas.getContext('2d').getImageData(0, 0, st.canvas.width, st.canvas.height).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, area = 0;
    for (let i = 0, n = alpha.length; i < n; i++) {
      const a = alpha[i];
      if (a > 0) {
        area++;
        const x = i % st.canvas.width, y = (i / st.canvas.width) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        out.data[i * 4] = orig[i * 4];
        out.data[i * 4 + 1] = orig[i * 4 + 1];
        out.data[i * 4 + 2] = orig[i * 4 + 2];
        out.data[i * 4 + 3] = a;
      }
    }
    lctx.putImageData(out, 0, 0);
    st.layers.push({ name: name, canvas: layer, area: area, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, feather: featherPx || 0, grounded: grounded || null });
    renderLayers();
    drawView();
    return st.layers[st.layers.length - 1];
  }

  function keepFromRgba(rgba, name, featherPx) {
    // rgba: ImageData(BEN2 结果);按其 alpha 收层(可选羽化)
    let alpha = new Uint8Array(st.canvas.width * st.canvas.height);
    const src = rgba.data;
    for (let i = 0; i < alpha.length; i++) alpha[i] = src[i * 4 + 3];
    const l = maskToLayer(alpha, name, featherPx, null);
    st.points = []; st.box = null; st.preview = null;
    $('#keepBtn').disabled = true;
    return l.area;
  }

  function keepLayer() {
    if (!st.preview) return;
    const feather = $('#featherToggle').checked ? 2 : 0;
    const name = st.pendingGround || '图层' + (st.layers.length + 1);
    const l = maskToLayer(st.preview.maskData, name, feather, st.pendingGround);
    st.pendingGround = null;
    st.points = []; st.box = null; st.preview = null;
    $('#keepBtn').disabled = true;
    status('已收下「' + l.name + '」(' + l.area + ' px' + (feather ? ',羽化' + feather + 'px' : '') + ')。继续下一个元素。');
  }

  // ---------- 未覆盖像素自检 ----------
  function uncovered() {
    if (!st.canvas || !st.layers.length) { status('先收下至少一个图层。', true); return; }
    const w = st.canvas.width, h = st.canvas.height;
    const cov = new Uint8Array(w * h);
    st.layers.forEach(function (l) {
      const d = l.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] > 8) cov[i] = 1;
    });
    let cnt = 0;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const src = st.canvas.getContext('2d').getImageData(0, 0, w, h);
    for (let i = 0; i < w * h; i++) {
      if (!cov[i]) {
        cnt++;
        // 未覆盖像素以品红高亮,其余压暗
        src.data[i * 4] = (src.data[i * 4] + 255 * 3) / 4;
        src.data[i * 4 + 1] = src.data[i * 4 + 1] / 4;
        src.data[i * 4 + 2] = (src.data[i * 4 + 2] + 255 * 2) / 4;
      } else {
        src.data[i * 4] /= 3; src.data[i * 4 + 1] /= 3; src.data[i * 4 + 2] /= 3;
      }
    }
    ctx.putImageData(src, 0, 0);
    // 新窗口展示
    const win = window.open('', '_blank');
    if (!win) { FS.canvasToBlobPng(c).then(function (b) { FS.downloadBlob(b, st.name + '_uncovered.png'); }); return; }
    win.document.title = '未覆盖像素 ' + cnt + ' px';
    win.document.body.style.margin = '0';
    win.document.body.style.background = '#131417';
    c.toBlob(function (b) {
      const u = URL.createObjectURL(b);
      const im = win.document.createElement('img');
      im.src = u; im.style.maxWidth = '100%';
      win.document.body.appendChild(im);
    }, 'image/png');
    status('未覆盖像素 ' + cnt + ' px' + (cnt === 0 ? ',全部收齐 ✅' : ',已用品红高亮(其余压暗)。可在新窗口查看。'));
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
        [st.layers[i], st.layers[i + 1]] = [st.layers[i], st.layers[i + 1]];
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
    $('#uncoveredBtn').disabled = !st.layers.length;
    $('#layerCount').textContent = st.layers.length;
  }

  // ---------- 导出 ----------
  async function exportZip() {
    if (!st.layers.length || !st.canvas) return;
    setBusy(true);
    try {
      const files = [];
      const manifest = {
        format: 'frameflow-layers',
        version: 2,
        source: st.name,
        width: st.canvas.width,
        height: st.canvas.height,
        samModel: st.samModel,
        layers: st.layers.map(function (l, i) { return { order: i, name: l.name, file: '', bbox: l.bbox, area: l.area, feather: l.feather, grounded: l.grounded || null }; }),
      };
      for (let i = 0; i < st.layers.length; i++) {
        const blob = await FS.canvasToBlobPng(st.layers[i].canvas);
        const fname = String(i + 1).padStart(2, '0') + '_' + FS.sanitizeName(st.layers[i].name, 'layer') + '.png';
        st.layers[i].file = fname;
        manifest.layers[i].file = fname;
        files.push({ name: 'layers/' + fname, data: await FS.blobToUint8(blob) });
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
    const c = document.createElement('canvas');
    c.width = st.canvas.width; c.height = st.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(st.canvas, 0, 0);
    if (st.preview) {
      const mc = MASK_TINT;
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

  // ---------- 交互:点/框 ----------
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
    // 拖框优先:按下后移动>4px 视为拖框,否则视为点选
    let pressPt = null;
    view.addEventListener('pointerdown', function (e) {
      if (st.busy) return;
      const p = viewPoint(e);
      if (!p) return;
      pressPt = { x: p[0], y: p[1], shift: e.shiftKey || e.button === 2, id: e.pointerId };
      view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', function (e) {
      if (!pressPt) return;
      const p = viewPoint(e);
      if (!p) return;
      if (Math.abs(p[0] - pressPt.x) > 4 || Math.abs(p[1] - pressPt.y) > 4) {
        st.dragging = { x0: pressPt.x, y0: pressPt.y, x1: p[0], y1: p[1] };
        drawView();
      }
    });
    view.addEventListener('pointerup', function (e) {
      if (!pressPt) return;
      const p = viewPoint(e);
      const d = st.dragging;
      pressPt = null;
      if (d) {
        st.dragging = null;
        // 归一化四角
        const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
        const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
        if (x1 - x0 > 2 && y1 - y0 > 2) {
          st.box = { x0: x0, y0: y0, x1: x1, y1: y1 };
          st.points = [];
          st.pendingGround = null; // 手动拖框 = 新意图,概念命名失效
          drawView();
          segment();
        } else {
          st.dragging = null;
          drawView();
        }
        return;
      }
      if (!p) return;
      // 点选:正点/负点(Shift 或右键)
      st.points.push({ x: p[0], y: p[1], label: pressShiftOrRight(e) ? 0 : 1 });
      st.box = null;
      st.pendingGround = null; // 手动点选 = 新意图,概念命名失效
      drawView();
      segment();
    });
    function pressShiftOrRight() { return pressPt && pressPt.shift; }
    $('#clearPts').addEventListener('click', function () {
      st.points = [];
      st.box = null;
      st.preview = null;
      $('#keepBtn').disabled = true;
      drawView();
    });
    $('#autoBtn').addEventListener('click', autoSubject);
    $('#conceptBtn').addEventListener('click', conceptInstances);
    $('#phraseGo').addEventListener('click', function () { conceptGround($('#phraseInput').value); });
    $('#phraseInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') conceptGround($('#phraseInput').value); });
    $('#keepBtn').addEventListener('click', keepLayer);
    $('#uncoveredBtn').addEventListener('click', uncovered);
    $('#dlZip').addEventListener('click', exportZip);
    $('#dlOverlay').addEventListener('click', exportOverlay);
    $('#samModel').value = st.samModel;
    $('#samModel').addEventListener('change', function (e) {
      st.samModel = e.target.value;
      localStorage.setItem('layerSamModel', st.samModel);
      // 换档后模型重建,旧句柄图需重新编码:直接让下一次 segment 重传(load_image 带新 model)
      // 句柄仍在,worker 会因 tier 变化自动重编码
      status('已切换模型档位:' + (st.samModel === 'large' ? '终稿 hiera_large' : '草稿 hiera_small') + '(下次分割生效,首图重新编码)。');
    });
    drawView();
    // 模型可用性探测(不拉起 worker)
    fetch('/api/sam/meta', { headers: { authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') } })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) return;
        (r.models || []).forEach(function (m) {
          const opt = $('#samModel').querySelector('option[value="' + m.id + '"]');
          if (opt && !m.available) { opt.disabled = true; opt.textContent = m.label.replace(/\(.*\)/, '(权重未下载)'); }
        });
        // 语义拆件可用 → 显示概念按钮/输入行(默认隐藏,免得没装 Florence-2 时碍事)
        if (r.concepts && r.concepts.available) {
          $('#conceptRow').style.display = '';
          $('#phraseRow').style.display = '';
        }
      }).catch(function () { });
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
