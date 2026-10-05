// 5 体の Clawd(1 体ずつ違うポーズも取れる)を横に並べた舞台を、端末の半角ブロックのセル(Raster の cells)にする純関数。
// 1 マス = 上の点と下の点。上だけ = ▀、下だけ = ▄、同じ色 = █、違う色 = ▀(文字色 = 上・背景色 = 下)。
import { COLOR, DEFAULT, NONE, sprite, standHeight } from './clawd.js'

export const DANCERS = 5
export const MAX_COLUMNS = 512 // Raster の上限

const SPACE = 0x20
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const FULL = 0x2588 // █

/** 絵の大きさごとに欲しい段数(床の段を含む)。 */
export const WANTED_ROWS = { L: 14, S: 11 }
/** 舞台の下に残す行: カウント 1 行+字幕 1 行。 */
export const FOOTER_ROWS = 2

/**
 * ペインの本体の幅と高さから、絵の大きさ・人数・並べる間隔・Raster の大きさを決める。
 * Raster は舞台の幅だけ(ペインいっぱいにはしない): 1 コマのデータを小さく保つ。
 * 広いときは大きい絵の間隔を 23〜27 桁で空け、狭いときは小さい絵(間隔 10〜15 桁)→ 3 体 → 1 体(王冠の 1 体はいつも真ん中)。
 * 高さが分かれば段数を収め(下の FOOTER_ROWS 行はカウントと字幕に残す)、上(手の先や王冠)から切れる。足と床は必ず残す。
 */
export function layoutFor(bodyColumns, bodyRows) {
  const avail = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(Number(bodyColumns) || 0) || 1))
  let size, dancers, spacing, margin
  if (avail >= 120) {
    // 腕を横に伸ばすと 22 桁ではとなりの胴に届く。余裕があれば 27 桁まで空ける
    size = 'L'; dancers = DANCERS; margin = 14
    spacing = Math.max(23, Math.min(27, Math.floor((avail - 2 * margin) / (dancers - 1))))
  } else {
    size = 'S'
    dancers = avail >= 60 ? DANCERS : avail >= 40 ? 3 : 1
    // 1 体は寄せる先がないので、いちばん横に広いポーズ(王冠つきで 22 桁)が収まる 24 桁を取る
    margin = dancers > 1 ? 10 : 12
    spacing = dancers > 1 ? Math.max(10, Math.min(15, Math.floor((avail - 2 * margin) / (dancers - 1)))) : 0
  }
  const columns = Math.min(avail, spacing * (dancers - 1) + 2 * margin)
  const wanted = WANTED_ROWS[size]
  // 高さが分かっていれば収める(下の行はカウントと字幕に使う。最低 1 段 = 床と足先)。分からなければ欲しい段数
  const known = Math.floor(Number(bodyRows) || 0)
  const rows = known > 0 ? Math.max(1, Math.min(wanted, known - FOOTER_ROWS)) : wanted
  return { size, dancers, columns, rows, spacing }
}

/** 床の高さ(点)。いちばん下の段の下半分。 */
const floorY = (rows) => rows * 2 - 1

/**
 * 1 コマぶんの点の並び(幅 columns × 高さ rows*2)を作る。
 * poses は 5 体ぶんのポーズ(画面の左から。choreo.js の posesAt)か、全員そろった 1 つのポーズ。
 * 3 体・1 体のときは真ん中の 3 体・1 体のポーズを使う(王冠の 1 体はいつも真ん中)。
 * pose.body.dx / dy は背丈に対する割合: dx は横移動、dy < 0 は跳び上がり(dy > 0 の沈み込みは脚の縮みで表す)。
 */
