import { afterEach, describe, expect, it } from 'vitest'

import { RecorderController, type RecorderHost, type RecorderUiState } from './recorder'

/** 假 MIDIInput：记录监听器，测试内手动发送消息 */
class FakeInput {
  name = 'Test Keyboard'
  manufacturer = 'Test'
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

/** 假 MIDIOutput：记录 send/clear（回放与回送的目标） */
class FakeOutput {
  sent: Array<{ data: number[]; ts: number | undefined }> = []
  clearCount = 0
  send(data: number[], ts?: number): void {
    this.sent.push({ data: [...data], ts })
  }
  clear(): void {
    this.clearCount++
  }
  /** 按状态字节高 4 位取消息（0x90 音符开 / 0x80 音符关 / 0xb0 CC） */
  byStatus(status: number): Array<{ data: number[]; ts: number | undefined }> {
    return this.sent.filter((m) => (m.data[0] & 0xf0) === status)
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
  fireStateChange(): void {
    for (const cb of this.stateCbs) cb()
  }
}

/** 假时钟/定时器宿主：手动推进时间、手动触发 tick */
class FakeHost implements RecorderHost {
  private time = 1000
  private timers = new Map<number, () => void>()
  private nextId = 1

  now(): number {
    return this.time
  }
  setInterval(cb: () => void): number {
    const id = this.nextId++
    this.timers.set(id, cb)
    return id
  }
  clearInterval(id: number): void {
    this.timers.delete(id)
  }
  advance(sec: number): void {
    this.time += sec
  }
  tick(): void {
    for (const cb of [...this.timers.values()]) cb()
  }
  get tickerCount(): number {
    return this.timers.size
  }
}

function stubNavigator(access: FakeAccess): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { requestMIDIAccess: () => Promise.resolve(access) },
    configurable: true,
  })
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 音符快照（时间四舍五入到毫秒，避免浮点噪声影响断言） */
const snap = (notes: readonly { pitch: number; start: number; end: number }[]): number[][] =>
  notes.map((n) => [n.pitch, Math.round(n.start * 1000) / 1000, Math.round(n.end * 1000) / 1000])

interface Harness {
  controller: RecorderController
  host: FakeHost
  access: FakeAccess
  input: FakeInput
  output: FakeOutput
  states: RecorderUiState[]
}

const live: RecorderController[] = []

async function harness(): Promise<Harness> {
  const access = new FakeAccess()
  const input = new FakeInput()
  const output = new FakeOutput()
  access.inputs.set('in-1', input)
  access.outputs.set('out-1', output)
  stubNavigator(access)

  const states: RecorderUiState[] = []
  const host = new FakeHost()
  const controller = new RecorderController({
    callbacks: { onState: (s) => states.push(s) },
    host,
  })
  live.push(controller)
  controller.autoConnect()
  await flush()
  expect(controller.midiStatus).toBe('connected')
  return { controller, host, access, input, output, states }
}

afterEach(() => {
  for (const c of live.splice(0)) c.dispose()
})

describe('RecorderController：连接要求', () => {
  it('未连接 MIDI 键盘时播放/录制不可用；插入键盘后可用', async () => {
    const access = new FakeAccess() // 已授权但无输入设备（no-devices）
    stubNavigator(access)
    const host = new FakeHost()
    const states: RecorderUiState[] = []
    const controller = new RecorderController({
      callbacks: { onState: (s) => states.push(s) },
      host,
    })
    live.push(controller)

    controller.autoConnect()
    await flush()
    expect(controller.midiStatus).toBe('no-devices')
    expect(states[states.length - 1].midiConnected).toBe(false)

    controller.toggleRecord()
    controller.togglePlay()
    expect(controller.mode).toBe('idle')

    // 插入键盘（statechange）→ 自动连上，录制可用
    const input = new FakeInput()
    access.inputs.set('in-1', input)
    access.fireStateChange()
    expect(controller.midiStatus).toBe('connected')
    expect(states[states.length - 1].midiConnected).toBe(true)

    controller.toggleRecord()
    expect(controller.mode).toBe('recording')
    host.advance(0.2)
    input.send([0x90, 60, 100])
    host.advance(0.2)
    input.send([0x80, 60, 0])
    expect(controller.visibleNotes()).toHaveLength(1)
  })

  it('键盘拔出（statechange）自动暂停录制/回放', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.2)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.2)

    h.access.inputs.delete('in-1')
    h.access.fireStateChange()
    expect(h.controller.midiStatus).toBe('no-devices')
    expect(h.controller.mode).toBe('idle')
    // 按住的键在断开时刻收尾，音符保留
    expect(h.controller.visibleNotes()).toHaveLength(1)
    expect(h.controller.visibleNotes()[0].end).toBeCloseTo(0.4, 5)
  })
})

