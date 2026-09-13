import { describe, expect, it } from 'vitest'

import {
  MIN_NOTE_SEC,
  erasePedalRange,
  eraseRange,
  firstNoteAtOrAfter,
  firstPedalAtOrAfter,
  mergeNotes,
  mergePedals,
  overlayNote,
  pedalTrackDuration,
  trackDuration,
  type RecordedNote,
  type RecordedPedalSegment,
} from './recorder-model'

const note = (pitch: number, start: number, end: number, velocity = 100): RecordedNote => ({
  pitch,
  velocity,
  start,
  end,
  channel: 0,
})

describe('overlayNote', () => {
  it('空音轨：插入并按 start 排序', () => {
    let notes: RecordedNote[] = []
    notes = overlayNote(notes, note(62, 1, 1.5))
    notes = overlayNote(notes, note(60, 0.5, 0.9))
    expect(notes.map((n) => [n.pitch, n.start, n.end])).toEqual([
      [60, 0.5, 0.9],
      [62, 1, 1.5],
    ])
  })

  it('不同音高可叠加（和弦/分轨录音）', () => {
    const notes = overlayNote([note(60, 0, 1)], note(64, 0.2, 0.8))
    expect(notes).toHaveLength(2)
    expect(notes.map((n) => n.pitch)).toEqual([60, 64])
  })

  it('同音高不重叠：两条都保留', () => {
    const notes = overlayNote([note(60, 0, 0.5)], note(60, 0.5, 1))
    expect(notes.map((n) => [n.start, n.end])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ])
  })

  it('同音高完全覆盖：旧音符被移除', () => {
    const notes = overlayNote([note(60, 0.2, 0.4)], note(60, 0, 0.8))
    expect(notes).toHaveLength(1)
    expect(notes[0].start).toBe(0)
    expect(notes[0].end).toBe(0.8)
  })

  it('同音高尾部重叠：旧音符被覆盖的头部裁掉、尾部保留', () => {
    const notes = overlayNote([note(60, 0.4, 1)], note(60, 0, 0.6))
    expect(notes.map((n) => [n.start, n.end])).toEqual([
      [0, 0.6],
      [0.6, 1],
    ])
  })

  it('同音高头部重叠：旧音符被覆盖的尾部裁掉、头部保留', () => {
    const notes = overlayNote([note(60, 0, 0.6)], note(60, 0.4, 1))
    expect(notes.map((n) => [n.start, n.end])).toEqual([
      [0, 0.4],
      [0.4, 1],
    ])
  })

  it('新音符落在旧音符内部：旧音符切成前后两段', () => {
    const notes = overlayNote([note(60, 0, 2)], note(60, 0.5, 1))
    expect(notes.map((n) => [n.start, n.end])).toEqual([
      [0, 0.5],
      [0.5, 1],
      [1, 2],
    ])
  })

  it('不修改原数组', () => {
    const original = [note(60, 0, 1)]
    overlayNote(original, note(60, 0.5, 1.5))
    expect(original.map((n) => [n.start, n.end])).toEqual([[0, 1]])
  })
})

describe('eraseRange（覆盖录制的擦除：只抹掉被录制线扫过的区间）', () => {
  it('完全在区间内的音符整体抹除；区间外的原样保留（不分音高）', () => {
    const notes = [note(60, 0.15, 0.35), note(64, 2, 3)]
    expect(eraseRange(notes, 1, 1.5)).toEqual(notes)
    expect(eraseRange(notes, 0.1, 0.4).map((n) => [n.start, n.end])).toEqual([[2, 3]])
  })

  it('只扫到一半：被扫到的部分抹掉，没扫到的部分保留', () => {
    // 音符 [0,2]，线扫过 [0,1.2] → 只剩 [1.2,2]
    expect(eraseRange([note(60, 0, 2)], 0, 1.2).map((n) => [n.start, n.end])).toEqual([[1.2, 2]])
  })

  it('区间落在音符中间：切成前后两段（两端都没扫到）', () => {
    expect(eraseRange([note(60, 0.5, 3)], 1, 1.5).map((n) => [n.start, n.end])).toEqual([
      [0.5, 1],
      [1.5, 3],
    ])
  })

  it('跨越区间起点：只保留区间之前的部分', () => {
    expect(eraseRange([note(60, 0.5, 1.2)], 1, 2).map((n) => [n.start, n.end])).toEqual([[0.5, 1]])
  })

  it('空区间（还没扫过任何位置）：内容不变，且不修改原数组', () => {
    const notes = [note(60, 0, 2)]
    expect(eraseRange(notes, 1, 1)).toEqual(notes)
    expect(eraseRange(notes, 2, 1)).toEqual(notes)
    expect(notes.map((n) => [n.start, n.end])).toEqual([[0, 2]])
  })

  it('同时擦掉多个音高（覆盖录制会带走这一段里的一切）', () => {
    const notes = [note(60, 0, 1), note(64, 0.2, 0.8), note(67, 0.9, 1.1)]
    expect(eraseRange(notes, 0, 1).map((n) => [n.pitch, n.start, n.end])).toEqual([[67, 1, 1.1]])
  })
})

