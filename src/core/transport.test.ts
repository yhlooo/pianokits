import { describe, expect, it } from 'vitest'

import type { Song } from './model'
import type { AudioEngine, ScheduledNote } from './engine/types'
import { Transport, type PracticeChord, type TransportHost } from './transport'

class FakeEngine implements AudioEngine {
  readonly id: 'smplr' | 'oscillator'
  ready = true
  scheduled: ScheduledNote[] = []
  noteOns: Array<{ pitch: number; velocity: number }> = []
  noteOffs: number[] = []
  allNotesOffCount = 0
  volume = -1

  constructor(id: 'smplr' | 'oscillator' = 'oscillator') {
    this.id = id
  }

  async init(): Promise<void> {}
  scheduleNote(ev: ScheduledNote): void {
    this.scheduled.push(ev)
  }
  noteOn(pitch: number, velocity: number): void {
    this.noteOns.push({ pitch, velocity })
  }
  noteOff(pitch: number): void {
    this.noteOffs.push(pitch)
  }
  allNotesOff(): void {
    this.allNotesOffCount++
  }
  setVolume(v: number): void {
    this.volume = v
  }
  dispose(): void {}
}

class FakeHost implements TransportHost {
  private time = 0
  private timers = new Map<number, () => void>()
  private nextId = 1

  now(): number {
    return this.time
  }
  setInterval(cb: () => void): number {
    this.timers.set(this.nextId, cb)
    return this.nextId++
  }
  clearInterval(id: number): void {
    this.timers.delete(id)
  }
  advance(sec: number): void {
    this.time += sec
  }
  fireTicks(): void {
    for (const cb of [...this.timers.values()]) cb()
  }
  get activeTimers(): number {
    return this.timers.size
  }
}

function makeSong(notes: Array<{ pitch: number; start: number; end: number }>): Song {
  return {
    ppq: 480,
    duration: notes.reduce((m, n) => Math.max(m, n.end), 0),
    tempos: [{ time: 0, bpm: 60 }],
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    keySignatures: [],
    tracks: [],
    notes: notes.map((n, i) => ({ ...n, velocity: 100, trackIndex: i })),
    sustainEvents: [],
  }
}

/** 显式指定轨号（分轨练习用例） */
function makeSongT(
  notes: Array<{ pitch: number; start: number; end: number; trackIndex: number }>,
): Song {
  return {
    ppq: 480,
    duration: notes.reduce((m, n) => Math.max(m, n.end), 0),
    tempos: [{ time: 0, bpm: 60 }],
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    keySignatures: [],
    tracks: [],
    notes: notes.map((n) => ({ ...n, velocity: 100 })),
    sustainEvents: [],
  }
}

