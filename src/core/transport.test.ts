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
    pedalEvents: [],
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
    pedalEvents: [],
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

  it('scrub：播放中拖动静音定位不发声，endScrub 恢复播放后才发声', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 1.0, end: 1.2 }]))
    t.play()
    host.fireTicks()
    // pos=0：1.0 超出 lookahead 窗口，无排期
    expect(engine.scheduled).toHaveLength(0)

    t.scrub(0.95)
    expect(t.state).toBe('paused')
    expect(t.position).toBeCloseTo(0.95)
    // 拖动预览不排期、定时器已停
    expect(engine.scheduled).toHaveLength(0)
    expect(host.activeTimers).toBe(0)

    // 拖动中反复 scrub 仍不发声
    t.scrub(0.9)
    t.scrub(0.95)
    expect(engine.scheduled).toHaveLength(0)

    // 松开：恢复播放，把窗口内的音符排期（此刻才开始发声）
    t.endScrub()
    host.fireTicks()
    expect(t.state).toBe('playing')
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60])
    // 绝对排期时间 = offset + start = (0 - 0.95) + 1.0 = 0.05
    expect(engine.scheduled[0].time).toBeCloseTo(0.05)
  })

  it('scrub：暂停中拖动只移动位置，结束后不恢复播放', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.5, end: 0.8 }]))
    t.scrub(0.3)
    expect(t.state).toBe('paused')
    expect(t.position).toBeCloseTo(0.3)
    t.endScrub()
    expect(t.state).toBe('paused')
    expect(host.activeTimers).toBe(0)
  })

  it('endScrub 未在拖动中调用时为空操作', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makeSong([{ pitch: 60, start: 0.5, end: 0.8 }]))
    t.endScrub()
    expect(t.state).toBe('ready')
    expect(host.activeTimers).toBe(0)
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

  it('提前进入判定窗口回调；到达和弦起点时冻结位置，不排入引擎', () => {
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
    host.fireTicks()
    // 进入提前触发窗口（一个四分音符 @60bpm = 1s）：立即回调，但不冻结、不发声
    expect(chords).toHaveLength(1)
    expect(chords[0]?.start).toBeCloseTo(0.5)
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60, 64, 67])
    expect(engine.scheduled).toHaveLength(0)
    expect(t.position).toBeCloseTo(0)
    // 到达判定线（0.5）：位置冻结在和弦起点，之后时间流逝不推进
    host.advance(0.55)
    host.fireTicks()
    expect(t.position).toBeCloseTo(0.5)
    host.advance(2)
    host.fireTicks()
    expect(t.position).toBeCloseTo(0.5)
  })

  it('提前窗口内按键可提前放行：位置追到和弦起点（门控音符不排期发声）', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(makeSong([{ pitch: 60, start: 0.5, end: 0.9 }]))
    t.setPracticeTracks(new Set([0]))
    t.play()
    // 和弦 0.5 已进入提前窗口（回调），位置尚未到判定线
    host.fireTicks()
    expect(chords).toHaveLength(1)
    expect(t.position).toBeCloseTo(0)
    // 在 0.2 提前按键放行：门控音符不排期（由回送发声），仅位置追到和弦起点
    host.advance(0.2)
    t.releaseChord()
    expect(engine.scheduled).toHaveLength(0)
    // 放行后位置追到和弦起点 0.5
    expect(t.position).toBeCloseTo(0.5)
  })

  it('按顺序触发：前一和弦放行后才回调下一和弦', () => {
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
    // 第一个和弦已进入提前窗口并回调；第二个和弦尚未回调（顺序门控）
    expect(chords).toHaveLength(1)
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60])
    // 放行第一个和弦后，第二个和弦才回调（已在其提前窗口内）
    t.releaseChord()
    host.fireTicks()
    expect(chords).toHaveLength(2)
    expect(chords[1]?.notes.map((n) => n.pitch)).toEqual([62])
  })

  it('releaseChord：放行推进到下一和弦（门控音符不排期发声）', () => {
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
    // 门控音符不排期（由回送发声），位置从和弦起点继续推进
    expect(engine.scheduled).toHaveLength(0)
    expect(t.position).toBeCloseTo(0.5)
    host.advance(0.7) // pos = 1.25 >= 1.2
    host.fireTicks()
    expect(chords).toHaveLength(2)
    expect(chords[1]?.notes.map((n) => n.pitch)).toEqual([62])
    expect(engine.scheduled).toHaveLength(0)
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
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60])
    expect(t.position).toBeCloseTo(0.5)
    // seek 到 1.0：取消当前等待（null）；1.2 已进入其提前窗口（0.2）→ 立即重新回调
    t.seek(1.0)
    expect(chords).toHaveLength(3)
    expect(chords[1]).toBeNull()
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
    // 放行：门控和弦不排期（由回送发声）；同 onset 自由音符下一 tick 以放行时刻发声
    t.releaseChord()
    expect(engine.scheduled).toHaveLength(0)
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([62])
    expect(engine.scheduled.every((n) => n.time === 0.75)).toBe(true)
    // 后续自由音符相对放行时刻继续推进（0.7 → 放行后 0.2s）
    host.advance(0.2) // now = 0.95
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([62, 65])
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
    // 放行：门控组不排期（由回送发声），同 onset 自由音符以放行时刻发声
    t.releaseChord()
    host.fireTicks()
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([67])
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

  it('excused：收集和弦时计算「在键盘上/正进入」的音符音高（长音符与同 onset 非门控音符）', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    const chords = collectChords(t)
    t.load(
      makeSongT([
        { pitch: 62, start: 0.0, end: 1.5, trackIndex: 0 }, // 长音符（跨后续和弦）
        { pitch: 60, start: 0.5, end: 0.8, trackIndex: 1 }, // 门控和弦
        { pitch: 64, start: 0.5, end: 0.8, trackIndex: 2 }, // 同 onset 非门控
      ]),
    )
    t.setPracticeTracks(new Set([1]))
    t.play()
    host.advance(0.55)
    host.fireTicks()
    expect(chords[0]?.notes.map((n) => n.pitch)).toEqual([60])
    expect([...(chords[0]?.excused ?? new Set<number>())].sort((a, b) => a - b)).toEqual([
      60, 62, 64,
    ])
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

describe('Transport 踏板练习', () => {
  /** 单轨（通道 0）曲目 + 延音踏板 0.4–1.0s；音符 0.5 与 1.5 */
  function makePedalSong(): Song {
    return {
      ppq: 480,
      duration: 2,
      tempos: [{ time: 0, bpm: 60 }], // 1 拍 = 1 秒（提前触发窗口 = 1 秒）
      timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
      keySignatures: [],
      tracks: [
        { index: 0, name: 'Piano', channel: 0, instrument: 0, percussion: false, noteCount: 2 },
      ],
      notes: [
        { pitch: 60, start: 0.5, end: 0.9, velocity: 100, trackIndex: 0 },
        { pitch: 62, start: 1.5, end: 1.9, velocity: 100, trackIndex: 0 },
      ],
      pedalEvents: [
        { time: 0.4, controller: 64, value: 127, trackIndex: 0, channel: 0 },
        { time: 1.0, controller: 64, value: 0, trackIndex: 0, channel: 0 },
      ],
    }
  }

  it('pedalFocus：未练习 → null；练习中 off → 空关注（全部压暗）；开启模式 → 判定范围', () => {
    const t = new Transport(new FakeEngine(), new FakeHost())
    t.load(makePedalSong())
    expect(t.pedalFocus).toBeNull()
    t.setPracticeTracks(new Set([0]))
    expect(t.pedalFocus).toEqual({ pedals: new Set(), channels: null })
    t.setPedalPracticeMode('sustain')
    expect(t.pedalFocus).toEqual({ pedals: new Set(['sustain']), channels: new Set([0]) })
    // 退出练习 → 关注范围为 null（踏板条恢复正常显示）
    t.setPracticeTracks(new Set())
    expect(t.pedalFocus).toBeNull()
  })

  it('pedalsDownAt：踩下区间的持续期间内为「文件正踩着」（含踩下、不含抬起）', () => {
    const t = new Transport(new FakeEngine(), new FakeHost())
    t.load(makePedalSong()) // 延音 0.4–1.0
    t.setPracticeTracks(new Set([0]))
    t.setPedalPracticeMode('sustain')
    expect([...t.pedalsDownAt(0.3)]).toEqual([])
    expect([...t.pedalsDownAt(0.4)]).toEqual(['sustain'])
    expect([...t.pedalsDownAt(0.7)]).toEqual(['sustain'])
    expect([...t.pedalsDownAt(1.0)]).toEqual([]) // 抬起时刻起不再踩着
    // 练习未开启（无关注范围）→ 恒为空
    t.setPracticeTracks(new Set())
    expect([...t.pedalsDownAt(0.5)]).toEqual([])
    // 练习中但踏板练习为 off → 判定踏板为空
    t.setPracticeTracks(new Set([0]))
    t.setPedalPracticeMode('off')
    expect([...t.pedalsDownAt(0.5)]).toEqual([])
  })

  it('独立踏板闸门：没有音符要按的时刻也会冻结等待（踏板与按键同等地位）', () => {
    const song = makePedalSong()
    song.duration = 3
    song.notes = [
      { pitch: 60, start: 0.5, end: 0.9, velocity: 100, trackIndex: 0 },
      { pitch: 64, start: 2.6, end: 2.9, velocity: 100, trackIndex: 0 },
    ]
    // 1.5s 处的踏板踩下远离任何音符（最近的音符 0.5 / 2.6，相差 > 合并窗口）
    song.pedalEvents = [
      { time: 1.5, controller: 64, value: 127, trackIndex: 0, channel: 0 },
      { time: 2.2, controller: 64, value: 0, trackIndex: 0, channel: 0 },
    ]
    const host = new FakeHost()
    const t = new Transport(new FakeEngine(), host)
    t.load(song)
    t.setPracticeTracks(new Set([0]))
    t.setPedalPracticeMode('sustain')
    const chords: Array<PracticeChord | null> = []
    t.onPracticeChord((c) => chords.push(c))
    t.play()
    host.fireTicks() // pos=0：进入和弦 0.5 的提前窗口
    expect(chords.at(-1)?.notes.map((n) => n.pitch)).toEqual([60])
    t.releaseChord()
    host.advance(1.1) // pos ≈ 1.1：越过 0.5，进入独立踏板闸门（1.5）的提前窗口
    host.fireTicks()
    const gate = chords.at(-1)
    expect(gate?.start).toBeCloseTo(1.5)
    expect(gate?.notes).toEqual([]) // 纯踏板闸门：没有音符要按
    expect([...(gate?.requiredPedals ?? [])]).toEqual(['sustain'])
    host.advance(0.5) // pos 到 1.5 → 冻结
    host.fireTicks()
    expect(t.position).toBeCloseTo(1.5)
    t.releaseChord()
    host.advance(0.3)
    host.fireTicks()
    expect(t.position).toBeGreaterThan(1.5)
  })

  it('门控和弦携带踏板要求（覆盖和弦起点的踏板）与参与判定的踏板', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makePedalSong())
    t.setPracticeTracks(new Set([0]))
    t.setPedalPracticeMode('sustain')
    const chords: Array<PracticeChord | null> = []
    t.onPracticeChord((c) => chords.push(c))
    t.play()
    host.fireTicks() // pos=0：进入和弦 60（0.5s）的提前触发窗口
    const chord = chords.at(-1)
    expect(chord?.notes.map((n) => n.pitch)).toEqual([60])
    expect([...(chord?.requiredPedals ?? [])]).toEqual(['sustain'])
    expect([...(chord?.judgedPedals ?? [])]).toEqual(['sustain'])
    // 放行后推进到第二个和弦（1.5s）：踏板 1.0s 已抬起 → 无踏板要求
    t.releaseChord()
    host.advance(1.6)
    host.fireTicks()
    const next = chords.at(-1)
    expect(next?.notes.map((n) => n.pitch)).toEqual([62])
    expect([...(next?.requiredPedals ?? [])]).toEqual([])
  })

  it('踏板练习为 off：和弦不带踏板要求（等价于既有行为）', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makePedalSong())
    t.setPracticeTracks(new Set([0]))
    const chords: Array<PracticeChord | null> = []
    t.onPracticeChord((c) => chords.push(c))
    t.play()
    host.fireTicks()
    expect([...(chords.at(-1)?.requiredPedals ?? [])]).toEqual([])
    expect([...(chords.at(-1)?.judgedPedals ?? [])]).toEqual([])
  })

  it('切换踏板练习模式：取消当前等待并按新范围重新进入', () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const t = new Transport(engine, host)
    t.load(makePedalSong())
    t.setPracticeTracks(new Set([0]))
    const chords: Array<PracticeChord | null> = []
    t.onPracticeChord((c) => chords.push(c))
    t.play()
    host.fireTicks()
    expect(chords.at(-1)).not.toBeNull()
    t.setPedalPracticeMode('all')
    expect(chords.at(-1)).toBeNull() // 取消等待
    host.fireTicks()
    // all 模式：三踏板都参与判定（本曲只有 CC64 数据，额外踩弱音/选择延音也会被判错）
    expect([...(chords.at(-1)?.judgedPedals ?? [])].sort()).toEqual([
      'soft',
      'sostenuto',
      'sustain',
    ])
  })

  it('踏板落在无音符轨（纯控制轨）→ 全曲踏板（channels = null，任何练习轨都判定）', () => {
    const song = makePedalSong()
    song.tracks = [
      { index: 0, name: 'Piano', channel: 0, instrument: 0, percussion: false, noteCount: 2 },
      { index: 1, name: 'Control', channel: 3, instrument: 0, percussion: false, noteCount: 0 },
    ]
    song.pedalEvents = [
      { time: 0.4, controller: 64, value: 127, trackIndex: 1, channel: 3 },
      { time: 1.0, controller: 64, value: 0, trackIndex: 1, channel: 3 },
    ]
    const t = new Transport(new FakeEngine(), new FakeHost())
    t.load(song)
    t.setPracticeTracks(new Set([0]))
    t.setPedalPracticeMode('all')
    expect(t.pedalFocus).toEqual({
      pedals: new Set(['soft', 'sostenuto', 'sustain']),
      channels: null,
    })
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

  it('练习模式放行和弦不排期到引擎/镜像（门控音符由回送发声）', () => {
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
    expect(engine.scheduled).toHaveLength(0)
    expect(sink.scheduled).toHaveLength(0)
  })

  it('部分门控：自由轨排期镜像到输出（门控轨由回送发声、不排期不镜像）', () => {
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
    // 放行：门控音符不排期（回送发声）；同 onset 自由音符以放行时刻发声并镜像
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([62])
    expect(sink.scheduled).toEqual(engine.scheduled)
  })
})
