import type { Note } from '../core/model'
import { el } from './dom'
import type { View } from './store'

const MIN_PITCH = 21 // A0
const MAX_PITCH = 108 // C8
const PITCH_COUNT = MAX_PITCH - MIN_PITCH + 1
const BLACK_PCS = new Set([1, 3, 6, 8, 10])
const KEYBOARD_H = 96
const DEFAULT_PX_PER_SEC = 140

export interface WaterfallViewCallbacks {
  onSeek(seconds: number): void
}

/**
 * 钢琴瀑布流（自绘 Canvas 2D，设计文档 §6.4）：
 * 底部为 88 键钢琴键盘（判定线即键盘上沿，无中间判定线）；音符条自上而下坠落，
 * 落到琴键的瞬间即发声时刻（与音频调度共用同一时钟，天然对齐），发声期间琴键点亮。
 * 交互：点击跳转、拖拽平移（脱离跟随）、双击恢复跟随、滚轮缩放。
 */
export class WaterfallView implements View {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly cbs: WaterfallViewCallbacks

  private notes: Note[] = []
  private noteEnds: number[] = []
  private playhead = 0
  private playing = false
  private follow = true
  private pxPerSecond = DEFAULT_PX_PER_SEC
  /** 画布顶边对应的时间（秒）；判定线时间 = viewTopSec - 音符区高度 / pxPerSecond */
  private viewTopSec = 0
  private dragStart: { y: number; viewTopSec: number; moved: boolean } | null = null
  private keysOffscreen: HTMLCanvasElement | null = null
  private readonly resizeObserver: ResizeObserver