describe('Transport 调度器', () => {
  it('播放时把 lookahead 窗口内的音符排入引擎（含 latency 补偿）', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(
      makeSong([
        { pitch: 60, start: 0.05, end: 0.3 },
        { pitch: 62, start: 0.2, end: 0.4 },
        { pitch: 64, start: 1.0, end: 1.2 },
      ]),
    )
    t.play()
    host.fireTicks()
    // pos=0：from=0.015, until=0.1 → 只调度 start<0.1 的音符
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60])
    // 排期时间 = offset(0) + start
    expect(engine.scheduled[0].time).toBeCloseTo(0.05)

    host.advance(0.15)
    host.fireTicks()
    // pos=0.15：from=0.165, until=0.25 → 调度 0.2；1.0 超出窗口
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 62])
  })

  it('暂停：停止定时器、止住发声、位置冻结', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.1, end: 1 }]))
    t.play()
    host.fireTicks()
    host.advance(0.3)
    t.pause()
    const posAtPause = t.position
    expect(t.state).toBe('paused')
    // load() 清场 1 次 + pause() 止音 1 次
    expect(engine.allNotesOffCount).toBe(2)
    expect(host.activeTimers).toBe(0)
    host.advance(1)
    expect(t.position).toBeCloseTo(posAtPause)
  })

  it('恢复播放：从暂停位置继续，排期时间基于新 offset', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.2, end: 1 }]))
    t.play()
    host.fireTicks()
    host.advance(0.5)
    t.pause()
    const pos = t.position // 0.5
    t.play()
    host.fireTicks()
    // pos=0.5：until=0.6 → 0.2 已排过（nextIndex 已越过），无新排期
    expect(engine.scheduled).toHaveLength(1)
    expect(pos).toBeCloseTo(0.5)
  })

  it('seek：跳转后从目标位置重新调度', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(
      makeSong([
        { pitch: 60, start: 1.0, end: 1.2 },
        { pitch: 62, start: 1.05, end: 1.25 },
      ]),
    )
    t.play()
    host.fireTicks()
    t.seek(0.95)
    host.fireTicks()
    // pos=0.95：from=0.965, until=1.05 → 调度 1.0，不调度 1.05
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60])
    // 绝对排期时间 = offset + start = (0 - 0.95) + 1.0 = 0.05
    expect(engine.scheduled[0].time).toBeCloseTo(0.05)
  })

  it('seek 到已开始长音中间：不重排该长音，只排后续音符', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(
      makeSong([
        { pitch: 60, start: 0.0, end: 2.0 },
        { pitch: 62, start: 1.5, end: 1.6 },
      ]),
    )
    t.play()
    host.fireTicks() // 排期长音 60
    engine.scheduled.length = 0
    t.seek(1.0) // 长音仍在响（0.0~2.0），不应重排
    host.fireTicks()
    // pos=1.0：长音已开始（start 0.0 < 1.0）跳过；1.5 超出窗口 → 无新排期
    expect(engine.scheduled).toHaveLength(0)
    host.advance(0.5) // pos = 1.5
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([62])
  })

  it('播到结尾自动停止并停在末尾', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0, end: 0.5 }]))
    t.play()
    host.fireTicks()
    host.advance(1)
    host.fireTicks()
    expect(t.state).toBe('paused')
    expect(t.position).toBeCloseTo(0.5)
    expect(host.activeTimers).toBe(0)
  })

  it('换引擎保持播放位置', () => {
    const engine = new FakeEngine('oscillator')
    const engine2 = new FakeEngine('smplr')
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.1, end: 1 }]))
    t.play()
    host.fireTicks()
    host.advance(0.4)
    const pos = t.position
    t.setEngine(engine2)
    expect(t.state).toBe('playing')
    expect(t.position).toBeCloseTo(pos)
    // load() 清场 1 次 + setEngine 切换清场 1 次
    expect(engine.allNotesOffCount).toBe(2)
  })

  it('实时演奏透传：liveNoteOn/Off 驱动引擎', () => {
    const engine = new FakeEngine()
    const t = new Transport(engine, new FakeHost())
    t.liveNoteOn(60, 90)
    t.liveNoteOff(60)
    expect(engine.noteOns).toEqual([{ pitch: 60, velocity: 90 }])
    expect(engine.noteOffs).toEqual([60])
  })
})

