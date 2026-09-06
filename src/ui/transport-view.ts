import type { MidiUiState, PracticeUiState } from '../core/practice'
import type { TransportState } from '../core/transport'
import { el, formatTime } from './dom'
import {
  midiKeyboardIcon,
  pauseIcon,
  playIcon,
  practiceIcon,
  scoreIcon,
  sidebarIcon,
  spinnerIcon,
  stopIcon,
  volumeIcon,
  waterfallIcon,
} from './icons'
import type { View } from './store'
import type { ViewMode, ViewPanel } from './state'
import { trackColor } from './track-colors'

export interface TransportViewCallbacks {
  onPlay(): void
  onPause(): void
  onStop(): void
  onSeek(seconds: number): void
  onVolume(volume: number): void
  /** 点击“瀑布/乐谱”开关：切换对应面板（两个开关不能都关闭） */
  onViewToggle(panel: ViewPanel): void
  onExpandSidebar(): void
  /** 点击钢琴图标：连接 / 断开 MIDI 键盘 */
  onMidiToggle(): void
  /** 点击练习图标：非全开（含全关）→ 全部开启；全开 → 全部关闭 */
  onPracticeToggle(): void
  /** 点击悬浮菜单中的某轨：开关该轨练习（可多选） */
  onPracticeTrack(index: number): void
}

const RING_R = 15
const RING_C = 2 * Math.PI * RING_R

/** 底部播放坞：上沿通栏进度条 + 控制行（播放/暂停/停止、时间、音量、瀑布/乐谱视图开关、
 *  MIDI 连接、练习模式）；顶部只保留外壳栏，不放任何控制按钮 */
export class TransportView implements View {
  /** 播放坞根元素（由 app.ts 挂在内容区底部，侧栏右侧） */
  readonly el: HTMLElement
  private readonly cbs: TransportViewCallbacks
  private readonly expandBtn: HTMLButtonElement
  private readonly playBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly seekEl: HTMLInputElement
  private readonly timeEl: HTMLSpanElement
  private readonly volumeEl: HTMLInputElement
  private readonly waterfallBtn: HTMLButtonElement
  private readonly scoreBtn: HTMLButtonElement
  private readonly midiBtn: HTMLButtonElement
  private readonly practiceBtn: HTMLButtonElement
  private readonly practiceMenuList: HTMLDivElement
  private readonly practiceMenuEmpty: HTMLDivElement
  /** 轨号 → 菜单行（按曲目轨序插入；更新时原地同步，避免重建丢焦点） */
  private readonly practiceRows = new Map<
    number,
    { item: HTMLButtonElement; name: HTMLSpanElement }
  >()
  private readonly ring: SVGSVGElement
  private readonly ringCircle: SVGCircleElement
  private seeking = false
  private duration = 0
  /** 最近一次分轨练习 UI 状态（标题与菜单行同步用） */
  private practiceUi: PracticeUiState | null = null
  private midiConnected = false
  /** 触控设备（无 hover）：点击练习按钮改为展开/收起菜单，而非开关全部轨 */
  private readonly touchMode = window.matchMedia('(hover: none)').matches
  /** 练习按钮 + 菜单的包装器（触控下点击展开/收起菜单用） */
  private readonly practiceWrap: HTMLElement
  private closePracticeOnOutside: ((e: Event) => void) | null = null

