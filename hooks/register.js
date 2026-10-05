// /inmu-king: 5 体の Clawd が INMU KING のサビを踊るペインを開く(もう一度で閉じる)。
// 伴奏: mod の sounds/chorus.m4a(インスト版 nc499434 のサビ 64 拍 = 踊りの 1 周)を $.audio.play で鳴らす。
// 歌入りに切り替えると sounds/chorus-vocal.m4a(歌入りの元の曲 nc499430 の同じ 64 拍。インスト版と拍の位置は同じ)を鳴らす。
// 1 周の頭ごとに、踊りの時計から鳴らし直す(ずれが積み重ならない)。ゆっくり・消音のときは鳴らさない。
// 字幕: Clawd の替え歌(lyrics.js)。元の歌詞の文字は入れていない(歌入りの音には元の歌が入る)。
// mod から直接ネットワーク・ファイル・プロセスには触れない(鳴らすのはエンジン)。$.store には消音と歌入りの設定 2 つだけを置く。
//
// 流れ: コマンドでペインを開く → ui.render が今のコマを Raster(key 'stage')で描く →
// タイマーが FRAME_MS ごとに次のコマを $.ui.blit で差し替える(再描画なし)。
// 下のカウントと字幕(日本語)は Raster に入れられない(幅 1 の文字だけ)ので Text にし、拍か塗る文字が変わったときだけ描き直す。
// ペインを閉じる・セッションが終わる・ペインが無くなる・描き替えが続けて失敗する で タイマーを止める。
//
// 待ち(await)の扱い: 番号を 2 つ持つ。
// - gen(タイマーの世代): 開始・停止・閉じたペインを開き直す直前に進む。待ちから戻った処理は、違っていれば何もしない
//   (古いタイマー・古い開始・開き直す前に読んだ古いペインの一覧)。
// - cancels(頼みの取り消し): 人やほかの mod がペインを閉じようとした・セッションが終わったときに進む。
//   コマンドは受け取ったときの番号を持ち、待ちから戻ったとき違っていれば踊りを始めない(閉じた後に開き直さない)。
//   そのコマンドが開いたペインなら、閉じて片付ける。
// 自分で閉じたかは、閉じる知らせの出どころ(next.origin.plugin: 閉じた plugin の名前。エンジンが付ける)で見分ける。
// 伴奏はタイマーの世代(gen)と伴奏の世代(take)の両方に結びつける: 止める(stop)・消音や歌の切り替え(silence)で、
// 鳴っている伴奏も次の周の予約も止まり、待ちから戻った古い予約の処理も鳴らさない(消音をすぐ戻しても復活しない)。
import { BPM, LOOP_BEATS, LOOP_START, beatAt, countAt, elapsedAt, posesAt } from './choreo.js'
import { lyricAt } from './lyrics.js'
import { frameCells, layoutFor } from './stage.js'

export const PANE = 'inmu-king'
export const COMMAND = 'inmu-king'
export const RASTER_KEY = 'stage'
export const FRAME_MS = 60 // 約 16 コマ/秒(1 拍 0.5 秒に 8 コマ強)
export const PANE_ROWS = 16 // 床を含む舞台 14 段+カウント 1 段+字幕 1 段
export const PANE_COLUMNS = 64 // 横に寄せた(dock)ときに欲しい幅: 小さい絵 5 体が入る
export const CHECK_EVERY = 10 // この回数ごとに、ペインがまだ開いているかを確かめる(約 0.6 秒)
export const DENY_LIMIT = 200 // 描き替えが続けて失敗したら止める安全弁(約 12 秒)
export const SLOW = 0.5
export const CLIP = 'sounds/chorus.m4a' // 伴奏(踊りの 1 周と同じ長さ)
export const VOCAL_CLIP = 'sounds/chorus-vocal.m4a' // 歌入りの伴奏(CLIP と同じ長さ・同じ拍の位置)
export const LOOP_MS = (LOOP_BEATS * 60000) / BPM // 1 周(約 28.87 秒)
export const AUDIO_LEAD_MS = 100 // 鳴らすと頼んでから音が出るまでの見込み: この分だけ先に頼み、踊りの頭をこの分だけ遅らせる
export const LATE_MS = 250 // 周の頭の予約がこれより遅れたら、その周は鳴らさない(踊りとずれるため。次の周の頭から鳴らす)
export const MUTED_KEY = 'muted' // $.store: 消音(セッションをまたいで覚える)
export const SOUND_KEY = 'sound' // 消音ボタンの key
export const VOCAL_KEY = 'vocal' // $.store: 歌入りで鳴らす(セッションをまたいで覚える)
export const TRACK_KEY = 'track' // 歌入り・歌なしを切り替えるボタンの key
export const LYRIC_COLOR = '#d77757' // 歌った字(Clawd のオレンジ)

