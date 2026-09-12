import { describe, expect, it } from 'vitest'

import type { MidiControlChange, MidiNoteEvent } from './input'
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

  it('松掉一个和弦键后不满足，重新按下补全剩余键才触发', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(64))
    expect(g.note(off(64))).toBe(false) // 松开 64：和弦不全
    expect(g.note(on(64))).toBe(false) // 重新按下 64：仍缺 67
    expect(g.note(on(67))).toBe(true) // 按齐 67 触发
  })

  it('连续同音音符：放行后按住不放不会再次触发，抬起重按才触发', () => {
    const g = new ChordGate()
    g.setChord(new Set([60]))
    expect(g.note(on(60))).toBe(true) // 第一个同音音符触发（放行时消费该音高的按下）
    g.setChord(null) // 放行后清空等待
    expect(g.setChord(new Set([60]))).toBe(false) // 键仍按住但未重新按下 → 不立即触发
    expect(g.note(off(60))).toBe(false) // 抬起：不满足
    expect(g.note(on(60))).toBe(true) // 重新按下：再次触发
  })

  it('连续相同和弦：放行后必须抬起重新按下每个键才再次触发', () => {
    const g = new ChordGate()
    g.setChord(CHORD)
    g.note(on(60))
    g.note(on(64))
    expect(g.note(on(67))).toBe(true) // 第一次触发
    g.setChord(null)
    expect(g.setChord(CHORD)).toBe(false) // 三键都仍按住，但均未重新按下 → 不立即触发
    expect(g.note(on(60))).toBe(false) // 仅重按 60，64/67 仍未重按 → 不触发
    g.note(off(60))
    g.note(off(64))
    g.note(off(67))
    g.note(on(60))
    g.note(on(64))
    expect(g.note(on(67))).toBe(true) // 全部重新按下后触发
  })

  it('豁免键（长音符重复按）：按下不算错、不触发、不重复触发', () => {
    const g = new ChordGate()
    // 第一个和弦：长音符 62 触发并消费
    g.setChord(new Set([62]), new Set([62]))
    expect(g.note(on(62))).toBe(true)
    g.setChord(null)
    // 下一个和弦 {60}；62 仍在键盘上（豁免）
    g.setChord(new Set([60]), new Set([60, 62]))
    expect(g.note(on(62))).toBe(false) // 重复按长音符：不标错、不触发
    expect(g.wrongKeys.size).toBe(0)
    expect(g.heldKeys.has(62)).toBe(true) // 仍反映为按住
    expect(g.note(on(60))).toBe(true) // 按对和弦键正常触发
  })

  it('豁免键（非练习轨音符）：按下不算错、不阻止触发', () => {
    const g = new ChordGate()
    // 分轨练习：和弦 {60}，64 是同 onset 的非练习轨音符（豁免）
    g.setChord(new Set([60]), new Set([60, 64]))
    expect(g.note(on(64))).toBe(false) // 非练习轨音符：不标错
    expect(g.wrongKeys.size).toBe(0)
    expect(g.note(on(60))).toBe(true) // 按对和弦键触发（豁免键不阻止）
  })

  it('豁免键的重复按不标记新鲜按下：后续同音和弦需重新按下才触发', () => {
    const g = new ChordGate()
    g.setChord(new Set([62]), new Set([62]))
    expect(g.note(on(62))).toBe(true) // 触发长音符，消费 62
    g.setChord(null)
    g.setChord(new Set([60]), new Set([60, 62]))
    g.note(on(62)) // 忽略的重复按（不进入 pressed）
    g.setChord(null)
    expect(g.setChord(new Set([62]), new Set([62]))).toBe(false) // 62 仍按住但未重新按下 → 不立即触发
    g.note(off(62))
    expect(g.note(on(62))).toBe(true) // 重新按下 → 触发
  })

  it('setChord(null) 清空豁免集合', () => {
    const g = new ChordGate()
    g.setChord(new Set([60]), new Set([60, 62]))
    g.setChord(null)
    // 取消等待后再设置新和弦：旧豁免（62）不再生效
    g.setChord(new Set([64]))
    expect(g.note(on(62))).toBe(false) // 62 不在新和弦、也不再豁免 → 标错
    expect(g.wrongKeys.has(62)).toBe(true)
  })
})

// ---------- 踏板判定（设计文档 20260912-midi-pedal-lane-and-practice.md §3.5） ----------

const cc = (controller: number, value: number): MidiControlChange => ({
  type: 'controlChange',
  channel: 0,
  controller,
  value,
})
const SUSTAIN_DOWN = cc(64, 127)
const SUSTAIN_UP = cc(64, 0)
const SOFT_DOWN = cc(67, 127)
const SOFT_UP = cc(67, 0)

