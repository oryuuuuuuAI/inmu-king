// Clawd(Claude Code のマスコット)をポーズどおりのドット絵にする純関数。
// 時刻・乱数・入出力に触れない。同じポーズと寸法からは、いつも同じ点が出る。
//
// 座標は「点」(1 マス = 横 1 点 × 縦 2 点)。原点は胴の下端の中央(腰)、x は右、y は下が正。
// 角度は度で、0 = 真下、+90 = 外向きの水平(画面左の手足は左へ、右の手足は右へ)、180 = 真上、
// −90 = 内向きの水平。手足の角度は胴に対する角度で、胴の傾き(tilt)ごと全体を回す。

export const DEFAULT = 0x01000000 // 端末の既定色(透明として扱う)
export const NONE = -1 // 点なし

export const COLOR = Object.freeze({
  body: 0xd77757, // Claude のオレンジ
  back: 0xb5603f, // 後ろ向きの胴
  armOver: 0xa85a3f, // 胴の前に重なった腕
  crown: 0xf2c14e, // 王冠
  floor: 0x6b6b6b, // 床
})

// 胴は CLI のロゴ(▐▛███▜▌)の比率: 横長の箱に点の目が 2 つ、脇に腕、下に 2 本ずつの細い脚。
export const SIZES = Object.freeze({
  L: Object.freeze({
    bw: 12, bh: 8, // 胴の幅と高さ
    eyes: Object.freeze([-4, 3]), eyeTop: 2, eyeH: 2, sideEye: 1, // 目(胴の上端から eyeTop 段下・高さ eyeH)
    shoulderY: -4, upper: 3, lower: 3, armT: 2, // 肩の高さ・上腕・前腕・腕の太さ
    hipX: 3.5, legGap: 1, thigh: 3, shin: 3, // 左右の脚の中心・2 本の脚の間隔の半分・もも・すね
    fist: 1.2, finger: 2, // 握りこぶしの半径・指の長さ
    crownBase: Object.freeze([-3, 3]), crownTips: Object.freeze([[-3, -2], [-1, 1], [2, 3]]),
  }),
  S: Object.freeze({
    bw: 8, bh: 6,
    eyes: Object.freeze([-3, 2]), eyeTop: 1, eyeH: 2, sideEye: 0,
    shoulderY: -3.5, upper: 3, lower: 2, armT: 1,
    hipX: 2.5, legGap: 1, thigh: 2, shin: 2,
    fist: 0.8, finger: 1.5,
    crownBase: Object.freeze([-2, 2]), crownTips: Object.freeze([[-2, -1], [1, 2]]),
  }),
})

/** 立ったときの背丈(胴+もも+すね)。上下動(dy)と横移動(dx)の単位。 */
export function standHeight(size) {
  const s = SIZES[size]
  return s.bh + s.thigh + s.shin
}

const RAD = Math.PI / 180
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** 手足の向き(胴の座標)。side は -1 = 画面左、+1 = 画面右。 */
function dir(side, deg) {
  const a = num(deg) * RAD
  return [side * Math.sin(a), Math.cos(a)]
}

/** 点 (px,py) と線分 a→b の距離の 2 乗。 */
function dist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0
  t = clamp(t, 0, 1)
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return dx * dx + dy * dy
}

const segment = (ax, ay, bx, by, t) => ({ ax, ay, bx, by, r2: (t / 2 + 0.15) ** 2 })

/**
 * ポーズを胴の座標の図形(線分と箱)に直す。
 * 脚の上げ(lift)と沈み込み(dy > 0)は、脚の縦の長さを縮めて表す。
 */
