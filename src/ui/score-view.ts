import {
  Accidental,
  Beam,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Voice,
} from 'vexflow/bravura'

import type { Measure, NotatedEvent, ScoreModel } from '../core/midi/quantize'
import { el } from './dom'
import type { View } from './store'

const STAFF_TOP_Y = 10
const STAFF_GAP = 100
const SYSTEM_HEIGHT = STAFF_TOP_Y + STAFF_GAP + 100
/** 记谱墨色：近黑微暖（暖象牙纸面上不用纯黑） */
const INK = '#1c1a17'
/** 播放高亮：纸面上的加深琥珀（视觉风格指南 §6.5） */
const ACTIVE_FILL = '#a8772e'
const ACTIVE_STROKE = '#8a6126'
/** 谱面滚动区横向留白 + 纸张卡片横向内边距（与 style.css 保持一致） */
const SCROLL_PAD_X = 16
const CARD_PAD_X = 24

/** 调号数量 → VexFlow keySpec */
const SF_TO_KEYSPEC: Record<number, string> = {
  0: 'C',
  1: 'G',
  2: 'D',
  3: 'A',
  4: 'E',
  5: 'B',
  6: 'F#',
  7: 'C#',
  [-1]: 'F',
  [-2]: 'Bb',
  [-3]: 'Eb',
  [-4]: 'Ab',
  [-5]: 'Db',
  [-6]: 'Gb',
  [-7]: 'Cb',
}

function pieceToDuration(beats: number): string {
  if (beats >= 2 - 1e-6) return '2'
  if (beats >= 1 - 1e-6) return '4'
  return '8'
}

function restDuration(beats: number): string {
  if (beats >= 4 - 1e-6) return '1r'
  if (beats >= 2 - 1e-6) return '2r'
  if (beats >= 1 - 1e-6) return '4r'
  return '8r'
}

/** 合并相邻休止符片段为尽量大的合法时值（休止符无需延音线） */
function mergeRestPieces(totalBeats: number): number[] {
  const parts: number[] = []
  let remaining = totalBeats
  for (const size of [4, 2, 1, 0.5]) {
    while (remaining >= size - 1e-6) {
      parts.push(size)
      remaining -= size
    }
  }
  if (remaining > 1e-6) parts.push(0.5)
  return parts
}

interface SystemRef {
  div: HTMLDivElement
  rendered: boolean
  dirty: boolean
}

/**
 * 五线谱视图（VexFlow 直雕，设计文档 §6.5）：
 * 双谱表（大谱表）+ 调号/拍号 + 延音线 + 符杠 + 播放高亮 + 自动滚动。
 * 按系统（一行）渲染，懒加载（IntersectionObserver），高亮变化只重绘受影响系统。
 */
export class ScoreView implements View {
  readonly el: HTMLElement
  private readonly scrollEl: HTMLDivElement
  private readonly systemsEl: HTMLDivElement
  private readonly emptyEl: HTMLDivElement
  private score: ScoreModel | null = null
  private systems: SystemRef[] = []
  private measuresPerSystem = 4
  private activeIds = new Set<number>()
  private activeSystem = -1
  private observer: IntersectionObserver | null = null
  private resizeObserver: ResizeObserver
  private lastRenderAt = 0

  constructor() {
    this.systemsEl = el('div', { class: 'score__systems' })
    this.scrollEl = el('div', { class: 'score__scroll' }, this.systemsEl)
    this.scrollEl.style.display = 'none'
    this.emptyEl = el(
      'div',
      { class: 'score__empty' },
      el('div', { class: 'score__empty-art' }, '𝄞'),
      el('div', {}, '选择左侧的曲目后，这里会显示参考谱'),
    )
    this.el = el(
      'div',
      { class: 'score' },
      el(
        'div',
        { class: 'score__notice' },
        '自动记谱，仅供跟随参考 · 量化到八分音符网格 · 以 C4 为界分左右手',
      ),
      this.scrollEl,
      this.emptyEl,
    )

    this.resizeObserver = new ResizeObserver(() => {
      if (this.score !== null) this.rebuild()
    })
    this.resizeObserver.observe(this.el)
  }

  setScore(score: ScoreModel): void {
    this.score = score
    this.activeIds.clear()
    this.activeSystem = -1
    this.emptyEl.style.display = 'none'
    this.scrollEl.style.display = ''
    this.rebuild()
  }

  clear(): void {
    this.score = null
    this.systemsEl.replaceChildren()
    this.systems = []
    this.activeIds.clear()
    this.activeSystem = -1
    this.scrollEl.style.display = 'none'
    this.emptyEl.style.display = ''
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    this.observer?.disconnect()
    this.observer = null
  }

