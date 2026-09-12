/**
 * 开发用冒烟：验证「录音」工具（/midi-recorder）——注入假 Web MIDI 键盘，
 * 走通录制/拖动/结束确认/下载/保存，并截图。
 * 用法：先 `pnpm dev`，再 `node scripts/probe-recorder.mjs`
 */
import { readFileSync } from 'node:fs'

import { chromium } from 'playwright'

const BASE_URL = process.env.PIANOKITS_URL ?? 'http://localhost:5173'
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp'

/** 解析 .mid 文件为音符数组（用项目依赖 @tonejs/midi 复核导出内容） */
async function readMidiNotes(path) {
  const mod = await import('@tonejs/midi')
  const Midi = mod.Midi ?? mod.default?.Midi ?? mod.default
  const midi = new Midi(readFileSync(path))
  return midi.tracks.flatMap((track) =>
    track.notes.map((n) => ({
      pitch: n.midi,
      start: n.time,
      end: n.time + n.duration,
      velocity: Math.round(n.velocity * 127),
    })),
  )
}

/** 注入假 Web MIDI：window.__fakeMidi.emit(bytes) 模拟键盘消息；withInput=false 模拟"已授权但无设备" */
const FAKE_MIDI = (withInput) => {
  const sent = []
  const stateCbs = new Set()
  const msgCbs = new Set()
  const input = {
    id: 'fake-in',
    name: 'Probe Keyboard',
    manufacturer: 'PianoKits',
    addEventListener(type, cb) {
      if (type === 'midimessage') msgCbs.add(cb)
    },
    removeEventListener(type, cb) {
      if (type === 'midimessage') msgCbs.delete(cb)
    },
  }
  const output = {
    id: 'fake-out',
    name: 'Probe Keyboard',
    manufacturer: 'PianoKits',
    send(data) {
      sent.push([...data])
    },
    clear() {},
  }
  const inputs = new Map(withInput ? [['fake-in', input]] : [])
  const outputs = new Map([['fake-out', output]])
  const access = {
    inputs,
    outputs,
    addEventListener(type, cb) {
      if (type === 'statechange') stateCbs.add(cb)
    },
    removeEventListener(type, cb) {
      stateCbs.delete(cb)
    },
  }
  navigator.requestMIDIAccess = () => Promise.resolve(access)
  window.__fakeMidi = {
    emit(bytes) {
      const data = Uint8Array.from(bytes)
      for (const cb of msgCbs) cb({ data })
    },
    sent,
    plugIn() {
      inputs.set('fake-in', input)
      for (const cb of stateCbs) cb()
    },
    unplug() {
      inputs.delete('fake-in')
      for (const cb of stateCbs) cb()
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析计时器文本 `mm:ss.ff` → 秒；格式不符返回 null */
function parseClock(text) {
  const m = /^(\d+):(\d\d)\.(\d\d)$/.exec(text ?? '')
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100
}

const browser = await chromium.launch()
const problems = []
const logs = []

function watch(page) {
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
  })
}

async function newPage(withInput) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.grantPermissions(['midi'])
  await context.addInitScript(FAKE_MIDI, withInput)
  const page = await context.newPage()
  watch(page)
  return { context, page }
}