  constructor(cbs: TransportViewCallbacks) {
    this.cbs = cbs
    // 侧栏展开按钮：固定在控制行最左、位置始终预留；展开态隐藏但保留占位，
    // 折叠后显示，避免出现时把播放/停止等按钮往右推。与侧栏内收起按钮共用同一侧栏图标。
    this.expandBtn = el('button', {
      class: 'icon-btn transport__sidebar-toggle',
      title: '展开侧栏',
    })
    this.expandBtn.append(sidebarIcon())
    this.expandBtn.addEventListener('click', () => cbs.onExpandSidebar())

    this.playBtn = el('button', { class: 'icon-btn transport__play', title: '播放/暂停' })
    this.playBtn.append(playIcon())
    this.playBtn.addEventListener('click', () => {
      if (this.playBtn.dataset.state === 'playing') cbs.onPause()
      else cbs.onPlay()
    })

    // 采样加载进度环（叠加在播放按钮外圈）
    this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.ring.setAttribute('class', 'transport__play-ring')
    this.ring.setAttribute('viewBox', '0 0 34 34')
    this.ring.style.display = 'none'
    this.ringCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    this.ringCircle.setAttribute('cx', '17')
    this.ringCircle.setAttribute('cy', '17')
    this.ringCircle.setAttribute('r', String(RING_R))
    this.ringCircle.setAttribute('stroke-dasharray', String(RING_C))
    this.ringCircle.setAttribute('stroke-dashoffset', String(RING_C))
    this.ring.append(this.ringCircle)
    this.playBtn.append(this.ring)

    this.stopBtn = el('button', { class: 'icon-btn transport__stop', title: '停止' })
    this.stopBtn.append(stopIcon())
    this.stopBtn.addEventListener('click', () => cbs.onStop())

    this.seekEl = el('input', {
      type: 'range',
      class: 'transport__seek',
      min: '0',
      max: '1',
      step: '0.001',
      value: '0',
    })
    this.seekEl.addEventListener('input', () => {
      this.seeking = true
      this.updateSeekFill()
      this.timeEl.textContent = `${formatTime(this.positionFromSlider())} / ${formatTime(this.duration)}`
    })
    this.seekEl.addEventListener('change', () => {
      this.seeking = false
      cbs.onSeek(this.positionFromSlider())
    })

    this.timeEl = el('span', { class: 'transport__time' }, '0:00 / 0:00')

    this.volumeEl = el('input', {
      type: 'range',
      class: 'transport__volume',
      min: '0',
      max: '100',
      value: '80',
      title: '音量',
    })
    this.volumeEl.addEventListener('input', () => {
      this.updateVolumeFill()
      cbs.onVolume(Number(this.volumeEl.value) / 100)
    })
    this.updateVolumeFill()

    const volumeLabel = el('span', { class: 'transport__volume-label', title: '音量' })
    volumeLabel.append(volumeIcon())

    // 视图开关：瀑布 / 乐谱两个图标开关（开启用亮度表示），并排放在 MIDI/练习图标旁；
    // 开启组合决定视图——瀑布+乐谱=分屏、仅瀑布=瀑布流、仅乐谱=五线谱，二者不能同时关闭
    this.waterfallBtn = el('button', {
      class: 'icon-btn transport__view',
      title: '瀑布流',
      'aria-pressed': 'false',
    })
    this.waterfallBtn.append(waterfallIcon())
    this.waterfallBtn.addEventListener('click', () => cbs.onViewToggle('waterfall'))

    this.scoreBtn = el('button', {
      class: 'icon-btn transport__view',
      title: '乐谱',
      'aria-pressed': 'false',
    })
    this.scoreBtn.append(scoreIcon())
    this.scoreBtn.addEventListener('click', () => cbs.onViewToggle('score'))

    // MIDI 键盘连接：右下角钢琴图标（连接/断开，状态经 setMidiStatus 同步）
    this.midiBtn = el('button', { class: 'icon-btn transport__midi', title: '连接 MIDI 键盘' })
    this.midiBtn.append(midiKeyboardIcon())
    this.midiBtn.addEventListener('click', () => cbs.onMidiToggle())

    // 练习模式：连接 MIDI 键盘后才可用，未连接置灰禁用；
    // 桌面端（有 hover）悬浮展开分轨练习菜单、点击开关全部轨；触控端无 hover，
    // 点击练习按钮改为展开菜单、再点收起（点击菜单行开关单轨，点外部空白收起）
    this.practiceBtn = el('button', {
      class: 'icon-btn transport__practice',
      title: '练习模式（需先连接 MIDI 键盘）',
    })
    this.practiceBtn.disabled = true
    this.practiceBtn.append(practiceIcon())
    this.practiceBtn.addEventListener('click', () => {
      if (this.touchMode) this.togglePracticeMenu()
      else cbs.onPracticeToggle()
    })

    this.practiceMenuList = el('div', { class: 'transport__practice-menu__list' })
    this.practiceMenuEmpty = el(
      'div',
      { class: 'transport__practice-menu__empty' },
      '载入曲目后，这里可以按轨开启练习',
    )
    const practiceMenu = el(
      'div',
      { class: 'transport__practice-menu', role: 'menu' },
      el('div', { class: 'transport__practice-menu__title' }, '分轨练习'),
      this.practiceMenuList,
      this.practiceMenuEmpty,
    )
    this.practiceWrap = el(
      'div',
      { class: 'transport__practice-wrap' },
      this.practiceBtn,
      practiceMenu,
    )

    // 播放坞：进度条贴坞上沿，控制行在下；整体钉在页面底部
    this.el = el(
      'div',
      { class: 'playerdock' },
      el('div', { class: 'seekbar' }, this.seekEl),
      el(
        'header',
        { class: 'transport' },
        this.expandBtn,
        this.playBtn,
        this.stopBtn,
        this.timeEl,
        el('div', { class: 'transport__spacer' }),
        volumeLabel,
        this.volumeEl,
        this.waterfallBtn,
        this.scoreBtn,
        this.midiBtn,
        this.practiceWrap,
      ),
    )
  }

