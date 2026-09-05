import { describe, expect, it } from 'vitest'

import { sortedHeldPitches } from './held-keys'

describe('sortedHeldPitches', () => {
  it('空集合返回空数组', () => {
    expect(sortedHeldPitches(new Map())).toEqual([])
  })

  it('音高升序排列，与插入顺序无关', () => {
    const held = new Map([
      [67, 90],
      [60, 100],
      [64, 80],
    ])
    expect(sortedHeldPitches(held)).toEqual([60, 64, 67])
  })

  it('松开键后从结果中移除', () => {
    const held = new Map([
      [60, 100],
      [64, 80],
    ])
    held.delete(64)
    expect(sortedHeldPitches(held)).toEqual([60])
  })

  it('全部松开后回空', () => {
    const held = new Map([[60, 100]])
    held.delete(60)
    expect(sortedHeldPitches(held)).toEqual([])
  })
})