try {
  // ---------- A. 已连接键盘：录制 → 拖动 → 下载 → 保存 → 结束 ----------
  const { context, page } = await newPage(true)
  await page.goto(`${BASE_URL}/midi-recorder`, { waitUntil: 'networkidle' })

  // 顶栏页签与 URI
  const tab = page.locator('.shell__tab[data-id="midi-recorder"]')
  await tab.waitFor({ timeout: 10000 })
  const tabText = await tab.textContent()
  const activeTab = await tab.evaluate((el) => el.classList.contains('is-active'))
  if (tabText?.trim() !== '录音') problems.push(`顶栏页签应为“录音”，实际“${tabText}”`)
  if (!activeTab) problems.push('录音页签应处于激活态')
  if (!page.url().endsWith('/midi-recorder'))
    problems.push(`URI 应为 /midi-recorder，实际 ${page.url()}`)

  const timer = page.locator('.recorder__timer')
  const status = page.locator('.recorder__status')
  const playBtn = page.locator('.recorder__btn').nth(0)
  const recordBtn = page.locator('.recorder__btn').nth(1)
  const stopBtn = page.locator('.recorder__btn').nth(2)
  const saveBtn = page.locator('.recorder__btn').nth(3)
  const downloadBtn = page.locator('.recorder__btn').nth(4)
  const canvas = page.locator('.recorder__canvas')

  const initial = {
    timer: await timer.textContent(),
    status: await status.textContent(),
    buttons: await page.locator('.recorder__btn').count(),
    playDisabled: await playBtn.isDisabled(),
    recordDisabled: await recordBtn.isDisabled(),
    stopDisabled: await stopBtn.isDisabled(),
    saveDisabled: await saveBtn.isDisabled(),
    downloadDisabled: await downloadBtn.isDisabled(),
  }
  logs.push(`初始状态: ${JSON.stringify(initial)}`)
  if (initial.buttons !== 5) problems.push(`控制行应有 5 个按钮，实际 ${initial.buttons}`)
  if (initial.timer !== '00:00.00') problems.push(`计时器初始应为 00:00.00，实际 ${initial.timer}`)
  if (initial.recordDisabled) problems.push('已连接键盘时录制按钮应可用')
  if (!initial.playDisabled) problems.push('空音轨时播放按钮应禁用')
  if (!initial.stopDisabled || !initial.saveDisabled || !initial.downloadDisabled) {
    problems.push('空音轨时结束/保存/下载应禁用')
  }
  if (!initial.status.includes('Probe Keyboard')) {
    problems.push(`状态行应显示已连接键盘名，实际“${initial.status}”`)
  }
  await page.screenshot({ path: `${SHOT_DIR}/recorder-1-empty.png` })

  // 录制一段：C4 长音、E4 短音、G4 和弦、力度差异
  await recordBtn.click()
  await sleep(500)
  await page.evaluate(() => window.__fakeMidi.emit([0x90, 60, 100])) // C4 强
  await sleep(700)
  await page.evaluate(() => window.__fakeMidi.emit([0x80, 60, 0]))
  await page.evaluate(() => window.__fakeMidi.emit([0x90, 64, 40])) // E4 弱
  await sleep(250)
  await page.evaluate(() => window.__fakeMidi.emit([0x80, 64, 0]))
  await page.evaluate(() => window.__fakeMidi.emit([0x90, 67, 127])) // G4 最强
  await page.evaluate(() => window.__fakeMidi.emit([0x90, 72, 90])) // C5 和弦
  await sleep(300)
  await page.evaluate(() => window.__fakeMidi.emit([0x80, 67, 0]))
  await sleep(200)
  await page.evaluate(() => window.__fakeMidi.emit([0x80, 72, 0]))
  await sleep(300)

  const during = {
    timer: await timer.textContent(),
    recordTitle: await recordBtn.getAttribute('title'),
    recordClass: await recordBtn.getAttribute('class'),
    playDisabled: await playBtn.isDisabled(),
    unplugProbe: null,
  }
  logs.push(`录制中: ${JSON.stringify(during)}`)
  if (!/^00:0[2-9]\.\d\d$/.test(during.timer ?? ''))
    problems.push(`录制中计时器约 2~9 秒且秒带两位小数（00:0X.XX），实际 ${during.timer}`)
  if (during.recordTitle !== '暂停录制') problems.push('录制中按钮应变为暂停')
  if (during.playDisabled) problems.push('已有内容时播放按钮应可用')
  await page.screenshot({ path: `${SHOT_DIR}/recorder-2-recording.png` })

  // 录制中拖动音轨：拖动期间位置不变，松手后从新位置继续
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('canvas 无尺寸')
  const cy = box.y + box.height / 2
  const beforeDrag = await timer.textContent()
  await page.mouse.move(box.x + box.width / 2, cy)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 160, cy, { steps: 12 })
  const duringDrag = await timer.textContent()
  await page.mouse.up()
  await sleep(120)
  logs.push(`拖动: 拖动前 ${beforeDrag}，拖动中 ${duringDrag}，松手后 ${await timer.textContent()}`)
  if (duringDrag === beforeDrag) problems.push('拖动音轨时线位置应随拖动改变')

  await recordBtn.click() // 暂停录制
  await sleep(100)
  if ((await recordBtn.getAttribute('title')) !== '录制') problems.push('暂停后录制按钮应恢复')
  const afterRecord = {
    stopDisabled: await stopBtn.isDisabled(),
    saveDisabled: await saveBtn.isDisabled(),
    downloadDisabled: await downloadBtn.isDisabled(),
  }
  logs.push(`录完暂停后: ${JSON.stringify(afterRecord)}`)
  if (afterRecord.stopDisabled || afterRecord.saveDisabled || afterRecord.downloadDisabled) {
    problems.push('音轨有内容时结束/保存/下载都应可用')
  }

  // 切到播放器再切回来：音轨内容与线位置保留（同页面会话）
  const timerBeforeSwitch = await timer.textContent()
  const playerTab = page.locator('.shell__tab[data-id="midi-player"]')
  await playerTab.click()
  await page.waitForTimeout(400)
  // 顶栏名称改为「播放 / 练习」，但工具 id 与 URI 保持 /midi-player
  const playerTabText = (await playerTab.textContent())?.trim()
  if (playerTabText !== '播放 / 练习') {
    problems.push(`顶栏播放器页签应为「播放 / 练习」，实际「${playerTabText}」`)
  }
  if (!page.url().endsWith('/midi-player')) {
    problems.push(`「播放 / 练习」的 URI 应保持 /midi-player，实际 ${page.url()}`)
  }
  logs.push(`顶栏页签「${playerTabText}」→ ${page.url()}`)
  await page.locator('.shell__tab[data-id="midi-recorder"]').click()
  await page.waitForTimeout(400)
  const afterSwitch = {
    timer: await timer.textContent(),
    stopDisabled: await stopBtn.isDisabled(),
    saveDisabled: await saveBtn.isDisabled(),
  }
  logs.push(`切走再切回: ${JSON.stringify(afterSwitch)}（切走前 ${timerBeforeSwitch}）`)
  if (afterSwitch.stopDisabled || afterSwitch.saveDisabled) {
    problems.push('切到其它工具再切回后音轨内容应保留')
  }
  if (afterSwitch.timer !== timerBeforeSwitch) {
    problems.push(`切回后线位置应保留（${timerBeforeSwitch} → ${afterSwitch.timer}）`)
  }
  await page.screenshot({ path: `${SHOT_DIR}/recorder-3-recorded.png` })

  // 回放：点播放后按钮变暂停、状态行不变、假输出收到 Note On/Off
  await playBtn.click()
  await sleep(500)
  const playing = {
    title: await playBtn.getAttribute('title'),
    active: await playBtn.evaluate((el) => el.classList.contains('is-active')),
  }
  const sentDuringPlay = await page.evaluate(() => window.__fakeMidi.sent.length)
  logs.push(`回放中: ${JSON.stringify(playing)}，假输出消息数 ${sentDuringPlay}`)
  if (playing.title !== '暂停播放') problems.push('回放中播放按钮应变为暂停')
  if (sentDuringPlay === 0) problems.push('回放应把音符发往 MIDI 输出（键盘音源）')
  await playBtn.click() // 暂停
  await sleep(100)

  // 下载：文件名弹窗默认值 + 真实下载
  await downloadBtn.click()
  const downloadDialog = page.locator('.dialog')
  await downloadDialog.waitFor()
  const downloadTitle = await downloadDialog.locator('.dialog__title').textContent()
  const downloadInput = downloadDialog.locator('.dialog__input')
  const defaultDownloadName = await downloadInput.inputValue()
  logs.push(`下载弹窗: ${downloadTitle} / 默认文件名 ${defaultDownloadName}`)
  if (!/^\d{8}-\d{6}\.mid$/.test(defaultDownloadName)) {
    problems.push(`下载默认文件名应为 yyyyMMdd-hhmmss.mid，实际 ${defaultDownloadName}`)
  }
  // 空文件名：弹窗内报错、不关闭、不下载
  await downloadInput.fill('')
  await downloadDialog.locator('.dialog__btn--primary').click()
  await page.waitForTimeout(120)
  const emptyNameError = await downloadDialog.locator('.dialog__error').textContent()
  if (emptyNameError !== '请输入文件名')
    problems.push(`空文件名应提示“请输入文件名”，实际“${emptyNameError}”`)
  if ((await downloadDialog.count()) !== 1) problems.push('校验失败时下载弹窗不应关闭')
  await downloadInput.fill(defaultDownloadName)

  const downloadPromise = page.waitForEvent('download')
  await downloadDialog.locator('.dialog__btn--primary').click()
  const download = await downloadPromise
  const downloadPath = `${SHOT_DIR}/recorder-download.mid`
  await download.saveAs(downloadPath)
  if (download.suggestedFilename() !== defaultDownloadName) {
    problems.push(`下载文件名应为 ${defaultDownloadName}，实际 ${download.suggestedFilename()}`)
  }
  const downloadNoticeClass = await page
    .locator('.notice')
    .evaluate((el) => el.classList.contains('notice--success'))
  logs.push(`已下载: ${download.suggestedFilename()}（success=${downloadNoticeClass}）`)
  if (!downloadNoticeClass) problems.push('下载成功提示应使用成功（绿色）样式')

  // 保存：默认文件名（无后缀）→ 写入 IndexedDB 文件库
  await saveBtn.click()
  await page.locator('.dialog').waitFor()
  const saveDialog = page.locator('.dialog')
  const defaultSaveName = await saveDialog.locator('.dialog__input').inputValue()
  logs.push(`保存弹窗默认文件名: ${defaultSaveName}`)
  if (!/^\d{8}-\d{6}$/.test(defaultSaveName)) {
    problems.push(`保存默认文件名应为 yyyyMMdd-hhmmss，实际 ${defaultSaveName}`)
  }
  await saveDialog.locator('.dialog__btn--primary').click()
  // 等保存真正落库（通知文案出现）再读 IndexedDB，避免与 importFiles 竞态
  await page.locator('.notice__text', { hasText: '已保存到播放器' }).waitFor({ timeout: 5000 })
  const noticeText = await page.locator('.notice__text').textContent()
  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pianokits', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('files'))
            db.createObjectStore('files', { keyPath: 'id' })
          if (!db.objectStoreNames.contains('settings'))
            db.createObjectStore('settings', { keyPath: 'key' })
        }
        req.onerror = () => resolve({ error: String(req.error) })
        req.onsuccess = () => {
          const db = req.result
          try {
            const all = db.transaction('files', 'readonly').objectStore('files').getAll()
            all.onsuccess = () =>
              resolve(
                all.result.map((r) => ({ name: r.name, size: r.size, bytes: r.bytes?.byteLength })),
              )
            all.onerror = () => resolve({ error: String(all.error) })
          } catch (err) {
            resolve({ error: err instanceof Error ? err.message : String(err) })
          }
        }
      }),
  )
  const noticeStyle = await page.locator('.notice').evaluate((el) => ({
    success: el.classList.contains('notice--success'),
    borderLeft: getComputedStyle(el).borderLeftColor,
  }))
  logs.push(
    `保存通知: ${noticeText}（success=${noticeStyle.success}，左边条 ${noticeStyle.borderLeft}）；文件库: ${JSON.stringify(stored)}`,
  )
  if (noticeText !== `已保存到播放器：${defaultSaveName}.mid`) {
    problems.push(`保存提示应简化为“已保存到播放器：xxx.mid”，实际“${noticeText}”`)
  }
  if (!noticeStyle.success) problems.push('保存/下载成功提示应加 notice--success（绿色左边条）')
  if (!/rgb\(127, 178, 133\)/.test(noticeStyle.borderLeft)) {
    problems.push(`成功提示左边条应为绿色 --success，实际 ${noticeStyle.borderLeft}`)
  }
  const saved = Array.isArray(stored)
    ? stored.find((r) => r.name === `${defaultSaveName}.mid`)
    : null
  if (saved === null || saved === undefined) {
    problems.push(`保存后文件库应包含 ${defaultSaveName}.mid，实际 ${JSON.stringify(stored)}`)
  } else if (!(saved.size > 0) || saved.bytes !== saved.size) {
    problems.push('保存的字节数应大于 0 且与记录一致')
  }
  await page.screenshot({ path: `${SHOT_DIR}/recorder-4-saved.png` })

  // 保存的文件应在「播放 / 练习」音乐库中出现
  const pagePlayer = await context.newPage()
  watch(pagePlayer)
  await pagePlayer.goto(`${BASE_URL}/midi-player`, { waitUntil: 'domcontentloaded' })
  const libName = pagePlayer.locator('.library__item-name', { hasText: defaultSaveName })
  await libName.waitFor({ timeout: 10000 })
  logs.push(`播放器音乐库出现: ${await libName.first().textContent()}`)
  await pagePlayer.close()

  // 覆盖录制：把线拖回 0，录 1.5 秒空白——录制线扫过的旧内容应被抹除，未扫到的部分保留后半段
  const beforeOverwrite = await readMidiNotes(downloadPath)
  logs.push(
    `覆盖录制前导出音符: ${JSON.stringify(beforeOverwrite.map((n) => [n.pitch, +n.start.toFixed(3), +n.end.toFixed(3)]))}`,
  )
  if (beforeOverwrite.length !== 4) {
    problems.push(`覆盖录制前应有 4 个音符，实际 ${beforeOverwrite.length}`)
  }
  await page.mouse.move(box.x + box.width / 2, cy)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 600, cy, { steps: 10 }) // 向右拖 = 回到更早（钳到 0）
  await page.mouse.up()
  await page.waitForTimeout(150)
  const posBeforeOverwrite = await timer.textContent()
  if (posBeforeOverwrite !== '00:00.00')
    problems.push(`覆盖录制前应把线拖回 00:00.00，实际 ${posBeforeOverwrite}`)

  await recordBtn.click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOT_DIR}/recorder-7-overwrite.png` }) // 录制线扫过、旧音符被吃掉一半
  await page.waitForTimeout(700)
  await recordBtn.click() // 暂停：这一次扫过到此为止
  await page.waitForTimeout(150)
  const sweepEndSec = parseClock(await timer.textContent())
  if (sweepEndSec === null) problems.push('无法解析暂停时的计时器文本')

  await downloadBtn.click()
  await page.locator('.dialog').waitFor()
  const overwriteDownload = page.waitForEvent('download')
  await page.locator('.dialog__btn--primary').click()
  const overwriteFile = await overwriteDownload
  const overwritePath = `${SHOT_DIR}/recorder-overwrite.mid`
  await overwriteFile.saveAs(overwritePath)
  const afterOverwrite = await readMidiNotes(overwritePath)
  logs.push(
    `覆盖录制后导出音符: ${JSON.stringify(afterOverwrite.map((n) => [n.pitch, +n.start.toFixed(3), +n.end.toFixed(3)]))}`,
  )
  if (afterOverwrite.length >= beforeOverwrite.length) {
    problems.push(
      `覆盖录制应抹掉被扫过的 ${beforeOverwrite.length} 个音符中的大部分，实际还剩 ${afterOverwrite.length}`,
    )
  }
  if (afterOverwrite.some((n) => n.pitch === 60)) {
    problems.push('完全被录制线扫过的 C4 音符应被抹除，导出里却还在')
  }
  // 容差 0.15s：暂停点击与音符收尾之间的抖动
  const sweep = sweepEndSec ?? 1.5
  for (const n of afterOverwrite) {
    if (n.start < sweep - 0.15) {
      problems.push(
        `被录制线扫过的位置不该还有音符（扫到 ${sweep.toFixed(2)}s）：${JSON.stringify(n)}`,
      )
    }
  }
  if (afterOverwrite.length > 0 && afterOverwrite.every((n) => n.start > sweep + 0.5)) {
    problems.push('未扫到的旧内容（录制线之后的后半段）应保留，实际全被抹掉了')
  }

  // 结束：二次确认（文案逐字核对）→ 清空 → 按钮全部禁用、计时器归零
  await stopBtn.click()
  const confirmDialog = page.locator('.dialog')
  await confirmDialog.waitFor()
  const confirmMessage = await confirmDialog.locator('.dialog__message').textContent()
  if (confirmMessage !== '该操作将清空音轨中记录的数据，是否继续') {
    problems.push(`确认文案不符：“${confirmMessage}”`)
  }
  await page.screenshot({ path: `${SHOT_DIR}/recorder-5-confirm.png` })
  // 取消：音轨保留；再次确认才清空
  await confirmDialog.locator('.dialog__btn').first().click()
  await page.waitForTimeout(150)
  if ((await confirmDialog.count()) !== 0) problems.push('取消后确认弹窗应关闭')
  if (await stopBtn.isDisabled()) problems.push('取消清空后音轨内容应保留')
  await stopBtn.click()
  await page.locator('.dialog').waitFor()
  await page.locator('.dialog__btn--danger').click()
  await sleep(150)
  const cleared = {
    timer: await timer.textContent(),
    stopDisabled: await stopBtn.isDisabled(),
    playDisabled: await playBtn.isDisabled(),
  }
  logs.push(`清空后: ${JSON.stringify(cleared)}`)
  if (cleared.timer !== '00:00.00') problems.push(`清空后计时器应归零，实际 ${cleared.timer}`)
  if (!cleared.stopDisabled || !cleared.playDisabled) problems.push('清空后结束/播放应禁用')

  // 键盘拔出 → 自动暂停 + 录制禁用
  await recordBtn.click() // 开始录制
  await sleep(200)
  await page.evaluate(() => window.__fakeMidi.emit([0x90, 62, 100]))
  await sleep(200)
  await page.evaluate(() => window.__fakeMidi.unplug())
  await sleep(150)
  const unplugged = {
    status: await status.textContent(),
    recordDisabled: await recordBtn.isDisabled(),
    recordTitle: await recordBtn.getAttribute('title'),
  }
  logs.push(`拔出键盘: ${JSON.stringify(unplugged)}`)
  if (!unplugged.recordDisabled) problems.push('拔出键盘后录制按钮应禁用')
  if (unplugged.status !== '')
    problems.push(`未连接时计时器右侧不应再提示，实际“${unplugged.status}”`)
  if ((await page.locator('.recorder__controls').isVisible()) !== true) {
    problems.push('控制行应始终可见')
  }
  await context.close()

  // ---------- B. 已授权但无设备：Tips 提示"请先连接 MIDI 键盘" ----------
  const ctxB = await await newPage(false)
  const pageB = ctxB.page
  await pageB.goto(`${BASE_URL}/midi-recorder`, { waitUntil: 'networkidle' })
  const recordB = pageB.locator('.recorder__btn').nth(1)
  const playB = pageB.locator('.recorder__btn').nth(0)
  await pageB.waitForTimeout(300)
  const noDevice = {
    status: await pageB.locator('.recorder__status').textContent(),
    recordDisabled: await recordB.isDisabled(),
    playDisabled: await playB.isDisabled(),
  }
  logs.push(`无设备: ${JSON.stringify(noDevice)}`)
  if (!noDevice.recordDisabled || !noDevice.playDisabled) {
    problems.push('无 MIDI 键盘时播放/录制都应禁用')
  }
  if (noDevice.status !== '') {
    problems.push(`无设备时计时器右侧不应再提示，实际“${noDevice.status}”`)
  }
  // 悬停禁用按钮 → Tips
  await pageB.locator('.recorder__btn-wrap').nth(1).hover()
  await pageB.waitForTimeout(250)
  const tip = {
    visible: await pageB
      .locator('.recorder__tip')
      .evaluate((el) => el.classList.contains('is-visible')),
    text: await pageB.locator('.recorder__tip').textContent(),
  }
  logs.push(`Tips: ${JSON.stringify(tip)}`)
  if (!tip.visible) problems.push('悬停禁用的录制按钮应显示 Tips')
  if (tip.text !== '请先连接 MIDI 键盘')
    problems.push(`Tips 文案应为“请先连接 MIDI 键盘”，实际“${tip.text}”`)
  await pageB.screenshot({ path: `${SHOT_DIR}/recorder-6-no-device.png` })

  // 点击禁用按钮（不是悬停）同样闪现 Tips
  await pageB.mouse.move(10, 10)
  await pageB.waitForTimeout(200)
  await pageB.locator('.recorder__btn-wrap').nth(1).click()
  await pageB.waitForTimeout(150)
  const tipClick = await pageB
    .locator('.recorder__tip')
    .evaluate((el) => el.classList.contains('is-visible'))
  if (!tipClick) problems.push('点击禁用的录制按钮应闪现 Tips')

  // 插入键盘 → 自动连上、按钮可用
  await pageB.evaluate(() => window.__fakeMidi.plugIn())
  await pageB.waitForTimeout(250)
  const plugged = {
    status: await pageB.locator('.recorder__status').textContent(),
    recordDisabled: await recordB.isDisabled(),
  }
  logs.push(`插入键盘: ${JSON.stringify(plugged)}`)
  if (plugged.recordDisabled) problems.push('插入键盘后录制按钮应可用')

  // 88 键音域：录最低音 A0 与最高音 C8，取样画布确认两端都画出了音符条
  await recordB.click()
  await pageB.waitForTimeout(200)
  await pageB.evaluate(() => window.__fakeMidi.emit([0x90, 21, 100])) // A0（MIDI 21）
  await pageB.waitForTimeout(350)
  await pageB.evaluate(() => window.__fakeMidi.emit([0x90, 108, 100])) // C8（MIDI 108）
  await pageB.waitForTimeout(350)
  await pageB.screenshot({ path: `${SHOT_DIR}/recorder-8-88keys.png` })
  const bands = await pageB.evaluate(() => {
    const canvas = document.querySelector('.recorder__canvas')
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width
    const h = canvas.height
    const gutter = Math.round(54 * dpr)
    const center = gutter + (w - gutter) / 2
    const data = ctx.getImageData(0, 0, w, h).data
    // 统计琥珀音符像素（排除录制线附近的中央列）：顶部 12% 应有 C8、底部 12% 应有 A0
    let top = 0
    let bottom = 0
    for (let y = 0; y < h; y++) {
      const inTop = y < h * 0.12
      const inBottom = y > h * 0.88
      if (!inTop && !inBottom) continue
      for (let x = gutter; x < w; x++) {
        if (Math.abs(x - center) < 20 * dpr) continue
        const i = (y * w + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const a = data[i + 3]
        if (a > 100 && r > 140 && g > 100 && b < 120 && r > b + 60) {
          if (inTop) top++
          else bottom++
        }
      }
    }
    return { top, bottom }
  })
  logs.push(`88 键取样（顶部 C8 / 底部 A0 的琥珀像素）: ${JSON.stringify(bands)}`)
  if (bands.top === 0) problems.push('最高音 C8 应在音轨最上一行画出（顶部无音符像素）')
  if (bands.bottom === 0) problems.push('最低音 A0 应在音轨最下一行画出（底部无音符像素）')
  await recordB.click() // 暂停录制
  await ctxB.context.close()
} catch (err) {
  problems.push(`脚本异常: ${err.stack ?? err.message}`)
} finally {
  await browser.close()
}

console.log(logs.join('\n'))
if (problems.length > 0) {
  console.error(`\n❌ 发现 ${problems.length} 个问题：`)
  for (const p of problems) console.error(` - ${p}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 录音工具冒烟全部通过')
}
