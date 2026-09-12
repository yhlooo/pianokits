/**
 * 解码传入 MIDI 消息为通道声音事件（Note On/Off、Control Change）。
 * Web MIDI 的每个 midimessage 事件都是一条完整消息（含状态字节），无需处理 running status。
 */

/**
 * 通道声音事件的三元判别联合：按键与控制器（踏板等）同属一条消息流，
 * 用 `type` 收窄即可只处理自己关心的分支。
 * - 力度（velocity）取 Note On 的第二数据字节（0–127）；
 * - 踏板是 CC（0xB0–0xBF），踏板幅度即 CC 的第二数据字节（0–127）。
 */
export type MidiChannelEvent =
  | { type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; channel: number; pitch: number; velocity: number }
  | { type: 'controlChange'; channel: number; controller: number; value: number }

/** 按键事件（Note On/Off）：练习模式与连接层只关心这一类 */
export type MidiNoteEvent = Extract<MidiChannelEvent, { type: 'noteOn' | 'noteOff' }>
/** 控制变化事件（CC）：踏板、调制轮、音量等 */
export type MidiControlChange = Extract<MidiChannelEvent, { type: 'controlChange' }>

const NOTE_ON = 0x90
const NOTE_OFF = 0x80
const CONTROL_CHANGE = 0xb0
const STATUS_MASK = 0xf0
const CHANNEL_MASK = 0x0f

/**
 * 解析一条 MIDI 消息（`MIDIMessageEvent.data`）。识别通道声音消息中的 Note On/Off 与
 * Control Change：
 * - 0x9n + velocity>0 → noteOn；velocity=0 → 按离键 noteOff（MIDI 1.0 惯例）；
 * - 0x8n → noteOff（保留释放力度）；
 * - 0xBn → controlChange（controller = data1，value = data2；踏板 CC64/66/67 的解析见
 *   `core/midi/pedals.ts`）；
 * - 其余（弯音/触后/sysex/realtime 等）与长度不足 3 字节的消息返回 null。
 */
export function parseMidiMessage(data: Uint8Array): MidiChannelEvent | null {
  if (data.length < 3) return null
  const status = data[0]
  const type = status & STATUS_MASK
  const channel = status & CHANNEL_MASK
  const data1 = data[1]
  const data2 = data[2]

  if (type === NOTE_ON) {
    if (data2 === 0) return { type: 'noteOff', channel, pitch: data1, velocity: 0 }
    return { type: 'noteOn', channel, pitch: data1, velocity: data2 }
  }
  if (type === NOTE_OFF) {
    return { type: 'noteOff', channel, pitch: data1, velocity: data2 }
  }
  if (type === CONTROL_CHANGE) {
    return { type: 'controlChange', channel, controller: data1, value: data2 }
  }
  return null
}
