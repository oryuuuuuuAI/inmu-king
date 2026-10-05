import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
// @ts-ignore 本体は型宣言のない JS(tsconfig は共通のまま変えない)
import { AUDIO_LEAD_MS, CHECK_EVERY, CLIP, COMMAND, DENY_LIMIT, FRAME_MS, LATE_MS, LOOP_MS, LYRIC_COLOR, MUTED_KEY, PANE, PANE_COLUMNS, PANE_ROWS, RASTER_KEY, SOUND_KEY, TRACK_KEY, VOCAL_CLIP, VOCAL_KEY } from '../hooks/register.js'
// @ts-ignore 同上
import { layoutFor } from '../hooks/stage.js'
// @ts-ignore 同上
import { BPM, LOOP_BEATS } from '../hooks/choreo.js'
// @ts-ignore 同上
import { INTERLUDE, LINES } from '../hooks/lyrics.js'

// コマンド・ペイン・タイマー・伴奏の試験。Claude Code 側(ペインの一覧・blit・open/close・音・保存)は world で差し替える。
// 音の試験以外は消音で始める(音ありだと踊りの頭が AUDIO_LEAD_MS 遅れ、拍の時刻がずれるため)。

const NOW = Date.parse('2026-10-05T00:00:00Z')
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const BEAT_MS = 60000 / BPM // 1 拍(BPM 133 で約 451 ms)

const paneProps = (bodyColumns: number, bodyRows: number) => ({
  title: 'INMU KING',
  isFocused: false,
  bodyColumns,
  placement: 'inline',
  scroll: { offset: 0, bodyRows },
  view: {},
})
const mountArgs = (surface = 'terminal', columns = 130, rows = 16) => ({
  plugin: 'inmu-king',
  surface,
  component: 'Pane',
  requestId: PANE,
  props: paneProps(columns, rows),
  viewport: { columns: 140, rows: 40 },
})

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

function engine(on: On, store: Record<string, unknown> = { [MUTED_KEY]: true }) {
  const world = {
    panes: [] as Pane[],
    isPlaced: true,
    opens: [] as any[],
    closes: [] as any[],
    blits: [] as any[],
    blitDeny: undefined as string | undefined, // blit が { deny } を返す
    blitReject: undefined as string | undefined, // hook が断る: $.ui.blit そのものが失敗する
    closeDelay: 0, // 閉じる知らせが届き終わるまでの時間(一覧からはすぐ消える)
    closeRefused: false, // ほかの hook が閉じるのを止めた(ペインが残る)
    openDelay: 0, // 開き終わるまでの時間
    openDeny: undefined as string | undefined, // 開くのを断る($.ui.open が失敗する)
    panesDelays: [] as number[], // ペインの一覧の返事を、呼ばれた順にこの時間ずつ遅らせる(1 回に 1 つ使う)
    panesLate: [] as number[], // ペインの一覧を呼ばれたときに読み、返事だけ遅らせる(呼ばれた順に 1 回に 1 つ使う)
    panesReject: undefined as string | undefined, // ペインの一覧そのものが失敗する
    panesFailAfterClose: undefined as string | undefined, // 閉じる知らせの後から、一覧が失敗するようになる
    logs: [] as any[],
    commands: [] as any[],
    plays: [] as any[], // $.audio.play を頼まれた時刻と中身
    playDeny: undefined as string | undefined, // 鳴らせない($.audio.play が失敗する)
    playMs: 0, // 1 回の伴奏が鳴り終わるまでの時間(0 ならすぐ終わる。止められたらそこで終わる)
    store: { ...store } as Record<string, unknown>, // $.store の中身(試験から読み書きする)
    storeSetDelay: 0, // 保存し終わるまでの時間(書くのは終わってから)
    storeGetLate: 0, // 読んだときの値を、この時間だけ遅らせて返す
  }
  const clock = mock.clock(on, { now: NOW })
  on('store.get', async (_$: any, e: any): Promise<any> => {
    const seen = world.store[e.key]
    if (world.storeGetLate) await clock.sleep(world.storeGetLate)
    return { value: seen }
  })
  on('store.set', async (_$: any, e: any): Promise<any> => {
    if (world.storeSetDelay) await clock.sleep(world.storeSetDelay)
    world.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any): any => (delete world.store[e.key], { value: undefined }))
  on('store.keys', (): any => ({ value: Object.keys(world.store) }))
  on('audio.play', async (_$: any, e: any, next: any): Promise<any> => {
    world.plays.push({ at: clock.now(), ...e, signal: next.signal })
    if (world.playDeny) return { deny: world.playDeny }
    if (world.playMs) await Promise.race([clock.sleep(world.playMs), new Promise((r) => next.signal.addEventListener('abort', r))])
    return { value: undefined }
  })
  on('session.start', (_$: any, e: any): any => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', (_$: any, e: any): any => ({ sessionId: e.sessionId }))
  on('command.register', (_$: any, e: any): any => (world.commands.push(e), { value: { command: e.name } }))
  on('ui.open', async (_$: any, e: any): Promise<any> => {
    world.opens.push(e)
    if (world.openDeny) return { deny: world.openDeny }
    if (world.openDelay) await clock.sleep(world.openDelay)
    if (!world.panes.some((p) => p.id === e.id)) {
      world.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: world.isPlaced })
    }
    return { value: world.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is too narrow' } }
  })
  on('ui.close', async (_$: any, e: any): Promise<any> => {
    world.closes.push(e)
    if (world.panesFailAfterClose) world.panesReject = world.panesFailAfterClose
    if (world.closeRefused) return { value: undefined }
    world.panes = world.panes.filter((p) => p.id !== e.id)
    if (world.closeDelay) await clock.sleep(world.closeDelay)
    return { value: undefined }
  })
  on('ui.panes', async (): Promise<any> => {
    const late = world.panesLate.shift() ?? 0
    if (late) {
      const seen = world.panes.map((p) => ({ ...p }))
      await clock.sleep(late)
      return { value: seen }
    }
    const d = world.panesDelays.shift() ?? 0
    if (d) await clock.sleep(d)
    if (world.panesReject) return { deny: world.panesReject }
    return { value: world.panes }
  })
  on('ui.blit', (_$: any, e: any): any => {
    world.blits.push(e)
    if (world.blitReject) return { deny: world.blitReject }
    return { value: world.blitDeny ? { deny: world.blitDeny } : {} }
  })
  on('ui.log', (_$: any, e: any): any => (world.logs.push(e), { value: undefined }))
  return { clock, world }
}

/** 描いた木から、型 type の要素を全部拾う。 */
function collect(node: any, type: string, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (node.type === type) out.push(node)
  for (const c of node.children ?? []) collect(c, type, out)
  return out
}
const textOf = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join('')

/**
 * 人がペインを閉じる代わり。試験の $ には ui.close が無いので、閉じるだけのコマンドを持つ
 * インライン plugin を並べて読み込み、その hook から閉じる(inmu-king の ui.close hook を通る)。
 */
const CLOSER = {
  name: 'closer',
  register: (on: On) => {
    on('command.run', { command: 'test-close' }, async ($: any, e: any): Promise<any> => {
      await $.ui.close({ id: e.args })
      return { text: 'closed' }
    })
  },
}
/**
 * 次の 1 回だけ $.clock.now() を遅らせる(args が 'fail' なら失敗させる)インライン plugin(試験の on には時計の hook を 2 つ置けない)。
 * インライン plugin は自分の環境で動き、試験の変数を読めないので、遅らせる長さはコマンドで渡す。
 * 遅れて戻った古い描画が、そのあいだに始まった新しい描画を上書きしないかを見る。
 */
