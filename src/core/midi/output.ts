import type { ScheduledNote } from '../engine/types'

/** lib.dom 尚未收录 clear() 方法（Web MIDI 规范自 Chrome 43 起支持），本地补全类型 */
interface MidiOutputExt extends MIDIOutput {
  /** 清空尚未发送的排期消息队列 */
  clear(): void
}

const ALL_CHANNELS = 16

/**
 * 把走带排期的音符同步镜像到 MIDI 输出端口（键盘自带音源与电脑播放同步发声，
 * 设计文档 20260906-midi-keyboard-and-practice.md §3.6）。
 *
 * 时间换算：`send()` 的时间戳基于 `performance.now()`（文档时间原点），而排期时间
 * 是 AudioContext 时间——两者同源（AudioContext.currentTime 即创建时刻的
 * performance.now()），故 `ts = performance.now() + (time - currentTime) * 1000`。
 * 已过期的排期时间不再带时间戳（立即发送）。
 */
export class MidiOutputSink {
  private readonly audioCtx: { currentTime: number }
  private outputs: readonly MidiOutputExt[] = []

  constructor(audioCtx: { currentTime: number }) {
    this.audioCtx = audioCtx
  }

  /** 更换输出端口（连接同步 / 热插拔 / 断开时传空数组） */
  sync(outputs: readonly MIDIOutput[]): void {
    this.outputs = [...outputs] as MidiOutputExt[]
  }

  /** 排期一条音符：Note On（按力度）+ 时值结束的 Note Off，逐端口发送 */
  scheduleNote(ev: ScheduledNote): void {
    if (this.outputs.length === 0) return
    const velocity = Math.max(1, Math.min(127, Math.round(ev.velocity)))
    // 一律用普通 number[]（而非 Uint8Array）：原生 Chrome 两者皆可，但 Web MIDI Browser
    // 等 shim 的 send() 里 data.map(Number) 对 Uint8Array 仍返回 Uint8Array，经
    // window.webkit.messageHandlers 的 JSON 序列化后变成 {"0":…}（对象）而非数组，
    // 原生侧按字节数组解析时崩溃（见研究文档 20260906-web-midi-ipad.md §7.1）。
    const on = [0x90, ev.pitch, velocity]
    const off = [0x80, ev.pitch, 0]
    // Note Off 时间按“音符结束时刻（time + duration）”单独换算，而非“Note On 时间戳 +
    // duration”：练习放行的音符 time 即当前时刻（Note On 已过期、立即发送、无时间戳），
    // 若据此把 Note Off 也立即发送，会把键盘音源上只响了一半的长音切断。
    const onTs = this.toTimestamp(ev.time)
    const offTs = this.toTimestamp(ev.time + ev.duration)
    for (const out of this.outputs) {
      out.send(on, onTs)
      out.send(off, offTs)
    }
  }

  /** 静默全部输出：清空未发送队列 + All Notes Off / All Sound Off（16 通道） */
  allNotesOff(): void {
    for (const out of this.outputs) {
      if (typeof out.clear === 'function') out.clear()
      for (let ch = 0; ch < ALL_CHANNELS; ch++) {
        out.send([0xb0 | ch, 123, 0])
      }
      for (let ch = 0; ch < ALL_CHANNELS; ch++) {
        out.send([0xb0 | ch, 120, 0])
      }
    }
  }

  dispose(): void {
    this.allNotesOff()
    this.outputs = []
  }

  /** AudioContext 时间 → send() 时间戳（ms，performance.now 基准）；已过期返回 undefined（立即发送） */
  private toTimestamp(time: number): number | undefined {
    const nowMs = performance.now()
    const ts = nowMs + (time - this.audioCtx.currentTime) * 1000
    return ts > nowMs ? ts : undefined
  }
}
