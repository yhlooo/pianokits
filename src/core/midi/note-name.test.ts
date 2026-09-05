import { describe, expect, it } from 'vitest'

import { midiNoteName } from './note-name'

describe('midiNoteName', () => {
  it('中央 C 与标准音 A', () => {
    expect(midiNoteName(60)).toBe('C4')
    expect(midiNoteName(69)).toBe('A4')
  })

  it('黑键用升号命名', () => {
    expect(midiNoteName(61)).toBe('C#4')
    expect(midiNoteName(62)).toBe('D4')
    expect(midiNoteName(63)).toBe('D#4')
    expect(midiNoteName(66)).toBe('F#4')
    expect(midiNoteName(68)).toBe('G#4')
    expect(midiNoteName(70)).toBe('A#4')
  })

  it('八度边界', () => {
    expect(midiNoteName(0)).toBe('C-1')
    expect(midiNoteName(12)).toBe('C0')
    expect(midiNoteName(48)).toBe('C3')
    expect(midiNoteName(72)).toBe('C5')
    expect(midiNoteName(127)).toBe('G9')
  })

  it('超出 0–127 也能稳定命名（按音级回绕）', () => {
    expect(midiNoteName(60 + 12)).toBe('C5')
    expect(midiNoteName(-1)).toBe('B-2')
  })
})
