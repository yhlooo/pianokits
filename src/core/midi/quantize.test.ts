import { describe, expect, it } from 'vitest'

import type { Song } from '../model'
import { QUANTIZE_STEP, quantizeToScore, spellPitch } from './quantize'

function makeSong(
  notes: Array<{ pitch: number; start: number; end: number; velocity?: number }>,
  opts: { sf?: number; mi?: 0 | 1 } = {},
): Song {
  return {
    ppq: 480,
    duration: notes.reduce((m, n) => Math.max(m, n.end), 0),
    tempos: [{ time: 0, bpm: 60 }], // 1 拍 = 1 秒
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    keySignatures: [{ time: 0, sf: opts.sf ?? 0, mi: opts.mi ?? 0 }],
    tracks: [],
    notes: notes.map((n, i) => ({ ...n, velocity: n.velocity ?? 100, trackIndex: i })),
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
  it('4/4、60BPM：两个四分音符 → 2 个小节、4 个事件（含休止符）', () => {
    // 1 拍 = 1 秒；C4 在第 0 拍和第 1 拍各 1 拍
    const song = makeSong([
      { pitch: 60, start: 0, end: 1 },
      { pitch: 62, start: 1, end: 2 },
    ])
    const score = quantizeToScore(song)
    expect(score.measures).toHaveLength(1)
    const notes = score.events.filter((e) => !e.rest)
    expect(notes).toHaveLength(2)
    expect(notes[0].keys[0]).toEqual({ letter: 'C', accidental: '', octave: 4 })
    // 4/4 小节：2 拍音符 + 2 拍休止
    const rests = score.events.filter((e) => e.rest && e.staff === 'upper')
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

  it('以 C4 为界分左右手谱表', () => {
    const song = makeSong([
      { pitch: 48, start: 0, end: 1 }, // C3 → lower
      { pitch: 72, start: 0, end: 1 }, // C5 → upper
    ])
    const score = quantizeToScore(song)
    const lower = score.events.find((e) => !e.rest && e.staff === 'lower')!
    const upper = score.events.find((e) => !e.rest && e.staff === 'upper')!
    expect(lower.keys[0].octave).toBe(3)
    expect(upper.keys[0].octave).toBe(5)
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

  it('量化网格：0.6 秒起点吸附到最近 0.5 拍网格', () => {
    const song = makeSong([{ pitch: 60, start: 0.6, end: 1.6 }])
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    // 0.6 → 0.5；1.6 → 1.5 → 时长 1 拍，beatOffset 0.5
    expect(ev.beatOffset).toBeCloseTo(QUANTIZE_STEP)
    expect(ev.pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(1)
  })
})
