/**
 * 冒烟测试（开发用）：无头 Chromium 跑一遍 导入 → 选曲 → 渲染 → 播放 主流程。
 * 用法：先 `pnpm dev`，再 `node scripts/smoke-test.mjs`
 * 产物：截图写入 /tmp/pianokits-smoke-*.png
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

/** 生成最小钢琴 MIDI（format 0，480 PPQ，120 BPM，C 大调和弦 + 分解音） */
function makeMidi() {
  const events = []
  const add = (delta, bytes) => events.push([delta, bytes])
  add(0, [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]) // tempo 120
  add(0, [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]) // 4/4
  // 分解和弦 C4 E4 G4（八分音符）
  for (const pitch of [0x3c, 0x40, 0x43]) {
    add(0, [0x90, pitch, 0x64])
    add(240, [0x80, pitch, 0x40])
  }
  // 双手 C 大调柱式和弦（1/4 拍 = 480 ticks）
  add(0, [0x90, 0x30, 0x64, 0x90, 0x37, 0x64, 0x90, 0x3c, 0x64, 0x90, 0x40, 0x64, 0x90, 0x43, 0x64])
  add(
    480,
    [0x80, 0x30, 0x40, 0x80, 0x37, 0x40, 0x80, 0x3c, 0x40, 0x80, 0x40, 0x40, 0x80, 0x43, 0x40],
  )
  add(0, [0xff, 0x2f, 0x00]) // end of track

  const varlen = (n) => {
    const bytes = [n & 0x7f]
    while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80)
    return bytes
  }
  const track = []
  for (const [delta, bytes] of events) {
    track.push(...varlen(delta), ...bytes)
  }
  const header = [
    ...Buffer.from('MThd', 'ascii'),
    0,
    0,
    0,
    6, // length
    0,
    0, // format 0
    0,
    1, // 1 track
    1,
    0xe0, // 480 PPQ
  ]
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
const problems = []
const sampleRequests = []
const externalRequests = []
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
})
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
page.on('request', (req) => {
  const url = req.url()
  if (url.includes('.ogg') || url.includes('.m4a')) {
    sampleRequests.push(url)
    if (!url.startsWith(BASE_URL + '/')) externalRequests.push(url)
  } else if (/^https?:\/\//.test(url) && !url.startsWith(BASE_URL)) {
    externalRequests.push(url)
  }
})

