/**
 * 导出 UI 审计截图到 docs/development/design/images（文档用）
 * 用法：先 `pnpm dev`，再 `node scripts/ui-audit-export.mjs`
 * 全页图 1×（1512×945）、局部图 2×（细节清晰且体积可控）。
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'development', 'design', 'images')
mkdirSync(OUT, { recursive: true })
const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'
const TMP = join(ROOT, '.tmp', 'audit')
mkdirSync(TMP, { recursive: true })
const MIDI = join(TMP, 'demo.mid')
const MULTI = join(TMP, 'multitrack.mid')
const CJK = join(TMP, 'cjk-tracks.mid')

/**
 * 生成轨名为 UTF-8 中文的 MIDI（非 ASCII 轨名证据用）。
 * 手工拼 SMF 字节而非用 @tonejs/midi 写入——后者按 latin-1 逐字节写文本事件，
 * 写出的文件本身就是坏的，无法用于证明"解析端"的问题。
 */
function makeCjkMidi() {
  const vlq = (n) => {
    const out = [n & 0x7f]
    for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80)
    return Buffer.from(out)
  }
  const metaText = (text) => {
    const b = Buffer.from(text, 'utf8') // 关键：UTF-8 编码轨名（SMF 常见写法）
    return Buffer.concat([vlq(0), Buffer.from([0xff, 0x03]), vlq(b.length), b])
  }
  const tempo = Buffer.from([0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])
  const on = (ch, p, v, delta = 0) => Buffer.concat([vlq(delta), Buffer.from([0x90 | ch, p, v])])
  const off = (ch, p, delta) => Buffer.concat([vlq(delta), Buffer.from([0x80 | ch, p, 0])])
  const track = (events) => {
    const body = Buffer.concat([...events, Buffer.from([0x00, 0xff, 0x2f, 0x00])])
    const hdr = Buffer.alloc(8)
    hdr.write('MTrk', 0, 'ascii')
    hdr.writeUInt32BE(body.length, 4)
    return Buffer.concat([hdr, body])
  }
  const t1 = track([
    metaText('右手旋律'),
    tempo,
    on(0, 72, 100),
    off(0, 72, 480),
    on(0, 76, 90),
    off(0, 76, 480),
  ])
  const t2 = track([metaText('左手伴奏'), on(1, 48, 80), off(1, 48, 960)])
  const hdr = Buffer.alloc(14)
  hdr.write('MThd', 0, 'ascii')
  hdr.writeUInt32BE(6, 4)
  hdr.writeUInt16BE(0, 8)
  hdr.writeUInt16BE(2, 10)
  hdr.writeUInt16BE(480, 12)
  writeFileSync(CJK, Buffer.concat([hdr, t1, t2]))
}
makeCjkMidi()

const FAKE_MIDI = () => {
  const listeners = new Set()
  const input = {
    id: 'fake-1',
    name: 'Virtual Piano',
    manufacturer: 'PianoKits',
    state: 'connected',
    type: 'input',
    connection: 'open',
    addEventListener(t, f) {
      if (t === 'midimessage') listeners.add(f)
    },
    removeEventListener(t, f) {
      listeners.delete(f)
    },
    __send(bytes) {
      const ev = { data: new Uint8Array(bytes) }
      for (const f of listeners) f(ev)
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

async function scene(fn, { dsf = 1, viewport = { width: 1512, height: 945 } } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dsf })
  await page.addInitScript(FAKE_MIDI)
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 140)))
  await fn(page)
  await page.close()
}

const gotoApp = async (page) => {
  await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library__import', { state: 'attached' })
  await page.waitForTimeout(900)
}
const loadTrack = async (page, file) => {
  await page.locator('.hidden-input').first().setInputFiles(file)
  await page.waitForSelector('.library__item')
  await page.locator('.library__item').first().click()
  await page.waitForSelector('.score__system svg', { timeout: 60000 })
  await page.waitForTimeout(1500)
}
/** 把视图切到目标组合（两个独立开关，不能同时关闭） */
async function setView(page, mode) {
  const want = {
    split: { 瀑布流: true, 乐谱: true },
    waterfall: { 瀑布流: true, 乐谱: false },
    score: { 瀑布流: false, 乐谱: true },
  }[mode]
  for (const [title, on] of Object.entries(want)) {
    const btn = page.locator(`.transport__view[title="${title}"]`).first()
    if ((await btn.getAttribute('aria-pressed')) !== String(on)) {
      await btn.click()
      await page.waitForTimeout(300)
    }
  }
  await page.waitForTimeout(700)
}
/** 弹层是绝对定位、溢出触发器的盒子：按页面区域裁剪而非元素截图 */
async function clipRegion(page, path, selector, pad = 16, dsf = 2) {
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
    path,
    clip: {
      x,
      y,
      width: Math.min(vp.width - x, r.width + pad * 2),
      height: Math.min(vp.height - y, r.height + pad * 2),
    },
  })
}