describe('ChordGate 踏板判定', () => {
  it('要求踏板没踩着：琴键齐全也不放行；踩下要求的踏板才放行', () => {
    const g = new ChordGate()
    g.setChord(CHORD, new Set(), new Set(['sustain']), new Set(['sustain']))
    expect(g.note(on(60))).toBe(false)
    expect(g.note(on(64))).toBe(false)
    expect(g.note(on(67))).toBe(false) // 琴键全部按住，但缺少要求踏板
    expect(g.control(SUSTAIN_DOWN)).toBe(true) // 踩下踏板 → 放行
    expect(g.wrongPedalKeys.size).toBe(0)
  })

  it('踏板按要求「当前状态」判定：进入等待前已踩着即满足，不要求重踩', () => {
    const g = new ChordGate()
    g.control(SUSTAIN_DOWN) // 等待之前就踩着（延音踏板可以一直踩）
    expect(g.setChord(CHORD, new Set(), new Set(['sustain']), new Set(['sustain']))).toBe(false)
    expect(g.note(on(60))).toBe(false)
    expect(g.note(on(64))).toBe(false)
    expect(g.note(on(67))).toBe(true) // 琴键齐全即放行
  })

  it('误踩（参与判定但本和弦不需要）：标红、不触发放行；松开后可放行', () => {
    const g = new ChordGate()
    g.setChord(CHORD, new Set(), new Set(), new Set(['sustain']))
    expect(g.control(SOFT_DOWN)).toBe(false) // 弱音不在参与判定集合 → 忽略，不标红
    expect(g.wrongPedalKeys.size).toBe(0)
    expect(g.control(SUSTAIN_DOWN)).toBe(false) // 参与判定但本和弦不需要 → 误踩
    expect([...g.wrongPedalKeys]).toEqual(['sustain'])
    expect(g.note(on(60))).toBe(false)
    expect(g.note(on(64))).toBe(false)
    expect(g.control(SOFT_UP)).toBe(false) // 非判定踏板与判定无关
    expect(g.control(SUSTAIN_UP)).toBe(false) // 松开误踩踏板，但琴键还缺 67
    expect(g.wrongPedalKeys.size).toBe(0)
    expect(g.note(on(67))).toBe(true) // 补全最后一个琴键 → 放行
  })

  it('等待开始前已踩着的非要求踏板不算误踩（同琴键的「遗留指法」语义）', () => {
    const g = new ChordGate()
    g.control(SOFT_DOWN)
    expect(g.setChord(CHORD, new Set(), new Set(), new Set(['soft', 'sustain']))).toBe(false)
    expect(g.wrongPedalKeys.size).toBe(0)
    expect(g.note(on(60))).toBe(false)
    expect(g.note(on(64))).toBe(false)
    expect(g.note(on(67))).toBe(true) // 遗留踏板不阻止放行
  })

  it('多个要求踏板必须全部踩着', () => {
    const g = new ChordGate()
    g.setChord(CHORD, new Set(), new Set(['sustain', 'soft']), new Set(['sustain', 'soft']))
    for (const p of [60, 64, 67]) g.note(on(p))
    expect(g.control(SUSTAIN_DOWN)).toBe(false) // 只踩了一个
    expect(g.control(SOFT_DOWN)).toBe(true) // 两个都踩 → 放行
  })

  it('换和弦清空误踩标记；踏板状态跨和弦保持', () => {
    const g = new ChordGate()
    g.setChord(new Set([60]), new Set(), new Set(), new Set(['sustain']))
    g.control(SUSTAIN_DOWN)
    expect([...g.wrongPedalKeys]).toEqual(['sustain'])
    g.setChord(new Set([62]), new Set(), new Set(), new Set(['sustain']))
    expect(g.wrongPedalKeys.size).toBe(0) // 新和弦重新评估
    expect([...g.heldPedalKeys]).toEqual(['sustain'])
  })

  it('setChord(null) 后踏板事件不再触发（无等待和弦）', () => {
    const g = new ChordGate()
    g.control(SUSTAIN_DOWN)
    g.setChord(null)
    expect(g.control(SUSTAIN_UP)).toBe(false)
    expect(g.control(SUSTAIN_DOWN)).toBe(false)
  })

  it('resetPedals 清空踏板状态（设备断开）', () => {
    const g = new ChordGate()
    g.control(SUSTAIN_DOWN)
    g.setChord(new Set([60]), new Set(), new Set(), new Set(['sustain', 'soft']))
    g.control(SOFT_DOWN) // 参与判定但本和弦不需要 → 误踩
    expect(g.wrongPedalKeys.size).toBe(1)
    g.resetPedals()
    expect([...g.heldPedalKeys]).toEqual([])
    expect(g.wrongPedalKeys.size).toBe(0)
    // 断开后即使踏板事件恢复，也不残留「已踩着」的旧状态
    expect(g.setChord(new Set([60]), new Set(), new Set(['sustain']), new Set(['sustain']))).toBe(
      false,
    )
  })

  it('非踏板 CC 忽略（不改变踏板状态、不标红）', () => {
    const g = new ChordGate()
    g.setChord(new Set([60]), new Set(), new Set(), new Set(['sustain']))
    expect(g.control(cc(7, 100))).toBe(false)
    expect([...g.heldPedalKeys]).toEqual([])
    expect(g.wrongPedalKeys.size).toBe(0)
    expect(g.note(on(60))).toBe(true) // 无踏板要求，琴键到位即放行
  })
})