  /** 每帧调用：按播放位置计算活动音符，重绘受影响系统并自动滚动 */
  setPosition(positionSec: number): void {
    if (this.score === null) return
    const now = Date.now()
    const active = this.computeActive(positionSec)
    if (!setsEqual(active, this.activeIds) || now - this.lastRenderAt > 500) {
      const changed = new Set<number>(
        [...active, ...this.activeIds].map((id) => this.eventSystem(id)),
      )
      this.activeIds = active
      this.lastRenderAt = now
      for (const sysIdx of changed) {
        const sys = this.systems[sysIdx]
        if (sys !== undefined) {
          if (sys.rendered) {
            sys.dirty = true
            this.renderSystem(sysIdx)
          } else {
            sys.dirty = true
          }
        }
      }
      const lead = this.findLeadingEvent(active)
      if (lead !== null) {
        const sysIdx = Math.floor(lead.measureIndex / this.measuresPerSystem)
        if (sysIdx !== this.activeSystem) {
          this.activeSystem = sysIdx
          const sys = this.systems[sysIdx]
          if (sys !== undefined) {
            sys.div.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }
        }
      }
    }
  }

  private eventSystem(eventId: number): number {
    if (this.score === null) return -1
    const ev = this.score.events.find((e) => e.id === eventId)
    if (ev === undefined) return -1
    return Math.floor(ev.measureIndex / this.measuresPerSystem)
  }