describe('RecorderController：录制', () => {
  it('按键 → 音符（音高/力度/通道/时值），松开后进音轨', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(1)
    h.input.send([0x93, 60, 100])
    expect(h.controller.pendingNotes()).toHaveLength(1)
    h.host.advance(0.5)
    h.input.send([0x80, 60, 0])

    expect(h.controller.pendingNotes()).toHaveLength(0)
    expect(h.controller.visibleNotes()).toHaveLength(1)
    const n = h.controller.visibleNotes()[0]
    expect(n.pitch).toBe(60)
    expect(n.velocity).toBe(100)
    expect(n.channel).toBe(3)
    expect(n.start).toBeCloseTo(1, 5)
    expect(n.end).toBeCloseTo(1.5, 5)
    expect(h.controller.duration).toBeCloseTo(1.5, 5)
  })

  it('按住不放：pendingNotes 一直画到当前录制线', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.3)
    h.input.send([0x90, 64, 80])
    h.host.advance(0.4)
    const pending = h.controller.pendingNotes()
    expect(pending).toHaveLength(1)
    expect(pending[0].start).toBeCloseTo(0.3, 5)
    expect(pending[0].end).toBeCloseTo(0.7, 5)
    expect(h.controller.visibleNotes()).toHaveLength(0)
  })

  it('同音高重复触发：前一个音符在第二次按下处收尾', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.input.send([0x90, 60, 100])
    h.host.advance(0.5)
    h.input.send([0x90, 60, 90])
    h.host.advance(0.5)
    h.input.send([0x80, 60, 0])

    expect(h.controller.visibleNotes().map((n) => [n.start, n.end, n.velocity])).toEqual([
      [0, 0.5, 100],
      [0.5, 1, 90],
    ])
  })

  it('同刻按下/松开也留出最短时值', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.5)
    h.input.send([0x90, 60, 100])
    h.input.send([0x80, 60, 0])
    expect(h.controller.visibleNotes()[0].end - h.controller.visibleNotes()[0].start).toBeCloseTo(
      0.02,
      5,
    )
  })

  it('暂停录制把按住的键收尾；再次录制从新位置继续', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.5)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.5)
    h.controller.toggleRecord() // 暂停录制
    expect(h.controller.mode).toBe('idle')
    expect(h.controller.visibleNotes()[0].end).toBeCloseTo(1, 5)

    h.host.advance(10) // 暂停期间时间流逝不录制
    h.controller.toggleRecord()
    h.host.advance(0.2)
    h.input.send([0x90, 62, 100])
    h.host.advance(0.2)
    h.input.send([0x80, 62, 0])
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.5, 1],
      [62, 1.2, 1.4],
    ])
  })

  it('回放中按录制：先暂停回放再进入录制', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.1)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.4)
    h.input.send([0x80, 60, 0])
    h.controller.toggleRecord()

    h.controller.togglePlay()
    expect(h.controller.mode).toBe('playing')
    h.controller.toggleRecord()
    expect(h.controller.mode).toBe('recording')
  })
})

