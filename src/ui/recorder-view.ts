import type { MidiConnectionStatus } from '../core/midi/connection'
import { midiNoteName } from '../core/midi/note-name'
import type { RecorderMode, RecorderUiState } from '../core/recorder'
import type { RecordedNote } from '../core/recorder-model'
import { el, formatClock } from './dom'
import { downloadIcon, pauseIcon, playIcon, recordIcon, saveIcon, stopIcon } from './icons'

/**
 * MIDI 录音工具视图（设计文档 20260912-midi-recorder.md §4）：
 * - 钢琴卷帘音轨：中央为录制/播放线，音符条随走带向左移动；一格一个半音，
 *   条长 = 时值、颜色深浅 = 力度、纵向位置 = 音高；左缘标音名、每行一条浅横线；
 *   音域为钢琴全键盘 88 键（A0~C8），键外的音符不显示；
 * - 音轨上方居中计时器（00:00，超过 60 分钟继续累加：99:23、102:23）；
 * - 音轨下方居中 5 个按钮：播放/暂停、录制/暂停、结束（清空）、保存、下载；
 * - 左右拖动音轨移动录制/播放线（拖动期间挂起录制/播放，由控制器负责）；
 * - 未连接 MIDI 键盘时播放/录制禁用，悬停或点击弹 Tips「请先连接 MIDI 键盘」；
 * - 音轨内不画任何说明文字（提示只出现在按钮 Tips 与控件上，画面留给音符）。
 */

/** 音轨显示音域：钢琴全键盘 88 键 A0(21)~C8(108)；键盘外的音符（0~20、109~127）不显示 */
const PITCH_LOW = 21
const PITCH_HIGH = 108
const ROW_COUNT = PITCH_HIGH - PITCH_LOW + 1
/** 左侧音名列宽度（px） */
const GUTTER = 54
/** 横向时间比例（px/秒）：视窗内约 18 秒 */
const PX_PER_SEC = 64
/** 行高小于此值时只标注白键音名（88 键时行高约 8px，每行都标会重叠） */
const LABEL_ALL_ROW_H = 12
/** 音名字号范围（px）：随行高缩放，保证密排时不重叠 */
const LABEL_FONT_MIN = 7
const LABEL_FONT_MAX = 11
/** 黑键音级（用于行底色与音名标注层级） */
const BLACK_PCS = new Set([1, 3, 6, 8, 10])
/** 画布文字字体（与全局 UI 字体一致） */
const CANVAS_FONT = 'system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

const LINE_WEAK = 'rgba(255, 255, 255, 0.055)'
const LINE_OCTAVE = 'rgba(255, 255, 255, 0.13)'
const ROW_BLACK = 'rgba(0, 0, 0, 0.24)'
const GRID_SEC = 'rgba(255, 255, 255, 0.032)'
const GRID_5SEC = 'rgba(255, 255, 255, 0.075)'
/** 音符条：琥珀（力度 → 深浅），底部更深一档模拟纸面阴影 */
const NOTE_TOP = [230, 186, 118] as const
const NOTE_BOTTOM = [168, 119, 46] as const
/** 录制线红、播放线琥珀（与全局语义色一致） */
const RECORD_RGB = '224, 105, 94'
const PLAY_RGB = '217, 164, 91'

const EMPTY_NOTES: readonly RecordedNote[] = []

export interface RecorderViewCallbacks {
  /** 播放/暂停切换 */
  onPlayToggle(): void
  /** 录制/暂停切换 */
  onRecordToggle(): void
  /** 结束（清空音轨）；二次确认由调用方负责 */
  onStop(): void
  /** 保存到「播放 / 练习」的文件库 */
  onSave(): void
  /** 导出 .mid 下载 */
  onDownload(): void
  /** 开始拖动音轨（挂起录制/播放） */
  onScrubStart(): void
  /** 拖动中：新的录制/播放线位置（秒） */
  onScrub(seconds: number): void
  /** 拖动结束（从新位置继续录制/播放） */
  onScrubEnd(): void
}

