import { describe, expect, it } from 'vitest'

import {
  PEDAL_ON_THRESHOLD,
  PEDALS,
  applyControlChange,
  initialPedals,
  isPedalController,
  isPedalDown,
  pedalLevelPercent,
  pedalMode,
} from './pedals'

const state = (
  m: ReadonlyMap<number, { value: number; hasLevel: boolean; seen: boolean }>,
  cc: number,
) => {
  const s = m.get(cc)
  if (s === undefined) throw new Error(`缺少踏板 ${cc}`)
  return s
}

describe('PEDALS 定义', () => {
  it('三个踏板按钢琴从左到右排列：弱音(67) / 选择延音(66) / 延音(64)', () => {
    expect(PEDALS.map((p) => [p.cc, p.name])).toEqual([
      [67, '弱音'],
      [66, '选择延音'],
      [64, '延音'],
    ])
    expect(PEDAL_ON_THRESHOLD).toBe(64)
  })

  it('isPedalController 只认三个踏板 CC（CC65 Portamento 等不算）', () => {
    expect(isPedalController(64)).toBe(true)
    expect(isPedalController(66)).toBe(true)
    expect(isPedalController(67)).toBe(true)
    expect(isPedalController(65)).toBe(false)
    expect(isPedalController(1)).toBe(false)
    expect(isPedalController(123)).toBe(false)
  })
})

describe('applyControlChange', () => {
  it('初始三踏板均为未踩、未见过消息', () => {
    const m = initialPedals()
    expect([...m.keys()]).toEqual(PEDALS.map((p) => p.cc))
    for (const cc of [64, 66, 67]) {
      expect(state(m, cc)).toEqual({ value: 0, hasLevel: false, seen: false })
    }
  })

  it('只收到端点值 → 不锁定幅度模式（开关式踏板）', () => {
    let m = initialPedals()
    m = applyControlChange(m, 64, 127)
    expect(state(m, 64)).toEqual({ value: 127, hasLevel: false, seen: true })
    m = applyControlChange(m, 64, 0)
    expect(state(m, 64)).toEqual({ value: 0, hasLevel: false, seen: true })
  })

  it('出现 0/127 之外的中间值 → 锁定幅度模式，回到端点也不回退', () => {
    let m = initialPedals()
    m = applyControlChange(m, 64, 80)
    expect(state(m, 64).hasLevel).toBe(true)
    m = applyControlChange(m, 64, 127)
    expect(state(m, 64)).toEqual({ value: 127, hasLevel: true, seen: true })
    m = applyControlChange(m, 64, 0)
    expect(state(m, 64).hasLevel).toBe(true)
  })

  it('各踏板独立判定：延音有幅度不影响弱音', () => {
    let m = initialPedals()
    m = applyControlChange(m, 64, 55)
    m = applyControlChange(m, 67, 127)
    expect(state(m, 64).hasLevel).toBe(true)
    expect(state(m, 67).hasLevel).toBe(false)
  })

  it('非踏板 CC 原样返回（引用相等），调用方据此免于无谓重绘', () => {
    const m = initialPedals()
    expect(applyControlChange(m, 1, 64)).toBe(m)
    expect(applyControlChange(m, 65, 127)).toBe(m)
  })

  it('纯函数：不修改入参状态表', () => {
    const m = initialPedals()
    const next = applyControlChange(m, 64, 100)
    expect(state(m, 64)).toEqual({ value: 0, hasLevel: false, seen: false })
    expect(state(next, 64).value).toBe(100)
  })
})

describe('踩下判读与显示形态', () => {
  it('阈值边界：63 未踩、64 踩下', () => {
    expect(isPedalDown({ value: 63, hasLevel: true, seen: true })).toBe(false)
    expect(isPedalDown({ value: 64, hasLevel: true, seen: true })).toBe(true)
  })

  it('pedalMode：见过幅度值 → level，否则 indicators', () => {
    expect(pedalMode({ value: 127, hasLevel: false, seen: true })).toBe('indicators')
    expect(pedalMode({ value: 30, hasLevel: true, seen: true })).toBe('level')
  })
})

describe('pedalLevelPercent', () => {
  it('按 /127 线性换算并四舍五入', () => {
    expect(pedalLevelPercent(0)).toBe(0)
    expect(pedalLevelPercent(63)).toBe(50) // 49.6 → 50
    expect(pedalLevelPercent(64)).toBe(50) // 50.4 → 50
    expect(pedalLevelPercent(127)).toBe(100)
    expect(pedalLevelPercent(1)).toBe(1)
  })

  it('越界值收敛到 0–100', () => {
    expect(pedalLevelPercent(-5)).toBe(0)
    expect(pedalLevelPercent(200)).toBe(100)
  })
})
