/**
 * 开发用冒烟：验证分轨练习悬浮菜单端到端行为（真实 Chromium + 假 Web MIDI）：
 * - 未连接：练习按钮禁用，但 hover 仍展开菜单，行禁用；
 * - 载入曲目后菜单逐轨显示（轨名 + 瀑布流颜色图例），打击乐轨不列出；
 * - 连接后点击行开关单轨（多选、菜单不收起），按钮高亮与“全开/全关”语义；
 * - 分轨压暗：部分门控时非练习轨瀑布流明显变暗、练习轨正常，练习关闭后恢复；
 * - 断连清空全部分轨开关。
 * 用法：先 `pnpm dev`，再 `node scripts/probe-per-track-practice.mjs`
 */
import { writeFileSync } from 'node:fs'
import toneMidi from '@tonejs/midi'
import { chromium } from 'playwright'

const { Midi } = toneMidi

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'

// 生成测试曲目：2 条非打击乐轨（有音符）+ 1 条打击乐轨（channel 9，不应出现在菜单）。
// 时长拉长到 ~8s，保证暂停/播放联动步骤在播放过程中有足够时间操作。
const midi = new Midi()
const melody = midi.addTrack()
melody.name = 'Melody'
melody.addNote({ midi: 60, time: 0.5, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 64, time: 0.9, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 62, time: 2.0, duration: 6.0, velocity: 0.8 })
const bass = midi.addTrack()
bass.name = 'Bass'
bass.addNote({ midi: 40, time: 0.5, duration: 0.8, velocity: 0.7 })
bass.addNote({ midi: 43, time: 1.0, duration: 7.0, velocity: 0.7 })
const drums = midi.addTrack()
drums.name = 'Drums'
drums.channel = 9
drums.addNote({ midi: 36, time: 0.5, duration: 0.1, velocity: 0.9 })
const MIDI_PATH = '/tmp/probe-multi-track.mid'
writeFileSync(MIDI_PATH, Buffer.from(midi.toArray()))

// 假 Web MIDI：1 台输入（可发 note 消息）+ 1 台输出
const fakeMidi = () => {
  class FakeInput {
    constructor() {
      this.name = 'Probe Keyboard'
      this.manufacturer = 'Probe'
      this.id = 'i1'
      this.state = 'connected'
      this.connection = 'open'
      this._listeners = new Set()
    }
    addEventListener(type, cb) {
      this._listeners.add(cb)
    }
    removeEventListener(type, cb) {
      this._listeners.delete(cb)
    }
    note(pitch, on) {
      for (const cb of this._listeners)
        cb({ data: Uint8Array.from(on ? [0x90, pitch, 100] : [0x80, pitch, 0]) })
    }
  }
  class FakeOutput {
    constructor() {
      this.name = 'Probe Out'
      this.manufacturer = 'Probe'
      this.id = 'o1'
      this.state = 'connected'
      this.connection = 'open'
      this.sent = []
    }
    send(data) {
      this.sent.push([...data])
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
    addEventListener(type, cb) {
      this._stateCbs.add(cb)
    }
    removeEventListener(type, cb) {
      this._stateCbs.delete(cb)
    }
  }
  const access = new FakeAccess()
  globalThis.__fakeAccess = access
  navigator.requestMIDIAccess = () => Promise.resolve(access)
  return access
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const problems = []
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
})
await page.addInitScript(fakeMidi)

const menuVisible = () =>
  page
    .locator('.transport__practice-menu')
    .evaluate((el) => getComputedStyle(el).display !== 'none')
const hoverPractice = async () => {
  const box = await page.locator('.transport__practice-wrap').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(150)
}
const clickRow = async (i) => {
  await hoverPractice()
  await page.locator('.transport__practice-item').nth(i).click()
  await page.waitForTimeout(100)
}
const itemState = (i) =>
  page
    .locator('.transport__practice-item')
    .nth(i)
    .evaluate((el) => ({
      name: el.querySelector('.transport__practice-item__name')?.textContent ?? '',
      swatchBg: getComputedStyle(el.querySelector('.transport__practice-item__swatch'))
        .backgroundImage,
      active: el.classList.contains('is-active'),
      disabled: el.disabled,
    }))

/** 采样瀑布流音符条中部一个像素（载入后未播放：判定线在 0 秒，t=0.785 落在 0.5–0.9 音符条内） */
const sampleNote = (pitch) =>
  page.evaluate(
    ({ pitch }) => {
      const canvas = document.querySelector('.waterfall__canvas')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      const ctx = canvas.getContext('2d')
      const MIN_PITCH = 21
      const PITCH_COUNT = 88
      const keyW = w / PITCH_COUNT
      // 与视图一致的键盘高度换算（resize() 同款算法）
      const keyboardH = Math.round(Math.max(44, Math.min(140, keyW * 6.3)))
      const noteAreaH = h - keyboardH
      const t = 0.785
      const y = noteAreaH - t * 140
      const x = (pitch - MIN_PITCH) * keyW + keyW * 0.5
      const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
      return { r: d[0], g: d[1], b: d[2], x: Math.round(x), y: Math.round(y) }
    },
    { pitch },
  )
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

