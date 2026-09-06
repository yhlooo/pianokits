import type { TransportState } from '../core/transport'
import { el, formatTime } from './dom'
import { pauseIcon, playIcon, sidebarIcon, stopIcon, volumeIcon } from './icons'
import type { View } from './store'
import type { ViewMode } from './state'

export interface TransportViewCallbacks {
  onPlay(): void
  onPause(): void
  onStop(): void
  onSeek(seconds: number): void
  onVolume(volume: number): void
  onViewMode(mode: ViewMode): void
  onExpandSidebar(): void
}

const RING_R = 15
const RING_C = 2 * Math.PI * RING_R

/** 底部播放坞：上沿通栏进度条 + 控制行（播放/暂停/停止、时间、音量、视图分段切换）；
 *  顶部只保留外壳栏，不放任何控制按钮 */
export class TransportView implements View {
  /** 播放坞根元素（由 app.ts 挂在内容区底部，侧栏右侧） */
  readonly el: HTMLElement
  private readonly expandBtn: HTMLButtonElement
  private readonly playBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly seekEl: HTMLInputElement
  private readonly timeEl: HTMLSpanElement
  private readonly volumeEl: HTMLInputElement
  private readonly modeBtns: Map<ViewMode, HTMLButtonElement>
  private readonly ring: SVGSVGElement
  private readonly ringCircle: SVGCircleElement
  private seeking = false
  private duration = 0

  constructor(cbs: TransportViewCallbacks) {
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

    this.modeBtns = new Map()
    const modeBar = el('div', { class: 'view-switch' })
    for (const mode of ['split', 'waterfall', 'score'] as ViewMode[]) {
      const label = mode === 'split' ? '分屏' : mode === 'waterfall' ? '瀑布流' : '五线谱'
      const btn = el('button', { class: 'view-switch__btn', dataset: { mode } }, label)
      btn.addEventListener('click', () => cbs.onViewMode(mode))
      this.modeBtns.set(mode, btn)
      modeBar.append(btn)
    }

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
        modeBar,
      ),
    )
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
    for (const [m, btn] of this.modeBtns) {
      btn.classList.toggle('is-active', m === mode)
    }
  }

  /** 同步侧栏折叠态：折叠时显示最左的展开按钮（其位置始终预留，不挤压其它控件） */
  setSidebarCollapsed(collapsed: boolean): void {
    this.expandBtn.classList.toggle('is-visible', collapsed)
  }
}
