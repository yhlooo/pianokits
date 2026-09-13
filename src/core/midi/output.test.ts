import { describe, expect, it, vi } from 'vitest'

import { MidiOutputSink } from './output'

/** 假 MIDIOutput：记录 send/clear 调用 */
class FakeOutput {
  sent: Array<{ data: number[]; ts: number | undefined }> = []
  clearCount = 0

  send(data: number[], ts?: number): void {
    this.sent.push({ data: [...data], ts })
  }

  clear(): void {
    this.clearCount++
  }
}

describe('MidiOutputSink 播放镜像', () => {
  it('scheduleNote：Note On（力度钳制）+ 时值结束的 Note Off，时间戳按 AudioContext 时间换算', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 10 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0 // 忽略 Local Control 消息，只看音符
    vi.spyOn(performance, 'now').mockReturnValue(10000)
    // time 10.5 → ts = 10000 + 500 = 10500；duration 0.4 → off at 10900
    sink.scheduleNote({ pitch: 60, velocity: 100, time: 10.5, duration: 0.4 })
    expect(out.sent).toEqual([
      { data: [0x90, 60, 100], ts: 10500 },
      { data: [0x80, 60, 0], ts: 10900 },
    ])
    // 必须是普通 number[]（不是 Uint8Array）：shim 的 send() 对 Uint8Array 会经 JSON
    // 序列化成对象 {"0":…}，原生侧解析崩溃。toEqual 不区分两者，故显式断言。
    expect(Array.isArray(out.sent[0].data)).toBe(true)
    vi.restoreAllMocks()
    sink.dispose()
  })

  it('已过期的排期时间不带时间戳（立即发送）', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 10 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    vi.spyOn(performance, 'now').mockReturnValue(10000)
    sink.scheduleNote({ pitch: 64, velocity: 90, time: 9.0, duration: 0.5 })
    expect(out.sent).toEqual([
      { data: [0x90, 64, 90], ts: undefined },
      { data: [0x80, 64, 0], ts: undefined },
    ])
    vi.restoreAllMocks()
    sink.dispose()
  })

  it('Note On 已过期但音符尚未结束：Note Off 仍按结束时刻排期（不被立即切断）', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 10 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    vi.spyOn(performance, 'now').mockReturnValue(10000)
    // 起音 9.9（已过期 100ms）但时长 0.5 → 结束 10.4（未来 400ms）
    sink.scheduleNote({ pitch: 64, velocity: 90, time: 9.9, duration: 0.5 })
    expect(out.sent).toEqual([
      { data: [0x90, 64, 90], ts: undefined },
      { data: [0x80, 64, 0], ts: 10400 },
    ])
    vi.restoreAllMocks()
    sink.dispose()
  })

  it('力度钳制到 1~127', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    sink.scheduleNote({ pitch: 60, velocity: 0, time: 100, duration: 1 })
    sink.scheduleNote({ pitch: 62, velocity: 200, time: 100, duration: 1 })
    expect(out.sent[0].data[2]).toBe(1)
    expect(out.sent[2].data[2]).toBe(127)
    sink.dispose()
  })

  it('allNotesOff：清空未发送队列 + 16 通道 All Notes Off / All Sound Off + 三踏板复位', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    sink.allNotesOff()
    expect(out.clearCount).toBe(1)
    // 16 All Notes Off + 16 All Sound Off + 3 踏板 × 16 通道
    expect(out.sent).toHaveLength(32 + 48)
    const statuses = out.sent.map((s) => s.data[0])
    expect(statuses.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, ch) => 0xb0 | ch))
    expect(statuses.slice(16, 32)).toEqual(Array.from({ length: 16 }, (_, ch) => 0xb0 | ch))
    expect(out.sent.every((s) => s.ts === undefined)).toBe(true)
    for (const s of out.sent.slice(0, 16)) expect(s.data[1]).toBe(123)
    for (const s of out.sent.slice(16, 32)) expect(s.data[1]).toBe(120)
    // 踏板复位（CC67/66/64 = 0，16 通道各一份）：clear() 会丢掉未发送的踏板抬起，必须显式复位
    const pedalMsgs = out.sent.slice(32)
    expect(pedalMsgs.map((s) => s.data[1])).toEqual(
      [67, 66, 64].flatMap((cc) => Array.from({ length: 16 }, () => cc)),
    )
    for (const s of pedalMsgs) expect(s.data[2]).toBe(0)
    sink.dispose()
  })

  it('无输出端口时静默（不发送）；sync([]) 清空端口', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.scheduleNote({ pitch: 60, velocity: 100, time: 0, duration: 1 })
    expect(out.sent).toHaveLength(0)
    sink.sync([out as unknown as MIDIOutput])
    sink.sync([])
    out.sent.length = 0 // 忽略 Local Control 消息，只看音符
    sink.scheduleNote({ pitch: 60, velocity: 100, time: 0, duration: 1 })
    expect(out.sent).toHaveLength(0)
    sink.dispose()
  })

  it('sync 挂载端口时发送 Local Control Off（禁用键盘自带音源）', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    expect(out.sent).toEqual([{ data: [0xb0, 122, 0], ts: undefined }])
    sink.dispose()
  })

  it('sync([]) 清空端口前恢复 Local Control On；dispose 也恢复', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    sink.sync([])
    expect(out.sent).toEqual([{ data: [0xb0, 122, 127], ts: undefined }])
    // dispose：恢复 Local On 再静默（32 条 CC123/CC120 + 48 条踏板复位）
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    sink.dispose()
    expect(out.sent[0]).toEqual({ data: [0xb0, 122, 127], ts: undefined })
    expect(out.sent).toHaveLength(1 + 32 + 48)
  })

  it('Local Control Off 后仍正常镜像音符（键盘经 MIDI IN 发声）', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 10 })
    sink.sync([out as unknown as MIDIOutput])
    vi.spyOn(performance, 'now').mockReturnValue(10000)
    sink.scheduleNote({ pitch: 60, velocity: 100, time: 10.5, duration: 0.4 })
    // 首条为 Local Off，其后为 Note On / Note Off
    expect(out.sent[0]).toEqual({ data: [0xb0, 122, 0], ts: undefined })
    expect(out.sent[1]).toEqual({ data: [0x90, 60, 100], ts: 10500 })
    expect(out.sent[2]).toEqual({ data: [0x80, 60, 0], ts: 10900 })
    vi.restoreAllMocks()
    sink.dispose()
  })

  it('echoNote：noteOn/noteOff 原样（音高 + 力度 + 通道）回送到输出端口', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    sink.echoNote({ type: 'noteOn', channel: 0, pitch: 60, velocity: 50 })
    sink.echoNote({ type: 'noteOff', channel: 0, pitch: 60, velocity: 0 })
    expect(out.sent).toEqual([
      { data: [0x90, 60, 50], ts: undefined },
      { data: [0x80, 60, 0], ts: undefined },
    ])
    // 非 0 通道原样保留
    out.sent.length = 0
    sink.echoNote({ type: 'noteOn', channel: 3, pitch: 62, velocity: 80 })
    expect(out.sent).toEqual([{ data: [0x93, 62, 80], ts: undefined }])
    sink.dispose()
  })

  it('echoNote：无输出端口时为空操作', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.echoNote({ type: 'noteOn', channel: 0, pitch: 60, velocity: 50 })
    expect(out.sent).toHaveLength(0)
    sink.dispose()
  })

  it('scheduleControlChange：按 AudioContext 时间换算时间戳；已过期立即发送；数据是普通数组', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 10 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    vi.spyOn(performance, 'now').mockReturnValue(10000)
    sink.scheduleControlChange({ controller: 64, value: 127, time: 10.5 })
    expect(out.sent).toEqual([{ data: [0xb0, 64, 127], ts: 10500 }])
    expect(Array.isArray(out.sent[0].data)).toBe(true)
    // 非 0 通道与越界值：通道/控制器/值都钳制到合法字节
    sink.scheduleControlChange({ controller: 64, value: 0, time: 9.0, channel: 3 })
    expect(out.sent[1]).toEqual({ data: [0xb3, 64, 0], ts: undefined })
    sink.scheduleControlChange({ controller: 200, value: 300, time: 9.0, channel: 99 })
    expect(out.sent[2]).toEqual({ data: [0xbf, 127, 127], ts: undefined })
    vi.restoreAllMocks()
    sink.dispose()
  })

  it('scheduleControlChange / echoControl：无输出端口时为空操作', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.scheduleControlChange({ controller: 64, value: 127, time: 1 })
    sink.echoControl({ type: 'controlChange', channel: 0, controller: 64, value: 127 })
    expect(out.sent).toHaveLength(0)
    sink.dispose()
  })

  it('echoControl：原样（控制器 + 值 + 通道）立即回送，不受时间戳影响', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    out.sent.length = 0
    sink.echoControl({ type: 'controlChange', channel: 0, controller: 64, value: 127 })
    sink.echoControl({ type: 'controlChange', channel: 2, controller: 66, value: 0 })
    expect(out.sent).toEqual([
      { data: [0xb0, 64, 127], ts: undefined },
      { data: [0xb2, 66, 0], ts: undefined },
    ])
    sink.dispose()
  })
})