const SLOW_NOW = {
  name: 'slow-now',
  register: (on: On) => {
    let once = ''
    on('command.run', { command: 'test-slow-now' }, (_$: any, e: any): any => {
      once = String(e.args ?? '')
      return { text: 'ok' }
    })
    on('clock.now', async ($: any, e: any, next: any): Promise<any> => {
      const d = once
      once = ''
      if (d === 'fail') return { deny: 'clock unavailable' }
      if (Number(d)) await $.clock.sleep(Number(d))
      return next(e)
    })
  },
}
/** 次の n 回の $.ui.invalidate を、エンジンに届く前に捨てるインライン plugin(描き直しの頼みが届かなかったとき)。 */
const DROP_INVALIDATE = {
  name: 'drop-invalidate',
  register: (on: On) => {
    let drop = 0
    on('command.run', { command: 'test-drop-invalidate' }, (_$: any, e: any): any => {
      drop = Number(e.args) || 0
      return { text: 'ok' }
    })
    on('ui.invalidate', (_$: any, e: any, next: any): any => {
      if (drop > 0) {
        drop--
        return { value: undefined }
      }
      return next(e)
    })
  },
}
/**
 * 次の 1 回の $.clock.after を、頼んだ時間より ms 遅らせて届けるインライン plugin(スリープからの復帰などで予約が遅れたとき)。
 * ms が負なら早める(1 周待たずに予約の発火を試すとき)。
 */
const LATE_AFTER = {
  name: 'late-after',
  register: (on: On) => {
    let late = 0
    on('command.run', { command: 'test-late-after' }, (_$: any, e: any): any => {
      late = Number(e.args) || 0
      return { text: 'ok' }
    })
    on('clock.after', (_$: any, e: any, next: any): any => {
      const d = late
      late = 0
      return next(d ? { ...e, ms: Math.max(0, e.ms + d) } : e)
    })
  },
}
const lateNextAfter = ($: any, ms: number) => $.command.run({ command: 'test-late-after', args: String(ms) } as any)
const slowNextNow = ($: any, ms: number | 'fail') => $.command.run({ command: 'test-slow-now', args: String(ms) } as any)
const dropInvalidates = ($: any, n: number) => $.command.run({ command: 'test-drop-invalidate', args: String(n) } as any)
const closePane = ($: any, id: string) => $.command.run({ command: 'test-close', args: id } as any)

async function openAndMount($: any, clock: any, args = '', columns = 130, rows = 16) {
  await $.session.start(START as any)
  const reply = await $.command.run({ command: COMMAND, args } as any)
  const pane = await $.ui.mount(mountArgs('terminal', columns, rows) as any)
  await clock.settle()
  return { reply, pane }
}

describe('コマンドとペイン', () => {
  test('session.start で /inmu-king を登録する(ペインはまだ開かない)', async ($, on) => {
    const { world } = engine(on)
    const r = await $.session.start(START as any)
    expect(r.cwd).toBe('/work')
    expect(world.commands).toHaveLength(1)
    expect(world.commands[0]).toMatchObject({ name: 'inmu-king', argumentHint: '[slow|mute|vocal]', immediate: true })
    expect(world.opens).toHaveLength(0)
  })

  test('/inmu-king でペインを開き、舞台の Raster とカウントを描く', async ($, on) => {
    const { clock, world } = engine(on)
    const { reply, pane } = await openAndMount($, clock)
    expect(reply.text).toMatch(/踊ります/)
    expect(world.opens).toEqual([{ id: PANE, title: 'INMU KING', rows: PANE_ROWS, columns: PANE_COLUMNS, closeOnEscape: true }])
    const tree = await pane.drawn()
    const [raster, ...more] = collect(tree, 'Raster')
    expect(more).toHaveLength(0)
    expect(raster.props).toMatchObject({ key: RASTER_KEY, columns: 128, rows: 14 }) // 本体 130 桁: 間隔 25
    expect(raster.props.cells.length).toBe((128 * 14 * 12 * 4) / 3) // 1 マス 12 バイト = base64 16 文字
    const text = collect(tree, 'Text').map(textOf).join('')
    expect(text).toContain('キメポーズ')
    expect(text).toContain(' 1 2 3 4 5 6 7 8')
    await pane.unmount()
  })

  test('拍が変わるとカウントを描き直し、区間が変わると名前も変わる', async ($, on) => {
    const { clock } = engine(on)
    const { pane } = await openAndMount($, clock)
    const bold = async () => collect(await pane.drawn(), 'Text').filter((t: any) => t.props?.bold).map(textOf)
    expect(await bold()).toEqual(['キメポーズ', ' 5'])
    await clock.advance(BEAT_MS + FRAME_MS) // コマは FRAME_MS 刻み: 拍の境目のすぐ後のコマで描き直る
    expect(await bold()).toEqual(['キメポーズ', ' 6'])
    await clock.advance(3 * BEAT_MS)
    expect(await bold()).toEqual(['チャールストン', ' 1'])
    await pane.unmount()
  })

  test('タイマーが FRAME_MS ごとに blit でコマを差し替える(同じコマは送らない)', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(BEAT_MS) // 最初の 1 拍は直立のまま: 送るコマが無い
    expect(world.blits).toHaveLength(0)
    await clock.advance(2 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(5)
    expect(world.blits.length).toBeLessThanOrEqual((2 * BEAT_MS) / FRAME_MS + 1)
    for (const b of world.blits) expect(b).toMatchObject({ requestId: PANE, key: RASTER_KEY, columns: 128, rows: 14 })
    const distinct = new Set(world.blits.map((b: any) => b.cells))
    expect(distinct.size).toBe(world.blits.length)
    await pane.unmount()
  })

  test('続けて 2 回打つと、閉じてから開き直す(自分で閉じたことでは後のコマンドを取り消さない)', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    const first = $.command.run({ command: COMMAND, args: '' } as any)
    const second = $.command.run({ command: COMMAND, args: '' } as any)
    expect((await first).text).toMatch(/閉じました/)
    expect((await second).text).toMatch(/踊ります/)
    expect(world.closes).toHaveLength(1)
    expect(world.opens).toHaveLength(2)
    expect(world.panes).toHaveLength(1)
    await pane.unmount()
  })

  test('もう一度 /inmu-king で閉じ、タイマーが止まる', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/閉じました/)
    expect(world.closes.map((c: any) => c.id)).toEqual([PANE])
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('閉じる知らせ(ui.close)で止まる: 人が閉じたときと同じ道', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await closePane($, PANE)
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    // 閉じた後のコマンドは、また開く
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/踊ります/)
    expect(world.opens).toHaveLength(2)
    await pane.unmount()
  })

  test('閉じ終わる前に開き直したら、遅れて届いた古い閉じる知らせで新しい踊りを止めない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.closeDelay = 2 * BEAT_MS
    const closing = closePane($, PANE) // 一覧からは消えたが、知らせはまだ届き終わっていない
    await clock.settle()
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/踊ります/)
    expect(world.opens).toHaveLength(2)
    await clock.advance(world.closeDelay + 3 * BEAT_MS)
    await closing
    const n = world.blits.length
    await clock.advance(2 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  test('別のペインが閉じても止まらない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(BEAT_MS)
    await closePane($, 'someone-else')
    await clock.advance(2 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(5)
    await pane.unmount()
  })

  test('知らせなしにペインが一覧から消えたら、次の確認で止まる', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panes = []
    await clock.advance(CHECK_EVERY * FRAME_MS + FRAME_MS)
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('裏のタブ(isShown false)の間は描かず、表に戻ると続ける', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panes[0]!.isShown = false
    await clock.advance(CHECK_EVERY * FRAME_MS + FRAME_MS)
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    world.panes[0]!.isShown = true
    await clock.advance(CHECK_EVERY * FRAME_MS + 2 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  test('blit が断られ続けたら止まり、debug ログに残す', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.blitDeny = 'not mounted'
    // 数えるのは送ったコマだけ(前に描けた絵と同じコマは送らない)。DENY_LIMIT コマより前には止まらない
    await clock.advance((DENY_LIMIT - 1) * FRAME_MS)
    expect(world.logs).toHaveLength(0)
    await clock.advance(60 * FRAME_MS)
    expect(world.logs).toHaveLength(1)
    expect(world.logs[0]).toMatchObject({ to: 'debug' })
    expect(world.logs[0].text).toContain('not mounted')
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    // 止まった後のコマンドは閉じずに踊り直す
    world.blitDeny = undefined
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/踊ります/)
    expect(world.closes).toHaveLength(0)
    await pane.unmount()
  })

  test('blit そのものが失敗し続けても(hook が断る)止まり、debug ログに 1 行だけ残す', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.blitReject = 'refused by a hook'
    await clock.advance((DENY_LIMIT - 1) * FRAME_MS)
    expect(world.logs).toHaveLength(0)
    await clock.advance(60 * FRAME_MS)
    expect(world.logs).toHaveLength(1)
    expect(world.logs[0]).toMatchObject({ to: 'debug' })
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    expect(world.logs).toHaveLength(1)
    await pane.unmount()
  })

  test('一時的な deny(数回)では止まらない', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.blitDeny = 'size changed'
    await clock.advance(5 * FRAME_MS)
    world.blitDeny = undefined
    const n = world.blits.length
    await clock.advance(2 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    expect(world.logs).toHaveLength(0)
    await pane.unmount()
  })

  test('session.end でタイマーが止まる', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.session.end({ reason: 'other', sessionId: 's' } as any)
    const n = world.blits.length
    await clock.advance(4 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('/clear(session.end の後もそのまま続く)の後も、コマンドで踊り直せる(開いたペインは開き直さない)', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    const n = world.blits.length
    await clock.advance(2 * BEAT_MS)
    expect(world.blits.length).toBe(n) // いったん止まる
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/踊ります/)
    expect(world.opens).toHaveLength(1)
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n + 5)
    await pane.unmount()
  })

  test('/clear の後に踊り直すとき、描き直しの頼みが届かなくても、頼み直して踊り出す', { plugins: [DROP_INVALIDATE] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any) // 舞台の大きさを忘れる
    await dropInvalidates($, 1)
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/踊ります/)
    const n = world.blits.length
    await clock.advance(6 * BEAT_MS) // 頭からなら、直立 2 拍 → 手を組む 1 拍 → キメのまま → チャールストン
    expect(world.blits.length).toBeGreaterThan(n + 5)
    await pane.unmount()
  })

  test('開いたまま読み直された(session.start がもう一度来た)ら踊り直す', async ($, on) => {
    const { clock, world } = engine(on)
    world.panes.push({ id: PANE, title: 'INMU KING', isShown: true, isFocused: false, isPlaced: true })
    await $.session.start(START as any)
    const pane = await $.ui.mount(mountArgs() as any)
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(5)
    expect(world.opens).toHaveLength(0)
    await pane.unmount()
  })

  test('描かれたまま session.start がもう一度来ても(描き直しを待たずに)踊り続ける', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.session.start(START as any)
    await clock.settle()
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS) // 頭(直立 1 拍)から踊り直す
    expect(world.blits.length).toBeGreaterThan(n + 5)
    expect(world.opens).toHaveLength(1)
    await pane.unmount()
  })
})

