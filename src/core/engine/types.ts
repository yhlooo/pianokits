/** 音频引擎接口：调度器只面向此接口，换引擎不影响播放状态机（设计文档 §6.2） */

export interface ScheduledNote {
  pitch: number
  velocity: number
  /** AudioContext 时间（采样级排期） */
  time: number
  /** 秒 */
  duration: number
}

export interface EngineInitOptions {
  onProgress?: (loaded: number, total: number) => void
}

export interface AudioEngine {
  readonly id: 'smplr' | 'oscillator'
  init(opts?: EngineInitOptions): Promise<void>
  readonly ready: boolean
  /** 在精确的 AudioContext 时间排期一个音符（含时值），引擎自行安排止音 */
  scheduleNote(ev: ScheduledNote): void
  /** 立即发声（实时演奏，如 MIDI 键盘按下）；同音高重复按下会先止住前一个 */
  noteOn(pitch: number, velocity: number): void
  /** 止住实时演奏中的音（如 MIDI 键盘松开）；不经过调度器 */
  noteOff(pitch: number): void
  /** 立即止住所有正在发声的音（暂停/停止用；smplr 会同步取消已排期未发声的源） */
  allNotesOff(): void
  /** 线性音量 0~1 */
  setVolume(volume: number): void
  dispose(): void
}