// 1. 空状态（分屏）
await scene(async (page) => {
  await gotoApp(page)
  await page.screenshot({ path: `${OUT}/01-empty-split.png` })
  console.log('01-empty-split')
})

// 2. 已载入曲目（分屏）
await scene(async (page) => {
  await gotoApp(page)
  await loadTrack(page, MIDI)
  await page.screenshot({ path: `${OUT}/02-split-loaded.png` })
  console.log('02-split-loaded')
})

// 3/4. 单瀑布 / 单谱面
await scene(async (page) => {
  await gotoApp(page)
  await loadTrack(page, MIDI)
  await setView(page, 'waterfall')
  await page.screenshot({ path: `${OUT}/03-waterfall-only.png` })
  console.log('03-waterfall-only')
  await setView(page, 'score')
  await page.screenshot({ path: `${OUT}/04-score-only.png` })
  console.log('04-score-only')
})

// 5. 6 轨播放中
await scene(async (page) => {
  await gotoApp(page)
  await loadTrack(page, MULTI)
  await page.locator('.transport__play').click()
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/05-multitrack-playing.png` })
  console.log('05-multitrack-playing')
})

// 6/7/18. 窄屏：抽屉收起（内容区占满）与抽屉展开（音乐库浮层）
await scene(
  async (page) => {
    await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.library__import', { state: 'attached' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/06-mobile-390.png` })
    // 打开抽屉（浮层 + 遮罩）
    await page.locator('.transport__sidebar-toggle').click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${OUT}/18-mobile-drawer-open.png` })
  },
  { viewport: { width: 390, height: 844 }, dsf: 2 },
)
console.log('06-mobile-390 / 18-mobile-drawer-open')

await scene(
  async (page) => {
    await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.library__import', { state: 'attached' })
    await page.waitForTimeout(1200)
    // 平板竖屏：从抽屉里选曲后抽屉自动收起，直接进入分屏播放形态
    await page.locator('.transport__sidebar-toggle').click()
    await page.waitForTimeout(600)
    await page.locator('.hidden-input').first().setInputFiles(MIDI)
    await page.waitForSelector('.library__item')
    await page.locator('.library__item').first().click()
    await page.waitForSelector('.score__system svg', { timeout: 60000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/07-tablet-820.png` })
  },
  { viewport: { width: 820, height: 1180 }, dsf: 1 },
)
console.log('07-tablet-820')

// 8. 调试页：MIDI 键盘（按下三个音）
await scene(async (page) => {
  await page.goto(`${BASE_URL}/midi-keyboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.evaluate(() => {
    for (const m of [60, 64, 67]) window.__fakeMidi.__send([0x90, m, 96])
  })
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/08-debug-midi-keyboard.png` })
  console.log('08-debug-midi-keyboard')
})

