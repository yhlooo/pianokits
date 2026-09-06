import { OscillatorEngine } from './core/engine/oscillator-engine'
import { SmplrEngine } from './core/engine/smplr-engine'
import { parseMidi } from './core/midi/parse'
import { quantizeToScore } from './core/midi/quantize'
import { PracticeController, practiceTracksOf } from './core/practice'
import { Transport } from './core/transport'
import { FileLibrary } from './storage/library'
import { el } from './ui/dom'
import { xIcon } from './ui/icons'
import { LibraryView } from './ui/library-view'
import type { ScoreView } from './ui/score-view'
import { Store } from './ui/store'
import type { AppState, ViewMode } from './ui/state'
import { nextViewMode } from './ui/state'
import { TransportView } from './ui/transport-view'
import { WaterfallView } from './ui/waterfall-view'

/** URL query 中保存“当前打开文件名”的键（刷新/切换工具后据此恢复选中文件） */
const FILE_QUERY_KEY = 'file'

function readFileQueryName(): string | null {
  return new URLSearchParams(window.location.search).get(FILE_QUERY_KEY)
}

/** 写入/清除 URL query 中的文件名（replaceState，不新增历史记录、保留工具路径与其它参数） */
function writeFileQueryName(name: string | null): void {
  const url = new URL(window.location.href)
  if (name === null) url.searchParams.delete(FILE_QUERY_KEY)
  else url.searchParams.set(FILE_QUERY_KEY, name)
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}

