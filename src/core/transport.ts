import type { Note, Song } from './model'
import type { AudioEngine, ScheduledNote } from './engine/types'

export type TransportState = 'empty' | 'ready' | 'playing' | 'paused'

/** 可注入的时间与定时器宿主：生产用 AudioContext 时钟，测试用假时钟（设计文档 §4） */
export interface TransportHost {
  now(): number
  setInterval(cb: () => void, ms: number): number
  clearInterval(id: number): void
}

/**
 * MIDI 输出镜像（可选）：走带排期的每个音符同步发一份到外部 MIDI 输出
 * （如键盘自带音源，与电脑播放同步发声；设计文档 20260906-midi-keyboard-and-practice.md §3.6）。
 * 实现为 core/midi/output.ts 的 MidiOutputSink（结构化匹配，无需相互引用）。
 */
export type MidiOutputSink = {
  scheduleNote(ev: ScheduledNote): void
  allNotesOff(): void
}

/** lookahead 窗口（秒）：调度器把未来 100ms 内的音符一次性排入引擎 */
export const LOOKAHEAD_SEC = 0.1
/** 定时器间隔（ms） */
export const TICK_MS = 25
/** 排期补偿（秒）：避免定时器回调边界的竞态 */
const LATENCY_SEC = 0.015

/**
 * 练习模式和弦分组容差（秒）：start 相差不超过此值的音符视为同一和弦、原子等待与放行。
 * 30ms 远小于 120bpm 十六分音符间隔（125ms），不会误并相邻和弦（设计文档
 * 20260906-midi-keyboard-and-practice.md §2-4）。
 */
export const CHORD_EPSILON_SEC = 0.03

/** 练习模式等待中的和弦（到达判定线、冻结播放位置直到放行） */
export interface PracticeChord {
  /** 和弦起点（秒） */
  start: number
  /** 组内全部音符（start ∈ [start, start + CHORD_EPSILON_SEC]） */
  notes: Note[]
}

type StateListener = (state: TransportState) => void
type PracticeChordListener = (chord: PracticeChord | null) => void

/**
 * 播放状态机 + lookahead 调度器 + 时钟（设计文档 §4、§6.3）。
 *
 * 唯一时钟：AudioContext.currentTime。position = now - offset。
 * 调度器只负责声音准时；视觉由视图每帧读 position（不依赖任何音频回调）。
 */
export class Transport {
  private song: Song | null = null
  private notes: Song['notes'] = []
  private engine: AudioEngine
  private host: TransportHost
  private offset = 0
  private pausedAt = 0
  private nextIndex = 0
  private intervalId: number | undefined
  private listeners = new Set<StateListener>()
  private _state: TransportState = 'empty'
  private _duration = 0
  private volume = 1
  /** 练习模式开关（见设计文档 20260906-midi-keyboard-and-practice.md §3.3） */
  private practiceEnabled = false
  /** 练习模式等待中的和弦；null = 未等待 */
  private waitingChord: PracticeChord | null = null
  private practiceChordCb: PracticeChordListener | null = null
  /** MIDI 输出镜像（可选）：与引擎同步排期的外部音源（无输出端口时为 null） */
  private midiOut: MidiOutputSink | null = null

  constructor(engine: AudioEngine, host: TransportHost) {
    this.engine = engine
    this.host = host
  }

  get state(): TransportState {
    return this._state
  }

  get duration(): number {
    return this._duration
  }

  /** 实时位置（秒）：播放中按音频时钟计算，暂停时取暂停位置；练习等待时冻结在和弦起点 */
  get position(): number {
    if (this._state === 'playing') {
      // 等待中的和弦：位置恒为和弦起点（不随时钟推进，也不受时长钳制）
      if (this.waitingChord !== null) return this.waitingChord.start
      return Math.min(this._duration, Math.max(0, this.host.now() - this.offset))
    }
    return this.pausedAt
  }

