import { writeMidi } from './core/midi/write'
import { RecorderController } from './core/recorder'
import type { RecordedNote } from './core/recorder-model'
import { FileLibrary } from './storage/library'
import { closeDialogs, confirmDialog, promptDialog } from './ui/dialog'
import { el, formatFileStamp } from './ui/dom'
import { xIcon } from './ui/icons'
import { RecorderView } from './ui/recorder-view'

/**
 * 上次会话的音轨（模块级）：切换工具会卸载本页，但模块仍驻留内存，
 * 因此"录到一半切去播放器看一眼再切回来"不会丢内容；刷新页面不保留（不做持久化）。
 */
let sessionTrack: { notes: readonly RecordedNote[]; position: number } | null = null

/**
 * 组装「录音」工具（设计文档 20260912-midi-recorder.md §3.5）：
 * 控制器（走带 + MIDI 连接 + 采集/回放）+ 视图（钢琴卷帘 + 控制按钮），
 * 外加两个文件动作：保存到「播放 / 练习」的文件库（IndexedDB）与导出 .mid 下载。
 * 返回卸载函数（停 rAF、关弹窗、释放 MIDI 连接并恢复键盘 Local Control）。
 */
export function createRecorderApp(host: HTMLElement): () => void {
  const library = new FileLibrary()
  let disposed = false
  let rafId = 0

  // 通知胶囊（保存/下载结果）：与播放器同一视觉，顶部居中、6 秒自动消退。
  // 成功用绿色左边条（默认红色只表示报错，成功提示不该长得像错误）
  const noticeText = el('span', { class: 'notice__text' })
  const noticeClose = el('button', { class: 'icon-btn notice__close', title: '关闭' })
  noticeClose.append(xIcon())
  // notice--recorder：下移到计时器行之下（否则顶部居中的胶囊会盖住计时器）
  const noticeEl = el('div', { class: 'notice notice--recorder' }, noticeText, noticeClose)
  let noticeTimer: number | null = null
  const hideNotice = (): void => {
    noticeEl.classList.remove('is-visible')
    if (noticeTimer !== null) {
      window.clearTimeout(noticeTimer)
      noticeTimer = null
    }
  }
  const showNotice = (message: string, kind: 'success' | 'error' = 'success'): void => {
    noticeText.textContent = message
    noticeEl.classList.toggle('notice--success', kind === 'success')
    noticeEl.classList.add('is-visible')
    if (noticeTimer !== null) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(hideNotice, 6000)
  }
  noticeClose.addEventListener('click', hideNotice)

  const view = new RecorderView({
    onPlayToggle: () => controller.togglePlay(),
    onRecordToggle: () => controller.toggleRecord(),
    onStop: () => void clearTrack(),
    onSave: () => void saveToLibrary(),
    onDownload: () => void downloadMidi(),
    onScrubStart: () => controller.beginScrub(),
    onScrub: (seconds) => controller.scrub(seconds),
    onScrubEnd: () => controller.endScrub(),
  })

  const controller = new RecorderController({
    callbacks: { onState: (state) => view.setState(state) },
  })
  // 切走再切回：恢复上次会话的音轨与线位置（刷新不保留）
  if (sessionTrack !== null) controller.restore(sessionTrack.notes, sessionTrack.position)

  /** 补 .mid 扩展名（用户输入可省略） */
  function withMidiExtension(name: string): string {
    return /\.midi?$/i.test(name) ? name : `${name}.mid`
  }

  function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  /** 结束：二次确认后清空音轨（文案为用户指定口径） */
  async function clearTrack(): Promise<void> {
    const confirmed = await confirmDialog({
      title: '结束录音',
      message: '该操作将清空音轨中记录的数据，是否继续',
      confirmText: '清空',
      danger: true,
    })
    if (disposed || !confirmed) return
    controller.clear()
  }

  /** 保存到「播放 / 练习」的文件库（与播放器共用 IndexedDB 文件库，切换到该工具即可看到） */
  async function saveToLibrary(): Promise<void> {
    const notes = controller.exportNotes()
    if (notes.length === 0) return
    const input = await promptDialog({
      title: '保存到播放器',
      label: '文件名',
      defaultValue: formatFileStamp(),
      confirmText: '保存',
    })
    if (disposed || input === null) return
    const name = withMidiExtension(input)
    try {
      await library.importFiles([new File([writeMidi(notes)], name, { type: 'audio/midi' })])
      showNotice(`已保存到播放器：${name}`)
    } catch (err) {
      showNotice(`保存失败：${errorText(err)}`, 'error')
    }
  }

  /** 导出当前音轨为 .mid 并触发浏览器下载 */
  async function downloadMidi(): Promise<void> {
    const notes = controller.exportNotes()
    if (notes.length === 0) return
    const input = await promptDialog({
      title: '下载 MIDI 文件',
      label: '文件名',
      defaultValue: `${formatFileStamp()}.mid`,
      confirmText: '下载',
    })
    if (disposed || input === null) return
    const name = withMidiExtension(input)
    try {
      const blob = new Blob([writeMidi(notes)], { type: 'audio/midi' })
      const url = URL.createObjectURL(blob)
      const link = el('a', { href: url, download: name })
      link.click()
      // 立即 revoke 可能打断下载：延后回收
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      showNotice(`已下载：${name}`)
    } catch (err) {
      showNotice(`下载失败：${errorText(err)}`, 'error')
    }
  }

  host.append(noticeEl, view.el)

  // 视觉每帧从走带读位置与当前可见音轨（覆盖录制中擦除是渐进的），录制中把未收尾音符画到录制线
  const frame = (): void => {
    if (disposed) return
    view.render(controller.position, controller.visibleNotes(), controller.pendingNotes())
    rafId = requestAnimationFrame(frame)
  }
  rafId = requestAnimationFrame(frame)

  // 进入页面即自动连接 MIDI 键盘（未连接时播放/录制禁用并提示）
  controller.autoConnect()

  return () => {
    if (disposed) return
    disposed = true
    // 记住本次音轨（含录制中未收尾的音符），切回本工具时恢复
    sessionTrack = { notes: controller.exportNotes(), position: controller.position }
    cancelAnimationFrame(rafId)
    hideNotice()
    closeDialogs()
    view.destroy()
    controller.dispose()
  }
}
