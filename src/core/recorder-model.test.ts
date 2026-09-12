import { describe, expect, it } from 'vitest'

import {
  MIN_NOTE_SEC,
  eraseRange,
  firstNoteAtOrAfter,
  mergeNotes,
  overlayNote,
  trackDuration,
  type RecordedNote,
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
