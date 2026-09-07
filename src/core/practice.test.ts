import { describe, expect, it, vi } from 'vitest'

import type { Song } from './model'
import type { AudioEngine, ScheduledNote } from './engine/types'
import { CONNECT_HINT_MS } from './midi/connection'
import { Transport, type TransportHost } from './transport'
import {
  PracticeController,
  practiceTracksOf,
  type KeyFeedback,
  type PracticeUiState,
} from './practice'

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
    tracks: [
      { index: 0, name: 'Melody', channel: 0, instrument: 0, percussion: false, noteCount: 3 },
      { index: 1, name: 'Bass', channel: 1, instrument: 0, percussion: false, noteCount: 1 },
      { index: 2, name: 'Drums', channel: 9, instrument: 0, percussion: true, noteCount: 5 },
    ],
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

/** 假 MIDIOutput：记录 send/clear（镜像 sink 的目标） */
class FakeOutput {
  sent: number[][] = []
  clearCount = 0
  send(data: Uint8Array): void {
    this.sent.push([...data])
  }
  clear(): void {
    this.clearCount++
  }
}

class FakeAccess {
  inputs = new Map<string, FakeInput>()
  outputs = new Map<string, FakeOutput>()
  private stateCbs = new Set<() => void>()
  addEventListener(_type: string, cb: () => void): void {
    this.stateCbs.add(cb)
  }
  removeEventListener(_type: string, cb: () => void): void {
    this.stateCbs.delete(cb)
  }
  /** 模拟设备热插拔（statechange 事件） */
  fireStateChange(): void {
    for (const cb of this.stateCbs) cb()
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

/** 练习 UI 状态快照 */
const snapUi = (ui: PracticeUiState) => ({
  tracks: ui.tracks.map((t) => ({ ...t })),
  active: ui.active,
  allOn: ui.allOn,
})

/** 建立已连接的控制器（含输入设备；可选输出设备） */
async function connectController(
  transport: Transport,
  access: FakeAccess,
): Promise<{
  c: PracticeController
  input: FakeInput
  access: FakeAccess
  practices: ReturnType<typeof snapUi>[]
  feedbacks: ReturnType<typeof snap>[]
  errors: string[]
}> {
  const input = new FakeInput()
  access.inputs.set('1', input)
  stubNavigator(() => Promise.resolve(access))
  const practices: ReturnType<typeof snapUi>[] = []
  const feedbacks: ReturnType<typeof snap>[] = []
  const errors: string[] = []
  const c = new PracticeController({
    transport,
    audioCtx: { currentTime: 0 },
    callbacks: {
      onStatus: () => {},
      onPractice: (ui) => practices.push(snapUi(ui)),
      onFeedback: (fb) => feedbacks.push(snap(fb)),
      onConnectError: (m) => errors.push(m),
    },
  })
  c.autoConnect()
  await vi.waitFor(() => expect(c.status).toBe('connected'))
  return { c, input, access, practices, feedbacks, errors }
}

describe('practiceTracksOf', () => {
  it('只列出出现在播放事件流中的轨（打击乐轨与空轨排除），按曲目轨序', () => {
    const song = makeSong()
    expect(practiceTracksOf(song)).toEqual([
      { index: 0, name: 'Melody' },
      { index: 1, name: 'Bass' },
    ])
  })
})

describe('PracticeController 编排', () => {
  it('连接 → 全开练习 → 和弦等待 → 按错键红显且阻止 → 纠错后放行 → 拔出强制退出', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const access = new FakeAccess()
    const { c, input, practices, feedbacks, errors } = await connectController(transport, access)
    // 构造期初始同步
    expect(practices[0]).toEqual({ tracks: [], active: false, allOn: false })
    expect(feedbacks[0]).toBeNull()

    c.setTracks([
      { index: 0, name: 'T0' },
      { index: 1, name: 'T1' },
    ])
    expect(practices.at(-1)).toEqual({
      tracks: [
        { index: 0, name: 'T0', on: false },
        { index: 1, name: 'T1', on: false },
      ],
      active: false,
      allOn: false,
    })
    expect(errors).toHaveLength(0)

    // 非练习模式：按键直达引擎（实时演奏）
    input.send([0x90, 72, 80])
    input.send([0x80, 72, 0])
    expect(engine.noteOns).toEqual([{ pitch: 72, velocity: 80 }])
    expect(engine.noteOffs).toEqual([72])

    // 练习按钮：全关 → 全开
    c.togglePractice()
    expect(c.practiceActive).toBe(true)
    expect(practices.at(-1)?.active).toBe(true)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([0, 1])

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

    // 松开错键：条件齐备 → 立即放行（门控音符由回送发声，不排期到引擎）
    input.send([0x80, 62, 0])
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [60, 64, 67], wrong: [] })

    // 继续推进：下一和弦进入等待
    host.advance(0.7) // pos = 1.25 >= 1.2
    host.fireTicks()
    input.send([0x90, 62, 100])
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [60, 62, 64, 67], wrong: [] })