describe('引数と場所', () => {
  test('slow は半分の速さで、(ゆっくり)と出す。開いたまま slow に切り替えても閉じない', async ($, on) => {
    const { clock, world } = engine(on)
    const { reply, pane } = await openAndMount($, clock, 'slow')
    expect(reply.text).toMatch(/ゆっくり/)
    const texts = async () => collect(await pane.drawn(), 'Text').map(textOf).join('')
    expect(await texts()).toContain('(ゆっくり)')
    await clock.advance(4 * BEAT_MS) // ふつうなら拍 0(チャールストン)、半分なら拍 −2
    expect(await texts()).toContain('キメポーズ')
    await clock.advance(4 * BEAT_MS + FRAME_MS)
    expect(await texts()).toContain('チャールストン')
    const again = await $.command.run({ command: COMMAND, args: ' SLOW ' } as any)
    expect(again.text).toMatch(/ゆっくり/)
    expect(world.closes).toHaveLength(0)
    await pane.unmount()
  })

  test('踊っている最中に slow へ切り替えると、今の拍から続け、コマも送り続ける', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    const texts = async () => collect(await pane.drawn(), 'Text').map(textOf).join('')
    await clock.advance(5 * BEAT_MS) // 拍 1(チャールストンの 2)
    expect(await texts()).toContain('チャールストン')
    const reply = await $.command.run({ command: COMMAND, args: 'slow' } as any)
    expect(reply.text).toMatch(/ゆっくり/)
    expect(world.closes).toHaveLength(0)
    const after = await texts()
    expect(after).toContain('チャールストン') // 頭(キメポーズ)に戻らない
    expect(after).toContain('(ゆっくり)')
    const n = world.blits.length
    await clock.advance(2 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    expect(await texts()).toContain('チャールストン')
    await pane.unmount()
  })

  test('時刻の返事が遅れても、slow への切り替えで拍が巻き戻らない(開き直しもしない)', { plugins: [SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    const bold = async () => collect(await pane.drawn(), 'Text').filter((t: any) => t.props?.bold).map(textOf)
    await clock.advance(5 * BEAT_MS) // 拍 1(チャールストンの 2)
    await slowNextNow($, 2 * BEAT_MS) // 切り替えが時刻を待つ
    const pending = $.command.run({ command: COMMAND, args: 'slow' } as any)
    await clock.advance(2 * BEAT_MS)
    expect((await pending).text).toMatch(/ゆっくり/)
    await clock.settle()
    // 待つあいだの 2 拍はふつうの速さで進んでいた: 拍 3(チャールストンの 4)から続ける(2 に戻らない)
    expect(await bold()).toEqual(['チャールストン', ' 4'])
    expect(world.opens).toHaveLength(1)
    await pane.unmount()
  })

  test('待っているあいだにペインが閉じられたら、古いコマンドは開き直さない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panesDelays = [BEAT_MS] // コマンドが「開いているか」を確かめる返事が遅れる
    const pending = $.command.run({ command: COMMAND, args: 'slow' } as any)
    await clock.settle()
    await closePane($, PANE)
    await clock.advance(BEAT_MS)
    expect((await pending).text).toMatch(/始めませんでした/)
    expect(world.opens).toHaveLength(1)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('待っているあいだにセッションが終わったら、古いコマンドは開き直さない', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panesDelays = [BEAT_MS]
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    await $.session.end({ reason: 'other', sessionId: 's' } as any)
    await clock.advance(BEAT_MS)
    expect((await pending).text).toMatch(/始めませんでした/)
    expect(world.opens).toHaveLength(1)
    expect(world.closes).toHaveLength(0)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('並んで待っていたコマンドも、閉じる操作の後には開き直さない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panesDelays = [BEAT_MS] // 先のコマンドの確認が遅れ、後のコマンドはその後ろで待つ
    const first = $.command.run({ command: COMMAND, args: 'slow' } as any)
    const second = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    await closePane($, PANE)
    await clock.advance(BEAT_MS)
    expect((await first).text).toMatch(/始めませんでした/)
    expect((await second).text).toMatch(/始めませんでした/)
    expect(world.opens).toHaveLength(1)
    expect(world.panes).toHaveLength(0)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  // 試験の道具からは人の閉じる(origin person)を出せないので、ほかの mod の閉じるで見る(自分以外はどちらも同じ道)
  test('自分で閉じているあいだにほかの mod も閉じたら、後ろで待っていたコマンドは開き直さない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.closeDelay = 2 * BEAT_MS // もう一度 /inmu-king の閉じる知らせが、届き終わるまで待たされる
    const first = $.command.run({ command: COMMAND, args: '' } as any)
    const second = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    const closing = closePane($, PANE)
    await clock.advance(2 * BEAT_MS)
    await closing
    expect((await first).text).toMatch(/閉じました/)
    expect((await second).text).toMatch(/始めませんでした/)
    expect(world.closes).toHaveLength(2)
    expect(world.opens).toHaveLength(1)
    expect(world.panes).toHaveLength(0)
    await pane.unmount()
  })

  test('閉じたかを確かめる返事が遅れても、そのあいだに古いコマンドが開き直さない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    // コマンドの確認・閉じた後の確認 の順に遅れる。コマンドの確認は、タイマーの次の見回り(CHECK_EVERY コマごと)より前に戻す
    world.panesDelays = [FRAME_MS, 2 * BEAT_MS]
    const pending = $.command.run({ command: COMMAND, args: 'slow' } as any)
    await clock.settle()
    const closing = closePane($, PANE)
    await clock.settle()
    await clock.advance(2 * BEAT_MS)
    await closing
    expect((await pending).text).toMatch(/始めませんでした/)
    expect(world.opens).toHaveLength(1)
    expect(world.panes).toHaveLength(0)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('ほかの mod が閉じた後の確認が遅れて戻っても、そのあいだに開き直したペインの踊りを止めない', { plugins: [CLOSER, SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panesLate = [2 * BEAT_MS] // 閉じた後の確認: 「ペインなし」を読んだまま、返事が遅れる
    const closing = closePane($, PANE)
    await clock.settle()
    expect(world.panes).toHaveLength(0)
    await slowNextNow($, 3 * BEAT_MS) // 開き直した後、始める時刻の返事は古い確認より後に戻る
    const reopened = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.opens).toHaveLength(2)
    await clock.advance(3 * BEAT_MS)
    await closing
    expect((await reopened).text).toMatch(/踊ります/)
    expect(world.closes).toHaveLength(1)
    expect(world.panes).toHaveLength(1)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  test('閉じ終わる前に開き直し始めたら、古い閉じるは開き終わる前の一覧で新しい踊りを止めない', { plugins: [CLOSER, SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.closeDelay = BEAT_MS // ほかの mod の閉じる知らせが届き終わるまで待たされる(一覧からはすぐ消える)
    const closing = closePane($, PANE)
    await clock.settle()
    world.openDelay = 2 * BEAT_MS // 開き直しは、古い閉じるが届き終わった後に開き終わる
    await slowNextNow($, 3 * BEAT_MS) // 始める時刻は、古い閉じるの確認より後に戻る
    const reopened = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.opens).toHaveLength(2)
    // 古い閉じるが届き終わった後の確認: 開き終わる前の「ペインなし」を読んだまま、返事が遅れる
    world.panesLate = [3 * BEAT_MS]
    await clock.advance(5 * BEAT_MS)
    world.panesLate = []
    await closing
    expect((await reopened).text).toMatch(/踊ります/)
    expect(world.closes).toHaveLength(1)
    expect(world.panes).toHaveLength(1)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  test('見回りの一覧が遅れて戻っても、そのあいだに開き直したペインの踊りを止めない', { plugins: [SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.panesLate = [2 * BEAT_MS] // タイマーの見回り: 「ペインなし」を読んだまま、返事が遅れる
    world.panes = [] // 閉じる知らせなしにペインが消えた
    await clock.advance(CHECK_EVERY * FRAME_MS) // この間に見回りが 1 回ある
    expect(world.panesLate).toHaveLength(0)
    await slowNextNow($, 3 * BEAT_MS)
    const reopened = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.opens).toHaveLength(2)
    await clock.advance(3 * BEAT_MS)
    expect((await reopened).text).toMatch(/踊ります/)
    expect(world.closes).toHaveLength(0)
    expect(world.panes).toHaveLength(1)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  test('踊っている最中の slow への切り替えでは開き直さない(閉じられたペインを作り直さない)', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.openDelay = BEAT_MS // 開き直すなら、そのあいだに閉じられる
    const pending = $.command.run({ command: COMMAND, args: 'slow' } as any)
    await clock.settle()
    await closePane($, PANE)
    await clock.advance(BEAT_MS)
    await pending
    expect(world.opens).toHaveLength(1)
    expect(world.panes).toHaveLength(0)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBe(n)
    await pane.unmount()
  })

  test('開くのを待つあいだにセッションが終わったら、開いたペインを片付ける', async ($, on) => {
    const { clock, world } = engine(on)
    await $.session.start(START as any)
    world.openDelay = BEAT_MS
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    await $.session.end({ reason: 'other', sessionId: 's' } as any)
    await clock.advance(BEAT_MS)
    expect((await pending).text).toMatch(/始めませんでした/)
    expect(world.opens).toHaveLength(1)
    expect(world.closes).toHaveLength(1)
    expect(world.panes).toHaveLength(0)
  })

  test('時刻を待つあいだにペインが閉じられたら、踊りを始めず、そう返す', { plugins: [CLOSER, SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    await $.session.start(START as any)
    await slowNextNow($, BEAT_MS) // 開いた後、始める時刻を待つ
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.opens).toHaveLength(1)
    world.closeDelay = 2 * BEAT_MS // 閉じる知らせが届き終わる(止める)より前に、時刻の返事が戻る
    const closing = closePane($, PANE)
    await clock.advance(BEAT_MS)
    expect((await pending).text).toMatch(/始めませんでした/)
    await clock.advance(BEAT_MS)
    await closing
    expect(world.panes).toHaveLength(0)
    const again = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(again.text).toMatch(/踊ります/)
    expect(world.opens).toHaveLength(2)
  })

  test('開いた後、時刻を待つあいだに /clear が来たら、開いたペインを片付ける', { plugins: [SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    await $.session.start(START as any)
    await slowNextNow($, BEAT_MS)
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.opens).toHaveLength(1)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await clock.advance(BEAT_MS)
    const reply = await pending
    expect(reply.text).toMatch(/始めませんでした/)
    expect(reply.text).not.toMatch(/閉じられませんでした|確かめられませんでした/)
    expect(world.closes.map((c: any) => c.id)).toEqual([PANE])
    expect(world.panes).toHaveLength(0)
  })

  test('時刻を取れずに始められなかったら、開いたペインを片付けてそう返す', { plugins: [SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    await $.session.start(START as any)
    await slowNextNow($, 'fail')
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/始められませんでした/)
    expect(world.closes).toHaveLength(1)
    expect(world.panes).toHaveLength(0)
    // 次はふつうに踊る
    const again = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(again.text).toMatch(/踊ります/)
    await clock.settle()
    expect(world.panes).toHaveLength(1)
  })

  test('片付けの閉じるが止められたら、ペインが残っていると返す', async ($, on) => {
    const { clock, world } = engine(on)
    await $.session.start(START as any)
    world.openDelay = BEAT_MS
    world.closeRefused = true
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    await $.session.end({ reason: 'other', sessionId: 's' } as any)
    await clock.advance(BEAT_MS)
    const reply = await pending
    expect(reply.text).toMatch(/始めませんでした/)
    expect(reply.text).toMatch(/開いたペインを閉じられませんでした\(ペインが残っています\)/)
    expect(world.closes).toHaveLength(1)
    expect(world.panes).toHaveLength(1)
  })

  test('片付けた後にペインの一覧を取れなければ、閉じたか確かめられなかったと返す', async ($, on) => {
    const { clock, world } = engine(on)
    await $.session.start(START as any)
    world.openDelay = BEAT_MS
    world.panesFailAfterClose = 'panes unavailable'
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    await $.session.end({ reason: 'other', sessionId: 's' } as any)
    await clock.advance(BEAT_MS)
    const reply = await pending
    expect(reply.text).toMatch(/始めませんでした/)
    expect(reply.text).toMatch(/開いたペインを閉じたか確かめられませんでした\(.*panes unavailable\)/)
  })

  test('前から開いていたペインは、取り消されても閉じない', { plugins: [SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any) // 止まるがペインは残る
    await slowNextNow($, BEAT_MS)
    const pending = $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await clock.advance(BEAT_MS)
    expect((await pending).text).toMatch(/始めませんでした/)
    expect(world.closes).toHaveLength(0)
    expect(world.panes).toHaveLength(1)
    await pane.unmount()
  })

  test('開くのを断られたら、そう返す', async ($, on) => {
    const { world } = engine(on)
    await $.session.start(START as any)
    world.openDeny = 'no panes here'
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/開けませんでした/)
    expect(reply.text).toContain('no panes here')
    expect(world.panes).toHaveLength(0)
  })

  test('ペインの様子を確かめられないときは、開かずにそう返す', async ($, on) => {
    const { world } = engine(on)
    await $.session.start(START as any)
    world.panesReject = 'panes unavailable'
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/確かめられませんでした/)
    expect(world.opens).toHaveLength(0)
  })

  test('閉じた後にペインの一覧を取れなければ、閉じたとは言わず踊り続ける', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.closeRefused = true
    world.panesFailAfterClose = 'panes unavailable'
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/閉じたか確かめられませんでした/)
    world.panesFailAfterClose = undefined
    world.panesReject = undefined
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  test('ほかの mod が閉じるのを止めたら、踊り続け、閉じられなかったと返す', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    world.closeRefused = true
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/閉じられませんでした/)
    await closePane($, PANE) // 人が閉じても止められた
    expect(world.closes).toHaveLength(2)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(n)
    await pane.unmount()
  })

  // 試験の道具は、遅れて戻った古い結果を捨ててすぐ今の props で描き直す。この試験は、最後に勝つのが新しい大きさであることだけを見る
  test('遅れて戻った古い描画は、あとから始まった描画の大きさを上書きしない', { plugins: [SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(BEAT_MS)
    await slowNextNow($, BEAT_MS) // 次の描画が時刻を待つ
    let oldDone = false
    const old = Promise.resolve(pane.redraw(paneProps(140, 16) as any)).then(() => (oldDone = true))
    await clock.settle()
    expect(oldDone).toBe(false) // 古い描画はまだ待っている
    await pane.redraw(paneProps(50, 16) as any)
    const n = world.blits.length
    await clock.advance(BEAT_MS) // ここで古い描画が戻る
    await old
    await clock.advance(2 * BEAT_MS)
    const later = world.blits.slice(n)
    expect(later.length).toBeGreaterThan(0)
    for (const b of later) expect(b.columns).toBe(layoutFor(50, 16).columns) // 古い大きさ(140 桁)のコマを送らない
    await pane.unmount()
  })

  test('閉じる前に始まった描画が閉じた後に戻っても、舞台の大きさを書き戻さない', { plugins: [CLOSER, SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(BEAT_MS)
    await slowNextNow($, BEAT_MS) // 次の描画が時刻を待つ
    const old = Promise.resolve(pane.redraw(paneProps(140, 16) as any))
    await clock.settle()
    await closePane($, PANE)
    await clock.advance(BEAT_MS) // ここで古い描画が戻る
    await old
    await pane.unmount()
    // 開き直す: 新しいペインがまだ描かれていないうちは、古い大きさのコマを送らない
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/踊ります/)
    const n = world.blits.length
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBe(n)
  })

  test('わからない引数は使い方を返し、ペインを開かない', async ($, on) => {
    const { world } = engine(on)
    await $.session.start(START as any)
    for (const args of ['fast', 'constructor', '__proto__', 'toString']) {
      const reply = await $.command.run({ command: COMMAND, args } as any)
      expect(reply.text).toMatch(/使い方/)
    }
    expect(world.opens).toHaveLength(0)
  })

  test('背の低いペインでは段を減らし(カウントと字幕に 2 段)、コマも同じ大きさで送る', async ($, on) => {
    const { clock, world } = engine(on)
    const { pane } = await openAndMount($, clock, '', 130, 5)
    const [raster] = collect(await pane.drawn(), 'Raster')
    expect(raster.props.rows).toBe(3)
    await clock.advance(3 * BEAT_MS)
    expect(world.blits.length).toBeGreaterThan(0)
    for (const b of world.blits) expect(b.rows).toBe(3)
    await pane.unmount()
  })

  test('場所が無くて置けないときは、そう返す(踊りは置かれたら見える)', async ($, on) => {
    const { world } = engine(on)
    world.isPlaced = false
    await $.session.start(START as any)
    const reply = await $.command.run({ command: COMMAND, args: '' } as any)
    expect(reply.text).toMatch(/表示できません/)
    expect(reply.text).toContain('the terminal is too narrow')
  })

  test('狭いペインでは小さい絵・3 体で、Raster はペインの幅を超えない', async ($, on) => {
    const { clock } = engine(on)
    const { pane } = await openAndMount($, clock, '', 50, 16)
    const [raster] = collect(await pane.drawn(), 'Raster')
    expect(raster.props.columns).toBeLessThanOrEqual(50)
    expect(raster.props.rows).toBe(11)
    await pane.unmount()
  })

  test('端末以外では 1 行の案内だけ(Raster は使わない)', async ($, on) => {
    engine(on)
    await $.session.start({ ...START, surface: 'desktop' } as any)
    const pane = await $.ui.mount(mountArgs('desktop') as any)
    const tree = await pane.drawn()
    expect(collect(tree, 'Raster')).toHaveLength(0)
    expect(textOf(tree)).toContain('端末でだけ踊れます')
    await pane.unmount()
  })
})

/** 下の 2 行目(字幕)の文字: all は行全体、sung はオレンジに塗った分。 */
async function lyricOf(pane: any) {
  const rows = collect(await pane.drawn(), 'Box').filter((b: any) => b.props?.flexDirection === 'row')
  const texts = collect(rows[rows.length - 1], 'Text')
  return {
    all: texts.map(textOf).join(''),
    sung: texts.filter((t: any) => t.props?.color === LYRIC_COLOR).map(textOf).join(''),
  }
}
const boldOf = async (pane: any) => collect(await pane.drawn(), 'Text').filter((t: any) => t.props?.bold).map(textOf)
const soundLabel = async (pane: any) => (await pane.find({ key: SOUND_KEY }))?.props?.label
const near = (a: number, b: number) => Math.abs(a - b) < 1

describe('伴奏', () => {
  test('音ありで開くと、すぐ伴奏を 1 回頼み、踊りの頭を AUDIO_LEAD_MS 遅らせる', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    expect(world.plays).toHaveLength(1)
    expect(world.plays[0]).toMatchObject({ at: NOW, clip: { asset: CLIP }, shouldLoop: false })
    expect(await soundLabel(pane)).toBe('音を消す')
    await clock.advance(BEAT_MS + FRAME_MS) // 遅らせた分だけ、まだ次の拍になっていない
    expect(await boldOf(pane)).toEqual(['キメポーズ', ' 5'])
    await clock.advance(AUDIO_LEAD_MS)
    expect(await boldOf(pane)).toEqual(['キメポーズ', ' 6'])
    await pane.unmount()
  })

  test('1 周ごとに、次の周の頭の AUDIO_LEAD_MS 前に鳴らし直す(時刻は踊りの時計から出す)', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    expect(near(LOOP_MS, (LOOP_BEATS * 60000) / BPM)).toBe(true)
    await clock.advance(3 * LOOP_MS + 10)
    expect(world.plays).toHaveLength(4)
    world.plays.forEach((p: any, k: number) => expect(near(p.at, NOW + k * LOOP_MS)).toBe(true))
    await pane.unmount()
  })

  test('slow では鳴らさない。踊っている最中に slow へ切り替えると、次の周も頼まない', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock, 'slow')
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(0)
    expect(await soundLabel(pane)).toBe('音を消す') // 消音にはしていない(ゆっくりのあいだ鳴らないだけ)
    await pane.unmount()
  })

  test('ふつうの速さから slow へ切り替えると、その後は頼まない', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.command.run({ command: COMMAND, args: 'slow' } as any)
    await clock.advance(3 * LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('もう一度 /inmu-king で閉じると、次の周を頼まない', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.command.run({ command: COMMAND, args: '' } as any)
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('人が閉じても(ui.close)、次の周を頼まない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await closePane($, PANE)
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('session.end(/clear)でも、次の周を頼まない', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('消音で始めると鳴らさず、ボタンは「音を出す」', async ($, on) => {
    const { clock, world } = engine(on, { [MUTED_KEY]: true })
    const { pane } = await openAndMount($, clock)
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(0)
    expect(await soundLabel(pane)).toBe('音を出す')
    await pane.unmount()
  })

  test('/inmu-king mute で消し(踊りは続く)、もう一度で戻すと頭から音つきで踊り直す。設定は保存する', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    await clock.advance(5 * BEAT_MS)
    const off = await $.command.run({ command: COMMAND, args: 'mute' } as any)
    expect(off.text).toMatch(/消しました/)
    expect(world.store[MUTED_KEY]).toBe(true)
    expect(world.opens).toHaveLength(1)
    expect(world.closes).toHaveLength(0)
    const n = world.blits.length
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(1) // 次の周の予約は消えた
    expect(world.blits.length).toBeGreaterThan(n) // 踊りは続く
    expect(await soundLabel(pane)).toBe('音を出す')
    const on2 = await $.command.run({ command: COMMAND, args: '消音' } as any)
    expect(on2.text).toMatch(/頭から/)
    expect(world.store[MUTED_KEY]).toBe(false)
    expect(world.plays).toHaveLength(2)
    expect(world.plays[1].at).toBe(clock.now())
    await clock.settle()
    expect(await boldOf(pane)).toEqual(['キメポーズ', ' 5']) // 頭から
    expect(await soundLabel(pane)).toBe('音を消す')
    await pane.unmount()
  })

  test('閉じているあいだの mute は設定だけ変え、開いていないペインを開かない', async ($, on) => {
    const { world } = engine(on, {})
    await $.session.start(START as any)
    const reply = await $.command.run({ command: COMMAND, args: 'mute' } as any)
    expect(reply.text).toMatch(/消しました/)
    const back = await $.command.run({ command: COMMAND, args: 'mute' } as any)
    expect(back.text).toMatch(/次に踊るとき/)
    expect(world.opens).toHaveLength(0)
    expect(world.plays).toHaveLength(0)
  })

  test('ゆっくりのあいだに音を戻しても鳴らさない(そう返す)', async ($, on) => {
    const { clock, world } = engine(on, { [MUTED_KEY]: true })
    const { pane } = await openAndMount($, clock, 'slow')
    const reply = await $.command.run({ command: COMMAND, args: 'mute' } as any)
    expect(reply.text).toMatch(/ゆっくりのあいだは鳴りません/)
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(0)
    await pane.unmount()
  })

  test('ペインのボタン(m)でも切り替える', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    expect((await pane.find({ key: SOUND_KEY }))?.props).toMatchObject({ hotkey: 'm' })
    await pane.press({ key: SOUND_KEY })
    await clock.settle()
    expect(await soundLabel(pane)).toBe('音を出す')
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.press({ key: SOUND_KEY })
    await clock.settle()
    expect(world.plays).toHaveLength(2)
    expect(await soundLabel(pane)).toBe('音を消す')
    await pane.unmount()
  })

  test('保存した消音は、読み直し(session.start)で読み込む', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    world.store[MUTED_KEY] = true // ほかの窓で消音にした
    await $.session.start(START as any) // 読み直し: 開いたままのペインを頭から踊り直す
    await clock.settle()
    expect(world.plays).toHaveLength(1) // 最初の 1 回だけ
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('鳴らせなかったら debug ログに 1 行・ペインに小さく出し、次に頭から始めるまで頼まない(踊りは続ける)', async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playDeny = 'no player'
    const { pane } = await openAndMount($, clock)
    expect(world.plays).toHaveLength(1)
    expect(world.logs).toHaveLength(1)
    expect(JSON.stringify(world.logs[0])).toContain('伴奏を鳴らせませんでした')
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(1)
    expect(world.logs).toHaveLength(1)
    expect(world.blits.length).toBeGreaterThan(5)
    expect(textOf(await pane.drawn())).toContain('音を出せませんでした')
    expect(await pane.find({ key: SOUND_KEY })).toBeUndefined()
    expect(await pane.find({ key: TRACK_KEY })).toBeUndefined() // 歌のボタンも出さない
    // 閉じて開き直すと、もう一度試す
    world.playDeny = undefined
    await $.command.run({ command: COMMAND, args: '' } as any)
    await $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.plays).toHaveLength(2)
    await pane.unmount()
  })

  test('消音は保存し終わるのを待たずに、鳴っている伴奏と次の周の予約を止める', async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playMs = LOOP_MS // 1 周のあいだ鳴り続ける
    const { pane } = await openAndMount($, clock)
    expect(world.plays).toHaveLength(1)
    expect(world.plays[0].signal.aborted).toBe(false)
    world.storeSetDelay = 5000
    const off = $.command.run({ command: COMMAND, args: 'mute' } as any)
    await clock.settle()
    expect(world.store[MUTED_KEY]).toBeUndefined() // まだ保存し終わっていない
    expect(world.plays[0].signal.aborted).toBe(true) // それでも止まっている
    expect(await soundLabel(pane)).toBe('音を出す')
    await clock.advance(5000)
    expect((await off).text).toMatch(/消しました/)
    expect(world.store[MUTED_KEY]).toBe(true)
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('閉じる・ゆっくりへの切り替えで、鳴っている伴奏を止める', async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playMs = LOOP_MS
    const { pane } = await openAndMount($, clock)
    await clock.advance(3 * BEAT_MS)
    await $.command.run({ command: COMMAND, args: 'slow' } as any)
    await clock.settle()
    expect(world.plays[0].signal.aborted).toBe(true)
    await $.command.run({ command: COMMAND, args: '' } as any) // 閉じる
    await $.command.run({ command: COMMAND, args: '' } as any) // 開き直す(音つきで頭から)
    await clock.settle()
    expect(world.plays).toHaveLength(2)
    expect(world.plays[1].signal.aborted).toBe(false)
    await $.command.run({ command: COMMAND, args: '' } as any)
    await clock.settle()
    expect(world.plays[1].signal.aborted).toBe(true)
    await pane.unmount()
  })

  test('予約が大きく遅れて届いても(スリープからの復帰など)、過ぎた周をまとめて鳴らさず、次に間に合う周から鳴らす', { plugins: [LATE_AFTER] }, async ($, on) => {
    const { clock, world } = engine(on, {})
    const late = 4 * LOOP_MS + 5000
    await lateNextAfter($, late) // 開いたときに入れる 1 周目の予約が、これだけ遅れて届く
    const { pane } = await openAndMount($, clock)
    expect(world.plays).toHaveLength(1)
    await clock.advance(LOOP_MS + late + 10) // 遅れた予約が届いた: 遅れすぎなので鳴らさない
    expect(world.plays).toHaveLength(1)
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(2)
    expect(near(world.plays[1].at, NOW + 6 * LOOP_MS)).toBe(true) // 次に間に合う周(6 周目)の頭
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(3)
    expect(near(world.plays[2].at, NOW + 7 * LOOP_MS)).toBe(true)
    await pane.unmount()
  })

  test('予約が少しだけ遅れたとき(LATE_MS まで)は、その周を鳴らす', { plugins: [LATE_AFTER] }, async ($, on) => {
    const { clock, world } = engine(on, {})
    await lateNextAfter($, LATE_MS - 50)
    const { pane } = await openAndMount($, clock)
    await clock.advance(LOOP_MS + LATE_MS)
    expect(world.plays).toHaveLength(2)
    expect(near(world.plays[1].at, NOW + LOOP_MS + LATE_MS - 50)).toBe(true)
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(3)
    expect(near(world.plays[2].at, NOW + 2 * LOOP_MS)).toBe(true) // 次の周は時計どおり
    await pane.unmount()
  })

  test('予約の時刻を読むあいだに消音→戻すをしても、古い予約は鳴らさない(戻したときの頭からの 1 回だけ)', { plugins: [LATE_AFTER, SLOW_NOW] }, async ($, on) => {
    const { clock, world } = engine(on, {})
    const fireAt = 17 * FRAME_MS + 10 // 1 周目の予約を、この時刻(NOW から)に早めて発火させる(コマとコマのあいだ)
    await lateNextAfter($, fireAt - LOOP_MS)
    const { pane } = await openAndMount($, clock)
    expect(world.plays).toHaveLength(1)
    await clock.set(NOW + fireAt - 5) // 直前のコマの後
    await slowNextNow($, 500) // 次の $.clock.now()(予約の発火で読む時刻)を 500 ms 遅らせる
    await clock.set(NOW + fireAt + 1) // 予約が発火し、時刻を待っている
    expect(world.plays).toHaveLength(1)
    expect((await $.command.run({ command: COMMAND, args: 'mute' } as any)).text).toMatch(/消しました/)
    world.storeSetDelay = 5000 // 戻す処理は保存を待つ(muted はもう戻っている)
    const back = $.command.run({ command: COMMAND, args: 'mute' } as any)
    await clock.advance(600) // 古い予約の処理が時刻を読み終えた
    expect(world.plays).toHaveLength(1)
    await clock.advance(5000)
    expect((await back).text).toMatch(/頭から/)
    expect(world.plays).toHaveLength(2)
    expect(world.plays[1].at).toBe(NOW + fireAt + 1 + 5000) // 保存し終わって頭から踊り直したとき
    await pane.unmount()
  })

  test('ボタンで音を戻すのを待つあいだにペインが閉じられたら、音つきで踊り直さない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on, { [MUTED_KEY]: true })
    const { pane } = await openAndMount($, clock)
    world.storeSetDelay = 100 // タイマーの見回り(CHECK_EVERY コマごと)より前に、音を戻す処理が進む
    world.closeDelay = 3000 // 閉じる知らせが届き終わるのは、音を戻す処理より後
    await pane.press({ key: SOUND_KEY })
    await clock.settle()
    const closing = closePane($, PANE)
    await clock.advance(150)
    expect(world.store[MUTED_KEY]).toBe(false)
    expect(world.plays).toHaveLength(0)
    await clock.advance(3000)
    await closing
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(0)
    await pane.unmount()
  })

  test('読み直しで消音の設定を読むあいだの mute を、遅れて戻った古い値で上書きしない', async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playMs = LOOP_MS // 止めるまで鳴り続ける
    const { pane } = await openAndMount($, clock)
    expect(world.plays).toHaveLength(1)
    world.storeGetLate = 500 // 読み直しの読み取り(音あり)が遅れて戻る
    const reload = $.session.start(START as any)
    await clock.settle()
    world.storeGetLate = 0
    const off = $.command.run({ command: COMMAND, args: 'mute' } as any)
    await clock.advance(600)
    await reload
    expect((await off).text).toMatch(/消しました/)
    expect(world.store[MUTED_KEY]).toBe(true)
    expect(await soundLabel(pane)).toBe('音を出す')
    expect(world.plays.every((p: any) => p.signal.aborted)).toBe(true) // 鳴っている伴奏は残っていない
    const n = world.plays.length
    await clock.advance(2 * LOOP_MS)
    expect(world.plays).toHaveLength(n)
    await pane.unmount()
  })

  test('mute とわからない引数の使い方に、mute と vocal を書く', async ($, on) => {
    engine(on)
    await $.session.start(START as any)
    const reply = await $.command.run({ command: COMMAND, args: 'loud' } as any)
    expect(reply.text).toContain('mute')
    expect(reply.text).toContain('vocal')
  })
})

const trackLabel = async (pane: any) => (await pane.find({ key: TRACK_KEY }))?.props?.label
/** 端末での表示幅(ASCII と → は 1 桁、ほかは 2 桁)。 */
const cols = (s: string) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 || ch === '→' ? 1 : 2), 0)