try {
  await page.goto(BASE_URL + '/midi-player', { waitUntil: 'networkidle' })
  const midiBtn = page.locator('.transport__midi')
  const practiceBtn = page.locator('.transport__practice')
  await midiBtn.waitFor({ timeout: 10000 })

  // 1. 未载入曲目：hover 显示菜单空态占位；练习按钮禁用
  await hoverPractice()
  if (!(await menuVisible())) problems.push('未载入曲目时 hover 应显示悬浮菜单')
  const emptyText = await page.locator('.transport__practice-menu__empty').textContent()
  console.log('空态菜单:', JSON.stringify(emptyText))
  if (!(emptyText ?? '').includes('载入曲目')) problems.push('空态菜单文案缺失')
  await page.mouse.move(30, 400) // 移出收起

  // 2. 导入并选择曲目
  await page.setInputFiles('.hidden-input', MIDI_PATH)
  await page.locator('.library__item').first().waitFor({ timeout: 10000 })
  await page.locator('.library__item').first().click()
  await page.waitForTimeout(300)

  // 2.5 切到瀑布流视图并采样基线（分轨压暗验证用；40 = Bass/非练习轨，60 = Melody/练习轨）
  await page.locator('.view-switch__btn[data-mode="waterfall"]').click()
  await page.waitForTimeout(300)
  const baseBass = await sampleNote(40)
  const baseMelody = await sampleNote(60)
  console.log('压暗基线:', JSON.stringify({ baseBass, baseMelody }))

  // 3. 未连接：hover 展开菜单，显示 2 条非打击乐轨（含颜色图例），行禁用
  await hoverPractice()
  if (!(await menuVisible())) problems.push('载入曲目后 hover 应显示悬浮菜单')
  const rows = page.locator('.transport__practice-item')
  if ((await rows.count()) !== 2) problems.push(`菜单应显示 2 条轨，实际 ${await rows.count()}`)
  const s0 = await itemState(0)
  const s1 = await itemState(1)
  console.log('未连接菜单行:', JSON.stringify(s0), JSON.stringify(s1))
  if (s0.name !== 'Melody' || s1.name !== 'Bass')
    problems.push('轨名不正确（应 Melody / Bass，不含 Drums）')
  if (!s0.swatchBg.includes('linear-gradient') || !s1.swatchBg.includes('linear-gradient'))
    problems.push('菜单行缺少瀑布流颜色图例（渐变背景）')
  if (!s0.disabled || !s1.disabled) problems.push('未连接时菜单行应禁用')
  if (await practiceBtn.isDisabled()) {
    console.log('未连接：练习按钮禁用 ✓')
  } else {
    problems.push('未连接时练习按钮应禁用')
  }

  // 4. 连接假键盘
  await midiBtn.click()
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.transport__midi')
      return el?.classList.contains('is-connected')
    },
    { timeout: 5000 },
  )
  await page.waitForTimeout(100)
  const enabled = await page
    .locator('.transport__practice-item')
    .nth(0)
    .evaluate((el) => !el.disabled)
  if (!enabled) problems.push('连接后菜单行应可点')
  console.log('已连接：钢琴按钮高亮，菜单行可用 ✓')

  // 5. 点击第一轨：开启该轨练习 → 按钮高亮、行激活、自动切瀑布流
  await clickRow(0)
  if (!(await practiceBtn.evaluate((el) => el.classList.contains('is-active'))))
    problems.push('开启一轨后练习按钮应高亮')
  if (!(await itemState(0)).active) problems.push('开启后该行应激活')
  if (!(await menuVisible())) problems.push('点击行后菜单不应收起（可多选）')
  const viewActive = await page
    .locator('.view-switch__btn[data-mode="waterfall"]')
    .evaluate((el) => el.classList.contains('is-active'))
  if (!viewActive) problems.push('开启练习应自动切到瀑布流视图')

  // 5.5 分轨压暗：非练习轨（Bass）明显变暗，练习轨（Melody）保持正常
  await page.mouse.move(30, 400) // 移开鼠标，避免菜单遮挡采样区域
  await page.waitForTimeout(150)
  const dimBass = await sampleNote(40)
  const dimMelody = await sampleNote(60)
  console.log('开启练习后:', JSON.stringify({ dimBass, dimMelody }))
  if (lum(dimBass) >= lum(baseBass) * 0.85)
    problems.push(
      `非练习轨瀑布流应明显变暗（基线 ${lum(baseBass).toFixed(1)} → ${lum(dimBass).toFixed(1)}）`,
    )
  if (Math.abs(lum(dimMelody) - lum(baseMelody)) > 6)
    problems.push('练习轨瀑布流应保持正常显示（亮度不应变化）')

  // 6. 再点第二轨：多选，按钮仍高亮
  await clickRow(1)
  if (!(await itemState(1)).active) problems.push('第二行应激活（多选）')
  if (!(await practiceBtn.evaluate((el) => el.classList.contains('is-active'))))
    problems.push('多选后练习按钮应保持高亮')

  // 7. 全开时点击练习按钮 → 全部关闭（按钮不再高亮）
  await practiceBtn.click()
  await page.waitForTimeout(100)
  if (await practiceBtn.evaluate((el) => el.classList.contains('is-active')))
    problems.push('全开点击练习按钮应全部关闭（不高亮）')
  if ((await itemState(0)).active || (await itemState(1)).active) problems.push('全关后行不应激活')

  // 8. 全关时点击练习按钮 → 全部开启
  await practiceBtn.click()
  await page.waitForTimeout(100)
  if (!(await itemState(0)).active || !(await itemState(1)).active)
    problems.push('全关点击练习按钮应全部开启')

  // 9. 点击第二行关掉单轨 → 部分开启，再点按钮 → 全开（按钮语义）
  await clickRow(1)
  if ((await itemState(1)).active) problems.push('点击已开启的行应关闭该轨')
  await practiceBtn.click()
  await page.waitForTimeout(100)
  if (!(await itemState(0)).active || !(await itemState(1)).active)
    problems.push('部分开启时点击练习按钮应全部开启')

  // 9.5 暂停/播放联动：开关练习自动暂停 → 练习开启时按任意琴键恢复播放
  const playState = () =>
    page.evaluate(() => document.querySelector('.transport__play')?.dataset.state)
  const waitPlayState = (state) =>
    page.waitForFunction(
      (s) => document.querySelector('.transport__play')?.dataset.state === s,
      state,
      { timeout: 5000 },
    )
  await page.locator('.transport__play').click() // 开始播放
  await waitPlayState('playing')
  await clickRow(1) // 关掉单轨（仍有一轨开启）→ 自动暂停
  if ((await playState()) !== 'paused') problems.push('开关练习应自动暂停')
  console.log('开关练习自动暂停 ✓')
  // 练习开启状态下按任意琴键（非和弦内键）→ 恢复播放
  await page.evaluate(() => globalThis.__fakeAccess.input.note(72, true))
  await waitPlayState('playing')
  console.log('按键恢复播放 ✓')
  await page.evaluate(() => globalThis.__fakeAccess.input.note(72, false))
  // 部分开 → 点按钮全开 → 自动暂停；再播放 → 点按钮全关 → 自动暂停
  await practiceBtn.click()
  if ((await playState()) !== 'paused') problems.push('开关练习（全开）应自动暂停')
  await page.locator('.transport__play').click()
  await waitPlayState('playing')
  await practiceBtn.click()
  if ((await playState()) !== 'paused') problems.push('关闭全部练习应自动暂停')
  console.log('关闭练习自动暂停 ✓')

  // 10. 断连：分轨开关全部清空、按钮不高亮、行恢复禁用、自动暂停
  await midiBtn.click()
  await page.waitForTimeout(300)
  if (await practiceBtn.evaluate((el) => el.classList.contains('is-active')))
    problems.push('断连后练习按钮不应高亮')
  if ((await itemState(0)).active || (await itemState(1)).active) problems.push('断连后行不应激活')
  if (
    !(await page
      .locator('.transport__practice-item')
      .nth(0)
      .evaluate((el) => el.disabled))
  )
    problems.push('断连后菜单行应恢复禁用')
  // 连接不影响播放状态（暂停中连接仍暂停）；播放中断开 → 自动暂停
  await page.locator('.transport__midi').click() // 重新连接
  await page.waitForFunction(
    () => document.querySelector('.transport__midi')?.classList.contains('is-connected'),
    { timeout: 5000 },
  )
  if ((await playState()) !== 'paused') problems.push('连接 MIDI 键盘不应改变暂停状态')
  await page.locator('.transport__play').click()
  await waitPlayState('playing')
  await page.locator('.transport__midi').click() // 断开 → 自动暂停
  await page.waitForFunction(
    () => !document.querySelector('.transport__midi')?.classList.contains('is-connected'),
    { timeout: 5000 },
  )
  if ((await playState()) !== 'paused') problems.push('断开 MIDI 键盘应自动暂停')
  console.log('断连自动暂停 ✓')

  // 10.5 断连（练习关闭）后分轨压暗恢复：重新载入曲目（视窗回到起点），非练习轨回到基线亮度
  await page.locator('.library__item').first().click()
  await page.waitForTimeout(300)
  await page.mouse.move(30, 400)
  await page.waitForTimeout(150)
  const restoreBass = await sampleNote(40)
  console.log('断连后恢复:', JSON.stringify({ restoreBass }))
  if (Math.abs(lum(restoreBass) - lum(baseBass)) > 6)
    problems.push(
      `断连后非练习轨瀑布流应恢复正常亮度（基线 ${lum(baseBass).toFixed(1)} → ${lum(restoreBass).toFixed(1)}）`,
    )

  await page.screenshot({ path: '/tmp/pianokits-per-track-practice.png' })
} finally {
  await browser.close()
}

if (problems.length > 0) {
  console.error('发现问题：')
  for (const p of problems) console.error('  ' + p)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
