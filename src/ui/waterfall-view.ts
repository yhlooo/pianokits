import type { Note } from '../core/model'
import { el } from './dom'
import type { View } from './store'
import { TRACK_COLORS, trackColor, type TrackColor } from './track-colors'

const MIN_PITCH = 21 // A0
const MAX_PITCH = 108 // C8
const PITCH_COUNT = MAX_PITCH - MIN_PITCH + 1
const BLACK_PCS = new Set([1, 3, 6, 8, 10])
/** 键盘高度跟随键宽：真实白键宽长比约 1 : 6.3（23.6mm × 150mm），并设上下限 */
const WHITE_KEY_ASPECT = 6.3
const KEYBOARD_MIN_H = 44
const KEYBOARD_MAX_H = 140
const DEFAULT_PX_PER_SEC = 140
/** 点亮键释放后的渐隐时长（ms） */
const KEY_FADE_MS = 80
/** 黑键几何（相对白键列宽）：左偏移、键宽、键长占键盘高比例 */
const BLACK_KEY_INSET = 0.18
const BLACK_KEY_WIDTH = 0.72
const BLACK_KEY_HEIGHT = 0.62

export interface WaterfallViewCallbacks {
  onSeek(seconds: number): void
}

/** 练习模式键盘反馈：按住键 + 按错键（设计文档 20260906-midi-keyboard-and-practice.md §4.2） */
export interface WaterfallKeyFeedback {
  held: ReadonlySet<number>
  wrong: ReadonlySet<number>
}

