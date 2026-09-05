/**
 * 解码传入 MIDI 消息为按键事件（Note On/Off）。
 * Web MIDI 的每个 midimessage 事件都是一条完整消息（含状态字节），无需处理 running status。
 */

export type MidiNoteEvent =
  | { type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; channel: number; pitch: number; velocity: number }

const NOTE_ON = 0x90
const NOTE_OFF = 0x80
const STATUS_MASK = 0xf0
const CHANNEL_MASK = 0x0f

/**
 * 解析一条 MIDI 消息（`MIDIMessageEvent.data`）。仅识别通道声音消息中的 Note On/Off：
 * - 0x9n + velocity>0 → noteOn；velocity=0 → 按离键 noteOff（MIDI 1.0 惯例）；
 * - 0x8n → noteOff（保留释放力度）；
 * - 其余（CC/弯音/触后/sysex/realtime 等）与长度不足 3 字节的消息返回 null。
 */
export function parseMidiMessage(data: Uint8Array): MidiNoteEvent | null {
  if (data.length < 3) return null
  const status = data[0]
  const type = status & STATUS_MASK
  const channel = status & CHANNEL_MASK
  const pitch = data[1]
  const velocity = data[2]

  if (type === NOTE_ON) {
    if (velocity === 0) return { type: 'noteOff', channel, pitch, velocity: 0 }
    return { type: 'noteOn', channel, pitch, velocity }
  }
  if (type === NOTE_OFF) {
    return { type: 'noteOff', channel, pitch, velocity }
  }
  return null
}
