#!/usr/bin/env node
/**
 * anim/gen.mjs —— 图生视频流水线(L4 生产工具:视频当母带,拆帧做派生)
 *
 * 流程:提示词组装(运动提示词 + 约束尾缀)→ 逐条「创建→轮询→下载」(多候选按首尾帧 PSNR 挑最优,
 *       模型 fallback)→ 循环质检与处理(实测:提示词 seamless loop 不被服从;pingpong 正反循环
 *       40.3dB 完胜,xfade 21.5dB 无效已弃)→ x264 转码瘦身(去音轨+faststart,实测 4.42MB→1.2MB)
 *       → 可选拆帧/雪碧图(--frames,透明叠加 --alpha 逐帧抠像)→ manifest 留痕 + 成本报告。
 *       视频一律走 COS 不进包;首帧用 art/ 定稿图——图管长相,词管动作,提示词只写运动不复述外观。
 *
 * 用法:
 *   node anim/gen.mjs -c anim.config.json -p anims.txt --dry-run    # 先看最终提示词,不花钱
 *   node anim/gen.mjs -c anim.config.json -p anims.txt [--out 目录] [--candidates 2]
 *        [--resolution 720p] [--model 模型ID] [--loop pingpong|raw|off] [--no-keep-master]
 *        [--frames] [--fps 12] [--width 360] [--alpha]
 *
 * anims.txt 每行:`name|首帧图路径|运动提示词`,# 注释。
 * 依赖:ffmpeg/ffprobe(doctor 检查);--alpha 依赖 matting/(chroma 需 cv2,ben2 需权重,极慢)。
 * 密钥只从环境变量/.env 读(config 指定变量名),禁止写入任何文件。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根 .env 自动加载(已 gitignore);进程环境变量优先
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
} catch { /* 无 .env 时跳过 */ }

const VERSION = '0.1.0'
const REF_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const LOOP_PSNR_OK = 30 // 首尾帧 PSNR ≥30dB 视为可直接循环

// ---------- CLI ----------
const argv = process.argv.slice(2)
const opts = { config: 'anim.config.json', prompts: 'anims.txt', loop: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-c') opts.config = argv[++i]
  else if (a === '-p') opts.prompts = argv[++i]
  else if (a === '--out') opts.out = argv[++i]
  else if (a === '--candidates') opts.candidates = Math.max(1, +argv[++i] || 1)
  else if (a === '--resolution') opts.resolution = argv[++i]
  else if (a === '--model') opts.model = argv[++i]
  else if (a === '--loop') opts.loop = argv[++i]
  else if (a === '--frames') opts.frames = true
  else if (a === '--fps') opts.fps = Math.max(1, +argv[++i] || 0)
  else if (a === '--width') opts.width = Math.max(64, +argv[++i] || 0)
  else if (a === '--alpha') opts.alpha = true
  else if (a === '--no-keep-master') opts.noKeepMaster = true
  else if (a === '--dry-run') opts.dryRun = true
  else if (a === '-h' || a === '--help') opts.help = true
}
if (opts.help) {
  console.log('用法: node anim/gen.mjs -c anim.config.json -p anims.txt [--out 目录] [--candidates 2] [--resolution 720p] [--model 模型ID] [--loop pingpong|raw|off] [--frames] [--fps 12] [--width 360] [--alpha] [--no-keep-master] [--dry-run]')
  process.exit(0)
}
function die(msg) { console.error(`[anim] 错误: ${msg}`); process.exit(1) }

// ---------- 配置 ----------
const cfgPath = path.resolve(opts.config)
if (!fs.existsSync(cfgPath)) die(`配置不存在: ${cfgPath}(模板见 anim/anim.config.example.json)`)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
for (const k of ['api']) if (!(k in cfg)) die(`配置缺少必填字段: ${k}`)
if (!Array.isArray(cfg.api.models) || cfg.api.models.length === 0) die('api.models 至少配置一个模型')
const key = process.env[cfg.api.keyEnv || 'CODEX_API_KEY']
if (!key) die(`环境变量 ${cfg.api.keyEnv || 'CODEX_API_KEY'} 未设置`)
const base = cfg.api.baseUrl.replace(/\/+$/, '')
const itemConcurrency = Math.max(1, cfg.api.concurrency ?? 1)

