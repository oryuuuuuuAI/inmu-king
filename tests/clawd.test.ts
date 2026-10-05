import { describe, expect, test } from 'claude-code/testing'
// @ts-ignore 本体は型宣言のない JS(tsconfig は共通のまま変えない)
import { COLOR, DEFAULT, NONE, SIZES, sprite, standHeight } from '../hooks/clawd.js'
// @ts-ignore 同上
import { base64, encodeCells, FOOTER_ROWS, frameCells, layoutFor, stagePixels, WANTED_ROWS } from '../hooks/stage.js'
// @ts-ignore 同上
import { BPM, KEYFRAMES, LOOP_BEATS, LOOP_START, SECTIONS, SOLOS, beatAt, countAt, elapsedAt, poseAt, posesAt, wrapBeat } from '../hooks/choreo.js'

/** 傾き → 直立からの傾き 0〜180(360 回っても同じ)。 */
const lean = (t: number) => Math.abs((((t % 360) + 540) % 360) - 180)

// 純関数(絵・舞台・振付)の試験。端末やタイマーは使わない。

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 → [文字, 文字色, 背景色] の並び(試験用の素直な実装)。 */
function decode(cells: string): number[][] {
  const clean = cells.replace(/=+$/, '')
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  const out: number[][] = []
  const u32 = (i: number) => (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0
  for (let i = 0; i + 11 < bytes.length; i += 12) out.push([u32(i), u32(i + 4), u32(i + 8)])
  return out
}

const GLYPHS = new Set([0x20, 0x2580, 0x2584, 0x2588])
const okColor = (c: number) => c === DEFAULT || (c >= 0 && c <= 0xffffff)

// 1 周を 1/4 拍ごとに見る(キーフレームのちょうどと、そのあいだ)
const SAMPLES: number[] = []
for (let b = LOOP_START; b < LOOP_START + LOOP_BEATS; b += 0.25) SAMPLES.push(b)

describe('base64', () => {
  test('標準の base64(= で埋める)になる', () => {
    expect(base64(Uint8Array.of())).toBe('')
    expect(base64(Uint8Array.of(0x41))).toBe('QQ==')
    expect(base64(Uint8Array.of(0x41, 0x42))).toBe('QUI=')
    expect(base64(Uint8Array.of(0x41, 0x42, 0x43))).toBe('QUJD')
    expect(base64(Uint8Array.of(0xff, 0xfe, 0xfd, 0x00))).toBe('//79AA==')
  })

  test('cells は 1 マス 12 バイト(文字・文字色・背景色の LE u32)', () => {
    // 幅 4・高さ 1 段: 上の点 4 つ、続けて下の点 4 つ
    const buf = Int32Array.of(COLOR.body, NONE, 0x123456, NONE, NONE, COLOR.body, COLOR.body, NONE)
    const cells = decode(encodeCells(buf, 4, 1))
    expect(cells).toEqual([
      [0x2580, COLOR.body, DEFAULT], // 上だけ = ▀
      [0x2584, COLOR.body, DEFAULT], // 下だけ = ▄
      [0x2580, 0x123456, COLOR.body], // 違う色 = ▀(文字色 = 上・背景色 = 下)
      [0x20, DEFAULT, DEFAULT], // どちらも無い = 空白
    ])
    const both = decode(encodeCells(Int32Array.of(1, 2, 1, 1), 2, 1))
    expect(both).toEqual([
      [0x2588, 1, DEFAULT], // 上下が同じ色 = █
      [0x2580, 2, 1], // 違う色 = ▀(文字色 = 上・背景色 = 下)
    ])
  })
})

describe('並べ方(layoutFor)', () => {
  test('広いと大きい絵 5 体・間隔は 23〜27 桁で、舞台の幅は 136 で止める', () => {
    expect(layoutFor(200, 20)).toEqual({ size: 'L', dancers: 5, columns: 136, rows: WANTED_ROWS.L, spacing: 27 })
    expect(layoutFor(130, 20)).toMatchObject({ size: 'L', columns: 128, spacing: 25 })
    expect(layoutFor(120, 20)).toMatchObject({ size: 'L', columns: 120, spacing: 23 })
  })

  test('狭くなると小さい絵 → 3 体 → 1 体。幅はペインを超えない', () => {
    for (let w = 1; w <= 300; w++) {
      const l = layoutFor(w, 30)
      expect(l.columns).toBeLessThanOrEqual(w)
      expect(l.columns).toBeGreaterThanOrEqual(1)
      expect(l.dancers === 1 || l.dancers === 3 || l.dancers === 5).toBe(true)
    }
    expect(layoutFor(119, 30).size).toBe('S')
    expect(layoutFor(80, 30)).toMatchObject({ size: 'S', dancers: 5, columns: 80, spacing: 15 })
    expect(layoutFor(64, 30)).toMatchObject({ dancers: 5, columns: 64, spacing: 11 })
    expect(layoutFor(60, 30)).toMatchObject({ dancers: 5, spacing: 10 })
    expect(layoutFor(59, 30).dancers).toBe(3)
    expect(layoutFor(39, 30).dancers).toBe(1)
  })

  test('高さが分かれば収める(カウントと字幕に 2 段残す・最低 1 段)。分からなければ欲しい段数', () => {
    expect(FOOTER_ROWS).toBe(2)
    expect(layoutFor(200, 16).rows).toBe(14)
    expect(layoutFor(200, 10).rows).toBe(8)
    expect(layoutFor(200, 4).rows).toBe(2)
    expect(layoutFor(200, 3).rows).toBe(1)
    expect(layoutFor(200, 2).rows).toBe(1)
    expect(layoutFor(200, 1).rows).toBe(1)
    expect(layoutFor(200, undefined).rows).toBe(WANTED_ROWS.L)
    expect(layoutFor(100, 100).rows).toBe(WANTED_ROWS.S)
    expect(layoutFor(Number.NaN, undefined)).toMatchObject({ columns: 1, dancers: 1 })
    expect(layoutFor(10_000, 20).columns).toBeLessThanOrEqual(512)
  })
})

describe('1 コマの絵(frameCells)', () => {
  test('1 周のどのコマも、大きさどおりで、使う文字は 4 つだけ・色は正しい形', () => {
    for (const [w, h] of [[130, 15], [80, 12], [50, 8], [20, 30]] as const) {
      const layout = layoutFor(w, h)
      for (const b of SAMPLES) {
        const cells = decode(frameCells(poseAt(b), layout))
        expect(cells.length).toBe(layout.columns * layout.rows)
        // 1 マスずつ expect すると遅いので、外れたマスだけ集める
        const bad = cells.filter(([cp, fg, bg]) => !GLYPHS.has(cp!) || !okColor(fg!) || !okColor(bg!))
        expect(bad).toEqual([])
      }
    }
  })

  test('同じポーズなら同じ絵(決まった結果)', () => {
    const layout = layoutFor(130, 16)
    for (const b of [-4, 0, 16.5, 57]) expect(frameCells(poseAt(b), layout)).toBe(frameCells(poseAt(b), layout))
  })

  test('いちばん下の段の下半分は床の線', () => {
    const layout = layoutFor(130, 16)
    const px = stagePixels(poseAt(10), layout)
    const fy = layout.rows * 2 - 1
    for (let x = 0; x < layout.columns; x++) expect(px[fy * layout.columns + x]).toBe(COLOR.floor)
  })

  test('端からはみ出す手足は切らずに、その 1 体を内側へ寄せる', () => {
    const base = poseAt(-4)
    for (const [side, dx] of [['armL', -3], ['armR', 3]] as const) {
      const pose = { ...base, [side]: { upper: 90, lower: 90, hand: 'open' }, body: { ...base.body, dx } }
      for (const layout of [{ size: 'L', dancers: 1, columns: 44, rows: 14, spacing: 0 }, { size: 'S', dancers: 1, columns: 28, rows: 11, spacing: 0 }]) {
        const sp = sprite(pose, layout.size, { crown: true }) // 1 体の舞台では、その 1 体が真ん中 = 王冠つき
        const want = sp.px.filter((c: number) => c !== NONE).length
        const px = stagePixels(pose, layout)
        const got = px.slice(0, (layout.rows * 2 - 1) * layout.columns).filter((c: number) => c !== NONE).length
        expect(got).toBe(want)
      }
    }
  })

  test('1 体の舞台(幅 24〜39 桁)では、1 周のどの拍でも手足が横に切れない', () => {
    for (const avail of [24, 39]) {
      const layout = { ...layoutFor(avail, 30), rows: 40 } // 縦は切れない高さにして、横の切れだけを見る
      expect(layout.dancers).toBe(1)
      for (let b = LOOP_START; b < LOOP_START + LOOP_BEATS; b += 0.125) {
        const pose = posesAt(b)[2] // 1 体の舞台は真ん中の 1 体(王冠つき)
        const sp = sprite(pose, 'S', { crown: true })
        const want = sp.px.filter((c: number) => c !== NONE).length
        const px = stagePixels(pose, layout)
        const got = px.slice(0, (layout.rows * 2 - 1) * layout.columns).filter((c: number) => c !== NONE).length
        expect([b, got]).toEqual([b, want])
      }
    }
  })

  test('5 体それぞれ違うポーズも描ける(同じ大きさ・決まった結果)', () => {
    const layout = layoutFor(130, 16)
    const poses = [-4, 0, 16.5, 30, 57].map((b) => poseAt(b))
    const a = frameCells(poses, layout)
    expect(a).toBe(frameCells(poses, layout))
    expect(decode(a).length).toBe(layout.columns * layout.rows)
    expect(a).not.toBe(frameCells(poseAt(-4), layout))
    // 1 体ずつ違う絵になる: 舞台の各人の場所の点の並びが、その人のポーズの絵と同じ向きに変わる
    const one = stagePixels(poses, layout)
    const same = stagePixels(poseAt(-4), layout)
    expect(one.some((c: number, i: number) => c !== same[i])).toBe(true)
  })

  test('直立のときは足が床のすぐ上にある(浮かない・めり込まない)', () => {
    for (const size of ['L', 'S'] as const) {
      const layout = size === 'L' ? layoutFor(130, 16) : layoutFor(80, 12)
      const px = stagePixels(poseAt(-4), layout)
      const w = layout.columns
      const y = layout.rows * 2 - 2 // 床のすぐ上
      let feet = 0
      for (let x = 0; x < w; x++) if (px[y * w + x] !== NONE) feet++
      expect(feet).toBeGreaterThan(0)
      // 1 体の背丈(胴+脚)ぶん上は胴の中: 足から数えて standHeight 点で胴の上端
      const top = y - standHeight(size) + 1
      let body = 0
      for (let x = 0; x < w; x++) if (px[top * w + x] === COLOR.body) body++
      expect(body).toBeGreaterThan(0)
    }
  })

  test('王冠は真ん中の 1 体だけ', () => {
    for (const [w, n] of [[130, 5], [50, 3], [30, 1]] as const) {
      const layout = layoutFor(w, 16)
      expect(layout.dancers).toBe(n)
      const px = stagePixels(poseAt(-4), layout)
      let minX = Infinity
      let maxX = -Infinity
      for (let i = 0; i < px.length; i++) {
        if (px[i] !== COLOR.crown) continue
        const x = i % layout.columns
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
      }
      expect(maxX - minX).toBeLessThan(8) // 1 体ぶんの幅に収まる
      expect(Math.abs((minX + maxX) / 2 - layout.columns / 2)).toBeLessThan(3)
    }
  })

  test('背中向きのコマは目が無く、背中の色になる', () => {
    const back = KEYFRAMES.find((k: any) => k.pose.body.facing === 'back')
    expect(back).toBeDefined()
    const sp = sprite(back.pose, 'L')
    const colors = new Set(sp.px)
    expect(colors.has(COLOR.back)).toBe(true)
    const front = sprite(KEYFRAMES[0].pose, 'L')
    expect(new Set(front.px).has(COLOR.back)).toBe(false)
  })

  test('逆立ち(真ん中の 1 体・傾き 205 度 = 逆さから 25 度)は手が床側・脚が上', () => {
    const k = { pose: poseAt(53, 2) }
    expect(lean(k.pose.body.tilt)).toBeGreaterThanOrEqual(150)
    const s = SIZES.L
    const top = (sp: any) => {
      for (let j = 0; j < sp.size; j++) for (let i = 0; i < sp.size; i++) if (sp.px[j * sp.size + i] !== NONE) return j - sp.origin
      return 0
    }
    // 直立: いちばん下は足(腰から脚の長さ)、いちばん上は胴の上端より上
    const stand = sprite(KEYFRAMES[0].pose, 'L')
    expect(stand.ground).toBeLessThan(s.bh)
    expect(top(stand)).toBeLessThanOrEqual(-s.bh)
    // 逆立ち: 胴と腕が腰より下(床側)に伸び、いちばん上は脚(腰の上、直立の頭より高くならない)
    const hand = sprite(k.pose, 'L')
    expect(hand.ground).toBeGreaterThan(s.bh)
    expect(top(hand)).toBeLessThan(0)
    expect(top(hand)).toBeGreaterThanOrEqual(-s.bh)
  })

  test('横向きは胴が細く、肩も胴の縁にある(腕が胴から離れて浮かない)', () => {
    const s = SIZES.L
    const base = KEYFRAMES[0].pose
    const down = { upper: 0, lower: 0, hand: '' }
    const pose = (facing: string) => ({ ...base, armL: down, armR: down, body: { ...base.body, facing } })
    const side = sprite(pose('side'), 'L')
    const front = sprite(pose('front'), 'L')
    expect(side.right - side.left).toBeLessThan(front.right - front.left)
    expect(side.right).toBeLessThanOrEqual(Math.ceil(s.bw * 0.3 + s.armT)) // 前の作りは肩が胴の幅の半分の外 = 7
  })

  test('転ぶ人の仰向け(拍 31.5・画面の右から 2 番目)は床に寝る: 横に長く、腰が低い', () => {
    const ps = posesAt(31.5)
    for (const size of ['L', 'S'] as const) {
      const s = SIZES[size]
      const lie = sprite(ps[3], size)
      const stand = sprite(KEYFRAMES[0].pose, size)
      expect(lie.right - lie.left).toBeGreaterThan(s.bh * 2) // 頭の先へ伸ばした腕と、腰から伸びる脚
      expect(lie.ground).toBeLessThan(stand.ground) // 腰(原点)から床まで: 寝ると立つより低い(縦に起き上がらない)
    }
  })
})

describe('振付(choreo)', () => {
  test('キーフレームは拍の順で、1 周の端(−4 と 60)は同じ直立', () => {
    for (let i = 1; i < KEYFRAMES.length; i++) expect(KEYFRAMES[i].beat).toBeGreaterThan(KEYFRAMES[i - 1].beat)
    expect(KEYFRAMES[0].beat).toBe(LOOP_START)
    expect(KEYFRAMES[KEYFRAMES.length - 1].beat).toBe(LOOP_START + LOOP_BEATS)
    expect(KEYFRAMES[KEYFRAMES.length - 1].pose).toEqual(KEYFRAMES[0].pose)
  })

  test('拍とカウント: 拍 0 はチャールストンの 1、拍 7 は 8、1 周で頭に戻る', () => {
    expect(countAt(0)).toEqual({ section: 'charleston', label: 'チャールストン', count: 1 })
    expect(countAt(7.9).count).toBe(8)
    expect(countAt(-4)).toMatchObject({ section: 'pose', count: 5 })
    expect(countAt(LOOP_START + LOOP_BEATS)).toEqual(countAt(LOOP_START))
    expect(countAt(50).section).toBe('freeze')
    expect(countAt(53)).toMatchObject({ section: 'reach', label: '手をかざす' })
    for (const s of SECTIONS) expect(countAt(s.start).section).toBe(s.name)
  })

  test('経過時間 → 拍: BPM どおり進み、1 周で折り返す。slow は半分', () => {
    const msPerBeat = 60_000 / BPM
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)
    expect(beatAt(0)).toBe(LOOP_START)
    near(beatAt(4 * msPerBeat), 0)
    near(beatAt(LOOP_BEATS * msPerBeat), LOOP_START)
    near(beatAt(8 * msPerBeat, 0.5), 0)
    expect(beatAt(-100)).toBe(LOOP_START)
    expect(wrapBeat(LOOP_START - 1)).toBe(LOOP_START + LOOP_BEATS - 1)
  })

  test('拍 → 経過時間(elapsedAt)は beatAt の逆: 速さを変えても同じ拍に戻る', () => {
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)
    for (const b of [LOOP_START, -1, 0, 7.5, 33.25, 59.9]) {
      for (const sp of [1, 0.5]) near(beatAt(elapsedAt(b, sp), sp), b)
    }
    expect(elapsedAt(LOOP_START)).toBe(0)
    near(elapsedAt(0, 0.5), 2 * elapsedAt(0, 1))
  })

  test('1 周のつなぎ目でポーズが飛ばない', () => {
    const a = poseAt(LOOP_START + LOOP_BEATS - 0.001)
    const b = poseAt(LOOP_START)
    for (const limb of ['armL', 'armR'] as const) {
      expect(Math.abs(a[limb].upper - b[limb].upper)).toBeLessThan(1)
      expect(Math.abs(a[limb].lower - b[limb].lower)).toBeLessThan(1)
    }
    expect(Math.abs(a.body.tilt - b.body.tilt)).toBeLessThan(1)
  })

  test('キーフレームのちょうどでは、そのポーズになる', () => {
    for (const k of KEYFRAMES.slice(0, -1)) {
      const p = poseAt(k.beat)
      expect(Math.abs(p.armL.upper - k.pose.armL.upper)).toBeLessThan(1e-6)
      expect(Math.abs(p.legR.thigh - k.pose.legR.thigh)).toBeLessThan(1e-6)
      expect(p.body.facing).toBe(k.pose.body.facing)
    }
  })
})

