import type {
  Note,
  Song,
  TempoEvent,
  TimeSignatureEvent,
  KeySignatureEvent,
  SustainEvent,
} from '../model'

/**
 * MIDI（演奏数据）→ ScoreModel（记谱中间表示）。
 *
 * M2 算法（见设计文档 docs/development/design/20260905-score-notation.draft1.md）：
 * 1. 踏板延音：用 CC64 延长长音，避免长音被量化切碎成休止符；
 * 2. 网格量化：起止时间吸附到 1/16 拍网格（GRID_STEP = 0.25 拍）；
 * 3. 分谱表：按 MIDI 音轨分组，一轨一谱表；谱号按轨内主音区（时长加权中位数 vs C4）判定；
 * 4. 谱表内分声部：重叠事件分多声部（MAX_VOICES，默认 2、可放宽）；
 * 5. 跨小节拆分：事件在小节边界处断开；
 * 6. 时值分解：按拍分解为合法时值（全/半/四分/八分/十六分），跨拍用延音线连接；
 * 7. 拼写：按小节生效调号拼写音名与临时记号；
 * 8. 休止符：每声部内空隙折叠为休止符。
 */

/** 量化网格步长（拍，四分之一音符为单位）；0.25 = 十六分音符 */
export const GRID_STEP = 0.25
/** treble/bass 谱号分界音高（C4），按轨内主音区（时长加权中位数）比较 */
export const CLEF_PITCH = 60
/** 谱表内声部上限：默认 2，可放宽（设计 §5.3 / Q2，上限 4） */
export const MAX_VOICES = 2
const EPS = 1e-6

export type Accidental = '' | '#' | 'b' | 'n'
export type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'
export type Clef = 'treble' | 'bass'

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

/** 谱表：一轨一谱表，谱号按轨内主音区判定 */
export interface ScoreStaff {
  /** 来源 MIDI 轨道序号（对应 Song.tracks） */
  trackIndex: number
  /** 轨道名（展示用，可空） */
  name: string
  clef: Clef
}

export interface NotatedEvent {
  id: number
  /** 量化后起止时间（秒），供播放高亮比对 */
  onsetSec: number
  endSec: number
  /** 指向 ScoreModel.staffs 下标 */
  staffIndex: number
  /** 谱表内声部序号（0 起，主声部 = 0） */
  voiceIndex: number
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
  /** 谱表列表（一轨一谱表），数组下标即 staffIndex */
  staffs: ScoreStaff[]
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

/**
 * 把 [offset, offset+total) 拍分解为合法时值片段（全/半/四分/八分/十六分，跨拍延音线连接）。
 * 规则：整拍起用尽量长的整拍时值；半拍起可用八分；其余用十六分逐步填。
 */
function decomposeBeats(offset: number, total: number): ScorePiece[] {
  const pieces: ScorePiece[] = []
  let pos = offset
  let remaining = total
  while (remaining > EPS) {
    const onBeat = Math.abs(pos - Math.round(pos)) < EPS
    const onHalf = Math.abs(pos * 2 - Math.round(pos * 2)) < EPS
    let dur: number
    if (onBeat && remaining >= 4 - EPS) dur = 4
    else if (onBeat && remaining >= 2 - EPS) dur = 2
    else if (onBeat && remaining >= 1 - EPS) dur = 1
    else if (onHalf && remaining >= 0.5 - EPS) dur = 0.5
    else dur = 0.25
    pieces.push({ beatOffset: pos, durationBeats: dur })
    pos += dur
    remaining -= dur
  }
  return pieces
}

function quantizeNote(start: number, end: number, step: number): { qs: number; qe: number } {
  const qs = Math.max(0, Math.round(start / step) * step)
  const qe = Math.max(qs + step, Math.round(end / step) * step)
  return { qs, qe }
}

// ---------- 分谱表 ----------

/** 时长加权中位数：累计时长过半处的音高（对极端高低音稳健） */
function durationWeightedMedian(notes: Note[]): number {
  if (notes.length === 0) return CLEF_PITCH
  const sorted = [...notes].sort((a, b) => a.pitch - b.pitch)
  const total = sorted.reduce((s, n) => s + Math.max(0, n.end - n.start), 0)
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)]?.pitch ?? CLEF_PITCH
  let acc = 0
  for (const n of sorted) {
    acc += Math.max(0, n.end - n.start)
    if (acc * 2 >= total) return n.pitch
  }
  return sorted[sorted.length - 1]?.pitch ?? CLEF_PITCH
}

/** 谱号：轨内主要音区 ≥ C4 → treble，否则 bass */
function clefForNotes(notes: Note[]): Clef {
  return durationWeightedMedian(notes) >= CLEF_PITCH ? 'treble' : 'bass'
}

