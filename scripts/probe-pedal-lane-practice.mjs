/**
 * 开发用冒烟：验证瀑布流踏板事件条与踏板练习（真实 Chromium + 假 Web MIDI + 合成 MIDI）。
 * 覆盖：
 * - 踏板事件条（银灰，左弱音 / 中选择延音 / 右延音）：几何（4 白键宽、间隔 2 白键、居中）、
 *   上下渐变（顶亮底暗、同高度左右一致）、无事件的列没有任何踏板轨道背景；
 * - 触发光晕（银白，判定线处）：条底接触判定线之前不亮、踩下期间亮起、抬起后消失；
 *   只画光晕（无发光条）、与踏板轨同宽或只略微宽、以判定线为高度中心且可见半高仅 15px、
 *   判定线下方（钢琴键盘区域）不发光；
 * - 练习菜单三个踏板单选（关 / 仅延音踏板 / 全部踏板，默认关）、切换自动全开全部轨；
 * - 练习中踏板光晕只反馈**实际踩下**（没踩就不亮；非练习时才由文件事件驱动）；
 * - 踏板**边缘触发**：一直踩着不放不能通过，必须在闸门开始后现踩；
 * - 踏板**独立闸门**：没有音符要按的时刻（踏板踩下事件远离任何和弦）也会冻结等待；
 * - **长踏板持续期间**（2.9–4.5）内松开再踩不算错：文件此刻正踩着 → 不红显、不阻塞
 *   （3.6s 处的和弦闸门只要求琴键，重踩延音后按对琴键即可放行）；
 * - 误踩踏板：判定线处红色光晕；有闸门等待时阻塞，非判定位置只红显不阻塞。
 * 用法：先 `pnpm dev`，再 `node scripts/probe-pedal-lane-practice.mjs`
 */
import { writeFileSync } from 'node:fs'
import toneMidi from '@tonejs/midi'
import { chromium } from 'playwright'

const { Midi } = toneMidi

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'

// 合成测试曲目：Melody/Bass 两轨都在通道 0（分手导出形态），踏板 CC 只落在 Bass 轨 →
// 按通道归属，两轨共享同一份踏板（练哪只手都应判定踏板）。
// 时间轴：踏板 0.4–2.0 踩着、2.9–4.5 踩着；和弦 0.5 / 3.0 / 5.0。
// 另有低音区单音 24 @3.6（x 在键盘最左侧，远离中央的三条踏板列）：它落在延音 2.9–4.5 的
// 持续期间内、又不与任何踏板踩下合并 → 只要求琴键的和弦闸门，用于验证"持续期间内重踩"。
const midi = new Midi()
const melody = midi.addTrack()
melody.name = 'Melody'
melody.addNote({ midi: 60, time: 0.5, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 64, time: 0.5, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 67, time: 0.5, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 60, time: 3.0, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 64, time: 3.0, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 67, time: 3.0, duration: 0.4, velocity: 0.8 })
melody.addNote({ midi: 24, time: 3.6, duration: 0.3, velocity: 0.8 })
melody.addNote({ midi: 60, time: 5.0, duration: 0.4, velocity: 0.8 })
const bass = midi.addTrack()
bass.name = 'Bass'
bass.addNote({ midi: 36, time: 0.5, duration: 1.5, velocity: 0.7 })
bass.addNote({ midi: 36, time: 3.0, duration: 1.5, velocity: 0.7 })
bass.addNote({ midi: 36, time: 5.0, duration: 1.0, velocity: 0.7 })
bass.addCC({ number: 64, value: 1, time: 0.4 }) // 延音踩下
bass.addCC({ number: 64, value: 0, time: 2.0 }) // 延音抬起
bass.addCC({ number: 64, value: 1, time: 2.9 }) // 第二次踩下
bass.addCC({ number: 64, value: 0, time: 4.5 })
// 弱音踏板 4.2–4.8s：离最近音符（3.0 / 5.0）都超过合并窗口 → 独立踏板闸门
bass.addCC({ number: 67, value: 1, time: 4.2 })
bass.addCC({ number: 67, value: 0, time: 4.8 })
const MIDI_PATH = '/tmp/probe-pedal-lane.mid'
writeFileSync(MIDI_PATH, Buffer.from(midi.toArray()))