describe('Transport 练习模式', () => {
  /** 记录 onPracticeChord 回调的和弦（null 也记录，用于断言等待取消） */
  function collectChords(t: Transport): Array<PracticeChord | null> {
    const chords: Array<PracticeChord | null> = []
    t.onPracticeChord((c) => chords.push(c))
    return chords
  }

  it('到达和弦起点时冻结位置并回调等待，不排入引擎', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSong([
        { pitch: 60, start: 0.5, end: 0.9 },
        { pitch: 64, start: 0.5, end: 0.9 },
        { pitch: 67, start: 0.5, end: 0.9 },
      ]),
    )
    t.setPracticeTracks(new Set([0, 1, 2]))
    t.play()
    host.advance(0.4)
    host.fireTicks()
    expect(chords).toHaveLength(0)
    expect(engine.scheduled).toHaveLength(0)
    host.advance(0.2) // pos = 0.6 >= 0.5
    host.fireTicks()
    expect(chords).toHaveLength(1)
    expect(chords[0]?.start).toBeCloseTo(0.5)
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60, 64, 67])
    // 位置冻结在和弦起点，之后时间流逝不推进
    expect(t.position).toBeCloseTo(0.5)
    host.advance(2)
    host.fireTicks()
    expect(t.position).toBeCloseTo(0.5)
  })

  it('releaseChord：以当前时间发声整组并推进到下一和弦', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSong([
        { pitch: 60, start: 0.5, end: 0.9 },
        { pitch: 64, start: 0.5, end: 0.9 },
        { pitch: 62, start: 1.2, end: 1.5 },
      ]),
    )
    t.setPracticeTracks(new Set([0, 1, 2]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(chords).toHaveLength(1)
    t.releaseChord()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 64])
    // 发声时刻 = 放行时刻（0.55），时值保持原曲
    expect(engine.scheduled.every((n) => n.time === 0.55)).toBe(true)
    expect(engine.scheduled.every((n) => n.duration === 0.4)).toBe(true)
    // 位置从和弦起点继续推进
    host.advance(0.7) // pos = 1.25 >= 1.2
    host.fireTicks()
    expect(chords).toHaveLength(2)
    expect(chords[1]?.notes.map((n) => n.pitch)).toEqual([62])
    expect(engine.scheduled).toHaveLength(2)
  })

  it('同 onset 组（相差 ≤ 30ms）合并为一个和弦；更远的音符是下一个和弦', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSong([
        { pitch: 60, start: 1.0, end: 1.4 },
        { pitch: 64, start: 1.02, end: 1.4 },
        { pitch: 65, start: 1.1, end: 1.5 },
      ]),
    )
    t.setPracticeTracks(new Set([0, 1, 2]))
    t.play()
    host.advance(1.05)
    host.fireTicks()
    expect(chords).toHaveLength(1)
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60, 64])
    t.releaseChord()
    host.advance(0.1) // pos = 1.15 >= 1.1
    host.fireTicks()
    expect(chords[1]?.notes.map((n) => n.pitch)).toEqual([65])
  })

  it('seek 在练习模式用 start 指针并取消等待', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSong([
        { pitch: 60, start: 0.5, end: 0.9 },
        { pitch: 62, start: 1.2, end: 1.5 },
      ]),
    )
    t.setPracticeTracks(new Set([0, 1]))
    t.play()
    host.advance(0.6)
    host.fireTicks()
    expect(chords).toHaveLength(1)
    t.seek(1.0)
    expect(chords).toEqual([chords[0], null]) // 等待被取消
    host.advance(0.25) // pos = 1.25 >= 1.2
    host.fireTicks()
    expect(chords[2]?.notes.map((n) => n.pitch)).toEqual([62])
  })

  it('暂停取消等待，恢复播放按当前状态重新进入等待', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(makeSong([{ pitch: 60, start: 0.5, end: 1.2 }]))
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(chords).toHaveLength(1)
    t.pause()
    expect(chords).toHaveLength(2)
    expect(chords[1]).toBeNull()
    host.advance(1)
    t.play()
    host.fireTicks()
    expect(chords).toHaveLength(3)
    expect(chords[2]?.notes.map((n) => n.pitch)).toEqual([60])
  })

  it('退出练习模式后等待中的和弦立即按正常调度发声', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(makeSong([{ pitch: 60, start: 0.5, end: 0.9 }]))
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(engine.scheduled).toHaveLength(0)
    t.setPracticeTracks(new Set())
    expect(chords).toHaveLength(2)
    expect(chords[1]).toBeNull()
    host.fireTicks()
    // pos 冻结在 0.5，正常调度窗口 [0.515, 0.6] 包含 0.5 的剩余部分
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60])
    expect(t.position).toBeCloseTo(0.5)
  })

  it('练习模式进入时清掉已排期音符并重定位指针', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSong([
        { pitch: 60, start: 0.05, end: 0.5 },
        { pitch: 62, start: 0.4, end: 0.8 },
      ]),
    )
    t.play()
    host.fireTicks() // 正常调度 0.05
    expect(engine.scheduled).toHaveLength(1)
    host.advance(0.2)
    t.setPracticeTracks(new Set([0, 1]))
    expect(engine.allNotesOffCount).toBeGreaterThanOrEqual(2)
    host.fireTicks()
    host.advance(0.25) // pos = 0.45 >= 0.4
    host.fireTicks()
    // start 指针：已开始的 0.05 音符不再等待，直接等 0.4 的下一和弦
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([62])
  })

  it('播到结尾自动停止（练习模式，最后一个和弦放行后）', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.1, end: 0.4 }]))
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.15)
    host.fireTicks()
    t.releaseChord()
    host.advance(0.5) // pos = 0.65 >= duration 0.4
    host.fireTicks()
    expect(t.state).toBe('paused')
    expect(t.position).toBeCloseTo(0.4)
    expect(host.activeTimers).toBe(0)
  })
})