/** 一轨一谱表：过滤打击乐轨与空轨，按文件原始顺序，谱号按轨内主音区判定 */
function buildStaffs(song: Song): ScoreStaff[] {
  const notesByTrack = new Map<number, Note[]>()
  for (const n of song.notes) {
    const arr = notesByTrack.get(n.trackIndex) ?? []
    arr.push(n)
    notesByTrack.set(n.trackIndex, arr)
  }
  const staffs: ScoreStaff[] = []
  for (const t of song.tracks) {
    if (t.percussion || t.noteCount === 0) continue
    staffs.push({
      trackIndex: t.index,
      name: t.name,
      clef: clefForNotes(notesByTrack.get(t.index) ?? []),
    })
  }
  return staffs
}

// ---------- 踏板延音 ----------

interface SustainInterval {
  on: number
  off: number
}

function buildSustainIntervals(events: SustainEvent[]): SustainInterval[] {
  const intervals: SustainInterval[] = []
  let current: SustainInterval | null = null
  for (const e of events) {
    if (e.value >= 64) {
      if (current === null) current = { on: e.time, off: Number.POSITIVE_INFINITY }
    } else if (current !== null) {
      current.off = e.time
      intervals.push(current)
      current = null
    }
  }
  if (current !== null) intervals.push(current)
  return intervals
}

/**
 * 用 CC64 踏板延长音符结束（参考 Magenta applySustainControlChanges 语义）：
 * 踏板踩住期间，note 结束延长到「下一个同音高的 note-on」或「踏板抬起」，二者取先到者。
 */
function extendWithSustain(notes: Note[], events: SustainEvent[]): Note[] {
  if (events.length === 0) return notes
  const intervals = buildSustainIntervals(events)
  if (intervals.length === 0) return notes

  const byPitch = new Map<number, Note[]>()
  for (const n of notes) {
    const arr = byPitch.get(n.pitch) ?? []
    arr.push(n)
    byPitch.set(n.pitch, arr)
  }
  for (const arr of byPitch.values()) arr.sort((a, b) => a.start - b.start)

  return notes.map((n) => {
    for (const iv of intervals) {
      if (iv.on <= n.start + EPS && iv.off > n.start) {
        const samePitch = byPitch.get(n.pitch) ?? []
        let nextOnset = Number.POSITIVE_INFINITY
        for (const m of samePitch) {
          if (m.start > n.start + EPS) {
            nextOnset = m.start
            break
          }
        }
        const cap = Math.min(iv.off, nextOnset)
        if (cap > n.end) return { ...n, end: cap }
        return n
      }
    }
    return n
  })
}

// ---------- 谱表内复调分声部 ----------

interface ChordSeg {
  qs: number
  qe: number
  pitches: number[]
}

/** 重叠 + 贪心分声部：不重叠的归入最早可用声部（主声部优先），重叠则开新声部或并入最近者 */
function assignVoices(
  chords: ChordSeg[],
  maxVoices: number,
): { qs: number; qe: number; pitches: number[]; voiceIndex: number }[] {
  const lastEnds: number[] = []
  const result: { qs: number; qe: number; pitches: number[]; voiceIndex: number }[] = []
  for (const c of chords) {
    let vi = -1
    for (let i = 0; i < lastEnds.length; i++) {
      if (lastEnds[i] <= c.qs + EPS) {
        vi = i
        break
      }
    }
    if (vi === -1) {
      if (lastEnds.length < maxVoices) {
        vi = lastEnds.length
        lastEnds.push(0)
      } else {
        // 超出声部上限：并入结束最早的声部（起点收紧，最小化位移）
        vi = 0
        for (let i = 1; i < lastEnds.length; i++) {
          if (lastEnds[i] < lastEnds[vi]) vi = i
        }
      }
    }
    const qs = Math.max(c.qs, lastEnds[vi])
    const qe = Math.max(qs + GRID_STEP, c.qe)
    result.push({ qs, qe, pitches: c.pitches, voiceIndex: vi })
    lastEnds[vi] = qe
  }
  return result
}

function makeRestEvent(
  m: Measure,
  staffIndex: number,
  voiceIndex: number,
  beatOffset: number,
  total: number,
  curve: BeatCurve,
  nextId: () => number,
): NotatedEvent {
  return {
    id: nextId(),
    onsetSec: curve.beatToSec(m.startBeat + beatOffset),
    endSec: curve.beatToSec(m.startBeat + beatOffset + total),
    staffIndex,
    voiceIndex,
    measureIndex: m.index,
    beatOffset,
    keys: [],
    rest: true,
    pieces: decomposeBeats(beatOffset, total),
  }
}

