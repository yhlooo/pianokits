import { describe, expect, it } from 'vitest'

import type { Song } from './model'
import type { AudioEngine, ScheduledNote } from './engine/types'
import { Transport, type TransportHost } from './transport'

class FakeEngine implements AudioEngine {
  readonly id: 'smplr' | 'oscillator'
  ready = true
  scheduled: ScheduledNote[] = []
  allNotesOffCount = 0
  volume = -1

  constructor(id: 'smplr' | 'oscillator' = 'oscillator') {
    this.id = id
  }

  async init(): Promise<void> {}
  scheduleNote(ev: ScheduledNote): void {
    this.scheduled.push(ev)
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
})