describe('歌入り', () => {
  test('歌なしで始め、ボタンは「歌を出す」(v)', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    expect(world.plays[0].clip).toEqual({ asset: CLIP })
    expect((await pane.find({ key: TRACK_KEY }))?.props).toMatchObject({ hotkey: 'v', plain: true, label: '歌を出す' })
    await pane.unmount()
  })

  test('/inmu-king vocal で、鳴っている伴奏をすぐ止め、頭から歌入りで踊り直す。古い予約は鳴らさない。もう一度(歌)で歌なしに戻る。設定は保存する', async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playMs = LOOP_MS // 止めるまで鳴り続ける
    const { pane } = await openAndMount($, clock)
    await clock.advance(5 * BEAT_MS)
    world.playMs = 0 // ここからの伴奏はすぐ鳴り終わる(鳴りっぱなしの伴奏があると、試験の時計を進めるのが遅くなる)
    const on2 = await $.command.run({ command: COMMAND, args: 'vocal' } as any)
    expect(on2.text).toMatch(/歌入りにしました.*頭から/)
    expect(world.store[VOCAL_KEY]).toBe(true)
    expect(world.plays).toHaveLength(2)
    expect(world.plays[0].signal.aborted).toBe(true)
    expect(world.plays[1]).toMatchObject({ at: clock.now(), clip: { asset: VOCAL_CLIP } })
    await clock.settle()
    expect(await boldOf(pane)).toEqual(['キメポーズ', ' 5']) // 頭から
    expect(await trackLabel(pane)).toBe('歌を消す')
    await clock.advance(LOOP_MS - 20) // 前の踊りの 2 周目の頭(切り替えの前に予約していた時刻)を過ぎた
    expect(world.plays).toHaveLength(2)
    await clock.advance(40)
    expect(world.plays).toHaveLength(3)
    expect(world.plays[2].clip).toEqual({ asset: VOCAL_CLIP }) // 次の周も歌入り
    const off = await $.command.run({ command: COMMAND, args: '歌' } as any)
    expect(off.text).toMatch(/歌なし/)
    expect(world.store[VOCAL_KEY]).toBe(false)
    expect(world.plays).toHaveLength(4)
    expect(world.plays[3]).toMatchObject({ at: clock.now(), clip: { asset: CLIP } })
    expect(await trackLabel(pane)).toBe('歌を出す')
    await pane.unmount()
  })

  test('ペインのボタン(v)でも切り替える', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock)
    await pane.press({ key: TRACK_KEY })
    await clock.settle()
    expect(world.store[VOCAL_KEY]).toBe(true)
    expect(world.plays).toHaveLength(2)
    expect(world.plays[1].clip).toEqual({ asset: VOCAL_CLIP })
    expect(await trackLabel(pane)).toBe('歌を消す')
    await pane.press({ key: TRACK_KEY })
    await clock.settle()
    expect(world.plays).toHaveLength(3)
    expect(world.plays[2].clip).toEqual({ asset: CLIP })
    expect(await trackLabel(pane)).toBe('歌を出す')
    await pane.unmount()
  })

  test('消音のあいだの vocal は設定だけ変える(鳴らさない)。音を戻すと歌入りで頭から鳴る', async ($, on) => {
    const { clock, world } = engine(on, { [MUTED_KEY]: true })
    const { pane } = await openAndMount($, clock)
    const r = await $.command.run({ command: COMMAND, args: '歌入り' } as any)
    expect(r.text).toMatch(/音を消しています/)
    expect(world.store[VOCAL_KEY]).toBe(true)
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(0)
    expect(await trackLabel(pane)).toBe('歌を消す')
    await $.command.run({ command: COMMAND, args: 'mute' } as any)
    expect(world.plays).toHaveLength(1)
    expect(world.plays[0].clip).toEqual({ asset: VOCAL_CLIP })
    await pane.unmount()
  })

  test('閉じているあいだの vocal は設定だけ変え、ペインを開かない。次に開くと歌入りで鳴る', async ($, on) => {
    const { clock, world } = engine(on, {})
    await $.session.start(START as any)
    const r = await $.command.run({ command: COMMAND, args: 'vocal' } as any)
    expect(r.text).toMatch(/次に踊るときから/)
    expect(world.opens).toHaveLength(0)
    expect(world.plays).toHaveLength(0)
    await $.command.run({ command: COMMAND, args: '' } as any)
    const pane = await $.ui.mount(mountArgs() as any)
    await clock.settle()
    expect(world.plays).toHaveLength(1)
    expect(world.plays[0].clip).toEqual({ asset: VOCAL_CLIP })
    await pane.unmount()
  })

  test('slow のあいだは vocal で設定だけ変え(鳴らさない)、歌のボタンは出さない(消音のボタンは出す)', async ($, on) => {
    const { clock, world } = engine(on, {})
    const { pane } = await openAndMount($, clock, 'slow')
    expect(await pane.find({ key: TRACK_KEY })).toBeUndefined()
    expect(await soundLabel(pane)).toBe('音を消す')
    const r = await $.command.run({ command: COMMAND, args: 'vocal' } as any)
    expect(r.text).toMatch(/ゆっくりのあいだは鳴りません/)
    expect(world.store[VOCAL_KEY]).toBe(true)
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(0)
    await pane.unmount()
  })

  test('保存した歌入りの設定を、開くときと読み直し(session.start)で読み込む', async ($, on) => {
    const { clock, world } = engine(on, { [VOCAL_KEY]: true })
    const { pane } = await openAndMount($, clock)
    expect(world.plays[0].clip).toEqual({ asset: VOCAL_CLIP })
    expect(await trackLabel(pane)).toBe('歌を消す')
    world.store[VOCAL_KEY] = false // ほかの窓で歌なしにした
    await $.session.start(START as any) // 読み直し: 開いたままのペインを頭から踊り直す
    await clock.settle()
    expect(world.plays).toHaveLength(2)
    expect(world.plays[1].clip).toEqual({ asset: CLIP })
    expect(await trackLabel(pane)).toBe('歌を出す')
    await pane.unmount()
  })

  test('歌の切り替えは保存し終わるのを待たずに、鳴っている伴奏を止める', async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playMs = LOOP_MS
    const { pane } = await openAndMount($, clock)
    world.storeSetDelay = 5000
    const r = $.command.run({ command: COMMAND, args: 'vocal' } as any)
    await clock.advance(100)
    expect(world.store[VOCAL_KEY]).toBeUndefined() // まだ保存し終わっていない
    expect(world.plays[0].signal.aborted).toBe(true) // それでも止まっている
    expect(world.plays).toHaveLength(1)
    await clock.advance(5000)
    expect((await r).text).toMatch(/頭から/)
    expect(world.plays).toHaveLength(2)
    expect(world.plays[1]).toMatchObject({ at: NOW + 5000, clip: { asset: VOCAL_CLIP } }) // 保存し終わって頭から踊り直したとき
    await pane.unmount()
  })

  test('ボタンで歌入りに切り替えるのを待つあいだにペインが閉じられたら、踊り直さない', { plugins: [CLOSER] }, async ($, on) => {
    const { clock, world } = engine(on, {})
    world.playMs = LOOP_MS
    const { pane } = await openAndMount($, clock)
    world.storeSetDelay = 100
    world.closeDelay = 3000
    await pane.press({ key: TRACK_KEY })
    await clock.settle()
    expect(world.plays[0].signal.aborted).toBe(true)
    const closing = closePane($, PANE)
    await clock.advance(150)
    expect(world.store[VOCAL_KEY]).toBe(true)
    expect(world.plays).toHaveLength(1)
    await clock.advance(3000)
    await closing
    await clock.advance(LOOP_MS)
    expect(world.plays).toHaveLength(1)
    await pane.unmount()
  })

  test('寄せた幅(64 桁)でも、いちばん長い区間の名前とボタン 2 つが 1 行に収まる', async ($, on) => {
    const { clock } = engine(on, {})
    const { pane } = await openAndMount($, clock, '', PANE_COLUMNS, PANE_ROWS)
    let widest = 0
    for (let b = 0; b < LOOP_BEATS; b += 0.5) {
      const tree = await pane.drawn()
      const row = collect(tree, 'Box').find((x: any) => (x.children ?? []).some((c: any) => c.type === 'Button'))
      expect(row).toBeTruthy()
      const w = (row.children ?? []).reduce((n: number, c: any) => n + (c.type === 'Button' ? cols(`${c.props.hotkey}: ${c.props.label}`) : cols(textOf(c))), 0)
      widest = Math.max(widest, w)
      await clock.advance(BEAT_MS / 2)
    }
    expect(widest).toBeLessThanOrEqual(PANE_COLUMNS)
    expect(widest).toBe(63) // いちばん長い名前(しゃがんで重心移動 18 桁)を通った: 18+2+16+3+11+2+11
    await pane.unmount()
  })
})