const SPEEDS = new Map([['', 1], ['slow', SLOW], ['ゆっくり', SLOW]])
const MUTE_ARGS = new Set(['mute', '消音'])
const VOCAL_ARGS = new Set(['vocal', '歌', '歌入り'])

// モジュールの状態(ホットリロードで消える: session.start で開いたままのペインを見つけたら最初から踊り直す)
let timer = null
let gen = 0 // タイマーの世代: 開始・停止(閉じたペインを開き直す直前を含む)のたびに 1 増える
let cancels = 0 // 頼みの取り消し番号: ペインを閉じる操作(この mod 自身のものを除く)・セッションの終わりで 1 増える
let startedAt = 0
let speed = 1
let busy = false
let ticks = 0
let shown = true
let failures = 0 // 描き替えが続けて失敗した回数(断られた・例外)
let layout = null // いまマウントされている舞台の大きさ(ui.render が決め、ペインが閉じたら忘れる)
let lastCells = ''
let lastLabel = ''
let renders = 0 // ui.render の通し番号。待ちから戻ったとき、いちばん新しい描画だけが上の 3 つを書く
let queue = Promise.resolve() // コマンドと読み直し後の再開は 1 本ずつ順に処理する(連打しても前の結果を見てから動く)
let muted = false // 消音(session.start で $.store から読む)
let vocal = false // 歌入りで鳴らす(session.start で $.store から読む)
let cue = null // 次の周の頭の伴奏を頼む予定(Timer)
let take = 0 // 伴奏の世代: 伴奏を止める(silence)たびに 1 増える。予約の処理は待ちから戻ったとき、違っていれば何もしない
const playing = new Set() // 鳴っている伴奏の AbortController
let soundBroken = '' // 伴奏を鳴らせなかった理由(次に頭から踊り始めるまで、もう頼まない)

/** 列の後ろに並べる。前の処理が失敗しても列は止めない。 */
function enqueue(job) {
  const run = queue.then(job)
  queue = run.catch(() => {})
  return run
}

/** 経過時間 → 今の拍。 */
async function currentBeat($) {
  return beatAt((await $.clock.now()) - startedAt, speed)
}

/** カウント表示の中身。拍が変わったかの比較にも使う。 */
export function labelOf(beat, sp = 1) {
  const { label, count } = countAt(beat)
  return { label, count, slow: sp < 1, key: `${label}|${count}|${sp}` }
}

/** 下の 2 行(カウントと字幕)の中身。key が変わったときだけ描き直す。 */
export function footerOf(beat, sp = 1) {
  const label = labelOf(beat, sp)
  const lyric = lyricAt(beat)
  return { ...label, lyric, key: `${label.key}#${lyric.key}` }
}

/** 伴奏を鳴らすか: 消音でない・ふつうの速さ・鳴らせなかったことがない。 */
const wantsSound = () => !muted && speed === 1 && !soundBroken

/** 伴奏を止める(鳴っているものも、次の周の予約も、待っている予約の処理も)。 */
function silence() {
  take++
  if (cue) cue.cancel()
  cue = null
  for (const c of playing) c.abort()
  playing.clear()
}

