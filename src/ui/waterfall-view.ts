import type { Note, PedalEvent } from '../core/model'
import {
  PEDALS,
  buildPedalSegments,
  isSegmentFocused,
  pedalColumn,
  type PedalFocus,
  type PedalId,
  type PedalSegment,
} from '../core/midi/pedals'
import { el } from './dom'
import {
  KEYBOARD_H_RATIO,
  MAX_PITCH,
  MIN_PITCH,
  WHITE_KEY_COUNT,
  buildPiano,
  keyGeometry,
  type PianoLit,
  type PianoView,
} from './piano-keyboard'
import type { View } from './store'
import { TRACK_COLORS, trackColor } from './track-colors'

const DEFAULT_PX_PER_SEC = 140
/** 点亮键释放后的渐隐时长（ms） */
const KEY_FADE_MS = 80
/** 练习反馈配色（设计文档 20260906-midi-keyboard-and-practice.md §4.2） */
const HELD_RGB = [217, 164, 91] as const // 按住键琥珀 #d9a45b
const WRONG_RGB = [224, 105, 94] as const // 按错键/误踩踏板红 #e0695e
/** 练习模式下非练习轨瀑布流的压暗系数（设计文档 20260906-midi-keyboard-and-practice.md §4.2）：
 *  亮度 0.6 / 不透明度 0.62——比正常暗淡一点、仍清晰可辨，突出正在练习的轨 */
const PRACTICE_DIM_VF = 0.6
const PRACTICE_DIM_ALPHA = 0.62

// ---------- 踏板轨道（设计文档 20260912-midi-pedal-lane-and-practice.md §3.4） ----------
/** 踏板条宽 = 4 个白键、相邻间隔 = 2 个白键（用户口径）；三列总宽 16 白键、整体居中 */
const PEDAL_BAR_WHITE_KEYS = 4
const PEDAL_GAP_WHITE_KEYS = 2
/**
 * 踏板条：接近灰度的银灰，**上下渐变**（顶亮底暗）+ 顶部 1px 高光（银灰金属感）。
 * 明度明显低于音符条（用户反馈：太突出）。不随轨色/力度变化。
 */
const PEDAL_SILVER_TOP = [188, 192, 198] as const
const PEDAL_SILVER_BOTTOM = [128, 133, 140] as const
/** 判定线处触发光晕的银白（比条本身更亮，保证"明显"表示触发） */
const PEDAL_GLOW_RGB = [228, 234, 242] as const
/**
 * 触发光晕：**以判定线为高度中心**的圆角矩形光斑（只画光晕本身，不画发光条）。
 * - 圆角矩形的高度中点在判定线上 → 可见部分只有上半块（底边平直、上方圆角），
 *   下半块落在钢琴键盘区域，绘制时裁掉不画；
 * - 宽度：与踏板轨同宽或只略微宽（PEDAL_GLOW_SPREAD_X 每侧几 px）；
 * - 亮度：高度中点（判定线）最亮，向上下两侧对称渐隐，顶边仍留一点亮度 → 轮廓可辨；
 * - 边缘：整块做一次高斯模糊（PEDAL_GLOW_BLUR）柔化成光。
 */
const PEDAL_GLOW_HALF = 15
const PEDAL_GLOW_SPREAD_X = 8
const PEDAL_GLOW_RADIUS = 8
const PEDAL_GLOW_BLUR = 4
/** 贴图四周留白（容纳模糊外溢；内容高度中点 = 判定线） */
const PEDAL_GLOW_PAD = 14
const PEDAL_GLOW_FADE_SEC = 0.12
/** 踏板条不透明度：正常 / 练习中"无需关注"的压暗值 */
const PEDAL_BAR_ALPHA = 0.35
const PEDAL_DIM_ALPHA = 0.14

type Rgb = readonly [number, number, number]

export interface WaterfallViewCallbacks {
  /** 点击跳转（立即定位，播放中则跳转后继续发声） */
  onSeek(seconds: number): void
  /** 拖拽预览：静音定位（拖动期间不发声） */
  onScrub(seconds: number): void
  /** 拖拽结束：若拖动前在播放则恢复播放（此刻开始发声） */
  onScrubEnd(): void
}