export function shapes(pose, size, opts = {}) {
  const s = SIZES[size]
  const body = pose.body ?? {}
  const facing = body.facing === 'back' || body.facing === 'side' ? body.facing : 'front'
  const crouch = clamp(1 - 2.5 * Math.max(0, num(body.dy)), 0.4, 1)

  const legs = []
  const feet = [] // 足先(胴の座標)。y は脚を上げないときの値: 両足が浮いた(跳んだ)ときの接地の目安
  let planted = false
  for (const [side, leg] of [[-1, pose.legL], [1, pose.legR]]) {
    const l = leg ?? {}
    const lift = clamp(num(l.lift), 0, 1)
    if (lift < 0.5) planted = true
    const squash = crouch * (1 - 0.8 * lift)
    const [tx, ty] = dir(side, l.thigh)
    const [sx, sy] = dir(side, l.shin)
    const hx = side * s.hipX
    const kx = hx + tx * s.thigh
    const ky = ty * s.thigh * squash
    const fx = kx + sx * s.shin
    const fy = ky + sy * s.shin * squash
    feet.push({ x: fx, y: (ty * s.thigh + sy * s.shin) * crouch })
    // 1 本の脚 = 平行な細い線 2 本(ロゴの ▘▘ ▝▝)。線分ごとに、その向きに直交する方向へずらす。
    for (const k of [-1, 1]) {
      const pt = perp(kx - hx, ky, k * s.legGap)
      const ps = perp(fx - kx, fy - ky, k * s.legGap)
      legs.push(segment(hx + pt[0], pt[1], kx + pt[0], ky + pt[1], 1))
      legs.push(segment(kx + ps[0], ky + ps[1], fx + ps[0], fy + ps[1], 1))
    }
  }

  const half = facing === 'side' ? s.bw * 0.3 : s.bw / 2 // 胴の半分の幅(横向きは細い)
  const arms = []
  const hands = []
  for (const [side, arm] of [[-1, pose.armL], [1, pose.armR]]) {
    const a = arm ?? {}
    const [ux, uy] = dir(side, a.upper)
    const [lx, ly] = dir(side, a.lower)
    const sx = side * (half + s.armT / 2) // 肩は胴の縁(横向きでも胴から離れない)
    const sy = s.shoulderY
    const ex = sx + ux * s.upper
    const ey = sy + uy * s.upper
    const hx = ex + lx * s.lower
    const hy = ey + ly * s.lower
    arms.push(segment(sx, sy, ex, ey, s.armT))
    arms.push(segment(ex, ey, hx, hy, s.armT))
    const hand = a.hand
    if (hand === 'fist' || hand === 'thumb') hands.push({ ax: hx, ay: hy, bx: hx, by: hy, r2: s.fist ** 2 })
    if (hand === 'open') {
      // 開いた手 = 前腕の向きから左右 35 度に開く 2 本の指
      for (const turn of [-35, 35]) {
        const c = Math.cos(turn * RAD)
        const n = Math.sin(turn * RAD)
        const fx = lx * c - ly * n
        const fy = lx * n + ly * c
        hands.push(segment(hx, hy, hx + fx * s.finger, hy + fy * s.finger, 1))
      }
    }
    if (hand === 'thumb') {
      // 立てた親指は胴の座標で真上(胴が傾けば一緒に傾く)
      hands.push(segment(hx, hy - s.fist, hx, hy - s.fist - s.finger, 1))
    }
  }

  const torso = { x0: -half, x1: half, y0: -s.bh, y1: 0 }
  const eyeY0 = -s.bh + s.eyeTop
  const eyes = facing === 'back' ? []
    : (facing === 'side' ? [s.sideEye] : s.eyes).map((x) => ({ x0: x, x1: x + 1, y0: eyeY0, y1: eyeY0 + s.eyeH }))
  const crown = opts.crown
    ? [
        { x0: s.crownBase[0], x1: s.crownBase[1], y0: -s.bh - 1, y1: -s.bh },
        ...s.crownTips.map(([x0, x1]) => ({ x0, x1, y0: -s.bh - 2, y1: -s.bh - 1 })),
      ]
    : []

  return { facing, legs, torso, eyes, crown, arms, hands, feet, planted }
}

/** 長さ len の向き (vx,vy) に直交する、長さ k の向き。 */
function perp(vx, vy, k) {
  const len = Math.hypot(vx, vy)
  if (len < 1e-9) return [k, 0]
  return [(-vy / len) * k, (vx / len) * k]
}

export const SHEAR_MAX = 30 // これ以下の傾きは上半身だけをずらす(点絵で回すと箱の縁がギザギザになるため)