/** k 周目の頭の伴奏を鳴らし、次の周の分を予約する。世代(踊り my・伴奏 t)が変わっていれば何もしない。 */
function playLoop($, my, t, k) {
  if (my !== gen || t !== take || !wantsSound()) return
  const c = new AbortController()
  playing.add(c)
  let played
  try {
    played = $.audio.play({ asset: vocal ? VOCAL_CLIP : CLIP }, { signal: c.signal })
  } catch (err) {
    played = Promise.reject(err)
  }
  played.then(
    () => playing.delete(c),
    (err) => {
      playing.delete(c)
      if (!c.signal.aborted) soundFailed($, my, t, err?.message ?? String(err)) // 止めたら resolve のはずだが、念のため数えない
    },
  )
  cueLoop($, my, t, k + 1).catch((err) => soundFailed($, my, t, err?.message ?? String(err)))
}

/**
 * k 周目の頭(踊りの時計で startedAt + k 周)の AUDIO_LEAD_MS 前に、伴奏を頼む予約を入れる。
 * その時刻が LATE_MS より前に過ぎていたら(スリープからの復帰などで予約が大きく遅れた)、過ぎた周は飛ばして
 * 次に間に合う周を予約する(過ぎた周の分をまとめて鳴らさない)。
 */
async function cueLoop($, my, t, k) {
  const now = await $.clock.now()
  if (my !== gen || t !== take || !wantsSound()) return
  const first = startedAt - AUDIO_LEAD_MS // 0 周目を頼む時刻
  k = Math.max(k, Math.ceil((now - LATE_MS - first) / LOOP_MS))
  const at = first + k * LOOP_MS
  if (cue) cue.cancel()
  cue = $.clock.after(Math.max(0, at - now), () => {
    cue = null
    onCue($, my, t, k, at).catch((err) => soundFailed($, my, t, err?.message ?? String(err)))
  })
}

/** 予約の時刻が来た: 遅れすぎていなければ鳴らす。遅れすぎていたら(予約そのものが遅れて届いた)その周は鳴らさず、次の周を予約する。 */
async function onCue($, my, t, k, at) {
  const now = await $.clock.now()
  if (my !== gen || t !== take || !wantsSound()) return
  if (now - at > LATE_MS) return cueLoop($, my, t, k + 1)
  playLoop($, my, t, k)
}

/** 伴奏を鳴らせなかった: 次に頭から踊り始めるまで頼まない。debug ログに 1 行・ペインに小さく出す。 */
function soundFailed($, my, t, why) {
  if (my !== gen || t !== take || soundBroken) return
  soundBroken = why || '理由不明'
  silence()
  try {
    $.ui.log(`inmu-king: 伴奏を鳴らせませんでした(${soundBroken})`, { to: 'debug' })
    $.ui.invalidate('ui.render')
  } catch {
    // 書けなくても、もう頼まないのは済んでいる
  }
}

/** タイマーを止める(伴奏も)。舞台の大きさは覚えたまま(ペインが開いていれば、また踊り出せる)。 */
function stop() {
  gen++
  if (timer) timer.cancel()
  timer = null
  silence()
  busy = false
  lastCells = ''
  lastLabel = ''
}

/** ペインが閉じた: 止めて、舞台の大きさも忘れる(次に開いたら ui.render が決め直す)。待っている描画にも書かせない。 */
function closed() {
  stop()
  layout = null
  renders++
}

/**
 * 速さ sp で踊り始める。keep なら今の拍から続ける(拍は始める時刻と同じ時刻から出す)、でなければ頭から。
 * 頭から・ふつうの速さ・消音でなければ伴奏も鳴らす(踊りの頭を AUDIO_LEAD_MS 遅らせ、音の出だしに合わせる)。
 * 途中から続けるとき(ゆっくりへの切り替え)は鳴らさない。
 * 始めたら true。時刻を待つあいだに別の開始・停止があった、または ok() が偽になったら何もせず false
 * (今の踊りと伴奏はそのまま)。
 */
async function start($, sp, keep = false, ok = () => true) {
  const my = gen
  const now = await $.clock.now()
  if (my !== gen || !ok()) return false
  const from = keep ? beatAt(now - startedAt, speed) : LOOP_START
  stop()
  const mine = gen
  speed = sp
  if (!keep) soundBroken = '' // 頭から始めるときは、前に鳴らせなかった伴奏ももう一度試す
  const sound = !keep && wantsSound()
  startedAt = now - elapsedAt(from, sp) + (sound ? AUDIO_LEAD_MS : 0)
  ticks = 0
  shown = true
  failures = 0
  timer = $.clock.every(FRAME_MS, () => tick($, mine).catch((err) => failed($, mine, err?.message ?? String(err))))
  if (sound) playLoop($, mine, take, 0)
  // カウント表示(ゆっくり)を描き直す。ホットリロードの直後なら舞台の大きさもここで決まる
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // 描き直しを頼めなくても、次に拍が変わったときにまた頼む
  }
  return true
}

