import {
  Accidental,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  Voice,
} from 'vexflow/bravura'
import type { RenderContext } from 'vexflow/bravura'

import type { Measure, NotatedEvent, ScoreModel } from '../core/midi/quantize'
import { beatBounds } from '../core/midi/quantize'
import { el } from './dom'
import type { View } from './store'

const STAFF_TOP_Y = 10
const STAFF_GAP = 100
const BOTTOM_PAD = 100
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

/** 时值（拍）→ VexFlow duration 字符串（含附点） */
function pieceToDuration(beats: number): string {
  if (beats >= 4 - 1e-6) return '1'
  if (beats >= 3 - 1e-6) return '2d'
  if (beats >= 2 - 1e-6) return '2'
  if (beats >= 1.5 - 1e-6) return '4d'
  if (beats >= 1 - 1e-6) return '4'
  if (beats >= 0.75 - 1e-6) return '8d'
  if (beats >= 0.5 - 1e-6) return '8'
  return '16'
}

function restDuration(beats: number): string {
  if (beats >= 4 - 1e-6) return '1r'
  if (beats >= 2 - 1e-6) return '2r'
  if (beats >= 1 - 1e-6) return '4r'
  if (beats >= 0.5 - 1e-6) return '8r'
  return '16r'
}

/** 合并相邻休止符片段为尽量大的合法时值（休止符无需延音线） */
function mergeRestPieces(totalBeats: number): number[] {
  const parts: number[] = []
  let remaining = totalBeats
  for (const size of [4, 2, 1, 0.5, 0.25]) {
    while (remaining >= size - 1e-6) {
      parts.push(size)
      remaining -= size
    }
  }
  if (remaining > 1e-6) parts.push(0.25)
  return parts
}

interface SystemRef {
  div: HTMLDivElement
  rendered: boolean
  dirty: boolean
}

interface StaffRow {
  stave: Stave
  voices: Voice[]
  ties: StaveTie[]
}

