/**
 * UI 审计：交互态（弹层/抽屉/通知/录音/调试）截图
 * 用法：先 `pnpm dev`，再 `node scripts/ui-audit-states.mjs`
 * 产物：.tmp/audit/state-*.png
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.tmp', 'audit')
mkdirSync(OUT, { recursive: true })
const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'
const MIDI = join(OUT, 'demo.mid')

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

/**
 * 按"弹层 + 周围留白"裁剪页面区域。
 * 弹层是绝对定位、溢出其触发器的盒子，因此不能用元素截图（只会截到触发器本身）。
 */
async function clipRegion(page, path, selector, pad = 16) {
  const r = await page
    .locator(selector)
    .first()
    .evaluate((e) => {
      const b = e.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    })
  const vp = page.viewportSize()
  const clip = {
    x: Math.max(0, r.x - pad),
    y: Math.max(0, r.y - pad),
    width: Math.min(vp.width - Math.max(0, r.x - pad), r.width + pad * 2),
    height: Math.min(vp.height - Math.max(0, r.y - pad), r.height + pad * 2),
  }
  await page.screenshot({ path, clip })
}

/** 单个场景：新开页面 -> 执行 -> 截图 */
async function scene(name, fn, { dsf = 2, viewport = { width: 1512, height: 945 } } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dsf })
  await page.addInitScript(FAKE_MIDI)
  page.on('pageerror', (e) => console.log(`[pageerror:${name}]`, e.message.slice(0, 160)))
  try {
    await fn(page)
    console.log('shot:', name)
  } catch (e) {
    console.log('FAIL:', name, String(e).split('\n')[0])
  }
  await page.close()
}

const gotoApp = async (page) => {
  await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library__import', { state: 'attached' })
  await page.waitForTimeout(900)
}
const loadTrack = async (page) => {
  await page.locator('.hidden-input').first().setInputFiles(MIDI)
  await page.waitForSelector('.library__item')
  await page.locator('.library__item').first().click()
  await page.waitForSelector('.score__system svg', { timeout: 60000 })
  await page.waitForTimeout(1500)
}

// 1. 练习菜单（已载入曲目）
await scene('state-practice-menu', async (page) => {
  await gotoApp(page)
  await loadTrack(page)
  await page.locator('.transport__practice').hover()
  await page.waitForTimeout(700)
  await clipRegion(page, `${OUT}/state-practice-menu.png`, '.transport__practice-menu', 20)
  await page.screenshot({ path: `${OUT}/state-practice-menu-full.png` })
})

// 2. MIDI 状态弹层
await scene('state-midi-menu', async (page) => {
  await gotoApp(page)
  await page.locator('.transport__midi').click()
  await page.waitForTimeout(700)
  await clipRegion(page, `${OUT}/state-midi-menu.png`, '.transport__midi-menu', 20)
})

// 3. 音量弹层（hover 展开）
await scene('state-volume-popup', async (page) => {
  await gotoApp(page)
  await page.locator('.transport__volume-btn').hover()
  await page.waitForTimeout(700)
  await clipRegion(page, `${OUT}/state-volume-popup.png`, '.transport__volume-popup', 24)
  await page.locator('.playerdock').screenshot({ path: `${OUT}/state-volume-dock.png` })
})

// 4. 侧栏收起 + 折叠把手
await scene('state-sidebar-collapsed', async (page) => {
  await gotoApp(page)
  await page.locator('.library__collapse').click()
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/state-sidebar-collapsed.png` })
})

// 5. 拖放态（文件拖入侧栏）
await scene('state-drag-over', async (page) => {
  await gotoApp(page)
  await page.evaluate(() => {
    const lib = document.querySelector('.library')
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(4)], 'x.mid', { type: 'audio/midi' }))
    lib.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }))
    lib.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
  })
  await page.waitForTimeout(600)
  await page.locator('.library').screenshot({ path: `${OUT}/state-drag-over.png` })
})

// 6. 基础 MIDI 不可用通知（无 requestMIDIAccess）
await scene('state-midi-notice', async (page) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: undefined })
  })
  await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library__import', { state: 'attached' })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/state-midi-notice.png` })
})

// 7. 录音页：已连接可用态
await scene('state-recorder-connected', async (page) => {
  await page.goto(`${BASE_URL}/midi-recorder`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.locator('.recorder').screenshot({ path: `${OUT}/state-recorder-connected.png` })
  await page
    .locator('.recorder__controls')
    .screenshot({ path: `${OUT}/state-recorder-controls.png` })
})

// 8. 录音页：录制中
await scene('state-recorder-recording', async (page) => {
  await page.goto(`${BASE_URL}/midi-recorder`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.locator('.recorder__btn').nth(1).click()
  await page.waitForTimeout(600)
  const notes = [
    [60, 0],
    [64, 300],
    [67, 600],
    [72, 900],
  ]
  for (const [n, d] of notes) {
    await page.waitForTimeout(d)
    await page.evaluate((m) => window.__fakeMidi.__send([0x90, m, 96]), n)
    await page.waitForTimeout(320)
    await page.evaluate((m) => window.__fakeMidi.__send([0x80, m, 0]), n)
  }
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/state-recorder-recording.png` })
  await page.locator('.recorder').screenshot({ path: `${OUT}/state-recorder-recording-close.png` })
  await page.locator('.recorder__btn').nth(2).click()
  await page.waitForTimeout(600)
  await page.locator('.recorder').screenshot({ path: `${OUT}/state-recorder-recorded.png` })
})

// 9. 调试菜单展开 + 调试页
await scene('state-debug-menu', async (page) => {
  await gotoApp(page)
  await page.locator('.debug-menu__trigger').click()
  await page.waitForTimeout(500)
  await page.locator('.debug-menu__dropdown').screenshot({ path: `${OUT}/state-debug-menu.png` })
  await page.locator('.shell').screenshot({ path: `${OUT}/state-debug-menu-shell.png` })
})

await scene('state-midi-keyboard-debug', async (page) => {
  await page.goto(`${BASE_URL}/midi-keyboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: `${OUT}/state-midi-keyboard-debug.png` })
  await page.evaluate(() => {
    window.__fakeMidi.__send([0x90, 60, 96])
    window.__fakeMidi.__send([0x90, 64, 96])
    window.__fakeMidi.__send([0x90, 67, 96])
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/state-midi-keyboard-pressed.png` })
  await page.keyboard.press('Space')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/state-midi-keyboard-space.png` })
})

// 10. 窄屏 / 移动端（触控，无 hover）
await scene(
  'state-mobile-390',
  async (page) => {
    await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.library__import', { state: 'attached' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/state-mobile-390.png` })
  },
  { viewport: { width: 390, height: 844 }, dsf: 3 },
)

await scene(
  'state-tablet-820',
  async (page) => {
    await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.library__import', { state: 'attached' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/state-tablet-820.png` })
  },
  { viewport: { width: 820, height: 1180 } },
)

await browser.close()
console.log(`\n交互态截图完成 -> ${OUT}/state-*.png`)