  /** 触控端：点击练习按钮展开/收起菜单；展开时监听外部点击，点空白处收起 */
  private togglePracticeMenu(): void {
    if (this.practiceWrap.classList.contains('is-open')) {
      this.practiceWrap.classList.remove('is-open')
      if (this.closePracticeOnOutside !== null) {
        document.removeEventListener('pointerdown', this.closePracticeOnOutside)
        this.closePracticeOnOutside = null
      }
      return
    }
    this.practiceWrap.classList.add('is-open')
    this.closePracticeOnOutside = (e) => {
      if (!this.practiceWrap.contains(e.target as Node)) {
        this.practiceWrap.classList.remove('is-open')
      }
    }
    document.addEventListener('pointerdown', this.closePracticeOnOutside)
  }

  private positionFromSlider(): number {
    return Number(this.seekEl.value) * this.duration
  }

  private updateSeekFill(): void {
    this.seekEl.style.setProperty('--fill', `${Number(this.seekEl.value) * 100}%`)
  }

  private updateVolumeFill(): void {
    this.volumeEl.style.setProperty('--fill', `${this.volumeEl.value}%`)
  }

  setState(state: TransportState): void {
    this.playBtn.dataset.state = state
    this.playBtn.replaceChildren(state === 'playing' ? pauseIcon() : playIcon(), this.ring)
    this.playBtn.disabled = false
  }