/**
 * 傾き(度・+ = 上が画面右)の当て方。
 * 小さい傾き: 腰より上の段を横にずらす(段ごとの形は崩れない)。脚は傾けない。
 * 大きい傾き(逆立ちとその途中): 腰を中心に全体を回す。
 */
export function transform(tiltDeg) {
  const lean = Math.abs(((tiltDeg % 360) + 540) % 360 - 180)
  if (lean <= SHEAR_MAX) {
    const k = Math.tan(tiltDeg * RAD)
    return {
      toLocal: (wx, wy) => (wy < 0 ? [wx + wy * k, wy] : [wx, wy]),
      worldY: (_x, y) => y,
    }
  }
  const cos = Math.cos(tiltDeg * RAD)
  const sin = Math.sin(tiltDeg * RAD)
  return {
    toLocal: (wx, wy) => [wx * cos + wy * sin, -wx * sin + wy * cos],
    worldY: (x, y) => x * sin + y * cos,
  }
}

const inBox = (b, x, y) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1
const onAny = (list, x, y) => list.some((g) => dist2(x, y, g.ax, g.ay, g.bx, g.by) <= g.r2)

/**
 * 1 体を点の並びにする。
 * 返り値: { size: 一辺の点数, origin: 原点の位置(添字), px: Int32Array(色 or NONE),
 *          ground: 床のすぐ上に置く段の y(原点基準)、left / right: 点のある左端・右端の x(原点基準)}
 * 接地: 片足でも着いているか逆さ(傾き 90 度以上)なら、いちばん下の点(逆立ちなら手)。両足が浮いていれば(跳躍)、脚を伸ばしたときの足先。
 * 描く順(後が上): 脚 → 胴(目は穴) → 王冠 → 腕 → 手。
 */
export function sprite(pose, size, opts = {}) {
  const s = SIZES[size]
  const g = shapes(pose, size, opts)
  const reach = Math.ceil(s.bh + Math.max(s.upper + s.lower, s.thigh + s.shin) + s.finger + 4) // 整数(点の番地に使う)
  const n = reach * 2
  const px = new Int32Array(n * n).fill(NONE)
  const tf = transform(num(pose.body?.tilt))
  const torsoColor = g.facing === 'back' ? COLOR.back : COLOR.body
  const overColor = g.facing === 'back' ? COLOR.body : COLOR.armOver
  let bottom = -Infinity
  let left = Infinity
  let right = -Infinity

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // 画面の点の中心を、傾きを戻して胴の座標へ
      const [x, y] = tf.toLocal(i - reach + 0.5, j - reach + 0.5)
      let c = NONE
      if (onAny(g.legs, x, y)) c = COLOR.body
      const inTorso = inBox(g.torso, x, y)
      if (inTorso) c = g.eyes.some((e) => inBox(e, x, y)) ? NONE : torsoColor
      if (g.crown.some((b) => inBox(b, x, y))) c = COLOR.crown
      if (onAny(g.arms, x, y) || onAny(g.hands, x, y)) c = inTorso ? overColor : COLOR.body
      if (c !== NONE) {
        px[j * n + i] = c
        if (j - reach > bottom) bottom = j - reach
        if (i - reach < left) left = i - reach
        if (i - reach > right) right = i - reach
      }
    }
  }
  let ground = bottom === -Infinity ? 0 : bottom
  // 逆さ(傾き 90 度以上)のときは手で支えている: 脚の上げに関係なく、いちばん下の点を床に着ける
  const tilt = num(pose.body?.tilt)
  const upside = Math.abs(((tilt % 360) + 540) % 360 - 180) >= 90
  if (!g.planted && !upside) {
    // 線の太さ 1 の端は中心から 0.65 まで塗られる → 足先 y の点が入る段は floor(y + 0.15)
    ground = Math.max(...g.feet.map((f) => Math.floor(tf.worldY(f.x, f.y) + 0.15)))
  }
  if (left === Infinity) left = right = 0
  return { size: n, origin: reach, px, ground, left, right }
}
