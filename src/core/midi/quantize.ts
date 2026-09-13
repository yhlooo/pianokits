import type { Note, Song, TempoEvent, TimeSignatureEvent } from '../model'
import { estimateKey, ESTIMATE_OVERRIDE_CONFIDENCE, type KeyEstimate } from './key-detect'
import { soundingEndsUnderSustain } from './pedals'

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

/** 跨小节延音线：从本事件最后一个片段跨到目标事件第一个片段 */
export interface TieLink {
  /** 目标事件 id（同谱表、下个小节开头） */
  targetId: number
  /** 本事件 keys 中参与延音线的下标 */
  fromKeys: number[]
  /** 目标事件 keys 中参与延音线的下标（与 fromKeys 对齐） */
  toKeys: number[]
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
  /** 跨小节延音线（来源音符跨小节拆分） */
  tieNext?: TieLink[]
  /** 跨小节延音线的来源事件 id（渲染反向半边弧用） */
  tiePrev?: number[]
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

/**
 * 拍号 → 节奏/符杠分组的拍边界（小节偏移，单位：四分音符拍）。
 * 简单拍按拍均等划分；复合拍（x/8，分子为 3 的倍数）每 3 个八分一组；
 * 不规则拍 5/8、7/8 按 3+2、2+2+3 惯例。
 */
export function beatBounds(numerator: number, denominator: number): number[] {
  if (denominator === 8) {
    if (numerator % 3 === 0) {
      const bounds: number[] = []
      for (let i = 0; i <= numerator; i += 3) bounds.push(i / 2)
      return bounds
    }
    if (numerator === 5) return [0, 1.5, 2.5]
    if (numerator === 7) return [0, 1, 2, 3.5]
  }
  const beats = (numerator * 4) / denominator
  const unit = 4 / denominator
  const bounds: number[] = []
  for (let b = 0; b <= beats + EPS; b += unit) bounds.push(b)
  return bounds
}

function buildMeasures(
  curve: BeatCurve,
  timeSignatures: TimeSignatureEvent[],
  keysig: { sf: number; mi: 0 | 1 },
  totalBeats: number,
): Measure[] {
  const sigs = [...timeSignatures].sort((a, b) => a.time - b.time)
  if (sigs.length === 0) sigs.push({ time: 0, numerator: 4, denominator: 4 })

  const measures: Measure[] = []
  let startBeat = 0
  let index = 0
  while (startBeat < totalBeats - EPS && index < 2000) {
    const sig = activeAt(sigs, startBeat, curve)
    const beatCount = (sig.numerator * 4) / sig.denominator
    const endBeat = startBeat + beatCount
    measures.push({
      index,
      startBeat,
      startSec: curve.beatToSec(startBeat),
      endSec: curve.beatToSec(endBeat),
      numerator: sig.numerator,
      denominator: sig.denominator,
      beatCount,
      keysig,
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
 *
 * 匹配优先级（顺序很重要）：
 * 1. **调号内的自然音**（字母的原位音高 == pc）→ 无记号；
 * 2. **调号内的升降音**（该字母被调号升/降后 == pc）→ 显式 `#`/`b`；
 * 3. 与调号冲突的自然音 → `n`；
 * 4. 其余黑键：升号调拼升、降号调拼降。
 *
 * 第 1 步必须优先于第 2 步，且第 2 步必须带上升降号。历史实现把前两个分支写在一起
 * 并且**只返回字母不带记号**，导致调号内的升降音被记成还原音（F 大调里 Bb 记成 B♮、
 * G 大调里 F# 记成 F♮），是**差半音的实际错误**。
 */
export function spellPitch(pitch: number, sf: number): ScoreKey {
  const pc = ((pitch % 12) + 12) % 12
  const octave = Math.floor(pitch / 12) - 1
  const sharpSet = new Set(SHARP_PCS.slice(0, Math.max(0, sf)))
  const flatSet = new Set(FLAT_PCS.slice(0, Math.max(0, -sf)))

  // 1. 调号内的自然音：字母原位即 pc。
  //    若该字母被调号升/降过，则原位音是「还原音」，必须显式写还原记号，
  //    否则乐手会按调号奏成升降音（例如 Bb 大调里的 B♮）。
  for (const letter of LETTERS) {
    const natural = LETTER_PC[letter]
    if (natural === pc) {
      const altered = sharpSet.has(natural) || flatSet.has(natural)
      return { letter, accidental: altered ? 'n' : '', octave }
    }
  }
  // 2. 调号内的升降音：该字母被调号升/降后 == pc
  for (const letter of LETTERS) {
    const natural = LETTER_PC[letter]
    if (sharpSet.has(natural) && natural + 1 === pc) {
      return { letter, accidental: '#', octave }
    }
    if (flatSet.has(natural) && natural - 1 === pc) {
      return { letter, accidental: 'b', octave }
    }
  }
  // 3. 与调号冲突的自然音（例如 G 大调中的 F 还原）
  for (const letter of LETTERS) {
    const natural = LETTER_PC[letter]
    if ((sharpSet.has(natural) || flatSet.has(natural)) && natural === pc) {
      return { letter, accidental: 'n', octave }
    }
  }
  // 4. 其余黑键：升号调拼升、降号调拼降
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
 * 把 [offset, offset+total) 拍分解为合法时值片段（全/附点半/半/附点四分/四分/附点八分/八分/十六分，
 * 跨拍延音线连接）。
 * 规则：
 * - 拍点上优先用尽量长的时值（含附点半/附点四分）；
 * - 附点八分仅当其整体落在本拍内部时采用（附点不越拍点）；
 * - 八分需八分网格对齐；其余用十六分逐步填。
 */
export function decomposeBeats(
  offset: number,
  total: number,
  bounds: readonly number[],
): ScorePiece[] {
  const onBeat = (pos: number): boolean => bounds.some((b) => Math.abs(pos - b) < EPS)
  const nextBeatEnd = (pos: number): number => {
    for (const b of bounds) {
      if (b > pos + EPS) return b
    }
    return pos + 1
  }
  const atEighth = (pos: number): boolean => Math.abs(pos * 2 - Math.round(pos * 2)) < EPS

  const pieces: ScorePiece[] = []
  let pos = offset
  let remaining = total
  while (remaining > EPS) {
    let dur: number
    if (onBeat(pos) && remaining >= 4 - EPS) dur = 4
    else if (onBeat(pos) && remaining >= 3 - EPS) dur = 3
    else if (onBeat(pos) && remaining >= 2 - EPS) dur = 2
    else if (onBeat(pos) && remaining >= 1.5 - EPS) dur = 1.5
    else if (onBeat(pos) && remaining >= 1 - EPS) dur = 1
    else if (remaining >= 0.75 - EPS && pos + 0.75 <= nextBeatEnd(pos) + EPS) dur = 0.75
    else if (atEighth(pos) && remaining >= 0.5 - EPS) dur = 0.5
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

/**
 * 用 CC64 踏板延长音符结束（`core/midi/pedals.ts` 的 `soundingEndsUnderSustain`，与声音链路
 * 同一份语义；设计文档 20260913-pedal-sound-path.md §3.1）：
 * 键抬起时踏板踩着 → 延到踏板抬起（或同音高再次击键，弦被重新击打）；按通道归属。
 */
function extendWithSustain(song: Song): Note[] {
  if (song.pedalEvents.length === 0) return song.notes
  const soundingEnd = soundingEndsUnderSustain(song.notes, song.tracks, song.pedalEvents)
  const extended = song.notes.map((n, i) =>
    soundingEnd[i] > n.end + EPS ? { ...n, end: soundingEnd[i] } : n,
  )
  // 踏板把音延到踏板抬起，但**不得越过同轨的下一个起音**：演奏者已经弹下一个音了，
  // 记谱上该音就到此为止。否则会造出源数据里根本不存在的重叠——实测某曲右手 16 个
  // 干净的八分音符因此被压成 13 个碎片、音高序列错乱（见
  // docs/development/research/20260913-score-render-diagnosis.md §8）。
  // 真正的持续低音（同轨后续起音都还在它后面）不受影响。
  const nextOnset = new Map<Note, number>()
  const byTrack = new Map<number, Note[]>()
  for (const n of song.notes) {
    let arr = byTrack.get(n.trackIndex)
    if (arr === undefined) {
      arr = []
      byTrack.set(n.trackIndex, arr)
    }
    arr.push(n)
  }
  for (const arr of byTrack.values()) {
    const onsets = [...new Set(arr.map((n) => n.start))].sort((a, b) => a - b)
    for (const n of arr) {
      let k = 0
      while (k < onsets.length && onsets[k] <= n.start + EPS) k++
      if (onsets[k] !== undefined) nextOnset.set(n, onsets[k])
    }
  }
  for (let i = 0; i < extended.length; i++) {
    const limit = nextOnset.get(song.notes[i])
    if (limit !== undefined && limit < extended[i].end) extended[i] = { ...extended[i], end: limit }
  }
  return extended
}

// ---------- 时值规整与连奏合并 ----------

/**
 * 量化前的时值规整：**起音可信、时长不可信**。
 *
 * 现实中导出的 MIDI（尤其从打谱软件或钢琴卷帘导出的）常常把每个音的时长统一写短
 * 一点点，例如本该 0.25 拍（八分）写成 0.235 拍、0.5 拍（四分）写成 0.473 拍——
 * 实测某曲 450 个音是 0.235、271 个是 0.473，**但起音间隔是干净的** 0.25/0.5 拍。
 * 这种「时长略短于起音间隔」的写法会让量化后的每个音都多跨出 0.015 拍而与下一个音
 * 重叠，进而被拆成「附点八分 + 十六分」的延音线碎片、并被 `assignVoices` 劈成两个声部，
 * 谱面因此满屏连线（见 `docs/development/research/20260913-score-render-diagnosis.md`）。
 *
 * 因此按同轨的下一个起音截断时长：`end = min(end, 下一个起音)`。
 * - 时长略超过起音间隔 → 收到间隔上，得到干净的时值；
 * - 时长本身较短（断奏/顿音）→ 保留原时长，不受影响；
 * - 与下一个音同起点（和弦）→ `gap <= EPS`，跳过，绝不改动和弦内各音。
 *
 * 截断之后，再由 `mergeLegatoFragments` 合并「note-off + 紧邻 note-on」造成的同音碎片。
 */
function clampNoteEndsToNextOnset(notes: Note[], rawEnds: Map<Note, number>): Note[] {
  const byTrack = new Map<number, Note[]>()
  const order: number[] = []
  for (const n of notes) {
    let arr = byTrack.get(n.trackIndex)
    if (arr === undefined) {
      arr = []
      byTrack.set(n.trackIndex, arr)
      order.push(n.trackIndex)
    }
    arr.push(n)
  }
  for (const trackIndex of order) {
    const arr = (byTrack.get(trackIndex) ?? []).sort(
      (a, b) => a.start - b.start || a.pitch - b.pitch,
    )
    const onsets = [...new Set(arr.map((n) => n.start))].sort((a, b) => a - b)
    for (const n of arr) {
      let k = 0
      while (k < onsets.length && onsets[k] <= n.start + EPS) k++
      const next = onsets[k]
      // 只截断「被踏板延音拉长、且已经越过下一个起音」的音。
      // 两个条件缺一不可：
      // - `rawEnd < next`：该音按原始时值本来在下一个起音前就结束了，是踏板把它拉长的
      //   （若原始时长本身就比到下一个起音的间隔长，说明是真正的持续低音，与上方走动
      //   声部有意重叠，必须保留原时长交给 `assignVoices` 分声部——否则复调会被压成单声部）；
      // - `next < n.end`：拉长后确实越过了下一个起音。
      // 「原始时长统一略短于起音间隔」的文件里 rawEnd 恰好卡在 next 之前（如 0.235 拍
      // 的八分音符 rawEnd=4.235 < 下一个起音 4.25），因此同样会被截断——这正是我们要的。
      if (next !== undefined && next < n.end && (rawEnds.get(n) ?? n.end) < next) n.end = next
    }
  }
  return notes
}

/**
 * 合并连奏造成的同音碎片：同一轨、同一音高、首尾相接（中间不存在任何量化网格点）的相邻音，
 * 按后者结束时间延长前者。
 *
 * 动机：文件里一个长音常被写成「note-off + 紧邻 note-on」两段（例如
 * `beat 3.750 ON 79 / 3.985 off` + `4.000 ON 79 / 4.235 off` 其实是一个音）。
 * 这类断口在 1/16 网格上会各吸附成独立片段，谱面出现多余延音线。
 *
 * 合并条件（三者同时成立，避免误伤真实的同音反复）：
 * 1. 两段不重叠（`b.start >= a.end`）；
 * 2. b 的结束晚于 a 的结束（合并后确实更长）；
 * 3. b 的起点与 a 的结束吸附到**同一网格点**——这正是「两段之间不存在任何网格点」的
 *    等价条件，也就是量化后本来就无法区分它们。带明确断口的真反复音（例如八分音符
 *    断奏，缝约 0.7 拍、缝里还有网格点）不满足，因而不会被误合并。
 *
 * 输入应为已按踏板延音延长、并做过 `clampNoteEndsToNextOnset` 的音符。
 */
function mergeLegatoFragments(notes: Note[], curve: BeatCurve): Note[] {
  const byTrack = new Map<number, Note[]>()
  const order: number[] = []
  for (const n of notes) {
    let arr = byTrack.get(n.trackIndex)
    if (arr === undefined) {
      arr = []
      byTrack.set(n.trackIndex, arr)
      order.push(n.trackIndex)
    }
    arr.push(n)
  }
  const out: Note[] = []
  const snap = (beat: number): number => Math.round(beat / GRID_STEP) * GRID_STEP
  for (const trackIndex of order) {
    const arr = (byTrack.get(trackIndex) ?? []).sort(
      (a, b) => a.start - b.start || a.pitch - b.pitch,
    )
    let cur: Note | null = null
    for (const n of arr) {
      if (cur === null || n.pitch !== cur.pitch) {
        if (cur !== null) out.push(cur)
        cur = { ...n }
        continue
      }
      const startBeat = curve.secToBeat(n.start)
      if (
        n.start >= cur.end - EPS &&
        n.end > cur.end + EPS &&
        snap(curve.secToBeat(cur.end)) === snap(startBeat)
      ) {
        cur = { ...cur, end: n.end } // 连奏：并入前一个音
        continue
      }
      out.push(cur)
      cur = { ...n }
    }
    if (cur !== null) out.push(cur)
  }
  return out.sort((a, b) => a.start - b.start)
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
    pieces: decomposeBeats(beatOffset, total, beatBounds(m.numerator, m.denominator)),
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

/**
 * 全局调号裁决：优先采用音符内容拟合结果（现实中 MIDI 调号 meta 常为占位值/自相矛盾）；
 * meta 与估计一致时取 meta；估计置信度不足时回落 meta。
 */
function resolveKeysig(song: Song): { sf: number; mi: 0 | 1 } {
  const est: KeyEstimate = estimateKey(song.notes)
  const meta = song.keySignatures[0]
  if (meta === undefined) return { sf: est.sf, mi: est.mi }
  if (meta.sf === est.sf) return { sf: meta.sf, mi: meta.mi }
  if (est.confidence >= ESTIMATE_OVERRIDE_CONFIDENCE) return { sf: est.sf, mi: est.mi }
  return { sf: meta.sf, mi: meta.mi }
}

/**
 * 跨小节延音线标记：同一来源音符在小节边界被拆成相邻两个事件时，
 * 在前一事件记 tieNext、后一事件记 tiePrev，渲染端据此画延音线/半边弧。
 */
function markCrossMeasureTies(events: NotatedEvent[], measures: Measure[]): void {
  // 各谱表中「从小节第 0 拍开始」的音符事件，按 谱表|小节 索引
  const startMap = new Map<string, NotatedEvent[]>()
  for (const ev of events) {
    if (ev.rest || Math.abs(ev.beatOffset) > EPS) continue
    const k = `${ev.staffIndex}|${ev.measureIndex}`
    const arr = startMap.get(k) ?? []
    arr.push(ev)
    startMap.set(k, arr)
  }
  const used = new Set<string>() // `${eventId}|${keyIndex}` 防重复
  for (const ev of events) {
    if (ev.rest) continue
    const m = measures[ev.measureIndex]
    const endOff = ev.beatOffset + ev.pieces.reduce((s, p) => s + p.durationBeats, 0)
    if (Math.abs(endOff - m.beatCount) > EPS) continue
    const candidates = [...(startMap.get(`${ev.staffIndex}|${ev.measureIndex + 1}`) ?? [])].sort(
      (a, b) => Math.abs(a.voiceIndex - ev.voiceIndex) - Math.abs(b.voiceIndex - ev.voiceIndex),
    )
    for (let i = 0; i < ev.keys.length; i++) {
      if (used.has(`${ev.id}|${i}`)) continue
      const k = ev.keys[i]
      for (const nx of candidates) {
        const j = nx.keys.findIndex(
          (kk, jj) =>
            !used.has(`${nx.id}|${jj}`) &&
            kk.letter === k.letter &&
            kk.octave === k.octave &&
            kk.accidental === k.accidental,
        )
        if (j < 0) continue
        used.add(`${ev.id}|${i}`)
        used.add(`${nx.id}|${j}`)
        let link = (ev.tieNext ?? []).find((l) => l.targetId === nx.id)
        if (link === undefined) {
          link = { targetId: nx.id, fromKeys: [], toKeys: [] }
          ev.tieNext = [...(ev.tieNext ?? []), link]
        }
        link.fromKeys.push(i)
        link.toKeys.push(j)
        nx.tiePrev = [...(nx.tiePrev ?? []), ev.id]
        break
      }
    }
  }
}

export function quantizeToScore(song: Song): ScoreModel {
  const curve = buildBeatCurve(song.tempos)
  const totalBeats = curve.secToBeat(song.duration)
  const keysig = resolveKeysig(song)
  const measures = buildMeasures(curve, song.timeSignatures, keysig, totalBeats)
  const staffs = buildStaffs(song)
  const staffIndexByTrack = new Map<number, number>()
  staffs.forEach((s, i) => staffIndexByTrack.set(s.trackIndex, i))

  const displayKeysig = keysig

  // 踏板延音前的原始末端：用于区分「被延音拉长」与「本来就是长音」
  const rawEnds = new Map(song.notes.map((n) => [n, n.end]))
  const extendedNotes = mergeLegatoFragments(
    clampNoteEndsToNextOnset(extendWithSustain(song), rawEnds),
    curve,
  )

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
            pieces: decomposeBeats(offset, total, beatBounds(m.numerator, m.denominator)),
          })
        }
        events.push(...noteEvents, ...buildRests(m, si, vi, noteEvents, curve, nextIdFn))
      }
    }
  }

  markCrossMeasureTies(events, measures)

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
