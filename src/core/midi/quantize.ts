import type { Song, TempoEvent, TimeSignatureEvent, KeySignatureEvent } from '../model'

/**
 * MIDI（演奏数据）→ ScoreModel（记谱中间表示）。
 *
 * M1 算法（"参考谱"级，见设计文档 §6.6）：
 * 1. 网格量化：起止时间吸附到 1/8 拍（QUANTIZE_STEP = 0.5 拍）网格；
 * 2. 跨小节拆分：事件在小节边界处断开；
 * 3. 分声部：以 C4（MIDI 60）为界分左右手谱表，同一起音合并为和弦；
 * 4. 时值分解：按拍分解为合法时值（半/四分/八分），跨拍用延音线连接；
 * 5. 拼写：按小节生效调号拼写音名与临时记号；
 * 6. 休止符：声部内空隙折叠为休止符。
 */

/** 量化网格步长（拍，四分之一音符为单位）；0.5 = 八分音符 */
export const QUANTIZE_STEP = 0.5
/** 左右手分界音高 */
export const SPLIT_PITCH = 60
const EPS = 1e-6

export type Accidental = '' | '#' | 'b' | 'n'
export type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'

export interface ScoreKey {
  letter: Letter
  accidental: Accidental
  octave: number
}

/** 一个时值片段（延音线连接的一段） */
export interface ScorePiece {
  /** 小节内起始拍 */
  beatOffset: number
  /** 时值（拍） */
  durationBeats: number
}

export interface NotatedEvent {
  id: number
  /** 量化后起止时间（秒），供播放高亮比对 */
  onsetSec: number
  endSec: number
  staff: 'upper' | 'lower'
  measureIndex: number
  /** 小节内起始拍 */
  beatOffset: number
  /** rest 时 keys 为空 */
  keys: ScoreKey[]
  rest: boolean
  /** 延音线连接的时值片段（≥1） */
  pieces: ScorePiece[]
}

export interface Measure {
  index: number
  startBeat: number
  startSec: number
  endSec: number
  numerator: number
  denominator: number
  /** 小节拍数（四分之一音符单位） */
  beatCount: number
  keysig: { sf: number; mi: 0 | 1 }
}

export interface ScoreModel {
  ppq: number
  durationSec: number
  measures: Measure[]
  events: NotatedEvent[]
  /** 谱面展示用调号（取首个调号事件） */
  displayKeysig: { sf: number; mi: 0 | 1 }
}

interface BeatCurve {
  secToBeat(sec: number): number
  beatToSec(beat: number): number
}

function buildBeatCurve(tempos: TempoEvent[]): BeatCurve {
  const sorted = [...tempos].sort((a, b) => a.time - b.time)
  if (sorted.length === 0) sorted.push({ time: 0, bpm: 120 })
  const points = sorted.map((t) => ({ t: t.time, bpm: Math.max(1, t.bpm) }))
  const acc: { t: number; beat: number; bpm: number }[] = []
  let beat = 0
  for (let i = 0; i < points.length; i++) {
    acc.push({ t: points[i].t, beat, bpm: points[i].bpm })
    if (i + 1 < points.length) {
      beat += ((points[i + 1].t - points[i].t) * points[i].bpm) / 60
    }
  }
  return {
    secToBeat(sec) {
      let i = acc.length - 1
      while (i > 0 && acc[i].t > sec) i--
      const a = acc[i]
      return a.beat + ((sec - a.t) * a.bpm) / 60
    },
    beatToSec(b) {
      let i = acc.length - 1
      while (i > 0 && acc[i].beat > b) i--
      const a = acc[i]
      return a.t + ((b - a.beat) * 60) / a.bpm
    },
  }
}

function activeAt<T extends { time: number }>(events: T[], beat: number, curve: BeatCurve): T {
  let found = events[0]
  for (const e of events) {
    if (curve.secToBeat(e.time) <= beat + EPS) found = e
    else break
  }
  return found
}