describe('Transport 分轨练习（部分门控）', () => {
  function collectChords(t: Transport): Array<PracticeChord | null> {
    const chords: Array<PracticeChord | null> = []
    t.onPracticeChord((c) => chords.push(c))
    return chords
  }

  it('部分门控：等待期间整体冻结，同 onset 自由音符随和弦放行、后续自由音符相对放行推进', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSongT([
        { pitch: 60, start: 0.5, end: 0.9, trackIndex: 0 }, // 门控
        { pitch: 62, start: 0.5, end: 0.9, trackIndex: 1 }, // 自由（同和音）
        { pitch: 65, start: 0.7, end: 1.0, trackIndex: 1 }, // 自由（后续）
      ]),
    )
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    // 等待中：门控与同 onset 自由音符都不排期（整体冻结）
    expect(engine.scheduled).toHaveLength(0)
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60])
    // 位置冻结在判定线（和弦起点），不随时间推进
    expect(t.position).toBeCloseTo(0.5)
    host.advance(0.2) // 时间流逝到 0.75，仍未放行
    host.fireTicks()
    expect(engine.scheduled).toHaveLength(0)
    expect(t.position).toBeCloseTo(0.5)
    // 放行：门控和弦立即发声；同 onset 自由音符下一 tick 以放行时刻一起发声
    t.releaseChord()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60])
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 62])
    expect(engine.scheduled.every((n) => n.time === 0.75)).toBe(true)
    // 后续自由音符相对放行时刻继续推进（0.7 → 放行后 0.2s）
    host.advance(0.2) // now = 0.95
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 62, 65])
    expect(engine.scheduled.at(-1)?.time).toBeCloseTo(0.95)
  })

  it('混合和弦：等待组只含门控轨音符，同起点的非门控音符放行时一起发声', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSongT([
        { pitch: 60, start: 0.5, end: 0.9, trackIndex: 0 },
        { pitch: 64, start: 0.5, end: 0.9, trackIndex: 0 },
        { pitch: 67, start: 0.5, end: 0.9, trackIndex: 1 },
      ]),
    )
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    // 等待组仅门控轨音符；同 onset 自由音符不提前排期
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60, 64])
    expect(engine.scheduled).toHaveLength(0)
    // 放行：门控组与同 onset 自由音符以放行时刻一起发声
    t.releaseChord()
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 64, 67])
    expect(engine.scheduled.every((n) => n.time === 0.55)).toBe(true)
  })

  it('调整门控集合：取消当前等待并按新集合从当前位置重新收集', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSongT([
        { pitch: 60, start: 0.5, end: 0.9, trackIndex: 0 },
        { pitch: 64, start: 0.5, end: 0.9, trackIndex: 1 },
      ]),
    )
    t.setPracticeTracks(new Set([0, 1])) // 全门控：冻结
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60, 64])
    t.setPracticeTracks(new Set([0])) // 缩小集合：取消等待（位置冻结在 0.5）
    expect(chords).toEqual([chords[0], null])
    host.fireTicks()
    // 从 0.5 重新收集：仅门控轨
    expect(chords[2]?.notes.map((n) => n.pitch)).toEqual([60])
    // 部分门控：练习轨和弦仍冻结在判定线
    host.advance(0.1)
    host.fireTicks()
    expect(t.position).toBeCloseTo(0.5)
  })

  it('部分门控：放行最后一组后播到结尾自动停止', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSongT([{ pitch: 60, start: 0.5, end: 0.8, trackIndex: 0 }]))
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(t.state).toBe('playing')
    t.releaseChord()
    host.advance(0.5) // pos = 1.05 >= duration 0.8
    host.fireTicks()
    expect(t.state).toBe('paused')
    expect(t.position).toBeCloseTo(0.8)
    expect(host.activeTimers).toBe(0)
  })

  it('清空门控集合（退出）：等待中的和弦立即发声，冻结的自由音符随后正常排期', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSongT([
        { pitch: 60, start: 0.5, end: 0.9, trackIndex: 0 },
        { pitch: 65, start: 0.6, end: 1.0, trackIndex: 1 },
        { pitch: 62, start: 1.2, end: 1.5, trackIndex: 0 },
      ]),
    )
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    // 等待中：门控与后续自由音符整体冻结，都不发声
    expect(engine.scheduled).toHaveLength(0)
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60])
    t.setPracticeTracks(new Set())
    expect(chords).toHaveLength(2)
    expect(chords[1]).toBeNull()
    // 退出后：等待中的和弦立即发声（位置回拨到和弦起点 0.5）
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60])
    // 继续推进：冻结的自由音符与后续门控音符按正常时间轴排期
    host.advance(0.1) // now = 0.65, pos = 0.6
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 65])
    host.advance(0.6) // now = 1.25, pos = 1.2
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 65, 62])
  })
})

