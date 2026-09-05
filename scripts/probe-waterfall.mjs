/** 瀑布流调试探针：把画布像素转成 ASCII 字符画，逐状态打印 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

function makeMidi(notes, leadSilenceSec = 0) {
  const PPQ = 480
  const events = []
  const add = (delta, bytes) => events.push([delta, bytes])
  add(0, [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])
  add(0, [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08])
  const secToTicks = (s) => Math.round((s * PPQ) / 0.5)
  const ordered = [...notes].sort((a, b) => a.start - b.start)
  let cur = 0
  for (const n of ordered) {
    const t0 = secToTicks(leadSilenceSec + n.start)
    const t1 = secToTicks(leadSilenceSec + n.end)
    events.push([t0 - cur, [0x90, n.pitch, 0x64]])
    events.push([t1 - t0, [0x80, n.pitch, 0x40]])
    cur = t1
  }
  events.push([0, [0xff, 0x2f, 0x00]])
  const varlen = (n) => {
    const b = [n & 0x7f]
    while ((n >>= 7) > 0) b.unshift((n & 0x7f) | 0x80)
    return b
  }
  const track = []
  for (const [delta, bytes] of events) track.push(...varlen(delta), ...bytes)
  const header = [...Buffer.from('MThd', 'ascii'), 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0]
  const chunk = [
    ...Buffer.from('MTrk', 'ascii'),
    (track.length >> 24) & 0xff,
    (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ]
  return Buffer.from([...header, ...chunk])
}

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

async function dump(label) {
  const info = await page.evaluate(() => {
    const c = document.querySelector('.waterfall__canvas')
    if (!c) return null
    const w = c.width,
      h = c.height
    const ctx = c.getContext('2d')
    const data = ctx.getImageData(0, 0, w, h).data
    const cols = 100,
      rows = 30
    const chars = ' .:-=+*#%@'
    let out = ''
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const x = Math.floor((col * w) / cols)
        const y = Math.floor((r * h) / rows)
        const i = (y * w + x) * 4
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3 / 255
        out += chars[Math.min(9, Math.floor(lum * 10))]
      }
      out += '\n'
    }
    return { w, h, elW: c.parentElement.clientWidth, elH: c.parentElement.clientHeight, ascii: out }
  })
  console.log(`\n===== ${label} =====`)
  if (info === null) {
    console.log('(无瀑布流画布)')
    return
  }
  console.log(`canvas ${info.w}x${info.h} 元素 ${info.elW}x${info.elH}`)
  console.log(info.ascii)
}

const file1 = makeMidi([
  { pitch: 60, start: 0, end: 0.25 },
  { pitch: 64, start: 0.25, end: 0.5 },
  { pitch: 67, start: 0.5, end: 0.75 },
  { pitch: 60, start: 0.75, end: 1.25 },
  { pitch: 64, start: 0.75, end: 1.25 },
  { pitch: 67, start: 0.75, end: 1.25 },
  { pitch: 48, start: 0.75, end: 1.25 },
  { pitch: 72, start: 1.25, end: 1.75 },
  { pitch: 76, start: 1.5, end: 2.0 },
  { pitch: 79, start: 1.75, end: 2.25 },
])
const file2 = makeMidi(
  [
    { pitch: 60, start: 0, end: 0.5 },
    { pitch: 64, start: 0.5, end: 1 },
  ],
  6,
) // 前 6 秒静音

writeFileSync('/tmp/probe-1.mid', file1)
writeFileSync('/tmp/probe-2.mid', file2)

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await dump('A: 空应用（未导入）')

  await page.locator('.hidden-input').first().setInputFiles('/tmp/probe-1.mid')
  await page.waitForSelector('.library__item')
  await page.locator('.library__item').first().click()
  await page.waitForTimeout(1200)
  await dump('B: 载入 file1 后（暂停在 0）')

  await page.locator('.transport__play').click()
  await page.waitForTimeout(1000)
  await dump('C: 播放 1 秒')

  await page.locator('.transport__play').click() // 暂停
  await page.locator('.view-switch__btn[data-mode="waterfall"]').click()
  await page.waitForTimeout(400)
  await dump('D: 瀑布流单视图（暂停）')

  // 静音前奏文件
  await page.locator('.hidden-input').first().setInputFiles('/tmp/probe-2.mid')
  await page.waitForSelector('.library__item:nth-child(2)')
  await page.locator('.library__item').nth(1).click()
  await page.waitForTimeout(1200)
  await dump('E: 载入 file2（前 6 秒静音，暂停在 0）')
} finally {
  await browser.close()
}
if (errors.length > 0) {
  console.log('\n页面错误：')
  for (const e of errors.slice(0, 10)) console.log('  ' + e)
}
