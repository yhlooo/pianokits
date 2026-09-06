import { describe, expect, it, vi } from 'vitest'

import type { Song } from './model'
import type { AudioEngine, ScheduledNote } from './engine/types'
import { CONNECT_TIMEOUT_MS } from './midi/connection'
import { Transport, type TransportHost } from './transport'
import { PracticeController, type KeyFeedback } from './practice'

class FakeEngine implements AudioEngine {
  readonly id = 'oscillator' as const
  ready = true
  scheduled: ScheduledNote[] = []
  noteOns: Array<{ pitch: number; velocity: number }> = []
  noteOffs: number[] = []

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
  allNotesOff(): void {}
  setVolume(): void {}
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
}

function makeSong(): Song {
  const notes = [
    { pitch: 60, start: 0.5, end: 0.9, velocity: 100, trackIndex: 0 },
    { pitch: 64, start: 0.5, end: 0.9, velocity: 100, trackIndex: 0 },
    { pitch: 67, start: 0.5, end: 0.9, velocity: 100, trackIndex: 0 },
    { pitch: 62, start: 1.2, end: 1.5, velocity: 100, trackIndex: 1 },
  ]
  return {
    ppq: 480,
    duration: 1.5,
    tempos: [{ time: 0, bpm: 60 }],
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    keySignatures: [],
    tracks: [],
    notes,
    sustainEvents: [],
  }
}

/** 假 MIDIInput：记录监听器，测试内手动发送消息 */
class FakeInput {
  name = 'Test Keyboard'
  private listeners = new Set<(e: { data: Uint8Array | null }) => void>()

  addEventListener(_type: string, cb: (e: { data: Uint8Array | null }) => void): void {
    this.listeners.add(cb)
  }
  removeEventListener(_type: string, cb: (e: { data: Uint8Array | null }) => void): void {
    this.listeners.delete(cb)
  }
  send(bytes: number[]): void {
    const data = Uint8Array.from(bytes)
    for (const cb of this.listeners) cb({ data })
  }
}

class FakeAccess {
  inputs = new Map<string, FakeInput>()
  private stateCbs = new Set<() => void>()
  addEventListener(_type: string, cb: () => void): void {
    this.stateCbs.add(cb)
  }
  removeEventListener(_type: string, cb: () => void): void {
    this.stateCbs.delete(cb)
  }
}

function stubNavigator(request: () => Promise<FakeAccess>): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { requestMIDIAccess: request },
    configurable: true,
  })
}

/** 反馈快照（Set → 排序数组，便于断言） */
const snap = (fb: KeyFeedback | null) =>
  fb === null
    ? null
    : { held: [...fb.held].sort((a, b) => a - b), wrong: [...fb.wrong].sort((a, b) => a - b) }