describe('Transport MIDI 输出镜像', () => {
  class FakeSink {
    scheduled: ScheduledNote[] = []
    allNotesOffCount = 0

    scheduleNote(ev: ScheduledNote): void {
      this.scheduled.push(ev)
    }
    allNotesOff(): void {
      this.allNotesOffCount++
    }
  }

  it('排期音符同步镜像到输出（与引擎同一份排期数据）', () => {
    const engine = new FakeEngine()
    const sink = new FakeSink()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.setMidiOutput(sink)
    t.load(
      makeSong([
        { pitch: 60, start: 0.05, end: 0.3 },
        { pitch: 64, start: 1.0, end: 1.2 },
      ]),
    )
    t.play()
    host.fireTicks()
    expect(sink.scheduled).toHaveLength(1)
    expect(sink.scheduled[0]).toEqual(engine.scheduled[0])
    host.advance(0.95)
    host.fireTicks()
    expect(sink.scheduled).toHaveLength(2)
    expect(sink.scheduled[1]).toEqual(engine.scheduled[1])
  })

  it('解除镜像后不再发送', () => {
    const engine = new FakeEngine()
    const sink = new FakeSink()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.05, end: 0.3 }]))
    t.play()
    host.fireTicks()
    expect(sink.scheduled).toHaveLength(0)
    t.setMidiOutput(sink)
    host.advance(0.2)
    host.fireTicks()
    // 指针已越过该音符：挂上 sink 后无新排期，仍为 0
    expect(sink.scheduled).toHaveLength(0)
    t.setMidiOutput(null)
  })

  it('暂停/停止/跳转/换引擎触发输出静默', () => {
    const engine = new FakeEngine()
    const sink = new FakeSink()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.1, end: 1 }]))
    t.setMidiOutput(sink)
    t.play()
    host.fireTicks()
    host.advance(0.3)
    t.pause()
    expect(sink.allNotesOffCount).toBe(1)
    t.play()
    host.fireTicks()
    t.stop()
    expect(sink.allNotesOffCount).toBe(2)
    t.play()
    host.fireTicks()
    t.seek(0.5)
    expect(sink.allNotesOffCount).toBe(3)
    const engine2 = new FakeEngine('smplr')
    t.setEngine(engine2)
    expect(sink.allNotesOffCount).toBe(4)
  })

  it('练习模式放行和弦同样镜像到输出', () => {
    const engine = new FakeEngine()
    const sink = new FakeSink()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.setMidiOutput(sink)
    t.load(
      makeSong([
        { pitch: 60, start: 0.5, end: 0.9 },
        { pitch: 64, start: 0.5, end: 0.9 },
      ]),
    )
    t.setPracticeTracks(new Set([0, 1]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(sink.scheduled).toHaveLength(0) // 等待中不发声也不镜像
    t.releaseChord()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 64])
    expect(sink.scheduled).toEqual(engine.scheduled)
  })

  it('部分门控：自由轨排期与门控轨放行都镜像到输出', () => {
    const engine = new FakeEngine()
    const sink = new FakeSink()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.setMidiOutput(sink)
    t.load(
      makeSongT([
        { pitch: 60, start: 0.5, end: 0.9, trackIndex: 0 },
        { pitch: 62, start: 0.5, end: 0.9, trackIndex: 1 },
      ]),
    )
    t.setPracticeTracks(new Set([0]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    // 等待中：同 onset 自由音符冻结不排期
    expect(engine.scheduled).toHaveLength(0)
    t.releaseChord()
    host.fireTicks()
    // 放行：门控音符与同 onset 自由音符以放行时刻一起发声，均镜像到输出
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 62])
    expect(sink.scheduled).toEqual(engine.scheduled)
  })
})
