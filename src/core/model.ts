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

/**
 * 三踏板 CC 事件（设计文档 20260912-midi-pedal-lane-and-practice.md §3.2）。
 * 踏板在 MIDI 里是**通道消息**（CC64 延音 / CC66 选择延音 / CC67 弱音），轨道只是容器，
 * 因此同时保留来源轨与其通道，供归属规则使用（研究文档 20260912-midi-pedal-track-relationship.md）。
 */
export interface PedalEvent {
  /** 秒 */
  time: number
  /** 踏板控制器号：64 延音 / 66 选择延音 / 67 弱音 */
  controller: number
  /** 0~127（CC 第二数据字节；`>= 64` 为踩下） */
  value: number
  /** 来源轨道 index（对应 Song.tracks） */
  trackIndex: number
  /** 来源轨道通道（@tonejs/midi 由轨内音符推导；无音符轨为 0） */
  channel: number
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
  /** 三踏板事件（CC64/66/67，合并所有非打击乐轨、按 time 排序），供瀑布流踏板轨道与练习判定 */
  pedalEvents: PedalEvent[]
}