function buildMeasures(
  curve: BeatCurve,
  timeSignatures: TimeSignatureEvent[],
  keySignatures: KeySignatureEvent[],
  totalBeats: number,
): Measure[] {
  const sigs = [...timeSignatures].sort((a, b) => a.time - b.time)
  if (sigs.length === 0) sigs.push({ time: 0, numerator: 4, denominator: 4 })
  const keys = [...keySignatures].sort((a, b) => a.time - b.time)
  const fallbackKey = keys[0] ?? { time: 0, sf: 0, mi: 0 as const }

  const measures: Measure[] = []
  let startBeat = 0
  let index = 0
  while (startBeat < totalBeats - EPS && index < 2000) {
    const sig = activeAt(sigs, startBeat, curve)
    const beatCount = (sig.numerator * 4) / sig.denominator
    const endBeat = startBeat + beatCount
    const ks = activeAt(keys.length > 0 ? keys : [fallbackKey], startBeat, curve)
    measures.push({
      index,
      startBeat,
      startSec: curve.beatToSec(startBeat),
      endSec: curve.beatToSec(endBeat),
      numerator: sig.numerator,
      denominator: sig.denominator,
      beatCount,
      keysig: { sf: ks.sf, mi: ks.mi },
    })
    startBeat = endBeat
    index++
  }
  return measures
}

/** 调号升降音集合（音级） */
const SHARP_PCS = [5, 0, 7, 2, 9, 4, 11] // F C G D A E B
const FLAT_PCS = [11, 4, 9, 2, 7, 0, 5] // B E A D G C F
const LETTERS: Letter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const LETTER_PC: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * 按调号拼写音高：返回字母 + 临时记号 + 八度。
 * 规则：调号内自然音无记号；调号内升降音无记号（已由调号覆盖）；
 * 与调号冲突的自然音记 'n'；其余黑键在升号调用 '#、降号调用 'b'。
 */
export function spellPitch(pitch: number, sf: number): ScoreKey {
  const pc = ((pitch % 12) + 12) % 12
  const octave = Math.floor(pitch / 12) - 1
  const sharpSet = new Set(SHARP_PCS.slice(0, Math.max(0, sf)))
  const flatSet = new Set(FLAT_PCS.slice(0, Math.max(0, -sf)))

  // 调号内自然音 / 调号内升降音
  for (const letter of LETTERS) {
    const natural = LETTER_PC[letter]
    const altered = sharpSet.has(natural)
      ? natural + 1
      : flatSet.has(natural)
        ? natural - 1
        : natural
    if (altered === pc) return { letter, accidental: '', octave }
  }
  // 与调号冲突的自然音（例如 G 大调中的 F 还原）
  for (const letter of LETTERS) {
    const natural = LETTER_PC[letter]
    if ((sharpSet.has(natural) || flatSet.has(natural)) && natural === pc) {
      return { letter, accidental: 'n', octave }
    }
  }
  // 其余黑键：升号调拼升、降号调拼降
  if (sf >= 0) {
    const natural = (pc - 1 + 12) % 12
    const letter = LETTERS.find((l) => LETTER_PC[l] === natural) ?? 'C'
    return { letter, accidental: '#', octave }
  }
  const natural = (pc + 1) % 12
  const letter = LETTERS.find((l) => LETTER_PC[l] === natural) ?? 'C'
  return { letter, accidental: 'b', octave }
}

/** 把 [offset, offset+total) 拍分解为合法时值片段（半/四分/八分，跨拍延音线连接） */
function decomposeBeats(offset: number, total: number): ScorePiece[] {
  const pieces: ScorePiece[] = []
  let pos = offset
  let remaining = total
  while (remaining > EPS) {
    if (Math.abs(pos - Math.round(pos)) < EPS && remaining >= 2 - EPS) {
      pieces.push({ beatOffset: pos, durationBeats: 2 })
      pos += 2
      remaining -= 2
      continue
    }
    const nextBeat = Math.floor(pos + EPS) + 1
    const take = Math.min(remaining, nextBeat - pos)
    pieces.push({ beatOffset: pos, durationBeats: take })
    pos += take
    remaining -= take
  }
  return pieces
}

function quantizeNote(start: number, end: number, step: number): { qs: number; qe: number } {
  const qs = Math.max(0, Math.round(start / step) * step)
  const qe = Math.max(qs + step, Math.round(end / step) * step)
  return { qs, qe }
}

