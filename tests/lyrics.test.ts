import { describe, expect, test } from 'claude-code/testing'
// @ts-ignore 本体は型宣言のない JS
import { INTERLUDE, LEAD, LINES, SPAN, lineIndexAt, lyricAt } from '../hooks/lyrics.js'
// @ts-ignore 同上
import { LOOP_BEATS, LOOP_START } from '../hooks/choreo.js'
// @ts-ignore 同上
import { footerOf } from '../hooks/register.js'

// 替え歌の字幕データ(lyrics.js)の約束: 拍の順・1 周の中・塗る向き。

const STEP = 1 / 16
const beats: number[] = []
for (let b = LOOP_START; b < LOOP_START + LOOP_BEATS; b += STEP) beats.push(b)

describe('字幕のデータ', () => {
  test('行も区切りも拍の順に並び、重ならず、1 周の中に収まる', () => {
    expect(LINES.length).toBeGreaterThan(10)
    let prev = SPAN.start
    for (const line of LINES) {
      expect(line.from).toBeGreaterThanOrEqual(prev)
      for (const p of line.parts) {
        expect(p.start).toBeGreaterThanOrEqual(prev)
        expect(p.end).toBeGreaterThan(p.start)
        expect(p.text.length).toBeGreaterThan(0)
        prev = p.end
      }
      expect(line.to).toBe(prev)
      expect(line.text).toBe(line.parts.map((p: any) => p.text).join(''))
    }
    expect(prev).toBeLessThanOrEqual(SPAN.end)
  })

  test('次の行は LEAD 拍前から出す。ただし前の行が歌い終わるまでは出さない', () => {
    LINES.forEach((line: any, i: number) => {
      expect(line.show).toBeLessThanOrEqual(line.from)
      expect(line.show).toBeGreaterThanOrEqual(line.from - LEAD)
      if (i > 0) expect(line.show).toBeGreaterThanOrEqual(LINES[i - 1].to)
    })
    expect(lineIndexAt(LOOP_START)).toBe(0) // 頭から 1 行目が出ている
  })

  test('間奏は 1 つで、♪ だけ', () => {
    const inter = LINES.filter((l: any) => l.interlude)
    expect(inter).toHaveLength(1)
    expect(inter[0].text).toBe(INTERLUDE)
    expect(lyricAt(45)).toMatchObject({ text: INTERLUDE, interlude: true })
  })
})

describe('塗り方', () => {
  test('1 行の中では塗る数が減らず、歌い終わりで全部塗る', () => {
    let last = { i: -2, sung: 0 }
    for (const b of beats) {
      const i = lineIndexAt(b)
      const r = lyricAt(b)
      if (i === last.i) expect(r.sung).toBeGreaterThanOrEqual(last.sung)
      last = { i, sung: r.sung }
    }
    // 最後の文字は歌い終わりより前に塗る(次の行に替わる前に、全部塗った行が見える)
    for (const line of LINES) expect(lyricAt(line.to - STEP / 2).sung).toBe([...line.text].length)
  })

  test('歌い始める前は塗らず、歌い始めた拍で 1 文字目を塗る。空白を先に塗らない', () => {
    for (const line of LINES) {
      expect(lyricAt(line.show).sung).toBe(line.show < line.from ? 0 : 1)
      expect(lyricAt(line.from).sung).toBe(1)
    }
    for (const b of beats) {
      const r = lyricAt(b)
      if (r.sung > 0) expect([...r.text][r.sung - 1]).not.toBe(' ')
    }
  })

  test('1 周の終わり(最後の行の後)は、次の周の 1 行目を塗らずに出す', () => {
    const last = LINES[LINES.length - 1]
    expect(LINES[0].show).toBe(LINES[0].from - LEAD)
    expect(LINES[0].show + LOOP_BEATS).toBeGreaterThanOrEqual(last.to)
    expect(lyricAt(LOOP_START + LOOP_BEATS - STEP)).toMatchObject({ text: LINES[0].text, sung: 0 })
    expect(lyricAt(last.to - STEP / 2)).toMatchObject({ text: last.text, sung: [...last.text].length })
  })

  test('1 周で折り返す(拍は 1 周の外でも同じ字幕)', () => {
    for (const b of [-4, -1.5, 0, 9.25, 44, 58.75]) {
      expect(lyricAt(b + LOOP_BEATS)).toEqual(lyricAt(b))
    }
  })

  test('描き直しの key は、行か塗る数が変わったときだけ変わる', () => {
    let prev = lyricAt(beats[0]!)
    for (const b of beats.slice(1)) {
      const r = lyricAt(b)
      expect(r.key === prev.key).toBe(r.text === prev.text && r.sung === prev.sung && lineIndexAt(b) === lineIndexAt(b - STEP))
      prev = r
    }
  })

  test('下の 2 行の key は、カウントか字幕が変わると変わる', () => {
    expect(footerOf(-3.9).key).toBe(footerOf(-3.95).key)
    expect(footerOf(-2).key).not.toBe(footerOf(-3.9).key)
    expect(footerOf(1, 1).key).not.toBe(footerOf(1, 0.5).key)
  })
})