// 9. 录音页录制中
await scene(async (page) => {
  await page.goto(`${BASE_URL}/midi-recorder`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.locator('.recorder__btn').nth(1).click()
  await page.waitForTimeout(600)
  for (const n of [60, 64, 67, 72]) {
    await page.waitForTimeout(300)
    await page.evaluate((m) => window.__fakeMidi.__send([0x90, m, 96]), n)
    await page.waitForTimeout(330)
    await page.evaluate((m) => window.__fakeMidi.__send([0x80, m, 0]), n)
  }
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/09-recorder-recording.png` })
  console.log('09-recorder-recording')
})

// 10~15. 局部（2×）
await scene(
  async (page) => {
    await gotoApp(page)
    await loadTrack(page, MULTI)
    await page.locator('.transport__play').click()
    await page.waitForTimeout(4000)
    await page.locator('.playerdock').screenshot({ path: `${OUT}/10-playerdock.png` })
    console.log('10-playerdock')
    await page.locator('.transport__play').click()
    await page.waitForTimeout(400)
    await page.locator('.library').screenshot({ path: `${OUT}/11-library.png` })
    console.log('11-library')
    await page.locator('.transport__practice').hover()
    await page.waitForTimeout(700)
    await clipRegion(page, `${OUT}/12-practice-menu.png`, '.transport__practice-menu', 20)
    console.log('12-practice-menu')
    await page.mouse.move(700, 300)
    await page.waitForTimeout(400)
    await page.locator('.transport__midi').click()
    await page.waitForTimeout(700)
    await clipRegion(page, `${OUT}/13-midi-status-menu.png`, '.transport__midi-menu', 20)
    console.log('13-midi-status-menu')
    await page.mouse.click(700, 300)
    await page.waitForTimeout(400)
    await page.locator('.transport__volume-btn').hover()
    await page.waitForTimeout(700)
    await clipRegion(page, `${OUT}/14-volume-popup.png`, '.transport__volume-popup', 24)
    console.log('14-volume-popup')
    await page.mouse.move(700, 300)
    await page.waitForTimeout(400)
    await page.locator('.library__collapse').click()
    await page.waitForTimeout(900)
    await page.locator('.playerdock').screenshot({ path: `${OUT}/15-sidebar-collapsed-dock.png` })
    console.log('15-sidebar-collapsed-dock')
  },
  { dsf: 2 },
)

// 16. 侧栏收起后的全页（1×）——分屏 + 已载入曲目，用于确认收起后布局正常
await scene(async (page) => {
  await gotoApp(page)
  await loadTrack(page, MIDI)
  await page.locator('.library__collapse').click()
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/16-sidebar-collapsed.png` })
  console.log('16-sidebar-collapsed')
})

// 17. 非 ASCII 轨名：练习菜单轨名乱码证据
//    夹具轨名为 UTF-8 中文（右手旋律 / 左手伴奏），@tonejs/midi 按 latin-1 解码后显示为乱码
await scene(
  async (page) => {
    await gotoApp(page)
    await page.locator('.hidden-input').first().setInputFiles(CJK)
    await page.waitForSelector('.library__item')
    await page.locator('.library__item').first().click()
    await page.waitForSelector('.score__system svg', { timeout: 60000 })
    await page.waitForTimeout(2500)
    await page.locator('.transport__practice').hover()
    await page.waitForSelector('.transport__practice-item__name', { timeout: 20000 })
    await page.waitForTimeout(600)
    const names = await page.locator('.transport__practice-item__name').allInnerTexts()
    console.log('17-cjk-track-names  菜单轨名 =', JSON.stringify(names))
    await clipRegion(page, `${OUT}/17-cjk-track-names.png`, '.transport__practice-menu', 20)
  },
  { dsf: 2 },
)

await browser.close()

/**
 * 陈旧配图检查：draft1 的错误结论部分源于读到了 .tmp/ 里跨天累积的旧图，
 * 以及 docs 目录里未清理的历史配图。这里做一次"名单核对"，
 * 列出本次未生成的文件，提醒确认后删除，避免旧图被当成当前实现的证据。
 */
const EXPECTED = new Set([
  '01-empty-split.png',
  '02-split-loaded.png',
  '03-waterfall-only.png',
  '04-score-only.png',
  '05-multitrack-playing.png',
  '06-mobile-390.png',
  '07-tablet-820.png',
  '08-debug-midi-keyboard.png',
  '09-recorder-recording.png',
  '10-playerdock.png',
  '11-library.png',
  '12-practice-menu.png',
  '13-midi-status-menu.png',
  '14-volume-popup.png',
  '15-sidebar-collapsed-dock.png',
  '16-sidebar-collapsed.png',
  '17-cjk-track-names.png',
  '18-mobile-drawer-open.png',
])
const stale = readdirSync(OUT).filter((f) => f.endsWith('.png') && !EXPECTED.has(f))
if (stale.length > 0) {
  console.log('\n⚠ 配图目录存在本次未生成的旧图（可能已与实现不符，请确认后删除）：')
  for (const f of stale) console.log(`   ${f}`)
}
console.log(`\n文档配图已导出 -> ${OUT}`)