/** 描き替えの失敗を数える。続けて DENY_LIMIT 回で止め、debug ログに 1 行残す。古い世代の失敗は数えない。 */
function failed($, my, why) {
  if (my !== gen) return
  if (++failures < DENY_LIMIT) return
  stop()
  try {
    $.ui.log(`inmu-king: 描き替えが続けて失敗したので止めました(${why})`, { to: 'debug' })
  } catch {
    // ログに残せなくても止めるのは済んでいる
  }
}

/** 1 コマ進める。前のコマの処理が終わっていなければ飛ばす(遅い端末で溜めない)。 */
async function tick($, my) {
  if (busy || my !== gen) return
  busy = true
  try {
    ticks++
    if (ticks % CHECK_EVERY === 0) {
      const pane = (await $.ui.panes()).find((p) => p.id === PANE)
      if (my !== gen) return
      if (!pane) return closed() // 閉じる知らせが届かなかったとき(描画の失敗で外された等)の後始末
      shown = pane.isShown && pane.isPlaced
    }
    if (!shown) return // 裏のタブ: 計算もしない
    if (!layout) {
      // まだ描かれていない(/clear・読み直しの後で、描き直しの頼みが届かなかった等): ときどき頼み直す
      if (ticks % CHECK_EVERY === 0) $.ui.invalidate('ui.render')
      return
    }
    const beat = await currentBeat($)
    if (my !== gen || !layout) return
    const at = layout
    const cells = frameCells(posesAt(beat), at)
    if (cells !== lastCells) {
      const r = await $.ui.blit({ requestId: PANE, key: RASTER_KEY, cells, columns: at.columns, rows: at.rows })
      if (my !== gen || layout !== at) return // 送っているあいだに描き直された: 古い大きさの結果は数えない
      if (r && r.deny) {
        // 大きさが変わった直後などは一時的に断られる。続くときだけ止める
        failed($, my, r.deny)
        if (my !== gen) return
      } else {
        failures = 0
        lastCells = cells
      }
    }
    const key = footerOf(beat, speed).key
    if (key !== lastLabel) {
      lastLabel = key
      $.ui.invalidate('ui.render')
    }
  } finally {
    if (my === gen) busy = false
  }
}

/** ペインの様子: open(pane つき)・closed・unknown(一覧を取れなかった。why に理由)。 */
async function paneState($) {
  try {
    const pane = (await $.ui.panes()).find((p) => p.id === PANE)
    return pane ? { state: 'open', pane } : { state: 'closed' }
  } catch (err) {
    return { state: 'unknown', why: err?.message ?? String(err) }
  }
}

/**
 * この mod として閉じ、閉じたかを一覧で確かめる: closed・open(ほかの hook が止めた)・unknown・failed(閉じる頼みが失敗)。
 * 止めるのは ui.close の hook(人が閉じたときと同じ道)。この閉じる知らせでは頼みを取り消さない。
 */
async function closeSelf($) {
  try {
    await $.ui.close({ id: PANE })
  } catch (err) {
    return { state: 'failed', why: err?.message ?? String(err) }
  }
  return paneState($)
}

const USAGE = `使い方: /${COMMAND}(開く・閉じる)・/${COMMAND} slow(ゆっくり・音なし)・/${COMMAND} mute(音を消す・戻す)・/${COMMAND} vocal(歌入り・歌なしを切り替える)`
const INTERRUPTED =
  'INMU KING: 待っているあいだにペインを閉じる操作かセッションの終わりがあったので、踊りを始めませんでした(もう一度 /inmu-king で開きます)'
const NOT_STARTED = 'INMU KING: 踊りを始められませんでした(もう一度 /inmu-king で試せます)'