// 假 Web MIDI：1 台输入（可发 note / CC）+ 1 台输出
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
    addEventListener(_type, cb) {
      this._listeners.add(cb)
    }
    removeEventListener(_type, cb) {
      this._listeners.delete(cb)
    }
    send(bytes) {
      for (const cb of this._listeners) cb({ data: Uint8Array.from(bytes) })
    }
    note(pitch, on) {
      this.send(on ? [0x90, pitch, 100] : [0x80, pitch, 0])
    }
    control(controller, value) {
      this.send([0xb0, controller, value])
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
    send() {}
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
  globalThis.__fakeAccess = access
  navigator.requestMIDIAccess = () => Promise.resolve(access)
  return access
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.grantPermissions(['midi'])
const page = await context.newPage()
const problems = []
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
})
await page.addInitScript(fakeMidi)

/** 踏板列几何（与 waterfall-view.pedalColumns 同款公式）：白键宽 = 总宽/52，三列居中 */
const pedalGeometry = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.waterfall__canvas')
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const keyW = w / 52
    const barW = 4 * keyW
    const step = 6 * keyW
    const left0 = (w - 16 * keyW) / 2
    const keyboardH = Math.round(w * 0.122)
    return {
      columns: [0, 1, 2].map((i) => ({
        left: left0 + i * step,
        width: barW,
        center: left0 + i * step + barW / 2,
      })),
      noteAreaH: h - keyboardH,
      keyW,
      w,
    }
  })

/** 在第 i 列中心偏移 dx 像素、判定线上方 dy 像素处采样（dy < 0 = 判定线下方） */
const samplePedalAt = (i, dx, dy) =>
  page.evaluate(
    ({ i, dx, dy }) => {
      const canvas = document.querySelector('.waterfall__canvas')
      const dpr = window.devicePixelRatio || 1
      const ctx = canvas.getContext('2d')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const keyW = w / 52
      const noteAreaH = h - Math.round(w * 0.122)
      const center = (w - 16 * keyW) / 2 + i * 6 * keyW + 2 * keyW
      const d = ctx.getImageData(
        Math.round((center + dx) * dpr),
        Math.round((noteAreaH - dy) * dpr),
        1,
        1,
      ).data
      return { r: d[0], g: d[1], b: d[2] }
    },
    { i, dx, dy },
  )

/** 第 i 列中心处的采样（samplePedalAt 的常用简写：dx = 0） */
const samplePedal = (i, yFromBottom) => samplePedalAt(i, 0, yFromBottom)

/** 踏板列内最亮的像素（用于确认事件条存在；yMax 传 noteAreaH - 16 可避开底部琥珀判定光带） */
const brightestInPedal = (i, yMax) =>
  page.evaluate(
    ({ i, yMax }) => {
      const canvas = document.querySelector('.waterfall__canvas')
      const dpr = window.devicePixelRatio || 1
      const ctx = canvas.getContext('2d')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const keyW = w / 52
      const noteAreaH = h - Math.round(w * 0.122)
      const center = (w - 16 * keyW) / 2 + i * 6 * keyW + 2 * keyW
      let best = { lum: -1, r: 0, g: 0, b: 0, y: 0 }
      for (let y = 0; y < Math.min(yMax, noteAreaH); y++) {
        const d = ctx.getImageData(Math.round(center * dpr), Math.round(y * dpr), 1, 1).data
        const lum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]
        if (lum > best.lum) best = { lum, r: d[0], g: d[1], b: d[2], y }
      }
      return best
    },
    { i, yMax },
  )

/**
 * 第 i 列中心向右，在判定线上方 dy 处光晕的横向半宽：
 * 以 dx=150（光晕之外）的同高度亮度为基线，取最后一个「明显高于基线」的位置。
 */
