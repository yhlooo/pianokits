/**
 * 开发用冒烟：验证「MIDI 键盘」调试页的力度与踏板显示（真实 Chromium + 假 Web MIDI 设备）。
 *
 * 为什么需要它：力度/踏板是纯前端渲染逻辑，但**只有真实浏览器**才能验证
 * - 音名方块右上角力度角标、键盘键色的力度深浅（内联渐变）；
 * - 踏板行三格的百分比/原始值/绿色背景（触发与否由 CC 值决定）；
 * - 消息接入链路（requestMIDIAccess → midimessage → 解析 → 状态 → 渲染）。
 *
 * 用法：先 `pnpm dev`（或复用已在 5173 跑着的 dev server），再
 *   node scripts/probe-midi-debug-velocity-pedal.mjs
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const problems = []
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
})

// 假 MIDI 设备：在页面脚本执行前替换 requestMIDIAccess（必须在 addInitScript 里做）
await page.addInitScript(() => {
  const input = new EventTarget()
  const access = {
    inputs: new Map([['in-1', input]]),
    outputs: new Map(),
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(input, 'name', { value: 'Fake Keyboard' })
  Object.defineProperty(input, 'manufacturer', { value: 'ACME' })
  input.send = (bytes) => {
    const event = new Event('midimessage')
    event.data = Uint8Array.from(bytes)
    input.dispatchEvent(event)
  }
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: () => Promise.resolve(access),
  })
  window.__fakeMidi = input
})

const send = (bytes) => page.evaluate((b) => window.__fakeMidi.send(b), bytes)

try {
  await page.goto(BASE_URL + '/midi-keyboard', { waitUntil: 'networkidle' })
  // 断言读 computed style，必须绕开 120ms 过渡（否则读到的是过渡起点的颜色）
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })
  await page.locator('.midi-debug__status').waitFor({ timeout: 10000 })
  await page.waitForFunction(
    () => document.querySelector('.midi-debug__status')?.textContent?.includes('已连接'),
    { timeout: 5000 },
  )
  console.log('状态行:', await page.locator('.midi-debug__status').textContent())

  // —— 0. 迁移回归：设备列表 + 折叠的诊断面板四项仍由共享层数据驱动 ——
  const devices = await page.$$eval('.midi-debug__device', (n) => n.map((x) => x.textContent))
  console.log('设备列表:', JSON.stringify(devices))
  if (devices[0] !== 'ACME Fake Keyboard') problems.push(`设备列表应显示厂商+名称，实际 ${devices}`)
  await page.locator('.midi-debug__diag-toggle').click()
  const diag = await page.$$eval('.midi-debug__diag dt, .midi-debug__diag dd', (n) =>
    n.map((x) => x.textContent),
  )
  console.log('诊断面板:', JSON.stringify(diag))
  const diagText = diag.join(' | ')
  if (!diagText.includes('安全上下文')) problems.push('诊断面板缺少“安全上下文”')
  if (!diagText.includes('Web MIDI API')) problems.push('诊断面板缺少“Web MIDI API”')
  if (!diagText.includes('MIDI 权限')) problems.push('诊断面板缺少“MIDI 权限”')
  if (!diagText.includes('连接阶段')) problems.push('诊断面板缺少“连接阶段”')
  if (!diagText.includes('已连接，监听按键与踏板中')) {
    problems.push(`连接阶段应显示已连接监听中，实际：${diagText}`)
  }
  if (!(await page.locator('.midi-debug__retry').isHidden())) {
    problems.push('连接正常时不应显示“重试连接”按钮')
  }
  await page.locator('.midi-debug__diag-toggle').click() // 收起，保持截图干净

  // —— 1. 力度：同时按下三键（C4 力度 20 / E4 100 / G4 127）——
  await send([0x90, 60, 20])
  await send([0x90, 64, 100])
  await send([0x90, 67, 127])
  const chips = await page.$$eval('.midi-debug__key', (nodes) =>
    nodes.map((n) => ({
      name: n.querySelector('.midi-debug__key-name')?.textContent,
      velocity: n.querySelector('.midi-debug__velocity')?.textContent,
      nameOpacity: getComputedStyle(n.querySelector('.midi-debug__key-name')).opacity,
      badgeColor: getComputedStyle(n.querySelector('.midi-debug__velocity')).color,
      fill: n.style.backgroundColor,
    })),
  )
  console.log('音名方块:', JSON.stringify(chips))
  if (chips.length !== 3) problems.push(`应显示 3 个音名方块，实际 ${chips.length}`)
  const byName = (n) => chips.find((c) => c.name === n)
  if (byName('C4')?.velocity !== '20') problems.push('C4 力度角标应为 20')
  if (byName('G4')?.velocity !== '127') problems.push('G4 力度角标应为 127')
  const op = (n) => Number(byName(n)?.nameOpacity ?? '0')
  if (!(op('C4') < op('E4') && op('E4') < op('G4'))) {
    problems.push(`音名亮度应随力度递增：C4=${op('C4')} E4=${op('E4')} G4=${op('G4')}`)
  }
  // 音名方块背景底色（半透明白）也随力度加深
  const fillAlpha = (n) => {
    const bg = byName(n)?.fill ?? ''
    const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(bg)
    return m === null ? null : Number(m[1])
  }
  console.log('方块底色:', JSON.stringify(chips.map((c) => [c.name, c.fill])))
  if (!(
    (fillAlpha('C4') ?? 1) < (fillAlpha('E4') ?? 0) &&
    (fillAlpha('E4') ?? 1) < (fillAlpha('G4') ?? 0)
  )) {
    problems.push(
      `方块底色应随力度加深：${fillAlpha('C4')} / ${fillAlpha('E4')} / ${fillAlpha('G4')}`,
    )
  }
  // 力度角标：与音名同框且字号约为音名的 0.43 倍（1.5rem / 3.5rem）
  const badgeFont = await page.$eval('.midi-debug__key', (n) => ({
    badge: parseFloat(getComputedStyle(n.querySelector('.midi-debug__velocity')).fontSize),
    name: parseFloat(getComputedStyle(n.querySelector('.midi-debug__key-name')).fontSize),
    chipPadding: getComputedStyle(n).padding,
    nameOffset: (() => {
      const cb = n.getBoundingClientRect()
      const nb = n.querySelector('.midi-debug__key-name').getBoundingClientRect()
      return Math.round(nb.left + nb.width / 2 - (cb.left + cb.width / 2))
    })(),
  }))
  console.log('角标字号/居中:', JSON.stringify(badgeFont))
  if (Math.abs(badgeFont.badge / badgeFont.name - 1.5 / 3.5) > 0.02) {
    problems.push(
      `角标字号应为音名的 ${(1.5 / 3.5).toFixed(2)} 倍，实际 ${badgeFont.badge / badgeFont.name}`,
    )
  }
  if (badgeFont.chipPadding !== '12px 18px') {
    problems.push(
      `chip 内边距应为对称的 12px 18px（不为角标留额外空间），实际 ${badgeFont.chipPadding}`,
    )
  }
  if (Math.abs(badgeFont.nameOffset) > 1) {
    problems.push(`音名应在方框正中，实际偏移 ${badgeFont.nameOffset}px`)
  }

  // —— 2. 键盘按键深浅：解析内联渐变的琥珀分量 ——
  const keyInfo = await page.evaluate(() => {
    const read = (pitch) => {
      const el = document.querySelector('.piano__wkey[data-pitch="' + pitch + '"]')
      if (el === null) return null
      const style = el.getAttribute('style') ?? ''
      // style 里同时有 left: calc(...) 与 background: linear-gradient(rgb(顶), rgb(底))：
      // 只取 background 段，用 split 解析（不写正则，免得转义层层叠加）
      const at = style.indexOf('background:')
      const bg = at < 0 ? '' : style.slice(at)
      const nums = bg
        .slice(bg.indexOf('(') + 1)
        .split(/[^0-9]+/)
        .filter((t) => t !== '')
        .map(Number)
      return {
        bg,
        top: nums.length >= 3 ? [nums[0], nums[1], nums[2]] : null,
        bottom: nums.length >= 6 ? [nums[3], nums[4], nums[5]] : null,
        alpha: el.style.getPropertyValue('--press-alpha'),
      }
    }
    return { soft: read(60), mid: read(64), hard: read(67) }
  })
  console.log('键盘键色:', JSON.stringify(keyInfo))
  const alphaOf = (k) => Number(keyInfo[k]?.alpha ?? '0')
  if (!(alphaOf('soft') < alphaOf('mid') && alphaOf('mid') < alphaOf('hard'))) {
    problems.push(
      `键色不透明度应随力度递增：20→${alphaOf('soft')} 100→${alphaOf('mid')} 127→${alphaOf('hard')}`,
    )
  }
  // 按下后仍是琥珀色系：顶色 R 分量明显高于 B 分量（白键本色 R-B 只有 9）
  const amber = (k) => {
    const t = keyInfo[k]?.top
    return t === null || t === undefined ? null : t[0] - t[2]
  }
  if (!((amber('soft') ?? 0) > 30 && (amber('hard') ?? 0) > 30)) {
    problems.push(`白键按下后仍应是琥珀色（R-B 偏暖）：20→${amber('soft')} 127→${amber('hard')}`)
  }
  // 力度越大 → 琥珀叠加越多 → 绿色分量越低（白键本色 G≈241，力度 20 时仍应明显更低）
  const gOf = (k) => keyInfo[k]?.top?.[1] ?? null
  if (!(Number(gOf('hard')) < Number(gOf('soft')))) {
    problems.push(`力度越大键色应越深（G 分量更低）：20→${gOf('soft')} 127→${gOf('hard')}`)
  }

  // —— 3. 踏板：开关键盘（只发 0/127）→ 数值恒显、绿色背景仅在 ≥64 出现 ——
  const pedalState = async () =>
    page.$$eval('.midi-debug__pedal', (nodes) =>
      nodes.map((n) => ({
        name: n.querySelector('.midi-debug__pedal-name')?.textContent,
        percent: n.querySelector('.midi-debug__pedal-percent')?.textContent,
        raw: n.querySelector('.midi-debug__pedal-raw')?.textContent,
        background: getComputedStyle(n.querySelector('.midi-debug__pedal-box')).backgroundColor,
        border: getComputedStyle(n.querySelector('.midi-debug__pedal-box')).borderTopColor,
        idle: n.querySelector('.midi-debug__pedal-box').classList.contains('is-idle'),
        level: n.querySelector('.midi-debug__pedal-box').classList.contains('is-level'),
      })),
    )
  const byPedal = (list, name) => list.find((p) => p.name === name)

  // 用户要求：踏板行不再有说明文本
  if ((await page.locator('.midi-debug__pedal-hint').count()) !== 0) {
    problems.push('踏板行下方的说明文本已按要求移除')
  }

  const beforePedal = await pedalState()
  console.log('未踩踏板:', JSON.stringify(beforePedal.map((p) => [p.name, p.percent, p.raw])))
  // 顺序 = 钢琴踏板实际位置（左→右）
  if (beforePedal.map((p) => p.name).join('/') !== '弱音/选择延音/延音') {
    problems.push(`踏板顺序应为 弱音/选择延音/延音，实际 ${beforePedal.map((p) => p.name)}`)
  }
  // 未踩时数值照显（0% / 0），且右上角不带 CC 号字样
  if (beforePedal.some((p) => p.percent !== '0%' || p.raw !== '0')) {
    problems.push('未踩时三格也应显示 0% / 0')
  }

  await page.screenshot({ path: '/tmp/midi-debug-keys.png', fullPage: true })

  await send([0xb0, 64, 127]) // 延音踩到底（开关式踏板的端点值）
  const down = await pedalState()
  const sustainDown = byPedal(down, '延音')
  console.log('延音踩下 127:', JSON.stringify(sustainDown))
  if (sustainDown?.percent !== '100%') problems.push('CC64=127 应显示 100%')
  if (sustainDown?.raw !== '127') problems.push(`右上角应只显示数值 127，实际 ${sustainDown?.raw}`)
  if (!/rgba?\([^)]*0\.4/.test(sustainDown?.background ?? '')) {
    problems.push(`踩到底应有较浓的绿色背景，实际 ${sustainDown?.background}`)
  }
  if (sustainDown?.level) problems.push('只见过端点值的踏板不应标记为幅度模式')
  if (byPedal(down, '弱音')?.level !== false) problems.push('未被踩的踏板不应标记为幅度模式')
  await page.screenshot({ path: '/tmp/midi-debug-pedal-switch.png', fullPage: true })

  // —— 4. 半踩（中间值）→ 标记为幅度模式并锁定，回到端点也不回退 ——
  await send([0xb0, 64, 40]) // CC64=40 < 64：未触发，但有幅度
  const half = await pedalState()
  const sustainHalf = byPedal(half, '延音')
  console.log('延音半踩 40:', JSON.stringify(sustainHalf))
  if (sustainHalf?.percent !== '31%')
    problems.push(`CC64=40 应显示 31%，实际 ${sustainHalf?.percent}`)
  if (!sustainHalf?.level) problems.push('出现过中间值的踏板应标记为幅度模式')
  if (!/rgba?\([^)]*,\s*0\)/.test(sustainHalf?.background ?? '')) {
    problems.push(`未触发（<64）时不应有绿色背景，实际 ${sustainHalf?.background}`)
  }

  await send([0xb0, 64, 0]) // 回到端点：幅度模式锁定，不回退
  const back = await pedalState()
  if (!byPedal(back, '延音')?.level) problems.push('幅度模式应锁定：回到 0 后不回退')
  if (byPedal(back, '延音')?.percent !== '0%') problems.push('回到 0 后应显示 0%')

  // —— 5. 三踏板独立：弱音 CC67 半踩，只有它新进入幅度模式 ——
  await send([0xb0, 67, 80])
  const all = await pedalState()
  console.log('三踏板:', JSON.stringify(all.map((p) => [p.name, p.percent, p.level, p.idle])))
  if (byPedal(all, '延音')?.level !== true) problems.push('延音应仍处于幅度模式')
  if (byPedal(all, '弱音')?.level !== true) problems.push('弱音出现过中间值后应为幅度模式')
  if (byPedal(all, '弱音')?.idle !== false) problems.push('收到过消息的踏板不应是 idle 压暗态')
  await page.screenshot({ path: '/tmp/midi-debug-pedal-level.png', fullPage: true })

  // —— 6. 抬起按键：chips 与键色复原 ——
  await send([0x80, 60, 0])
  await send([0x80, 64, 0])
  await send([0x80, 67, 0])
  const after = await page.evaluate(() => ({
    chips: document.querySelectorAll('.midi-debug__key').length,
    placeholder: document.querySelector('.midi-debug__note')?.textContent ?? null,
    pressedKeys: document.querySelectorAll('.piano__wkey.is-pressed').length,
    softBg: document.querySelector('.piano__wkey[data-pitch="60"]')?.style.background ?? '',
  }))
  console.log('全部抬起:', JSON.stringify(after))
  if (after.chips !== 0) problems.push('抬起后音名方块应清空')
  if (after.placeholder !== '—') problems.push('抬起后应回到 “—” 占位')
  if (after.pressedKeys !== 0) problems.push('抬起后不应有 is-pressed 键')
  if (after.softBg !== '') problems.push('抬起后键色内联样式应清除')

  // —— 7. 谱面不受力度影响（只表达音高）——
  await send([0x90, 60, 5])
  const head = await page.evaluate(() => {
    const el = document.querySelector('.midi-debug__shead')
    return el === null
      ? null
      : { opacity: getComputedStyle(el).opacity, fill: getComputedStyle(el).fill }
  })
  console.log('谱面符头（力度 5）:', JSON.stringify(head))
  if (head === null) problems.push('谱面应画出符头')
  else if (head.opacity !== '1') problems.push(`谱面符头不应随力度改透明度（实际 ${head.opacity}）`)
  await send([0x80, 60, 0])

  console.log('截图: /tmp/midi-debug-keys.png / -pedal-switch.png / -pedal-level.png')
} finally {
  await browser.close()
}

if (problems.length > 0) {
  console.error('\n发现问题：')
  for (const p of problems) console.error(` - ${p}`)
  process.exit(1)
}
console.log('\n全部通过')