/** 按系数压暗 RGB 颜色（力度映射：弱音更暗） */
function shade(c: readonly [number, number, number] | readonly number[], f: number): string {
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`
}

/** RGB 三元组 + alpha → rgba() 字符串（发光色用） */
function rgba(c: readonly [number, number, number] | readonly number[], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}

/**
 * 钢琴瀑布流（自绘 Canvas 2D，设计文档 §6.4）：
 * 底部为 88 键钢琴键盘（判定线即键盘上沿，无中间判定线）；音符条自上而下坠落，
 * 落到琴键的瞬间即发声时刻（与音频调度共用同一时钟，天然对齐），发声期间琴键点亮。
 * 视觉（视觉风格指南 §6.4）：按轨五色循环（一轨一色，第 6 轨复用第 1 色）+ 力度→明度映射 + 音区参考线。
 * 交互：点击跳转、拖拽平移（联动进度条，松手后恢复跟随）、双击恢复跟随。
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
  /** 键盘高度：随容器宽度按键宽比例换算（resize 时更新） */
  private keyboardH = KEYBOARD_MIN_H
  private bgGradient: CanvasGradient | null = null
  /** 上一帧发声中的键：pitch → 轨号（渐隐时用于找回轨色） */
  private prevActive = new Map<number, number>()
  /** 释放中的键：pitch → { 轨号, 释放时刻 } */
  private readonly releasedAt = new Map<number, { track: number; at: number }>()
  /** 练习模式键盘反馈（按住/按错键）；null = 不显示 */
  private keyFeedback: WaterfallKeyFeedback | null = null
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
        // 拖拽向下 = 内容下移 = 视窗向更早时间平移（与手势同向）
        this.viewTopSec = this.dragStart.viewTopSec + dy / this.pxPerSecond
        // 拖动联动进度条：判定线（键盘上沿）时间即当前播放位置
        const tKey = this.viewTopSec - this.noteAreaHeight() / this.pxPerSecond
        this.cbs.onSeek(tKey)
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
            this.cbs.onSeek(t)
          }
        }
      }
      // 拖拽/点击结束后恢复跟随播放（拖拽期间的脱离跟随仅用于手势平移期间）
      this.follow = true
    })
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
    this.prevActive.clear()
    this.releasedAt.clear()
    this.render()
  }

  clear(): void {
    this.notes = []
    this.noteEnds = []
    this.playhead = 0
    this.viewTopSec = 0
    this.prevActive.clear()
    this.releasedAt.clear()
    this.render()
  }

  /** 练习模式键盘反馈：按住键琥珀点亮、按错键红色（null 清除） */
  setKeyFeedback(fb: WaterfallKeyFeedback | null): void {
    this.keyFeedback = fb
    this.render()
  }

  /** 每帧调用：更新播放位置并重绘 */
  setPosition(positionSec: number, playing: boolean): void {
    this.playhead = positionSec
    this.playing = playing
    this.render()
  }

  private noteAreaHeight(): number {
    return Math.max(0, this.el.clientHeight - this.keyboardH)
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    if (w === 0 || h === 0) return
    // 键宽随容器变化，键盘高度按真实白键宽长比换算（钳制上下限），保持琴键比例协调
    const keyW = w / PITCH_COUNT
    this.keyboardH = Math.round(
      Math.max(KEYBOARD_MIN_H, Math.min(KEYBOARD_MAX_H, keyW * WHITE_KEY_ASPECT)),
    )
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.keysOffscreen = null
    // 背景微渐变缓存：自上而下 #121110 → #161514
    const g = this.ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#121110')
    g.addColorStop(1, '#161514')
    this.bgGradient = g
  }

  private render(): void {
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    if (w === 0 || h === 0) return
    const ctx = this.ctx
    const noteAreaH = h - this.keyboardH
    const keyboardTop = noteAreaH

    // 背景（微渐变，替代纯色）
    if (this.bgGradient !== null) {
      ctx.fillStyle = this.bgGradient
      ctx.fillRect(0, 0, w, h)
    } else {
      ctx.clearRect(0, 0, w, h)
    }

    // 跟随播放：判定线（键盘上沿）始终对齐播放头；画布顶边 = 播放头 + 音符区高度/pps
    if (this.playing && this.follow) {
      this.viewTopSec = this.playhead + noteAreaH / this.pxPerSecond
    }
    // 判定线时间；未来在画布上方（y 小），过去在键盘下方（不可见）
    const tKey = this.viewTopSec - noteAreaH / this.pxPerSecond
    const yAt = (t: number): number => noteAreaH - (t - tKey) * this.pxPerSecond

    this.drawLaneGuides(w, noteAreaH)
    this.drawNotes(w, noteAreaH, yAt)
    this.drawJudgmentGlow(w, noteAreaH)
    this.drawKeyboard(w, noteAreaH)
    this.drawActiveKeys(w, keyboardTop)
    this.drawKeyFeedback(w, keyboardTop)

    if (this.notes.length === 0) {
      ctx.fillStyle = '#807d76'
      ctx.font = '14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('导入并选择一个 MIDI 文件后，瀑布流会显示在这里', w / 2, noteAreaH / 2)
    }
  }

  /** 音区参考线：每个 C 音位置 1px 发丝竖线 */
  private drawLaneGuides(w: number, noteAreaH: number): void {
    const ctx = this.ctx
    const keyW = w / PITCH_COUNT
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    for (let i = 0; i < PITCH_COUNT; i++) {
      const pc = (MIN_PITCH + i) % 12
      if (pc !== 0) continue
      ctx.fillRect(Math.round(i * keyW) + 0.5, 0, 1, noteAreaH)
    }
  }

  /** 判定区：键盘上沿的琥珀光带（克制，非霓虹） */
  private drawJudgmentGlow(w: number, noteAreaH: number): void {
    const ctx = this.ctx
    const g = ctx.createLinearGradient(0, noteAreaH - 10, 0, noteAreaH)
    g.addColorStop(0, 'rgba(217,164,91,0)')
    g.addColorStop(1, 'rgba(217,164,91,0.4)')
    ctx.fillStyle = g
    ctx.fillRect(0, noteAreaH - 10, w, 10)
  }

  /** 底部 88 键键盘（离屏缓存）；象牙白键 / 乌木黑键材质 */
  private drawKeyboard(w: number, noteAreaH: number): void {
    const dpr = window.devicePixelRatio || 1
    if (this.keysOffscreen === null) {
      const off = document.createElement('canvas')
      off.width = Math.round(w * dpr)
      off.height = Math.round(this.keyboardH * dpr)
      const octx = off.getContext('2d')
      if (octx !== null) {
        octx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const keyW = w / PITCH_COUNT
        // 白键：象牙微渐变
        const ivory = octx.createLinearGradient(0, 0, 0, this.keyboardH)
        ivory.addColorStop(0, '#f4f1eb')
        ivory.addColorStop(1, '#e3dfd7')
        for (let i = 0; i < PITCH_COUNT; i++) {
          const x = i * keyW
          octx.fillStyle = ivory
          octx.fillRect(x, 0, keyW, this.keyboardH)
          octx.strokeStyle = 'rgba(0,0,0,0.25)'
          octx.lineWidth = 0.5
          octx.strokeRect(x + 0.5, 0.5, keyW - 1, this.keyboardH - 1)
        }
        // 白键键底阴影线
        octx.fillStyle = 'rgba(0,0,0,0.16)'
        octx.fillRect(0, this.keyboardH - 1, w, 1)
        // 黑键（叠画在白键上）：乌木渐变 + 顶边高光
        const ebony = octx.createLinearGradient(0, 0, 0, this.keyboardH * 0.62)
        ebony.addColorStop(0, '#2a2825')
        ebony.addColorStop(1, '#141312')
        for (let i = 0; i < PITCH_COUNT; i++) {
          const pc = (MIN_PITCH + i) % 12
          if (!BLACK_PCS.has(pc)) continue
          const x = i * keyW
          const bx = x - keyW * BLACK_KEY_INSET
          const bw = keyW * BLACK_KEY_WIDTH
          const bh = this.keyboardH * BLACK_KEY_HEIGHT
          octx.fillStyle = ebony
          octx.fillRect(bx, 0, bw, bh)
          octx.strokeStyle = 'rgba(0,0,0,0.6)'
          octx.lineWidth = 0.5
          octx.strokeRect(bx, 0, bw, bh)
          octx.fillStyle = 'rgba(255,255,255,0.08)'
          octx.fillRect(bx, 0, bw, 1)
        }
      }
      this.keysOffscreen = off
    }
    this.ctx.drawImage(this.keysOffscreen, 0, noteAreaH, w, this.keyboardH)
  }

  /** 音符条：按轨五色循环（一轨一色），力度调制明度与透明度，顶部 1px 高光 */
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

      const [top, bottom] = trackColor(n.trackIndex)
      // 力度映射：弱音更暗更淡，强音更亮更实
      const v = Math.max(0, Math.min(1, n.velocity / 127))
      const vf = 0.55 + 0.5 * v
      const alpha = 0.55 + 0.45 * v

      const col = n.pitch - MIN_PITCH
      const black = BLACK_PCS.has(n.pitch % 12)
      const x = col * keyW + keyW * (black ? 0.1 : 0.07)
      const bw = keyW * (black ? 0.8 : 0.86)

      const g = ctx.createLinearGradient(0, y0, 0, y1)
      g.addColorStop(0, shade(top, Math.min(1.05, vf)))
      g.addColorStop(1, shade(bottom, vf))
      ctx.globalAlpha = alpha
      ctx.shadowColor = rgba(top, 0.45)
      ctx.shadowBlur = 6
      ctx.fillStyle = g
      const radius = Math.min(3, keyW / 4, (y1 - y0) / 2)
      this.roundRect(x, y0, bw, y1 - y0, radius)
      ctx.fill()
      ctx.shadowBlur = 0
      // 顶部 1px 高光边（音符够高时才有意义）
      if (y1 - y0 > 4) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        this.roundRect(x, y0, bw, 1, 0.5)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }

  /** 发声中的琴键点亮（颜色跟随音符轨色，同键多音符取最近 onset；释放后 80ms 渐隐） */
  private drawActiveKeys(w: number, keyboardTop: number): void {
    const ctx = this.ctx
    const keyW = w / PITCH_COUNT
    // 当前发声中的键：pitch → 轨号（notes 按 start 排序，同键后写的覆盖 → 最近 onset 胜出）
    const active = new Map<number, number>()
    for (const n of this.notes) {
      if (n.start > this.playhead) break
      if (this.playhead < n.end) active.set(n.pitch, n.trackIndex)
    }
    // 记录释放时刻（用于渐隐，连同轨号以便渐隐时沿用轨色）
    const now = performance.now()
    for (const [p, track] of this.prevActive) {
      if (!active.has(p)) this.releasedAt.set(p, { track, at: now })
    }
    for (const p of active.keys()) this.releasedAt.delete(p)
    this.prevActive = new Map(active)
    for (const [p, v] of this.releasedAt) {
      if (now - v.at > KEY_FADE_MS) this.releasedAt.delete(p)
    }

    const drawKey = (pitch: number, alpha: number): void => {
      if (pitch < MIN_PITCH || pitch > MAX_PITCH) return
      const col = pitch - MIN_PITCH
      const black = BLACK_PCS.has(pitch % 12)
      ctx.globalAlpha = alpha
      if (black) {
        // 与离屏键盘黑键几何一致，完整覆盖
        ctx.fillRect(
          col * keyW - keyW * BLACK_KEY_INSET,
          keyboardTop,
          keyW * BLACK_KEY_WIDTH,
          this.keyboardH * BLACK_KEY_HEIGHT,
        )
      } else {
        // 完整覆盖白键（含描边），不留缝隙
        ctx.fillRect(col * keyW, keyboardTop, keyW, this.keyboardH)
      }
      ctx.globalAlpha = 1
    }

    // 按轨色分批绘制（批次数 ≤ 色板大小 5，每批一次 fillStyle/shadow 设置）
    const byColor = new Map<number, [number, number][]>()
    const addEntry = (colorIndex: number, entry: [number, number]): void => {
      let list = byColor.get(colorIndex)
      if (list === undefined) {
        list = []
        byColor.set(colorIndex, list)
      }
      list.push(entry)
    }
    for (const [p, track] of active) addEntry(track % TRACK_COLORS.length, [p, 1])
    for (const [p, v] of this.releasedAt) {
      const alpha = 1 - (now - v.at) / KEY_FADE_MS
      addEntry(v.track % TRACK_COLORS.length, [p, alpha])
    }
    const paint = (entries: [number, number][], color: TrackColor): void => {
      ctx.shadowColor = rgba(color[0], 0.85)
      ctx.shadowBlur = 10
      ctx.fillStyle = shade(color[0], 1)
      for (const [p, alpha] of entries) drawKey(p, alpha)
      ctx.shadowBlur = 0
    }
    for (const [colorIndex, entries] of byColor) paint(entries, TRACK_COLORS[colorIndex])
  }

  /** 练习模式键盘反馈：按住键琥珀点亮、按错键红色 + 光晕（画在轨色点亮之上） */
  private drawKeyFeedback(w: number, keyboardTop: number): void {
    const fb = this.keyFeedback
    if (fb === null) return
    const ctx = this.ctx
    const keyW = w / PITCH_COUNT
    const fillKey = (pitch: number): void => {
      if (pitch < MIN_PITCH || pitch > MAX_PITCH) return
      const col = pitch - MIN_PITCH
      const black = BLACK_PCS.has(pitch % 12)
      if (black) {
        ctx.fillRect(
          col * keyW - keyW * BLACK_KEY_INSET,
          keyboardTop,
          keyW * BLACK_KEY_WIDTH,
          this.keyboardH * BLACK_KEY_HEIGHT,
        )
      } else {
        ctx.fillRect(col * keyW, keyboardTop, keyW, this.keyboardH)
      }
    }
    // 按住键（不含按错键）：琥珀半透明点亮
    ctx.globalAlpha = 0.55
    ctx.fillStyle = '#d9a45b'
    for (const p of fb.held) {
      if (!fb.wrong.has(p)) fillKey(p)
    }
    // 按错键：语义危险红 + 同色光晕，最上层
    ctx.shadowColor = 'rgba(224,105,94,0.9)'
    ctx.shadowBlur = 12
    ctx.globalAlpha = 0.92
    ctx.fillStyle = '#e0695e'
    for (const p of fb.wrong) fillKey(p)
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
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
