import type { Note } from '../core/model'
import { el } from './dom'
import {
  BLACK_PCS,
  KEYBOARD_H_RATIO,
  MAX_PITCH,
  MIN_PITCH,
  buildPiano,
  type PianoLit,
  type PianoView,
} from './piano-keyboard'
import type { View } from './store'
import { TRACK_COLORS, trackColor } from './track-colors'

const PITCH_COUNT = MAX_PITCH - MIN_PITCH + 1
const DEFAULT_PX_PER_SEC = 140
/** 点亮键释放后的渐隐时长（ms） */
const KEY_FADE_MS = 80
/** 练习反馈配色（设计文档 20260906-midi-keyboard-and-practice.md §4.2） */
const HELD_RGB = [217, 164, 91] as const // 按住键琥珀 #d9a45b
const WRONG_RGB = [224, 105, 94] as const // 按错键红 #e0695e
/** 练习模式下非练习轨瀑布流的压暗系数（设计文档 20260906-midi-keyboard-and-practice.md §4.2）：
 *  亮度 0.6 / 不透明度 0.62——比正常暗淡一点、仍清晰可辨，突出正在练习的轨 */
const PRACTICE_DIM_VF = 0.6
const PRACTICE_DIM_ALPHA = 0.62

type Rgb = readonly [number, number, number]

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

/** 按系数压暗 RGB 三元组（键盘点亮色用） */
function shadeTuple(c: Rgb, f: number): Rgb {
  return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)]
}

/** c 以不透明度 t 叠在 over 之上（练习反馈叠于轨色点亮之上，与画布时代分层一致） */
function overTuple(c: Rgb, over: Rgb, t: number): Rgb {
  return [
    Math.round(c[0] * t + over[0] * (1 - t)),
    Math.round(c[1] * t + over[1] * (1 - t)),
    Math.round(c[2] * t + over[2] * (1 - t)),
  ]
}

/**
 * 钢琴瀑布流（音符区自绘 Canvas 2D，设计文档 §6.4）：
 * 底部为 88 键钢琴键盘（与「MIDI 键盘」调试页共用 DOM 组件；判定线即键盘上沿，
 * 无中间判定线）；音符条自上而下坠落，
 * 落到琴键的瞬间即发声时刻（与音频调度共用同一时钟，天然对齐），发声期间琴键点亮。
 * 视觉（视觉风格指南 §6.4）：按轨五色循环（一轨一色，第 6 轨复用第 1 色）+ 力度→明度映射 + 音区参考线。
 * 交互：点击跳转、拖拽平移（联动进度条，松手后恢复跟随）、双击恢复跟随。
 */
export class WaterfallView implements View {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly piano: PianoView
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
  /** 键盘高度：= 总宽度 × 0.122（resize 时随宽度同步更新，不钳制） */
  private keyboardH = 0
  private bgGradient: CanvasGradient | null = null
  /** 上一帧发声中的键：pitch → 轨号（渐隐时用于找回轨色） */
  private prevActive = new Map<number, number>()
  /** 释放中的键：pitch → { 轨号, 释放时刻 } */
  private readonly releasedAt = new Map<number, { track: number; at: number }>()
  /** 练习模式键盘反馈（按住/按错键）；null = 不显示 */
  private keyFeedback: WaterfallKeyFeedback | null = null
  /**
   * 练习模式开启练习的轨集合（分轨压暗）：集合内的轨正常显示，其余轨的
   * 音符条与琴键点亮压暗；null = 练习关闭（全部正常显示）
   */
  private practiceTracks: ReadonlySet<number> | null = null
  private readonly resizeObserver: ResizeObserver

