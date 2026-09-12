import { describe, expect, it } from 'vitest'

import {
  DebugMidiState,
  VELOCITY_CURVE_EXPONENT,
  pedalBorderAlpha,
  pedalBoxText,
  pedalFillAlpha,
  pedalTextAlpha,
  velocityFillAlpha,
  velocityIntensity,
  velocityTextAlpha,
} from './midi-debug-state'
import { PEDAL_ON_THRESHOLD } from '../core/midi/pedals'

const on = (pitch: number, velocity: number) =>
  ({ type: 'noteOn', channel: 0, pitch, velocity }) as const
const off = (pitch: number) => ({ type: 'noteOff', channel: 0, pitch, velocity: 0 }) as const
const cc = (controller: number, value: number) =>
  ({ type: 'controlChange', channel: 0, controller, value }) as const

describe('力度映射', () => {
  it('velocityIntensity：幂曲线（指数 0.4）映射到 0–1，越界收敛', () => {
    expect(velocityIntensity(0)).toBe(0)
    expect(velocityIntensity(127)).toBe(1)
    expect(velocityIntensity(64)).toBeCloseTo((64 / 127) ** VELOCITY_CURVE_EXPONENT, 12)
    expect(velocityIntensity(-10)).toBe(0)
    expect(velocityIntensity(300)).toBe(1)
  })

  it('低力度被拉开、高力度被压缩（非线性；依据 MIDI 力度—音量平方律的感知逆曲线）', () => {
    // 线性下 v=1 与 v=20 只差 0.15；幂曲线下应超过 0.25（肉眼可辨）
    expect(velocityIntensity(20) - velocityIntensity(1)).toBeGreaterThan(0.25)
    // 高力度区间被压缩：v=100 与 v=127 的差小于低力度区间的差
    const low = velocityIntensity(20) - velocityIntensity(1)
    const high = velocityIntensity(127) - velocityIntensity(100)
    expect(high).toBeLessThan(low)
    // 单调不减
    let prev = -1
    for (let v = 0; v <= 127; v++) {
      const cur = velocityIntensity(v)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })

  it('velocityTextAlpha：极轻仍可读（0.50），最重为 1（越大越亮）', () => {
    expect(velocityTextAlpha(0)).toBeCloseTo(0.5, 12)
    expect(velocityTextAlpha(127)).toBeCloseTo(1, 12)
    expect(velocityTextAlpha(64)).toBeGreaterThan(velocityTextAlpha(20))
  })

  it('velocityFillAlpha：背景底色随力度加深（0.03 → 0.30），低力度间也要有梯度', () => {
    expect(velocityFillAlpha(0)).toBeCloseTo(0.03, 12)
    expect(velocityFillAlpha(127)).toBeCloseTo(0.3, 12)
    expect(velocityFillAlpha(100)).toBeGreaterThan(velocityFillAlpha(30))
    // 最轻的力度也要有一层可辨的底色（不是 0），且 v=20 与 v=1 的差肉眼可辨（>0.05）
    expect(velocityFillAlpha(1)).toBeGreaterThan(0.03)
    expect(velocityFillAlpha(20) - velocityFillAlpha(1)).toBeGreaterThan(0.05)
  })
})

describe('踏板方块视觉', () => {
  it('未触发（<64）没有背景色，触发后越深越浓', () => {
    expect(pedalFillAlpha(0)).toBe(0)
    expect(pedalFillAlpha(63)).toBe(0)
    expect(pedalFillAlpha(64)).toBeCloseTo(0.1, 12)
    expect(pedalFillAlpha(127)).toBeCloseTo(0.4, 12)
    expect(pedalFillAlpha(100)).toBeGreaterThan(pedalFillAlpha(70))
  })

  it('边框与文字亮度随值增大而变亮', () => {
    expect(pedalBorderAlpha(0)).toBeCloseTo(0.3, 12)
    expect(pedalBorderAlpha(127)).toBeCloseTo(0.85, 12)
    expect(pedalBorderAlpha(100)).toBeGreaterThan(pedalBorderAlpha(30))
    expect(pedalTextAlpha(0)).toBeCloseTo(0.55, 12)
    expect(pedalTextAlpha(127)).toBeCloseTo(0.95, 12)
    expect(pedalTextAlpha(100)).toBeGreaterThan(pedalTextAlpha(30))
  })

  it('pedalBoxText：中间大字百分比 + 右上角小字原始值（未触发也显示）', () => {
    expect(pedalBoxText({ value: 0, hasLevel: false, seen: false })).toEqual({
      percent: '0%',
      raw: '0',
    })
    expect(pedalBoxText({ value: 96, hasLevel: true, seen: true })).toEqual({
      percent: '76%',
      raw: '96',
    })
    expect(pedalBoxText({ value: 127, hasLevel: true, seen: true })).toEqual({
      percent: '100%',
      raw: '127',
    })
  })
})

describe('DebugMidiState', () => {
  it('按键：noteOn 记录力度、noteOff 移除，音高不重复', () => {
    const s = new DebugMidiState()
    s.feed(on(60, 100))
    s.feed(on(64, 40))
    expect([...s.snapshot().held]).toEqual([
      [60, 100],
      [64, 40],
    ])
    s.feed(off(60))
    expect([...s.snapshot().held]).toEqual([[64, 40]])
  })

  it('同音高重按（未抬起）以最新力度为准', () => {
    const s = new DebugMidiState()
    s.feed(on(60, 30))
    s.feed(on(60, 120))
    expect(s.snapshot().held.get(60)).toBe(120)
  })

  it('踏板：CC64/66/67 各自独立，非踏板 CC 被忽略', () => {
    const s = new DebugMidiState()
    s.feed(cc(64, 127))
    s.feed(cc(66, 20))
    s.feed(cc(1, 90)) // 调制轮：不是踏板
    const snap = s.snapshot()
    // 顺序按钢琴从左到右：弱音(67) / 选择延音(66) / 延音(64)
    expect(snap.pedals.map((p) => [p.def.cc, p.state.value, p.state.seen])).toEqual([
      [67, 0, false],
      [66, 20, true],
      [64, 127, true],
    ])
  })

  it('clearInputs：设备全部断开后按键与踏板一并复位', () => {
    const s = new DebugMidiState()
    s.feed(on(60, 100))
    s.feed(cc(64, 127))
    const snap = s.clearInputs()
    expect(snap.held.size).toBe(0)
    expect(snap.pedals.every((p) => !p.state.seen && p.state.value === 0)).toBe(true)
  })

  it('snapshot 返回的 held 是实时视图（渲染前无需拷贝），pedals 是固定三格', () => {
    const s = new DebugMidiState()
    const before = s.snapshot()
    s.feed(on(60, 100))
    expect(before.held.get(60)).toBe(100)
    expect(before.pedals).toHaveLength(3)
  })
})

describe('踏板阈值与视觉的边界一致', () => {
  it('63 / 64 是背景色与踩下判读的共同边界', () => {
    expect(pedalFillAlpha(PEDAL_ON_THRESHOLD - 1)).toBe(0)
    expect(pedalFillAlpha(PEDAL_ON_THRESHOLD)).toBeGreaterThan(0)
  })
})