/**
 * 练习模式反馈（设计文档 20260906-midi-keyboard-and-practice.md §4.2、
 * 20260912-midi-pedal-lane-and-practice.md §3.5）：按住键 + 按错键 + 误踩踏板。
 */
export interface WaterfallFeedback {
  held: ReadonlySet<number>
  wrong: ReadonlySet<number>
  /** 误踩的踏板（红晕，与按错键同语义；松开即清除） */
  wrongPedals: ReadonlySet<PedalId>
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

/** 圆角矩形路径（画布与光晕贴图共用） */
function roundRectPath(
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

/**
 * 踏板触发光晕贴图（宽度可变，按宽度缓存）：只画光晕，不画发光条。
 * 内容是**以判定线为高度中心**的圆角矩形（高度 2 × PEDAL_GLOW_HALF，判定线在高度中点）：
 * 亮度由中心（判定线）向上下对称渐隐，顶边仍留一点亮度让轮廓可辨；四周做一次高斯模糊化成光。
 */
function buildPedalGlowSprite(width: number, rgb: Rgb): HTMLCanvasElement {
  const scale = 2 // 按 2 倍分辨率绘制，避免光晕糊；模糊半径同按设备像素给
  const w = Math.max(8, Math.round(width))
  const h = PEDAL_GLOW_HALF * 2
  const pad = PEDAL_GLOW_PAD
  const canvas = document.createElement('canvas')
  canvas.width = (w + pad * 2) * scale
  canvas.height = (h + pad * 2) * scale
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('canvas 2d context unavailable')
  const px = (v: number): number => v * scale

  ctx.filter = `blur(${px(PEDAL_GLOW_BLUR)}px)`
  // 亮度以高度中点（= 判定线）为峰，向上下两侧对称渐隐
  const g = ctx.createLinearGradient(0, px(pad), 0, px(pad + h))
  g.addColorStop(0, rgba(rgb, 0.3)) // 顶边仍留亮度 → 圆角矩形轮廓可辨
  g.addColorStop(0.5, rgba(rgb, 1)) // 高度中点 = 判定线：最亮
  g.addColorStop(1, rgba(rgb, 0.3))
  ctx.fillStyle = g
  roundRectPath(ctx, px(pad), px(pad), px(w), px(h), px(PEDAL_GLOW_RADIUS))
  ctx.fill()
  return canvas
}

/**
 * 钢琴瀑布流（音符区自绘 Canvas 2D，设计文档 §6.4）：
 * 底部为 88 键钢琴键盘（与「MIDI 键盘」调试页共用 DOM 组件；判定线即键盘上沿，
 * 无中间判定线）；音符条自上而下坠落，
 * 落到琴键的瞬间即发声时刻（与音频调度共用同一时钟，天然对齐），发声期间琴键点亮。
 * 视觉（视觉风格指南 §6.4）：按轨五色循环（一轨一色，第 6 轨复用第 1 色）+ 力度→明度映射 + 音区参考线。
 * 横向几何：音符条与音区参考线按键盘几何绘制（keyGeometry，与 DOM 键盘同一套公式）——
 * 白键音符宽 = 白键宽、黑键音符宽 = 黑键宽（按组外扩定位），与底部键盘严格对齐、边缘不漂移。
 * 踏板事件条（设计文档 20260912-midi-pedal-lane-and-practice.md §3.4）：画面中央三列银灰条
 * （左弱音 / 中选择延音 / 右延音，条宽 4 白键、间隔 2 白键），置于音符条之下；只画有事件的
 * 条、不画轨道背景；踩下时刻在与键盘交界处亮起银白光晕，练习误踩时同位置变红。
 * 交互：点击跳转、拖拽平移（联动进度条，松手后恢复跟随）、双击恢复跟随。
 */
export class WaterfallView implements View {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly piano: PianoView
  private readonly cbs: WaterfallViewCallbacks

  private notes: Note[] = []
  private playhead = 0
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
  /** 练习模式反馈（按住/按错键、误踩踏板）；null = 不显示 */
  private feedback: WaterfallFeedback | null = null
  /**
   * 练习模式开启练习的轨集合（分轨压暗）：集合内的轨正常显示，其余轨的
   * 音符条与琴键点亮压暗；null = 练习关闭（全部正常显示）
   */
  private practiceTracks: ReadonlySet<number> | null = null
  /** 曲目踏板踩下区间（setPedals 构建，按 start 排序） */
  private pedalSegments: PedalSegment[] = []
  /**
   * 练习模式下踏板轨道的关注范围（判定 + 高亮）：范围外的踏板条压暗、不显示触发光晕；
   * null = 练习未开启（踏板条全部正常显示）
   */
  private pedalFocus: PedalFocus | null = null
  /** 触发光晕贴图缓存（键 = 宽度|颜色；resize 时清空，按需重建） */
  private readonly glowSprites = new Map<string, HTMLCanvasElement>()
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
        // 拖动联动进度条：判定线（键盘上沿）时间即当前播放位置；静音预览，不发声
        const tKey = this.viewTopSec - this.noteAreaHeight() / this.pxPerSecond
        this.cbs.onScrub(tKey)
      }
    })
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.dragStart === null) return
      const wasDrag = this.dragStart.moved
      this.dragStart = null
      if (wasDrag) {
        // 拖拽结束：若拖动前在播放则恢复播放（此刻才开始发声）
        this.cbs.onScrubEnd()
      } else {
        const noteAreaH = this.noteAreaHeight()
        if (e.offsetY < noteAreaH) {
          // 点击处的时间：t = viewTopSec - y / pxPerSecond
          const t = this.viewTopSec - e.offsetY / this.pxPerSecond
          if (t >= 0) {
            this.cbs.onSeek(t)
          }
        }
      }
      // 拖拽/点击结束后恢复跟随（拖拽期间的脱离跟随仅用于手势平移期间）
      this.follow = true
    })
    // 手势被系统接管（如触控滚动）时也要结束拖拽预览，避免走带停在暂停态不恢复
    this.canvas.addEventListener('pointercancel', () => {
      if (this.dragStart === null) return
      const wasDrag = this.dragStart.moved
      this.dragStart = null
      if (wasDrag) this.cbs.onScrubEnd()
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
    this.pedalSegments = []
    this.pedalFocus = null
    this.playhead = 0
    this.viewTopSec = 0
    this.prevActive.clear()
    this.releasedAt.clear()
    this.render()
  }

  /**
   * 踏板轨道数据（设计文档 20260912-midi-pedal-lane-and-practice.md §3.4）：
   * 曲目三踏板 CC 事件 → 踩下区间（时值），与音符条同一条时间轴坠落。
   */
  setPedals(events: readonly PedalEvent[]): void {
    this.pedalSegments = buildPedalSegments(events)
    this.render()
  }

  /** 练习模式反馈：按住键琥珀点亮、按错键红色、误踩踏板红色光晕（null 清除） */
  setFeedback(fb: WaterfallFeedback | null): void {
    this.feedback = fb
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

  /**
   * 练习模式踏板关注范围（设计文档 20260912-midi-pedal-lane-and-practice.md §3.4）：
   * 范围外的踏板条压暗（"无需关注"）、不显示触发光晕；null = 练习未开启，全部正常显示。
   */
  setPedalFocus(focus: PedalFocus | null): void {
    this.pedalFocus = focus
    this.render()
  }

  /** 每帧调用：更新播放位置并重绘 */
  setPosition(positionSec: number): void {
    this.playhead = positionSec
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
    // 宽度变化 → 踏板光晕贴图（按宽度缓存）作废，下一帧按新宽度重建
    this.glowSprites.clear()
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

    // 跟随：判定线（键盘上沿）始终对齐播放头；画布顶边 = 播放头 + 音符区高度/pps。
    // 不再限定「播放中」——暂停时拖拽进度条/点击跳转也会移动播放头，视窗需同步跟随。
    if (this.follow) {
      this.viewTopSec = this.playhead + noteAreaH / this.pxPerSecond
    }
    // 判定线时间；未来在画布上方（y 小），过去在键盘下方（不可见）
    const tKey = this.viewTopSec - noteAreaH / this.pxPerSecond
    const yAt = (t: number): number => noteAreaH - (t - tKey) * this.pxPerSecond

    this.drawLaneGuides(w, noteAreaH)
    // 踏板条置于最底下：先画踏板，音符条覆盖其上（不阻挡其它音符）
    this.drawPedals(w, noteAreaH, yAt)
    this.drawNotes(w, noteAreaH, yAt)
    this.drawJudgmentGlow(w, noteAreaH)
    // 触发/误踩光晕画在音符之上：光带很薄且半透明，不会遮住音符，但必须清晰可见
    this.drawPedalGlows(w, noteAreaH)
    // 底部键盘是共享 DOM 组件，这里只同步它的点亮状态
    this.applyKeyLights()
  }

  /** 三列踏板（左弱音 / 中选择延音 / 右延音）的横向几何：条宽 4 白键、间隔 2 白键、整体居中 */
  private pedalColumns(w: number): { left: number; width: number }[] {
    const keyW = w / WHITE_KEY_COUNT
    const barW = PEDAL_BAR_WHITE_KEYS * keyW
    const step = (PEDAL_BAR_WHITE_KEYS + PEDAL_GAP_WHITE_KEYS) * keyW
    const groupW = PEDALS.length * barW + (PEDALS.length - 1) * PEDAL_GAP_WHITE_KEYS * keyW
    const left0 = (w - groupW) / 2
    return PEDALS.map((_, i) => ({ left: left0 + i * step, width: barW }))
  }

  /** 某分段是否落在练习关注范围内；练习未开启（focus = null）→ 全部关注 */
  private pedalFocused(seg: PedalSegment): boolean {
    return this.pedalFocus === null || isSegmentFocused(seg, this.pedalFocus)
  }

  /**
   * 踏板条（银灰，置底）：与音符条同一时间映射，条底 = 踩下时刻、条顶 = 抬起时刻。
   * 无踏板事件时画布上不出现任何踏板相关背景（用户口径：只显示事件条本身）；
   * 练习模式下关注范围外的条压暗（"无需关注"，不判定也不显示触发光晕）。
   */
  private drawPedals(w: number, noteAreaH: number, yAt: (t: number) => number): void {
    if (this.pedalSegments.length === 0) return
    const ctx = this.ctx
    const cols = this.pedalColumns(w)

    for (const seg of this.pedalSegments) {
      if (seg.start > this.viewTopSec + 0.5) break // 按 start 排序，越界即止
      const bottomEdge = yAt(seg.start)
      const topEdge = yAt(seg.end)
      if (bottomEdge <= 0 || topEdge >= noteAreaH) continue
      const y0 = Math.max(0, topEdge)
      const y1 = Math.min(noteAreaH, bottomEdge)
      if (y1 - y0 < 1) continue

      const col = cols[pedalColumn(seg.pedalId)]
      const alpha = this.pedalFocused(seg) ? PEDAL_BAR_ALPHA : PEDAL_DIM_ALPHA
      // 上下渐变（顶亮底暗，银灰金属感）+ 顶部 1px 高光
      const g = ctx.createLinearGradient(0, y0, 0, y1)
      g.addColorStop(0, shade(PEDAL_SILVER_TOP, 1))
      g.addColorStop(1, shade(PEDAL_SILVER_BOTTOM, 1))
      ctx.globalAlpha = alpha
      ctx.fillStyle = g
      const radius = Math.min(3, col.width / 4, (y1 - y0) / 2)
      this.roundRect(col.left, y0, col.width, y1 - y0, radius)
      ctx.fill()
      if (y1 - y0 > 4) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        this.roundRect(col.left, y0, col.width, 1, 0.5)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }

  /**
   * 判定线（= 键盘上沿）处的踏板光晕：
   * - 银白：文件踏板正在踩下（关注范围内）——接触瞬间亮起，抬起后 120ms 渐隐；
   * - 红色：练习等待期间误踩的踏板（与按错键同色，位置与银白光晕完全一致）。
   */
  private drawPedalGlows(w: number, noteAreaH: number): void {
    const wrongPedals = this.feedback?.wrongPedals
    if (this.pedalSegments.length === 0 && (wrongPedals === undefined || wrongPedals.size === 0)) {
      return
    }
    const cols = this.pedalColumns(w)
    const now = this.playhead

    for (const seg of this.pedalSegments) {
      if (seg.start > now) break
      if (!this.pedalFocused(seg)) continue
      let strength: number
      if (now <= seg.end) {
        strength = 1
      } else if (now - seg.end < PEDAL_GLOW_FADE_SEC) {
        strength = 1 - (now - seg.end) / PEDAL_GLOW_FADE_SEC
      } else {
        continue
      }
      this.drawPedalGlow(cols[pedalColumn(seg.pedalId)], noteAreaH, PEDAL_GLOW_RGB, strength)
    }

    // 误踩红晕最后画：覆盖同列银光，位置一致
    if (wrongPedals !== undefined) {
      for (const id of wrongPedals) {
        this.drawPedalGlow(cols[pedalColumn(id)], noteAreaH, WRONG_RGB, 0.95)
      }
    }
  }

  /**
   * 单列踏板光晕：圆角矩形光斑的**高度中点落在判定线上**（只画光晕本身，不画发光条）。
   * 可见部分只有上半块（底边平直、上方圆角）；下半块在钢琴键盘区域，被裁掉不画。
   */
  private drawPedalGlow(
    col: { left: number; width: number },
    noteAreaH: number,
    rgb: Rgb,
    strength: number,
  ): void {
    const ctx = this.ctx
    const width = col.width + PEDAL_GLOW_SPREAD_X * 2
    const key = `${Math.round(width)}|${rgb[0]},${rgb[1]},${rgb[2]}`
    let sprite = this.glowSprites.get(key)
    if (sprite === undefined) {
      sprite = buildPedalGlowSprite(width, rgb)
      this.glowSprites.set(key, sprite)
    }
    const pad = PEDAL_GLOW_PAD
    const h = PEDAL_GLOW_HALF * 2
    ctx.save()
    // 只画判定线以上：光晕下半块（钢琴键盘区域）不画，模糊外溢也不越过判定线
    ctx.beginPath()
    ctx.rect(0, 0, this.el.clientWidth, noteAreaH)
    ctx.clip()
    ctx.globalAlpha = Math.max(0, Math.min(1, strength))
    // 贴图内容（圆角矩形）高度中点对齐判定线，四周留白 pad 容纳模糊外溢
    ctx.drawImage(
      sprite,
      col.left - PEDAL_GLOW_SPREAD_X - pad,
      noteAreaH - PEDAL_GLOW_HALF - pad,
      width + pad * 2,
      h + pad * 2,
    )
    ctx.restore()
  }

  /** 音区参考线：每个 C 音位置 1px 发丝竖线，画在 C 键左边缘（B|C 键缝），与键盘严格对齐 */
  private drawLaneGuides(w: number, noteAreaH: number): void {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      if (p % 12 !== 0) continue
      const left = keyGeometry(w, p).left
      ctx.fillRect(Math.round(left) + 0.5, 0, 1, noteAreaH)
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
    const fb = this.feedback
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

  /**
   * 音符条：按轨五色循环（一轨一色），力度调制明度与透明度，顶部 1px 高光。
   * 横向按键盘几何（keyGeometry）：白键音符宽 = 白键宽、黑键音符宽 = 黑键宽，
   * 左边缘与琴键左边缘重合 → 与底部键盘严格对齐。
   */
  private drawNotes(w: number, noteAreaH: number, yAt: (t: number) => number): void {
    if (this.notes.length === 0) return
    // notes 按 start 排序，但 end 并不单调（长音符可被后面先起的短音符“夹住”），
    // 不能对 end 二分；从 0 逐条扫描，已结束的音符由下方 topEdge >= noteAreaH 的裁剪跳过。
    const ctx = this.ctx
    for (let i = 0; i < this.notes.length; i++) {
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

      // 键位几何 = 琴键横向占位（白键宽 / 黑键宽 + 分组外扩定位），与 DOM 键盘同一公式
      const { left, width: keyWidth } = keyGeometry(w, n.pitch)

      const g = ctx.createLinearGradient(0, y0, 0, y1)
      g.addColorStop(0, shade(top, Math.min(1.05, vf)))
      g.addColorStop(1, shade(bottom, vf))
      ctx.globalAlpha = alpha
      ctx.shadowColor = rgba(top, dimmed ? 0.18 : 0.45)
      ctx.shadowBlur = 6
      ctx.fillStyle = g
      const radius = Math.min(3, keyWidth / 4, (y1 - y0) / 2)
      this.roundRect(left, y0, keyWidth, y1 - y0, radius)
      ctx.fill()
      ctx.shadowBlur = 0
      // 顶部 1px 高光边（音符够高时才有意义）
      if (y1 - y0 > 4) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        this.roundRect(left, y0, keyWidth, 1, 0.5)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    roundRectPath(this.ctx, x, y, w, h, r)
  }
}
