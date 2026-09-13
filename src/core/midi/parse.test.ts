import { describe, expect, it } from 'vitest'
import toneMidi from '@tonejs/midi'

import { decodeMidiText, parseMidi } from './parse'

const { Midi } = toneMidi

/**
 * 造一段 MIDI（@tonejs/midi 写出 → 本项目的 parseMidi 读入）：
 * melody 轨（通道 0）含 CC64 踩下/抬起、CC67 与一条非踏板 CC7；drums 轨（通道 9）含 CC64。
 */
function buildBytes(): ArrayBuffer {
  const midi = new Midi()
  const melody = midi.addTrack()
  melody.name = 'Melody'
  melody.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
  melody.addCC({ number: 64, value: 1, time: 0 }) // 延音踩下（写出为 127）
  melody.addCC({ number: 64, value: 0, time: 1 }) // 延音抬起
  melody.addCC({ number: 67, value: 0, time: 0 }) // 弱音抬起（三踏板之一，照常采集）
  melody.addCC({ number: 7, value: 0.8, time: 0 }) // 音量：非踏板，忽略
  const drums = midi.addTrack()
  drums.name = 'Drums'
  drums.channel = 9
  drums.addNote({ midi: 36, time: 0, duration: 0.1, velocity: 0.9 })
  drums.addCC({ number: 64, value: 1, time: 0 }) // 打击乐轨的踏板：忽略
  return Uint8Array.from(midi.toArray()).buffer
}

describe('parseMidi 踏板事件', () => {
  it('采集三踏板 CC（CC64/66/67），值为 0–127，保留来源轨与通道；非踏板 CC 与打击乐轨忽略', () => {
    const song = parseMidi(buildBytes())
    expect(song.pedalEvents.map((e) => [e.controller, e.value, e.trackIndex, e.channel])).toEqual([
      [64, 127, 0, 0], // @tonejs/midi 归一化 0–1 → 还原 0–127（旧实现误存为 1，记谱延长失效）
      [67, 0, 0, 0],
      [64, 0, 0, 0],
    ])
    expect(song.pedalEvents.map((e) => e.time)).toEqual([0, 0, 1])
    // 打击乐轨（通道 9）的 CC64 不进事件流
    expect(song.pedalEvents.some((e) => e.trackIndex === 1)).toBe(false)
  })

  it('notes 与 pedalEvents 各自按时间排序，tracks 保留每轨通道', () => {
    const song = parseMidi(buildBytes())
    // 打击乐轨不进音符事件流（踏板同理）
    expect(song.notes.map((n) => n.pitch)).toEqual([60])
    expect(song.tracks.map((t) => t.channel)).toEqual([0, 9])
    expect(song.tracks[1].percussion).toBe(true)
  })

  it('无踏板 CC 的曲目：pedalEvents 为空数组', () => {
    const midi = new Midi()
    const track = midi.addTrack()
    track.addNote({ midi: 60, time: 0, duration: 1, velocity: 0.5 })
    const song = parseMidi(Uint8Array.from(midi.toArray()).buffer)
    expect(song.pedalEvents).toEqual([])
  })
})

describe('decodeMidiText 轨名编码还原', () => {
  /** 把 UTF-8 文本按字节模拟成 @tonejs/midi 的 latin-1 逐字节解码结果 */
  const asLatin1 = (text: string): string =>
    Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join('')

  it('ASCII 原样返回', () => {
    expect(decodeMidiText('Piano')).toBe('Piano')
    expect(decodeMidiText('')).toBe('')
    expect(decodeMidiText('Track 1')).toBe('Track 1')
  })

  it('还原被误读为 latin-1 的 UTF-8 中文轨名', () => {
    expect(decodeMidiText(asLatin1('右手旋律'))).toBe('右手旋律')
    expect(decodeMidiText(asLatin1('左手伴奏'))).toBe('左手伴奏')
  })

  it('还原被误读为 latin-1 的 UTF-8 西欧字符', () => {
    expect(decodeMidiText(asLatin1('Prélude'))).toBe('Prélude')
    expect(decodeMidiText(asLatin1('Café'))).toBe('Café')
  })

  it('真正的 latin-1 文本不被误判（非法 UTF-8 字节序列）', () => {
    expect(decodeMidiText('café')).toBe('café') // é = U+00E9，单字节 EB 后无续接字节
    expect(decodeMidiText('Prélude')).toBe('Prélude')
    expect(decodeMidiText('über')).toBe('über')
  })

  it('含 >U+00FF 字符的字符串原样返回', () => {
    expect(decodeMidiText('已解码的中文')).toBe('已解码的中文')
    expect(decodeMidiText('旋律 ABC')).toBe('旋律 ABC')
  })

  it('parseMidi 对轨名应用还原，空名仍退到 Track N', () => {
    const midi = new Midi()
    const a = midi.addTrack()
    a.name = 'Melody'
    a.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    const b = midi.addTrack()
    b.addNote({ midi: 62, time: 0, duration: 0.5, velocity: 0.8 }) // 无轨名
    const song = parseMidi(midi.toArray().buffer as ArrayBuffer)
    expect(song.tracks.map((t) => t.name)).toEqual(['Melody', 'Track 2'])
  })
})
