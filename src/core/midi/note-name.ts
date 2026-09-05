/**
 * 音符号（MIDI pitch 0–127）→ 科学音高记号（黑键统一用升号，如 "C#4"）。
 * 与 quantize.ts 的 spellPitch 不同：这里不依赖调号，只求无歧义的可读名称。
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** 音符号 → 音名（pitch 60 = C4、69 = A4、0 = C-1、127 = G9） */
export function midiNoteName(pitch: number): string {
  const pc = ((pitch % 12) + 12) % 12
  const octave = Math.floor(pitch / 12) - 1
  return `${NOTE_NAMES[pc]}${octave}`
}
