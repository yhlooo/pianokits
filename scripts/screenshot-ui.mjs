/**
 * UI 截图脚本（设计分析用）：渲染 PianoKits 各状态并截图到项目 .tmp/pianokits-ui-*.png
 * 用法：先 `pnpm dev`，再 `node scripts/screenshot-ui.mjs`
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '@tonejs/midi'
const { Midi } = pkg
import { chromium } from 'playwright'

/** 产物目录：项目根 .tmp/（相对脚本位置解析，任意工作目录下都可运行） */
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp')
mkdirSync(OUT, { recursive: true })
const MIDI_PATH = join(OUT, 'pianokits-ui.mid')
const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'

/** 生成一段“像样的钢琴曲”：右手旋律 + 左手低音/分解和弦，16 小节 */
function makeScore() {
  const midi = new Midi()
  midi.header.setTempo(96)
  midi.header.name = 'Moonlight Story'
  const beat = 60 / 96 // 一拍秒数

  const mel = midi.addTrack()
  mel.name = '右手旋律'
  // 简单一段上行-回落旋律（C 宫五声 + 经过音），每小节 4 拍
  const melody = [
    // bar1
    [0.5, 72, 1.5, 95],
    [0, 74, 1, 88],
    [0, 76, 1, 84],
    [0, 79, 1, 90],
    // bar2
    [0.5, 81, 1.5, 92],
    [0, 79, 1, 80],
    [0, 76, 1, 82],
    [0, 74, 1, 78],
    // bar3
    [0.5, 72, 1, 88],
    [0, 74, 1, 84],
    [0, 76, 1.5, 90],
    [0.5, 74, 0.5, 76],
    // bar4
    [0, 72, 2, 92],
    [0.5, 71, 1, 84],
    [0, 72, 1, 90],
    // bar5-8: 变奏
    [0.25, 76, 0.5, 90],
    [0.25, 79, 0.5, 94],
    [0.25, 81, 0.5, 96],
    [0.25, 84, 0.5, 100],
    [0.5, 83, 1.5, 92],
    [0, 79, 1, 84],
    [0, 81, 1, 88],
    [0.25, 79, 0.75, 95],
    [0.25, 76, 0.75, 90],
    [0.25, 74, 0.75, 88],
    [0.25, 72, 0.75, 86],
    [0, 71, 3, 92],
    [0.5, 72, 1, 80],
  ]
  md(mel, melody, beat)

  // 左手：每小节根音 + 五度 + 分解和弦
  const bass = midi.addTrack()
  bass.name = '左手伴奏'
  const bassLine = []
  const chords = [
    [48, 55, 64, 67], // C
    [43, 50, 59, 62], // G
    [45, 52, 60, 64], // Am
    [41, 48, 57, 60], // F
    [48, 55, 64, 67], // C
    [45, 52, 60, 64], // Am
    [41, 48, 57, 60], // F
    [43, 50, 59, 62], // G
  ]
  for (const ch of chords) {
    bassLine.push([0.5, ch[0], 2, 85]) // 根音长音
    bassLine.push(
      [0, ch[1], 0.5, 66],
      [0, ch[2], 0.5, 62],
      [0, ch[3], 0.5, 60],
      [0, ch[2], 0.5, 58],
    )
    bassLine.push([0, ch[1], 0.5, 62], [0, ch[2], 0.5, 64], [0, ch[3] + 12, 0.75, 58])
  }
  md(bass, bassLine, beat)

  writeFileSync(MIDI_PATH, Buffer.from(midi.toArray()))
}

function md(track, notes, beat) {
  let t = 0
  for (const [rest, midi, durBeats, vel] of notes) {
    t += rest * beat
    track.addNote({ midi, time: t, duration: durBeats * beat, velocity: vel / 127 })
    t += durBeats * beat
  }
}

makeScore()

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 })
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200))
})

await page.goto(BASE_URL, { waitUntil: 'networkidle' })
await page.waitForSelector('.library__import')
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/pianokits-ui-0-empty.png` })
console.log('1. 空状态')

await page.locator('.hidden-input').first().setInputFiles(MIDI_PATH)
await page.waitForSelector('.library__item')
await page.locator('.library__item').first().click()
await page.waitForSelector('.score__system svg', { timeout: 60000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/pianokits-ui-1-split.png` })
console.log('2. 分屏视图（已加载曲目）')

// 播放一会儿，抓瀑布流演奏中的形态
await page.locator('.transport__play').click()
try {
  await page.waitForTimeout(4500)
} catch {}
await page.screenshot({ path: `${OUT}/pianokits-ui-2-split-playing.png` })
console.log('3. 分屏视图（播放中）')
await page.locator('.transport__play').click()

await page.locator('.view-switch__btn[data-mode="waterfall"]').click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/pianokits-ui-3-waterfall.png` })
console.log('4. 瀑布流单视图')

await page.locator('.view-switch__btn[data-mode="score"]').click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/pianokits-ui-4-score.png` })
console.log('5. 五线谱单视图')

// 回到分屏，细看顶栏 + 侧栏区域裁剪
await page.locator('.view-switch__btn[data-mode="split"]').click()
await page.waitForTimeout(400)
await page.locator('.playerdock').screenshot({ path: `${OUT}/pianokits-ui-5-transport.png` })
await page.locator('.library').screenshot({ path: `${OUT}/pianokits-ui-6-library.png` })
await page.locator('.shell').screenshot({ path: `${OUT}/pianokits-ui-7-shell.png` })
console.log('6. 局部：工具条 / 侧栏 / 外壳栏')

await browser.close()
console.log(`截图完成 -> ${OUT}/pianokits-ui-*.png`)
