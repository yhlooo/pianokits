/**
 * 开发用冒烟：验证 MIDI 连接按钮交互（暗色/旋转等待/取消/报错通知），
 * 无真实 MIDI 设备环境下授权会被自动拒绝（denied 降级路径）。
 * 用法：先 `pnpm dev`，再 `node scripts/probe-practice.mjs`
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.grantPermissions(['midi'])
const page = await context.newPage()
const problems = []
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
})

try {
  await page.goto(BASE_URL + '/midi-player', { waitUntil: 'networkidle' })
  const midiBtn = page.locator('.transport__midi')
  const practiceBtn = page.locator('.transport__practice')
  const errorToast = page.locator('.notice--bottom-right')
  await midiBtn.waitFor({ timeout: 10000 })

  // 1. 未连接：暗色 + tooltip “连接 MIDI 键盘”，练习禁用
  const initial = await midiBtn.evaluate((el) => ({
    title: el.title,
    color: getComputedStyle(el).color,
    connecting: el.classList.contains('is-connecting'),
    connected: el.classList.contains('is-connected'),
    icon: el.querySelector('svg path')?.getAttribute('d')?.slice(0, 12) ?? '',
  }))
  console.log('未连接状态:', JSON.stringify(initial))
  if (initial.title !== '连接 MIDI 键盘')
    problems.push(`初始 tooltip 应为“连接 MIDI 键盘”，实际“${initial.title}”`)
  if (initial.connecting || initial.connected) problems.push('初始不应处于连接中/已连接')
  if (!(await practiceBtn.isDisabled())) problems.push('未连接时练习按钮应禁用')

  // 2. 点击后立即检查：进入连接中（旋转等待图标）
  await midiBtn.click()
  const during = await midiBtn.evaluate((el) => ({
    title: el.title,
    connecting: el.classList.contains('is-connecting'),
    hasSpinner: el.querySelector('svg path')?.getAttribute('d')?.startsWith('M10 3a7') ?? false,
  }))
  console.log('点击后立即状态:', JSON.stringify(during))
  if (!during.connecting) {
    console.log('  （提示：授权拒绝过快，未能捕捉连接中状态，允许竞态）')
  } else if (during.title !== '连接中（点击取消）') {
    problems.push(`连接中 tooltip 应为“连接中（点击取消）”，实际“${during.title}”`)
  }

  // 3. 等待授权结果（无头环境自动拒绝）→ 右下角报错通知 + 按钮恢复暗色
  await page.waitForTimeout(1200)
  const after = await midiBtn.evaluate((el) => ({
    title: el.title,
    connecting: el.classList.contains('is-connecting'),
    connected: el.classList.contains('is-connected'),
  }))
  const toast = await errorToast.evaluate((el) => ({
    visible: el.classList.contains('is-visible'),
    text: el.querySelector('.notice__text')?.textContent ?? '',
    rect: el.getBoundingClientRect().toJSON(),
  }))
  console.log('授权结果后按钮:', JSON.stringify(after))
  console.log('右下角通知:', JSON.stringify(toast))
  if (after.connecting) problems.push('结束后不应仍是连接中')
  if (after.connected) problems.push('无设备环境不应显示已连接')
  if (!toast.visible) problems.push('连接失败应弹出右下角报错通知')
  else {
    if (toast.rect.x + toast.rect.width < 1200) problems.push('报错通知应位于右下角')
    if (!(toast.rect.y > 700)) problems.push('报错通知应位于底部区域')
  }
  if (after.title !== 'MIDI 授权被拒绝（点击重试）') {
    problems.push(`被拒后 tooltip 应为“MIDI 授权被拒绝（点击重试）”，实际“${after.title}”`)
  }

  await page.screenshot({ path: '/tmp/pianokits-practice-ui.png' })
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
