import { describe, expect, it } from 'vitest'

import type { PedalEvent, Song } from '../model'
import { beatBounds, GRID_STEP, decomposeBeats, quantizeToScore, spellPitch } from './quantize'

interface NoteSpec {
  pitch: number
  start: number
  end: number
  velocity?: number
  trackIndex?: number
}

function makeSong(
  notes: NoteSpec[],
  opts: { sf?: number; mi?: 0 | 1; pedalEvents?: PedalEvent[]; noKeySig?: boolean } = {},
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
    keySignatures: opts.noKeySig === true ? [] : [{ time: 0, sf: opts.sf ?? 0, mi: opts.mi ?? 0 }],
    tracks,
    notes: notes.map((n) => ({
      pitch: n.pitch,
      start: n.start,
      end: n.end,
      velocity: n.velocity ?? 100,
      trackIndex: trackOf(n),
    })),
    pedalEvents: opts.pedalEvents ?? [],
  }
}

describe('spellPitch', () => {
  it('C 大调：白键无记号，黑键记升号', () => {
    expect(spellPitch(60, 0)).toEqual({ letter: 'C', accidental: '', octave: 4 })
    expect(spellPitch(61, 0)).toEqual({ letter: 'C', accidental: '#', octave: 4 })
    expect(spellPitch(58, 0)).toEqual({ letter: 'A', accidental: '#', octave: 3 })
  })

  it('G 大调：调号内升音带升号，F 还原记 n', () => {
    expect(spellPitch(66, 1)).toEqual({ letter: 'F', accidental: '#', octave: 4 }) // F#
    expect(spellPitch(65, 1)).toEqual({ letter: 'F', accidental: 'n', octave: 4 }) // F 还原
    expect(spellPitch(67, 1)).toEqual({ letter: 'G', accidental: '', octave: 4 })
  })

  it('F 大调：降号拼写', () => {
    expect(spellPitch(58, -1)).toEqual({ letter: 'B', accidental: 'b', octave: 3 }) // Bb
    expect(spellPitch(59, -1)).toEqual({ letter: 'B', accidental: 'n', octave: 3 }) // B 还原
    expect(spellPitch(61, -1)).toEqual({ letter: 'D', accidental: 'b', octave: 4 }) // Db
  })

  // 回归：调号内的升降音曾被记成还原音（只返回字母、不带记号），是差半音的实际错误。
  // 见 docs/development/research/20260913-score-render-diagnosis.md §8
  it('回归：调号内升降音必须带升降号，不能被记成还原音', () => {
    // 两个降号：Bb、Eb 属于调号
    expect(spellPitch(70, -2)).toEqual({ letter: 'B', accidental: 'b', octave: 4 }) // Bb4
    expect(spellPitch(82, -2)).toEqual({ letter: 'B', accidental: 'b', octave: 5 }) // Bb5
    expect(spellPitch(63, -2)).toEqual({ letter: 'E', accidental: 'b', octave: 4 }) // Eb4
    // 还原音必须显式写还原记号，否则会被按调号奏成升降音
    expect(spellPitch(71, -2)).toEqual({ letter: 'B', accidental: 'n', octave: 4 })
    expect(spellPitch(64, -2)).toEqual({ letter: 'E', accidental: 'n', octave: 4 })
    // 升号调同理
    expect(spellPitch(66, 2)).toEqual({ letter: 'F', accidental: '#', octave: 4 })
    expect(spellPitch(61, 2)).toEqual({ letter: 'C', accidental: '#', octave: 4 })
  })

  it('回归：拼写出的音名必须还原为原音高（全调号 × 全音高往返）', () => {
    const pcOf = (k: { letter: string; accidental: string; octave: number }): number => {
      const L: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
      const acc = k.accidental === '#' ? 1 : k.accidental === 'b' ? -1 : 0
      return (L[k.letter] + acc + 12) % 12
    }
    for (let sf = -7; sf <= 7; sf++) {
      for (let pitch = 21; pitch <= 108; pitch++) {
        const k = spellPitch(pitch, sf)
        expect(pcOf(k), `sf=${sf} pitch=${pitch} → ${k.letter}${k.accidental}${k.octave}`).toBe(
          pitch % 12,
        )
      }
    }
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

  it('1.5 拍长音 → 单一附点四分片段（不再拆延音线）', () => {
    const song = makeSong([{ pitch: 60, start: 0, end: 1.5 }])
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    expect(ev.pieces).toEqual([{ beatOffset: 0, durationBeats: 1.5 }])
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
      pedalEvents: [
        { time: 0, controller: 64, value: 127, trackIndex: 0, channel: 0 },
        { time: 2, controller: 64, value: 0, trackIndex: 0, channel: 0 },
      ],
    })
    const score = quantizeToScore(song)
    const ev = score.events.find((e) => !e.rest)!
    expect(ev.pieces.reduce((s, p) => s + p.durationBeats, 0)).toBeCloseTo(2)
  })

  it('踏板延音：起点在踏板踩下之前的音，只要键在踏板踩着时抬起也延长（Magenta 语义）', () => {
    // 旧实现按「音符起点是否在踏板区间内」判定，会漏掉这一形态；现按「键抬起时是否踩着」判定
    const song = makeSong([{ pitch: 60, start: 0, end: 0.25 }], {
      pedalEvents: [
        { time: 0.1, controller: 64, value: 127, trackIndex: 0, channel: 0 },
        { time: 2, controller: 64, value: 0, trackIndex: 0, channel: 0 },
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

  it('全局调号：G 小调内容且无 meta → sf=-2（写进每个小节与 displayKeysig）', () => {
    // G 小调音阶内容：G4 A4 Bb4 C5 D5 Eb5 F5
    const pcs = [67, 69, 70, 72, 74, 75, 77]
    const song = makeSong(
      pcs.flatMap((p, i) => [
        { pitch: p, start: i * 0.5, end: i * 0.5 + 0.45 },
        { pitch: p, start: 4 + i * 0.5, end: 4 + i * 0.5 + 0.45 },
      ]),
      { noKeySig: true },
    )
    const score = quantizeToScore(song)
    expect(score.measures[0].keysig.sf).toBe(-2)
    expect(score.displayKeysig.sf).toBe(-2)
    // Bb 在 -2 调号下拼写为 B + 降号（音高必须能被还原出来）
    const bb = score.events.find((e) => !e.rest && e.keys[0].letter === 'B')
    expect(bb).toBeDefined()
    expect(bb!.keys[0].accidental).toBe('b')
  })

  it('估计与 meta 冲突：meta 说 C、内容却是 G 小调 → 估计覆盖（高置信度）', () => {
    const pcs = [67, 69, 70, 72, 74, 75, 77]
    const song = makeSong(
      pcs.flatMap((p, i) => [
        { pitch: p, start: i * 0.5, end: i * 0.5 + 0.45 },
        { pitch: p, start: 4 + i * 0.5, end: 4 + i * 0.5 + 0.45 },
      ]),
      { sf: 0, mi: 0 },
    )
    const score = quantizeToScore(song)
    expect(score.measures[0].keysig.sf).toBe(-2)
  })

  it('估计置信度不足时回落 meta：全白键内容 + meta=Ab → 遵循 meta', () => {
    const song = makeSong(
      [60, 62, 64, 65, 67, 69, 71].map((p, i) => ({ pitch: p, start: i, end: i + 0.9 })),
      { sf: -4, mi: 0 },
    )
    const score = quantizeToScore(song)
    expect(score.measures[0].keysig.sf).toBe(-4)
  })

  it('跨小节延音线：横跨小节线的音符标记 tieNext/tiePrev', () => {
    // 60 BPM：1 秒 = 1 拍；第 3 拍开始长 2 拍 → 跨小节，且 C6 和弦部分延续
    const song = makeSong([
      { pitch: 60, start: 3, end: 6 },
      { pitch: 64, start: 3, end: 6 },
      { pitch: 67, start: 3, end: 4 },
    ])
    const score = quantizeToScore(song)
    const ev0 = score.events.find((e) => !e.rest && e.measureIndex === 0)!
    const ev1 = score.events.find((e) => !e.rest && e.measureIndex === 1)!
    expect(ev0.tieNext).toBeDefined()
    const link = ev0.tieNext!.find((l) => l.targetId === ev1.id)
    expect(link).toBeDefined()
    // C(60)、E(64) 跨小节延续，G(67) 不延续
    expect(link!.fromKeys.sort()).toEqual([0, 1])
    expect(link!.toKeys.sort()).toEqual([0, 1])
    expect(ev1.tiePrev).toContain(ev0.id)
  })
})

describe('beatBounds', () => {
  it('常见拍号的拍边界', () => {
    expect(beatBounds(4, 4)).toEqual([0, 1, 2, 3, 4])
    expect(beatBounds(3, 4)).toEqual([0, 1, 2, 3])
    expect(beatBounds(2, 2)).toEqual([0, 2, 4])
    expect(beatBounds(6, 8)).toEqual([0, 1.5, 3])
    expect(beatBounds(3, 8)).toEqual([0, 1.5])
    expect(beatBounds(5, 8)).toEqual([0, 1.5, 2.5])
    expect(beatBounds(7, 8)).toEqual([0, 1, 2, 3.5])
  })
})

describe('decomposeBeats（附点）', () => {
  const bounds44 = beatBounds(4, 4)

  it('附点八分：起于拍点', () => {
    expect(decomposeBeats(0, 0.75, bounds44)).toEqual([{ beatOffset: 0, durationBeats: 0.75 }])
  })

  it('附点八分：起于十六分位、收于拍点', () => {
    expect(decomposeBeats(0.25, 0.75, bounds44)).toEqual([
      { beatOffset: 0.25, durationBeats: 0.75 },
    ])
  })

  it('起于八分位的 0.75 拍若越过拍点 → 八分 + 十六分延音线', () => {
    expect(decomposeBeats(0.5, 0.75, bounds44)).toEqual([
      { beatOffset: 0.5, durationBeats: 0.5 },
      { beatOffset: 1, durationBeats: 0.25 },
    ])
  })

  it('附点四分：起于拍点的 1.5 拍', () => {
    expect(decomposeBeats(1, 1.5, bounds44)).toEqual([{ beatOffset: 1, durationBeats: 1.5 }])
  })

  it('附点半音符：起于拍点的 3 拍', () => {
    expect(decomposeBeats(0, 3, bounds44)).toEqual([{ beatOffset: 0, durationBeats: 3 }])
  })

  it('3/8：整小节 1.5 拍 → 附点四分', () => {
    expect(decomposeBeats(0, 1.5, beatBounds(3, 8))).toEqual([
      { beatOffset: 0, durationBeats: 1.5 },
    ])
  })

  it('0.25 拍仍落十六分', () => {
    expect(decomposeBeats(0.5, 0.25, bounds44)).toEqual([{ beatOffset: 0.5, durationBeats: 0.25 }])
  })
})

describe('时值规整：连奏合并与踏板不越界', () => {
  it('同一音被写成「note-off + 紧邻 note-on」两段 → 合并为一个音', () => {
    const song = makeSong([
      { pitch: 79, start: 0, end: 0.2354 },
      { pitch: 79, start: 0.25, end: 0.4854 },
    ])
    const notes = quantizeToScore(song).events.filter((e) => !e.rest)
    expect(notes).toHaveLength(1)
    const total = notes[0].pieces.reduce((s, p) => s + p.durationBeats, 0)
    expect(total).toBe(0.5)
  })

  it('有明确断口的同音反复（断奏）→ 不合并', () => {
    const song = makeSong([
      { pitch: 60, start: 0, end: 0.5 },
      { pitch: 60, start: 1, end: 1.5 },
    ])
    expect(quantizeToScore(song).events.filter((e) => !e.rest)).toHaveLength(2)
  })

  it('音高不同 → 不合并', () => {
    const song = makeSong([
      { pitch: 60, start: 0, end: 0.2354 },
      { pitch: 62, start: 0.25, end: 0.4854 },
    ])
    expect(quantizeToScore(song).events.filter((e) => !e.rest)).toHaveLength(2)
  })

  it('不同轨道的同音不合并', () => {
    const song = makeSong([
      { pitch: 60, start: 0, end: 0.2354, trackIndex: 0 },
      { pitch: 60, start: 0.25, end: 0.4854, trackIndex: 1 },
    ])
    expect(quantizeToScore(song).staffs).toHaveLength(2)
    expect(quantizeToScore(song).events.filter((e) => !e.rest)).toHaveLength(2)
  })

  // 回归：踏板把每个音都延到踏板抬起，会造出源数据里不存在的重叠，
  // 使干净的八分音符序列被压成碎片、音高序列错乱（见调查报告 §8）。
  it('踏板延音不得越过同轨的下一个起音', () => {
    const song = makeSong(
      [
        { pitch: 60, start: 0, end: 0.2 },
        { pitch: 62, start: 0.5, end: 0.7 },
        { pitch: 64, start: 1, end: 1.2 },
      ],
      {
        pedalEvents: [
          { time: 0, controller: 64, value: 127, trackIndex: 0, channel: 0 },
          { time: 3, controller: 64, value: 0, trackIndex: 0, channel: 0 },
        ],
      },
    )
    const notes = quantizeToScore(song)
      .events.filter((e) => !e.rest)
      .sort((a, b) => a.beatOffset - b.beatOffset)
    expect(notes).toHaveLength(3)
    // 每个音都不得延到「同轨下一个起音」之后（最后一个音没有后继，可被踏板延长）
    for (let i = 0; i < notes.length - 1; i++) {
      const end = notes[i].beatOffset + notes[i].pieces.reduce((s, p) => s + p.durationBeats, 0)
      expect(end, `第 ${i + 1} 个音越过下一个起音`).toBeLessThanOrEqual(notes[i + 1].beatOffset)
    }
  })

  it('真正的持续低音（后续起音都在它之后）仍被踏板延长', () => {
    const song = makeSong(
      [
        { pitch: 60, start: 0, end: 1 },
        { pitch: 72, start: 1.5, end: 1.7 },
      ],
      {
        pedalEvents: [
          { time: 0, controller: 64, value: 127, trackIndex: 0, channel: 0 },
          { time: 4, controller: 64, value: 0, trackIndex: 0, channel: 0 },
        ],
      },
    )
    const low = quantizeToScore(song).events.filter((e) => !e.rest && e.keys[0].letter === 'C')[0]
    const total = low.pieces.reduce((s, p) => s + p.durationBeats, 0)
    expect(total).toBeGreaterThan(1)
    expect(total).toBeLessThanOrEqual(1.5)
  })
})

describe('符杠分组的输入形态（score-view 按拍分组的前提）', () => {
  // 回归背景：量化常把一个八分音符写成「八分 + 八分（延音线）」两段。若渲染端把这些
  // 延音线片段当成符杠分组边界，每个音都会单独成组而丢掉符杠（实测 16 个八分音符
  // 只剩 1 组符杠、11 个独立符尾）。这里把该形态钉住，避免上游悄悄改成别的样子。
  it('连奏断音合并后，成对的八分音符各为一个 0.5 拍片段（可直接按拍连符杠）', () => {
    const song = makeSong([
      { pitch: 79, start: 0, end: 0.2354 },
      { pitch: 79, start: 0.25, end: 0.4854 },
      { pitch: 81, start: 0.5, end: 0.7354 },
      { pitch: 81, start: 0.75, end: 0.9854 },
    ])
    const notes = quantizeToScore(song)
      .events.filter((e) => !e.rest)
      .sort((a, b) => a.beatOffset - b.beatOffset)
    expect(notes).toHaveLength(2)
    // 每个音是一个 0.5 拍（八分）片段，起于 0 / 0.5 拍
    expect(notes.map((n) => n.beatOffset)).toEqual([0, 0.5])
    expect(notes.map((n) => n.pieces.map((p) => p.durationBeats))).toEqual([[0.5], [0.5]])
  })

  it('同一拍内的多个片段落在同一个拍组（跨拍的片段才分离）', () => {
    const bounds = beatBounds(4, 4)
    const beatIndexOf = (off: number): number => {
      let idx = 0
      for (let i = 0; i < bounds.length; i++) if (bounds[i] <= off + 1e-6) idx = i
      return idx
    }
    // 同拍内的两个 0.25 片段 → 同一拍组（可以连符杠）
    const inBeat = makeSong([
      { pitch: 79, start: 0, end: 0.2354 },
      { pitch: 79, start: 0.25, end: 0.4854 },
    ])
    const a = quantizeToScore(inBeat).events.find((e) => !e.rest)!
    expect(new Set(a.pieces.map((p) => beatIndexOf(p.beatOffset))).size).toBe(1)

    // 跨拍的音（0 → 1.5）：起点在第 0 拍组、终点已进入第 1 拍组
    const acrossBeat = makeSong([{ pitch: 72, start: 0, end: 1.5 }])
    const b2 = quantizeToScore(acrossBeat).events.find((e) => !e.rest)!
    const last = b2.pieces[b2.pieces.length - 1]
    expect(beatIndexOf(b2.beatOffset)).toBe(0)
    expect(beatIndexOf(last.beatOffset + last.durationBeats - 1e-6)).toBeGreaterThan(0)
  })
})