const videoCfg = { resolution: '720p', candidates: 1, pollMs: 4000, timeoutMin: 15, loop: 'pingpong', ...cfg.video }
const transcode = { crf: 24, preset: 'medium', ...cfg.transcode }
const framesCfg = { fps: 12, width: 360, alpha: false, alphaMethod: 'chroma', ...cfg.frames }
const promptCfg = { append: '镜头固定,动作幅度小而柔和,不要镜头切换,不要新增元素', ...cfg.prompt }
const resolution = opts.resolution || videoCfg.resolution
const candidates = opts.candidates || videoCfg.candidates
const loop = opts.loop || videoCfg.loop
if (!['pingpong', 'raw', 'off'].includes(loop)) die(`--loop 只支持 pingpong|raw|off,收到: ${loop}`)
const framesEnabled = opts.frames || opts.alpha
const framesFps = opts.fps || framesCfg.fps
const framesWidth = opts.width || framesCfg.width
const alphaOn = opts.alpha || framesCfg.alpha
const outDir = path.resolve(opts.out || cfg.output?.dir || 'generated/anim')

// ---------- ffmpeg ----------
function run(bin, args, what = '') {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`${what || bin} 执行失败: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${what || bin} 失败: ${(r.stderr || r.stdout || '').slice(-300)}`)
  return r
}
try { run('ffmpeg', ['-version'], 'ffmpeg 可用性检查') } catch (e) { die(`${e.message}\n[anim] 安装 ffmpeg(winget install Gyan.FFmpeg)后重开终端,或先跑 node doctor.mjs`) }

function probeMeta(file) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-show_entries', 'format=duration', '-of', 'json', file], 'ffprobe')
  const j = JSON.parse(r.stdout)
  const s = j.streams?.[0] ?? {}
  const [num, den] = String(s.avg_frame_rate || '24/1').split('/')
  return { width: s.width ?? 0, height: s.height ?? 0, fps: den ? +(num / den).toFixed(2) : 24, durationSec: +(+(j.format?.duration ?? 0)).toFixed(2) }
}

// 循环质检:首帧 vs 末帧 PSNR(dB),≥30 可无缝循环;inf 按 99 计
function psnrLoop(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-loop-'))
  try {
    run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', path.join(tmp, 'first.png')], '抽首帧')
    run('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.1', '-i', file, '-update', '1', '-frames:v', '1', path.join(tmp, 'last.png')], '抽末帧')
    const r = spawnSync('ffmpeg', ['-i', path.join(tmp, 'first.png'), '-i', path.join(tmp, 'last.png'), '-filter_complex', 'psnr', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true })
    const m = (r.stderr || '').match(/average:([\d.]+|inf)/)
    return m ? (m[1] === 'inf' ? 99 : +m[1]) : 0
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// 正反循环:母带去掉尾帧后接自身的倒放,首尾帧天然衔接(实测 40.3dB vs xfade 21.5dB)
function pingpongArgs(master, out) {
  const d = probeMeta(master).durationSec
  const fwdEnd = Math.max(0.5, d - 0.04)
  const filter = `[0:v]split=2[a][b];[a]trim=0:${fwdEnd},setpts=PTS-STARTPTS[fwd];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rev];[fwd][rev]concat=n=2:v=1[v]`
  return ['-v', 'error', '-y', '-i', master, '-filter_complex', filter, '-map', '[v]']
}
const encodeArgs = (out) => ['-an', '-c:v', 'libx264', '-crf', String(transcode.crf), '-preset', transcode.preset, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]

function bumpFilename(dir, base, ext) {
  let name = `${base}.${ext}`, n = 1
  while (fs.existsSync(path.join(dir, name))) { n += 1; name = `${base}_v${n}.${ext}` }
  return name
}

// ---------- 提示词与清单 ----------
function parseAnims() {
  const file = path.resolve(opts.prompts)
  if (!fs.existsSync(file)) die(`提示词文件不存在: ${file}`)
  const items = []
  const seen = new Set()
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length < 3) die(`格式应为 name|首帧图路径|运动提示词: ${line.slice(0, 60)}`)
    const [name, ref, text] = parts
    if (!/^[\w-]+$/.test(name)) die(`名称只允许字母数字_-: ${name}`)
    if (seen.has(name)) die(`提示词名称重复: ${name}`)
    seen.add(name)
    const refPath = path.resolve(ref)
    if (!fs.existsSync(refPath)) die(`首帧图不存在(${name}): ${refPath}`)
    if (!REF_MIME[path.extname(refPath).toLowerCase()]) die(`首帧图只支持 jpg/png/webp(${name}): ${refPath}`)
    items.push({ name, refPath, text })
  }
  if (items.length === 0) die('提示词为空')
  return items
}
const finalPrompt = (text) => promptCfg.append ? `${text}. ${promptCfg.append}` : text

