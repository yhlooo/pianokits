import { describe, expect, it } from 'vitest'

import type { Song, SustainEvent } from '../model'
import { GRID_STEP, quantizeToScore, spellPitch } from './quantize'

interface NoteSpec {
  pitch: number
  start: number
  end: number
  velocity?: number
  trackIndex?: number
}

function makeSong(
  notes: NoteSpec[],
  opts: { sf?: number; mi?: 0 | 1; sustainEvents?: SustainEvent[] } = {},
): Song {
  const trackOf = (n: NoteSpec): number => n.trackIndex ?? 0
  const indices = [...new Set(notes.map(trackOf))].sort((a, b) => a - b)
  const tracks = indices.map((i) => ({
    index: i,
    name: `Track ${i + 1}`,
    channel: 0,
    instrument: 0,
    percussion: false,
    noteCount: notes.filter((n) => trackOf(n) === i).length,
  }))
  return {
    ppq: 480,
    duration: notes.reduce((m, n) => Math.max(m, n.end), 0),
    tempos: [{ time: 0, bpm: 60 }], // 1 拍 = 1 秒
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    keySignatures: [{ time: 0, sf: opts.sf ?? 0, mi: opts.mi ?? 0 }],
    tracks,
    notes: notes.map((n) => ({
      pitch: n.pitch,
      start: n.start,
      end: n.end,
      velocity: n.velocity ?? 100,
      trackIndex: trackOf(n),
    })),
    sustainEvents: opts.sustainEvents ?? [],
  }
}

describe('spellPitch', () => {
  it('C 大调：白键无记号，黑键记升号', () => {
    expect(spellPitch(60, 0)).toEqual({ letter: 'C', accidental: '', octave: 4 })
    expect(spellPitch(61, 0)).toEqual({ letter: 'C', accidental: '#', octave: 4 })
    expect(spellPitch(58, 0)).toEqual({ letter: 'A', accidental: '#', octave: 3 })
  })

  it('G 大调：调号内升音无记号，F 还原记 n', () => {
    expect(spellPitch(66, 1)).toEqual({ letter: 'F', accidental: '', octave: 4 }) // F#
    expect(spellPitch(65, 1)).toEqual({ letter: 'F', accidental: 'n', octave: 4 }) // F 还原
    expect(spellPitch(67, 1)).toEqual({ letter: 'G', accidental: '', octave: 4 })
  })

  it('F 大调：降号拼写', () => {
    expect(spellPitch(58, -1)).toEqual({ letter: 'B', accidental: '', octave: 3 }) // Bb
    expect(spellPitch(59, -1)).toEqual({ letter: 'B', accidental: 'n', octave: 3 }) // B 还原
    expect(spellPitch(61, -1)).toEqual({ letter: 'D', accidental: 'b', octave: 4 }) // Db
  })
})