describe('PracticeController 编排', () => {
  it('连接 → 开练习 → 和弦等待 → 按错键红显且阻止 → 纠错后放行 → 断连强制退出', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => Promise.resolve(access))

    const statuses: string[] = []
    const uiStates: Array<{ attempting: boolean; deviceLabel: string | null }> = []
    const practices: boolean[] = []
    const feedbacks: ReturnType<typeof snap>[] = []
    const errors: string[] = []
    const c = new PracticeController({
      transport,
      callbacks: {
        onStatus: (ui) => {
          statuses.push(ui.status)
          uiStates.push({ attempting: ui.attempting, deviceLabel: ui.deviceLabel })
        },
        onPractice: (on) => practices.push(on),
        onFeedback: (fb) => feedbacks.push(snap(fb)),
        onConnectError: (m) => errors.push(m),
      },
    })
    // 构造期初始同步
    expect(statuses).toEqual(['idle'])
    expect(uiStates[0]).toEqual({ attempting: false, deviceLabel: null })
    expect(practices).toEqual([false])
    expect(feedbacks[0]).toBeNull()

    // 连接（无真实设备，用假 access）：status → connecting → connected
    c.toggleMidi()
    await vi.waitFor(() => expect(c.status).toBe('connected'))
    expect(practices).toEqual([false]) // 连接不触发练习开关变化
    expect(uiStates.at(-1)).toEqual({ attempting: false, deviceLabel: 'Test Keyboard' })
    expect(errors).toHaveLength(0)

    // 非练习模式：按键直达引擎（实时演奏）
    input.send([0x90, 72, 80])
    input.send([0x80, 72, 0])
    expect(engine.noteOns).toEqual([{ pitch: 72, velocity: 80 }])
    expect(engine.noteOffs).toEqual([72])

    // 开练习
    c.togglePractice()
    expect(c.practice).toBe(true)
    expect(practices).toEqual([false, true])
    expect(transport.practiceMode).toBe(true)

    transport.load(makeSong())
    transport.play()
    host.advance(0.55)
    host.fireTicks()
    // 等待中：引擎没有发声
    expect(engine.scheduled).toHaveLength(0)

    // 依次按对两个键：不触发、不标红
    input.send([0x90, 60, 100])
    input.send([0x90, 64, 100])
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [60, 64], wrong: [] })

    // 按错键：红显、阻止触发
    input.send([0x90, 62, 100])
    expect(feedbacks.at(-1)).toEqual({ held: [60, 62, 64], wrong: [62] })
    input.send([0x90, 67, 100])
    expect(engine.scheduled).toHaveLength(0) // 错键仍按住 → 不触发

    // 松开错键：条件齐备 → 立即放行（按原曲时值/力度发声）
    input.send([0x80, 62, 0])
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 64, 67])
    expect(engine.scheduled.every((n) => n.time === 0.55)).toBe(true)
    expect(feedbacks.at(-1)).toEqual({ held: [60, 64, 67], wrong: [] })

    // 继续推进：下一和弦进入等待
    host.advance(0.7) // pos = 1.25 >= 1.2
    host.fireTicks()
    input.send([0x90, 62, 100])
    expect(engine.scheduled.map((n) => n.pitch)).toEqual([60, 64, 67, 62])
    expect(feedbacks.at(-1)).toEqual({ held: [60, 62, 64, 67], wrong: [] })

    // 断开 MIDI：强制退出练习模式、反馈清空
    c.toggleMidi()
    await vi.waitFor(() => expect(c.status).toBe('idle'))
    expect(c.practice).toBe(false)
    expect(transport.practiceMode).toBe(false)
    expect(practices).toEqual([false, true, false])
    expect(feedbacks.at(-1)).toBeNull()
    c.dispose()
  })

  it('未连接时 togglePractice 无效', () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    stubNavigator(() => Promise.resolve(new FakeAccess()))
    const c = new PracticeController({
      transport,
      callbacks: {
        onStatus: () => {},
        onPractice: () => {},
        onFeedback: () => {},
        onConnectError: () => {},
      },
    })
    c.togglePractice()
    expect(c.practice).toBe(false)
    expect(transport.practiceMode).toBe(false)
    c.dispose()
  })

  it('连接尝试中再次点击 = 取消：回到 idle，在途结果作废', () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    let resolveAccess!: (access: FakeAccess) => void
    stubNavigator(
      () =>
        new Promise<FakeAccess>((resolve) => {
          resolveAccess = resolve
        }),
    )
    const uiStates: Array<{ status: string; attempting: boolean }> = []
    const errors: string[] = []
    const c = new PracticeController({
      transport,
      callbacks: {
        onStatus: (ui) => uiStates.push({ status: ui.status, attempting: ui.attempting }),
        onPractice: () => {},
        onFeedback: () => {},
        onConnectError: (m) => errors.push(m),
      },
    })
    c.toggleMidi()
    expect(c.status).toBe('connecting')
    expect(uiStates.at(-1)).toEqual({ status: 'connecting', attempting: true })
    c.toggleMidi() // 取消
    expect(c.status).toBe('idle')
    expect(uiStates.at(-1)).toEqual({ status: 'idle', attempting: false })
    expect(errors).toHaveLength(0) // 主动取消不报错
    // 迟到的授权结果作废
    const access = new FakeAccess()
    access.inputs.set('1', new FakeInput())
    resolveAccess(access)
    c.dispose()
  })

  it('5s 内未连上：超时报错、按钮状态恢复未连接', async () => {
    vi.useFakeTimers()
    try {
      const transport = new Transport(new FakeEngine(), new FakeHost())
      stubNavigator(() => new Promise<FakeAccess>(() => {})) // 永不 resolve
      const uiStates: Array<{ status: string; attempting: boolean }> = []
      const errors: string[] = []
      const c = new PracticeController({
        transport,
        callbacks: {
          onStatus: (ui) => uiStates.push({ status: ui.status, attempting: ui.attempting }),
          onPractice: () => {},
          onFeedback: () => {},
          onConnectError: (m) => errors.push(m),
        },
      })
      c.toggleMidi()
      expect(uiStates.at(-1)).toEqual({ status: 'connecting', attempting: true })
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(c.status).toBe('timeout')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('超时')
      // 按钮恢复未连接：attempting 结束
      expect(uiStates.at(-1)).toEqual({ status: 'timeout', attempting: false })
      c.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('授权被拒：立即报错', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    stubNavigator(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    const errors: string[] = []
    const c = new PracticeController({
      transport,
      callbacks: {
        onStatus: () => {},
        onPractice: () => {},
        onFeedback: () => {},
        onConnectError: (m) => errors.push(m),
      },
    })
    c.toggleMidi()
    await vi.waitFor(() => expect(c.status).toBe('denied'))
    expect(errors).toEqual(['MIDI 授权被拒绝'])
    c.dispose()
  })
})
