/**
 * 开发/验收用：验证**踏板信息进入声音链路**（真实 Chromium + 假 Web MIDI + 合成 MIDI）。
 * 覆盖设计文档 docs/development/design/20260913-pedal-sound-path.md 的三条链路：
 * 1. 走带播放 → MIDI 输出端口：曲目 CC64 踩下/抬起被镜像；
 * 2. 走带播放 → 机内引擎：voice 发声时长按踏板延长（合成曲目键按 0.3s、延音 0.4–4.5s）；
 * 3. 练习输入 → MIDI 输出端口：用户踩下踏板被原样回送；
 * 4. 暂停 → 输出端口补发 CC64=0（不留残响）。
 *
 * 任一条不满足以非零退出码结束。用法：先 `pnpm dev`，再
 * `node scripts/probe-pedal-sound-gap.mjs`
 *
 * 修复前的实测事实见 docs/development/research/20260913-pedal-sound-path-gap.md。
 */
import { writeFileSync } from 'node:fs'
import toneMidi from '@tonejs/midi'
import { chromium } from 'playwright'

const { Midi } = toneMidi

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'
/** 合成曲目：三个音键各按 0.3s（0.5 / 1.5 / 2.5s 起），延音 0.4–4.5s 一直踩着 */
const NOTES = [
  { midi: 60, time: 0.5 },
  { midi: 64, time: 1.5 },
  { midi: 67, time: 2.5 },
]
const PEDAL_ON = 0.4
const PEDAL_OFF = 4.5

const midi = new Midi()
const track = midi.addTrack()
track.name = 'PedalSound'
for (const n of NOTES) track.addNote({ midi: n.midi, time: n.time, duration: 0.3, velocity: 0.8 })
track.addCC({ number: 64, value: 1, time: PEDAL_ON })
track.addCC({ number: 64, value: 0, time: PEDAL_OFF })
const MIDI_PATH = '/tmp/probe-pedal-sound-gap.mid'
writeFileSync(MIDI_PATH, Buffer.from(midi.toArray()))

/** 注入到页面的探针：输出端口消息留痕 + 音频 voice start/stop 留痕 + 假 Web MIDI */
const initScript = () => {
  window.__outMsgs = []
  window.__voiceOps = []
  const ids = new WeakMap()
  let nextId = 0
  const idOf = (node) => {
    let v = ids.get(node)
    if (v === undefined) {
      v = ++nextId
      ids.set(node, v)
    }
    return v
  }
  const patch = (proto, fn) => {
    const orig = proto[fn]
    Object.defineProperty(proto, fn, {
      configurable: true,
      writable: true,
      value: function (...args) {
        try {
          window.__voiceOps.push({ id: idOf(this), fn, at: args[0] })
        } catch {
          /* 留痕失败不影响发声 */
        }
        return orig.apply(this, args)
      },
    })
  }
  patch(AudioBufferSourceNode.prototype, 'start')
  patch(AudioBufferSourceNode.prototype, 'stop')
  patch(OscillatorNode.prototype, 'start')
  patch(OscillatorNode.prototype, 'stop')

  class FakeInput {
    constructor() {
      this.name = 'Probe Keyboard'
      this.manufacturer = 'Probe'
      this.id = 'i1'
      this.state = 'connected'
      this.connection = 'open'
      this._listeners = new Set()
    }
    addEventListener(_type, cb) {
      this._listeners.add(cb)
    }
    removeEventListener(_type, cb) {
      this._listeners.delete(cb)
    }
    send(bytes) {
      for (const cb of this._listeners) cb({ data: Uint8Array.from(bytes) })
    }
    control(controller, value) {
      this.send([0xb0, controller, value])
    }
    note(pitch, on) {
      this.send(on ? [0x90, pitch, 100] : [0x80, pitch, 0])
    }
  }
  class FakeOutput {
    constructor() {
      this.name = 'Probe Out'
      this.manufacturer = 'Probe'
      this.id = 'o1'
      this.state = 'connected'
      this.connection = 'open'
    }
    send(data, ts) {
      window.__outMsgs.push({ data: Array.from(data), ts })
    }
    clear() {}
  }
  class FakeAccess {
    constructor() {
      this.sysexEnabled = false
      this.input = new FakeInput()
      this.output = new FakeOutput()
      this.inputs = new Map([['i1', this.input]])
      this.outputs = new Map([['o1', this.output]])
      this._stateCbs = new Set()
    }
    addEventListener(_type, cb) {
      this._stateCbs.add(cb)
    }
    removeEventListener(_type, cb) {
      this._stateCbs.delete(cb)
    }
  }
  const access = new FakeAccess()
  window.__fakeAccess = access
  navigator.requestMIDIAccess = () => Promise.resolve(access)
}

