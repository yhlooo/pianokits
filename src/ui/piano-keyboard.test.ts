import { describe, expect, it } from 'vitest'

import {
  BLACK_PCS,
  BLACK_KEY_WIDTH_RATIO,
  MAX_PITCH,
  MIN_PITCH,
  WHITE_INDEX,
  keyGeometry,
  keyPressStyle,
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

/** linear-gradient 里的一个颜色端点 */
interface RgbTriplet {
  top: readonly [number, number, number]
  bottom: readonly [number, number, number]
}

/** 解析 keyPressStyle 的 background：linear-gradient(rgb(顶), rgb(底)) */
function parseGradient(css: string): RgbTriplet {
  const found = [...css.matchAll(/rgb\((\d+),(\d+),(\d+)\)/g)].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const,
  )
  if (found.length !== 2) throw new Error(`无法解析渐变色：${css}`)
  return { top: found[0], bottom: found[1] }
}

/** 三元组亮度均值（越大越亮；琥珀叠加越多 → 白键越暗、黑键越亮） */
const luma = ([r, g, b]: readonly [number, number, number]): number => (r + g + b) / 3

describe('keyPressStyle（按下键色按力度叠加）', () => {
  it('白键：力度越大琥珀叠加越多 → 亮度越低；最轻力度仍是明显琥珀', () => {
    const soft = luma(parseGradient(keyPressStyle(1, false).background).top)
    const hard = luma(parseGradient(keyPressStyle(127, false).background).top)
    // 白键本色顶色 #f4f1eb 亮度约 240；最重力度应明显更深
    expect(hard).toBeLessThan(soft - 30)
    // 最轻力度也不退化成白键本色（仍是琥珀，亮度明显低于白键本色约 240）
    expect(soft).toBeLessThan(225)
  })

  it('白键力度单调：越重越深', () => {
    const at = (v: number): number => luma(parseGradient(keyPressStyle(v, false).background).top)
    expect(at(20)).toBeGreaterThan(at(60))
    expect(at(60)).toBeGreaterThan(at(100))
    expect(at(100)).toBeGreaterThan(at(127))
  })

  it('黑键：力度越大越亮（琥珀透出），常态投影由 CSS 保留', () => {
    const soft = keyPressStyle(0, true)
    const hard = keyPressStyle(127, true)
    expect(luma(parseGradient(hard.background).top)).toBeGreaterThan(
      luma(parseGradient(soft.background).top),
    )
    // 键色由内联渐变表达；黑键常态投影留在 .piano__bkey 的 CSS 里（不被内联覆盖）
    expect(soft.alpha).toBeLessThan(hard.alpha)
  })

  it('光晕峰值随力度增强，最轻力度为 0（无光晕）', () => {
    expect(keyPressStyle(0, false).glow).toBe(0)
    expect(keyPressStyle(64, false).glow).toBeCloseTo(0.6 * (64 / 127) ** 0.4, 12)
    expect(keyPressStyle(127, false).glow).toBeCloseTo(0.6, 12)
  })

  it('越界力度收敛到 0–127', () => {
    expect(keyPressStyle(-5, false)).toEqual(keyPressStyle(0, false))
    expect(keyPressStyle(200, false)).toEqual(keyPressStyle(127, false))
  })
})
