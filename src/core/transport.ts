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
  /** 组内全部门控轨音符（start ∈ [start, start + CHORD_EPSILON_SEC]；非门控轨音符照常排期，不参与判定） */
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
  /**
   * 每个音符是否已排期/放行（分轨练习退出时合并双流指针用）：
   * 门控期间自由流排期、放行和弦都会打标；退出练习后正常流跳过已打标音符，
   * 避免与自由流重复发声。任何指针重定位（load/seek/stop/换引擎/调整门控集合）都会清空。
   */
  private consumed = new Uint8Array(0)
  private intervalId: number | undefined
  private listeners = new Set<StateListener>()
  private _state: TransportState = 'empty'
  private _duration = 0
  private volume = 1
  /**
   * 分轨练习门控集合（轨道 index，设计文档 20260906-midi-keyboard-and-practice.md §3.3）：
   * 空集 = 关闭练习；集合内的轨到达判定线时等待琴键放行（冻结整个播放），集合外的轨
   * 与门控和弦同 onset 时随和弦一起等待/放行，其余照常排期播放。
   */
  private gatedTracks = new Set<number>()
  /** 练习模式等待中的和弦（仅含门控轨音符）；null = 未等待 */
  private waitingChord: PracticeChord | null = null
  /** 当前等待的和弦是否冻结视觉位置（position 恒停在和弦起点，音符条底贴判定线） */
  private waitingFrozen = false
  /** 门控流指针：第一个尚未处理的门控轨音符（和弦收集与放行推进） */
  private nextGated = 0
  /** 自由流指针：第一个尚未排期的非门控轨音符（只排期到下一个门控和弦之前） */
  private nextFree = 0
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
      // 冻结中的和弦：位置恒为和弦起点（不随时钟推进，也不受时长钳制）；
      // 等待期间整个播放冻结，放行后从和弦起点继续推进
      if (this.waitingChord !== null && this.waitingFrozen) return this.waitingChord.start
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
    this.nextGated = 0
    this.nextFree = 0
    this.consumed = new Uint8Array(this.notes.length)
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
    this.setPointer(0)
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

  /** 当前门控轨集合（副本）；空集 = 练习关闭 */
  get practiceTracks(): ReadonlySet<number> {
    return new Set(this.gatedTracks)
  }

  /**
   * 设置分轨练习门控集合（设计文档 20260906-midi-keyboard-and-practice.md §3.3）：
   * - 进入/调整集合：清掉已排期与发声中的音符，取消当前等待，两个流指针按
   *   “第一个 start ≥ 当前位置”重定位（放弃已开始的音符，同全局练习进入语义）；
   * - 清空集合（退出）：取消等待，正常流指针按当前位置重定位，等待中的和弦
   *   按正常调度立即发声并继续。
   */
  setPracticeTracks(tracks: ReadonlySet<number>): void {
    const next = new Set(tracks)
    if (this.sameSet(this.gatedTracks, next)) return
    this.gatedTracks = next
    if (next.size === 0) {
      // 退出：取消等待，正常流从第一个未排期音符继续（已排期的自由轨音符不重复发声）
      this.cancelWaiting()
      this.nextIndex = this.firstUnconsumed()
    } else {
      this.silenceAll()
      this.cancelWaiting()
      this.setPracticePointers(this.position)
    }
  }

  /**
   * 订阅练习等待事件：播放位置到达门控和弦起点时回调该和弦（位置冻结在起点）；
   * null 表示等待被取消（seek/停止/暂停/调整门控集合/退出练习等）。
   */
  onPracticeChord(cb: PracticeChordListener): () => void {
    this.practiceChordCb = cb
    return () => {
      if (this.practiceChordCb === cb) this.practiceChordCb = null
    }
  }

  /**
   * 放行当前等待的和弦：立即以当前时间发声（原始时值/力度），并回拨 offset 从和弦起点
   * 继续推进。同 onset 的非门控音符由自由流在放行后的下一 tick 以同一时刻排期，随和弦一起发声。
   */
  releaseChord(): void {
    if (this.gatedTracks.size === 0 || this.waitingChord === null) return
    const chord = this.waitingChord
    const now = this.host.now()
    // 放行的音符打上已排期标记：退出练习后正常流不重复发声
    let mark = this.nextGated
    const markUntil = chord.start + CHORD_EPSILON_SEC
    while (mark < this.notes.length && this.notes[mark].start <= markUntil) {
      if (this.gatedTracks.has(this.notes[mark].trackIndex)) this.consumed[mark] = 1
      mark++
    }
    for (const n of chord.notes) {
      if (n.end <= chord.start) continue
      this.scheduleToBoth({
        pitch: n.pitch,
        velocity: n.velocity,
        time: now,
        duration: n.end - n.start,
      })
    }
    // 门控流越过整组（组内非门控音符由自由流独立排期，无需处理）
    this.nextGated = mark
    this.waitingChord = null
    // 回拨 offset 从和弦起点继续：同 onset 的非门控音符由自由流在下一 tick 排期，
    // 发声时刻 = now（与门控和弦一起播放）；后续音符相对放行时刻继续推进
    this.offset = now - chord.start
    this.waitingFrozen = false
  }

  dispose(): void {
    this.stopTicker()
    this.silenceAll()
    this.listeners.clear()
    this.practiceChordCb = null
    this.waitingChord = null
    this.waitingFrozen = false
    this.setState('empty')
  }

  /** 定时器回调：把 [now+latency, now+latency+lookahead] 窗口内的音符排入引擎 */
  tick(): void {
    if (this._state !== 'playing' || this.song === null) return
    if (this.gatedTracks.size > 0) {
      this.tickGated()
      return
    }
    const now = this.host.now()
    const pos = now - this.offset
    const from = pos + LATENCY_SEC
    const until = pos + LOOKAHEAD_SEC
    const notes = this.notes

    while (this.nextIndex < notes.length && notes[this.nextIndex].start < until) {
      const i = this.nextIndex
      const n = notes[i]
      this.nextIndex = i + 1
      if (this.consumed[i] === 1) continue // 退出分轨练习时已排期的音符
      if (n.end <= from) continue
      const atTime = this.offset + n.start
      this.scheduleToBoth({
        pitch: n.pitch,
        velocity: n.velocity,
        time: atTime,
        duration: n.end - n.start,
      })
      this.consumed[i] = 1
    }

    if (pos >= this._duration) {
      this.pausedAt = this._duration
      this.stopTicker()
      this.setState('paused')
    }
  }

  /**
   * 分轨练习调度：非门控轨按 lookahead 窗口排期（不越过下一个门控和弦）；门控轨到达和弦
   * 起点时收集等待。等待期间整体冻结：非门控轨也不再排期（同 onset 的非门控音符随和弦
   * 一起等待，放行后随和弦一起发声）。
   */
  private tickGated(): void {
    const now = this.host.now()
    const pos = now - this.offset
    if (this.waitingChord === null) {
      this.scheduleFree(pos)
      this.tryCollectChord(now, pos)
    }
    if (pos >= this._duration && this.waitingChord === null) {
      this.pausedAt = this._duration
      this.stopTicker()
      this.setState('paused')
    }
  }

  /**
   * 自由流：非门控轨音符按 lookahead 窗口排期，但**不越过下一个门控和弦起点**——
   * 与门控和弦同 onset 的非门控音符不由自由流提前排期，而是在放行后的 tick 以放行时刻
   * 排期（与门控和弦一起发声）。
   */
  private scheduleFree(pos: number): void {
    const notes = this.notes
    const from = pos + LATENCY_SEC
    const until = pos + LOOKAHEAD_SEC
    const gatedStart = this.nextGatedStart()
    const limit = gatedStart === null ? until : Math.min(until, gatedStart)
    while (this.nextFree < notes.length && notes[this.nextFree].start < limit) {
      const i = this.nextFree
      const n = notes[i]
      this.nextFree = i + 1
      if (this.gatedTracks.has(n.trackIndex)) continue // 门控轨留给门控流
      if (n.end <= from) continue
      this.scheduleToBoth({
        pitch: n.pitch,
        velocity: n.velocity,
        time: this.offset + n.start,
        duration: n.end - n.start,
      })
      this.consumed[i] = 1
    }
  }

  /** 下一个门控轨音符的起点（从门控指针出发跳过非门控音符）；无则 null */
  private nextGatedStart(): number | null {
    let i = this.nextGated
    while (i < this.notes.length && !this.gatedTracks.has(this.notes[i].trackIndex)) i++
    return i < this.notes.length ? this.notes[i].start : null
  }

  /** 门控流：位置到达下一门控和弦起点时收集整组（仅门控轨音符）并回调等待 */
  private tryCollectChord(now: number, pos: number): void {
    const notes = this.notes
    // 从门控指针出发找到第一个门控轨音符（非门控音符永久跳过）
    let i = this.nextGated
    while (i < notes.length && !this.gatedTracks.has(notes[i].trackIndex)) i++
    if (i >= notes.length) {
      this.nextGated = notes.length
      return
    }
    this.nextGated = i
    const first = notes[i]
    if (pos < first.start) return
    // 收集 [start, start + CHORD_EPSILON_SEC] 内的整组门控轨音符
    const until = first.start + CHORD_EPSILON_SEC
    const group: Note[] = []
    while (i < notes.length && notes[i].start <= until) {
      if (this.gatedTracks.has(notes[i].trackIndex)) group.push(notes[i])
      i++
    }
    // 冻结在判定线（position 停在和弦起点，音符条底贴判定线）；同时回拨 offset，放行后
    // 从和弦起点继续（同 onset 的非门控音符由自由流在放行后的 tick 以放行时刻补发）
    this.waitingChord = { start: first.start, notes: group }
    this.waitingFrozen = true
    this.offset = now - first.start
    this.practiceChordCb?.(this.waitingChord)
  }

  /** 取消练习等待并通知订阅者（无等待时为空操作） */
  private cancelWaiting(): void {
    if (this.waitingChord === null) return
    this.waitingChord = null
    this.waitingFrozen = false
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

  /** 按当前模式定位音符指针：门控模式用双流 start 指针（等待从当前位置起的第一组音符） */
  private setPointer(position: number): void {
    if (this.gatedTracks.size > 0) this.setPracticePointers(position)
    else this.setNotePointer(position)
  }

  /**
   * start 指针：二分第一个 start >= position 的音符（notes 按 start 排序，end 并不单调，
   * 不能对 end 二分）。跳过已开始的音符（不重排），与练习模式「第一个 start ≥ 当前位置」一致；
   * 重定位时清空已排期标记。
   */
  private setNotePointer(position: number): void {
    let lo = 0
    let hi = this.notes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.notes[mid].start < position) lo = mid + 1
      else hi = mid
    }
    this.nextIndex = lo
    this.consumed.fill(0)
  }

  /** 门控模式双流指针：各自定位到第一个 start ≥ position 的门控轨 / 非门控轨音符（进入时放弃已开始的音符） */
  private setPracticePointers(position: number): void {
    this.nextGated = this.firstOf((n) => this.gatedTracks.has(n.trackIndex), position)
    this.nextFree = this.firstOf((n) => !this.gatedTracks.has(n.trackIndex), position)
    this.consumed.fill(0)
  }

  /** 第一个未排期音符的下标（退出分轨练习时正常流起点）；无则 notes.length */
  private firstUnconsumed(): number {
    let i = 0
    while (i < this.notes.length && this.consumed[i] === 1) i++
    return i
  }

  /** 第一个满足谓词且 start ≥ position 的音符下标；无则 notes.length */
  private firstOf(pred: (n: Note) => boolean, position: number): number {
    let i = 0
    while (i < this.notes.length) {
      const n = this.notes[i]
      if (pred(n) && n.start >= position) break
      i++
    }
    return i
  }

  /** 两个轨号集合内容一致（避免无变化时重复进入/退出） */
  private sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    if (a.size !== b.size) return false
    for (const x of a) {
      if (!b.has(x)) return false
    }
    return true
  }

  private setState(state: TransportState): void {
    if (this._state === state) return
    this._state = state
    for (const cb of this.listeners) cb(state)
  }
}