describe('RecorderController：覆盖录制（录制线扫过的旧内容被抹除）', () => {
  /** 先录一条"旧音轨"：C4 [0,1]、E4 [2,3]，回到线位置 0 并清空输出记录 */
  function recordOldTake(h: Harness): void {
    h.controller.toggleRecord()
    h.input.send([0x90, 60, 100])
    h.host.advance(1)
    h.input.send([0x80, 60, 0])
    h.host.advance(1)
    h.input.send([0x90, 64, 100])
    h.host.advance(1)
    h.input.send([0x80, 64, 0])
    h.controller.toggleRecord() // 暂停：提交
    h.controller.beginScrub()
    h.controller.scrub(0)
    h.controller.endScrub()
    h.output.sent.length = 0
  }

  it('录制线没到的旧内容不抹除；扫过多少抹多少（渐进）', async () => {
    const h = await harness()
    recordOldTake(h)
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0, 1],
      [64, 2, 3],
    ])

    h.controller.toggleRecord() // 从 0 开始重新录（覆盖）
    h.host.advance(0.5)
    // 扫过 [0,0.5]：C4 只剩后半段，E4 完全没被扫到
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.5, 1],
      [64, 2, 3],
    ])

    h.host.advance(0.5)
    // 扫过 [0,1]：C4 被完全抹掉，E4 仍在
    expect(snap(h.controller.visibleNotes())).toEqual([[64, 2, 3]])

    h.host.advance(2.5)
    // 扫过 [0,3.5]：整条旧音轨都没了
    expect(h.controller.visibleNotes()).toHaveLength(0)
    expect(h.states[h.states.length - 1].hasNotes).toBe(true) // 仍在录制中

    h.controller.toggleRecord() // 暂停提交
    expect(h.controller.visibleNotes()).toHaveLength(0)
    // 暂不继续录制时不恢复播放（无内容）
    h.controller.togglePlay()
    expect(h.controller.mode).toBe('idle')
  })

  it('新录的音符写进被扫过的这一段，与未扫到的旧内容共存', async () => {
    const h = await harness()
    recordOldTake(h)
    h.controller.toggleRecord()
    h.host.advance(0.2)
    h.input.send([0x90, 67, 100])
    h.host.advance(0.3)
    h.input.send([0x80, 67, 0])
    h.controller.toggleRecord() // 在 0.5s 处暂停

    expect(snap(h.controller.visibleNotes())).toEqual([
      [67, 0.2, 0.5], // 新录的 G4（在被扫过的这一段里）
      [60, 0.5, 1], // 旧 C4 被扫掉前半段
      [64, 2, 3], // 没扫到的旧 E4
    ])
  })

  it('覆盖录制中导出：已抹除的部分不出现在导出内容里', async () => {
    const h = await harness()
    recordOldTake(h)
    h.controller.toggleRecord()
    h.host.advance(0.5)
    expect(snap(h.controller.exportNotes())).toEqual([
      [60, 0.5, 1],
      [64, 2, 3],
    ])
  })

  it('被整段扫过、两端没扫到的长音符：只抹中间被扫的部分（切成两段）', async () => {
    const h = await harness()
    // 旧音轨：一个 0~4s 的长音
    h.controller.toggleRecord()
    h.input.send([0x90, 60, 100])
    h.host.advance(4)
    h.input.send([0x80, 60, 0])
    h.controller.toggleRecord()
    h.controller.beginScrub()
    h.controller.scrub(1)
    h.controller.endScrub()

    // 从 1s 起录 1s（扫过 [1,2]）后暂停
    h.controller.toggleRecord()
    h.host.advance(1)
    h.controller.toggleRecord()
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0, 1],
      [60, 2, 4],
    ])
  })

  it('拖动结束覆盖录制：擦除只到拖动起点，松手后从新位置重新开始扫', async () => {
    const h = await harness()
    recordOldTake(h)
    h.controller.toggleRecord() // 从 0 起录制
    h.host.advance(0.4)
    h.controller.beginScrub() // 在 0.4s 处结束本次扫过
    h.controller.scrub(2) // 拖到 2s（拖动期间不录不擦）
    h.host.advance(1)
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.4, 1],
      [64, 2, 3],
    ])

    h.controller.endScrub() // 从 2s 重新开始扫
    h.host.advance(0.5)
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.4, 1],
      [64, 2.5, 3],
    ])
  })

  it('暂停止于音符中间：只抹掉扫过的一半', async () => {
    const h = await harness()
    recordOldTake(h)
    h.controller.toggleRecord()
    h.host.advance(0.6)
    h.controller.toggleRecord() // 0.6s 处暂停
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.6, 1],
      [64, 2, 3],
    ])
  })
})