    // 拔出 MIDI 键盘：强制退出练习模式（清空分轨选择）、反馈清空
    access.inputs.clear()
    access.fireStateChange()
    await vi.waitFor(() => expect(c.status).toBe('no-devices'))
    expect(c.practiceActive).toBe(false)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([])
    expect(practices.at(-1)?.active).toBe(false)
    expect(feedbacks.at(-1)).toBeNull()
    c.dispose()
  })

  it('分轨开关：菜单多选，transport 门控集合同步', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    const { c, practices } = await connectController(transport, new FakeAccess())
    c.setTracks([
      { index: 0, name: 'T0' },
      { index: 1, name: 'T1' },
      { index: 2, name: 'T2' },
    ])
    c.toggleTrack(0)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([0])
    expect(practices.at(-1)).toEqual({
      tracks: [
        { index: 0, name: 'T0', on: true },
        { index: 1, name: 'T1', on: false },
        { index: 2, name: 'T2', on: false },
      ],
      active: true,
      allOn: false,
    })
    c.toggleTrack(2)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([0, 2])
    expect(practices.at(-1)?.active).toBe(true)
    // 再点已开的轨 → 关闭（多选互不影响）
    c.toggleTrack(0)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([2])
    // 不在列表内的轨忽略
    c.toggleTrack(9)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([2])
    c.toggleTrack(2)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([])
    expect(practices.at(-1)).toMatchObject({ active: false, allOn: false })
    c.dispose()
  })

  it('练习按钮语义：全关/部分开 → 全开；全开 → 全关', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    const { c, practices } = await connectController(transport, new FakeAccess())
    c.setTracks([
      { index: 0, name: 'T0' },
      { index: 1, name: 'T1' },
      { index: 2, name: 'T2' },
    ])
    c.togglePractice() // 全关 → 全开
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([0, 1, 2])
    expect(practices.at(-1)).toMatchObject({ active: true, allOn: true })
    c.toggleTrack(1) // 部分开
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([0, 2])
    c.togglePractice() // 部分开 → 全开
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([0, 1, 2])
    c.togglePractice() // 全开 → 全关
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([])
    expect(practices.at(-1)?.active).toBe(false)
    c.dispose()
  })

  it('换曲：轨列表更新，练习开关与新曲目轨号求交', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    const { c, practices } = await connectController(transport, new FakeAccess())
    c.setTracks([
      { index: 0, name: 'A0' },
      { index: 1, name: 'A1' },
    ])
    c.toggleTrack(0)
    c.toggleTrack(1)
    c.setTracks([
      { index: 1, name: 'B1' },
      { index: 2, name: 'B2' },
    ])
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([1])
    expect(practices.at(-1)?.tracks.map((t) => t.name)).toEqual(['B1', 'B2'])
    expect(practices.at(-1)?.active).toBe(true)
    expect(practices.at(-1)?.allOn).toBe(false)
    c.setTracks([{ index: 2, name: 'C2' }])
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([])
    expect(practices.at(-1)?.active).toBe(false)
    c.dispose()
  })

  it('开关练习自动暂停：togglePractice / toggleTrack 都会暂停播放', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    const { c } = await connectController(transport, new FakeAccess())
    c.setTracks([
      { index: 0, name: 'T0' },
      { index: 1, name: 'T1' },
    ])
    transport.load(makeSong())
    transport.play()
    expect(transport.state).toBe('playing')
    // 开练习 → 自动暂停
    c.togglePractice()
    expect(transport.state).toBe('paused')
    // 恢复播放后关练习 → 自动暂停
    transport.play()
    c.togglePractice()
    expect(transport.state).toBe('paused')
    // 恢复播放后菜单开关单轨 → 自动暂停
    transport.play()
    c.toggleTrack(0)
    expect(transport.state).toBe('paused')
    c.dispose()
  })

  it('练习开启时按下任意琴键：从暂停恢复播放，按键同时参与判定', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const { c, input, feedbacks } = await connectController(transport, new FakeAccess())
    c.setTracks([{ index: 0, name: 'T0' }])
    c.toggleTrack(0) // 开启练习（此时无曲目，自动暂停空操作）
    transport.load(makeSong())
    transport.play()
    host.advance(0.55)
    host.fireTicks()
    // 和弦等待中 → 暂停
    transport.pause()
    expect(transport.state).toBe('paused')
    // 按任意键（不在和弦内）→ 恢复播放
    input.send([0x90, 72, 100])
    expect(transport.state).toBe('playing')
    // 该键同时参与判定：按错红显、不触发
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [72], wrong: [72] })
    // 按对和弦全部琴键：错键仍按住 → 不触发
    input.send([0x90, 60, 100])
    input.send([0x90, 64, 100])
    input.send([0x90, 67, 100])
    expect(engine.scheduled).toHaveLength(0)
    // 松开错键 → 立即放行（门控音符由回送发声，不排期到引擎）
    input.send([0x80, 72, 0])
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [60, 64, 67], wrong: [] })
    c.dispose()
  })

  it('长音符重复按：瀑布流上仍在键盘期间再按不判错、不重复触发', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const { c, input, feedbacks } = await connectController(transport, new FakeAccess())
    c.setTracks([
      { index: 0, name: 'T0' },
      { index: 1, name: 'T1' },
    ])
    c.togglePractice() // 全开
    const song: Song = {
      ppq: 480,
      duration: 1.5,
      tempos: [{ time: 0, bpm: 60 }],
      timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
      keySignatures: [],
      tracks: [
        { index: 0, name: 'T0', channel: 0, instrument: 0, percussion: false, noteCount: 1 },
        { index: 1, name: 'T1', channel: 1, instrument: 0, percussion: false, noteCount: 1 },
      ],
      notes: [
        { pitch: 62, start: 0.5, end: 1.5, velocity: 100, trackIndex: 0 }, // 长音符
        { pitch: 60, start: 0.8, end: 1.0, velocity: 100, trackIndex: 1 }, // 短和弦
      ],
      sustainEvents: [],
    }
    transport.load(song)
    transport.play()
    host.advance(0.55)
    host.fireTicks()
    // 触发长音符（门控音符由回送发声，不排期到引擎）
    input.send([0x90, 62, 100])
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [62], wrong: [] })

    // 推进到第二个和弦（60 @ 0.8）：长音符仍在键盘上
    host.advance(0.3) // now = 0.85 → pos = 0.8
    host.fireTicks()
    // 松开再按长音符键：不判错、不重复触发
    input.send([0x80, 62, 0])
    input.send([0x90, 62, 100])
    expect(feedbacks.at(-1)).toEqual({ held: [62], wrong: [] })
    expect(engine.scheduled).toHaveLength(0)
    // 按对短和弦键触发（不排期到引擎）
    input.send([0x90, 60, 100])
    expect(engine.scheduled).toHaveLength(0)
    c.dispose()
  })

  it('分轨练习：按下非练习轨的同 onset 音符不判错、不阻止练习轨触发', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const { c, input, feedbacks } = await connectController(transport, new FakeAccess())
    c.setTracks([
      { index: 0, name: 'T0' },
      { index: 1, name: 'T1' },
    ])
    c.toggleTrack(0) // 只练习 track 0
    const song: Song = {
      ppq: 480,
      duration: 1.0,
      tempos: [{ time: 0, bpm: 60 }],
      timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
      keySignatures: [],
      tracks: [
        { index: 0, name: 'T0', channel: 0, instrument: 0, percussion: false, noteCount: 1 },
        { index: 1, name: 'T1', channel: 1, instrument: 0, percussion: false, noteCount: 1 },
      ],
      notes: [
        { pitch: 60, start: 0.5, end: 0.8, velocity: 100, trackIndex: 0 }, // 练习轨
        { pitch: 64, start: 0.5, end: 0.8, velocity: 100, trackIndex: 1 }, // 非练习轨（同 onset）
      ],
      sustainEvents: [],
    }
    transport.load(song)
    transport.play()
    host.advance(0.55)
    host.fireTicks()
    // 非练习轨音符：不判错
    input.send([0x90, 64, 100])
    expect(feedbacks.at(-1)).toEqual({ held: [64], wrong: [] })
    // 练习轨和弦键：触发（门控音符由回送发声，不排期到引擎；同 onset 非练习轨下一 tick 排期）
    input.send([0x90, 60, 100])
    expect(engine.scheduled).toHaveLength(0)
    expect(feedbacks.at(-1)).toEqual({ held: [60, 64], wrong: [] })
    c.dispose()
  })

  it('连接不影响播放状态；设备拔出自动暂停并清空练习开关', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    const { c, access } = await connectController(transport, new FakeAccess())
    transport.load(makeSong())
    // 已连接状态播放；连接过程本身不触碰播放状态
    transport.play()
    expect(transport.state).toBe('playing')
    // 设备拔出（statechange 后无输入设备）→ 自动暂停并清空练习开关
    c.setTracks([{ index: 0, name: 'T0' }])
    c.toggleTrack(0) // 开练习（自动暂停）
    expect(transport.state).toBe('paused')
    transport.play()
    access.inputs.clear()
    access.fireStateChange()
    await vi.waitFor(() => expect(c.status).toBe('no-devices'))
    expect(transport.state).toBe('paused')
    expect(c.practiceActive).toBe(false)
    expect([...transport.practiceTracks]).toEqual([])
    c.dispose()
  })

  it('未连接时 togglePractice / toggleTrack 无效', () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    stubNavigator(() => Promise.resolve(new FakeAccess()))
    const practices: ReturnType<typeof snapUi>[] = []
    const c = new PracticeController({
      transport,
      audioCtx: { currentTime: 0 },
      callbacks: {
        onStatus: () => {},
        onPractice: (ui) => practices.push(snapUi(ui)),
        onFeedback: () => {},
        onConnectError: () => {},
      },
    })
    c.setTracks([{ index: 0, name: 'T0' }])
    c.toggleTrack(0)
    c.togglePractice()
    expect(c.practiceActive).toBe(false)
    expect([...transport.practiceTracks].sort((a, b) => a - b)).toEqual([])
    expect(practices.at(-1)).toMatchObject({ active: false, allOn: false })
    c.dispose()
  })

  it('授权成功但无设备（no-devices）：静默，不弹报错', async () => {
    const transport = new Transport(new FakeEngine(), new FakeHost())
    stubNavigator(() => Promise.resolve(new FakeAccess()))
    const errors: string[] = []
    const c = new PracticeController({
      transport,
      audioCtx: { currentTime: 0 },
      callbacks: {
        onStatus: () => {},
        onPractice: () => {},
        onFeedback: () => {},
        onConnectError: (m) => errors.push(m),
      },
    })
    c.autoConnect()
    await vi.waitFor(() => expect(c.status).toBe('no-devices'))
    expect(errors).toHaveLength(0) // 无设备是正常等待态，不报错
    c.dispose()
  })

  it('connecting 长期未落定：软提示经 MidiUiState 呈现，不弹报错', async () => {
    vi.useFakeTimers()
    try {
      const transport = new Transport(new FakeEngine(), new FakeHost())
      stubNavigator(() => new Promise<FakeAccess>(() => {})) // 永不 resolve
      const uiStates: Array<{ status: string; connectingHint: string | null }> = []
      const errors: string[] = []
      const c = new PracticeController({
        transport,
        audioCtx: { currentTime: 0 },
        callbacks: {
          onStatus: (ui) => uiStates.push({ status: ui.status, connectingHint: ui.connectingHint }),
          onPractice: () => {},
          onFeedback: () => {},
          onConnectError: (m) => errors.push(m),
        },
      })
      c.autoConnect()
      expect(c.status).toBe('connecting')
      expect(uiStates.at(-1)).toEqual({ status: 'connecting', connectingHint: null })
      await vi.advanceTimersByTimeAsync(CONNECT_HINT_MS)
      expect(c.status).toBe('connecting') // 状态保持 connecting，不进入失败终态
      expect(uiStates.at(-1)?.connectingHint).toContain('超时')
      expect(errors).toHaveLength(0) // 软提示不弹报错
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
      audioCtx: { currentTime: 0 },
      callbacks: {
        onStatus: () => {},
        onPractice: () => {},
        onFeedback: () => {},
        onConnectError: (m) => errors.push(m),
      },
    })
    c.autoConnect()
    await vi.waitFor(() => expect(c.status).toBe('denied'))
    expect(errors).toEqual(['MIDI 授权被拒绝'])
    c.dispose()
  })

  it('有输出端口：走带排期同步镜像到键盘音源；拔出后解除镜像', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const access = new FakeAccess()
    const output = new FakeOutput()
    access.outputs.set('o1', output)
    const { c } = await connectController(transport, access)

    // 播放：3 个和弦音符同时排入引擎与输出端口（Note On ×3 + Note Off ×3）
    transport.load(makeSong())
    transport.play()
    host.advance(0.45)
    host.fireTicks()
    expect(engine.scheduled).toHaveLength(3)
    const noteOns = output.sent.filter((d) => d[0] === 0x90)
    const noteOffs = output.sent.filter((d) => d[0] === 0x80)
    expect(noteOns.map((d) => d[1])).toEqual([60, 64, 67])
    expect(noteOns.map((d) => d[2])).toEqual([100, 100, 100])
    expect(noteOffs.map((d) => d[1])).toEqual([60, 64, 67])

    // 拔出键盘（输入+输出端口同时消失）：镜像解除、静默输出（清队列 + 全音符止音）
    // 并恢复键盘 Local Control On
    const sentBefore = output.sent.length
    access.inputs.clear()
    access.outputs.clear()
    access.fireStateChange()
    await vi.waitFor(() => expect(c.status).toBe('no-devices'))
    expect(output.clearCount).toBeGreaterThan(0)
    // 拔出后新排期不再镜像
    transport.play()
    host.advance(0.1)
    host.fireTicks()
    expect(output.sent.length).toBe(sentBefore + 33) // 32 = 16 通道 CC123 + CC120 + 1 Local Control On
    c.dispose()
  })

  it('练习模式：按键回送到键盘音源并驱动电脑引擎（力度=按键力度，弹错的音也发声）', async () => {
    const engine = new FakeEngine()
    const host = new FakeHost()
    const transport = new Transport(engine, host)
    const access = new FakeAccess()
    const output = new FakeOutput()
    access.outputs.set('o1', output)
    const { c, input } = await connectController(transport, access)
    c.setTracks([{ index: 0, name: 'T0' }])
    c.toggleTrack(0) // 开练习
    transport.load(makeSong())
    transport.play()
    host.advance(0.55)
    host.fireTicks()
    // 首条为 Local Control Off；其后是练习按键的回送
    expect(output.sent[0]).toEqual([0xb0, 122, 0])
    const echoStart = output.sent.length

    // 按对和弦键（力度 50，区别于曲中原力度 100）：回送 noteOn 用按键力度
    input.send([0x90, 60, 50])
    expect(output.sent.slice(echoStart)).toEqual([[0x90, 60, 50]])

    // 按错键：同样回送发声（弹错的音也发声，不因判错而静默）
    input.send([0x90, 99, 64])
    expect(output.sent.slice(echoStart + 1)).toEqual([[0x90, 99, 64]])

    // 松开错键：回送 noteOff
    input.send([0x80, 99, 0])
    expect(output.sent.slice(echoStart + 2)).toEqual([[0x80, 99, 0]])

    // 练习模式下按键同时驱动电脑引擎（力度=按键力度），门控轨仍不排期
    expect(engine.scheduled).toHaveLength(0)
    expect(engine.noteOns).toEqual([
      { pitch: 60, velocity: 50 },
      { pitch: 99, velocity: 64 },
    ])
    expect(engine.noteOffs).toEqual([99])
    c.dispose()
  })
})