  private computeActive(positionSec: number): Set<number> {
    const score = this.score
    if (score === null) return new Set()
    const events = score.events
    // 二分：最后一个 onsetSec <= position 的事件
    let lo = 0
    let hi = events.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (events[mid].onsetSec <= positionSec) lo = mid + 1
      else hi = mid
    }
    const active = new Set<number>()
    for (let i = lo - 1; i >= 0; i--) {
      const ev = events[i]
      if (positionSec - ev.onsetSec > 5) break // 事件最长不超过 5 秒（小节内）
      if (positionSec < ev.endSec && !ev.rest) active.add(ev.id)
    }
    return active
  }

  private findLeadingEvent(active: Set<number>): NotatedEvent | null {
    if (this.score === null || active.size === 0) return null
    const ids = [...active].sort((a, b) => a - b)
    return this.score.events.find((e) => e.id === ids[0]) ?? null
  }

  private rebuild(): void {
    if (this.score === null) return
    const width = this.el.clientWidth - SCROLL_PAD_X * 2
    if (width <= 0) return
    this.measuresPerSystem = Math.max(1, Math.floor((width - CARD_PAD_X * 2) / 210))
    const systemCount = Math.ceil(this.score.measures.length / this.measuresPerSystem)
    this.systemsEl.replaceChildren()
    this.systems = []
    this.observer?.disconnect()
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = Number((entry.target as HTMLElement).dataset.index)
          const sys = this.systems[idx]
          if (sys !== undefined && (!sys.rendered || sys.dirty)) this.renderSystem(idx)
        }
      },
      { root: this.scrollEl, rootMargin: '600px 0px' },
    )
    for (let i = 0; i < systemCount; i++) {
      const div = el('div', { class: 'score__system', dataset: { index: String(i) } })
      this.systemsEl.append(div)
      this.systems.push({ div, rendered: false, dirty: false })
      this.observer.observe(div)
    }
    this.activeSystem = -1
  }

  private renderSystem(sysIdx: number): void {
    const score = this.score
    const sys = this.systems[sysIdx]
    if (score === null || sys === undefined) return
    const width = this.el.clientWidth - SCROLL_PAD_X * 2 - CARD_PAD_X * 2
    if (width <= 0) return

    sys.div.replaceChildren()
    sys.rendered = true
    sys.dirty = false

    const startMeasure = sysIdx * this.measuresPerSystem
    const endMeasure = Math.min(score.measures.length, startMeasure + this.measuresPerSystem)
    if (startMeasure >= endMeasure) return

    const renderer = new Renderer(sys.div, Renderer.Backends.SVG)
    renderer.resize(width, SYSTEM_HEIGHT)
    const ctx = renderer.getContext()
    if (ctx === null) return
    // 记谱墨色：近黑微暖
    ctx.fillStyle = INK
    ctx.strokeStyle = INK

    const measureWidth = (width - 30) / (endMeasure - startMeasure)

    for (let m = startMeasure; m < endMeasure; m++) {
      const measure = score.measures[m]
      const x = 10 + (m - startMeasure) * measureWidth
      const staveW = measureWidth - 4

      const treble = new Stave(x, STAFF_TOP_Y, staveW)
      const bass = new Stave(x, STAFF_TOP_Y + STAFF_GAP, staveW)
      treble.addClef('treble')
      bass.addClef('bass')
      const keySpec = this.keySpec(measure)
      treble.addKeySignature(keySpec)
      bass.addKeySignature(keySpec)
      if (m === 0) {
        treble.addTimeSignature(`${measure.numerator}/${measure.denominator}`)
        bass.addTimeSignature(`${measure.numerator}/${measure.denominator}`)
      }

      const upper = this.buildVoice(measure, 'upper', this.activeIds)
      const lower = this.buildVoice(measure, 'lower', this.activeIds)
      const voices = upper.voice !== null ? [upper.voice] : []
      if (lower.voice !== null) voices.push(lower.voice)

      if (voices.length > 0) {
        const formatter = new Formatter()
        formatter.joinVoices(voices)
        formatter.format(voices, staveW - 40)
      }

      const connector = new StaveConnector(treble, bass)
      connector.setType('brace')

      treble.setContext(ctx).draw()
      bass.setContext(ctx).draw()
      connector.setContext(ctx).draw()

      if (upper.voice !== null) upper.voice.draw(ctx, treble)
      if (lower.voice !== null) lower.voice.draw(ctx, bass)
      for (const tie of [...upper.ties, ...lower.ties]) {
        tie.setContext(ctx).draw()
      }
    }
  }

  private keySpec(measure: Measure): string {
    if (measure.index === 0) {
      const ks = this.score?.displayKeysig
      if (ks !== undefined) {
        const base = SF_TO_KEYSPEC[ks.sf] ?? 'C'
        return ks.mi === 1 ? `${base}m` : base
      }
    }
    // 中间调号变化 M1 不展示：与首小节调号一致（参考谱定位）
    const ks = this.score?.displayKeysig
    if (ks === undefined) return 'C'
    const base = SF_TO_KEYSPEC[ks.sf] ?? 'C'
    return ks.mi === 1 ? `${base}m` : base
  }

  private buildVoice(
    measure: Measure,
    staff: 'upper' | 'lower',
    activeIds: Set<number>,
  ): { voice: Voice | null; ties: StaveTie[] } {
    const score = this.score
    if (score === null) return { voice: null, ties: [] }
    const events = score.events.filter((e) => e.measureIndex === measure.index && e.staff === staff)
    if (events.length === 0) return { voice: null, ties: [] }

    const notes: StaveNote[] = []
    const tickables: StaveNote[] = []
    const ties: StaveTie[] = []

    for (const ev of events) {
      if (ev.rest) {
        const total = ev.pieces.reduce((s, p) => s + p.durationBeats, 0)
        for (const part of mergeRestPieces(total)) {
          const rest = new StaveNote({ keys: ['b/4'], duration: restDuration(part) })
          tickables.push(rest)
        }
        continue
      }
      const pieceNotes: StaveNote[] = []
      for (let i = 0; i < ev.pieces.length; i++) {
        const piece = ev.pieces[i]
        const note = new StaveNote({
          keys: ev.keys.map((k) => `${k.letter.toLowerCase()}/${k.octave}`),
          duration: pieceToDuration(piece.durationBeats),
          autoStem: true,
        })
        if (activeIds.has(ev.id)) {
          note.setStyle({ fillStyle: ACTIVE_FILL, strokeStyle: ACTIVE_STROKE })
        }
        if (i === 0) {
          ev.keys.forEach((k, idx) => {
            if (k.accidental !== '') {
              note.addModifier(new Accidental(k.accidental), idx)
            }
          })
        }
        pieceNotes.push(note)
        tickables.push(note)
        notes.push(note)
      }
      // 延音线连接同一事件的片段
      for (let i = 1; i < pieceNotes.length; i++) {
        const prev = pieceNotes[i - 1]
        const curr = pieceNotes[i]
        const count = Math.min(prev.keys.length, curr.keys.length)
        const indices = Array.from({ length: count }, (_, idx) => idx)
        ties.push(
          new StaveTie({
            firstNote: prev,
            lastNote: curr,
            firstIndexes: indices,
            lastIndexes: [...indices],
          }),
        )
      }
    }

    // 符杠：小节内相邻八分/十六分音符自动组合
    if (notes.length > 0) {
      Beam.generateBeams(notes)
    }

    const voice = new Voice({ numBeats: measure.beatCount, beatValue: 4 })
    voice.setMode(Voice.Mode.SOFT)
    voice.addTickables(tickables)
    return { voice, ties }
  }
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) {
    if (!b.has(v)) return false
  }
  return true
}
