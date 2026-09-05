/**
 * MIDI 解析后的领域模型（自研，与 @tonejs/midi 解耦）。
 * 时间一律为秒；tempo/拍号变化按时间点给出。
 */

export interface TempoEvent {
  /** 秒 */
  time: number
  bpm: number
}

export interface TimeSignatureEvent {
  /** 秒 */
  time: number
  numerator: number
  denominator: number
}

export interface KeySignatureEvent {
  /** 秒 */
  time: number
  /** 升降号数量：正为升号，负为降号（-7 ~ +7） */
  sf: number
  /** 0 = 大调，1 = 小调 */
  mi: 0 | 1
}

export interface Track {
  /** 轨道在文件中的原始序号 */
  index: number
  name: string
  channel: number
  /** 乐器 program number */
  instrument: number
  /** 打击乐轨（GM channel 10 或 percussion 乐器族） */
  percussion: boolean
  noteCount: number
}

export interface Note {
  /** MIDI 音高 0~127 */
  pitch: number
  /** 秒 */
  start: number
  /** 秒 */
  end: number
  /** 0~127 */
  velocity: number
  /** 来源轨道 index（对应 Song.tracks） */
  trackIndex: number
}

export interface Song {
  /** 每四分音符 tick 数 */
  ppq: number
  /** 秒 */
  duration: number
  tempos: TempoEvent[]
  timeSignatures: TimeSignatureEvent[]
  keySignatures: KeySignatureEvent[]
  tracks: Track[]
  /** 播放用事件流：默认合并所有非打击乐轨，按 start 排序 */
  notes: Note[]
}