const glowExtent = (i, dy) =>
  page.evaluate(
    ({ i, dy }) => {
      const canvas = document.querySelector('.waterfall__canvas')
      const dpr = window.devicePixelRatio || 1
      const ctx = canvas.getContext('2d')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const keyW = w / 52
      const noteAreaH = h - Math.round(w * 0.122)
      const center = (w - 16 * keyW) / 2 + i * 6 * keyW + 2 * keyW
      const lumAt = (dx) => {
        const d = ctx.getImageData(
          Math.round((center + dx) * dpr),
          Math.round((noteAreaH - dy) * dpr),
          1,
          1,
        ).data
        return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]
      }
      const baseline = lumAt(150)
      let last = 0
      for (let dx = 0; dx <= 148; dx += 2) {
        if (lumAt(dx) > baseline + 8) last = dx
      }
      return last
    },
    { i, dy },
  )

const lumOf = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

/** 某列里「银灰踏板条」颜色的最长连续像素段（踏板条是几十~几百 px 的竖直长条；
 *  音符边缘的抗锯齿像素只有一两像素，不会误判；音符彩色/高亮、背景很暗都不计入） */
const longestBarRun = (i) =>
  page.evaluate(
    ({ i }) => {
      const canvas = document.querySelector('.waterfall__canvas')
      const dpr = window.devicePixelRatio || 1
      const ctx = canvas.getContext('2d')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const keyW = w / 52
      const noteAreaH = h - Math.round(w * 0.122) - 16 // 避开底部琥珀判定光带
      const center = Math.round(((w - 16 * keyW) / 2 + i * 6 * keyW + 2 * keyW) * dpr)
      let best = 0
      let run = 0
      for (let y = 0; y < noteAreaH; y++) {
        const d = ctx.getImageData(center, Math.round(y * dpr), 1, 1).data
        const max = Math.max(d[0], d[1], d[2])
        const min = Math.min(d[0], d[1], d[2])
        const lum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]
        if (max - min <= 14 && lum >= 40 && lum <= 150) {
          run++
          if (run > best) best = run
        } else {
          run = 0
        }
      }
      return best
    },
    { i },
  )