/** 踊っているペインを閉じる(もう一度 /inmu-king)。閉じたかは一覧で確かめてから答える。 */
async function toggleClose($) {
  const after = await closeSelf($)
  if (after.state === 'failed') return { text: `INMU KING を閉じられませんでした(${after.why})` }
  if (after.state === 'open') return { text: 'INMU KING を閉じられませんでした(ペインが残っています)' }
  if (after.state === 'unknown') return { text: `INMU KING を閉じたか確かめられませんでした(${after.why})` }
  return { text: 'INMU KING を閉じました' }
}

/** 始めなかった頼みが開いたペインを片付ける(もう閉じられていれば何もしない)。片付けられなかったら、そう書き足す。 */
async function abandon($, text) {
  const now = await paneState($)
  if (now.state === 'closed') return { text }
  const after = await closeSelf($)
  if (after.state === 'closed') return { text }
  if (after.state === 'unknown') return { text: `${text}。開いたペインを閉じたか確かめられませんでした(${after.why})` }
  return { text: `${text}。開いたペインを閉じられませんでした(${after.state === 'open' ? 'ペインが残っています' : after.why})` }
}

/**
 * 消音を切り替える(/inmu-king mute・ペインのボタン。1 本ずつ順に呼ばれる)。$.store に覚える。
 * 音を戻したとき、ふつうの速さで踊っていれば頭から音つきで踊り直す(伴奏は 1 周の頭からしか鳴らせない)。
 */
async function toggleMute($, ok = () => true) {
  muted = !muted
  if (muted) silence() // 覚え終わるのを待たずに止める
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // ボタンの表示は次に拍が変わったときに直る
  }
  try {
    await $.store.set(MUTED_KEY, muted)
  } catch {
    // 覚えられなくても、このセッションの切り替えは効く
  }
  if (muted) return { text: 'INMU KING の音を消しました(戻すときは /inmu-king mute)' }
  if (timer === null) return { text: 'INMU KING の音を出す設定にしました(次に踊るときから鳴ります)' }
  if (speed !== 1) return { text: 'INMU KING の音を出す設定にしました(ゆっくりのあいだは鳴りません)' }
  if (!(await start($, 1, false, ok).catch(() => false))) return { text: 'INMU KING の音を出す設定にしました(次に踊るときから鳴ります)' }
  return { text: 'INMU KING の音を出します(頭から踊り直します)' }
}

/**
 * 歌入り・歌なし(インスト)を切り替える(/inmu-king vocal・ペインのボタン。1 本ずつ順に呼ばれる)。$.store に覚える。
 * 鳴っている伴奏はすぐ止める。ふつうの速さで音つきで踊っていれば、頭から新しい伴奏で踊り直す
 * (伴奏は 1 周の頭からしか鳴らせない)。消音・ゆっくり・閉じているときは設定だけ変える。
 */
async function toggleVocal($, ok = () => true) {
  vocal = !vocal
  silence() // 覚え終わるのを待たずに、前の伴奏(と予約)を止める
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // ボタンの表示は次に拍が変わったときに直る
  }
  try {
    await $.store.set(VOCAL_KEY, vocal)
  } catch {
    // 覚えられなくても、このセッションの切り替えは効く
  }
  const set = `INMU KING の音を${vocal ? '歌入り' : '歌なし(インスト)'}にしました`
  if (muted) return { text: `${set}(今は音を消しています。/inmu-king mute で出せます)` }
  if (timer === null) return { text: `${set}(次に踊るときから鳴ります)` }
  if (speed !== 1) return { text: `${set}(ゆっくりのあいだは鳴りません)` }
  if (!(await start($, 1, false, ok).catch(() => false))) return { text: `${set}(次に踊るときから鳴ります)` }
  return { text: `${set}(頭から踊り直します)` }
}

/**
 * /inmu-king の中身(1 本ずつ順に呼ばれる)。ticket は受け取ったときの取り消し番号。
 * 待ちから戻るたびに、そのあいだに人やほかの mod がペインを閉じようとした・セッションが終わったなら、
 * 古い頼みとして踊りを始めない(閉じたペインを勝手に開き直さない)。この頼みが開いたペインは片付ける。
 */