describe('quantizeToScore', () => {
  it('4/4、60BPM：两个四分音符 → 1 个小节、2 个音符 + 2 拍休止', () => {
    const song = makeSong([
      { pitch: 60, start: 0, end: 1 },
      { pitch: 62, start: 1, end: 2 },
    ])
    const score = quantizeToScore(song)
    expect(score.measures).toHaveLength(1)
    const notes = score.events.filter((e) => !e.rest)
    expect(notes).toHaveLength(2)
    expect(notes[0].keys[0]).toEqual({ letter: 'C', accidental: '', octave: 4 })
    const rests = score.events.filter((e) => e.rest && e.staffIndex === 0)
    expect(
      rests.reduce((s, e) => s + e.pieces.reduce((a, p) => a + p.durationBeats, 0), 0),
    ).toBeCloseTo(2)
  })

  it('跨拍长音拆分为延音线连接的片段', () => {
    // 1.5 拍长音从第 0 拍开始：0~1 拍(四分) + 1~1.5 拍(八分) 两片段
    const song = makeSong([{ pitch: 60, start: 0, end: 1.5 }])
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    expect(ev.pieces).toHaveLength(2)
    expect(ev.pieces[0]).toEqual({ beatOffset: 0, durationBeats: 1 })
    expect(ev.pieces[1]).toEqual({ beatOffset: 1, durationBeats: 0.5 })
  })

  it('跨小节音符在小节边界断开', () => {
    // 第 3 拍开始长 2 拍 → 横跨小节线，拆成两个事件
    const song = makeSong([{ pitch: 60, start: 3, end: 5 }])
    const score = quantizeToScore(song)
    expect(score.measures).toHaveLength(2)
    const notes = score.events.filter((e) => !e.rest)
    expect(notes).toHaveLength(2)
    expect(notes[0].measureIndex).toBe(0)
    expect(notes[1].measureIndex).toBe(1)
    expect(notes[0].pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(1)
    expect(notes[1].pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(1)
  })

  it('同一起音合并为和弦', () => {
    const song = makeSong([
      { pitch: 60, start: 0, end: 1 },
      { pitch: 64, start: 0, end: 1 },
      { pitch: 67, start: 0, end: 1 },
    ])
    const score = quantizeToScore(song)
    const chords = score.events.filter((e) => !e.rest)
    expect(chords).toHaveLength(1)
    expect(chords[0].keys).toHaveLength(3)
  })

  it('量化网格：0.6 拍起点吸附到最近 0.25 拍网格', () => {
    const song = makeSong([{ pitch: 60, start: 0.6, end: 1.6 }])
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    // 0.6 → 0.5；1.6 → 1.5 → 时长 1 拍，beatOffset 0.5
    expect(ev.beatOffset).toBeCloseTo(0.5)
    expect(ev.pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(1)
  })

  it('十六分音符网格：0.25 拍时值可被记谱', () => {
    const song = makeSong([{ pitch: 60, start: 0.25, end: 0.5 }])
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    expect(ev.beatOffset).toBeCloseTo(0.25)
    expect(ev.pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(GRID_STEP)
  })

  it('按音轨分谱表：两轨 → 两谱表，谱号按主音区', () => {
    const song = makeSong([
      { pitch: 48, start: 0, end: 1, trackIndex: 0 }, // C3 低音轨
      { pitch: 72, start: 0, end: 1, trackIndex: 1 }, // C5 高音轨
    ])
    const score = quantizeToScore(song)
    expect(score.staffs).toHaveLength(2)
    expect(score.staffs[0]).toMatchObject({ trackIndex: 0, clef: 'bass' })
    expect(score.staffs[1]).toMatchObject({ trackIndex: 1, clef: 'treble' })
    const low = score.events.find((e) => !e.rest && e.staffIndex === 0)!
    const high = score.events.find((e) => !e.rest && e.staffIndex === 1)!
    expect(low.keys[0].octave).toBe(3)
    expect(high.keys[0].octave).toBe(5)
  })

  it('谱号按主音区判定：短促高音不翻转低音轨谱号', () => {
    const song = makeSong([
      { pitch: 40, start: 0, end: 0.5 },
      { pitch: 45, start: 0.5, end: 1 },
      { pitch: 50, start: 1, end: 1.5 },
      { pitch: 90, start: 1.5, end: 1.6 }, // 短促高音，时长加权后不占主导
    ])
    const score = quantizeToScore(song)
    expect(score.staffs[0].clef).toBe('bass')
  })

  it('复调分声部：同轨内重叠的持续低音与旋律分两个声部', () => {
    const song = makeSong([
      { pitch: 60, start: 0, end: 4, trackIndex: 0 }, // 持续低音 C4（4 拍）
      { pitch: 72, start: 0.5, end: 1, trackIndex: 0 }, // 上方旋律，与低音重叠
      { pitch: 74, start: 1, end: 1.5, trackIndex: 0 },
      { pitch: 76, start: 1.5, end: 2, trackIndex: 0 },
    ])
    const score = quantizeToScore(song)
    const voices = new Set(score.events.filter((e) => !e.rest).map((e) => e.voiceIndex))
    expect(voices.has(0)).toBe(true)
    expect(voices.has(1)).toBe(true)
  })

  it('踏板延音：长音延长到踏板抬起，不被切碎', () => {
    const song = makeSong([{ pitch: 60, start: 0, end: 0.25 }], {
      sustainEvents: [
        { time: 0, value: 127 },
        { time: 2, value: 0 },
      ],
    })
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    expect(ev.pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(2)
  })

  it('过滤打击乐轨与空轨', () => {
    const song = makeSong([{ pitch: 60, start: 0, end: 1, trackIndex: 0 }])
    song.tracks = [
      { index: 0, name: 'R', channel: 0, instrument: 0, percussion: false, noteCount: 1 },
      { index: 1, name: 'Drums', channel: 9, instrument: 0, percussion: true, noteCount: 5 },
      { index: 2, name: 'Empty', channel: 0, instrument: 0, percussion: false, noteCount: 0 },
    ]
    const score = quantizeToScore(song)
    expect(score.staffs).toHaveLength(1)
    expect(score.staffs[0].trackIndex).toBe(0)
  })
})