export function stagePixels(poses, layout) {
  const { size, dancers, columns, rows, spacing } = layout
  const w = columns
  const h = rows * 2
  const buf = new Int32Array(w * h).fill(NONE)
  const fy = floorY(rows)
  for (let x = 0; x < w; x++) buf[fy * w + x] = COLOR.floor

  const unit = standHeight(size)
  const left = Math.round(w / 2 - (spacing * (dancers - 1)) / 2)
  const center = (dancers - 1) / 2 // 王冠をかぶるのは真ん中の 1 体
  const skip = (DANCERS - dancers) / 2 // 3 体・1 体のときに飛ばす端の人数
  const sprites = new Map() // 同じポーズ(同じ物)の絵は 1 度だけ描く
  for (let d = 0; d < dancers; d++) {
    const pose = Array.isArray(poses) ? poses[d + skip] ?? poses[0] : poses
    const crown = d === center
    let byPose = sprites.get(pose)
    if (!byPose) sprites.set(pose, (byPose = {}))
    const kind = crown ? 'king' : 'plain'
    if (!byPose[kind]) byPose[kind] = sprite(pose, size, crown ? { crown: true } : undefined)
    const sp = byPose[kind]
    const body = pose.body ?? {}
    const shiftX = Math.round(num(body.dx) * unit)
    const lean = Math.abs(((num(body.tilt) % 360) + 540) % 360 - 180) // 直立からの傾き 0〜180
    // 跳び上がりは直立に近いときだけ(逆立ちの dy は姿勢の説明で、宙に浮かせない)
    const jump = lean < 90 ? Math.max(0, Math.round(-num(body.dy) * unit)) : 0
    // 舞台の端からはみ出す手足は切らずに、その 1 体を内側へ寄せる(端の余白は狭いので、大きく振ったときだけ寄る)
    const cx = Math.max(-sp.left, Math.min(w - 1 - sp.right, left + d * spacing + shiftX))
    const baseY = fy - 1 - jump - sp.ground // 原点(腰)の位置: 接地の段が床のすぐ上に来る
    blitSprite(buf, w, h, sp, cx, baseY)
  }
  return buf
}

function blitSprite(buf, w, h, sp, cx, cy) {
  const n = sp.size
  for (let j = 0; j < n; j++) {
    const y = cy + j - sp.origin
    if (y < 0 || y >= h - 1) continue // 床の段(最下段の下半分)には描かない
    for (let i = 0; i < n; i++) {
      const c = sp.px[j * n + i]
      if (c === NONE) continue
      const x = cx + i - sp.origin
      if (x < 0 || x >= w) continue
      buf[y * w + x] = c
    }
  }
}

/** 点の並び → Raster の cells(base64)。 */
export function encodeCells(buf, columns, rows) {
  const bytes = new Uint8Array(columns * rows * 12)
  const view = new DataView(bytes.buffer)
  let o = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = buf[2 * r * columns + c]
      const bot = buf[(2 * r + 1) * columns + c]
      let cp = SPACE
      let fg = DEFAULT
      let bg = DEFAULT
      if (top !== NONE && bot !== NONE) {
        if (top === bot) { cp = FULL; fg = top } else { cp = UPPER; fg = top; bg = bot }
      } else if (top !== NONE) {
        cp = UPPER; fg = top
      } else if (bot !== NONE) {
        cp = LOWER; fg = bot
      }
      view.setUint32(o, cp, true)
      view.setUint32(o + 4, fg, true)
      view.setUint32(o + 8, bg, true)
      o += 12
    }
  }
  return base64(bytes)
}

/** 1 コマを描いて cells にする(poses は stagePixels と同じ)。 */
export function frameCells(poses, layout) {
  return encodeCells(stagePixels(poses, layout), layout.columns, layout.rows)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 標準の base64(= で埋める)。実行環境に btoa や toBase64 があるとは限らないので自前で持つ。 */
export function base64(bytes) {
  const out = []
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out.push(B64[(v >> 18) & 63], B64[(v >> 12) & 63], B64[(v >> 6) & 63], B64[v & 63])
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const v = bytes[i] << 16
    out.push(B64[(v >> 18) & 63], B64[(v >> 12) & 63], '==')
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out.push(B64[(v >> 18) & 63], B64[(v >> 12) & 63], B64[(v >> 6) & 63], '=')
  }
  return out.join('')
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