async function command($, e, ticket) {
  const arg = String(e.args ?? '').trim().toLowerCase()
  const valid = () => ticket === cancels
  if (MUTE_ARGS.has(arg)) return toggleMute($, valid)
  if (VOCAL_ARGS.has(arg)) return toggleVocal($, valid)
  const sp = SPEEDS.get(arg)
  if (sp === undefined) return { text: USAGE }
  if (!valid()) return { text: INTERRUPTED }
  const now = await paneState($)
  if (!valid()) return { text: INTERRUPTED }
  if (now.state === 'unknown') return { text: `INMU KING: ペインの様子を確かめられませんでした(${now.why})` }
  const dancing = now.state === 'open' && timer !== null
  if (dancing && sp === 1) return toggleClose($)
  let placed = now.pane?.isPlaced ?? false
  let reason
  let openedHere = false
  if (now.state === 'closed') {
    // 開いていれば開き直さない(速さの切り替え・止まっていたペインの再開): 閉じられたペインを作り直す道を持たない
    // 閉じていると確かめた: 前のペインの踊りと大きさを忘れ、世代を進めてから開く。
    // 開く前に読まれた古い一覧(遅れて戻る閉じる確認・タイマーの見回り)が、これから開くペインの踊りを止めないように
    closed()
    let opened
    try {
      opened = await $.ui.open({ id: PANE, title: 'INMU KING', rows: PANE_ROWS, columns: PANE_COLUMNS, closeOnEscape: true })
    } catch (err) {
      return { text: `INMU KING を開けませんでした(${err?.message ?? err})` }
    }
    openedHere = true
    if (!valid()) return abandon($, INTERRUPTED) // 開くあいだに閉じる操作・セッションの終わりがあった
    placed = opened.isPlaced
    reason = opened.reason
  }
  // 踊っている最中の速さの切り替えは、今の拍から続ける
  if (!(await start($, sp, dancing, valid).catch(() => false))) {
    const text = valid() ? NOT_STARTED : INTERRUPTED
    return openedHere ? abandon($, text) : { text } // 前から開いていたペインは閉じない
  }
  if (!placed) return { text: `INMU KING: 今は表示できません(${reason ?? '場所が足りません'})。端末を広げると出ます` }
  return { text: sp < 1 ? 'INMU KING をゆっくり踊ります(閉じるときは もう一度 /inmu-king)' : 'INMU KING を踊ります(閉じるときは もう一度 /inmu-king)' }
}

