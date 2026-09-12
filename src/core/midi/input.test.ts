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

  it('Control Change：0xBn + 控制器号 + 值（踏板 CC64/66/67 走这里）', () => {
    expect(parseMidiMessage(msg(0xb0, 64, 127))).toEqual({
      type: 'controlChange',
      channel: 0,
      controller: 64,
      value: 127,
    })
    expect(parseMidiMessage(msg(0xb2, 66, 40))).toEqual({
      type: 'controlChange',
      channel: 2,
      controller: 66,
      value: 40,
    })
    expect(parseMidiMessage(msg(0xbf, 67, 0))).toEqual({
      type: 'controlChange',
      channel: 15,
      controller: 67,
      value: 0,
    })
  })

  it('忽略其余消息（弯音/触后/program change/realtime）', () => {
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
