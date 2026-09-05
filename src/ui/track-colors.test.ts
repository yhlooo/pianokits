import { describe, expect, it } from 'vitest'

import { TRACK_COLORS, trackColor } from './track-colors'

describe('track-colors', () => {
  it('色板为 5 色', () => {
    expect(TRACK_COLORS).toHaveLength(5)
  })

  it('每轨一色：前 5 轨依次取 5 色，第 6 轨循环回第 1 色', () => {
    expect(trackColor(0)).toBe(TRACK_COLORS[0])
    expect(trackColor(4)).toBe(TRACK_COLORS[4])
    expect(trackColor(5)).toBe(TRACK_COLORS[0])
    expect(trackColor(6)).toBe(TRACK_COLORS[1])
    expect(trackColor(11)).toBe(TRACK_COLORS[1])
  })

  it('每种颜色均为顶/底两个 RGB 三元组', () => {
    for (const [top, bottom] of TRACK_COLORS) {
      expect(top).toHaveLength(3)
      expect(bottom).toHaveLength(3)
      for (const c of [...top, ...bottom]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })
})