/** 输出端口上的 CC64 值序列（按发送顺序） */
const pedalMessages = () =>
  page.evaluate(() =>
    window.__outMsgs.filter((m) => m.data[0] === 0xb0 && m.data[1] === 64).map((m) => m.data[2]),
  )

/** 机内引擎 voice 的发声时长（stop-start，秒） */
const voiceSpans = () =>
  page.evaluate(() => {
    const starts = new Map()
    const spans = []
    for (const op of window.__voiceOps) {
      if (op.fn === 'start') starts.set(op.id, op.at)
      else if (op.fn === 'stop' && starts.has(op.id))
        spans.push(+(op.at - starts.get(op.id)).toFixed(3))
    }
    return spans
  })

const problems = []
const check = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`)
  if (!ok) problems.push(message)
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.grantPermissions(['midi'])
const page = await context.newPage()
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
})
await page.addInitScript(initScript)

try {
  await page.goto(BASE_URL + '/midi-player', { waitUntil: 'networkidle' })
  await page.locator('.transport__midi').waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  await page.setInputFiles('.hidden-input', MIDI_PATH)
  await page.locator('.library__item').first().waitFor({ timeout: 10000 })
  await page.locator('.library__item').first().click()
  await page.waitForTimeout(600)

  console.log(
    `合成曲目：音键各按 0.3s（${NOTES.map((n) => n.time).join(' / ')}s 起），延音踩 ${PEDAL_ON}–${PEDAL_OFF}s`,
  )

  console.log('--- 1/2. 走带播放：输出端口镜像 + 机内引擎延音 ---')
  await page.locator('.transport__play').click()
  await page.waitForTimeout(4800) // 覆盖到 4.5s 的踏板抬起
  const played = await pedalMessages()
  const spans = await voiceSpans()
  console.log('   输出端口 CC64 值序列：', JSON.stringify(played))
  console.log('   机内 voice 发声时长（秒）：', JSON.stringify(spans))
  check(played.includes(127) && played.includes(0), '曲目踏板镜像到输出端口（CC64 踩下 + 抬起）')
  check(
    spans.length >= NOTES.length && Math.min(...spans.slice(0, NOTES.length)) > 2,
    '机内引擎发声时长被踏板延长（最短 voice > 键按 0.3s + release 0.5s）',
  )

  console.log('--- 3. 暂停：输出端口补发 CC64=0（不留残响） ---')
  const beforePause = await pedalMessages()
  await page.locator('.transport__play').click() // 暂停
  await page.waitForTimeout(200)
  const afterPause = await pedalMessages()
  check(
    afterPause.length > beforePause.length && afterPause.includes(0),
    '暂停后输出端口收到踏板复位（CC64=0）',
  )

  console.log('--- 4. 练习输入：踩下踏板回送到输出端口 ---')
  // 打开练习菜单 → 选"仅延音踏板"（自动全开全部轨、进入门控）
  const box = await page.locator('.transport__practice-wrap').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(150)
  await page.locator('.transport__practice-pedal').nth(1).click()
  await page.waitForTimeout(200)
  const beforePedal = await pedalMessages()
  await page.evaluate(() => window.__fakeAccess.input.control(64, 127))
  await page.waitForTimeout(200)
  const afterPedal = await pedalMessages()
  check(afterPedal.slice(beforePedal.length).includes(127), '练习中踩下延音踏板被回送到输出端口')
} catch (err) {
  problems.push(`探针异常：${err instanceof Error ? err.message : String(err)}`)
} finally {
  await browser.close()
}

if (problems.length > 0) {
  console.log('\n失败项：')
  for (const p of problems) console.log(`- ${p}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过：踏板信息已进入声音链路（文件播放 + 实时输入）')
}