/** 组装 MIDI 播放器工具：存储/解析/播放/视图接线（设计文档 §3 总体架构）。返回卸载函数。 */
export async function createApp(host: HTMLElement): Promise<() => void> {
  const library = new FileLibrary()
  const audioCtx = new AudioContext()
  const oscillator = new OscillatorEngine(audioCtx)
  const smplr = new SmplrEngine(audioCtx)
  let disposed = false

  const transport = new Transport(oscillator, {
    now: () => audioCtx.currentTime,
    setInterval: (cb, ms) => window.setInterval(cb, ms),
    clearInterval: (id) => window.clearInterval(id),
  })

  const initialVolume = 0.8
  const initialView: ViewMode = 'split'
  const store = new Store<AppState>({
    files: [],
    currentFile: null,
    song: null,
    score: null,
    transport: 'empty',
    engine: 'oscillator',
    engineProgress: null,
    volume: initialVolume,
    view: initialView,
    notice: null,
  })
  transport.setVolume(initialVolume)

  // ---------- 视图 ----------
  const waterfall = new WaterfallView({ onSeek: (t) => transport.seek(t) })

  const stage = el('div', { class: 'stage stage--split' })
  stage.append(waterfall.el)

  // 五线谱视图懒加载（VexFlow 体积大，首次选文件时再加载）；
  // 挂载前先用轻量占位元素占据谱面区，避免分屏右侧一块空板
  const scorePlaceholder = el(
    'div',
    { class: 'score score--placeholder' },
    el('div', { class: 'score__empty' }, el('div', { class: 'score__empty-art' }, '𝄞')),
  )
  stage.append(scorePlaceholder)

  let scoreView: ScoreView | null = null
  let scoreViewPromise: Promise<ScoreView> | null = null
  function ensureScoreView(): Promise<ScoreView> {
    scoreViewPromise ??= import('./ui/score-view').then(({ ScoreView: SV }) => {
      scoreView = new SV()
      scorePlaceholder.replaceWith(scoreView.el)
      return scoreView
    })
    return scoreViewPromise
  }

  // ---------- 侧栏折叠 ----------
  // 主区域提前创建（子元素随后 append），供折叠回调引用；折叠后整栏隐藏、不留外露部分，
  // 展开按钮固定在播放坞最左并始终预留位置。
  const mainEl = el('main', { class: 'main' })
  const setSidebarCollapsed = (collapsed: boolean): void => {
    mainEl.classList.toggle('is-collapsed', collapsed)
    transportView.setSidebarCollapsed(collapsed)
  }

  const libraryView = new LibraryView({
    onImport: async (files) => {
      await importFiles(files)
    },
    onSelect: (id) => void selectFile(id),
    onRemove: async (id) => {
      await library.remove(id)
      await refreshFiles()
      if (store.get().currentFile?.id === id) {
        transport.stop()
        waterfall.clear()
        scoreView?.clear()
        practiceController.setTracks([])
        store.update({ currentFile: null, song: null, score: null })
        writeFileQueryName(null)
      }
    },
    onCollapse: () => setSidebarCollapsed(true),
  })

  const transportView = new TransportView({
    onPlay: () => {
      void audioCtx.resume().then(() => {
        transport.play()
      })
    },
    onPause: () => transport.pause(),
    onStop: () => transport.stop(),
    onSeek: (t) => transport.seek(t),
    onVolume: (v) => {
      transport.setVolume(v)
      store.update({ volume: v })
    },
    onViewToggle: (panel) => {
      const next = nextViewMode(store.get().view, panel)
      store.update({ view: next })
      applyViewMode(next)
    },
    onExpandSidebar: () => setSidebarCollapsed(false),
    onMidiToggle: () => practiceController.toggleMidi(),
    onPracticeToggle: () => practiceController.togglePractice(),
    onPracticeTrack: (index) => practiceController.toggleTrack(index),
  })

  // ---------- MIDI 键盘 + 练习模式 ----------
  // MIDI 连接失败报错通知：右下角浮动胶囊（5 秒自动消退 + 关闭按钮），
  // 位置与顶部居中的通用通知区分（设计文档 20260906-midi-keyboard-and-practice.md §4.1）
  const midiErrorText = el('span', { class: 'notice__text' })
  const midiErrorClose = el('button', { class: 'icon-btn notice__close', title: '关闭' })
  midiErrorClose.append(xIcon())
  const midiErrorEl = el(
    'div',
    { class: 'notice notice--bottom-right' },
    midiErrorText,
    midiErrorClose,
  )
  let midiErrorTimer: number | null = null
  const hideMidiError = (): void => {
    midiErrorEl.classList.remove('is-visible')
    if (midiErrorTimer !== null) {
      window.clearTimeout(midiErrorTimer)
      midiErrorTimer = null
    }
  }
  const showMidiError = (message: string): void => {
    midiErrorText.textContent = message
    midiErrorEl.classList.add('is-visible')
    if (midiErrorTimer !== null) window.clearTimeout(midiErrorTimer)
    midiErrorTimer = window.setTimeout(hideMidiError, 5000)
  }
  midiErrorClose.addEventListener('click', hideMidiError)

  // 编排控制器（core/practice.ts）：连接生命周期、实时演奏、分轨练习判定、播放镜像到键盘音源；
  // 状态经回调推到播放坞按钮与瀑布流键盘反馈（设计文档 20260906-midi-keyboard-and-practice.md §3.5）
  let practiceWasActive = false
  const practiceController = new PracticeController({
    transport,
    audioCtx,
    callbacks: {
      onStatus: (ui) => transportView.setMidiStatus(ui),
      onPractice: (ui) => {
        // 练习的视觉载体是瀑布流键盘：任一轨开启时自动切到瀑布流视图
        if (ui.active && !practiceWasActive && store.get().view !== 'waterfall') {
          store.update({ view: 'waterfall' })
          applyViewMode('waterfall')
        }
        practiceWasActive = ui.active
        // 分轨压暗：练习轨正常显示，非练习轨瀑布流暗淡（练习关闭时传 null 恢复）
        const gated = new Set(ui.tracks.filter((t) => t.on).map((t) => t.index))
        waterfall.setPracticeTracks(ui.active ? gated : null)
        transportView.setPractice(ui)
      },
      onFeedback: (fb) => waterfall.setKeyFeedback(fb),
      onConnectError: (message) => showMidiError(message),
    },
  })

  // 通知胶囊：文本 + 关闭按钮，6 秒自动消退
  const noticeText = el('span', { class: 'notice__text' })
  const noticeClose = el('button', { class: 'icon-btn notice__close', title: '关闭' })
  noticeClose.append(xIcon())
  const noticeEl = el('div', { class: 'notice' }, noticeText, noticeClose)
  let noticeTimer: number | null = null
  const hideNotice = (): void => {
    noticeEl.classList.remove('is-visible')
    if (noticeTimer !== null) {
      window.clearTimeout(noticeTimer)
      noticeTimer = null
    }
  }
  noticeClose.addEventListener('click', hideNotice)

  // 内容列：舞台在上，播放坞（进度条 + 控制行）钉在页面最底部（侧栏通高到底）
  const contentCol = el('div', { class: 'content' }, stage, transportView.el)
  mainEl.append(libraryView.el, contentCol)
  host.append(noticeEl, midiErrorEl, mainEl)

  function applyViewMode(mode: ViewMode): void {
    stage.classList.remove('stage--split', 'stage--waterfall', 'stage--score')
    stage.classList.add(`stage--${mode}`)
    transportView.setViewMode(mode)
  }

  // ---------- 状态同步 ----------
  transport.on('statechange', (s) => {
    store.update({ transport: s })
    transportView.setState(s)
  })

  store.subscribe(() => {
    const st = store.get()
    // 先同步选中 id、再渲染列表：setFiles 依赖 this.selectedId 决定 is-selected，
    // 顺序颠倒会导致黄色选中条滞后一次点击才跟上
    libraryView.setSelected(st.currentFile?.id ?? null)
    libraryView.setFiles(st.files)
    if (st.notice !== null) {
      noticeText.textContent = st.notice
      noticeEl.classList.add('is-visible')
      if (noticeTimer !== null) window.clearTimeout(noticeTimer)
      noticeTimer = window.setTimeout(hideNotice, 6000)
    } else {
      hideNotice()
    }
  })

  async function refreshFiles(): Promise<void> {
    const files = await library.list()
    store.update({ files })
  }

  async function importFiles(files: File[]): Promise<void> {
    try {
      await library.importFiles(files)
      await refreshFiles()
    } catch (err) {
      store.update({ notice: `导入失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  async function selectFile(id: string): Promise<void> {
    const item = store.get().files.find((f) => f.id === id)
    if (item === undefined) return
    try {
      const bytes = await library.read(id)
      const song = parseMidi(bytes)
      const score = quantizeToScore(song)
      transport.load(song)
      waterfall.setNotes(song.notes)
      practiceController.setTracks(practiceTracksOf(song))
      const sv = await ensureScoreView()
      sv.setScore(score)
      transportView.setDuration(song.duration)
      store.update({ currentFile: { id, name: item.name }, song, score, notice: null })
      writeFileQueryName(item.name)
    } catch (err) {
      store.update({ notice: `解析失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  // ---------- 采样引擎 ----------
  smplr
    .init({
      onProgress: (loaded, total) => {
        store.update({ engineProgress: { loaded, total } })
        transportView.setEngineProgress({ loaded, total })
      },
    })
    .then(() => {
      if (disposed) return
      store.update({ engine: 'smplr', engineProgress: null })
      transportView.setEngineProgress(null)
      transport.setEngine(smplr)
    })
    .catch((err: unknown) => {
      if (disposed) return
      console.warn('钢琴采样加载失败，使用振荡器兜底音色', err)
      store.update({ engine: 'oscillator', engineProgress: null })
      transportView.setEngineProgress(null)
    })

  // ---------- 渲染循环：视觉统一按 transport.position 拉取（不依赖音频回调） ----------
  const frame = (): void => {
    if (disposed) return
    const st = store.get()
    if (st.song !== null) {
      const pos = transport.position
      waterfall.setPosition(pos, transport.state === 'playing')
      scoreView?.setPosition(pos)
      transportView.setPosition(pos)
    }
    rafId = requestAnimationFrame(frame)
  }
  let rafId = requestAnimationFrame(frame)

  // ---------- 初始化 ----------
  applyViewMode(store.get().view)
  transportView.setVolume(store.get().volume)
  await refreshFiles()

  // 刷新后恢复上次打开的文件：从 URL query 读取文件名并在文件库中匹配
  const restoredName = readFileQueryName()
  if (restoredName !== null) {
    const item = store.get().files.find((f) => f.name === restoredName)
    if (item !== undefined) await selectFile(item.id)
  }

  // ---------- 卸载：工具切换时释放资源 ----------
  return () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(rafId)
    practiceController.dispose()
    transport.dispose()
    oscillator.dispose()
    smplr.dispose()
    waterfall.destroy()
    scoreView?.destroy()
    void audioCtx.close().catch(() => {})
  }
}