describe('RecorderController：拖动音轨', () => {
  it('录制中拖动：拖动期间不录制，松手后从新位置继续', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.5)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.2)

    h.controller.beginScrub()
    h.controller.scrub(2)
    expect(h.controller.mode).toBe('recording')
    expect(h.controller.position).toBe(2)

    // 拖动期间（已松手前）按键不录制：位置不动
    h.host.advance(1)
    h.input.send([0x90, 62, 100])
    h.input.send([0x80, 62, 0])
    expect(snap(h.controller.visibleNotes())).toEqual([[60, 0.5, 0.7]])

    h.controller.endScrub()
    h.host.advance(0.3)
    h.input.send([0x90, 64, 100])
    h.host.advance(0.2)
    h.input.send([0x80, 64, 0])
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.5, 0.7],
      [64, 2.3, 2.5],
    ])
  })

  it('回放中拖动：挂起（不再排期）并在松手后从新位置继续', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.1)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.4)
    h.input.send([0x80, 60, 0])
    h.controller.toggleRecord()
    h.controller.beginScrub()
    h.controller.scrub(0)
    h.controller.endScrub()
    h.output.sent.length = 0 // 忽略录制期间的回送

    h.controller.togglePlay()
    h.host.advance(0.05)
    h.host.tick()
    expect(h.output.byStatus(0x90).map((m) => m.data)).toContainEqual([0x90, 60, 100])

    h.controller.beginScrub()
    h.controller.scrub(1)
    const sentWhileDragging = h.output.sent.length
    h.host.advance(0.5)
    h.host.tick()
    expect(h.output.sent.length).toBe(sentWhileDragging)
    expect(h.controller.mode).toBe('playing')

    h.controller.endScrub()
    // 新位置 1 > 音符结束 0.5：从线位置继续，不再补发已过音符
    h.host.tick()
    expect(h.output.byStatus(0x90)).toHaveLength(1)
  })
})

describe('RecorderController：回放', () => {
  /** 录一个 0.1~0.5s 的 C4（力度 100），把线拖回 0 并清空输出记录 */
  function recordOneNote(h: Harness): void {
    h.controller.toggleRecord()
    h.host.advance(0.1)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.4)
    h.input.send([0x80, 60, 0])
    h.controller.toggleRecord()
    h.controller.beginScrub()
    h.controller.scrub(0)
    h.controller.endScrub()
    h.output.sent.length = 0 // 忽略录制期间的回送与 Local Control
  }

  it('从录制/播放线位置开始，把音符排期到 MIDI 输出（键盘发声，本机不发声）', async () => {
    const h = await harness()
    recordOneNote(h)
    h.controller.togglePlay()
    expect(h.controller.mode).toBe('playing')
    h.host.advance(0.05)
    h.host.tick()

    const on = h.output.byStatus(0x90)
    const off = h.output.byStatus(0x80)
    expect(on).toHaveLength(1)
    expect(on[0].data).toEqual([0x90, 60, 100])
    expect(off).toHaveLength(1)
    expect(off[0].data).toEqual([0x80, 60, 0])
    // 时间戳即走带时钟：Note Off 比 Note On 晚一个时值（0.4s = 400ms）
    expect((off[0].ts ?? 0) - (on[0].ts ?? 0)).toBeCloseTo(400, 1)
  })

  it('线位置之后的音符才发声；已开始的音符不补发', async () => {
    const h = await harness()
    recordOneNote(h)
    h.controller.beginScrub()
    h.controller.scrub(0.2)
    h.controller.endScrub()
    h.controller.togglePlay()
    h.host.tick()
    expect(h.output.byStatus(0x90)).toHaveLength(0)
  })

  it('暂停停止排期并止音；播到末尾自动暂停', async () => {
    const h = await harness()
    recordOneNote(h)
    h.controller.togglePlay()
    h.host.advance(0.05)
    h.host.tick()
    h.controller.togglePlay() // 暂停
    expect(h.controller.mode).toBe('idle')
    expect(h.output.byStatus(0xb0).some((m) => m.data[1] === 123)).toBe(true)

    h.controller.togglePlay() // 继续
    expect(h.controller.mode).toBe('playing')
    h.host.advance(2)
    h.host.tick()
    expect(h.controller.mode).toBe('idle')
    expect(h.controller.position).toBeCloseTo(0.5, 5)
  })

  it('播到末尾后再点播放：从头开始', async () => {
    const h = await harness()
    recordOneNote(h)
    h.controller.togglePlay()
    h.host.advance(2)
    h.host.tick()
    expect(h.controller.position).toBeCloseTo(0.5, 5)

    h.controller.togglePlay()
    expect(h.controller.position).toBeCloseTo(0, 5)
    expect(h.controller.mode).toBe('playing')
  })
})