  /** 采样加载进度：null 表示空闲/加载完成（隐藏进度环） */
  setEngineProgress(progress: { loaded: number; total: number } | null): void {
    if (progress === null || progress.total <= 0) {
      this.ring.style.display = 'none'
      return
    }
    this.ring.style.display = ''
    const frac = Math.max(0, Math.min(1, progress.loaded / progress.total))
    this.ringCircle.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)))
  }

  setDuration(duration: number): void {
    this.duration = duration
  }

  setPosition(position: number): void {
    if (this.seeking) return
    const frac = this.duration > 0 ? position / this.duration : 0
    this.seekEl.value = String(frac)
    this.updateSeekFill()
    this.timeEl.textContent = `${formatTime(position)} / ${formatTime(this.duration)}`
  }

  setVolume(volume: number): void {
    if (document.activeElement !== this.volumeEl) {
      this.volumeEl.value = String(Math.round(volume * 100))
      this.updateVolumeFill()
    }
  }

  setViewMode(mode: ViewMode): void {
    const waterfallOn = mode === 'split' || mode === 'waterfall'
    const scoreOn = mode === 'split' || mode === 'score'
    this.waterfallBtn.classList.toggle('is-on', waterfallOn)
    this.scoreBtn.classList.toggle('is-on', scoreOn)
    this.waterfallBtn.setAttribute('aria-pressed', String(waterfallOn))
    this.scoreBtn.setAttribute('aria-pressed', String(scoreOn))
  }

  /**
   * 同步 MIDI 按钮状态（设计文档 §4.1）：
   * - 未连接：暗色钢琴图标，tooltip “连接 MIDI 键盘”，点击尝试连接；
   * - 连接尝试中：旋转等待图标，tooltip “连接中（点击取消）”，点击取消；
   * - 已连接：琥珀高亮，tooltip 显示键盘名称（点击断开），点击断开；
   * - 失败态（超时/被拒/不支持等）：恢复暗色，tooltip 提示原因，点击重试。
   * 练习图标与菜单行仅在已连接时可用。
   */
  setMidiStatus(ui: MidiUiState): void {
    const { status, attempting, deviceLabel } = ui
    const connected = status === 'connected'
    const spinning = attempting && !connected
    this.midiConnected = connected
    this.midiBtn.classList.toggle('is-connected', connected)
    this.midiBtn.classList.toggle('is-connecting', spinning)
    this.midiBtn.disabled = status === 'unsupported'
    this.midiBtn.replaceChildren(spinning ? spinnerIcon() : midiKeyboardIcon())
    this.midiBtn.title = connected
      ? `已连接 ${deviceLabel ?? ''}（点击断开）`
      : spinning
        ? '连接中（点击取消）'
        : status === 'unsupported'
          ? '当前浏览器不支持 Web MIDI'
          : status === 'no-devices'
            ? '未检测到 MIDI 键盘（点击重连）'
            : status === 'denied'
              ? 'MIDI 授权被拒绝（点击重试）'
              : status === 'timeout'
                ? '连接超时（点击重试）'
                : status === 'error'
                  ? '连接失败（点击重试）'
                  : '连接 MIDI 键盘'
    this.practiceBtn.disabled = !connected
    for (const row of this.practiceRows.values()) {
      row.item.disabled = !connected
      row.item.title = connected ? '开关该轨练习' : '需先连接 MIDI 键盘'
    }
    this.refreshPracticeTitle()
  }

  /**
   * 同步分轨练习状态（设计文档 §4.1）：任一轨开启时按钮琥珀高亮；
   * 悬浮菜单行同步轨名 / 瀑布流颜色图例 / 开关圆点，未连接时行禁用但菜单仍可查看。
   */
  setPractice(ui: PracticeUiState): void {
    this.practiceUi = ui
    this.practiceBtn.classList.toggle('is-active', ui.active)
    const seen = new Set<number>()
    for (const t of ui.tracks) {
      seen.add(t.index)
      let row = this.practiceRows.get(t.index)
      if (row === undefined) {
        row = this.buildPracticeRow(t.index)
        this.practiceRows.set(t.index, row)
      }
      row.name.textContent = t.name
      row.item.classList.toggle('is-active', t.on)
      row.item.setAttribute('aria-checked', String(t.on))
    }
    for (const [index, row] of this.practiceRows) {
      if (!seen.has(index)) {
        row.item.remove()
        this.practiceRows.delete(index)
      }
    }
    this.practiceMenuEmpty.classList.toggle('is-visible', ui.tracks.length === 0)
    this.refreshPracticeTitle()
  }

  /** 同步侧栏折叠态：折叠时显示最左的展开按钮（其位置始终预留，不挤压其它控件） */
  setSidebarCollapsed(collapsed: boolean): void {
    this.expandBtn.classList.toggle('is-visible', collapsed)
  }

  /** 菜单行：瀑布流轨色渐变图例 + 轨名 + 开关圆点；点击开关该轨（多选，不收起菜单） */
  private buildPracticeRow(index: number): {
    item: HTMLButtonElement
    name: HTMLSpanElement
  } {
    const [top, bottom] = trackColor(index)
    const swatch = el('span', { class: 'transport__practice-item__swatch' })
    swatch.style.background = `linear-gradient(180deg, rgb(${top[0]},${top[1]},${top[2]}), rgb(${bottom[0]},${bottom[1]},${bottom[2]}))`
    const name = el('span', { class: 'transport__practice-item__name' })
    const dot = el('span', { class: 'transport__practice-item__dot' })
    const item = el(
      'button',
      {
        class: 'transport__practice-item',
        role: 'menuitemcheckbox',
        dataset: { track: String(index) },
      },
      swatch,
      name,
      dot,
    )
    item.disabled = !this.midiConnected
    item.title = this.midiConnected ? '开关该轨练习' : '需先连接 MIDI 键盘'
    item.addEventListener('click', () => this.cbs.onPracticeTrack(index))
    this.practiceMenuList.append(item)
    return { item, name }
  }

  private refreshPracticeTitle(): void {
    const ui = this.practiceUi
    if (!this.midiConnected) {
      this.practiceBtn.title = '练习模式（需先连接 MIDI 键盘）'
      return
    }
    this.practiceBtn.title = ui !== null && ui.allOn ? '关闭全部轨练习' : '开启全部轨练习'
  }
}
