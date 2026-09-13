/**
 * UI 审计截图脚本（设计评估用）：渲染 PianoKits 全部工具/状态并截图到项目 .tmp/audit/
 * 用法：先 `pnpm dev`，再 `node scripts/ui-audit-screenshots.mjs`
 * 环境变量：PIANOKITS_URL（默认 http://localhost:5173）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '@tonejs/midi'
const { Midi } = pkg
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.tmp', 'audit')
mkdirSync(OUT, { recursive: true })
const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'

const MIDI_PATH = join(OUT, 'demo.mid')
const MULTI_PATH = join(OUT, 'multitrack.mid')

/** 生成一段"像样的钢琴曲"：右手旋律 + 左手低音/分解和弦，16 小节 */
function makeScore() {
  const midi = new Midi()
  midi.header.setTempo(96)
  midi.header.name = 'Moonlight Story'
  const beat = 60 / 96

  const mel = midi.addTrack()
  mel.name = 'Right Hand'
  const melody = [
    [0.5, 72, 1.5, 95],
    [0, 74, 1, 88],
    [0, 76, 1, 84],
    [0, 79, 1, 90],
    [0.5, 81, 1.5, 92],
    [0, 79, 1, 80],
    [0, 76, 1, 82],
    [0, 74, 1, 78],
    [0.5, 72, 1, 88],
    [0, 74, 1, 84],
    [0, 76, 1.5, 90],
    [0.5, 74, 0.5, 76],
    [0, 72, 2, 92],
    [0.5, 71, 1, 84],
    [0, 72, 1, 90],
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

  const bass = midi.addTrack()
  bass.name = 'Left Hand'
  const bassLine = []
  const chords = [
    [48, 55, 64, 67],
    [43, 50, 59, 62],
    [45, 52, 60, 64],
    [41, 48, 57, 60],
    [48, 55, 64, 67],
    [45, 52, 60, 64],
    [41, 48, 57, 60],
    [43, 50, 59, 62],
  ]
  for (const ch of chords) {
    bassLine.push([0.5, ch[0], 2, 85])
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

/** 多轨（6 轨）曲目：用于检验按轨配色与练习音轨菜单 */
function makeMultiTrack() {
  const midi = new Midi()
  midi.header.setTempo(100)
  midi.header.name = 'Six Hands'
  const beat = 60 / 100
  const specs = [
    ['Melody', 76, 0.5, 0.5, 100],
    ['Harmony', 64, 0, 2, 70],
    ['Bass', 43, 0, 2, 80],
    ['Arpeggio', 55, 0.25, 0.25, 60],
    ['Counterpoint', 69, 0.75, 0.5, 75],
    ['Percussion', 84, 0.25, 0.2, 90],
  ]
  for (const [name, base, off, dur, vel] of specs) {
    const tr = midi.addTrack()
    tr.name = name
    let t = 0
    for (let i = 0; i < 48; i++) {
      const midiNote = base + [0, 2, 4, 7, 9, 7, 4, 2][i % 8]
      tr.addNote({
        midi: midiNote,
        time: t + off * beat,
        duration: dur * beat,
        velocity: vel / 127,
      })
      t += beat
    }
  }
  writeFileSync(MULTI_PATH, Buffer.from(midi.toArray()))
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
makeMultiTrack()

/**
 * 注入假 MIDI 输入设备（虚拟键盘）：让"MIDI 已连接"相关 UI（练习菜单、录音页可用态、
 * 琴键点亮）在无硬件的 devcontainer 中也能截图。必须在页面加载前 addInitScript。
 */
const FAKE_MIDI = () => {
  const input = {
    id: 'fake-1',
    name: 'Virtual Piano',
    manufacturer: 'PianoKits',
    state: 'connected',
    type: 'input',
    connection: 'open',
    __listeners: new Set(),
    addEventListener(t, f) {
      if (t === 'midimessage') this.__listeners.add(f)
    },
    removeEventListener(t, f) {
      this.__listeners.delete(f)
    },
    /** 测试钩子：向页面内的监听器派发一条 MIDI 消息 */
    __send(bytes) {
      const ev = { data: new Uint8Array(bytes) }
      for (const f of this.__listeners) f(ev)
    },
  }
  const access = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map(),
    sysexEnabled: false,
    onstatechange: null,
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: async () => access,
  })
  Object.defineProperty(window, '__fakeMidi', { configurable: true, value: input })
}

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1512, height: 945 },
  deviceScaleFactor: 2,
})
await page.addInitScript(FAKE_MIDI)
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200))
})

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot:', name)
}
const clip = async (name, selector) => {
  await page
    .locator(selector)
    .first()
    .screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot:', name)
}
/**
 * 弹层（练习菜单 / MIDI 状态 / 音量）是绝对定位、溢出其触发器的小盒子，
 * 元素截图只会截到 32×32 的触发器本身；因此按"弹层 + 留白"裁剪页面区域。
 */
const clipPopup = async (name, selector, pad = 20) => {
  const r = await page
    .locator(selector)
    .first()
    .evaluate((e) => {
      const b = e.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    })
  const vp = page.viewportSize()
  const x = Math.max(0, r.x - pad)
  const y = Math.max(0, r.y - pad)
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x,
      y,
      width: Math.min(vp.width - x, r.width + pad * 2),
      height: Math.min(vp.height - y, r.height + pad * 2),
    },
  })
  console.log('shot:', name)
}
/** 视图开关：.transport__view 第 1 个=瀑布流、第 2 个=乐谱（无 dataset，用 title 定位） */
const viewBtn = (title) => page.locator(`.transport__view[title="${title}"]`).first()
/** 读取某个视图开关的开启态（aria-pressed） */
const viewOn = (title) =>
  viewBtn(title)
    .getAttribute('aria-pressed')
    .then((v) => v === 'true')
