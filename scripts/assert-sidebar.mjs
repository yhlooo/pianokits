/**
 * 侧栏形态断言（回归守护）：桌面折叠态 / 窄屏抽屉态 / 断点边界。
 *
 * 由来：2026-09-12 合并 setSidebarCollapsed 与 setSidebarDrawerMode 时，把"桌面已收起"
 * 这个状态传丢了，导致**宽屏下侧栏收起来后播放坞的展开按钮不显示**（无法再展开）。
 * 这类"状态没传到 DOM"的错误用肉眼看几何尺寸看不出来（侧栏宽度是对的），
 * 必须断言"按钮可见性 ↔ 侧栏状态"的一致性。用法：
 *   pnpm dev   # 终端 1
 *   node scripts/assert-sidebar.mjs   # 终端 2
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const failures = []

/**
 * 安全点击：元素不可见/不可点时记为失败并继续，而不是抛错中断整轮断言
 * （断言脚本的价值在于一次跑完把所有问题列出来）。
 */
async function safeClick(locator, label, failures) {
  try {
    await locator.click({ timeout: 5000 })
    return true
  } catch {
    failures.push(`${label}: 元素不可点击（可能未显示）`)
    return false
  }
}

/** 进入页面并读取侧栏相关状态 */
async function inspect(page) {
  return page.evaluate(() => {
    const main = document.querySelector('.main')
    const toggle = document.querySelector('.transport__sidebar-toggle')
    const lib = document.querySelector('.library')
    return {
      cls: main.className,
      drawer: main.classList.contains('is-drawer'),
      drawerOpen: main.classList.contains('is-drawer-open'),
      collapsed: main.classList.contains('is-collapsed'),
      libWidth: Math.round(lib.getBoundingClientRect().width),
      toggleVisible: getComputedStyle(toggle).visibility !== 'hidden',
      toggleIsClose: toggle.title === '收起音乐库',
      // 头部关闭按钮只在抽屉打开时出现；桌面端应始终不存在
      closeVisible: (() => {
        const e = document.querySelector('.library__close')
        return e ? getComputedStyle(e).display !== 'none' : false
      })(),
      // 收起按钮（桌面用）：固定在侧栏左下角
      collapseInFoot:
        document.querySelector('.library__collapse')?.parentElement?.className === 'library__foot',
      backdrop: document.querySelector('.main__backdrop') !== null,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
}

/** 核心不变式：按钮该不该出现，必须与侧栏当前形态一致 */
function check(label, s) {
  const wantVisible = s.drawer ? true : s.collapsed
  const wantClose = s.drawer && s.drawerOpen
  const problems = []
  if (s.toggleVisible !== wantVisible) {
    problems.push(`展开按钮可见性=${s.toggleVisible}，期望 ${wantVisible}`)
  }
  if (s.toggleIsClose !== wantClose) {
    problems.push(`按钮图标语义=关闭(${s.toggleIsClose})，期望 ${wantClose}`)
  }
  if (s.overflowX > 0) problems.push(`横向溢出 ${s.overflowX}px`)
  // 桌面展开态：侧栏必须占宽；桌面收起态：必须为 0
  if (!s.drawer && !s.collapsed && s.libWidth === 0) problems.push('桌面展开态但侧栏宽度为 0')
  if (!s.drawer && s.collapsed && s.libWidth !== 0) problems.push('桌面收起态但侧栏仍有宽度')
  if (s.drawer && !s.drawerOpen && s.backdrop) problems.push('抽屉收起却残留遮罩')
  if (s.drawer && s.drawerOpen && !s.backdrop) problems.push('抽屉打开却没有遮罩')
  // 关闭按钮只在"抽屉已打开"时出现（桌面端永不出现）
  if (s.closeVisible !== wantClose) {
    problems.push(`头部关闭按钮可见性=${s.closeVisible}，期望 ${wantClose}`)
  }
  if (!s.collapseInFoot) problems.push('收起按钮不在侧栏左下角（脚注）')
  if (problems.length > 0) failures.push(`${label}: ${problems.join('；')}`)
  return problems.length === 0 ? 'ok' : 'FAIL'
}

// ---------- 桌面：展开 → 收起 → 再展开 ----------
{
  const page = await browser.newPage({ viewport: { width: 1512, height: 945 } })
  await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library__import')
  await page.waitForTimeout(700)
  console.log('桌面 展开态   ', check('桌面/展开态', await inspect(page)))
  if (await safeClick(page.locator('.library__collapse'), '桌面/收起按钮', failures)) {
    await page.waitForTimeout(600)
    console.log('桌面 收起态   ', check('桌面/收起态', await inspect(page)))
    if (await safeClick(page.locator('.transport__sidebar-toggle'), '桌面/展开按钮', failures)) {
      await page.waitForTimeout(600)
      console.log('桌面 再展开   ', check('桌面/再展开态', await inspect(page)))
    }
  }
  await page.close()
}

// ---------- 窄屏：抽屉收起 → 打开 → Esc 关闭 ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.library__import', { state: 'attached' })
  await page.waitForTimeout(900)
  console.log('窄屏 抽屉收起 ', check('窄屏/抽屉收起', await inspect(page)))
  if (await safeClick(page.locator('.transport__sidebar-toggle'), '窄屏/抽屉按钮', failures)) {
    await page.waitForTimeout(600)
    console.log('窄屏 抽屉打开 ', check('窄屏/抽屉打开', await inspect(page)))
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  console.log('窄屏 Esc 后   ', check('窄屏/Esc 后', await inspect(page)))
  await page.close()
}

// ---------- 断点边界：两侧都不该溢出 ----------
for (const width of [901, 900, 899]) {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  await page.goto(`${BASE_URL}/midi-player`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.library__import', { state: 'attached' })
  await page.waitForTimeout(500)
  const s = await inspect(page)
  console.log(`断点 ${width}px  `, check(`断点/${width}`, s), `drawer=${s.drawer}`)
  await page.close()
}

await browser.close()

if (failures.length > 0) {
  console.error('\n侧栏断言失败：')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('\n侧栏形态断言全部通过')
