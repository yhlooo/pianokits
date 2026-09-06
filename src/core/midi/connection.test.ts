import { describe, expect, it, vi } from 'vitest'

import { CONNECT_TIMEOUT_MS, MidiConnection } from './connection'

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

/** 以假 requestMIDIAccess 替换全局 navigator（本测试文件进程内生效） */
function stubNavigator(request: (() => Promise<FakeAccess>) | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: request === undefined ? {} : { requestMIDIAccess: request },
    configurable: true,
  })
}

const NOTE_ON_C4 = Uint8Array.from([0x90, 60, 100])
const NOTE_OFF_C4 = Uint8Array.from([0x80, 60, 0])

describe('MidiConnection 接入层', () => {
  it('成功授权但无输入设备 → connecting 后进入 no-devices', async () => {
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

    stubNavigator(() => Promise.reject(new DOMException('nope', 'NotSupportedError')))
    const c2 = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c2.connect()
    expect(c2.status).toBe('unsupported')
    expect(statuses).toEqual(['connecting', 'denied'])
  })

  it('浏览器无 requestMIDIAccess → unsupported（不发起请求）', async () => {
    stubNavigator(undefined)
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(c.status).toBe('unsupported')
  })

  it('disconnect：摘监听回 idle，不再派发按键', async () => {
    const access = new FakeAccess()
    const input = new FakeInput()
    access.inputs.set('1', input)
    stubNavigator(() => Promise.resolve(access))
    const notes: unknown[] = []
    const c = new MidiConnection({ onStatus: () => {}, onNote: (ev) => notes.push(ev) })
    await c.connect()
    c.disconnect()
    expect(c.status).toBe('idle')
    input.send(NOTE_ON_C4)
    expect(notes).toHaveLength(0)
  })

  it('热插拔：statechange 后重挂输入并刷新状态', async () => {
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

    // 设备全部拔出：老输入不再派发
    access.inputs.clear()
    access.fireStateChange()
    expect(c.status).toBe('no-devices')
    a.send(NOTE_ON_C4)
    b.send(NOTE_ON_C4)
    expect(notes).toHaveLength(1)
    c.dispose()
  })

  it('connect 期间 disconnect：丢弃迟到的授权结果', async () => {
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
    c.disconnect()
    expect(c.status).toBe('idle')
    const access = new FakeAccess()
    access.inputs.set('1', new FakeInput())
    resolveAccess(access)
    await pending
    // 迟到的授权被丢弃：状态保持 idle（未变成 connected）
    expect(c.status).toBe('idle')
  })
})

describe('MidiConnection 连接尝试（超时/取消/设备名）', () => {
  /** 冲刷微任务队列（让 await 的续体跑完） */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('已连接：attempting 结束、connectedLabel 为 厂商+名称', async () => {
    const access = new FakeAccess()
    access.inputs.set('1', new FakeInput())
    stubNavigator(() => Promise.resolve(access))
    const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
    await c.connect()
    expect(c.status).toBe('connected')
    expect(c.attempting).toBe(false)
    expect(c.connectedLabel).toBe('ACME Fake Keyboard')
    c.disconnect()
    expect(c.connectedLabel).toBeNull()
  })

  it('5s 内未连上 → timeout；迟到的授权结果作废、attempting 结束', async () => {
    vi.useFakeTimers()
    try {
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
      expect(c.attempting).toBe(true)
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(c.status).toBe('timeout')
      expect(c.attempting).toBe(false)
      // 迟到的授权结果（用户 5s 后才允许）被作废
      const access = new FakeAccess()
      const input = new FakeInput()
      access.inputs.set('1', input)
      resolveAccess(access)
      await flush()
      expect(c.status).toBe('timeout')
      expect(c.connectedLabel).toBeNull()
      await pending
      c.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('已授权无设备：5s 窗口内热插拔即连上（计时器清除，不再超时）', async () => {
    vi.useFakeTimers()
    try {
      const access = new FakeAccess()
      stubNavigator(() => Promise.resolve(access))
      const statuses: string[] = []
      const c = new MidiConnection({ onStatus: (s) => statuses.push(s), onNote: () => {} })
      const pending = c.connect()
      await flush()
      // 已授权但无设备：仍在尝试窗口内
      expect(c.status).toBe('no-devices')
      expect(c.attempting).toBe(true)
      // 窗口内插入设备 → connected，attempting 结束
      const input = new FakeInput()
      access.inputs.set('1', input)
      access.fireStateChange()
      expect(c.status).toBe('connected')
      expect(c.attempting).toBe(false)
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(c.status).toBe('connected')
      expect(statuses).not.toContain('timeout')
      await pending
      c.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('已授权无设备且窗口内未插入：超时 → timeout 并拆掉 access', async () => {
    vi.useFakeTimers()
    try {
      const access = new FakeAccess()
      stubNavigator(() => Promise.resolve(access))
      const c = new MidiConnection({ onStatus: () => {}, onNote: () => {} })
      const pending = c.connect()
      await flush()
      expect(c.status).toBe('no-devices')
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(c.status).toBe('timeout')
      expect(c.attempting).toBe(false)
      // access 已拆除：此后热插拔不再生效
      access.inputs.set('1', new FakeInput())
      access.fireStateChange()
      expect(c.status).toBe('timeout')
      await pending
      c.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('断开后重试：重连可再次成功', async () => {
    const access = new FakeAccess()
    access.inputs.set('1', new FakeInput())
    stubNavigator(() => Promise.resolve(access))
    const statuses: string[] = []
    const c = new MidiConnection({ onStatus: (s) => statuses.push(s), onNote: () => {} })
    await c.connect()
    c.disconnect()
    expect(c.status).toBe('idle')
    await c.connect()
    expect(c.status).toBe('connected')
    expect(statuses).toEqual(['connecting', 'connected', 'idle', 'connecting', 'connected'])
    c.disconnect()
  })

  it('输出端口快照随连接同步/热插拔刷新，断开时清空', async () => {
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
    // 断开：输出快照清空
    c.disconnect()
    expect(snapshots.at(-1)).toEqual([])
  })
})
