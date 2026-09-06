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
    sink.scheduleNote({ pitch: 60, velocity: 0, time: 100, duration: 1 })
    sink.scheduleNote({ pitch: 62, velocity: 200, time: 100, duration: 1 })
    expect(out.sent[0].data[2]).toBe(1)
    expect(out.sent[2].data[2]).toBe(127)
    sink.dispose()
  })

  it('allNotesOff：清空未发送队列 + 16 通道 All Notes Off / All Sound Off', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.sync([out as unknown as MIDIOutput])
    sink.allNotesOff()
    expect(out.clearCount).toBe(1)
    expect(out.sent).toHaveLength(32)
    const statuses = out.sent.map((s) => s.data[0])
    expect(statuses.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, ch) => 0xb0 | ch))
    expect(statuses.slice(16)).toEqual(Array.from({ length: 16 }, (_, ch) => 0xb0 | ch))
    expect(out.sent.every((s) => s.ts === undefined)).toBe(true)
    for (const s of out.sent.slice(0, 16)) expect(s.data[1]).toBe(123)
    for (const s of out.sent.slice(16)) expect(s.data[1]).toBe(120)
    sink.dispose()
  })

  it('无输出端口时静默（不发送）；sync([]) 清空端口', () => {
    const out = new FakeOutput()
    const sink = new MidiOutputSink({ currentTime: 0 })
    sink.scheduleNote({ pitch: 60, velocity: 100, time: 0, duration: 1 })
    expect(out.sent).toHaveLength(0)
    sink.sync([out as unknown as MIDIOutput])
    sink.sync([])
    sink.scheduleNote({ pitch: 60, velocity: 100, time: 0, duration: 1 })
    expect(out.sent).toHaveLength(0)
    sink.dispose()
  })
})
