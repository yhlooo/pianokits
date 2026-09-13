/** 音频引擎接口：调度器只面向此接口，换引擎不影响播放状态机（设计文档 §6.2） */

export interface ScheduledNote {
  pitch: number
  velocity: number
  /** AudioContext 时间（采样级排期） */
  time: number
  /** 秒 */
  duration: number
  /** MIDI 通道 0~15（默认 0）：仅 MIDI 输出镜像使用（录音回放保留录制通道），音频引擎忽略 */
  channel?: number
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
  /**
   * 延音（damper，CC64）踏板状态：true = 踩着。只作用于**实时演奏**的 voice——键抬起时
   * 踏板踩着则延后止音，抬起踏板时统一释放（文件播放的踏板已在排期时烘焙成发声时值）。
   * CC66/67 与半踏板不建模（设计文档 20260913-pedal-sound-path.md §3.3）；
   * `allNotesOff()` 不清除本状态（物理踏板可能仍踩着）。
   */
  setSustain(down: boolean): void
  /** 立即止住所有正在发声的音（暂停/停止用；smplr 会同步取消已排期未发声的源） */
  allNotesOff(): void
  /** 线性音量 0~1 */
  setVolume(volume: number): void
  dispose(): void
}
