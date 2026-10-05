// Clawd の替え歌(2026-10-05 の下書き v1)を、拍ごとの字幕にしたもの。
// 元の歌詞は使っていない・写していない(聞き取ってもいない)。拍の区切りは、歌入り版とインスト版の差から
// 歌の鳴っている 16 分の区間を数で取ったもの(音も歌詞も保存していない)。
//
// 1 行 = いくつかの区切り [歌い始めの拍, 歌い終わりの拍, 文字]。区切りの中は文字(空白を除く)を等しい長さで並べ、
// その文字を歌い始めた拍で塗る(最後の文字は歌い終わりより前に塗り終わる)。伸ばす音は区切りを分けて、伸ばしの分だけゆっくり塗る。
// 次の行は LEAD 拍前から出す(前の行が歌い終わるまでは前の行のまま)。1 行目の先出しは、1 周の終わり(最後の行の後)に回る。

import { LOOP_BEATS, LOOP_START, wrapBeat } from './choreo.js'

export const LEAD = 0.75 // 次の行を先に見せる拍数
export const INTERLUDE = '♪'

const RAW = [
  [[-3.5, -0.25, 'ターミナルに 参上!']],
  [[0, 3, 'ぼくら クロード・キング!']],
  [[3.5, 7.25, 'ドット絵で 踊るぜ']],
  [[7.5, 12, '親指立てて テスト 全部 グリー'], [12, 13.75, 'ン〜']],
  [[14, 16, 'はい、マージ可!']],
  [[16, 19, 'ぼくら クロード・キング!']],
  [[19.5, 23.25, '腰ふり くるっと ターン']],
  [[23.5, 28, 'キックで バグを ぜんぶ 蹴とば'], [28, 29.75, 'せ〜']],
  [[30, 32, 'コケても リトライ!']],
  [[32, 36, '右へ 左へ 差分を 読む']],
  [[36.5, 40, 'しゃがんで じっと 考え中']],
  [[40, 42, 'よけて よけて エラー 回'], [42, 43.5, '避〜']],
  [[44, 47.5, INTERLUDE]], // 間奏(歌なし)
  [[47.75, 52, '王冠かぶって 片手で 逆立ち']],
  [[52, 56, 'みんなで 手をかざせば ビルド 通る']],
  [[56, 57, 'クロード・'], [57.5, 58, 'キ・'], [58, 58.5, 'ン・'], [58.5, 59.75, 'グ!']],
]

const isInk = (ch) => ch !== ' '

/** 行の一覧(凍結)。from・to は歌い始めと歌い終わり、show は字幕に出し始める拍。 */
export const LINES = Object.freeze(
  RAW.map((parts, i) => {
    const text = parts.map((p) => p[2]).join('')
    const last = RAW[i > 0 ? i - 1 : RAW.length - 1]
    const prevTo = last[last.length - 1][1] - (i > 0 ? 0 : LOOP_BEATS) // 1 行目の前は、前の周の最後の行
    const from = parts[0][0]
    return Object.freeze({
      from,
      to: parts[parts.length - 1][1],
      show: Math.max(from - LEAD, prevTo),
      text,
      interlude: text === INTERLUDE,
      parts: Object.freeze(parts.map(([start, end, t]) => Object.freeze({ start, end, text: t }))),
    })
  }),
)

/** 拍 → 今の行の番号(どの行も出ていなければ −1)。拍は 1 周の中へ折り返す。 */
export function lineIndexAt(beat) {
  beat = wrapBeat(beat)
  if (beat >= LINES[0].show + LOOP_BEATS) return 0 // 1 周の終わり: 次の周の 1 行目を先に出す
  let at = -1
  for (let i = 0; i < LINES.length; i++) if (beat >= LINES[i].show) at = i
  return at
}

/** 区切り 1 つの中で、拍 beat までに塗る文字(空白を除く)の数。j 文字目(0 から)は start + j/n の長さで歌い始める。 */
function inkedIn(part, beat) {
  const n = [...part.text].filter(isInk).length
  if (beat < part.start) return 0
  if (beat >= part.end) return n
  return Math.min(n, Math.floor(((beat - part.start) / (part.end - part.start)) * n) + 1)
}

/**
 * 拍 → 字幕。{ text, sung, interlude, key }。sung は先頭から塗る文字数(空白も含めた文字の位置)。
 * 行が出ていなければ text は ''。key は描き直しの要不要の比較に使う(行と塗った数が同じなら同じ)。
 */
export function lyricAt(beat) {
  beat = wrapBeat(beat)
  const i = lineIndexAt(beat)
  if (i < 0) return { text: '', sung: 0, interlude: false, key: '-' }
  const line = LINES[i]
  if (beat >= line.show + LOOP_BEATS) beat -= LOOP_BEATS // 1 周の終わりに先に出した 1 行目: まだ歌っていない
  let ink = 0
  for (const p of line.parts) ink += inkedIn(p, beat)
  // 塗る数(空白を除く)→ 文字の位置。塗った最後の文字の後ろの空白は、次の文字を塗るまで塗らない
  const chars = [...line.text]
  let sung = 0
  for (let left = ink; sung < chars.length && left > 0; sung++) if (isInk(chars[sung])) left--
  return { text: line.text, sung, interlude: line.interlude, key: `${i}|${sung}` }
}

/** 1 周の長さ(拍)。試験で 1 周の外へはみ出していないかを見るのに使う。 */
export const SPAN = Object.freeze({ start: LOOP_START, end: LOOP_START + LOOP_BEATS })
