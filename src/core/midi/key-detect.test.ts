import { describe, expect, it } from 'vitest'

import type { Note } from '../model'
import { estimateKey, tonalitySf } from './key-detect'

/** 构造测试音符：pc = 音级（0=C…11=B），dur = 秒 */
function n(pc: number, dur = 1): Note {
  return { pitch: 60 + pc, start: 0, end: dur, velocity: 64, trackIndex: 0 }
}

/**
 * 音阶内容拟真：主音最重、属音次之、其他调内音级重（模拟真实调性分布），
 * 调外音级微（2s）模拟少量经过音。
 */
function scaleContent(scalePcs: number[], tonicPc: number): Note[] {
  const notes: Note[] = []
  for (let pc = 0; pc < 12; pc++) {
    let w = 2
    if (scalePcs.includes(pc)) {
      w = 100
      if (pc === tonicPc) w = 250
      else if (pc === (tonicPc + 7) % 12) w = 150
    }
    notes.push(n(pc, w))
  }
  return notes
}

describe('tonalitySf', () => {
  it('大小调 → 调号 sf（小调取关系大调）', () => {
    expect(tonalitySf(0, 0)).toBe(0) // C
    expect(tonalitySf(7, 0)).toBe(1) // G
    expect(tonalitySf(10, 0)).toBe(-2) // Bb
    expect(tonalitySf(9, 1)).toBe(0) // Am → C
    expect(tonalitySf(7, 1)).toBe(-2) // Gm → Bb
    expect(tonalitySf(2, 1)).toBe(-1) // Dm → F
    expect(tonalitySf(6, 1)).toBe(3) // F#m → A
  })
})

describe('estimateKey', () => {
  it('G 小调内容 → sf=-2、mi=1', () => {
    const est = estimateKey(scaleContent([7, 9, 10, 0, 2, 3, 5], 7))
    expect(est.sf).toBe(-2)
    expect(est.mi).toBe(1)
    expect(est.tonicPc).toBe(7)
    expect(est.confidence).toBeGreaterThan(0)
  })

  it('C 大调内容 → sf=0（全白键不产生调号）', () => {
    const est = estimateKey(scaleContent([0, 2, 4, 5, 7, 9, 11], 0))
    expect(est.sf).toBe(0)
  })

  it('D 小调内容 → sf=-1、mi=1', () => {
    const est = estimateKey(scaleContent([2, 4, 5, 7, 9, 10, 0], 2))
    expect(est.sf).toBe(-1)
    expect(est.mi).toBe(1)
    expect(est.tonicPc).toBe(2)
  })

  it('F# 小调内容 → sf=3、mi=1', () => {
    const est = estimateKey(scaleContent([6, 8, 9, 11, 1, 2, 4], 6))
    expect(est.sf).toBe(3)
    expect(est.mi).toBe(1)
    expect(est.tonicPc).toBe(6)
  })

  it('C 宫五声音阶 → 无黑键无歧义，sf=0', () => {
    const est = estimateKey(scaleContent([0, 2, 4, 7, 9], 0))
    expect(est.sf).toBe(0)
  })

  it('空音符 → sf=0、confidence=0', () => {
    const est = estimateKey([])
    expect(est).toEqual({ sf: 0, mi: 0, tonicPc: 0, confidence: 0 })
  })

  it('真实取样的「梦中的婚礼」类直方图（D/G/Bb/C/F/Eb 为主）→ sf=-2', () => {
    // 来自 .tmp/梦中的婚礼.mid 实测的时长加权音级占比
    const weights: [number, number][] = [
      [2, 60.9], // D
      [7, 59.6], // G
      [10, 52.7], // A#=Bb
      [0, 44.0], // C
      [5, 41.7], // F
      [3, 24.5], // D#=Eb
      [9, 22.0], // A
      [1, 0.9],
      [4, 1.1],
      [6, 2.5],
      [8, 0.7],
      [11, 0.9],
    ]
    const est = estimateKey(weights.map(([pc, w]) => n(pc, w)))
    expect(est.sf).toBe(-2)
    expect(est.confidence).toBeGreaterThan(0.5)
  })
})