// ---------- 视频接口(创建 → 轮询 → 下载) ----------
async function createJob(model, prompt, refPath) {
  const dataUrl = `data:${REF_MIME[path.extname(refPath).toLowerCase()]};base64,${fs.readFileSync(refPath).toString('base64')}`
  const res = await fetch(`${base}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, prompt, resolution,
      frame_images: [{ type: 'image_url', image_url: { url: dataUrl }, frame_type: 'first_frame' }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`创建失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  const j = JSON.parse(text)
  const jobId = j.id ?? j.jobId ?? j.job_id ?? j.task_id
  if (!jobId) throw new Error(`创建响应无任务 ID: ${text.slice(0, 200)}`)
  return { jobId, response: j }
}

async function pollJob(jobId) {
  const t0 = Date.now()
  for (;;) {
    if (Date.now() - t0 > videoCfg.timeoutMin * 60_000) throw new Error(`轮询超时(${videoCfg.timeoutMin} 分钟)`)
    await new Promise((r) => setTimeout(r, videoCfg.pollMs))
    const res = await fetch(`${base}/videos/${jobId}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`轮询失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    const status = j.status ?? j.state ?? j.data?.status
    process.stdout.write(`  [${Math.round((Date.now() - t0) / 1000)}s] ${status}   \r`)
    if (status === 'completed') { process.stdout.write('\n'); return j }
    if (status === 'failed') { process.stdout.write('\n'); throw new Error(`任务失败: ${JSON.stringify(j.error ?? j).slice(0, 300)}`) }
  }
}

async function downloadVideo(job) {
  const url = job.unsigned_urls?.[0]
  if (url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (r.ok) return Buffer.from(await r.arrayBuffer())
  }
  const r = await fetch(`${base}/videos/${job.id ?? ''}/content`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(300_000) })
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// ---------- 拆帧/雪碧图 ----------
function buildFrames(finalFile, finalBase, rec) {
  const framesDir = path.join(outDir, `${finalBase}_frames`)
  fs.rmSync(framesDir, { recursive: true, force: true })
  fs.mkdirSync(framesDir, { recursive: true })
  run('ffmpeg', ['-v', 'error', '-y', '-i', finalFile, '-vf', `fps=${framesFps},scale=${framesWidth}:-2`, path.join(framesDir, 'f%03d.png')], '拆帧')
  let frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort()
  // 雪碧图网格补齐:tile 会给空槽填黑,复制末帧补位(播放按 count 截断,不会用到)
  const cols = Math.ceil(Math.sqrt(frames.length))
  const rows = Math.ceil(frames.length / cols)
  for (let i = frames.length; i < cols * rows; i++) {
    fs.copyFileSync(path.join(framesDir, frames[frames.length - 1]), path.join(framesDir, `f${String(i + 1).padStart(3, '0')}.png`))
  }
  frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort()

  const sprite = { fps: framesFps, cols, rows, count: frames.length, image: `${finalBase}_sprite.png`, imageAlpha: null }
  const tileArgs = (pattern, out) => ['-v', 'error', '-y', '-i', pattern, '-vf', `tile=${cols}x${rows}`, out]

  if (alphaOn) {
    const py = process.env.PYTHON_MATTING || 'python'
    const method = framesCfg.alphaMethod
    const weights = process.env.BEN2_WEIGHTS
    if (method === 'ben2' && !weights) die('--alpha ben2 需要 BEN2_WEIGHTS 环境变量(doctor 可体检)')
    const mattedDir = path.join(framesDir, 'matted')
    fs.mkdirSync(mattedDir, { recursive: true })
    const mattingScript = fileURLToPath(new URL('../matting/solid_bg_matting.py', import.meta.url))
    for (const f of frames) {
      const args = [mattingScript, path.join(framesDir, f), mattedDir, '--method', method]
      if (method === 'ben2') args.push('--ben2-weights', weights)
      run(py, args, `抠像 ${f}`)
      const stem = f.replace(/\.png$/, '')
      const out = fs.readdirSync(mattedDir).find((x) => x.startsWith(`${stem}_`) && !x.includes('compare'))
      if (!out) throw new Error(`抠像输出未找到: ${stem}_*(目录: ${fs.readdirSync(mattedDir).join(', ').slice(0, 200)})`)
      fs.copyFileSync(path.join(mattedDir, out), path.join(framesDir, `a${f.slice(1)}`)) // a001.png 与 f001.png 对齐
    }
    const alphaOut = path.join(outDir, `${finalBase}_sprite_alpha.png`)
    run('ffmpeg', tileArgs(path.join(framesDir, 'a%03d.png'), alphaOut), '透明雪碧图')
    sprite.imageAlpha = `${finalBase}_sprite_alpha.png`
  }
  const rgbOut = path.join(outDir, sprite.image)
  run('ffmpeg', tileArgs(path.join(framesDir, 'f%03d.png'), rgbOut), '雪碧图')
  const sheet = probeMeta(rgbOut)
  sprite.frameWidth = sheet.width / cols
  sprite.frameHeight = sheet.height / rows
  fs.writeFileSync(path.join(outDir, `${finalBase}_sprite.json`), JSON.stringify({ ...sprite, frameWidth: Math.round(sprite.frameWidth), frameHeight: Math.round(sprite.frameHeight) }, null, 2))
  if (!opts.noKeepMaster) fs.rmSync(framesDir, { recursive: true, force: true }) // 帧目录是中间产物,雪碧图已落盘
  return sprite
}

// ---------- 单条处理 ----------
async function processItem(item) {
  const prompt = finalPrompt(item.text)
  console.log(`\n▶ ${item.name} | ${resolution} × ${candidates} 候选 | loop=${loop}\n  提示词: ${prompt}`)
  const rec = { name: item.name, prompt, resolution, candidates: [], at: new Date().toISOString() }
  let best = null
  for (let k = 1; k <= candidates; k++) {
    const model = opts.model || cfg.api.models[(k - 1) % cfg.api.models.length]
    const t0 = Date.now()
    const cand = { model, seq: k }
    console.log(`  候选 ${k}/${candidates} → ${model}(约 5 分钟/条,$0.84 档)`)
    try {
      const { jobId } = await createJob(model, prompt, item.refPath)
      cand.jobId = jobId
      const job = await pollJob(jobId)
      cand.cost = job.usage?.cost ?? 0
      const buf = await downloadVideo(job)
      const master = path.join(outDir, `${item.name}_c${k}_master.mp4`)
      fs.writeFileSync(master, buf)
      cand.master = path.basename(master)
      cand.bytes = buf.length
      cand.loopPsnr = +psnrLoop(master).toFixed(1)
      cand.elapsedSec = Math.round((Date.now() - t0) / 1000)
      console.log(`  ✓ ${cand.master} ${(buf.length / 1024 / 1024).toFixed(2)}MB loopPSNR=${cand.loopPsnr}dB $${(+cand.cost).toFixed(2)} ${cand.elapsedSec}s`)
      if (!best || cand.loopPsnr > best.loopPsnr) best = { ...cand, masterPath: master }
    } catch (e) {
      cand.error = e.message
      cand.elapsedSec = Math.round((Date.now() - t0) / 1000)
      console.error(`  ✗ 候选 ${k} 失败: ${e.message.slice(0, 260)}`)
    }
    rec.candidates.push(cand)
  }
  if (!best) { rec.error = '全部候选失败'; return rec }

  // 循环处理 + 转码:pingpong 在首尾帧差超标时介入;off 只留母带
  const finalName = bumpFilename(outDir, item.name, 'mp4')
  const finalFile = path.join(outDir, finalName)
  let treatment = 'raw'
  if (loop === 'off') {
    fs.copyFileSync(best.masterPath, finalFile)
    treatment = 'off(未转码)'
  } else if (loop === 'pingpong' && best.loopPsnr < LOOP_PSNR_OK) {
    run('ffmpeg', [...pingpongArgs(best.masterPath, finalFile), ...encodeArgs(finalFile)], '正反循环转码')
    treatment = 'pingpong'
  } else {
    run('ffmpeg', ['-v', 'error', '-y', '-i', best.masterPath, ...encodeArgs(finalFile)], '转码')
  }
  const meta = probeMeta(finalFile)
  const finalPsnr = loop === 'off' ? best.loopPsnr : +psnrLoop(finalFile).toFixed(1)
  rec.winner = {
    file: finalName, master: best.master, model: best.model, cost: best.cost,
    loopPsnr: best.loopPsnr, finalLoopPsnr: finalPsnr, treatment,
    loopOk: finalPsnr >= LOOP_PSNR_OK,
    durationSec: meta.durationSec, width: meta.width, height: meta.height, fps: meta.fps,
    bytes: fs.statSync(finalFile).size,
  }
  if (framesEnabled) rec.frames = buildFrames(finalFile, finalName.replace(/\.mp4$/, ''), rec)
  if (opts.noKeepMaster) for (const c of rec.candidates) if (c.master) fs.rmSync(path.join(outDir, c.master), { force: true })
  return rec
}

// ---------- 主流程 ----------
const items = parseAnims()
fs.mkdirSync(outDir, { recursive: true })
console.log(`[anim] ${items.length} 条 × ${candidates} 候选 | ${resolution} | loop=${loop}${framesEnabled ? ` | 拆帧 ${framesFps}fps/${framesWidth}px${alphaOn ? `/alpha:${framesCfg.alphaMethod}` : ''}` : ''} | 模型: ${cfg.api.models.join(', ')} | 输出: ${outDir}`)
if (opts.dryRun) {
  for (const it of items) console.log(`\n[dry-run] ${it.name}: ${finalPrompt(it.text)}`)
  process.exit(0)
}

const manifestPath = path.join(outDir, 'manifest.json')
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { version: VERSION, items: [] }
manifest.version = VERSION

const queue = [...items]
const records = await Promise.all(Array.from({ length: Math.min(itemConcurrency, queue.length) }, async () => {
  const out = []
  while (queue.length) out.push(await processItem(queue.shift()))
  return out
}))
for (const r of records.flat()) manifest.items.push(r)
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

// 预览页:随产物落一份,preview/serve.mjs 指向输出目录即可看效果
try { fs.copyFileSync(fileURLToPath(new URL('./player.html', import.meta.url)), path.join(outDir, 'player.html')) } catch { /* 缺模板不影响产物 */ }

console.log('\n═══ 生成报告 ═══')
let totalCost = 0
const failed = []
for (const r of manifest.items) {
  totalCost += (r.candidates ?? []).reduce((s, c) => s + (c.cost ?? 0), 0)
  if (r.error) { failed.push(r.name); console.log(`✗ ${r.name}: ${r.error}`); continue }
  const w = r.winner
  const loopNote = w.loopOk ? (w.treatment === 'pingpong' ? `已转正反循环(${w.finalLoopPsnr}dB)` : `可循环(${w.finalLoopPsnr}dB)`) : `不可循环,建议只播一次(${w.finalLoopPsnr}dB)`
  console.log(`${w.file} | ${w.model} | $${(+w.cost).toFixed(2)} | ${w.durationSec}s ${w.width}x${w.height} ${(w.bytes / 1024 / 1024).toFixed(2)}MB | ${loopNote}`)
  if (r.frames) console.log(`  拆帧: ${r.frames.image} ${r.frames.cols}x${r.frames.rows} 格 @${r.frames.fps}fps ${r.frames.frameWidth}x${r.frames.frameHeight}${r.frames.imageAlpha ? ` | 透明版 ${r.frames.imageAlpha}` : ''}(播放配置 ${r.frames.image.replace('.png', '.json')})`)
  console.log(`  提示词: ${r.prompt}`)
}
console.log(`\n[成本] 本次 $${totalCost.toFixed(2)}(候选含失败条目,按接口账单计)`)
const size = fs.readdirSync(outDir, { recursive: true }).reduce((s, f) => { try { return s + fs.statSync(path.join(outDir, f)).size } catch { return s } }, 0)
console.log(`[COS] ${outDir} 共 ${(size / 1024 / 1024).toFixed(2)}MB —— 视频不进包,发版走 cos/ 版本化上传,模拟器预览走 preview/serve.mjs`)
if (failed.length) process.exit(3)
