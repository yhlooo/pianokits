import { describe, expect, it, vi } from 'vitest'

import { CONNECT_HINT_MS, MidiConnection } from './connection'

/** 假 MIDIInput：记录监听器，可模拟消息与热插拔 */
class FakeInput {
  name = 'Fake Keyboard'
  manufacturer = 'ACME'
  private listeners = new Set<(e: { data: Uint8Array | null }) => void>()

  addEventListener(_type: string, cb: (e: { data: Uint8Array | null }) => void): void {
    this.listeners.add(cb)
  }

  removeEventListener(_type: string, cb: (e: { data: Uint8Array | null }) => void): void {
    this.listeners.delete(cb)
  }

  send(data: Uint8Array | null): void {
    for (const cb of this.listeners) cb({ data })
  }
}

/** 假 MIDIOutput：最小实现（send/clear 由镜像 sink 调用） */
class FakeOutput {
  sent: number[][] = []
  send(data: Uint8Array): void {
    this.sent.push([...data])
  }
  clear(): void {}
}

/** 假 MIDIAccess：inputs/outputs Map + statechange 监听 */
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

/**
 * 模拟 Web MIDI shim（如 iPad 的 Web MIDI Browser / cordova-plugin-webmidi）的端口表：
 * 只有 `forEach` / `size`，`values()` 返回的迭代器**没有 Symbol.iterator**（不可 `for…of` /
 * 展开）。若实现里用 `for…of` / `[...values()]` 遍历会抛 TypeError，本假类用于守住该回归。
 */
class FakeShimPortMap<T> {
  private readonly items: readonly T[]

  constructor(items: readonly T[]) {
    this.items = items
  }

  get size(): number {
    return this.items.length
  }

  forEach(cb: (value: T) => void): void {
    for (const item of this.items) cb(item)
  }

  /** 故意返回不可迭代对象：`next()` 可用但无 `[Symbol.iterator]` */
  values(): { next(): { value: T | undefined; done: boolean } } {
    let index = 0
    const items = this.items
    return {
      next() {
        return index < items.length
          ? { value: items[index++], done: false }
          : { value: undefined, done: true }
      },
    }
  }
}

/** 模拟 Web MIDI shim 的 MIDIAccess：inputs/outputs 为非原生端口表（见 FakeShimPortMap） */
class FakeShimAccess {
  inputs = new FakeShimPortMap<FakeInput>([])
  outputs = new FakeShimPortMap<FakeOutput>([])
  private stateCbs = new Set<() => void>()

  addEventListener(_type: string, cb: () => void): void {
    this.stateCbs.add(cb)
  }

  removeEventListener(_type: string, cb: () => void): void {
    this.stateCbs.delete(cb)
  }
}

/** 以假 requestMIDIAccess 替换全局 navigator（本测试文件进程内生效） */
function stubNavigator(request: (() => Promise<FakeAccess>) | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: request === undefined ? {} : { requestMIDIAccess: request },
    configurable: true,
  })
}

const NOTE_ON_C4 = Uint8Array.from([0x90, 60, 100])
const NOTE_OFF_C4 = Uint8Array.from([0x80, 60, 0])
const CC64_DOWN = Uint8Array.from([0xb0, 64, 127])
const CC64_HALF = Uint8Array.from([0xb0, 64, 40])