/** 未连接 MIDI 键盘时的提示文案（Tips 与状态行共用，按连接状态细分原因） */
export function midiHintText(status: MidiConnectionStatus): string {
  switch (status) {
    case 'connected':
      return ''
    case 'unsupported':
      return '当前浏览器不支持 Web MIDI'
    case 'denied':
      return 'MIDI 授权被拒绝，请在浏览器站点设置中允许后重试'
    case 'error':
      return 'MIDI 连接失败，请重试'
    default:
      return '请先连接 MIDI 键盘'
  }
}

function rgba(rgb: readonly [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** 圆角矩形路径 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export class RecorderView {
  readonly el: HTMLElement
  private readonly cbs: RecorderViewCallbacks
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly stage: HTMLElement
  private readonly timerEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly tipEl: HTMLElement
  private readonly playBtn: HTMLButtonElement
  private readonly recordBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly saveBtn: HTMLButtonElement
  private readonly downloadBtn: HTMLButtonElement
  private readonly playWrap: HTMLElement
  private readonly recordWrap: HTMLElement
  private readonly resizeObserver: ResizeObserver

  private width = 0
  private height = 0
  private bgGradient: CanvasGradient | null = null
  /** 已收尾的音符（控制器同步） */
  private notes: readonly RecordedNote[] = EMPTY_NOTES
  /** 录制中尚未收尾的音符（每帧传入） */
  private pending: readonly RecordedNote[] = EMPTY_NOTES
  private position = 0
  private mode: RecorderMode = 'idle'
  private state: RecorderUiState | null = null
  /** 需要重绘（尺寸/数据/状态变化）；位置变化每帧比较 */
  private dirty = true
  private lastTimerText = ''
  /** 拖动音轨状态；moved 为真才通知控制器挂起/恢复 */
  private drag: { pointerId: number; startX: number; startPos: number; moved: boolean } | null =
    null
  private tipTimer: number | null = null

  constructor(cbs: RecorderViewCallbacks) {
    this.cbs = cbs

    this.canvas = el('canvas', { class: 'recorder__canvas' })
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx

    this.timerEl = el('div', { class: 'recorder__timer' }, '00:00')
    this.statusEl = el('div', { class: 'recorder__status' }, '正在连接 MIDI 键盘…')
    this.tipEl = el('div', { class: 'recorder__tip', role: 'status' })
    this.stage = el('div', { class: 'recorder__stage' }, this.canvas, this.tipEl)

    // 5 个控制按钮：播放/暂停、录制/暂停、结束（清空）、保存、下载
    this.playBtn = this.buildButton('播放', playIcon(), () => cbs.onPlayToggle())
    this.recordBtn = this.buildButton('录制', recordIcon(), () => cbs.onRecordToggle())
    this.stopBtn = this.buildButton('结束（清空音轨）', stopIcon(), () => cbs.onStop())
    this.saveBtn = this.buildButton('保存到播放器', saveIcon(), () => cbs.onSave())
    this.downloadBtn = this.buildButton('下载 MIDI 文件', downloadIcon(), () => cbs.onDownload())
    this.recordBtn.classList.add('recorder__btn--record')

    // 未连接 MIDI 键盘时按钮禁用（disabled 元素不派发鼠标事件），
    // 因此在包装器上做 Tips：悬停显示、点击（含点击禁用按钮）闪现
    this.playWrap = this.buildTipTarget(this.playBtn, 'play')
    this.recordWrap = this.buildTipTarget(this.recordBtn, 'record')

    this.el = el(
      'div',
      { class: 'recorder' },
      el('header', { class: 'recorder__head' }, this.timerEl, this.statusEl),
      this.stage,
      el(
        'footer',
        { class: 'recorder__controls' },
        this.playWrap,
        this.recordWrap,
        this.stopBtn,
        this.saveBtn,
        this.downloadBtn,
      ),
    )

    this.resizeObserver = new ResizeObserver(() => {
      this.resize()
      this.dirty = true
    })
    this.resizeObserver.observe(this.stage)
    this.resize()

    this.attachDrag()
  }

  /** 同步离散状态（模式/是否有内容/MIDI 连接）：更新按钮图标、禁用态与状态行 */
  setState(state: RecorderUiState): void {
    this.state = state
    this.mode = state.mode

    this.playBtn.replaceChildren(state.mode === 'playing' ? pauseIcon() : playIcon())
    this.playBtn.title = state.mode === 'playing' ? '暂停播放' : '播放'
    this.playBtn.classList.toggle('is-active', state.mode === 'playing')

    this.recordBtn.replaceChildren(state.mode === 'recording' ? pauseIcon() : recordIcon())
    this.recordBtn.title = state.mode === 'recording' ? '暂停录制' : '录制'
    this.recordBtn.classList.toggle('is-recording', state.mode === 'recording')

    // 播放/录制需连接 MIDI 键盘；音轨为空时播放无内容可放
    this.playBtn.disabled = !state.midiConnected || !state.hasNotes
    this.recordBtn.disabled = !state.midiConnected
    // 结束/保存/下载：音轨中有内容才可用
    this.stopBtn.disabled = !state.hasNotes
    this.saveBtn.disabled = !state.hasNotes
    this.downloadBtn.disabled = !state.hasNotes
    this.playWrap.classList.toggle('is-blocked', this.playBtn.disabled)
    this.recordWrap.classList.toggle('is-blocked', this.recordBtn.disabled)

    // 状态行只报"已连接哪台键盘"；未连接不在这里重复提示（提示统一由按钮 Tips 承担）
    this.statusEl.textContent = state.midiConnected
      ? state.midiLabels.length > 0
        ? `已连接：${state.midiLabels.join('、')}`
        : `已连接 MIDI 键盘`
      : ''
    this.statusEl.classList.toggle('is-connected', state.midiConnected)
    this.statusEl.title = state.midiConnected ? '播放与录制将经 MIDI 键盘发声' : ''

    // 状态变化可能让正在显示的 Tips 过期（最典型：刚连上键盘时还挂着"请先连接 MIDI 键盘"），收起
    if (state.midiConnected) this.hideTip()

    this.dirty = true
  }

  /**
   * 每帧渲染（位置与音轨都是连续量，必须每帧取）：
   * - `position`：录制/播放线所在秒数；
   * - `notes`：当前可见音轨——覆盖录制中，录制线扫过的旧内容已被抹除，每帧都不同；
   * - `pending`：录制中尚未收尾的音符（end = 当前线位置，条形看上去从线向左生长）。
   */
  render(position: number, notes: readonly RecordedNote[], pending: readonly RecordedNote[]): void {
    const changed =
      this.dirty || position !== this.position || notes !== this.notes || pending !== this.pending
    this.position = position
    this.notes = notes
    this.pending = pending
    const timerText = formatClock(position)
    if (timerText !== this.lastTimerText) {
      this.lastTimerText = timerText
      this.timerEl.textContent = timerText
    }
    if (!changed) return
    this.dirty = false
    this.draw()
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    if (this.tipTimer !== null) window.clearTimeout(this.tipTimer)
  }

  // ---------- DOM 组装 ----------

  private buildButton(title: string, icon: SVGSVGElement, action: () => void): HTMLButtonElement {
    const btn = el('button', { class: 'recorder__btn', type: 'button', title, 'aria-label': title })
    btn.append(icon)
    btn.addEventListener('click', action)
    return btn
  }

  private buildTipTarget(btn: HTMLButtonElement, which: 'play' | 'record'): HTMLElement {
    const wrap = el('span', { class: 'recorder__btn-wrap' }, btn)
    wrap.addEventListener('pointerenter', () => this.showTip(which))
    wrap.addEventListener('pointerleave', () => this.hideTip())
    wrap.addEventListener('click', () => {
      if (btn.disabled) this.showTip(which, true)
    })
    return wrap
  }

  /** 显示 Tips；autoHide 为真时 2.5 秒后自动收起（点击禁用按钮的反馈） */
  private showTip(which: 'play' | 'record', autoHide = false): void {
    const message = this.tipMessage(which)
    if (message === '') return
    this.tipEl.textContent = message
    this.tipEl.classList.add('is-visible')
    if (this.tipTimer !== null) window.clearTimeout(this.tipTimer)
    this.tipTimer = autoHide ? window.setTimeout(() => this.hideTip(), 2500) : null
  }

  private hideTip(): void {
    this.tipEl.classList.remove('is-visible')
    if (this.tipTimer !== null) {
      window.clearTimeout(this.tipTimer)
      this.tipTimer = null
    }
  }

  private tipMessage(which: 'play' | 'record'): string {
    const state = this.state
    if (state === null) return ''
    if (!state.midiConnected) return midiHintText(state.midiStatus)
    if (which === 'play' && !state.hasNotes) return '音轨为空，先录制一些内容吧'
    return ''
  }

  // ---------- 拖动音轨 ----------

  private attachDrag(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId)
      this.drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startPos: this.position,
        moved: false,
      }
    })
    this.canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag
      if (drag === null || e.pointerId !== drag.pointerId) return
      const dx = e.clientX - drag.startX
      if (!drag.moved) {
        if (Math.abs(dx) < 3) return
        drag.moved = true
        this.canvas.classList.add('is-dragging')
        this.cbs.onScrubStart()
      }
      // 内容跟手：指针右移 = 音轨右移 = 时间轴位置左移
      this.cbs.onScrub(Math.max(0, drag.startPos - dx / PX_PER_SEC))
    })
    const endDrag = (e: PointerEvent): void => {
      const drag = this.drag
      if (drag === null || e.pointerId !== drag.pointerId) return
      this.drag = null
      this.canvas.classList.remove('is-dragging')
      if (drag.moved) this.cbs.onScrubEnd()
    }
    this.canvas.addEventListener('pointerup', endDrag)
    this.canvas.addEventListener('pointercancel', endDrag)
  }

  // ---------- 绘制 ----------

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = this.stage.clientWidth
    const h = this.stage.clientHeight
    if (w === 0 || h === 0) return
    this.width = w
    this.height = h
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // 背景微渐变缓存：自上而下 #141312 → #191816
    const g = this.ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#141312')
    g.addColorStop(1, '#191816')
    this.bgGradient = g
  }

  /** 音轨区（不含左侧音名列）水平中心：录制/播放线所在 x */
  private centerX(): number {
    return GUTTER + (this.width - GUTTER) / 2
  }

  private rowHeight(): number {
    return this.height / ROW_COUNT
  }

  private draw(): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    if (w === 0 || h === 0) return
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = this.bgGradient ?? '#141312'
    ctx.fillRect(0, 0, w, h)

    this.drawRows(w, h)
    this.drawTimeGrid(w, h)
    const centerX = this.centerX()
    for (const n of this.notes) this.drawNote(n, centerX, false)
    for (const n of this.pending) this.drawNote(n, centerX, true)
    this.drawPlayhead(centerX, h)
    this.drawGutter(h)
  }

  /** 每行一条浅横线（八度分界更亮）+ 黑键行底色 */
  private drawRows(w: number, h: number): void {
    const ctx = this.ctx
    const rowH = this.rowHeight()
    ctx.fillStyle = ROW_BLACK
    for (let i = 0; i < ROW_COUNT; i++) {
      const pc = (PITCH_LOW + i) % 12
      if (!BLACK_PCS.has(pc)) continue
      ctx.fillRect(GUTTER, h - (i + 1) * rowH, w - GUTTER, rowH)
    }
    ctx.lineWidth = 1
    for (let i = 1; i < ROW_COUNT; i++) {
      const pitch = PITCH_LOW + i
      const y = Math.round(h - i * rowH) + 0.5
      ctx.strokeStyle = pitch % 12 === 0 ? LINE_OCTAVE : LINE_WEAK
      ctx.beginPath()
      ctx.moveTo(GUTTER, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
  }

  /** 每秒一条淡竖线（5 秒整数倍略亮），随时间轴一起移动 */
  private drawTimeGrid(w: number, h: number): void {
    const ctx = this.ctx
    const centerX = this.centerX()
    const firstSec = Math.max(0, Math.floor(this.position - centerX / PX_PER_SEC))
    const lastSec = Math.ceil(this.position + (w - centerX) / PX_PER_SEC)
    ctx.lineWidth = 1
    for (let s = firstSec; s <= lastSec; s++) {
      const x = Math.round(centerX + (s - this.position) * PX_PER_SEC) + 0.5
      if (x <= GUTTER || x >= w) continue
      ctx.strokeStyle = s % 5 === 0 ? GRID_5SEC : GRID_SEC
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
  }

  /** 音符条：高度 = 音高（一行一个半音）、长度 = 时值、颜色深浅 = 力度 */
  private drawNote(n: RecordedNote, centerX: number, pending: boolean): void {
    const idx = n.pitch - PITCH_LOW
    if (idx < 0 || idx >= ROW_COUNT) return // 音域外：不显示（音域见文件头注释）
    const ctx = this.ctx
    const rowH = this.rowHeight()
    const barH = Math.max(2, rowH - 2)
    const y = this.height - (idx + 1) * rowH + (rowH - barH) / 2
    const x1 = centerX + (n.start - this.position) * PX_PER_SEC
    const x2 = centerX + (n.end - this.position) * PX_PER_SEC
    if (x2 <= GUTTER || x1 >= this.width) return
    const left = Math.max(GUTTER, x1)
    let right = Math.min(this.width, x2)
    if (right - left < 2) {
      // 极短音符：至少画出 2px（音符起点仍在视窗内时）
      if (x1 < GUTTER) return
      right = Math.min(this.width, left + 2)
    }
    const velocityT = Math.max(0, Math.min(1, (n.velocity - 1) / 126))
    const alpha = 0.3 + 0.7 * velocityT
    const gradient = ctx.createLinearGradient(0, y, 0, y + barH)
    gradient.addColorStop(0, rgba(NOTE_TOP, alpha))
    gradient.addColorStop(1, rgba(NOTE_BOTTOM, alpha * 0.9))
    ctx.fillStyle = gradient
    roundRect(ctx, left, y, right - left, barH, Math.min(3, barH / 2))
    ctx.fill()
    // 描边：录制中尚未收尾（亮白）或当前正在发声（淡白）
    const sounding =
      !pending && this.mode !== 'idle' && n.start <= this.position && n.end > this.position
    if (pending || sounding) {
      ctx.strokeStyle = pending ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 255, 255, 0.42)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  /** 录制/播放线：中央竖线，录制中为红色并带淡光带 */
  private drawPlayhead(centerX: number, h: number): void {
    const ctx = this.ctx
    const rgb = this.mode === 'recording' ? RECORD_RGB : PLAY_RGB
    if (this.mode !== 'idle') {
      ctx.fillStyle = `rgba(${rgb}, 0.10)`
      ctx.fillRect(centerX - 4, 0, 8, h)
    }
    ctx.fillStyle = `rgba(${rgb}, 0.95)`
    ctx.fillRect(Math.round(centerX) - 1, 0, 2, h)
    ctx.beginPath()
    ctx.moveTo(centerX - 5, 0)
    ctx.lineTo(centerX + 5, 0)
    ctx.lineTo(centerX, 7)
    ctx.closePath()
    ctx.fill()
  }

  /**
   * 左侧音名列：白键音名常显，行高足够时连黑键一起标。
   * 88 键时行高约 8px，字号随行高缩放（LABEL_FONT_MIN~MAX）以免上下行重叠。
   */
  private drawGutter(h: number): void {
    const ctx = this.ctx
    const rowH = this.rowHeight()
    const labelAll = rowH >= LABEL_ALL_ROW_H
    const fontSize = Math.max(LABEL_FONT_MIN, Math.min(LABEL_FONT_MAX, rowH * 0.85))
    ctx.fillStyle = 'rgba(20, 19, 18, 0.94)'
    ctx.fillRect(0, 0, GUTTER, h)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.font = `${fontSize.toFixed(1)}px ${CANVAS_FONT}`
    for (let i = 0; i < ROW_COUNT; i++) {
      const pitch = PITCH_LOW + i
      const natural = !BLACK_PCS.has(pitch % 12)
      if (!labelAll && !natural) continue
      ctx.fillStyle = natural ? 'rgba(184, 181, 174, 0.85)' : 'rgba(128, 125, 118, 0.7)'
      ctx.fillText(midiNoteName(pitch), GUTTER - 8, h - (i + 0.5) * rowH)
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(GUTTER + 0.5, 0)
    ctx.lineTo(GUTTER + 0.5, h)
    ctx.stroke()
  }
}
