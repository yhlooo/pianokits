import type { TransportState } from '../core/transport'
import { el, formatTime } from './dom'
import type { View } from './store'
import type { ViewMode } from './state'

export interface TransportViewCallbacks {
  onPlay(): void
  onPause(): void
  onStop(): void
  onSeek(seconds: number): void
  onVolume(volume: number): void
  onViewMode(mode: ViewMode): void
}

/** 顶部工具条：播放/暂停/停止、进度条、时间、音量、视图切换 */
export class TransportView implements View {
  readonly el: HTMLElement
  private readonly playBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly seekEl: HTMLInputElement
  private readonly timeEl: HTMLSpanElement
  private readonly volumeEl: HTMLInputElement
  private readonly modeBtns: Map<ViewMode, HTMLButtonElement>
  private seeking = false
  private duration = 0

  constructor(cbs: TransportViewCallbacks) {
    this.playBtn = el('button', { class: 'transport__play', title: '播放/暂停' }, '▶')
    this.playBtn.addEventListener('click', () => {
      if (this.playBtn.dataset.state === 'playing') cbs.onPause()
      else cbs.onPlay()
    })

    this.stopBtn = el('button', { class: 'transport__stop', title: '停止' }, '⏹')
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
      cbs.onVolume(Number(this.volumeEl.value) / 100)
    })

    this.modeBtns = new Map()
    const modeBar = el('div', { class: 'view-switch' })
    for (const mode of ['split', 'waterfall', 'score'] as ViewMode[]) {
      const label = mode === 'split' ? '分屏' : mode === 'waterfall' ? '瀑布流' : '五线谱'
      const btn = el('button', { class: 'view-switch__btn', dataset: { mode } }, label)
      btn.addEventListener('click', () => cbs.onViewMode(mode))
      this.modeBtns.set(mode, btn)
      modeBar.append(btn)
    }

    this.el = el(
      'header',
      { class: 'transport' },
      el('span', { class: 'transport__brand' }, 'PianoKits'),
      this.playBtn,
      this.stopBtn,
      this.timeEl,
      this.seekEl,
      el('span', { class: 'transport__volume-label', title: '音量' }, '🔊'),
      this.volumeEl,
      modeBar,
    )
  }

  private positionFromSlider(): number {
    return Number(this.seekEl.value) * this.duration
  }

  setState(state: TransportState): void {
    this.playBtn.dataset.state = state
    this.playBtn.textContent = state === 'playing' ? '⏸' : '▶'
    this.playBtn.disabled = false
  }

  setDuration(duration: number): void {
    this.duration = duration
  }

  setPosition(position: number): void {
    if (this.seeking) return
    const frac = this.duration > 0 ? position / this.duration : 0
    this.seekEl.value = String(frac)
    this.timeEl.textContent = `${formatTime(position)} / ${formatTime(this.duration)}`
  }

  setVolume(volume: number): void {
    if (document.activeElement !== this.volumeEl) {
      this.volumeEl.value = String(Math.round(volume * 100))
    }
  }

  setViewMode(mode: ViewMode): void {
    for (const [m, btn] of this.modeBtns) {
      btn.classList.toggle('is-active', m === mode)
    }
  }
}