  on(event: 'statechange', cb: StateListener): () => void {
    if (event !== 'statechange') return () => {}
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  setEngine(engine: AudioEngine): void {
    if (this.engine.id === engine.id) {
      this.engine = engine
      return
    }
    const wasPlaying = this._state === 'playing'
    const pos = this.position
    this.silenceAll()
    this.engine = engine
    engine.setVolume(this.volume)
    if (this.song !== null) {
      this.pausedAt = pos
      this.cancelWaiting()
      this.setPointer(pos)
      if (wasPlaying) {
        this.offset = this.host.now() - pos
        this.setState('playing')
      } else if (this._state !== 'empty') {
        this.setState('paused')
      }
    }
  }

  load(song: Song): void {
    this.stopTicker()
    this.silenceAll()
    this.cancelWaiting()
    this.song = song
    this.notes = song.notes
    this._duration = song.duration
    this.pausedAt = 0
    this.offset = this.host.now()
    this.nextIndex = 0
    this.setState('ready')
  }

  play(): void {
    if (this.song === null || this._state === 'playing') return
    if (this._state === 'empty') return
    if (this.pausedAt >= this._duration - 0.001) {
      // 播完后再点播放：从头开始
      this.seek(0)
    }
    this.offset = this.host.now() - this.pausedAt
    this.setState('playing')
    this.tick()
    this.startTicker()
  }

  pause(): void {
    if (this._state !== 'playing') return
    this.pausedAt = this.position
    this.stopTicker()
    this.silenceAll()
    // 取消练习等待：暂停期间琴键不参与判定，恢复播放时重新进入等待并回调
    this.cancelWaiting()
    this.setState('paused')
  }

  stop(): void {
    if (this.song === null) return
    this.pausedAt = 0
    this.offset = this.host.now()
    this.stopTicker()
    this.silenceAll()
    this.cancelWaiting()
    this.nextIndex = 0
    this.setState('paused')
  }

  seek(seconds: number): void {
    if (this.song === null) return
    const wasPlaying = this._state === 'playing'
    const target = Math.max(0, Math.min(this._duration, seconds))
    this.silenceAll()
    this.pausedAt = target
    this.cancelWaiting()
    this.setPointer(target)
    this.offset = this.host.now() - target
    this.setState(wasPlaying ? 'playing' : 'paused')
    if (wasPlaying) this.tick()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.engine.setVolume(this.volume)
  }

  /** 实时演奏透传（MIDI 键盘）：按下/松开，绕过调度器直接驱动引擎（设计文档 §3.2） */
  liveNoteOn(pitch: number, velocity: number): void {
    this.engine.noteOn(pitch, velocity)
  }

  liveNoteOff(pitch: number): void {
    this.engine.noteOff(pitch)
  }

  /** 设置 / 解除 MIDI 输出镜像（外部音源与引擎同步发声；无输出端口时传 null） */
  setMidiOutput(sink: MidiOutputSink | null): void {
    this.midiOut = sink
  }

  get practiceMode(): boolean {
    return this.practiceEnabled
  }

  /**
   * 开关练习模式（设计文档 20260906-midi-keyboard-and-practice.md §3.3）。
   * 进入：清掉 lookahead 已排期与发声中的音符，指针改为“第一个 start ≥ 当前位置”；
   * 退出：等待中的和弦按正常调度立即发声并继续（指针天然指向该和弦起点）。
   */
  setPracticeMode(on: boolean): void {
    if (this.practiceEnabled === on) return
    this.practiceEnabled = on
    if (on) {
      this.silenceAll()
      this.cancelWaiting()
      if (this.song !== null) this.setNotePointerStart(this.position)
    } else {
      this.cancelWaiting()
    }
  }

  /**
   * 订阅练习等待事件：播放位置到达和弦起点时回调该和弦（位置冻结在起点）；
   * null 表示等待被取消（seek/停止/暂停/退出练习等）。
   */
  onPracticeChord(cb: PracticeChordListener): () => void {
    this.practiceChordCb = cb
    return () => {
      if (this.practiceChordCb === cb) this.practiceChordCb = null
    }
  }

  /** 放行当前等待的和弦：立即以当前时间发声（原始时值/力度），位置从和弦起点继续推进 */
  releaseChord(): void {
    if (!this.practiceEnabled || this.waitingChord === null) return
    const chord = this.waitingChord
    const now = this.host.now()
    for (const n of chord.notes) {
      if (n.end <= chord.start) continue
      this.scheduleToBoth({
        pitch: n.pitch,
        velocity: n.velocity,
        time: now,
        duration: n.end - n.start,
      })
    }
    let i = this.nextIndex
    const until = chord.start + CHORD_EPSILON_SEC
    while (i < this.notes.length && this.notes[i].start <= until) i++
    this.nextIndex = i
    this.waitingChord = null
    this.offset = now - chord.start
  }

  dispose(): void {
    this.stopTicker()
    this.silenceAll()
    this.listeners.clear()
    this.practiceChordCb = null
    this.waitingChord = null
    this.setState('empty')
  }

  /** 定时器回调：把 [now+latency, now+latency+lookahead] 窗口内的音符排入引擎 */
  tick(): void {
    if (this._state !== 'playing' || this.song === null) return
    if (this.practiceEnabled) {
      this.tickPractice()
      return
    }
    const now = this.host.now()
    const pos = now - this.offset
    const from = pos + LATENCY_SEC
    const until = pos + LOOKAHEAD_SEC
    const notes = this.notes

    while (this.nextIndex < notes.length && notes[this.nextIndex].start < until) {
      const n = notes[this.nextIndex]
      this.nextIndex++
      if (n.end <= from) continue
      const atTime = this.offset + n.start
      this.scheduleToBoth({
        pitch: n.pitch,
        velocity: n.velocity,
        time: atTime,
        duration: n.end - n.start,
      })
    }

    if (pos >= this._duration) {
      this.pausedAt = this._duration
      this.stopTicker()
      this.setState('paused')
    }
  }

  /** 练习模式调度：到达下一和弦起点时冻结位置并回调等待，不排入引擎 */
  private tickPractice(): void {
    if (this.waitingChord !== null) return
    const notes = this.notes
    const now = this.host.now()
    const pos = now - this.offset
    if (this.nextIndex >= notes.length) {
      if (pos >= this._duration) {
        this.pausedAt = this._duration
        this.stopTicker()
        this.setState('paused')
      }
      return
    }
    const first = notes[this.nextIndex]
    if (pos >= first.start) {
      const chord: PracticeChord = { start: first.start, notes: this.collectChord(first.start) }
      this.waitingChord = chord
      // 冻结：位置精确停在和弦起点（音符条底贴在判定线上）
      this.offset = now - chord.start
      this.practiceChordCb?.(chord)
    }
  }

  /** 收集 [start, start + CHORD_EPSILON_SEC] 内的整组音符（nextIndex 总在组首） */
  private collectChord(start: number): Note[] {
    const group: Note[] = []
    let i = this.nextIndex
    const until = start + CHORD_EPSILON_SEC
    while (i < this.notes.length && this.notes[i].start <= until) {
      group.push(this.notes[i])
      i++
    }
    return group
  }

  /** 取消练习等待并通知订阅者（无等待时为空操作） */
  private cancelWaiting(): void {
    if (this.waitingChord === null) return
    this.waitingChord = null
    this.practiceChordCb?.(null)
  }

  /** 音符排期：引擎与 MIDI 输出镜像同步各发一份（设计文档 §3.6） */
  private scheduleToBoth(ev: ScheduledNote): void {
    this.engine.scheduleNote(ev)
    this.midiOut?.scheduleNote(ev)
  }

  /** 静默：引擎止音 + MIDI 输出清空队列并 All Notes Off（暂停/停止/跳转等） */
  private silenceAll(): void {
    this.engine.allNotesOff()
    this.midiOut?.allNotesOff()
  }

  private startTicker(): void {
    if (this.intervalId !== undefined) return
    this.intervalId = this.host.setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicker(): void {
    if (this.intervalId !== undefined) {
      this.host.clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  /** 按当前模式定位音符指针：练习模式用 start 指针（等待从当前位置起的第一组音符） */
  private setPointer(position: number): void {
    if (this.practiceEnabled) this.setNotePointerStart(position)
    else this.setNotePointer(position)
  }

  /** end 指针：二分第一个 end > position 的音符（正常调度，不重排已开始的音符） */
  private setNotePointer(position: number): void {
    let lo = 0
    let hi = this.notes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.notes[mid].end <= position) lo = mid + 1
      else hi = mid
    }
    this.nextIndex = lo
  }

  /** start 指针：二分第一个 start >= position 的音符（练习模式，进入时放弃已开始的音符） */
  private setNotePointerStart(position: number): void {
    let lo = 0
    let hi = this.notes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.notes[mid].start < position) lo = mid + 1
      else hi = mid
    }
    this.nextIndex = lo
  }

  private setState(state: TransportState): void {
    if (this._state === state) return
    this._state = state
    for (const cb of this.listeners) cb(state)
  }
}