  constructor(cbs: WaterfallViewCallbacks) {
    this.cbs = cbs
    this.canvas = el('canvas', { class: 'waterfall__canvas' })
    this.el = el('div', { class: 'waterfall' }, this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx

    this.resizeObserver = new ResizeObserver(() => {
      this.resize()
      this.render()
    })
    this.resizeObserver.observe(this.el)
    this.resize()

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId)
      this.dragStart = { y: e.offsetY, viewTopSec: this.viewTopSec, moved: false }
    })
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragStart === null) return
      const dy = e.offsetY - this.dragStart.y
      if (Math.abs(dy) > 3) {
        this.dragStart.moved = true
        this.follow = false
        // 拖拽向下 = 内容下移 = 视窗向更早时间平移
        this.viewTopSec = this.dragStart.viewTopSec - dy / this.pxPerSecond
      }
    })
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.dragStart === null) return
      const wasDrag = this.dragStart.moved
      this.dragStart = null
      if (!wasDrag) {
        const noteAreaH = this.noteAreaHeight()
        if (e.offsetY < noteAreaH) {
          // 点击处的时间：t = viewTopSec - y / pxPerSecond
          const t = this.viewTopSec - e.offsetY / this.pxPerSecond
          if (t >= 0) {
            this.follow = true
            this.cbs.onSeek(t)
          }
        }
      }
    })
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const anchorT = this.viewTopSec - e.offsetY / this.pxPerSecond
        const factor = Math.exp(-e.deltaY * 0.001)
        this.pxPerSecond = Math.max(10, Math.min(600, this.pxPerSecond * factor))
        this.viewTopSec = anchorT + e.offsetY / this.pxPerSecond
        this.render()
      },
      { passive: false },
    )
    this.canvas.addEventListener('dblclick', () => {
      this.follow = true
    })
  }

  destroy(): void {
    this.resizeObserver.disconnect()
  }

  setNotes(notes: Note[]): void {
    this.notes = [...notes].sort((a, b) => a.start - b.start)
    this.noteEnds = this.notes.map((n) => n.end)
    // 初始视窗：判定线（键盘上沿）对齐 0 秒，未来音符自键盘向上排布
    this.viewTopSec = this.noteAreaHeight() / this.pxPerSecond
    this.playhead = 0
    this.follow = true
    this.render()
  }

  clear(): void {
    this.notes = []
    this.noteEnds = []
    this.playhead = 0
    this.viewTopSec = 0
    this.render()
  }

  /** 每帧调用：更新播放位置并重绘 */
  setPosition(positionSec: number, playing: boolean): void {
    this.playhead = positionSec
    this.playing = playing
    this.render()
  }

  private noteAreaHeight(): number {
    return Math.max(0, this.el.clientHeight - KEYBOARD_H)
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    if (w === 0 || h === 0) return
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.keysOffscreen = null
  }

  private render(): void {
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    if (w === 0 || h === 0) return
    const ctx = this.ctx
    ctx.clearRect(0, 0, w, h)
    const noteAreaH = h - KEYBOARD_H
    const keyboardTop = noteAreaH

    // 跟随播放：判定线（键盘上沿）始终对齐播放头；画布顶边 = 播放头 + 音符区高度/pps
    if (this.playing && this.follow) {
      this.viewTopSec = this.playhead + noteAreaH / this.pxPerSecond
    }
    // 判定线时间；未来在画布上方（y 小），过去在键盘下方（不可见）
    const tKey = this.viewTopSec - noteAreaH / this.pxPerSecond
    const yAt = (t: number): number => noteAreaH - (t - tKey) * this.pxPerSecond

    this.drawKeyboard(w, noteAreaH)
    this.drawNotes(w, noteAreaH, yAt)
    this.drawActiveKeys(w, keyboardTop)

    if (this.notes.length === 0) {
      ctx.fillStyle = 'rgba(128,128,128,0.8)'
      ctx.font = '14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('导入并选择一个 MIDI 文件后，瀑布流会显示在这里', w / 2, noteAreaH / 2)
    }
  }

  /** 底部 88 键键盘（离屏缓存）；判定线即其上沿，不另画判定线 */
  private drawKeyboard(w: number, noteAreaH: number): void {
    const dpr = window.devicePixelRatio || 1
    if (this.keysOffscreen === null) {
      const off = document.createElement('canvas')
      off.width = Math.round(w * dpr)
      off.height = Math.round(KEYBOARD_H * dpr)
      const octx = off.getContext('2d')
      if (octx !== null) {
        octx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const keyW = w / PITCH_COUNT
        // 白键
        for (let i = 0; i < PITCH_COUNT; i++) {
          const pc = (MIN_PITCH + i) % 12
          const x = i * keyW
          octx.fillStyle = '#f2f2f5'
          octx.fillRect(x, 0, keyW, KEYBOARD_H)
          octx.strokeStyle = 'rgba(0,0,0,0.3)'
          octx.lineWidth = 0.5
          octx.strokeRect(x + 0.5, 0.5, keyW - 1, KEYBOARD_H - 1)
          if (pc === 0) {
            const octave = Math.floor((MIN_PITCH + i) / 12) - 1
            octx.fillStyle = 'rgba(0,0,0,0.55)'
            octx.font = '10px system-ui, sans-serif'
            octx.textAlign = 'left'
            octx.fillText(`C${octave}`, x + 3, KEYBOARD_H - 6)
          }
        }
        // 黑键（叠画在白键上）
        for (let i = 0; i < PITCH_COUNT; i++) {
          const pc = (MIN_PITCH + i) % 12
          if (!BLACK_PCS.has(pc)) continue
          const x = i * keyW
          octx.fillStyle = '#1c1c20'
          octx.fillRect(x - keyW * 0.18, 0, keyW * 0.72, KEYBOARD_H * 0.62)
          octx.strokeStyle = 'rgba(0,0,0,0.6)'
          octx.lineWidth = 0.5
          octx.strokeRect(x - keyW * 0.18, 0, keyW * 0.72, KEYBOARD_H * 0.62)
        }
      }
      this.keysOffscreen = off
    }
    this.ctx.drawImage(this.keysOffscreen, 0, noteAreaH, w, KEYBOARD_H)
  }

  /** 音符条：自上而下坠落；条底到判定线的时刻即发声时刻 */
  private drawNotes(w: number, noteAreaH: number, yAt: (t: number) => number): void {
    if (this.notes.length === 0) return
    const keyW = w / PITCH_COUNT
    // 可见窗口：[判定线时间, 画布顶边时间] = [viewTopSec - noteAreaH/pps, viewTopSec]
    const tKey = this.viewTopSec - noteAreaH / this.pxPerSecond

    // 二分：第一个 end > tKey 的音符
    let lo = 0
    let hi = this.noteEnds.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.noteEnds[mid] <= tKey) lo = mid + 1
      else hi = mid
    }

    const ctx = this.ctx
    ctx.shadowColor = 'rgba(99, 102, 241, 0.8)'
    ctx.shadowBlur = 6
    for (let i = lo; i < this.notes.length; i++) {
      const n = this.notes[i]
      if (n.start > this.viewTopSec + 0.5) break
      if (n.pitch < MIN_PITCH || n.pitch > MAX_PITCH) continue
      const bottomEdge = yAt(n.start)
      const topEdge = yAt(n.end)
      if (bottomEdge <= 0 || topEdge >= noteAreaH) continue
      const y0 = Math.max(0, topEdge)
      const y1 = Math.min(noteAreaH, bottomEdge)
      if (y1 - y0 < 1) continue

      const col = n.pitch - MIN_PITCH
      const black = BLACK_PCS.has(n.pitch % 12)
      const x = col * keyW + keyW * (black ? 0.1 : 0.07)
      const bw = keyW * (black ? 0.8 : 0.86)
      ctx.fillStyle = 'rgba(99, 102, 241, 0.92)'
      const radius = Math.min(3, keyW / 4, (y1 - y0) / 2)
      this.roundRect(x, y0, bw, y1 - y0, radius)
      ctx.fill()
    }
    ctx.shadowBlur = 0
  }

  /** 发声中的琴键点亮（发光） */
  private drawActiveKeys(w: number, keyboardTop: number): void {
    const ctx = this.ctx
    const keyW = w / PITCH_COUNT
    const active = new Set<number>()
    for (const n of this.notes) {
      if (n.start > this.playhead) break
      if (this.playhead < n.end) active.add(n.pitch)
    }
    if (active.size === 0) return
    ctx.shadowColor = 'rgba(34, 211, 238, 0.9)'
    ctx.shadowBlur = 10
    ctx.fillStyle = 'rgba(34, 211, 238, 0.9)'
    for (const pitch of active) {
      if (pitch < MIN_PITCH || pitch > MAX_PITCH) continue
      const col = pitch - MIN_PITCH
      const black = BLACK_PCS.has(pitch % 12)
      if (black) {
        ctx.fillRect(col * keyW + keyW * 0.1, keyboardTop + 1, keyW * 0.8, KEYBOARD_H * 0.62)
      } else {
        ctx.fillRect(col * keyW + 1, keyboardTop + 1, keyW - 2, KEYBOARD_H - 2)
      }
    }
    ctx.shadowBlur = 0
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx
    const rr = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr)
    ctx.arcTo(x + w, y + h, x, y + h, rr)
    ctx.arcTo(x, y + h, x, y, rr)
    ctx.arcTo(x, y, x + w, y, rr)
    ctx.closePath()
  }
}