describe('字幕', () => {
  test('歌う前の行は薄く出し、歌った分だけ左からオレンジに塗る', async ($, on) => {
    const { clock } = engine(on)
    const { pane } = await openAndMount($, clock)
    expect(await lyricOf(pane)).toEqual({ all: LINES[0].text, sung: '' })
    await clock.advance(2 * BEAT_MS + FRAME_MS) // 拍 −2: 1 行目の途中
    const mid = await lyricOf(pane)
    expect(mid.all).toBe(LINES[0].text)
    expect(mid.sung.length).toBeGreaterThan(0)
    expect(mid.sung.length).toBeLessThan(LINES[0].text.length)
    expect(LINES[0].text.startsWith(mid.sung)).toBe(true)
    await clock.advance(4.75 * BEAT_MS) // 拍 2.9 ごろ: 2 行目の最後の音(次の行はまだ出ない)
    const second = await lyricOf(pane)
    expect(second).toEqual({ all: LINES[1].text, sung: LINES[1].text })
    await pane.unmount()
  })

  test('間奏(拍 44〜47.5)は ♪ を出す', async ($, on) => {
    const { clock } = engine(on)
    const { pane } = await openAndMount($, clock)
    await clock.advance(49 * BEAT_MS) // 拍 45
    expect(await lyricOf(pane)).toEqual({ all: INTERLUDE, sung: INTERLUDE })
    await pane.unmount()
  })

  test('ゆっくりでも字幕を出す(拍に合わせて塗る)', async ($, on) => {
    const { clock } = engine(on)
    const { pane } = await openAndMount($, clock, 'slow')
    expect((await lyricOf(pane)).all).toBe(LINES[0].text)
    await clock.advance(4 * BEAT_MS + FRAME_MS) // ゆっくり: 拍 −2
    expect((await lyricOf(pane)).sung.length).toBeGreaterThan(0)
    await pane.unmount()
  })
})
