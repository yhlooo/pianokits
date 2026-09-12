import { describe, expect, it } from 'vitest'

import type { RecordedNote } from '../recorder-model'
import { parseMidi } from './parse'
import { writeMidi } from './write'

/**
 * 时间容差（秒）：@tonejs/midi 以 480 ppq 的 tick 记时，120 bpm 下
 * 1 tick = 60 / 120 / 480 ≈ 1.04 ms，秒 → tick 取整带来的往返误差远小于 10 ms。
 */
const TIME_TOLERANCE_SEC = 0.01

/** 断言两个时刻在量化容差内相等 */
function expectTime(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TIME_TOLERANCE_SEC)
}

describe('writeMidi 往返（writeMidi → parseMidi）', () => {
  it('单个 C4 音符：音高、力度、起止时间与来源轨通道原样读回', () => {
    const notes: RecordedNote[] = [{ pitch: 60, velocity: 100, start: 0, end: 0.5, channel: 0 }]

    const song = parseMidi(writeMidi(notes))

    expect(song.notes).toHaveLength(1)
    const note = song.notes[0]
    expect(note.pitch).toBe(60)
    expect(note.velocity).toBe(100)
    expectTime(note.start, 0)
    expectTime(note.end, 0.5)
    // 单通道只有一轨，音符来源轨即录音通道
    expect(song.tracks).toHaveLength(1)
    expect(song.tracks[note.trackIndex].channel).toBe(0)
    // 默认 120 BPM（SMF 以整数微秒/拍存储，120 可精确往返）
    expect(song.tempos.map((t) => t.bpm)).toEqual([120])
  })

  it('和弦（同起点 3 音）与多通道：音符齐全、按 start 排序、通道保留', () => {
    const notes: RecordedNote[] = [
      { pitch: 60, velocity: 100, start: 0, end: 1, channel: 0 },
      { pitch: 64, velocity: 90, start: 0, end: 1, channel: 0 },
      { pitch: 67, velocity: 80, start: 0, end: 1, channel: 0 },
      { pitch: 72, velocity: 70, start: 0.25, end: 0.75, channel: 1 },
      { pitch: 48, velocity: 60, start: 0.5, end: 1.5, channel: 1 },
    ]

    const song = parseMidi(writeMidi(notes))

    // 和弦同刻音按音高定序（parseMidi 的排序规则），其余按 start 升序
    expect(song.notes.map((n) => n.pitch)).toEqual([60, 64, 67, 72, 48])
    expect(song.notes.map((n) => n.velocity)).toEqual([100, 90, 80, 70, 60])
    const starts = song.notes.map((n) => n.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    const expectedStarts = [0, 0, 0, 0.25, 0.5]
    starts.forEach((start, i) => {
      expectTime(start, expectedStarts[i])
    })
    // 通道保留：读来源轨通道；一个通道一轨，升序排列
    expect(song.notes.map((n) => song.tracks[n.trackIndex].channel)).toEqual([0, 0, 0, 1, 1])
    expect(song.tracks.map((t) => t.channel)).toEqual([0, 1])
  })

  it('力度极值 1 与 127 经 0~1 归一化往返后不变', () => {
    const notes: RecordedNote[] = [
      { pitch: 60, velocity: 1, start: 0, end: 0.5, channel: 0 },
      { pitch: 62, velocity: 127, start: 0, end: 0.5, channel: 0 },
    ]

    const song = parseMidi(writeMidi(notes))

    // 编码侧 velocity / 127 → 写出侧 floor(v * 127)，对 1~127 的整数恒等（无浮点偏差）
    expect(song.notes.map((n) => n.velocity)).toEqual([1, 127])
  })

  it('空录音：写出可解析的空 MIDI 文件（不抛错）', () => {
    const bytes = writeMidi([])

    // SMF 头块标识 MThd，文件非空且格式合法
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('MThd')
    const song = parseMidi(bytes)
    expect(song.notes).toEqual([])
    expect(song.tracks.filter((t) => t.noteCount > 0)).toEqual([])
  })

  it('不修改传入的音符（冻结数组 + 前后深比较）', () => {
    // 刻意乱序并冻结：就地排序/就地改写会在严格模式下直接抛错
    const notes: readonly RecordedNote[] = Object.freeze([
      Object.freeze({ pitch: 64, velocity: 80, start: 0.5, end: 1, channel: 0 }),
      Object.freeze({ pitch: 60, velocity: 100, start: 0, end: 0.5, channel: 0 }),
    ])
    const before = notes.map((n) => ({ ...n }))

    const song = parseMidi(writeMidi(notes))

    expect(notes.map((n) => ({ ...n }))).toEqual(before)
    expect(song.notes.map((n) => n.pitch)).toEqual([60, 64])
  })

  it('防御性钳制：音高 0~127、力度 1~127、非正时值丢弃', () => {
    const notes: RecordedNote[] = [
      { pitch: -5, velocity: 0, start: 0, end: 0.5, channel: 0 },
      { pitch: 200, velocity: 200, start: 0, end: 0.5, channel: 0 },
      { pitch: 62, velocity: 64, start: 0.5, end: 0.5, channel: 0 }, // 零时值：丢弃
    ]

    const song = parseMidi(writeMidi(notes))

    expect(song.notes.map((n) => [n.pitch, n.velocity])).toEqual([
      [0, 1],
      [127, 127],
    ])
  })

  it('trackName 选项：单通道时轨名即选项值', () => {
    const notes: RecordedNote[] = [{ pitch: 60, velocity: 100, start: 0, end: 0.5, channel: 0 }]

    const song = parseMidi(writeMidi(notes, { trackName: 'Take 1' }))

    expect(song.tracks.map((t) => t.name)).toEqual(['Take 1'])
    // 注：@tonejs/midi 的文本事件按 latin-1 逐字节写出（midi-file writeString 取
    // codePoint & 0xFF），非 ASCII 轨名在文件里会变乱码，故默认轨名只用 ASCII
    // （'PianoKits Recording'）；这里用 ASCII 轨名验证这条分支能完整往返。
  })
})
