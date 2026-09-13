/**
 * MIDI 文件编码：把录音音符（RecordedNote）与踏板踩下区间（RecordedPedalSegment）编码为
 * 标准 MIDI 文件（SMF）字节。与 parse.ts 反向对称——写出的字节可被 parseMidi 读回
 * （音高/力度/时间/通道、踏板 CC64/66/67 一致），供「录音导出 .mid」使用。
 */

import { Midi } from '@tonejs/midi'

import type { RecordedNote, RecordedPedalSegment } from '../recorder-model'

/** 写 MIDI 文件的选项 */
export interface MidiWriteOptions {
  /** 速度 BPM，默认 120 */
  bpm?: number
  /** 轨名前缀，默认 'PianoKits Recording' */
  trackName?: string
}

/** 默认速度（BPM） */
const DEFAULT_BPM = 120
/**
 * 默认轨名前缀（单通道即轨名本身）。只用 ASCII：@tonejs/midi 的文本事件按 latin-1
 * 逐字节写出（midi-file writeString 取 codePoint & 0xFF），非 ASCII 轨名在文件里会变乱码。
 */
const DEFAULT_TRACK_NAME = 'PianoKits Recording'
/** MIDI 数据字节的合法范围（音高 0~127、力度 1~127、通道 0~15） */
const PITCH_MIN = 0
const PITCH_MAX = 127
const VELOCITY_MIN = 1
const VELOCITY_MAX = 127
const CHANNEL_MAX = 15
/** 控制器号/控制器值范围（CC 只能取合法字节） */
const CONTROLLER_MAX = 127

/** 钳制到 [min, max]（MIDI 数据字节只能取合法整数，越界会让写出/解析失真） */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 按通道分组（通道升序；同通道内保持传入顺序）。
 * 通道消息本身不带轨道，轨道只是容器，因此导出时一个通道一轨最贴近录音语义。
 */
function groupByChannel<T extends { channel: number }>(items: readonly T[]): Array<[number, T[]]> {
  const groups = new Map<number, T[]>()
  for (const item of items) {
    const channel = clamp(Math.round(item.channel), 0, CHANNEL_MAX)
    const bucket = groups.get(channel)
    if (bucket === undefined) groups.set(channel, [item])
    else bucket.push(item)
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
}

/**
 * 把录音音符与踏板区间编码为 SMF（.mid）字节；两者都可含多个 MIDI 通道，按通道分到各轨
 * （某通道只有踏板时也建轨）。
 *
 * 轨名：单通道为 trackName 本身，多通道为 `${trackName} Ch${channel + 1}`（只用 ASCII，
 * 见 DEFAULT_TRACK_NAME 注释）。空数组写出合法的空 MIDI 文件（只有头部轨），不抛错。
 */
export function writeMidi(
  notes: readonly RecordedNote[],
  pedals: readonly RecordedPedalSegment[] = [],
  opts: MidiWriteOptions = {},
): ArrayBuffer {
  const trackName = opts.trackName ?? DEFAULT_TRACK_NAME
  const midi = new Midi()
  midi.header.setTempo(opts.bpm ?? DEFAULT_BPM)
  midi.header.name = trackName

  const notesOf = new Map(groupByChannel(notes))
  const pedalsOf = new Map(groupByChannel(pedals))
  const channels = [...new Set([...notesOf.keys(), ...pedalsOf.keys()])].sort((a, b) => a - b)
  for (const channel of channels) {
    const track = midi.addTrack()
    track.channel = channel
    track.name = channels.length === 1 ? trackName : `${trackName} Ch${channel + 1}`
    for (const note of notesOf.get(channel) ?? []) {
      const duration = note.end - note.start
      // 防御：录音不会产生非正时值，但 0/负/NaN 时值会让读出方得到非法音符
      if (!(duration > 0)) continue
      track.addNote({
        // @tonejs/midi 的力度是 0~1 归一化值，写出时按 velocity * 127 取整回 MIDI 字节
        midi: clamp(Math.round(note.pitch), PITCH_MIN, PITCH_MAX),
        time: note.start,
        duration,
        velocity: clamp(Math.round(note.velocity), VELOCITY_MIN, VELOCITY_MAX) / 127,
        noteOffVelocity: 0,
      })
    }
    for (const pedal of pedalsOf.get(channel) ?? []) {
      // 防御：未收尾（end = Infinity）或非正区间会写出悬空/零长踏板，直接跳过
      if (!Number.isFinite(pedal.end) || !(pedal.end > pedal.start)) continue
      const controller = clamp(Math.round(pedal.controller), 0, CONTROLLER_MAX)
      // @tonejs/midi 的 CC 值同样是 0~1 归一化值（编码时 floor(value * 127)，与 parse.ts 对称）
      const value = clamp(Math.round(pedal.value), 0, VELOCITY_MAX) / 127
      track.addCC({ number: controller, value, time: pedal.start })
      track.addCC({ number: controller, value: 0, time: pedal.end })
    }
  }

  const bytes = midi.toArray()
  // slice() 复制出长度恰好等于字节数的 ArrayBuffer（toArray 的返回类型可能是
  // Uint8Array<SharedArrayBuffer> 且视图未必覆盖整个 buffer，不能直接返回 .buffer）
  return bytes.slice().buffer
}