describe('RecorderController：结束（清空）', () => {
  it('清空音轨、位置归零、止音并停表', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.2)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.2)
    h.input.send([0x80, 60, 0])
    h.output.sent.length = 0

    h.controller.clear()
    expect(h.controller.visibleNotes()).toHaveLength(0)
    expect(h.controller.position).toBe(0)
    expect(h.controller.mode).toBe('idle')
    expect(h.host.tickerCount).toBe(0)
    expect(h.output.byStatus(0xb0).some((m) => m.data[1] === 123)).toBe(true)
    expect(h.states[h.states.length - 1].hasNotes).toBe(false)
  })
})

describe('RecorderController：会话恢复', () => {
  it('restore：装载音符与线位置、回到空闲模式，可从该位置继续录制', async () => {
    const h = await harness()
    h.controller.restore([{ pitch: 60, velocity: 100, start: 0.2, end: 0.6, channel: 0 }], 1.5)
    expect(h.controller.mode).toBe('idle')
    expect(h.controller.position).toBeCloseTo(1.5, 5)
    expect(snap(h.controller.visibleNotes())).toEqual([[60, 0.2, 0.6]])
    expect(h.states[h.states.length - 1].hasNotes).toBe(true)

    // 线位置（1.5s）之后录制：新音符接在恢复的内容之后
    h.controller.toggleRecord()
    h.host.advance(0.3)
    h.input.send([0x90, 62, 100])
    h.host.advance(0.2)
    h.input.send([0x80, 62, 0])
    expect(snap(h.controller.visibleNotes())).toEqual([
      [60, 0.2, 0.6],
      [62, 1.8, 2],
    ])
  })

  it('restore：空音轨 + 位置 0 等同初始状态', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.5)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.2)
    h.input.send([0x80, 60, 0])
    h.controller.toggleRecord()

    h.controller.restore([], 0)
    expect(h.controller.visibleNotes()).toHaveLength(0)
    expect(h.controller.position).toBe(0)
    expect(h.controller.mode).toBe('idle')
    expect(h.states[h.states.length - 1].hasNotes).toBe(false)
  })
})

describe('RecorderController：导出快照', () => {
  it('录制中导出把尚未收尾的音符补到当前位置，但不改动走带状态', async () => {
    const h = await harness()
    h.controller.toggleRecord()
    h.host.advance(0.5)
    h.input.send([0x90, 60, 100])
    h.host.advance(0.25)

    const snapshot = h.controller.exportNotes()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].end).toBeCloseTo(0.75, 5)
    // 走带仍是录制中，音符尚未提交
    expect(h.controller.mode).toBe('recording')
    expect(h.controller.visibleNotes()).toHaveLength(0)
    expect(h.controller.pendingNotes()).toHaveLength(1)
  })
})
