// FrameSpine - 处理管线:视频拆帧 / 键控抠图 / 画笔修擦 / 对齐 / 循环检测 / 减帧
(function () {
  'use strict';

  const FS = (window.FS = window.FS || {});

  // ---------- 视频拆帧 ----------
  // file: Blob; fps: 每秒抽帧数; maxFrames: 上限
  FS.extractFrames = async function (file, fps, maxFrames, onProgress) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    try {
      await FS.waitForEvent(video, 'loadedmetadata', 15000);
      if (!video.videoWidth) throw new Error('无法读取视频画面(编码可能不受支持)');
      // 等待首帧真实可绘制,否则 t=0 时 drawImage 会得到黑帧
      if (video.readyState < 2) {
        await FS.waitForEvent(video, 'loadeddata', 8000);
      }
      if (video.readyState < 2) throw new Error('视频首帧未能就绪');
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('无法读取视频时长');
      const n = Math.min(maxFrames, Math.max(1, Math.ceil(dur * fps)));
      const frames = [];
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < n; i++) {
        const t = Math.min(dur - 0.001, i / fps);
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const orig = document.createElement('canvas');
        orig.width = canvas.width; orig.height = canvas.height;
        orig.getContext('2d').drawImage(canvas, 0, 0);
        const proc = document.createElement('canvas');
        proc.width = canvas.width; proc.height = canvas.height;
        proc.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0);
        frames.push({
          id: i,
          orig: orig,          // 原始画面(恢复画笔的数据源)
          proc: proc,          // 处理后画面(键控+画笔)
          strokes: [],         // 画笔记录
          dropped: false,      // 减帧剔除标记
          hash: null,
        });
        if (onProgress && i % 5 === 0) onProgress(i + 1, n);
      }
      if (onProgress) onProgress(n, n);
      return { frames: frames, videoW: video.videoWidth, videoH: video.videoHeight, duration: dur };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  };

  function seekTo(video, t) {
    return new Promise(function (resolve) {
      if (Math.abs(video.currentTime - t) < 1e-4) return resolve();
      let done = false;
      const finish = function () {
        if (done) return; done = true;
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        resolve();
      };
      const onSeeked = function () { finish(); };
      video.addEventListener('seeked', onSeeked);
      const timer = setTimeout(finish, 400);
      video.currentTime = t;
    });
  }

  // ---------- 键控抠图 ----------
  // key: {mode:'green'|'white'|'black'|'custom', color:[r,g,b], tol:0..1, spill:0..1, edges:boolean}
  // edges=true 时,额外从画面四边做连通泛洪清除(适合非绿幕但背景均匀的素材)
  FS.applyKey = function (frame, key) {
    const src = frame.orig.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, frame.orig.width, frame.orig.height);
    const out = frame.proc.getContext('2d', { willReadFrequently: true });
    const img = out.createImageData(src.width, src.height);
    img.data.set(src.data);
    const d = img.data;
    const kr = key.color[0], kg = key.color[1], kb = key.color[2];
    const tol = key.tol, soft = Math.max(0.02, key.tol * 0.6);
    const N = src.width * src.height;
    const dist = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      const dr = (r - kr) / 255, dg = (g - kg) / 255, db = (b - kb) / 255;
      dist[i] = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
    }
    let mask = null;
    if (key.edges) {
      // 从边缘泛洪:背景连通区域清除,避免误伤角色身上的同色区域
      mask = new Uint8Array(N);
      const w = src.width, h = src.height;
      const stack = [];
      for (let x = 0; x < w; x++) { stack.push(x, x + (h - 1) * w); }
      for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
      for (let k = 0; k < stack.length; k++) {
        const p = stack[k];
        if (!mask[p] && dist[p] < tol) { mask[p] = 1; stack.push(p - 1, p + 1, p - w, p + w); }
      }
      // 边界像素的邻居越界时是安全的:mask 越界访问返回 undefined
    }
    const spillStrength = key.spill;
    for (let i = 0; i < N; i++) {
      let a;
      if (key.edges) {
        if (mask[i]) a = 0;
        else if (dist[i] < tol) a = 255;        // 泛洪模式下,非连通的同色区域保留
        else if (dist[i] < tol + soft) a = ((dist[i] - tol) / soft * 255) | 0;
        else a = 255;
      } else {
        if (dist[i] < tol) a = 0;
        else if (dist[i] < tol + soft) a = ((dist[i] - tol) / soft * 255) | 0;
        else a = 255;
      }
      if (a < 255) {
        // 溢出抑制:把键色分量压向相邻分量(标准绿幕去绿边)
        if (spillStrength > 0) {
          const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
          if (kg > kr && kg > kb) {
            const m = Math.max(r, b);
            d[i * 4 + 1] = g + (m - g) * spillStrength * (1 - a / 255) | 0;
          } else if (kr > kg && kr > kb) {
            const m = Math.max(g, b);
            d[i * 4] = r + (m - r) * spillStrength * (1 - a / 255) | 0;
          } else if (kb > kr && kb > kg) {
            const m = Math.max(r, g);
            d[i * 4 + 2] = b + (m - b) * spillStrength * (1 - a / 255) | 0;
          }
        }
      }
      d[i * 4 + 3] = a;
    }
    out.putImageData(img, 0, 0);
    replayStrokes(frame);
  };

  // ---------- 画笔修擦 ----------
  // stroke: {mode:'erase'|'restore', r:半径(px), pts:[[x,y],...]}
  // erase: 处理图 alpha 清 0;restore: 从原图复制像素
  FS.applyStroke = function (frame, stroke) {
    const ctx = frame.proc.getContext('2d', { willReadFrequently: true });
    const w = frame.proc.width, h = frame.proc.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const orig = frame.orig.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const r = stroke.r, r2 = r * r;
    stroke.pts.forEach(function (p) {
      const cx = Math.round(p[0]), cy = Math.round(p[1]);
      for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy > r2) continue;
          const i = (y * w + x) * 4;
          if (stroke.mode === 'erase') {
            d[i + 3] = 0;
          } else {
            d[i] = orig[i]; d[i + 1] = orig[i + 1]; d[i + 2] = orig[i + 2]; d[i + 3] = orig[i + 3];
          }
        }
      }
    });
    ctx.putImageData(img, 0, 0);
  };

  function replayStrokes(frame) {
    frame.strokes.forEach(function (s) { FS.applyStroke(frame, s); });
  }

  FS.replayAllStrokes = function (frame) { replayStrokes(frame); };

  // ---------- 对齐框(所有保留帧内容的联合包围盒) ----------
  FS.computeUnionBBox = function (frames) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    frames.forEach(function (f) {
      if (f.dropped) return;
      const ctx = f.proc.getContext('2d', { willReadFrequently: true });
      const w = f.proc.width, h = f.proc.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    });
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };

  // ---------- 循环检测 ----------
  // 基于 16x16 亮度感知哈希:找 d(start, start+len) 小的片段,优先平滑段
  FS.detectLoops = function (frames) {
    const n = frames.length;
    if (n < 6) return [];
    const hashes = frames.map(function (f) { return FS.phashOfCanvas(f.proc); });
    const results = [];
    const minLen = 4, maxLen = Math.min(60, n - 1);
    for (let len = minLen; len <= maxLen; len++) {
      for (let s = 0; s + len < n; s++) {
        const d = FS.phashDistance(hashes[s], hashes[s + len]);
        if (d <= 40) results.push({ start: s, end: s + len - 1, dist: d, len: len });
      }
    }
    results.sort(function (a, b) {
      const sa = a.dist + (a.len < 8 ? 6 : 0);
      const sb = b.dist + (b.len < 8 ? 6 : 0);
      return sa - sb;
    });
    // 贪心去重叠,最多 6 个候选
    const picked = [];
    for (const c of results) {
      if (picked.some(function (p) { return !(c.end < p.start || c.start > p.end); })) continue;
      picked.push(c);
      if (picked.length >= 6) break;
    }
    return picked;
  };

  // ---------- 减帧(自动剔除相邻过近帧) ----------
  FS.autoDrop = function (frames, threshold) {
    let last = null;
    let count = 0;
    frames.forEach(function (f) {
      if (!f.hash) f.hash = FS.phashOfCanvas(f.proc);
      if (last && FS.phashDistance(last.hash, f.hash) <= threshold) {
        f.dropped = true;
        count++;
      } else {
        f.dropped = false;
        last = f;
      }
    });
    return count;
  };
})();
