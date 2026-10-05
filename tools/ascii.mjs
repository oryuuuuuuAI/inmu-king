// 振付を文字で確かめる道具(配布しない。mod 本体は読み込まない)。画像を作らずに、拍ごとの舞台を半角ブロックで端末に出す。
// 使い方: node tools/ascii.mjs <ペインの幅> <左端の桁> <右端の桁> <拍>...
//   例: node tools/ascii.mjs 130 0 130 30 31.25 32
const c = await import(new URL('../hooks/choreo.js', import.meta.url))
const s = await import(new URL('../hooks/stage.js', import.meta.url))
const k = await import(new URL('../hooks/clawd.js', import.meta.url))
const floor = k.COLOR.floor
const layout = s.layoutFor(Number(process.argv[2] ?? 130), 15)
const from = Number(process.argv[3]), to = Number(process.argv[4])
for (const b of process.argv.slice(5).map(Number)) {
  const px = s.stagePixels(c.posesAt(b), layout)
  const w = layout.columns
  const h = px.length / w
  console.log(`--- beat ${b} ${c.countAt(b).label}`)
  for (let y = 0; y < h; y += 2) {
    let line = ''
    for (let x = from; x < Math.min(w, to); x++) {
      const on = (v) => v !== undefined && v !== k.NONE && v !== floor
      const t = on(px[y * w + x]), u = y + 1 < h && on(px[(y + 1) * w + x])
      line += t && u ? '█' : t ? '▀' : u ? '▄' : ' '
    }
    if (line.trim()) console.log(line.replace(/\s+$/, ''))
  }
}