/** 読み直し(ホットリロード)の後、ペインが開いたままなら頭から踊り直す。 */
async function resume($, ticket) {
  const now = await paneState($)
  if (ticket !== cancels || now.state !== 'open') return
  await start($, 1, false, () => ticket === cancels)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const ticket = cancels
    try {
      await $.command.register({
        name: COMMAND,
        description: '5 体の Clawd が INMU KING のサビを踊るペインを開く(もう一度で閉じる・slow でゆっくり・mute で音を消す・vocal で歌入りに切り替える)',
        argumentHint: '[slow|mute|vocal]',
        immediate: true,
      })
    } catch {
      // 登録に失敗してもセッションは止めない
    }
    // 消音と歌入りの設定を読み、開いたまま読み直されたら踊り直す。コマンド・ボタンと同じ列に並ぶ
    // (読んでいるあいだの切り替えを、遅れて戻った古い値で上書きしない)
    await enqueue(async () => {
      try {
        muted = (await $.store.get(MUTED_KEY)) === true
      } catch {
        // 読めなければ音あり
      }
      try {
        vocal = (await $.store.get(VOCAL_KEY)) === true
      } catch {
        // 読めなければ歌なし
      }
      await resume($, ticket)
    }).catch(() => {})
    return next(e)
  })

  // /clear でもセッションは終わる(その後は新しいセッション ID で続き、session.start は来ない)。
  // 止めて、待っている頼みは取り消すが、この後のコマンドはふつうに受け付ける
  on('session.end', ($, e, next) => {
    cancels++
    closed()
    return next(e)
  })

  on('command.run', { command: COMMAND }, ($, e) => {
    const ticket = cancels // 受け取った時点の番号
    return enqueue(() => command($, e, ticket))
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    // 人(person)・ほかの mod・読み直し(unload)が閉じようとした: 待っているコマンドは踊りを始めない。
    // この mod 自身の閉じる(もう一度 /inmu-king・片付け)では取り消さない(続けて打った /inmu-king は開き直す)
    const own = e.origin?.kind === 'plugin' && next.origin?.plugin === $.plugin.name
    if (!own) cancels++
    // 世代は閉じる前に取る: 閉じ終わるまでのあいだに開き直されていたら(開く直前に世代が進む)、
    // この閉じるの確認は古いので、新しい踊りを止めない
    const my = gen
    const out = await next(e)
    if (my !== gen) return out
    // 閉じたかは一覧で確かめる: ほかの hook が止めていたら残っている(踊りも続ける)・確かめられなければタイマーの確認に任せる
    const after = await paneState($)
    if (after.state === 'closed' && my === gen) closed() // 確かめるあいだに開き直されていたら、新しい踊りは止めない
    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    if (e.surface !== 'terminal' || !el.Raster) return Text({ dimColor: true, children: 'INMU KING は端末でだけ踊れます' })
    const props = e.props ?? e
    const next = layoutFor(props.bodyColumns, props.scroll?.bodyRows)
    const seq = ++renders
    const beat = timer ? await currentBeat($) : beatAt(0)
    const cells = frameCells(posesAt(beat), next)
    const { label, count, slow, lyric, key } = footerOf(beat, speed)
    if (seq === renders) {
      // 待っているあいだに新しい描画(開き直し・大きさの変化)が始まっていたら、そちらに任せる
      layout = next
      lastCells = cells
      lastLabel = key
    }
    const counts = []
    for (let i = 1; i <= 8; i++) counts.push(Text({ bold: i === count, dimColor: i !== count, children: ` ${i}` }))
    // 音のボタン: 消音と、歌入り・歌なし。鳴らせなかったときは出さない。
    // ゆっくりのあいだは音が鳴らず、横にも入らない(寄せた幅 64 桁)ので、歌のボタンは出さない(コマンドでは切り替えられる)。
    // 押したときの取り消し番号を持つ: 待つあいだにペインが閉じられたら、音つきで踊り直さない
    const sound = soundBroken
      ? [Text({ dimColor: true, children: '(音を出せませんでした)' })]
      : [
          Button({
            key: SOUND_KEY,
            plain: true,
            hotkey: 'm',
            dimColor: true,
            label: muted ? '音を出す' : '音を消す',
            onPress: () => {
              const ticket = cancels
              enqueue(() => toggleMute($, () => ticket === cancels)).catch(() => {})
            },
          }),
          ...(slow
            ? []
            : [
                Text({ dimColor: true, children: '  ' }),
                Button({
                  key: TRACK_KEY,
                  plain: true,
                  hotkey: 'v',
                  dimColor: true,
                  label: vocal ? '歌を消す' : '歌を出す',
                  onPress: () => {
                    const ticket = cancels
                    enqueue(() => toggleVocal($, () => ticket === cancels)).catch(() => {})
                  },
                }),
              ]),
        ]
    // 字幕: 歌った字はオレンジ、まだの字は薄く。行が無いときも 1 行あける
    const chars = [...lyric.text]
    const words = lyric.interlude
      ? [Text({ color: LYRIC_COLOR, children: lyric.text })]
      : [
          ...(lyric.sung > 0 ? [Text({ color: LYRIC_COLOR, children: chars.slice(0, lyric.sung).join('') })] : []),
          ...(lyric.sung < chars.length ? [Text({ dimColor: true, children: chars.slice(lyric.sung).join('') })] : []),
        ]
    return Box({
      flexDirection: 'column',
      alignItems: 'center',
      children: [
        el.Raster({ key: RASTER_KEY, columns: next.columns, rows: next.rows, cells }),
        Box({
          flexDirection: 'row',
          children: [
            Text({ bold: true, children: label }),
            Text({ dimColor: true, children: '  ' }),
            ...counts,
            ...(slow ? [Text({ dimColor: true, children: '  (ゆっくり)' })] : []),
            Text({ dimColor: true, children: '   ' }),
            ...sound,
          ],
        }),
        Box({ flexDirection: 'row', children: words.length ? words : [Text({ children: ' ' })] }),
      ],
    })
  })
}
