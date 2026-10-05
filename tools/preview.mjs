// 見比べ用の画像を作る道具(配布しない。mod 本体は読み込まない)。
// 端末で見える絵と同じ点(半角ブロック 1 マス = 上下 2 点)を、1 点 = scale×scale の四角で PNG にする。
//
//   node tools/preview.mjs --out <dir> [--size L|S] [--solo [--dancer 0-4]] [--beats -4,0,0.5,...] [--cols 8] [--scale 4] [--gif]
//
//   --solo … 1 体だけ(ふつうは真ん中の 1 体)を大きく。参考動画と見比べるとき用
//   --dancer N … --solo で描く人(画面の左から 0〜4。その人だけ違う動きの区間も、その人の動きで描く。絵は王冠つき)
//
//   sheet.png  … 指定した拍(既定: 1 周の各カウント)のコマを、拍の番号つきで並べた一覧
//   inmu-king.gif … --gif のとき 1 周ぶん(60 ms ごと)。ffmpeg が要る
//
// 依存なし(PNG は node の zlib で書く)。出力先は作業用の一時フォルダにする(リポジトリに画像を溜めない)。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { NONE } from '../hooks/clawd.js'
import { BPM, LOOP_BEATS, LOOP_START, countAt, poseAt, posesAt, wrapBeat } from '../hooks/choreo.js'
import { layoutFor, stagePixels } from '../hooks/stage.js'

const BG = 0x1e1e1e // 端末の地の色(暗いテーマ)
const INK = 0xd0d0d0
const FRAME_MS = 60
const WIDTH = { L: 130, S: 80 } // 本体の幅(この幅で layoutFor が選ぶ大きさになる)

function parseArgs(argv) {
  const a = { size: 'L', cols: 8, scale: 4, gif: false, solo: false, dancer: undefined, out: '', beats: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--out') a.out = v()
    else if (k === '--size') a.size = v()
    else if (k === '--cols') a.cols = Number(v())
    else if (k === '--scale') a.scale = Number(v())
    else if (k === '--beats') a.beats = v().split(',').map(Number)
    else if (k === '--gif') a.gif = true
    else if (k === '--solo') a.solo = true
    else if (k === '--dancer') a.dancer = Number(v())
    else throw new Error(`知らない引数: ${k}`)
  }
  if (!a.out) throw new Error('--out <dir> が要る')
  if (!(a.size in WIDTH)) throw new Error('--size は L か S')
  if (a.beats && a.beats.some((b) => !Number.isFinite(b))) throw new Error('--beats は数の並び')
  if (a.dancer !== undefined && !(a.solo && Number.isInteger(a.dancer) && a.dancer >= 0 && a.dancer <= 4)) throw new Error('--dancer は --solo と一緒に 0〜4')
  return a
}

/** 1 コマ → RGB の点(幅 w × 高さ h)。 */
function frame(beat, layout) {
  const buf = stagePixels(args.dancer === undefined ? posesAt(beat) : poseAt(beat, args.dancer), layout)
  return { w: layout.columns, h: layout.rows * 2, buf }
}

/** 画像(RGB の Uint32Array)。 */
function canvas(w, h, fill = BG) {
  return { w, h, px: new Uint32Array(w * h).fill(fill) }
}

function paste(dst, f, x0, y0, scale) {
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const c = f.buf[y * f.w + x]
      if (c === NONE) continue
      for (let dy = 0; dy < scale; dy++) {
        const row = (y0 + y * scale + dy) * dst.w
        for (let dx = 0; dx < scale; dx++) dst.px[row + x0 + x * scale + dx] = c & 0xffffff
      }
    }
  }
}

// 拍の番号だけ書ければよいので、3×5 の小さな字(数字と - . : b c)を持つ
const GLYPH = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111', '-': '000000111000000', '.': '000000000000010',
  ':': '000010000010000', ' ': '000000000000000', b: '100100111101111', c: '000111100100111',
}

function text(dst, s, x0, y0, k) {
  let x = x0
  for (const ch of s) {
    const g = GLYPH[ch] ?? GLYPH[' ']
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 3; i++) {
        if (g[j * 3 + i] !== '1') continue
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) dst.px[(y0 + j * k + dy) * dst.w + x + i * k + dx] = INK
      }
    }
    x += 4 * k
  }
}

// PNG(8 bit RGB・フィルタなし)
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(img) {
  const raw = Buffer.alloc(img.h * (1 + img.w * 3))
  let o = 0
  for (let y = 0; y < img.h; y++) {
    raw[o++] = 0
    for (let x = 0; x < img.w; x++) {
      const c = img.px[y * img.w + x]
      raw[o++] = (c >> 16) & 0xff
      raw[o++] = (c >> 8) & 0xff
      raw[o++] = c & 0xff
    }
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(img.w, 0)
  head.writeUInt32BE(img.h, 4)
  head[8] = 8
  head[9] = 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 拍の一覧を表にした画像。各コマの上に「b拍 c カウント」。 */
function sheet(beats, layout, cols, scale) {
  const f0 = frame(beats[0], layout)
  const k = Math.max(2, scale - 1)
  const labelH = 5 * k + 2 * k
  const cw = f0.w * scale + 2 * scale
  const ch = f0.h * scale + labelH + 2 * scale
  const rows = Math.ceil(beats.length / cols)
  const img = canvas(cw * cols, ch * rows)
  beats.forEach((beat, i) => {
    const x0 = (i % cols) * cw + scale
    const y0 = Math.floor(i / cols) * ch + scale
    text(img, `b${beat} c${countAt(beat).count}`, x0, y0, k)
    paste(img, frame(beat, layout), x0, y0 + labelH, scale)
    for (let x = (i % cols) * cw; x < (i % cols + 1) * cw; x++) img.px[(Math.floor(i / cols) + 1) * ch * img.w - img.w + x] = 0x444444
  })
  return img
}

function gif(dir, layout, scale) {
  const frames = join(dir, '_gif_frames')
  rmSync(frames, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })
  const msPerBeat = 60000 / BPM
  const n = Math.round((LOOP_BEATS * msPerBeat) / FRAME_MS)
  for (let i = 0; i < n; i++) {
    const beat = wrapBeat(LOOP_START + (i * FRAME_MS) / msPerBeat)
    const f = frame(beat, layout)
    const img = canvas(f.w * scale, f.h * scale)
    paste(img, f, 0, 0, scale)
    writeFileSync(join(frames, `f${String(i).padStart(4, '0')}.png`), png(img))
  }
  const out = join(dir, 'inmu-king.gif')
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-framerate', String(1000 / FRAME_MS), '-i', join(frames, 'f%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=none', '-loop', '0', out,
  ])
  rmSync(frames, { recursive: true, force: true })
  return out
}

const args = parseArgs(process.argv.slice(2))
mkdirSync(args.out, { recursive: true })
const full = layoutFor(WIDTH[args.size], 15)
// 1 体だけ: 舞台を 1 体ぶんの幅にする(stagePixels は dancers 1 なら真ん中 = その 1 体を描く)
const layout = args.solo ? { ...full, dancers: 1, spacing: 0, columns: full.size === 'L' ? 44 : 28 } : full
const beats = args.beats ?? Array.from({ length: LOOP_BEATS }, (_, i) => LOOP_START + i)
const sheetPath = join(args.out, 'sheet.png')
writeFileSync(sheetPath, png(sheet(beats, layout, args.cols, args.scale)))
console.log(sheetPath)
if (args.gif) console.log(gif(args.out, layout, args.scale))
