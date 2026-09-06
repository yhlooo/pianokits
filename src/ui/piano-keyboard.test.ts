import { describe, expect, it } from 'vitest'

import {
  BLACK_PCS,
  BLACK_KEY_WIDTH_RATIO,
  MAX_PITCH,
  MIN_PITCH,
  WHITE_INDEX,
  keyGeometry,
} from './piano-keyboard'

const W = 960

/** 范围内全部白键音高（升序） */
function whitePitches(): number[] {
  const out: number[] = []
  for (let p = MIN_PITCH; p <= MAX_PITCH; p++) if (!BLACK_PCS.has(p % 12)) out.push(p)
  return out
}

/** 黑键落在左白键上的宽度占比（期望值，与 piano-keyboard.ts 的 BLACK_LEFT_FRAC 一致） */
const EXPECT_FRAC: Record<number, number> = { 1: 2 / 3, 3: 1 / 3, 6: 3 / 4, 8: 1 / 2, 10: 1 / 4 }

describe('keyGeometry（与 .piano CSS 同一套键盘几何公式）', () => {
  it('52 根白键均分总宽度、首尾闭合、相邻无缝', () => {
    const whites = whitePitches()
    expect(whites).toHaveLength(52)
    const whiteW = W / 52
    expect(keyGeometry(W, whites[0]).left).toBe(0)
    for (let i = 1; i < whites.length; i++) {
      const prev = keyGeometry(W, whites[i - 1])
      const cur = keyGeometry(W, whites[i])
      expect(cur.width).toBeCloseTo(whiteW, 12)
      // 相邻白键左边缘差 = 白键宽（无缝贴合，1px 键缝由 border-right 在键内承担）
      expect(cur.left - prev.left).toBeCloseTo(whiteW, 12)
    }
    const last = keyGeometry(W, whites[whites.length - 1])
    expect(last.left + last.width).toBeCloseTo(W, 12)
  })

  it('黑键宽 = 白键宽 × 1.3/2.3，横向占位符合分组外扩', () => {
    const whiteW = W / 52
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      if (!BLACK_PCS.has(p % 12)) continue
      const g = keyGeometry(W, p)
      expect(g.width).toBeCloseTo(whiteW * BLACK_KEY_WIDTH_RATIO, 12)
      const li = WHITE_INDEX.get(p - 1)
      if (li === undefined) throw new Error('黑键必须有左邻白键')
      const boundary = whiteW * (li + 1) // 左白键右边界（分界线）
      // 左边缘 = 分界线 − leftFrac × 黑键宽
      const frac = (boundary - g.left) / g.width
      expect(frac).toBeCloseTo(EXPECT_FRAC[p % 12], 12)
      // 整个黑键落在相邻两根白键跨度内
      expect(g.left).toBeGreaterThanOrEqual(whiteW * li - 1e-9)
      expect(g.left + g.width).toBeLessThanOrEqual(whiteW * (li + 2) + 1e-9)
    }
  })

  it('G# 严格居中于两侧白键分界线上', () => {
    const whiteW = W / 52
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      if (p % 12 !== 8) continue
      const g = keyGeometry(W, p)
      const li = WHITE_INDEX.get(p - 1)
      if (li === undefined) throw new Error('黑键必须有左邻白键')
      expect(g.left + g.width / 2).toBeCloseTo(whiteW * (li + 1), 12)
    }
  })

  it('同一音级跨八度平移恒为 7 根白键宽（无随位置累积漂移）', () => {
    const whiteW = W / 52
    for (let p = MIN_PITCH; p + 12 <= MAX_PITCH; p++) {
      const a = keyGeometry(W, p)
      const b = keyGeometry(W, p + 12)
      expect(b.width).toBeCloseTo(a.width, 12)
      expect(b.left - a.left).toBeCloseTo(7 * whiteW, 12)
    }
  })

  it('超出 A0–C8 抛 RangeError', () => {
    expect(() => keyGeometry(W, MIN_PITCH - 1)).toThrow(RangeError)
    expect(() => keyGeometry(W, MAX_PITCH + 1)).toThrow(RangeError)
  })
})