describe('1 人だけ違う動き(SOLOS・posesAt)', () => {
  const allSegs = () => Object.values(SOLOS).flat() as any[]
  const inSolo = (b: number, d: number) => (SOLOS[d] ?? []).some((g: any) => b >= g.from && b <= g.to)
  const near = (p: any, q: any) => {
    for (const limb of ['armL', 'armR'] as const) {
      expect(Math.abs(p[limb].upper - q[limb].upper)).toBeLessThan(1e-6)
      expect(Math.abs(p[limb].lower - q[limb].lower)).toBeLessThan(1e-6)
    }
    for (const limb of ['legL', 'legR'] as const) expect(Math.abs(p[limb].thigh - q[limb].thigh)).toBeLessThan(1e-6)
    expect(Math.abs(p.body.tilt - q.body.tilt)).toBeLessThan(1e-6)
    expect(Math.abs(p.body.dy - q.body.dy)).toBeLessThan(1e-6)
  }

  test('posesAt は 5 体ぶん。違う区間の外では全員が同じ物で、poseAt と同じポーズ', () => {
    for (let b = LOOP_START; b < LOOP_START + LOOP_BEATS; b += 0.25) {
      const ps = posesAt(b)
      expect(ps.length).toBe(5)
      const common = poseAt(b)
      for (let d = 0; d < 5; d++) {
        if (inSolo(b, d)) near(ps[d], poseAt(b, d))
        else near(ps[d], common)
      }
      const plain = [0, 1, 2, 3, 4].filter((d) => !inSolo(b, d))
      for (const d of plain) expect(ps[d]).toBe(ps[plain[0]]) // 同じ物 = 絵は 1 度だけ描く
    }
  })

  test('区間は 1 周の中で、人ごとに重ならず、中の行は拍の順', () => {
    for (const [d, segs] of Object.entries(SOLOS) as [string, any[]][]) {
      expect(Number(d) >= 0 && Number(d) <= 4).toBe(true)
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i]
        expect(g.from).toBeGreaterThanOrEqual(LOOP_START)
        expect(g.to).toBeLessThanOrEqual(LOOP_START + LOOP_BEATS)
        expect(g.to).toBeGreaterThan(g.from)
        if (i > 0) expect(g.from).toBeGreaterThan(segs[i - 1].to)
        for (let k = 1; k < g.keys.length; k++) expect(g.keys[k].beat).toBeGreaterThan(g.keys[k - 1].beat)
        expect(g.keys[0].beat).toBe(g.from)
        expect(g.keys[g.keys.length - 1].beat).toBe(g.to)
      }
    }
  })

  test('区間の始めと終わりでは共通の振付と同じポーズ(つなぎ目で飛ばない)', () => {
    expect(allSegs().length).toBeGreaterThan(0)
    for (const g of allSegs()) {
      near(poseAt(g.from, g.dancer), poseAt(g.from))
      if (g.to < LOOP_START + LOOP_BEATS) near(poseAt(g.to, g.dancer), poseAt(g.to))
      // 区間のすぐ外側からすぐ内側へも、ほとんど動かない
      const a = poseAt(g.from - 0.01, g.dancer)
      const b = poseAt(g.from + 0.01, g.dancer)
      expect(Math.abs(a.body.tilt - b.body.tilt)).toBeLessThan(5)
      expect(Math.abs(a.armL.upper - b.armL.upper)).toBeLessThan(5)
    }
  })
  test('右から 2 番目(画面の左から 3)だけが、キックの終わりに転んで、サイドステップに戻る', () => {
    const fall = (SOLOS[3] ?? []).find((g: any) => g.from <= 31.5 && 31.5 <= g.to)
    expect(fall).toBeDefined()
    expect(fall.from).toBeGreaterThanOrEqual(29)
    expect(fall.to).toBeLessThanOrEqual(33)
    const ps = posesAt(31.5)
    expect(lean(ps[3].body.tilt)).toBeGreaterThanOrEqual(80) // あお向けに倒れている
    for (const d of [0, 1, 2, 4]) expect(lean(ps[d].body.tilt)).toBeLessThan(10)
    near(poseAt(32, 3), poseAt(32)) // MV は 32 で立って、ほかの 4 人と同じサイドステップ
    near(poseAt(33, 3), poseAt(33))
  })

  test('おわりのキメ: 真ん中だけ逆立ち、残りの 4 体は真ん中へ手をかざす(右の 2 体は左右を入れ替えた鏡)', () => {
    for (const b of [52, 53, 54]) {
      const ps = posesAt(b)
      expect(lean(ps[2].body.tilt)).toBeGreaterThanOrEqual(150)
      expect(ps[0]).toBe(ps[1])
      // 左の 2 体: 両腕を画面右へ(左腕は内 = 右、右腕は外 = 右)
      expect(ps[0].armL.upper).toBeLessThan(-80)
      expect(ps[0].armR.upper).toBeGreaterThan(80)
      for (const d of [3, 4]) {
        expect(lean(ps[d].body.tilt)).toBeLessThan(10)
        expect(Math.abs(ps[d].armL.upper - ps[0].armR.upper)).toBeLessThan(1e-6)
        expect(Math.abs(ps[d].armR.upper - ps[0].armL.upper)).toBeLessThan(1e-6)
        expect(Math.abs(ps[d].armL.lower - ps[0].armR.lower)).toBeLessThan(1e-6)
      }
    }
  })

  test('傾きは 1/100 拍で 8 度より大きく飛ばない(360 → 0 のような所で 1 回転しない)', () => {
    // 見るのは補間の飛び(折り返しの取り違え)。実際のコマ(60 ms ≒ 0.13 拍)では、速い動きは 1 コマで
    // 数十度動く(転ぶ人で約 60 度・真ん中の逆立ちで約 30 度)。それは振付どおりで、ここでは見ない。
    for (let d = 0; d < 5; d++) {
      let prev = poseAt(LOOP_START, d).body.tilt
      for (let b = LOOP_START + 0.01; b < LOOP_START + LOOP_BEATS; b += 0.01) {
        const t = poseAt(b, d).body.tilt
        expect(Math.abs((((t - prev) % 360) + 540) % 360 - 180)).toBeLessThan(8)
        prev = t
      }
    }
  })
})