/** 单声部内空隙折叠为休止符（含小节尾部） */
function buildRests(
  m: Measure,
  staffIndex: number,
  voiceIndex: number,
  noteEvents: NotatedEvent[],
  curve: BeatCurve,
  nextId: () => number,
): NotatedEvent[] {
  const rests: NotatedEvent[] = []
  let coveredUntil = 0
  for (const e of noteEvents) {
    const gapStart = coveredUntil
    const gapEnd = e.beatOffset
    if (gapEnd - gapStart >= GRID_STEP - EPS) {
      rests.push(
        makeRestEvent(m, staffIndex, voiceIndex, gapStart, gapEnd - gapStart, curve, nextId),
      )
    }
    coveredUntil = Math.max(
      coveredUntil,
      e.beatOffset + e.pieces.reduce((s, p) => s + p.durationBeats, 0),
    )
  }
  const tail = m.beatCount - coveredUntil
  if (tail >= GRID_STEP - EPS) {
    rests.push(makeRestEvent(m, staffIndex, voiceIndex, coveredUntil, tail, curve, nextId))
  }
  return rests
}

export function quantizeToScore(song: Song): ScoreModel {
  const curve = buildBeatCurve(song.tempos)
  const totalBeats = curve.secToBeat(song.duration)
  const measures = buildMeasures(curve, song.timeSignatures, song.keySignatures, totalBeats)
  const staffs = buildStaffs(song)
  const staffIndexByTrack = new Map<number, number>()
  staffs.forEach((s, i) => staffIndexByTrack.set(s.trackIndex, i))

  const displayKeysig =
    song.keySignatures.length > 0
      ? { sf: song.keySignatures[0].sf, mi: song.keySignatures[0].mi }
      : { sf: 0, mi: 0 as const }

  const extendedNotes = extendWithSustain(song.notes, song.sustainEvents)

  type Segment = { pitch: number; qs: number; qe: number; staffIndex: number }
  const byMeasure: Segment[][] = measures.map(() => [])

  for (const note of extendedNotes) {
    const staffIndex = staffIndexByTrack.get(note.trackIndex)
    if (staffIndex === undefined) continue
    if (note.pitch < 0 || note.pitch > 127) continue
    const { qs, qe } = quantizeNote(
      curve.secToBeat(note.start),
      curve.secToBeat(note.end),
      GRID_STEP,
    )
    // 跨小节拆分
    for (const m of measures) {
      const segStart = Math.max(qs, m.startBeat)
      const segEnd = Math.min(qe, m.startBeat + m.beatCount)
      if (segStart < segEnd - EPS) {
        byMeasure[m.index].push({ pitch: note.pitch, qs: segStart, qe: segEnd, staffIndex })
      }
    }
  }

  const events: NotatedEvent[] = []
  let nextId = 1
  const nextIdFn = (): number => nextId++

  for (const m of measures) {
    for (let si = 0; si < staffs.length; si++) {
      const segs = byMeasure[m.index]
        .filter((s) => s.staffIndex === si)
        .sort((a, b) => a.qs - b.qs || a.pitch - b.pitch)

      // 同一起音合并为和弦
      const chords: ChordSeg[] = []
      for (const s of segs) {
        const last = chords[chords.length - 1]
        if (last !== undefined && Math.abs(last.qs - s.qs) < EPS) {
          last.qe = Math.max(last.qe, s.qe)
          if (!last.pitches.includes(s.pitch)) last.pitches.push(s.pitch)
        } else {
          chords.push({ qs: s.qs, qe: s.qe, pitches: [s.pitch] })
        }
      }

      // 谱表内复调分声部
      const assigned = assignVoices(chords, MAX_VOICES)
      const byVoice = new Map<number, typeof assigned>()
      for (const a of assigned) {
        const arr = byVoice.get(a.voiceIndex) ?? []
        arr.push(a)
        byVoice.set(a.voiceIndex, arr)
      }

      // 声部 0 始终存在（至少含休止符）；其余声部按实际出现的最高声部号生成
      const maxVoice = assigned.reduce((mx, a) => Math.max(mx, a.voiceIndex), 0)
      for (let vi = 0; vi <= maxVoice; vi++) {
        const noteEvents: NotatedEvent[] = []
        for (const c of byVoice.get(vi) ?? []) {
          const offset = c.qs - m.startBeat
          const total = c.qe - c.qs
          if (total < GRID_STEP - EPS) continue
          noteEvents.push({
            id: nextIdFn(),
            onsetSec: curve.beatToSec(c.qs),
            endSec: curve.beatToSec(c.qe),
            staffIndex: si,
            voiceIndex: vi,
            measureIndex: m.index,
            beatOffset: offset,
            keys: c.pitches.map((p) => spellPitch(p, m.keysig.sf)),
            rest: false,
            pieces: decomposeBeats(offset, total),
          })
        }
        events.push(...noteEvents, ...buildRests(m, si, vi, noteEvents, curve, nextIdFn))
      }
    }
  }

  events.sort(
    (a, b) =>
      a.onsetSec - b.onsetSec ||
      a.staffIndex - b.staffIndex ||
      a.voiceIndex - b.voiceIndex ||
      (a.rest === b.rest ? 0 : a.rest ? 1 : -1),
  )

  return {
    ppq: song.ppq,
    durationSec: song.duration,
    measures,
    staffs,
    events,
    displayKeysig,
  }
}