try {
  writeFileSync('/tmp/pianokits-test.mid', makeMidi())

  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library__import')

  // 导入
  await page.locator('.hidden-input').first().setInputFiles('/tmp/pianokits-test.mid')
  await page.waitForSelector('.library__item')
  console.log('导入完成，列表条目出现')

  // 选曲（触发解析 + 五线谱懒加载 + 渲染）
  await page.locator('.library__item').first().click()
  try {
    // 首次运行需要 Vite 冷编译 VexFlow chunk，放宽到 60s
    await page.waitForSelector('.score__system svg', { timeout: 60000 })
  } catch {
    console.error('五线谱系统未在 60s 内渲染，已收集的问题：')
    for (const p of problems.slice(0, 20)) console.error('  ' + p)
    const notice = await page
      .locator('.notice')
      .textContent()
      .catch(() => '(无)')
    console.error('notice 条:', notice)
    await page.screenshot({ path: '/tmp/pianokits-smoke-fail.png' })
    throw new Error('score render timeout')
  }
  console.log('五线谱系统已渲染（VexFlow SVG 存在）')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: '/tmp/pianokits-smoke-1-split.png' })

  // 播放 1.2 秒，检查时间推进
  await page.locator('.transport__play').click()
  await page.waitForTimeout(1200)
  const time1 = await page.locator('.transport__time').textContent()
  console.log('播放中时间标签:', time1)
  await page.screenshot({ path: '/tmp/pianokits-smoke-2-playing.png' })

  // 暂停后再截瀑布流单视图
  await page.locator('.transport__play').click()
  await page.locator('.view-switch__btn[data-mode="waterfall"]').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/pianokits-smoke-3-waterfall.png' })

  // 五线谱单视图
  await page.locator('.view-switch__btn[data-mode="score"]').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/pianokits-smoke-4-score.png' })

  // 采样加载观察（不阻塞成败）：给 20 秒，检查是否报错
  await page.waitForTimeout(20000)

  // ---------- 程序化断言 ----------
  // 0. 外壳：顶栏页签存在，当前工具挂载在工具区
  const shellStats = await page.evaluate(() => ({
    tabs: document.querySelectorAll('.shell__tab').length,
    activeTab: document.querySelector('.shell__tab.is-active')?.textContent ?? null,
    toolMounted: document.querySelector('.shell__tool .library') !== null,
  }))
  console.log('外壳:', JSON.stringify(shellStats))
  if (shellStats.tabs < 1 || shellStats.activeTab === null || !shellStats.toolMounted) {
    problems.push(`外壳结构异常: ${JSON.stringify(shellStats)}`)
  }

  // 1. 五线谱 SVG 内容量（音符/谱表元素）
  const svgStats = await page.evaluate(() => {
    const svgs = document.querySelectorAll('.score__system svg')
    let paths = 0
    for (const svg of svgs) paths += svg.querySelectorAll('path, rect, polygon, ellipse').length
    return { systems: svgs.length, elements: paths }
  })
  console.log('SVG 统计:', JSON.stringify(svgStats))
  if (svgStats.systems < 1 || svgStats.elements < 50) {
    problems.push(`五线谱 SVG 元素过少: ${JSON.stringify(svgStats)}`)
  }

  // 2. 瀑布流画布：底部键盘条已绘制（判定线在底部），且音符区有下落的音符条
  //    （回归守卫：时间→纵坐标映射曾反转导致音符条全部不可见，而键盘始终在画）
  const canvasStats = await page.evaluate(() => {
    const canvas = document.querySelector('.waterfall__canvas')
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const h = canvas.height
    const w = canvas.width
    let nonBg = 0
    let keyboardSamples = 0
    let noteAreaSamples = 0
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const i = (y * w + x) * 4
        const isBg = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0
        if (!isBg) {
          nonBg++
          if (y > h - 96) keyboardSamples++
          else noteAreaSamples++
        }
      }
    }
    return { w, h, nonBgSamples: nonBg, keyboardSamples, noteAreaSamples }
  })
  console.log('瀑布流画布:', JSON.stringify(canvasStats))
  if (canvasStats.nonBgSamples < 100) problems.push('瀑布流画布几乎空白')
  if (canvasStats.keyboardSamples < 50)
    problems.push('瀑布流底部键盘未绘制（判定线应在底部键盘处）')
  if (canvasStats.noteAreaSamples < 50) problems.push('瀑布流音符区无内容（音符条未绘制）')

  // 3. 采样全部来自本地镜像，且升号（♯）映射生效
  const sharpRequests = sampleRequests.filter((u) => u.includes('%E2%99%AF'))
  console.log(
    `采样请求: ${sampleRequests.length} 个，其中升号文件 ${sharpRequests.length} 个，外部请求 ${externalRequests.length} 个`,
  )
  if (externalRequests.length > 0)
    problems.push(`存在外部请求: ${externalRequests.slice(0, 5).join(', ')}`)
  if (sampleRequests.length < 200) problems.push(`采样请求过少: ${sampleRequests.length}`)
  if (sharpRequests.length < 1) problems.push('未发现升号（♯）采样请求，映射可能失效')

  // 4. 播放高亮：播放中五线谱应有活动色样式
  const highlightCount = await page.evaluate(() => {
    let n = 0
    for (const svg of document.querySelectorAll('.score__system svg')) {
      if (svg.outerHTML.includes('#a8772e')) n++
    }
    return n
  })
  console.log('含高亮色的系统数:', highlightCount)
} finally {
  await browser.close()
}

if (problems.length > 0) {
  console.error('\n发现问题：')
  for (const p of problems.slice(0, 20)) console.error('  ' + p)
  process.exit(1)
}
console.log('\n冒烟测试通过（无控制台错误/页面异常）')