describe('mergeNotes（合并两条有序音轨）', () => {
  it('保持 start 升序，同 start 按音高', () => {
    const a = [note(60, 0, 1), note(67, 2, 3)]
    const b = [note(64, 0, 1), note(62, 1, 1.5)]
    expect(mergeNotes(a, b).map((n) => [n.pitch, n.start])).toEqual([
      [60, 0],
      [64, 0],
      [62, 1],
      [67, 2],
    ])
  })

  it('一边为空时返回另一边的内容副本', () => {
    const a = [note(60, 0, 1)]
    const merged = mergeNotes(a, [])
    expect(merged).toEqual(a)
    expect(merged).not.toBe(a)
  })
})

describe('trackDuration', () => {
  it('取最后一个音符的结束时刻；空轨为 0', () => {
    expect(trackDuration([])).toBe(0)
    expect(trackDuration([note(60, 0, 1.2), note(64, 0.5, 0.8)])).toBe(1.2)
  })
})

describe('firstNoteAtOrAfter', () => {
  const notes = [note(60, 0.5, 1), note(62, 1.2, 1.5), note(64, 1.2, 2)]

  it('二分定位第一个 start >= position 的音符', () => {
    expect(firstNoteAtOrAfter(notes, 0)).toBe(0)
    expect(firstNoteAtOrAfter(notes, 0.5)).toBe(0)
    expect(firstNoteAtOrAfter(notes, 0.6)).toBe(1)
    expect(firstNoteAtOrAfter(notes, 1.2)).toBe(1)
    expect(firstNoteAtOrAfter(notes, 3)).toBe(3)
  })
})

describe('MIN_NOTE_SEC', () => {
  it('最短时值为正（同刻按下/松开也能画出并听见）', () => {
    expect(MIN_NOTE_SEC).toBeGreaterThan(0)
  })
})

// ---------- 踏板（设计文档 20260913-recorder-pedals.md §3.2） ----------

const pedal = (
  controller: number,
  start: number,
  end: number,
  channel = 0,
  value = 127,
): RecordedPedalSegment => ({ controller, channel, start, end, value })

const span = (s: RecordedPedalSegment): number[] => [s.start, s.end]

describe('erasePedalRange（踏板覆盖擦除）', () => {
  it('完全在窗口内 → 整段抹除', () => {
    expect(erasePedalRange([pedal(64, 1, 2)], 0.5, 2.5)).toEqual([])
  })

  it('跨越窗口起点 → 只保留起点之前的部分（踏板在录制线处被"接管"）', () => {
    expect(erasePedalRange([pedal(64, 0, 2)], 1, 3).map(span)).toEqual([[0, 1]])
  })

  it('跨越窗口终点 → 保留终点之后的部分（从录制线起继续踩着）', () => {
    expect(erasePedalRange([pedal(64, 0, 2)], -1, 1).map(span)).toEqual([[1, 2]])
  })

  it('跨两端 → 切成前后两段', () => {
    expect(erasePedalRange([pedal(64, 0, 4)], 1, 2).map(span)).toEqual([
      [0, 1],
      [2, 4],
    ])
  })

  it('不相交 → 原样；空窗口 → 浅拷贝不变（且不修改原数组）', () => {
    const segs = [pedal(64, 3, 4)]
    expect(erasePedalRange(segs, 0, 1)).toEqual(segs)
    const same = erasePedalRange(segs, 1, 1)
    expect(same).toEqual(segs)
    expect(same).not.toBe(segs)
    expect(segs.map(span)).toEqual([[3, 4]])
  })
})

describe('mergePedals / pedalTrackDuration / firstPedalAtOrAfter', () => {
  it('合并保持 start 升序；同 start 按控制器号、通道', () => {
    const a = [pedal(64, 0, 1), pedal(67, 2, 3)]
    const b = [pedal(66, 0, 1), pedal(64, 1, 2, 1)]
    expect(mergePedals(a, b).map((s) => [s.controller, s.channel, s.start])).toEqual([
      [64, 0, 0],
      [66, 0, 0],
      [64, 1, 1],
      [67, 0, 2],
    ])
    expect(mergePedals(a, [])).toEqual(a)
    expect(mergePedals(a, [])).not.toBe(a)
  })

  it('时长取最后一个区间的结束；未收尾（Infinity）不计入；空轨为 0', () => {
    expect(pedalTrackDuration([])).toBe(0)
    expect(pedalTrackDuration([pedal(64, 0, 2), pedal(67, 1, 1.5)])).toBe(2)
    expect(pedalTrackDuration([pedal(64, 0, Number.POSITIVE_INFINITY)])).toBe(0)
  })

  it('指针 = 第一个 end > position 的区间（已结束的跳过）', () => {
    const segs = [pedal(67, 1, 2), pedal(66, 4, 6)]
    expect(firstPedalAtOrAfter(segs, -1)).toBe(0)
    expect(firstPedalAtOrAfter(segs, 1)).toBe(0) // 落在区间内：保留
    expect(firstPedalAtOrAfter(segs, 1.9)).toBe(0)
    expect(firstPedalAtOrAfter(segs, 2)).toBe(1) // end = 2 不算（已经抬起）
    expect(firstPedalAtOrAfter(segs, 5.9)).toBe(1)
    expect(firstPedalAtOrAfter(segs, 6)).toBe(2)
  })

  it('指针不被"更早开始但仍在响"的其它踏板区间带偏（线落在延音中途必须保留它）', () => {
    const segs = [pedal(64, 0, 10), pedal(67, 1, 2)]
    expect(firstPedalAtOrAfter(segs, 5)).toBe(0)
  })
})
