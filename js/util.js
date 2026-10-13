// FrameSpine - 通用工具:压缩、ZIP、感知哈希、杂项
(function () {
  'use strict';

  const FS = (window.FS = window.FS || {});

  // 邀请码门禁错误码 → 可读文案(页面请求带 FFGate 码,401/403 时展示)
  FS.gateError = function (code) {
    return {
      invalid_invite_code: '邀请码未生效,请回首页重新验证',
      invite_locked: '邀请码错误次数过多,今日已锁定,请明天再试',
      upstream_unavailable: '服务端未设邀请码且当前来源非本机,已拒绝(公网部署需设 GEN_INVITE_CODE)',
    }[code] || code;
  };

  // ---------- 杂项 ----------
  FS.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  FS.sanitizeName = function (s, fallback) {
    s = (s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return s || fallback || 'anim';
  };

  FS.nextEven = function (v) { return v % 2 === 0 ? v : v + 1; };

  FS.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  FS.waitForEvent = function (target, name, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const h = function (e) { if (!done) { done = true; cleanup(); resolve(e); } };
      const cleanup = function () { target.removeEventListener(name, h); };
      target.addEventListener(name, h);
      if (timeoutMs) setTimeout(function () { if (!done) { done = true; cleanup(); resolve(null); } }, timeoutMs);
    });
  };

  FS.makeTextBlob = function (text) {
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  };

  FS.blobToUint8 = async function (blob) {
    return new Uint8Array(await blob.arrayBuffer());
  };

  FS.blobToBase64 = function (blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result.split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('base64 编码失败')); };
      reader.readAsDataURL(blob);
    });
  };

  FS.downloadBlob = function (blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  };

  FS.formatBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  };

  // ---------- CRC32 / ZIP(store 无压缩,PNG 自带压缩已足够) ----------
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
  function writeU16(view, offset, value) { view.setUint16(offset, value, true); }

  // files: [{name, data:Uint8Array}]
  FS.makeZip = function (files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach(function (f) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      writeU32(lv, 0, 0x04034b50);
      writeU16(lv, 4, 20);            // version needed
      writeU16(lv, 6, 0x0800);        // UTF-8 names
      writeU16(lv, 8, 0);             // store
      writeU16(lv, 10, 0); writeU16(lv, 12, 0); // time/date
      writeU32(lv, 14, crc);
      writeU32(lv, 18, f.data.length);
      writeU32(lv, 22, f.data.length);
      writeU16(lv, 26, nameBytes.length);
      writeU16(lv, 28, 0);
      local.set(nameBytes, 30);
      parts.push(local, f.data);
      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      writeU32(cv, 0, 0x02014b50);
      writeU16(cv, 4, 20); writeU16(cv, 6, 20);
      writeU16(cv, 8, 0x0800);
      writeU16(cv, 10, 0);
      writeU16(cv, 12, 0); writeU16(cv, 14, 0);
      writeU32(cv, 16, crc);
      writeU32(cv, 20, f.data.length);
      writeU32(cv, 24, f.data.length);
      writeU16(cv, 28, nameBytes.length);
      writeU32(cv, 42, offset);
      cen.set(nameBytes, 46);
      central.push(cen);
      offset += local.length + f.data.length;
    });
    let centralSize = 0;
    central.forEach(function (c) { centralSize += c.length; });
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    writeU32(ev, 0, 0x06054b50);
    writeU16(ev, 8, files.length);
    writeU16(ev, 10, files.length);
    writeU32(ev, 12, centralSize);
    writeU32(ev, 16, offset);
    const all = parts.concat(central, [end]);
    let total = 0;
    all.forEach(function (p) { total += p.length; });
    const out = new Uint8Array(total);
    let pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return new Blob([out], { type: 'application/zip' });
  };

  // ---------- 感知哈希(16x16 亮度,256 位) ----------
  FS.phashOfCanvas = function (canvas) {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const gray = new Float32Array(N * N);
    let sum = 0;
    for (let i = 0; i < N * N; i++) {
      const a = d[i * 4 + 3] / 255;
      const lum = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a;
      gray[i] = lum; sum += lum;
    }
    const mean = sum / (N * N);
    // 4 x 64bit 用 4 个 32bit 数字对表示
    const words = new Array(8).fill(0);
    for (let i = 0; i < N * N; i++) {
      if (gray[i] > mean) words[i >> 5] |= (1 << (i & 31)) >>> 0;
    }
    return { words: words, mean: mean };
  };

  FS.phashDistance = function (a, b) {
    let d = 0;
    for (let w = 0; w < 8; w++) {
      let x = (a.words[w] ^ b.words[w]) >>> 0;
      while (x) { d += x & 1; x >>>= 1; }
    }
    return d;
  };

  // ---------- PNG 压缩:调色板量化(中位切分) ----------
  // imgData: ImageData;maxColors: 2..256;dither: Floyd–Steinberg 抖动
  // 只量化 RGB,alpha 保留连续值(抗锯齿边缘不发硬);色数减少后 DEFLATE 体积显著下降
  FS.quantizeImageData = function (imgData, maxColors, dither) {
    const d = imgData.data;
    const N = d.length / 4;
    const samples = [];
    const step = Math.max(1, Math.floor(N / 60000));
    for (let i = 0; i < N; i += step) {
      if (d[i * 4 + 3] > 8) samples.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    }
    if (!samples.length) return imgData;
    const bucketRange = function (b) {
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (const p of b) {
        if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
        if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
        if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
      }
      const rr = rmax - rmin, gr = (gmax - gmin) * 1.2, bb = (bmax - bmin) * 0.8;
      return { range: Math.max(rr, gr, bb), ch: rr >= gr && rr >= bb ? 0 : (gr >= bb ? 1 : 2) };
    };
    let buckets = [samples];
    while (buckets.length < maxColors) {
      let bi = -1, br = -1, bch = 0;
      for (let k = 0; k < buckets.length; k++) {
        if (buckets[k].length < 2) continue;
        const q = bucketRange(buckets[k]);
        if (q.range > br) { br = q.range; bi = k; bch = q.ch; }
      }
      if (bi < 0) break;
      const bucket = buckets[bi];
      bucket.sort(function (a, b) { return a[bch] - b[bch]; });
      const mid = bucket.length >> 1;
      buckets.splice(bi, 1, bucket.slice(0, mid), bucket.slice(mid));
    }
    const palette = buckets.map(function (b) {
      let r = 0, g = 0, bl = 0;
      b.forEach(function (p) { r += p[0]; g += p[1]; bl += p[2]; });
      const n = b.length || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    });
    const cache = new Map();
    const nearest = function (r, g, b) {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let hit = cache.get(key);
      if (hit !== undefined) return hit;
      let best = 0, bd = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const dr = r - palette[k][0], dg = g - palette[k][1], db = b - palette[k][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bd) { bd = dist; best = k; }
      }
      cache.set(key, best);
      return best;
    };
    if (!dither) {
      for (let i = 0; i < N; i++) {
        if (d[i * 4 + 3] <= 8) continue;
        const p = palette[nearest(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])];
        d[i * 4] = p[0]; d[i * 4 + 1] = p[1]; d[i * 4 + 2] = p[2];
      }
      return imgData;
    }
    // Floyd–Steinberg(只扩散 RGB 误差)
    const buf = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      buf[i * 3] = d[i * 4]; buf[i * 3 + 1] = d[i * 4 + 1]; buf[i * 3 + 2] = d[i * 4 + 2];
    }
    const w = imgData.width, h = imgData.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (d[i * 4 + 3] <= 8) continue;
        const o = i * 3;
        const r = FS.clamp(Math.round(buf[o]), 0, 255);
        const g = FS.clamp(Math.round(buf[o + 1]), 0, 255);
        const b = FS.clamp(Math.round(buf[o + 2]), 0, 255);
        const p = palette[nearest(r, g, b)];
        const er = buf[o] - p[0], eg = buf[o + 1] - p[1], eb = buf[o + 2] - p[2];
        d[i * 4] = p[0]; d[i * 4 + 1] = p[1]; d[i * 4 + 2] = p[2];
        const push = function (xx, yy, f) {
          if (xx < 0 || xx >= w || yy >= h) return;
          const q = (yy * w + xx) * 3;
          buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f;
        };
        push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
      }
    }
    return imgData;
  };

  FS.quantizeCanvas = function (canvas, maxColors, dither) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    FS.quantizeImageData(img, maxColors, dither);
    ctx.putImageData(img, 0, 0);
    return canvas;
  };

  FS.canvasToBlobPng = function (canvas) {
    return new Promise(function (r) { canvas.toBlob(r, 'image/png'); });
  };
  FS.canvasToBlobWebp = function (canvas, quality) {
    return new Promise(function (r) { canvas.toBlob(r, 'image/webp', quality); });
  };
})();