/** 把播放头定位到 t 秒（拖动进度条：value 是 0–1 的分数） */
const seekTo = async (t, duration) => {
  await page.locator('.transport__seek').evaluate((el, frac) => {
    el.value = String(frac)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, t / duration)
  await page.waitForTimeout(120)
}

/** 确保处于播放状态（seek 结束会自动恢复播放，盲目点击播放按钮会把它暂停） */
const ensurePlaying = async () => {
  const state = await page.locator('.transport__play').getAttribute('data-state')
  if (state !== 'playing') await page.locator('.transport__play').click()
}

/** 确保处于暂停状态（seek 结束会自动恢复播放） */
const ensurePaused = async () => {
  const state = await page.locator('.transport__play').getAttribute('data-state')
  if (state === 'playing') await page.locator('.transport__play').click()
}

const hoverPractice = async () => {
  const box = await page.locator('.transport__practice-wrap').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(150)
}

/** 银灰踏板条：接近灰度的中低明度（用户口径：容易分辨但不突出，与音符协调） */
const isGrayBar = (c) => {
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  const lum = lumOf(c)
  return max - min <= 24 && lum >= 40 && lum <= 150
}
/** 判定线处的银白光晕：明显的高亮银白 */
const isSilverGlow = (c) => c.r > 155 && c.g > 155 && c.b > 155 && Math.abs(c.r - c.b) < 30
const isRed = (c) => c.r > 150 && c.r - c.g > 40 && c.r - c.b > 40
const isDark = (c) => lumOf(c) < 40

try {
  await page.goto(BASE_URL + '/midi-player', { waitUntil: 'networkidle' })
  await page.locator('.transport__midi').waitFor({ timeout: 10000 })
  await page.waitForTimeout(300)

  await page.setInputFiles('.hidden-input', MIDI_PATH)
  await page.locator('.library__item').first().waitFor({ timeout: 10000 })
  await page.locator('.library__item').first().click()
  await page.waitForTimeout(400)

  // 只留瀑布流视图，画布更大、采样更稳
  await page.locator('.transport__view[title="乐谱"]').click()
  await page.waitForTimeout(300)

  // 1. 踏板练习：三个单选框、文案、默认无踏板、已连接可用
  const radios = page.locator('.transport__practice-radio')
  const radioCount = await radios.count()
  console.log('踏板单选框数量:', radioCount)
  if (radioCount !== 3) problems.push(`踏板练习应有 3 个单选框，实际 ${radioCount}`)
  const labels = await page.locator('.transport__practice-pedal__label').allTextContents()
  console.log('踏板单选项:', JSON.stringify(labels))
  if (labels.join('|') !== '关|仅延音踏板|全部踏板')
    problems.push(`单选项文案不正确：${labels.join('|')}`)
  const defaultChecked = await page
    .locator('.transport__practice-radio:checked')
    .evaluate((el) => el.value)
  if (defaultChecked !== 'off') problems.push(`默认应选中"关"，实际 ${defaultChecked}`)
  const anyDisabled = await radios.evaluateAll((els) => els.some((el) => el.disabled))
  if (anyDisabled) problems.push('已连接 MIDI 键盘时踏板单选框不应禁用')

  // 2. 踏板事件条几何：三列居中、条宽 4 白键、间隔 2 白键
  const geo = await pedalGeometry()
  const expectLeft0 = (geo.w - 16 * geo.keyW) / 2
  const expectBarW = 4 * geo.keyW
  const geoOk =
    Math.abs(geo.columns[0].left - expectLeft0) < 0.5 &&
    Math.abs(geo.columns[1].left - (expectLeft0 + 6 * geo.keyW)) < 0.5 &&
    Math.abs(geo.columns[2].width - expectBarW) < 0.5
  console.log(
    '踏板列几何:',
    JSON.stringify({
      w: geo.w,
      keyW: geo.keyW,
      columns: geo.columns.map((c) => Math.round(c.left)),
    }),
  )
  if (!geoOk) problems.push('踏板三列几何不是「条宽 4 白键 / 间隔 2 白键 / 整体居中」')

  const duration = 6

  // 3. 银灰事件条：定位到 0 秒，延音条（第 3 列）应在画布内落下。
  //    扫描到判定线上方 16px 为止：避开底部琥珀判定光带（它比压暗后的踏板条还亮）
  const bar = await brightestInPedal(2, geo.noteAreaH - 16)
  console.log('延音列最亮像素:', JSON.stringify(bar))
  if (!isGrayBar(bar)) problems.push(`延音列应出现银灰踏板条，实际 rgb(${bar.r},${bar.g},${bar.b})`)
  // 本曲只有延音（CC64）与弱音（CC67）数据：两列都有事件条，中选择延音（CC66）列没有
  const sustainBarPx = await longestBarRun(2)
  const softBarPx = await longestBarRun(0)
  const sostenutoBarPx = await longestBarRun(1)
  console.log(
    '各列踏板条最长连续段（弱音/选择延音/延音）:',
    softBarPx,
    sostenutoBarPx,
    sustainBarPx,
  )
  if (sustainBarPx < 20) problems.push('延音列应出现踏板事件条')
  if (softBarPx < 20) problems.push('弱音列应出现踏板事件条（本曲有 CC67 数据）')
  if (sostenutoBarPx > 10) problems.push('本曲无选择延音踏板数据，中列不应出现踏板事件条')

  // 3.5 没有踏板事件的列：不应有任何"踏板轨道"背景（与画布普通背景一致）
  const midLane = await samplePedal(1, Math.round(geo.noteAreaH * 0.6))
  const outside = await page.evaluate(
    ({ yFromBottom }) => {
      const canvas = document.querySelector('.waterfall__canvas')
      const dpr = window.devicePixelRatio || 1
      const ctx = canvas.getContext('2d')
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const keyW = w / 52
      const noteAreaH = h - Math.round(w * 0.122)
      const x = 4 * keyW // 踏板轨道之外的普通背景
      const d = ctx.getImageData(
        Math.round(x * dpr),
        Math.round((noteAreaH - yFromBottom) * dpr),
        1,
        1,
      ).data
      return { r: d[0], g: d[1], b: d[2] }
    },
    { yFromBottom: Math.round(geo.noteAreaH * 0.6) },
  )
  console.log('中列(无踏板数据) vs 轨道外背景:', JSON.stringify(midLane), JSON.stringify(outside))
  if (
    !isDark(midLane) ||
    Math.abs(midLane.r - outside.r) > 6 ||
    Math.abs(midLane.b - outside.b) > 6
  )
    problems.push('没有踏板事件的列不应显示任何踏板轨道背景')

  // 4. 触发光晕：条底接触判定线之前不亮；踩下期间判定线处银白；抬起后消失
  await seekTo(0.35, duration) // 踩下（0.4s）之前：条底还在判定线上方
  const beforeTouch = await samplePedal(2, 3)
  console.log('接触判定线之前:', JSON.stringify(beforeTouch))
  if (isSilverGlow(beforeTouch)) problems.push('踏板条尚未接触判定线时不应亮起银白光晕')
  await seekTo(1.0, duration)
  const glowOn = await samplePedal(2, 3)
  console.log('踩下期间判定线处:', JSON.stringify(glowOn))
  if (!isSilverGlow(glowOn))
    problems.push(`踩下期间延音列判定线处应有银白光晕，实际 ${JSON.stringify(glowOn)}`)

  const barW = geo.columns[2].width
  const glowLeft = await samplePedalAt(2, -(barW / 2 + 10), 4)
  const glowFarLeft = await samplePedalAt(2, -(barW / 2 + 46), 4)
  console.log('光晕左右外扩:', JSON.stringify(glowLeft), 'vs 远端', JSON.stringify(glowFarLeft))
  if (!(lumOf(glowLeft) > lumOf(glowFarLeft) + 8)) problems.push('触发光晕应铺到踏板条左右两侧之外')
  const belowLine = await samplePedalAt(2, 0, -4)
  console.log('判定线下方（键盘区域）:', JSON.stringify(belowLine))
  if (!isDark(belowLine)) problems.push('光晕不应越过判定线下方（钢琴键盘区域不受影响）')

  // 条体：上下渐变（顶亮底暗）；同一高度左右两点应一致（不做横向渐变）
  // 取 60/130px：都在条体内、且避开贴判定线的光晕（高 30px + 模糊外溢）
  const barLower = await samplePedalAt(2, 0, 60)
  const barUpper = await samplePedalAt(2, 0, 130)
  const barLowerL = await samplePedalAt(2, -barW * 0.25, 60)
  const barLowerR = await samplePedalAt(2, barW * 0.25, 60)
  console.log('条体上下渐变:', JSON.stringify([barLower, barUpper, barLowerL, barLowerR]))
  if (!(lumOf(barUpper) > lumOf(barLower) + 8))
    problems.push('踏板条应为上下渐变（同列上缘更亮、下缘更暗）')
  if (Math.abs(lumOf(barLowerL) - lumOf(barLowerR)) > 8)
    problems.push('踏板条同一高度左右应一致（不做横向渐变）')

  // 光晕形状：横向必须铺出条体之外；贴线与上方 24px 的半宽接近
  // （侧边接近竖直 → 与判定线成直角/略钝角，而不是向内收的锐角）
  const extentLow = await glowExtent(2, 3)
  const extentHigh = await glowExtent(2, 12)
  console.log(
    '光晕横向半宽（贴线/上方 12px）:',
    extentLow,
    extentHigh,
    '条半宽',
    (barW / 2).toFixed(0),
  )
  if (!(extentLow > barW / 2 + 2)) problems.push('光晕应不小于踏板条宽度')
  if (!(extentLow < barW / 2 + 30)) problems.push('光晕只应略宽于踏板条，不能明显超出')
  if (!(extentHigh > extentLow * 0.8)) problems.push('光晕侧边不能明显向内收（应为圆角矩形的直边）')
  // 垂直：判定线处（圆角矩形高度中点）最亮，向上渐隐
  const glowTop = await samplePedalAt(2, 0, 13)
  console.log('光晕顶部（判定线上方 13px）:', JSON.stringify(glowTop))
  if (!(lumOf(glowOn) > lumOf(glowTop) + 20))
    problems.push('光晕应以判定线（圆角矩形高度中点）最亮、向上渐隐')

  await seekTo(2.5, duration)
  const glowOff = await samplePedal(2, 3)
  console.log('抬起后判定线处:', JSON.stringify(glowOff))
  if (isSilverGlow(glowOff))
    problems.push(`踏板抬起后不应残留银白光晕，实际 ${JSON.stringify(glowOff)}`)

  // 5. 练习压暗：关（默认）下踏板条"无需关注"整体压暗；切到全部踏板练习后恢复正常。
  //    取判定线上方 40px 处采样（条体、避开光晕），避免把光晕亮度当成条体
  await seekTo(1.0, duration)
  const barNormal = await samplePedal(2, 40)
  await page.locator('.transport__practice').click() // 开启分轨练习（全部轨），踏板模式仍为默认 off
  await page.waitForTimeout(200)
  const barDimmed = await samplePedal(2, 40)
  const barNormalLum = lumOf(barNormal)
  const barDimmedLum = lumOf(barDimmed)
  console.log(
    '练习前/关（默认）下的延音条亮度:',
    barNormalLum.toFixed(0),
    '→',
    barDimmedLum.toFixed(0),
  )
  if (!(barDimmedLum < barNormalLum * 0.7))
    problems.push('踏板判定为关时踏板条应明显压暗（"无需关注"）')
  if (!isGrayBar(barNormal)) problems.push('正常播放时踏板条应为银灰（接近灰度）')
  const dimGlow = await samplePedal(2, 3)
  if (isSilverGlow(dimGlow)) problems.push('压暗（无需关注）的踏板条不应显示触发光晕')

  // 6. 练习：切到"全部踏板"（自动全开全部轨）
  await hoverPractice()
  await page.locator('.transport__practice-pedal').nth(2).click()
  await page.waitForTimeout(200)
  const barBright = await samplePedal(2, 40)
  const barBrightLum = lumOf(barBright)
  console.log('全部踏板下延音条亮度:', barBrightLum.toFixed(0))
  if (!isGrayBar(barBright)) problems.push('全部踏板下延音踏板条应恢复正常显示')
  const mode = await page.locator('.transport__practice-radio:checked').evaluate((el) => el.value)
  if (mode !== 'all') problems.push(`应选中"全部踏板"，实际 ${mode}`)
  const activeRows = await page.locator('.transport__practice-item.is-active').count()
  console.log('自动全开练习轨数:', activeRows)
  if (activeRows !== 2) problems.push(`踏板练习应自动全开全部轨（2），实际 ${activeRows}`)

  await seekTo(0, duration)

  // 6.5 非判定位置误踩（尚未开始播放、没有闸门等待）：只红显、不阻塞
  await page.evaluate(() => globalThis.__fakeAccess.input.control(67, 127))
  await page.waitForTimeout(200)
  const idleWrong = await samplePedal(0, 3)
  console.log('非判定位置误踩弱音:', JSON.stringify(idleWrong))
  if (!isRed(idleWrong)) problems.push('非判定位置踩错踏板也应显示红色光晕')
  await page.evaluate(() => globalThis.__fakeAccess.input.control(67, 0))
  await page.waitForTimeout(150)

  // 7. 练习中「没踩踏板就不亮光晕」：按齐琴键、未踩任何踏板 → 冻结等待且判定线处无银白光晕
  await ensurePlaying()
  await page.waitForTimeout(400)
  for (const pitch of [36, 60, 64, 67]) {
    await page.evaluate((p) => globalThis.__fakeAccess.input.note(p, true), pitch)
  }
  await page.waitForTimeout(700)
  const frozen = Number(await page.locator('.transport__seek').inputValue())
  const expectedFrozen = 0.5 / duration
  console.log('未踩踏板 + 按齐琴键的位置:', frozen.toFixed(4), '期望≈', expectedFrozen.toFixed(4))
  if (Math.abs(frozen - expectedFrozen) > 0.02)
    problems.push(`缺少踏板时应冻结在 ${expectedFrozen.toFixed(3)}，实际 ${frozen.toFixed(3)}`)
  const noGlow = await samplePedal(2, 3)
  console.log('未踩踏板时判定线处:', JSON.stringify(noGlow))
  if (isSilverGlow(noGlow))
    problems.push('练习模式下没踩踏板时不应显示踏板光晕（光晕是踩下的反馈）')

  // 8. 现踩延音 → 放行；光晕作为「已踩下」的反馈亮起；松开即消失
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 127))
  await page.waitForTimeout(400)
  const heldGlow = await samplePedal(2, 3)
  console.log('现踩后判定线处:', JSON.stringify(heldGlow))
  if (!isSilverGlow(heldGlow)) problems.push('现踩踏板后应显示银白光晕（踩下反馈）')
  await page.waitForTimeout(500)
  const after = Number(await page.locator('.transport__seek').inputValue())
  console.log('现踩延音后位置:', after.toFixed(4))
  if (after <= expectedFrozen + 0.02) problems.push('现踩要求踏板后播放未继续推进')
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 0))
  await page.waitForTimeout(200)
  const releasedGlow = await samplePedal(2, 3)
  if (isSilverGlow(releasedGlow)) problems.push('松开踏板后光晕应消失')

  // 8.5 非判定位置误踩不阻塞：闸门已放行、播放正在推进时踩弱音 → 红显但位置照常前进
  await page.evaluate(() => globalThis.__fakeAccess.input.control(67, 127))
  await page.waitForTimeout(150)
  const movingWrong = await samplePedal(0, 3)
  const posA = Number(await page.locator('.transport__seek').inputValue())
  await page.waitForTimeout(500)
  const posB = Number(await page.locator('.transport__seek').inputValue())
  console.log(
    '播放中误踩弱音（红显）:',
    JSON.stringify(movingWrong),
    '位置',
    posA.toFixed(3),
    '→',
    posB.toFixed(3),
  )
  if (!isRed(movingWrong)) problems.push('播放中误踩踏板应显示红色光晕')
  if (!(posB > posA)) problems.push('非判定位置误踩踏板不应阻塞播放')
  await page.evaluate(() => globalThis.__fakeAccess.input.control(67, 0))
  await page.waitForTimeout(150)

  // 8.7 边缘触发：闸门开始前就踩住延音 → 即使琴键已按住也不放行（一直踩着不能过）。
  //     注意顺序：练习模式下按任意琴键会自动开始播放，所以必须先踩踏板、再按琴键。
  await seekTo(0, duration)
  await ensurePaused() // 闸门必须在踩踏板之前还没建立
  for (const pitch of [36, 60, 64, 67]) {
    await page.evaluate((p) => globalThis.__fakeAccess.input.note(p, false), pitch)
  }
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 127)) // 闸门开始前就踩着
  for (const pitch of [36, 60, 64, 67]) {
    await page.evaluate((p) => globalThis.__fakeAccess.input.note(p, true), pitch) // 自动开始播放
  }
  await page.waitForTimeout(700)
  const edgeFrozen = Number(await page.locator('.transport__seek').inputValue())
  console.log(
    '一直踩着 + 琴键已按住的位置:',
    edgeFrozen.toFixed(4),
    '期望≈',
    expectedFrozen.toFixed(4),
  )
  if (Math.abs(edgeFrozen - expectedFrozen) > 0.02)
    problems.push(
      `一直踩着踏板不能通过：应冻结在 ${expectedFrozen.toFixed(3)}，实际 ${edgeFrozen.toFixed(3)}`,
    )
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 0))
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 127))
  await page.waitForTimeout(800)
  const edgeAfter = Number(await page.locator('.transport__seek').inputValue())
  console.log('抬起再踩后位置:', edgeAfter.toFixed(4))
  if (edgeAfter <= expectedFrozen + 0.02) problems.push('抬起再踩后播放未继续推进')
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 0))
  await page.waitForTimeout(150)

  // 8.9 长踏板持续期间：松开再踩不算错（长踏板与长音符同等处理）。
  //     延音 2.9–4.5 的持续期间内，3.6s 处有一个只要求琴键的和弦闸门（单音 24）：
  //     闸门等待时重踩延音 → 不红显、不阻塞（按对琴键即放行）
  await seekTo(3.3, duration)
  await ensurePaused() // 闸门必须在踩踏板之前还没建立
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 127)) // 一直踩着（2.9 起）
  await ensurePlaying()
  await page.waitForTimeout(900) // 落到 3.6 的和弦闸门 → 冻结等待琴键
  const longPedalFrozen = Number(await page.locator('.transport__seek').inputValue())
  const expectedLongPedalGate = 3.6 / duration
  console.log(
    '长踏板持续期间的和弦闸门位置:',
    longPedalFrozen.toFixed(4),
    '期望≈',
    expectedLongPedalGate.toFixed(4),
  )
  if (Math.abs(longPedalFrozen - expectedLongPedalGate) > 0.02)
    problems.push(
      `长踏板持续期间内的和弦闸门应冻结在 3.6，实际 ${(longPedalFrozen * duration).toFixed(3)}`,
    )
  // 持续期间内松开再踩（真实演奏的换踩）：文件此刻仍踩着 → 不算误踩
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 0))
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 127))
  await page.waitForTimeout(200)
  const rePressedGlow = await samplePedal(2, 3)
  console.log('持续期间内松开再踩（延音列）:', JSON.stringify(rePressedGlow))
  if (isRed(rePressedGlow)) problems.push('踏板持续期间内松开再踩不应判为误踩（红色光晕）')
  if (!isSilverGlow(rePressedGlow)) problems.push('持续期间内重踩后应显示银白光晕（踩下反馈）')
  // 不阻塞：按对该和弦要求的琴键即放行
  await page.evaluate(() => globalThis.__fakeAccess.input.note(24, true))
  await page.waitForTimeout(600)
  const afterLongPedal = Number(await page.locator('.transport__seek').inputValue())
  console.log('持续期间内重踩后按对琴键的位置:', afterLongPedal.toFixed(4))
  if (!(afterLongPedal > longPedalFrozen + 0.02))
    problems.push('踏板持续期间内重踩不应阻塞：按对要求的琴键后播放应继续推进')
  await page.evaluate(() => globalThis.__fakeAccess.input.note(24, false))
  await page.evaluate(() => globalThis.__fakeAccess.input.control(64, 0))
  await page.waitForTimeout(150)

  // 9. 独立踏板闸门：没有音符要按的时刻（弱音 4.2s，离最近音符 0.6s）也会冻结等待
  await seekTo(3.8, duration)
  await ensurePlaying()
  await page.waitForTimeout(900)
  const pedalGatePos = Number(await page.locator('.transport__seek').inputValue())
  const expectedPedalGate = 4.2 / duration
  console.log(
    '独立踏板闸门处的位置:',
    pedalGatePos.toFixed(4),
    '期望≈',
    expectedPedalGate.toFixed(4),
  )
  if (Math.abs(pedalGatePos - expectedPedalGate) > 0.02)
    problems.push(
      `没有音符要按的踏板时刻也应冻结等待（期望 ${expectedPedalGate.toFixed(3)}，实际 ${pedalGatePos.toFixed(3)}）`,
    )
  const gateGlowBefore = await samplePedal(0, 3)
  console.log('独立踏板闸门处（未踩）:', JSON.stringify(gateGlowBefore))
  if (isSilverGlow(gateGlowBefore)) problems.push('独立踏板闸门未踩下时不应显示光晕')
  await page.evaluate(() => globalThis.__fakeAccess.input.control(67, 127))
  await page.waitForTimeout(400)
  const gateGlowAfter = await samplePedal(0, 3)
  console.log('独立踏板闸门处（已现踩）:', JSON.stringify(gateGlowAfter))
  if (!isSilverGlow(gateGlowAfter)) problems.push('现踩后独立闸门处应显示银白光晕')
  await page.waitForTimeout(400)
  const afterPedalGate = Number(await page.locator('.transport__seek').inputValue())
  console.log('现踩弱音后位置:', afterPedalGate.toFixed(4))
  if (afterPedalGate <= expectedPedalGate + 0.02)
    problems.push('现踩要求踏板后（独立闸门）播放未继续推进')
  await page.evaluate(() => globalThis.__fakeAccess.input.control(67, 0))

  if (problems.length === 0) {
    console.log('\n✅ 踏板轨道与踏板练习探针全部通过')
  } else {
    console.log('\n❌ 发现问题：')
    for (const p of problems) console.log(' -', p)
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