export function quantizeToScore(song: Song): ScoreModel {
  const curve = buildBeatCurve(song.tempos)
  const totalBeats = curve.secToBeat(song.duration)
  const measures = buildMeasures(curve, song.timeSignatures, song.keySignatures, totalBeats)

  const displayKeysig =
    song.keySignatures.length > 0
      ? { sf: song.keySignatures[0].sf, mi: song.keySignatures[0].mi }
      : { sf: 0, mi: 0 as const }

  type Segment = {
    pitch: number
    velocity: number
    qs: number
    qe: number
    staff: 'upper' | 'lower'
  }
  const byMeasure: Segment[][] = measures.map(() => [])

  for (const note of song.notes) {
    if (note.pitch < 0 || note.pitch > 127) continue
    const staff: 'upper' | 'lower' = note.pitch >= SPLIT_PITCH ? 'upper' : 'lower'
    const { qs, qe } = quantizeNote(
      curve.secToBeat(note.start),
      curve.secToBeat(note.end),
      QUANTIZE_STEP,
    )
    // 跨小节拆分
    for (const m of measures) {
      const segStart = Math.max(qs, m.startBeat)
      const segEnd = Math.min(qe, m.startBeat + m.beatCount)
      if (segStart < segEnd - EPS) {
        byMeasure[m.index].push({
          pitch: note.pitch,
          velocity: note.velocity,
          qs: segStart,
          qe: segEnd,
          staff,
        })
      }
    }
  }

  const events: NotatedEvent[] = []
  let nextId = 1

  for (const m of measures) {
    for (const staff of ['upper', 'lower'] as const) {
      const segs = byMeasure[m.index]
        .filter((s) => s.staff === staff)
        .sort((a, b) => a.qs - b.qs || a.pitch - b.pitch)

      // 同一起音合并为和弦
      const chords: { qs: number; qe: number; pitches: number[] }[] = []
      for (const s of segs) {
        const last = chords[chords.length - 1]
        if (last !== undefined && Math.abs(last.qs - s.qs) < EPS) {
          last.qe = Math.max(last.qe, s.qe)
          if (!last.pitches.includes(s.pitch)) last.pitches.push(s.pitch)
        } else {
          chords.push({ qs: s.qs, qe: s.qe, pitches: [s.pitch] })
        }
      }

      // 单声部：与前一事件重叠时收紧起点（避免 VexFlow 单声部重叠的非法输入）
      const normalized: { qs: number; qe: number; pitches: number[] }[] = []
      let lastEnd = -1
      for (const c of chords) {
        const qs = Math.max(c.qs, lastEnd)
        const qe = Math.max(qs + QUANTIZE_STEP, c.qe)
        normalized.push({ qs, qe, pitches: c.pitches })
        lastEnd = qe
      }

      // 生成事件
      const staffEvents: NotatedEvent[] = []
      for (const c of normalized) {
        const offset = c.qs - m.startBeat
        const total = c.qe - c.qs
        if (total < QUANTIZE_STEP - EPS) continue
        staffEvents.push({
          id: nextId++,
          onsetSec: curve.beatToSec(c.qs),
          endSec: curve.beatToSec(c.qe),
          staff,
          measureIndex: m.index,
          beatOffset: offset,
          keys: c.pitches.map((p) => spellPitch(p, m.keysig.sf)),
          rest: false,
          pieces: decomposeBeats(offset, total),
        })
      }

      // 休止符：事件空隙折叠
      const restEvents: NotatedEvent[] = []
      let coveredUntil = 0
      for (const e of staffEvents) {
        const gapStart = coveredUntil
        const gapEnd = e.beatOffset
        if (gapEnd - gapStart >= QUANTIZE_STEP - EPS) {
          restEvents.push({
            id: nextId++,
            onsetSec: curve.beatToSec(m.startBeat + gapStart),
            endSec: curve.beatToSec(m.startBeat + gapEnd),
            staff,
            measureIndex: m.index,
            beatOffset: gapStart,
            keys: [],
            rest: true,
            pieces: decomposeBeats(gapStart, gapEnd - gapStart),
          })
        }
        coveredUntil = Math.max(
          coveredUntil,
          e.beatOffset + e.pieces.reduce((s, p) => s + p.durationBeats, 0),
        )
      }
      // 小节尾部空隙的休止符（弱起小节会在开头补休止符，此处补结尾）
      const tail = m.beatCount - coveredUntil
      if (tail >= QUANTIZE_STEP - EPS) {
        restEvents.push({
          id: nextId++,
          onsetSec: curve.beatToSec(m.startBeat + coveredUntil),
          endSec: m.endSec,
          staff,
          measureIndex: m.index,
          beatOffset: coveredUntil,
          keys: [],
          rest: true,
          pieces: decomposeBeats(coveredUntil, tail),
        })
      }
      events.push(...staffEvents, ...restEvents)
    }
  }

  events.sort(
    (a, b) => a.onsetSec - b.onsetSec || (a.staff === b.staff ? 0 : a.staff === 'upper' ? -1 : 1),
  )

  return {
    ppq: song.ppq,
    durationSec: song.duration,
    measures,
    events,
    displayKeysig,
  }
}