/**
 * 五线谱视图（VexFlow 直雕，设计文档 §6.5 / §6）：
 * 多谱表（一轨一谱表，2 轨用 brace、>2 轨用 bracket）+ 调号/拍号 + 谱表内多声部 +
 * 延音线 + 符杠 + 播放高亮 + 自动滚动。
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
  /** 当前系统渲染中：事件 id → 其各时值片段的 StaveNote（跨小节延音线用） */
  private pieceNotesByEvent = new Map<number, StaveNote[]>()
  /** 当前系统渲染中：`小节|谱表` → Stave（半边弧定位用） */
  private staveByMeasureStaff = new Map<string, Stave>()
  /** 额外符号（谱号/调号/拍号）宽度探针缓存 */
  private prefixDeltaCache = new Map<string, number>()

  constructor() {
    this.systemsEl = el('div', { class: 'score__systems' })
    this.scrollEl = el('div', { class: 'score__scroll' }, this.systemsEl)
    this.scrollEl.style.display = 'none'
    this.emptyEl = el(
      'div',
      { class: 'score__empty' },
      el('div', { class: 'score__empty-art' }, '𝄞'),
    )
    this.el = el('div', { class: 'score' }, this.scrollEl, this.emptyEl)

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
    const staffCount = score.staffs.length
    if (staffCount === 0) return

    sys.div.replaceChildren()
    sys.rendered = true
    sys.dirty = false
    this.pieceNotesByEvent.clear()
    this.staveByMeasureStaff.clear()

    const startMeasure = sysIdx * this.measuresPerSystem
    const endMeasure = Math.min(score.measures.length, startMeasure + this.measuresPerSystem)
    if (startMeasure >= endMeasure) return

    const systemHeight = STAFF_TOP_Y + (staffCount - 1) * STAFF_GAP + BOTTOM_PAD
    const renderer = new Renderer(sys.div, Renderer.Backends.SVG)
    renderer.resize(width, systemHeight)
    const ctx = renderer.getContext()
    if (ctx === null) return
    // 记谱墨色：近黑微暖
    ctx.fillStyle = INK
    ctx.strokeStyle = INK

    // 布局：全曲所有小节的「音符区宽度」一致；谱号/调号/拍号等额外符号按 VexFlow
    // 实测宽度单独预留空间，避免行首小节因挤进记谱符号而显得更拥挤
    const columnExtras: number[] = []
    const columnTimeSig: (string | null)[] = []
    const columnKeySig: boolean[] = []
    const columnClef: boolean[] = []
    for (let m = startMeasure; m < endMeasure; m++) {
      const measure = score.measures[m]
      const isSystemStart = m === startMeasure
      const prev = m > 0 ? score.measures[m - 1] : null
      const keyChanged =
        prev !== null &&
        (prev.keysig.sf !== measure.keysig.sf || prev.keysig.mi !== measure.keysig.mi)
      const tsChanged =
        prev !== null &&
        (prev.numerator !== measure.numerator || prev.denominator !== measure.denominator)
      const timeSig = m === 0 || tsChanged ? `${measure.numerator}/${measure.denominator}` : null
      const showKeySig = isSystemStart || keyChanged
      columnClef.push(isSystemStart)
      columnKeySig.push(showKeySig)
      columnTimeSig.push(timeSig)
      let extra = 0
      if (isSystemStart || showKeySig || timeSig !== null) {
        extra = Math.max(
          0,
          ...score.staffs.map((s) =>
            this.probePrefixDelta(
              s.clef,
              showKeySig ? this.keySpec(measure.keysig) : null,
              isSystemStart,
              timeSig,
            ),
          ),
        )
      }
      columnExtras.push(extra)
    }
    const totalExtra = columnExtras.reduce((a, b) => a + b, 0)
    // 小节音距：各小节音符区一致的长度
    const measurePitch = Math.max(120, (width - 30 - totalExtra) / (endMeasure - startMeasure))
    const columns: { x: number; w: number }[] = []
    let accX = 10
    for (let i = 0; i < columnExtras.length; i++) {
      const w = measurePitch + columnExtras[i]
      columns.push({ x: accX, w })
      accX += w
    }

    let systemTop: Stave | null = null
    let systemBottom: Stave | null = null
    const allBeams: Beam[] = []

    for (let m = startMeasure; m < endMeasure; m++) {
      const measure = score.measures[m]
      const col = columns[m - startMeasure]
      const x = col.x
      const staveW = col.w - 4
      const isSystemStart = columnClef[m - startMeasure]
      const showKeySig = columnKeySig[m - startMeasure]
      const timeSig = columnTimeSig[m - startMeasure]

      const rows: StaffRow[] = []

      for (let si = 0; si < staffCount; si++) {
        const stave = new Stave(x, STAFF_TOP_Y + si * STAFF_GAP, staveW)
        stave.setContext(ctx)
        if (isSystemStart) {
          stave.addClef(score.staffs[si].clef)
        }
        if (showKeySig) {
          stave.addKeySignature(this.keySpec(measure.keysig))
        }
        if (timeSig !== null) {
          stave.addTimeSignature(timeSig)
        }

        const voices: Voice[] = []
        const ties: StaveTie[] = []
        const beams: Beam[] = []
        const maxVoice = this.maxVoiceIndex(measure, si)
        for (let vi = 0; vi <= maxVoice; vi++) {
          const r = this.buildVoice(measure, si, vi, this.activeIds, maxVoice > 0)
          if (r.voice !== null) voices.push(r.voice)
          ties.push(...r.ties)
          beams.push(...r.beams)
        }
        if (voices.length > 0) {
          const formatter = new Formatter()
          formatter.joinVoices(voices)
          // 音符区宽度按该小节实际谱号/调号占位计算（行内无谱号时音符区更宽）
          const noteWidth = stave.getNoteEndX() - stave.getNoteStartX()
          formatter.format(voices, noteWidth)
        }
        rows.push({ stave, voices, ties })
        allBeams.push(...beams)
        this.staveByMeasureStaff.set(`${measure.index}|${si}`, stave)
      }

      // 首个小节记录系统顶/底谱表，供系统左端竖线连接符使用
      if (m === startMeasure) {
        systemTop = rows[0].stave
        systemBottom = rows[rows.length - 1].stave
      }

      for (const row of rows) row.stave.draw()
      for (const row of rows) {
        for (const voice of row.voices) voice.draw(ctx, row.stave)
        for (const tie of row.ties) tie.setContext(ctx).draw()
      }
    }

    // 符杠：VexFlow 把成组音符的符干接管到 Beam 上，必须在 voice 之后显式绘制
    for (const beam of allBeams) beam.setContext(ctx).draw()

    // 跨小节延音线：同系统画完整延音线，跨系统画半边弧
    this.drawCrossMeasureTies(ctx, score, startMeasure, endMeasure)

    // 系统左端一条竖线连接所有谱表（每系统一次，而非每小节画连接符）
    if (systemTop !== null && systemBottom !== null) {
      const connector = new StaveConnector(systemTop, systemBottom)
      connector.setType('singleLeft')
      connector.setContext(ctx).draw()
    }
  }

  /**
   * 绘制跨小节延音线。对齐目标在同一系统时用完整 StaveTie；
   * 目标在其它系统（可能尚未渲染）时，出向/入向各画一段到小节线附近的半边弧。
   */
  private drawCrossMeasureTies(
    ctx: RenderContext,
    score: ScoreModel,
    startMeasure: number,
    endMeasure: number,
  ): void {
    const byId = new Map(score.events.map((e) => [e.id, e]))
    const inSystem = (m: number): boolean => m >= startMeasure && m < endMeasure

    for (const ev of score.events) {
      if (ev.tieNext === undefined || !inSystem(ev.measureIndex)) continue
      const srcPieces = this.pieceNotesByEvent.get(ev.id)
      if (srcPieces === undefined || srcPieces.length === 0) continue
      const lastNote = srcPieces[srcPieces.length - 1]
      const stave = this.staveByMeasureStaff.get(`${ev.measureIndex}|${ev.staffIndex}`)
      for (const link of ev.tieNext) {
        const target = byId.get(link.targetId)
        const dstPieces =
          target !== undefined && inSystem(target.measureIndex)
            ? this.pieceNotesByEvent.get(target.id)
            : undefined
        for (let i = 0; i < link.fromKeys.length; i++) {
          if (dstPieces !== undefined && dstPieces.length > 0) {
            const tie = new StaveTie({
              firstNote: lastNote,
              lastNote: dstPieces[0],
              firstIndexes: [link.fromKeys[i]],
              lastIndexes: [link.toKeys[i]],
            })
            tie.setContext(ctx).draw()
          } else if (stave !== undefined) {
            this.drawTieArc(ctx, lastNote, link.fromKeys[i], 'out', stave)
          }
        }
      }
    }

    // 入向半边弧：本系统内带 tiePrev 的起始事件，若来源不在本系统则补画
    for (const ev of score.events) {
      if (ev.tiePrev === undefined || !inSystem(ev.measureIndex)) continue
      const srcPieces = this.pieceNotesByEvent.get(ev.id)
      if (srcPieces === undefined || srcPieces.length === 0) continue
      const stave = this.staveByMeasureStaff.get(`${ev.measureIndex}|${ev.staffIndex}`)
      if (stave === undefined) continue
      for (const srcId of ev.tiePrev) {
        const src = byId.get(srcId)
        if (src === undefined || inSystem(src.measureIndex)) continue
        const link = src.tieNext?.find((l) => l.targetId === ev.id)
        if (link === undefined) continue
        for (const toKey of link.toKeys) {
          this.drawTieArc(ctx, srcPieces[0], toKey, 'in', stave)
        }
      }
    }
  }

  /** 半边延音线弧：从符头到小节线方向画一小段（跨系统时用） */
  private drawTieArc(
    ctx: RenderContext,
    note: StaveNote,
    keyIndex: number,
    side: 'in' | 'out',
    stave: Stave,
  ): void {
    const ys = note.getYs()
    const y = ys[Math.min(keyIndex, ys.length - 1)]
    const stemDir = note.getStemDirection()
    const bend = stemDir === Stem.UP ? 7 : -7 // 符干方向反向弯曲
    const headLeft = note.getNoteHeadBeginX()
    const headRight = headLeft + note.getGlyphWidth()
    let x0: number
    let x1: number
    if (side === 'out') {
      x0 = headRight + 2
      x1 = Math.min(x0 + 26, stave.getX() + stave.getWidth() - 2)
    } else {
      x1 = headLeft - 2
      x0 = Math.max(x1 - 26, stave.getX() + 2)
    }
    const cx = (x0 + x1) / 2
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.quadraticCurveTo(cx, y + bend, x1, y)
    ctx.stroke()
  }

  private maxVoiceIndex(measure: Measure, staffIndex: number): number {
    let mx = -1
    if (this.score === null) return -1
    for (const e of this.score.events) {
      if (e.measureIndex === measure.index && e.staffIndex === staffIndex) {
        if (e.voiceIndex > mx) mx = e.voiceIndex
      }
    }
    return mx
  }

  private keySpec(keysig: { sf: number; mi: 0 | 1 }): string {
    // 一律用关系大调名输出：VexFlow 的小调名按其自身调号定义（'Bbm' = 5 降），
    // 与本项目「sf = 关系大调升降号数量」的语义不同，拼上 'm' 会画错调号
    return SF_TO_KEYSPEC[keysig.sf] ?? 'C'
  }

  /**
   * 实测谱号/调号/拍号在音符区左侧占用的宽度（相对无修饰谱表的增量）。
   * 用同名修饰符构造探针 Stave，比对 getNoteStartX 的偏移量；结果缓存。
   */
  private probePrefixDelta(
    clef: string,
    keySig: string | null,
    withClef: boolean,
    timeSig: string | null,
  ): number {
    const cacheKey = `${clef}|${keySig ?? ''}|${withClef ? 1 : 0}|${timeSig ?? ''}`
    const cached = this.prefixDeltaCache.get(cacheKey)
    if (cached !== undefined) return cached
    const base = new Stave(0, 0, 10).getNoteStartX()
    const stave = new Stave(0, 0, 10)
    if (withClef) stave.addClef(clef)
    if (keySig !== null) stave.addKeySignature(keySig)
    if (timeSig !== null) stave.addTimeSignature(timeSig)
    const delta = stave.getNoteStartX() - base
    this.prefixDeltaCache.set(cacheKey, delta)
    return delta
  }

  private buildVoice(
    measure: Measure,
    staffIndex: number,
    voiceIndex: number,
    activeIds: Set<number>,
    multiVoice: boolean,
  ): { voice: Voice | null; ties: StaveTie[]; beams: Beam[] } {
    const score = this.score
    if (score === null) return { voice: null, ties: [], beams: [] }
    const events = score.events.filter(
      (e) =>
        e.measureIndex === measure.index &&
        e.staffIndex === staffIndex &&
        e.voiceIndex === voiceIndex,
    )
    if (events.length === 0) return { voice: null, ties: [], beams: [] }

    const clef = score.staffs[staffIndex].clef
    const tickables: StaveNote[] = []
    const ties: StaveTie[] = []
    /** 参与符杠分组的音符片段元数据（休止符不参与） */
    const piecesMeta: { note: StaveNote; beatOffset: number; continuation: boolean }[] = []

    for (const ev of events) {
      if (ev.rest) {
        const total = ev.pieces.reduce((s, p) => s + p.durationBeats, 0)
        for (const part of mergeRestPieces(total)) {
          const rest = new StaveNote({ keys: ['b/4'], duration: restDuration(part), clef })
          tickables.push(rest)
        }
        continue
      }
      const pieceNotes: StaveNote[] = []
      for (let i = 0; i < ev.pieces.length; i++) {
        const piece = ev.pieces[i]
        const duration = pieceToDuration(piece.durationBeats)
        const note = new StaveNote({
          keys: ev.keys.map((k) => `${k.letter.toLowerCase()}/${k.octave}`),
          duration,
          clef,
          autoStem: true,
        })
        // VexFlow 只解析 'd' 后缀的时值，附点记号需要显式挂上
        if (duration.endsWith('d')) Dot.buildAndAttach([note], { all: true })
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
        piecesMeta.push({
          note,
          beatOffset: piece.beatOffset,
          continuation: i > 0, // 延音线连接的片段不再参与符杠分组
        })
      }
      // 跨小节延音线/符杠分组要用到片段的 StaveNote 引用
      this.pieceNotesByEvent.set(ev.id, pieceNotes)
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

    // 符杠：按拍分组，同拍内连续的八分/十六分成组；多声部时按声部定符干方向
    const bounds = beatBounds(measure.numerator, measure.denominator)
    const beatIndex = (offset: number): number => {
      let idx = 0
      for (let i = 0; i < bounds.length; i++) {
        if (bounds[i] <= offset + 1e-6) idx = i
      }
      return idx
    }
    const beams: Beam[] = []
    let group: StaveNote[] = []
    let groupBeat = -1
    const flush = (): void => {
      if (group.length >= 2) {
        if (multiVoice) {
          // 多声部惯例：主声部符干朝上，其余朝下
          const dir = voiceIndex === 0 ? Stem.UP : Stem.DOWN
          for (const n of group) n.setStemDirection(dir)
          beams.push(new Beam(group, false))
        } else {
          beams.push(new Beam(group, true))
        }
      }
      group = []
      groupBeat = -1
    }
    for (const pm of piecesMeta) {
      if (!this.isBeamable(pm.note) || pm.continuation) {
        flush()
        continue
      }
      const bi = beatIndex(pm.beatOffset)
      if (group.length > 0 && bi !== groupBeat) flush()
      group.push(pm.note)
      groupBeat = bi
    }
    flush()

    // 多声部：把整声部的符干方向统一（含未成组的八分/四分）
    if (multiVoice) {
      const dir = voiceIndex === 0 ? Stem.UP : Stem.DOWN
      for (const pm of piecesMeta) pm.note.setStemDirection(dir)
    }

    const voice = new Voice({ numBeats: measure.beatCount, beatValue: 4 })
    voice.setMode(Voice.Mode.SOFT)
    voice.addTickables(tickables)
    return { voice, ties, beams }
  }

  /** 是否为可上符杠的时值（八分/十六分，含附点） */
  private isBeamable(note: StaveNote): boolean {
    return note.getBeamCount() >= 1 || /^(8|16)d?$/.test(note.getDuration())
  }
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) {
    if (!b.has(v)) return false
  }
  return true
}
