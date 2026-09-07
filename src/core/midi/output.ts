import type { MidiNoteEvent } from './input'
import type { ScheduledNote } from '../engine/types'

/** lib.dom 尚未收录 clear() 方法（Web MIDI 规范自 Chrome 43 起支持），本地补全类型 */
interface MidiOutputExt extends MIDIOutput {
  /** 清空尚未发送的排期消息队列 */
  clear(): void
}

const ALL_CHANNELS = 16
/** Local Control（CC122，通道模式消息）：0 = 禁用键盘自带音源，127 = 恢复 */
const CC_LOCAL_CONTROL = 122

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

  /**
   * 更换输出端口（连接同步 / 热插拔 / 断开时传空数组）。
   * 有端口时禁用键盘自带音源（Local Control Off，统一由程序输出音量）；端口被清空
   * （断开/拔出）时先恢复键盘自带音源（Local Control On），避免键盘残留「无声」状态。
   */
  sync(outputs: readonly MIDIOutput[]): void {
    const prev = this.outputs
    const next = [...outputs] as MidiOutputExt[]
    if (next.length === 0 && prev.length > 0) this.setLocalControl(true)
    this.outputs = next
    if (next.length > 0) this.setLocalControl(false)
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

  /**
   * 回送实时按键：把输入 noteOn/noteOff 原样（音高 + 力度 + 通道）发回输出端口，
   * Local Control Off 之后的软件回送——练习模式下按键以此发声（力度=按键力度，
   * 弹错的音也发声）。无输出端口时为空操作（此时键盘自带音源未被禁用，本地直接发声）。
   */
  echoNote(ev: MidiNoteEvent): void {
    if (this.outputs.length === 0) return
    const data =
      ev.type === 'noteOn'
        ? [0x90 | ev.channel, ev.pitch, ev.velocity]
        : [0x80 | ev.channel, ev.pitch, 0]
    for (const out of this.outputs) out.send(data)
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
    // 恢复键盘自带音源，避免断开后键盘留在 Local Off（无声）
    this.setLocalControl(true)
    this.allNotesOff()
    this.outputs = []
  }

  /** 设置键盘 Local Control：On（自带音源）或 Off（禁用，统一由程序输出） */
  private setLocalControl(enabled: boolean): void {
    const data = [0xb0, CC_LOCAL_CONTROL, enabled ? 0x7f : 0x00]
    for (const out of this.outputs) {
      out.send(data)
    }
  }

  /** AudioContext 时间 → send() 时间戳（ms，performance.now 基准）；已过期返回 undefined（立即发送） */
  private toTimestamp(time: number): number | undefined {
    const nowMs = performance.now()
    const ts = nowMs + (time - this.audioCtx.currentTime) * 1000
    return ts > nowMs ? ts : undefined
  }
}
