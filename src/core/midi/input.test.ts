import { describe, expect, it } from 'vitest'

import { parseMidiMessage } from './input'

const msg = (...bytes: number[]): Uint8Array => new Uint8Array(bytes)

describe('parseMidiMessage', () => {
  it('Note On：0x90 + 音符号 + 力度', () => {
    expect(parseMidiMessage(msg(0x90, 60, 100))).toEqual({
      type: 'noteOn',
      channel: 0,
      pitch: 60,
      velocity: 100,
    })
  })

  it('Note On 且 velocity=0 等价 Note Off', () => {
    expect(parseMidiMessage(msg(0x94, 60, 0))).toEqual({
      type: 'noteOff',
      channel: 4,
      pitch: 60,
      velocity: 0,
    })
  })

  it('Note Off：0x80 + 音符号 + 释放力度', () => {
    expect(parseMidiMessage(msg(0x83, 69, 64))).toEqual({
      type: 'noteOff',
      channel: 3,
      pitch: 69,
      velocity: 64,
    })
  })

  it('通道号取状态字节低 4 位', () => {
    expect(parseMidiMessage(msg(0x9f, 127, 1))).toEqual({
      type: 'noteOn',
      channel: 15,
      pitch: 127,
      velocity: 1,
    })
  })

  it('忽略非按键消息（CC/弯音/触后/realtime）', () => {
    expect(parseMidiMessage(msg(0xb0, 64, 127))).toBeNull() // CC64 延音踏板
    expect(parseMidiMessage(msg(0xe0, 0, 64))).toBeNull() // 弯音
    expect(parseMidiMessage(msg(0xc0, 0))).toBeNull() // program change
    expect(parseMidiMessage(msg(0xf8))).toBeNull() // realtime clock
  })

  it('长度不足的消息返回 null', () => {
    expect(parseMidiMessage(msg())).toBeNull()
    expect(parseMidiMessage(msg(0x90))).toBeNull()
    expect(parseMidiMessage(msg(0x90, 60))).toBeNull()
  })
})