/**
 * 把视图切到目标组合（两个独立开关，不能同时关闭）：
 * 'split'=瀑布+乐谱、'waterfall'=仅瀑布、'score'=仅乐谱
 */
async function setView(mode) {
  const want = {
    split: { 瀑布流: true, 乐谱: true },
    waterfall: { 瀑布流: true, 乐谱: false },
    score: { 瀑布流: false, 乐谱: true },
  }[mode]
  for (const [title, on] of Object.entries(want)) {
    if ((await viewOn(title)) !== on) {
      await viewBtn(title).click()
      await page.waitForTimeout(250)
    }
  }
  await page.waitForTimeout(700)
}
/** 经假设备点亮琴键 */
const pressKey = (midi, on) =>
  page.evaluate(
    ([m, isOn]) => window.__fakeMidi.__send([isOn ? 0x90 : 0x80, m, isOn ? 100 : 0]),
    [midi, on],
  )

// ---------- A. 空状态 ----------
await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
await page.waitForSelector('.library__import', { state: 'attached' })
await page.waitForTimeout(1200)
await shot('01-empty-full')
await clip('02-empty-library', '.library')
await clip('03-empty-shell', '.shell')
await clip('04-empty-dock', '.playerdock')

// ---------- B. 单曲（2 轨）全状态 ----------
await page.locator('.hidden-input').first().setInputFiles(MIDI_PATH)
await page.waitForSelector('.library__item')
await page.locator('.library__item').first().click()
await page.waitForSelector('.score__system svg', { timeout: 60000 })
await page.waitForTimeout(1500)
await shot('05-split-loaded')
await clip('06-library-one', '.library')

// 播放中
await page.locator('.transport__play').click()
await page.waitForTimeout(5000)
await shot('07-split-playing')
await clip('08-dock-playing', '.playerdock')
await page.locator('.transport__play').click()
await page.waitForTimeout(400)

// 悬停弹层：练习菜单 / MIDI 状态 / 音量
await page.locator('.transport__practice').hover()
await page.waitForTimeout(600)
await shot('09-practice-menu')
await clipPopup('10-practice-menu-close', '.transport__practice-menu')
await page.mouse.move(700, 400)
await page.waitForTimeout(400)

await page.locator('.transport__midi').click()
await page.waitForTimeout(600)
await clipPopup('11-midi-menu', '.transport__midi-menu')
await page.keyboard.press('Escape')
await page.mouse.click(700, 400)
await page.waitForTimeout(400)

await page.locator('.transport__volume-btn').hover()
await page.waitForTimeout(600)
await clipPopup('12-volume-popup', '.transport__volume-popup', 24)
await page.mouse.move(700, 400)
await page.waitForTimeout(400)

// 单瀑布
await setView('waterfall')
await shot('13-waterfall-only')

// 单谱面
await setView('score')
await shot('14-score-only')
await clip('15-score-paper', '.score:not(.score--placeholder)')

// 回到分屏
await setView('split')

// 练习模式开启 + 按键点亮（假 MIDI 设备）
await page.locator('.transport__practice').click()
await page.waitForTimeout(400)
await pressKey(60, true)
await pressKey(64, true)
await pressKey(67, true)
await page.locator('.transport__play').click()
await page.waitForTimeout(3000)
await shot('16-practice-active')
await clip('17-practice-dock', '.playerdock')
await page.locator('.transport__play').click()
await page.waitForTimeout(300)
await pressKey(60, false)
await pressKey(64, false)
await pressKey(67, false)
await page.locator('.transport__practice').click()
await page.waitForTimeout(300)

// ---------- C. 6 轨曲目：按轨配色 / 练习菜单 / 谱面 ----------
await page.locator('.hidden-input').first().setInputFiles(MULTI_PATH)
await page.waitForTimeout(800)
await page.locator('.library__item').first().click()
await page.waitForTimeout(3000)
await page.locator('.transport__play').click()
await page.waitForTimeout(3500)
await shot('18-multitrack-playing')
await clip('19-library-two', '.library')
await page.locator('.transport__practice').hover()
await page.waitForTimeout(600)
await clipPopup('20-practice-menu-6track', '.transport__practice-menu')
await page.locator('.transport__play').click()
await page.waitForTimeout(400)
await page.mouse.move(700, 400)

// 录音工具
await page.locator('.shell__tab[data-id="midi-recorder"]').click()
await page.waitForTimeout(1500)
await shot('21-recorder-idle')
await clip('22-recorder-stage', '.recorder')

// 调试：MIDI 键盘
await page.locator('.debug-menu__trigger').click()
await page.waitForTimeout(400)
await shot('23-debug-menu-open')
await page.locator('.debug-menu__item[data-id="midi-keyboard"]').click()
await page.waitForTimeout(1500)
await shot('24-midi-keyboard-debug')

// 窄屏（响应式检查）
await page.setViewportSize({ width: 1024, height: 800 })
await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await shot('25-narrow-1024')

await page.setViewportSize({ width: 768, height: 800 })
await page.waitForTimeout(1500)
await shot('26-narrow-768')

await browser.close()
console.log(`\n截图完成 -> ${OUT}/*.png`)