  constructor(cbs: WaterfallViewCallbacks) {
    this.cbs = cbs
    this.canvas = el('canvas', { class: 'waterfall__canvas' })
    // 底部键盘与「MIDI 键盘」调试页共用同一 DOM 组件（画布只负责音符区）
    this.piano = buildPiano()
    this.el = el('div', { class: 'waterfall' }, this.canvas, this.piano.el)
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

  /**
   * 分轨压暗（设计文档 20260906-midi-keyboard-and-practice.md §4.2）：
   * 传入开启练习的轨集合——这些轨正常显示，其余轨瀑布流压暗；
   * null = 关闭练习，全部正常显示。
   */
  setPracticeTracks(tracks: ReadonlySet<number> | null): void {
    this.practiceTracks = tracks
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
    // 键盘高度 = 总宽度 × 0.122（与调试页 aspect-ratio 同一比例）：宽度变化（拉伸/缩放）
    // 时高度同步按比例改变；黑键高 = 键盘高 × 2/3 由共享 CSS 承担
    this.keyboardH = Math.round(w * KEYBOARD_H_RATIO)
    this.piano.el.style.height = `${this.keyboardH}px`
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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
    // 底部键盘是共享 DOM 组件，这里只同步它的点亮状态
    this.applyKeyLights()
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

  /**
   * 键盘点亮（共享 DOM 钢琴）：发声键按音符轨色点亮 + 同色光晕（同键多音符取最近
   * onset），释放后 80ms 渐隐；练习模式下非练习轨点亮随瀑布流一起压暗；
   * 练习反馈（按住键琥珀、按错键红 + 光晕）叠在轨色点亮之上（与画布时代分层一致）。
   */
  private applyKeyLights(): void {
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

    const lit = new Map<number, PianoLit>()
    const put = (pitch: number, color: Rgb, alpha: number, glow: number): void => {
      if (pitch < MIN_PITCH || pitch > MAX_PITCH) return
      lit.set(pitch, { color, alpha, glow })
    }
    const isDimmed = (track: number): boolean =>
      this.practiceTracks !== null && !this.practiceTracks.has(track)

    // 轨色点亮：非练习轨按亮度 0.55 / 光晕 0.3 压暗（与瀑布流音符条压暗一致）
    for (const [p, track] of active) {
      const top = TRACK_COLORS[track % TRACK_COLORS.length][0]
      put(p, shadeTuple(top, isDimmed(track) ? 0.55 : 1), 1, isDimmed(track) ? 0.3 : 0.85)
    }
    for (const [p, v] of this.releasedAt) {
      const top = TRACK_COLORS[v.track % TRACK_COLORS.length][0]
      put(
        p,
        shadeTuple(top, isDimmed(v.track) ? 0.55 : 1),
        1 - (now - v.at) / KEY_FADE_MS,
        isDimmed(v.track) ? 0.3 : 0.85,
      )
    }

    // 练习反馈叠在轨色点亮之上：按住键琥珀半透明（55%）、按错键红（92%）+ 光晕
    const fb = this.keyFeedback
    if (fb !== null) {
      for (const p of fb.held) {
        if (fb.wrong.has(p)) continue
        const cur = lit.get(p)
        if (cur === undefined) put(p, HELD_RGB, 0.55, 0)
        else lit.set(p, { ...cur, color: overTuple(HELD_RGB, cur.color, 0.55) })
      }
      for (const p of fb.wrong) {
        const cur = lit.get(p)
        if (cur === undefined) put(p, WRONG_RGB, 0.92, 0.9)
        else
          lit.set(p, {
            ...cur,
            color: overTuple(WRONG_RGB, cur.color, 0.92),
            glow: Math.max(cur.glow ?? 0, 0.9),
          })
      }
    }
    this.piano.setLit(lit)
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
      // 分轨压暗：练习模式下非练习轨暗淡，练习轨正常显示
      const dimmed = this.practiceTracks !== null && !this.practiceTracks.has(n.trackIndex)
      // 力度映射：弱音更暗更淡，强音更亮更实
      const v = Math.max(0, Math.min(1, n.velocity / 127))
      const vf = (0.55 + 0.5 * v) * (dimmed ? PRACTICE_DIM_VF : 1)
      const alpha = (0.55 + 0.45 * v) * (dimmed ? PRACTICE_DIM_ALPHA : 1)

      const col = n.pitch - MIN_PITCH
      const black = BLACK_PCS.has(n.pitch % 12)
      const x = col * keyW + keyW * (black ? 0.1 : 0.07)
      const bw = keyW * (black ? 0.8 : 0.86)

      const g = ctx.createLinearGradient(0, y0, 0, y1)
      g.addColorStop(0, shade(top, Math.min(1.05, vf)))
      g.addColorStop(1, shade(bottom, vf))
      ctx.globalAlpha = alpha
      ctx.shadowColor = rgba(top, dimmed ? 0.18 : 0.45)
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