/** 冲刷微任务队列（让 await 的续体跑完） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('MidiConnection 接入层', () => {
  it('成功授权但无输入设备 → connecting 后进入 no-devices（常驻，不超时）', async () => {
    const access = new FakeAccess()
    stubNavigator(() => Promise.resolve(access))
    const statuses: string[] = []
    const c = new MidiConnection({
      onStatus: (s) => statuses.push(s),
      onNote: () => {},
    })
    await c.connect()
    expect(statuses).toEqual(['connecting', 'no-devices'])
    expect(c.status).toBe('no-devices')
    expect(c.connectedLabels).toEqual([])
    c.dispose()
  })

  it('有输入设备 → connected；按键消息解码后回调 onNote', async () => {
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => Promise.resolve(access))
    const notes: unknown[] = []
    const c = new MidiConnection({ onStatus: () => {}, onNote: (ev) => notes.push(ev) })
    await c.connect()
    expect(c.status).toBe('connected')
    input.send(NOTE_ON_C4)
    input.send(NOTE_OFF_C4)
    expect(notes).toEqual([
      { type: 'noteOn', channel: 0, pitch: 60, velocity: 100 },
      { type: 'noteOff', channel: 0, pitch: 60, velocity: 0 },
    ])
    c.dispose()
  })

  it('授权被拒 → denied；不支持 → unsupported', async () => {
    stubNavigator(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    const statuses: string[] = []
    const c = new MidiConnection({ onStatus: (s) => statuses.push(s), onNote: () => {} })
    await c.connect()
    expect(c.status).toBe('denied')
    // 失败详情对诊断面板可见（错误名 + 请求发起时刻）
    expect(c.errorName).toBe('NotAllowedError')
    expect(c.errorMessage).toBe('denied')
    expect(c.requestStartedAt).not.toBeNull()

    stubNavigator(() => Promise.reject(new DOMException('nope', 'NotSupportedError')))
    const c2 = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c2.connect()
    expect(c2.status).toBe('unsupported')
    expect(c2.errorName).toBe('NotSupportedError')
    expect(statuses).toEqual(['connecting', 'denied'])
  })

  it('浏览器无 requestMIDIAccess → unsupported（不发起请求）', async () => {
    stubNavigator(undefined)
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(c.status).toBe('unsupported')
  })

  it('shim 端口表（无 Symbol.iterator）也能连上并同步输出快照', async () => {
    const input = new FakeInput()
    const out = new FakeOutput()
    const access = new FakeShimAccess()
    access.inputs = new FakeShimPortMap([input])
    access.outputs = new FakeShimPortMap([out])
    stubNavigator(() => Promise.resolve(access as unknown as FakeAccess))
    const notes: unknown[] = []
    const snapshots: unknown[][] = []
    const c = new MidiConnection({
      onStatus: () => {},
      onNote: (ev) => notes.push(ev),
      onOutputs: (outputs) => snapshots.push([...outputs]),
    })
    await c.connect()
    // 关键：即便端口表不可迭代（for…of / 展开会抛 TypeError），也照常连上
    expect(c.status).toBe('connected')
    expect(c.connectedLabels).toEqual(['ACME Fake Keyboard'])
    expect(snapshots.at(-1)).toEqual([out])
    input.send(NOTE_ON_C4)
    expect(notes).toEqual([{ type: 'noteOn', channel: 0, pitch: 60, velocity: 100 }])
    c.dispose()
  })

  it('connectedLabels：返回全部已连接键盘的 厂商+名称 列表', async () => {
    const access = new FakeAccess()
    const a = new FakeInput()
    const b = new FakeInput()
    b.name = 'Keyboard B'
    b.manufacturer = 'Yamaha'
    access.inputs.set('a', a)
    access.inputs.set('b', b)
    stubNavigator(() => Promise.resolve(access))
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(c.connectedLabels).toEqual(['ACME Fake Keyboard', 'Yamaha Keyboard B'])
    c.dispose()
  })

  it('热插拔：statechange 重挂输入并刷新状态；拔出再插入自动重连', async () => {
    const access = new FakeAccess()
    const a = new FakeInput()
    access.inputs.set('a', a)
    stubNavigator(() => Promise.resolve(access))
    const notes: unknown[] = []
    const statuses: string[] = []
    const c = new MidiConnection({
      onStatus: (s) => statuses.push(s),
      onNote: (ev) => notes.push(ev),
    })
    await c.connect()
    expect(c.status).toBe('connected')

    // 新设备插入：新输入被挂载，可收消息
    const b = new FakeInput()
    access.inputs.set('b', b)
    access.fireStateChange()
    expect(c.status).toBe('connected')
    b.send(NOTE_ON_C4)
    expect(notes).toHaveLength(1)

    // 设备全部拔出：老输入不再派发，进入 no-devices（access 仍常驻）
    access.inputs.clear()
    access.fireStateChange()
    expect(c.status).toBe('no-devices')
    a.send(NOTE_ON_C4)
    b.send(NOTE_ON_C4)
    expect(notes).toHaveLength(1)

    // 再插入：statechange 自动重连，无需再次 connect
    access.inputs.set('c', a)
    access.fireStateChange()
    expect(c.status).toBe('connected')
    a.send(NOTE_ON_C4)
    expect(notes).toHaveLength(2)
    c.dispose()
  })

  it('CC 消息解码后走 onControl，不混入 onNote；诊断 getter 反映端口数', async () => {
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => Promise.resolve(access))
    const notes: unknown[] = []
    const controls: unknown[] = []
    const c = new MidiConnection({
      onStatus: () => {},
      onNote: (ev) => notes.push(ev),
      onControl: (ev) => controls.push(ev),
    })
    expect(c.inputCount).toBe(0)
    await c.connect()
    expect(c.inputCount).toBe(1)
    input.send(NOTE_ON_C4)
    input.send(CC64_DOWN)
    input.send(CC64_HALF)
    expect(notes).toEqual([{ type: 'noteOn', channel: 0, pitch: 60, velocity: 100 }])
    expect(controls).toEqual([
      { type: 'controlChange', channel: 0, controller: 64, value: 127 },
      { type: 'controlChange', channel: 0, controller: 64, value: 40 },
    ])
    c.dispose()
    expect(c.inputCount).toBe(0)
  })

  it('未实现 onControl 时不抛错（练习模式只关心按键）', async () => {
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => Promise.resolve(access))
    const notes: unknown[] = []
    const c = new MidiConnection({ onStatus: () => {}, onNote: (ev) => notes.push(ev) })
    await c.connect()
    expect(() => input.send(CC64_DOWN)).not.toThrow()
    expect(notes).toEqual([])
    c.dispose()
  })

  it('dispose：摘监听回 idle，不再派发按键', async () => {
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => Promise.resolve(access))
    const notes: unknown[] = []
    const c = new MidiConnection({ onStatus: () => {}, onNote: (ev) => notes.push(ev) })
    await c.connect()
    c.dispose()
    expect(c.status).toBe('idle')
    input.send(NOTE_ON_C4)
    expect(notes).toHaveLength(0)
  })

  it('reconnect：作废旧请求并立刻发起新请求（调试页“重试连接”）', async () => {
    let calls = 0
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => {
      calls++
      return Promise.resolve(access)
    })
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(calls).toBe(1)
    await c.reconnect()
    expect(calls).toBe(2)
    expect(c.status).toBe('connected')
    c.dispose()
  })

  it('connect 期间 dispose：丢弃迟到的授权结果', async () => {
    let resolveAccess!: (access: FakeAccess) => void
    stubNavigator(
      () =>
        new Promise<FakeAccess>((resolve) => {
          resolveAccess = resolve
        }),
    )
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    const pending = c.connect()
    expect(c.status).toBe('connecting')
    c.dispose()
    expect(c.status).toBe('idle')
    const access = new FakeAccess()
    access.inputs.set('1', new FakeInput())
    resolveAccess(access)
    await pending
    // 迟到的授权被丢弃：状态保持 idle（未变成 connected）
    expect(c.status).toBe('idle')
  })
})

describe('MidiConnection 自动连接（常驻 access / 软提示 / 重试）', () => {
  it('授权后无设备：no-devices 常驻，超过提示阈值也不超时、不拆 access', async () => {
    vi.useFakeTimers()
    try {
      const access = new FakeAccess()
      stubNavigator(() => Promise.resolve(access))
      const statuses: string[] = []
      const c = new MidiConnection({ onStatus: (s) => statuses.push(s), onNote: () => {} })
      await c.connect()
      expect(c.status).toBe('no-devices')
      await vi.advanceTimersByTimeAsync(CONNECT_HINT_MS * 2)
      expect(c.status).toBe('no-devices')
      expect(statuses).not.toContain('timeout')
      // 插入设备 → statechange → connected
      access.inputs.set('1', new FakeInput())
      access.fireStateChange()
      expect(c.status).toBe('connected')
      c.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('connecting 超过提示阈值 → connectingHint 软提示，状态仍 connecting；晚到结果按真实状态呈现', async () => {
    vi.useFakeTimers()
    try {
      let resolveAccess!: (access: FakeAccess) => void
      stubNavigator(
        () =>
          new Promise<FakeAccess>((resolve) => {
            resolveAccess = resolve
          }),
      )
      const statuses: string[] = []
      const c = new MidiConnection({ onStatus: (s) => statuses.push(s), onNote: () => {} })
      const pending = c.connect()
      expect(c.status).toBe('connecting')
      expect(c.connectingHint).toBeNull()
      await vi.advanceTimersByTimeAsync(CONNECT_HINT_MS)
      expect(c.status).toBe('connecting')
      expect(c.connectingHint).toContain('超时')
      // 晚到的授权结果仍按真实状态呈现：有设备 → connected，软提示清除
      const access = new FakeAccess()
      access.inputs.set('1', new FakeInput())
      resolveAccess(access)
      await flush()
      expect(c.status).toBe('connected')
      expect(c.connectingHint).toBeNull()
      await pending
      c.dispose()
      expect(statuses).not.toContain('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('denied 后重试：connect 可再次发起并成功', async () => {
    stubNavigator(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(c.status).toBe('denied')
    // 授权改回成功 + 有设备，重试连上
    const access = new FakeAccess()
    access.inputs.set('1', new FakeInput())
    stubNavigator(() => Promise.resolve(access))
    await c.connect()
    expect(c.status).toBe('connected')
    c.dispose()
  })

  it('connected / no-devices 下再次 connect 幂等（不重复请求）', async () => {
    let calls = 0
    const access = new FakeAccess()
    stubNavigator(() => {
      calls++
      return Promise.resolve(access)
    })
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(c.status).toBe('no-devices')
    await c.connect()
    expect(calls).toBe(1)
    c.dispose()
  })

  it('输出端口快照随连接同步/热插拔刷新，dispose 时清空', async () => {
    const access = new FakeAccess()
    const out = new FakeOutput()
    access.outputs.set('o1', out)
    access.inputs.set('1', new FakeInput())
    stubNavigator(() => Promise.resolve(access))
    const snapshots: unknown[][] = []
    const c = new MidiConnection({
      onStatus: () => {},
      onNote: () => {},
      onOutputs: (outputs) => snapshots.push([...outputs]),
    })
    await c.connect()
    expect(snapshots.at(-1)).toEqual([out])
    // 热插拔：新输出端口被快照
    const out2 = new FakeOutput()
    access.outputs.set('o2', out2)
    access.fireStateChange()
    expect(snapshots.at(-1)).toEqual([out, out2])
    // 销毁：输出快照清空
    c.dispose()
    expect(snapshots.at(-1)).toEqual([])
  })
})
