// FrameSpine - 导出器:精灵图集 / 序列帧 ZIP / Spine 4.3 三件套(帧换附件时间线)
(function () {
  'use strict';

  const FS = (window.FS = window.FS || {});

  function premultiplyToCanvas(frame, bbox, scale) {
    const w = FS.nextEven(Math.round(bbox.w * scale));
    const h = FS.nextEven(Math.round(bbox.h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame.proc, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, w, h);
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

  // 贪心行排布:margin 2px,尺寸取偶数,防出血
  function packCanvases(entries, maxWidth) {
    const sorted = entries.slice().sort(function (a, b) { return b.canvas.height - a.canvas.height; });
    const margin = 2;
    let width = 0, x = margin, y = margin, rowH = 0;
    const placements = new Map();
    for (const e of sorted) {
      const w = e.canvas.width, h = e.canvas.height;
      if (x + w + margin > maxWidth && rowH > 0) { x = margin; y += rowH + margin; rowH = 0; }
      placements.set(e.key, { x: x, y: y });
      x += w + margin;
      if (h > rowH) rowH = h;
      if (x > width) width = x;
    }
    const height = y + rowH + margin;
    return { placements: placements, width: width, height: height };
  }

  function collectEntries(loops, bbox, scale) {
    // key: loopName#frameIndex; 同名重复循环名会冲突,app 层保证唯一
    const entries = [];
    loops.forEach(function (loop) {
      loop.frames.forEach(function (f, idx) {
        entries.push({
          key: loop.name + '#' + idx,
          name: loop.name + '_f' + String(idx).padStart(2, '0'),
          canvas: premultiplyToCanvas(f, bbox, scale),
        });
      });
    });
    return entries;
  }

  // 压缩选项 compress: {colors: 0=不压缩|64|128|256, dither: bool}
  // 作用于最终 PNG(图集页/雪碧图/序列帧):调色板量化降低色数 → DEFLATE 体积下降
  function maybeQuantize(canvas, compress) {
    if (compress && compress.colors >= 2) {
      return FS.quantizeCanvas(canvas, compress.colors, !!compress.dither);
    }
    return canvas;
  }

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
    const pack = packCanvases(entries, maxWidth);
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
    const pngBlob = await FS.canvasToBlobPng(maybeQuantize(sheet, compress));
    return { pngBlob: pngBlob, metaText: JSON.stringify(meta, null, 2), width: pack.width, height: pack.height };
  };

  // ---------- Spine 4.3 三件套 ----------
  // skeleton: root 骨架; slot "body" 帧换附件时间线; slot "fx" point 锚点(底部中心为原点,y 向上)
  FS.exportSpine = async function (charId, loops, bbox, scale, maxWidth, compress) {
    const entries = collectEntries(loops, bbox, scale);
    const pack = packCanvases(entries, maxWidth);
    const sheet = document.createElement('canvas');
    sheet.width = pack.width; sheet.height = pack.height;
    const ctx = sheet.getContext('2d');
    entries.forEach(function (e) {
      const p = pack.placements.get(e.key);
      ctx.drawImage(e.canvas, p.x, p.y);
    });

    const H = FS.nextEven(Math.round(bbox.h * scale));
    const W = FS.nextEven(Math.round(bbox.w * scale));
    // JSON:attachment 原点在区域底部中心(x=0, y=H/2, Spine y 向上)
    const bodyAttachments = {};
    const animations = {};
    loops.forEach(function (loop) {
      const keys = [];
      const n = loop.frames.length;
      for (let i = 0; i < n; i++) {
        const name = loop.name + '_f' + String(i).padStart(2, '0');
        bodyAttachments[name] = { x: 0, y: H / 2, width: W, height: H };
        keys.push({ time: +(i / loop.fps).toFixed(4), name: name });
      }
      animations[loop.name] = { slots: { body: { attachment: keys } } };
    });
    const skeleton = {
      skeleton: { spine: '4.3.23', hash: '', x: 0, y: 0, width: W, height: H, images: './' },
      bones: [{ name: 'root' }],
      slots: [
        { name: 'body', bone: 'root', attachment: loops[0].name + '_f00' },
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
      '',
    ];
    entries.forEach(function (e) {
      const p = pack.placements.get(e.key);
      lines.push(e.name);
      lines.push('bounds:' + p.x + ',' + p.y + ',' + e.canvas.width + ',' + e.canvas.height);
    });
    const atlasText = lines.join('\n') + '\n';

    const meta = {
      format: 'spine-frame-flipbook',
      spine: '4.3',
      character: charId,
      anchor: 'bottom-center',
      bbox: bbox,
      scale: scale,
      page: { w: pack.width, h: pack.height, pma: true },
      animations: loops.map(function (loop) {
        return { name: loop.name, fps: loop.fps, loop: loop.loop, frames: loop.frames.length, duration: +(loop.frames.length / loop.fps).toFixed(3) };
      }),
      note: '帧换附件时间线;loop 标志由运行时(SpineCharacterAnimator)控制,见 meta.animations.loop',
    };

    const pngBlob = await FS.canvasToBlobPng(maybeQuantize(sheet, compress));
    return {
      jsonText: JSON.stringify(skeleton, null, 1),
      atlasText: atlasText,
      pngBlob: pngBlob,
      metaText: JSON.stringify(meta, null, 2),
      page: { w: pack.width, h: pack.height },
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
        const blob = await FS.canvasToBlobPng(maybeQuantize(c, compress));
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
      { name: 'meta.json', data: await FS.blobToUint8(FS.makeTextBlob(exported.metaText)) },
    ];
    return FS.makeZip(files);
  };
})();
