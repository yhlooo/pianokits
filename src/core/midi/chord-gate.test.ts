import { describe, expect, it } from 'vitest'

import type { MidiNoteEvent } from './input'
import { ChordGate } from './chord-gate'

const on = (pitch: number, velocity = 100): MidiNoteEvent => ({
  type: 'noteOn',
  channel: 0,
  pitch,
  velocity,
})
const off = (pitch: number): MidiNoteEvent => ({ type: 'noteOff', channel: 0, pitch, velocity: 0 })

const CHORD = new Set([60, 64, 67])

describe('ChordGate 练习匹配', () => {
  it('无等待和弦时按键不评估、不标红', () => {
    const g = new ChordGate()
    expect(g.note(on(99))).toBe(false)
    expect(g.wrongKeys.size).toBe(0)
  })

  it('依次按全全部和弦键：最后一下触发', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    expect(g.note(on(60))).toBe(false)
    expect(g.note(on(64))).toBe(false)
    expect(g.note(on(67))).toBe(true)
    expect(g.wrongKeys.size).toBe(0)
  })

  it('按错键：标红、不触发；松开后消除标记', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(62)) // 错键
    expect(g.wrongKeys).toEqual(new Set([62]))
    expect(g.note(on(67))).toBe(false) // 仍被错键阻止
    expect(g.note(off(62))).toBe(false) // 松开错键：和弦还不全
    expect(g.wrongKeys.size).toBe(0)
    expect(g.note(on(64))).toBe(true) // 条件齐备，触发
  })

  it('多按键阻止触发：和弦齐全但错键仍按住', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(64))
    g.note(on(65)) // 多按
    expect(g.note(on(67))).toBe(false)
    expect(g.note(off(65))).toBe(true) // 松开多按的键立即触发
  })

  it('预先按住全部和弦键：进入等待时立即触发', () => {
    const g = new ChordGate()
    g.note(on(60))
    g.note(on(64))
    g.note(on(67))
    expect(g.setChord(CHORD)).toBe(true)
  })

  it('等待开始前已按住的键不标红、不阻止触发（上一和弦遗留指法）', () => {
    const g = new ChordGate()
    g.note(on(55)) // 上一和弦遗留
    expect(g.setChord(CHORD)).toBe(false) // 和弦不全
    expect(g.wrongKeys.size).toBe(0) // 遗留键不标红
    expect(g.note(on(60))).toBe(false)
    expect(g.note(on(64))).toBe(false)
    expect(g.note(on(67))).toBe(true) // 遗留键不阻止触发
  })

  it('部分按住时等待中按下错键会标红；换到新和弦时清除标记', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(62))
    expect(g.wrongKeys.has(62)).toBe(true)
    g.setChord(new Set([72]))
    expect(g.wrongKeys.size).toBe(0)
    expect(g.heldKeys.has(62)).toBe(true)
  })

  it('reset 清空和弦与按住状态', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(62))
    g.reset()
    expect(g.heldKeys.size).toBe(0)
    expect(g.wrongKeys.size).toBe(0)
    expect(g.note(on(99))).toBe(false)
  })

  it('松掉一个和弦键后不满足，重新按下再次触发', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(64))
    g.note(on(67))
    expect(g.note(off(64))).toBe(false)
    expect(g.note(on(64))).toBe(true)
  })
})
