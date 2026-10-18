// FrameSpine - 导出器:精灵图集 / 序列帧 ZIP / Spine 4.3 三件套(帧换附件时间线;紧包围盒+跨动画去重)
(function () {
  'use strict';

  const FS = (window.FS = window.FS || {});

  function premultiplyToCanvas(canvas, bbox, scale) {
    const w = FS.nextEven(Math.round(bbox.w * scale));
    const h = FS.nextEven(Math.round(bbox.h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, w, h);
    // 预乘 alpha(pma:true,spine-unity SkeletonGraphic 默认材质)
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a !== 255) {
        d[i] = d[i] * a / 255 | 0;
        d[i + 1] = d[i + 1] * a / 255 | 0;
        d[i + 2] = d[i + 2] * a / 255 | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // 二维排布:margin 2px。宽高预算 maxWidth/maxHeight(通常同为上限 16384):
  // 帧尺寸一致时按网格排并取最接近方形的行列组合;异形帧退回按行贪心。超预算标记 overBudget。
  function packCanvases(entries, maxWidth, maxHeight) {
    const margin = 2;
    const sorted = entries.slice().sort(function (a, b) { return b.canvas.height - a.canvas.height; });
    function shelf(maxW) {
      let x = margin, y = margin, rowH = 0, width = margin;
      const placements = new Map();
      for (const e of sorted) {
        const w = e.canvas.width, h = e.canvas.height;
        if (x + w + margin > maxW && rowH > 0) { x = margin; y += rowH + margin; rowH = 0; }
        placements.set(e.key, { x: x, y: y });
        x += w + margin;
        if (h > rowH) rowH = h;
        if (x > width) width = x;
      }
      return { placements: placements, width: width, height: y + rowH + margin };
    }
    if (sorted.length < 2) return shelf(maxWidth);
    const w0 = sorted[0].canvas.width, h0 = sorted[0].canvas.height;
    const uniform = sorted.every(function (e) {
      return Math.abs(e.canvas.width - w0) <= 1 && Math.abs(e.canvas.height - h0) <= 1;
    });
    if (uniform) {
      const colsMax = Math.max(1, Math.floor((maxWidth - margin) / (w0 + margin)));
      let best = null, overBudget = false;
      for (let cols = colsMax; cols >= 1; cols--) {
        const rows = Math.ceil(sorted.length / cols);
        const w = margin + cols * (w0 + margin);
        const h = margin + rows * (h0 + margin);
        if (maxHeight && h > maxHeight) continue;
        if (!best || Math.max(w, h) < Math.max(best.width, best.height)) best = { cols: cols, width: w, height: h };
      }
      if (!best) {
        const rows = Math.ceil(sorted.length / colsMax);
        best = { cols: colsMax, width: margin + colsMax * (w0 + margin), height: margin + rows * (h0 + margin) };
        overBudget = true;
      }
      const placements = new Map();
      sorted.forEach(function (e, i) {
        placements.set(e.key, { x: margin + (i % best.cols) * (w0 + margin), y: margin + Math.floor(i / best.cols) * (h0 + margin) });
      });
      return { placements: placements, width: best.width, height: best.height, overBudget: overBudget };
    }
    const packed = shelf(maxWidth);
    if (maxHeight) packed.overBudget = packed.height > maxHeight;
    return packed;
  }

  // 裁剪区域画布(感知哈希用)
  function cropCanvas(rec) {
    const c = document.createElement('canvas');
    c.width = rec.fb.w; c.height = rec.fb.h;
    c.getContext('2d').drawImage(rec.f.proc, rec.fb.x, rec.fb.y, rec.fb.w, rec.fb.h, 0, 0, rec.fb.w, rec.fb.h);
    return c;
  }

  // PNG 压缩:不压色,走「图片压缩」页同款方案(TinyPNG 在线,经本地服务器代理)。
  // 非 'tinypng' / 服务不可用 → 浏览器直接编码
  FS.compressPng = async function (canvas, mode) {
    if (mode !== 'tinypng') return FS.canvasToBlobPng(canvas);
    const plain = await FS.canvasToBlobPng(canvas);
    try {
      const resp = await fetch('/api/compress/' + mode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + ((window.FFGate && FFGate.code) || '') },
        body: JSON.stringify({ image: 'data:image/png;base64,' + await FS.blobToBase64(plain) }),
      });
      const r = await resp.json();
      if (!r.ok) throw new Error(r.error ? FS.gateError(r.error) : 'HTTP ' + resp.status);
      return await (await fetch(r.image)).blob();
    } catch (e) {
      FS.exportNote = '压缩服务不可用(' + e.message + '),已用浏览器编码';
      return FS.canvasToBlobPng(canvas);
    }
  };

  // ---------- 精灵图集(直通 alpha,通用用途) ----------
  FS.exportSpritesheet = async function (loops, bbox, scale, maxWidth, compress) {
    const entries = [];
    loops.forEach(function (loop) {
      loop.frames.forEach(function (f, idx) {
        const c = document.createElement('canvas');
        const w = FS.nextEven(Math.round(bbox.w * scale));
        const h = FS.nextEven(Math.round(bbox.h * scale));
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(f.proc, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, w, h);
        entries.push({ key: loop.name + '#' + idx, name: loop.name + '_f' + String(idx).padStart(2, '0'), canvas: c });
      });
    });
    const pack = packCanvases(entries, maxWidth, maxWidth);
    const sheet = document.createElement('canvas');
    sheet.width = pack.width; sheet.height = pack.height;
    const ctx = sheet.getContext('2d');
    entries.forEach(function (e) {
      const p = pack.placements.get(e.key);
      ctx.drawImage(e.canvas, p.x, p.y);
    });
    const meta = {
      format: 'spritesheet',
      anchor: 'bottom-center',
      bbox: bbox,
      scale: scale,
      animations: loops.map(function (loop) {
        return {
          name: loop.name, fps: loop.fps, loop: loop.loop, frames: loop.frames.length,
          frameSize: { w: FS.nextEven(Math.round(bbox.w * scale)), h: FS.nextEven(Math.round(bbox.h * scale)) },
        };
      }),
      regions: entries.map(function (e) { return { name: e.name, rect: pack.placements.get(e.key), w: e.canvas.width, h: e.canvas.height }; }),
    };
    const pngBlob = await FS.compressPng(sheet, compress && compress.mode);
    return { pngBlob: pngBlob, metaText: JSON.stringify(meta, null, 2), width: pack.width, height: pack.height, overBudget: pack.overBudget === true };
  };

  // ---------- Spine 4.3 三件套 ----------
  // skeleton: root 骨架; slot "body" 帧换附件时间线; slot "fx" point 锚点(底部中心为原点,y 向上)
  // 每帧裁到自身内容包围盒,位置写入附件 x/y(G = 联合包围盒,锚点 = G 底部中心):
  //   att.x = (F.cx − G.cx)·scale   att.y = (G.bottom − F.cy)·scale   (F=G 时即 x:0, y:H/2)
  // 跨动画去重:像素与位置全等的帧共用一个附件(默认开);感知哈希近似合并可选,
  // 需位置差 ≤2px 且尺寸差 ≤4px,避免把真实位移当成重复。
  FS.exportSpine = async function (charId, loops, bbox, scale, maxWidth, compress, opts) {
    opts = opts || {};
    const dedupeOn = opts.dedupe !== false;
    const perceptual = !!opts.perceptual;
    const phashThr = (opts.phashThr == null ? 8 : FS.clamp(opts.phashThr | 0, 0, 20));

    // 1. 帧记录 + 单帧内容包围盒
    const records = [];
    const loopRecs = new Map();
    loops.forEach(function (loop) {
      const recs = [];
      loop.frames.forEach(function (f, idx) {
        const r = { loop: loop, idx: idx, f: f, fb: FS.contentBBoxOf(f.proc), canonName: null };
        records.push(r);
        recs.push(r);
      });
      loopRecs.set(loop, recs);
    });
    if (!records.length) throw new Error('没有可导出的帧');

    // 2. 全局包围盒 G:调用方 bbox(如有)∪ 所有帧内容
    let G = null;
    const unionRect = function (b) {
      if (!b) return;
      if (!G) { G = { x: b.x, y: b.y, w: b.w, h: b.h }; return; }
      const x2 = Math.max(G.x + G.w, b.x + b.w), y2 = Math.max(G.y + G.h, b.y + b.h);
      G.x = Math.min(G.x, b.x); G.y = Math.min(G.y, b.y);
      G.w = x2 - G.x; G.h = y2 - G.y;
    };
    unionRect(bbox || null);
    records.forEach(function (r) { unionRect(r.fb); });
    if (!G) throw new Error('所有帧都没有内容,请检查抠图');
    // 全透明帧:G 底部中心放 2×2 透明占位(渲染为空,不报错)
    records.forEach(function (r) {
      if (!r.fb) r.fb = { x: G.x + (G.w >> 1) - 1, y: G.y + G.h - 2, w: 2, h: 2 };
    });

    // 3. 去重分组
    const cropBytes = function (r) {
      return r.f.proc.getContext('2d', { willReadFrequently: true })
        .getImageData(r.fb.x, r.fb.y, r.fb.w, r.fb.h).data;
    };
    const sameBytes = function (a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const groups = [];
    if (dedupeOn) {
      // 精确:位置+尺寸+像素字节(FNV-1a 哈希分桶,桶内字节比对兜底碰撞)
      const buckets = new Map();
      records.forEach(function (r) {
        const d = cropBytes(r);
        let h = 0x811c9dc5;
        for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
        const key = r.fb.x + ',' + r.fb.y + ',' + r.fb.w + 'x' + r.fb.h + ':' + h;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      });
      buckets.forEach(function (list) {
        const reps = [];
        list.forEach(function (r) {
          const hit = reps.find(function (p) { return sameBytes(cropBytes(r), cropBytes(p.rep)); });
          if (hit) hit.members.push(r);
          else reps.push({ rep: r, members: [r], phash: null });
        });
        groups.push.apply(groups, reps);
      });
    } else {
      records.forEach(function (r) { groups.push({ rep: r, members: [r], phash: null }); });
    }
    const exactMerged = records.length - groups.length;

    // 感知合并(可选):g 被并入 best 时其 members 必为空(g 尚未被接受过),只需搬 rep
    let canonicals = groups;
    if (perceptual) {
      const accepted = [];
      groups.forEach(function (g) {
        g.phash = FS.phashOfCanvas(cropCanvas(g.rep));
        let best = null, bd = Infinity;
        accepted.forEach(function (a) {
          const p = a.rep.fb, q = g.rep.fb;
          if (Math.abs(p.x - q.x) > 2 || Math.abs(p.y - q.y) > 2) return;
          if (Math.abs(p.w - q.w) > 4 || Math.abs(p.h - q.h) > 4) return;
          const d = FS.phashDistance(a.phash, g.phash);
          if (d < bd) { bd = d; best = a; }
        });
        if (best && bd <= phashThr) best.members.push(g.rep);
        else accepted.push(g);
      });
      canonicals = accepted;
    }
    const perceptualMerged = groups.length - canonicals.length;

    const entryName = function (r) { return r.loop.name + '_f' + String(r.idx).padStart(2, '0'); };
    canonicals.forEach(function (c) {
      c.name = entryName(c.rep);
      c.rep.canonName = c.name;
      c.members.forEach(function (m) { m.canonName = c.name; });
    });

    // 4. 打包图集(仅唯一帧)
    const entries = canonicals.map(function (c) {
      return {
        key: c.name,
        name: c.name,
        rec: c.rep,
        canvas: premultiplyToCanvas(c.rep.f.proc, c.rep.fb, scale),
      };
    });
    const pack = packCanvases(entries, maxWidth, maxWidth);
    const sheet = document.createElement('canvas');
    sheet.width = pack.width; sheet.height = pack.height;
    const ctx = sheet.getContext('2d');
    entries.forEach(function (e) {
      const p = pack.placements.get(e.key);
      ctx.drawImage(e.canvas, p.x, p.y);
    });

    // 5. JSON:附件中心相对锚点偏移;动画时间线引用规范附件名(可跨动画)
    const W = FS.nextEven(Math.round(G.w * scale));
    const H = FS.nextEven(Math.round(G.h * scale));
    const gcx = G.x + G.w / 2, gbottom = G.y + G.h;
    const r2 = function (v) { return Math.round(v * 100) / 100; };
    const bodyAttachments = {};
    entries.forEach(function (e) {
      const fb = e.rec.fb;
      bodyAttachments[e.name] = {
        x: r2((fb.x + fb.w / 2 - gcx) * scale),
        y: r2((gbottom - (fb.y + fb.h / 2)) * scale),
        width: e.canvas.width,
        height: e.canvas.height,
      };
    });
    const animations = {};
    loops.forEach(function (loop) {
      const keys = loopRecs.get(loop).map(function (r, i) {
        return { time: +(i / loop.fps).toFixed(4), name: r.canonName };
      });
      animations[loop.name] = { slots: { body: { attachment: keys } } };
    });
    const firstRecs = loopRecs.get(loops[0]);
    const skeleton = {
      skeleton: { spine: '4.3.23', hash: '', x: 0, y: 0, width: W, height: H, images: './' },
      bones: [{ name: 'root' }],
      slots: [
        { name: 'body', bone: 'root', attachment: firstRecs.length ? firstRecs[0].canonName : null },
        { name: 'fx', bone: 'root', attachment: 'hit_anchor' },
      ],
      skins: [{
        name: 'default',
        attachments: {
          body: bodyAttachments,
          fx: { hit_anchor: { type: 'point', x: 0, y: Math.round(H * 0.55), rotation: 0 } },
        },
      }],
      animations: animations,
    };

    // atlas 文本(4.3 格式,与本地 spine-csharp Atlas 解析器一致)
    const lines = [
      charId + '.png',
      'size:' + pack.width + ',' + pack.height,
      'format:RGBA8888',
      'filter:Linear,Linear',
      'pma:true',
    ];
    entries.forEach(function (e) {
      const p = pack.placements.get(e.key);
      lines.push(e.name);
      lines.push('bounds:' + p.x + ',' + p.y + ',' + e.canvas.width + ',' + e.canvas.height);
    });
    const atlasText = lines.join('\n') + '\n';

    const stats = {
      totalFrames: records.length,
      uniqueFrames: entries.length,
      exactMerged: exactMerged,
      perceptualMerged: perceptualMerged,
      dedupe: dedupeOn,
      perceptual: perceptual,
    };

    const meta = {
      format: 'spine-frame-flipbook',
      spine: '4.3',
      character: charId,
      anchor: 'bottom-center',
      bbox: G,
      scale: scale,
      page: { w: pack.width, h: pack.height, pma: true },
      dedupe: stats,
      animations: loops.map(function (loop) {
        const recs = loopRecs.get(loop);
        return {
          name: loop.name, fps: loop.fps, loop: loop.loop, frames: recs.length,
          duration: +(recs.length / loop.fps).toFixed(3),
          frameMap: recs.map(function (r) { return r.canonName; }),
        };
      }),
      note: '帧换附件时间线;每帧紧包围盒,位置在附件 x/y;跨动画去重后多个动画可引用同一附件;loop 标志由运行时(SpineCharacterAnimator)控制,见 meta.animations.loop',
    };

    const pngBlob = await FS.compressPng(sheet, compress && compress.mode);
    return {
      overBudget: pack.overBudget === true,
      jsonText: JSON.stringify(skeleton, null, 1),
      atlasText: atlasText,
      pngBlob: pngBlob,
      metaText: JSON.stringify(meta, null, 2),
      page: { w: pack.width, h: pack.height },
      stats: stats,
      bbox: G,
    };
  };

  // ---------- 序列帧 ZIP(直通 alpha PNG) ----------
  FS.exportFramesZip = async function (charId, loops, bbox, scale, compress) {
    const files = [];
    for (const loop of loops) {
      for (let i = 0; i < loop.frames.length; i++) {
        const c = document.createElement('canvas');
        c.width = FS.nextEven(Math.round(bbox.w * scale));
        c.height = FS.nextEven(Math.round(bbox.h * scale));
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(loop.frames[i].proc, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, c.width, c.height);
        const blob = await FS.compressPng(c, compress && compress.mode);
        files.push({
          name: charId + '_' + loop.name + '_f' + String(i).padStart(2, '0') + '.png',
          data: await FS.blobToUint8(blob),
        });
      }
    }
    files.push({
      name: 'meta.json',
      data: await FS.blobToUint8(FS.makeTextBlob(JSON.stringify({
        character: charId, bbox: bbox, scale: scale,
        animations: loops.map(function (l) { return { name: l.name, fps: l.fps, loop: l.loop, frames: l.frames.length }; }),
      }, null, 2))),
    });
    return FS.makeZip(files);
  };

  // ---------- Spine 三件套打包 ZIP ----------
  FS.exportSpineZip = async function (exported, charId) {
    const files = [
      { name: charId + '.json', data: await FS.blobToUint8(FS.makeTextBlob(exported.jsonText)) },
      { name: charId + '.atlas.txt', data: await FS.blobToUint8(FS.makeTextBlob(exported.atlasText)) },
      { name: charId + '.png', data: await FS.blobToUint8(exported.pngBlob) },
    ];
    return FS.makeZip(files);
  };
})();
