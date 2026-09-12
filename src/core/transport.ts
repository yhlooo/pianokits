import type { Note, Song } from './model'
import type { AudioEngine, ScheduledNote } from './engine/types'
import {
  buildPedalSegments,
  mergePedalGates,
  pedalFocus,
  pedalsDownAt,
  type PedalFocus,
  type PedalId,
  type PedalPracticeMode,
  type PedalSegment,
} from './midi/pedals'

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

/**
 * 踏板事件与和弦合并窗口（秒）：相差不超过此时长的踏板踩下事件并入该和弦闸门（与琴键一起踩），
 * 更远的踏板踩下各自成为**独立闸门**（踏板与按键同等地位，设计文档
 * 20260912-midi-pedal-lane-and-practice.md §3.5）。200ms 约等于 120bpm 的十六分音符，
 * 足以容下真实演奏中踏板略早/略晚于和弦的偏移，又不会把相邻和弦的踏板张冠李戴。
 */
export const PEDAL_CHORD_WINDOW_SEC = 0.2

/**
 * 练习闸门点（Transport 内部）：门控轨和弦起点 或 关注范围内的踏板踩下事件（相近者合并）。
 * 踏板与按键同等地位——没有音符要按的时刻也能单独成闸门。
 */
interface PracticeGate {
  /** 判定时刻（冻结位置）；合并到和弦时 = 和弦起点，独立踏板闸门 = 踏板踩下时刻 */
  start: number
  /** 本闸门的门控轨和弦起点；纯踏板闸门为 null */
  noteStart: number | null
  /** 本闸门要求「现踩」的踏板（边缘触发） */
  pedals: readonly PedalId[]
}

/** 练习模式等待中的和弦（进入提前触发窗口后回调、到达判定线冻结直到放行） */
export interface PracticeChord {
  /** 和弦起点（秒） */
  start: number
  /** 组内全部门控轨音符（start ∈ [start, start + CHORD_EPSILON_SEC]；非门控轨音符不参与判定） */
  notes: Note[]
  /**
   * 豁免键：在和弦起点处仍「在瀑布流键盘上」或「正进入」的音符音高（任意轨）——
   * 即 `note.start ≤ start + CHORD_EPSILON_SEC 且 note.end > start`。等待期间按下这些键
   * 不算错（已触发的长音符重复按、分轨练习中非练习轨音符），也不重复触发（见 chord-gate）。
   */
  excused: ReadonlySet<number>
  /**
   * 本闸门要求**现踩**的踏板（边缘触发）：文件在该时刻踩下的踏板（与和弦相差
   * `PEDAL_CHORD_WINDOW_SEC` 以内的踩下事件并入本闸门、更远的独立成闸门）。
   * 必须是本闸门开始之后收到的踩下转变才算数——一直踩着不放不能通过。
   */
  requiredPedals: ReadonlySet<PedalId>
  /**
   * 本闸门参与判定的踏板（练习模式 ∩ 练习范围）：踩下这些踏板而非要求踏板 → 误踩红显，
   * 有闸门等待时阻止放行；不在集合内的踏板完全忽略（不判定、不标红）。
   */
  judgedPedals: ReadonlySet<PedalId>
}

type StateListener = (state: TransportState) => void
type PracticeChordListener = (chord: PracticeChord | null) => void

/**
 * 播放状态机 + lookahead 调度器 + 时钟（设计文档 §4、§6.3）。
 *
 * 唯一时钟：AudioContext.currentTime。position = now - offset。
 * 调度器只负责声音准时；视觉由视图每帧读 position（不依赖任何音频回调）。
 *
 * 练习模式（分轨门控 + 踏板要求，设计文档 20260906-…-and-practice.md §3.3、
 * 20260912-midi-pedal-lane-and-practice.md §3.5）：门控和弦携带参与判定的音符、豁免音高
 * 与踏板要求；走带在判定线冻结直到 ChordGate 放行，踏板关注范围经 `pedalFocus` 外发。
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
  /** 踏板练习模式（off/sustain/all；设计文档 20260912-midi-pedal-lane-and-practice.md §3.5） */
  private pedalMode: PedalPracticeMode = 'off'
  /** 曲目踏板踩下区间（load 时构建；门控和弦的踏板要求与瀑布流共用同一数据） */
  private pedalSegments: PedalSegment[] = []
  /** 当前踏板关注范围缓存（门控集合/踏板模式/曲目变化时重算）；null = 练习未开启 */
  private pedalFocusCache: PedalFocus | null = null
  /**
   * 练习闸门点（按时间排序）：门控轨和弦起点 ∪ 关注范围内的踏板踩下事件
   * （相近者合并，见 mergePedalGates）。踏板与按键同等地位——纯踏板时刻也能单独成闸门。
   */
  private gates: PracticeGate[] = []
  /** 闸门指针：第一个尚未处理的闸门 */
  private nextGate = 0
  /** 练习模式等待中的闸门（可能只有踏板要求，没有音符）；null = 未等待 */
  private waitingChord: PracticeChord | null = null
  /** 等待中闸门的音符下标（放行时打「已排期」标记，退出练习后不重复发声） */
  private waitingIndices: number[] = []
  /** 当前等待的闸门是否冻结视觉位置（position 恒停在闸门起点，音符条底贴判定线） */
  private waitingFrozen = false
  /** 自由流指针：第一个尚未排期的非门控轨音符（只排期到下一个闸门之前） */
  private nextFree = 0
  private practiceChordCb: PracticeChordListener | null = null
  /** MIDI 输出镜像（可选）：与引擎同步排期的外部音源（无输出端口时为 null） */
  private midiOut: MidiOutputSink | null = null
  /** 拖动预览（scrub）进行中（用于记录拖动前是否在播放，结束后恢复） */
  private scrubbing = false
  /** 拖动前是否在播放（endScrub 据此决定是否恢复播放） */
  private scrubResume = false

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
    this.pedalSegments = buildPedalSegments(song.pedalEvents)
    this.applyPedalFocus()
    this._duration = song.duration
    this.pausedAt = 0
    this.offset = this.host.now()
    this.nextIndex = 0
    this.nextGate = 0
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

  /**
   * 拖动预览（静音）：移动播放位置并止音，但不恢复播放、不排期发声——拖动瀑布流/进度条
   * 快速扫过大量音符时不触发声音（MIDI 大量发声会卡顿）。首次调用记录拖动前是否在播放，
   * 供 endScrub 在拖动结束后恢复。
   */
  scrub(seconds: number): void {
    if (this.song === null) return
    if (!this.scrubbing) {
      this.scrubbing = true
      this.scrubResume = this._state === 'playing'
    }
    const target = Math.max(0, Math.min(this._duration, seconds))
    this.silenceAll()
    this.pausedAt = target
    this.cancelWaiting()
    this.setPointer(target)
    this.offset = this.host.now() - target
    this.stopTicker()
    this.setState('paused')
  }

  /** 拖动结束：若拖动前在播放，则从当前位置恢复播放（此刻才开始发声） */
  endScrub(): void {
    if (!this.scrubbing) return
    this.scrubbing = false
    const resume = this.scrubResume
    this.scrubResume = false
    if (resume && this.song !== null) this.play()
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
   * 当前踏板关注范围（练习模式下踏板轨道的高亮/判定范围；设计文档 §3.5）：
   * null = 分轨练习未开启；非 null 但 pedals 为空 = 练习中但不判定任何踏板
   * （踏板练习为 off，或练习轨通道内没有踏板数据）——此时踏板轨道全部压暗、和弦无踏板要求。
   */
  get pedalFocus(): PedalFocus | null {
    return this.pedalFocusCache
  }

  /**
   * 关注范围内、**文件在 `at` 时刻正处于踩下状态**的踏板（踩下区间的持续期间；设计文档
   * 20260912-midi-pedal-lane-and-practice.md §3.5 的 2026-09-12 修订）。
   * 练习判定用它把长踏板与长音符同等对待：持续期间内松开再踩不算误踩——判定时刻通常是
   * 冻结/播放中的当前位置，故由调用方传入（`position` 在等待期间恒为闸门起点）。
   */
  pedalsDownAt(at: number): ReadonlySet<PedalId> {
    const focus = this.pedalFocusCache
    if (focus === null) return new Set()
    return pedalsDownAt(this.pedalSegments, focus, at)
  }

  /**
   * 设置踏板练习模式（off/sustain/all）：关注范围变化会取消当前等待（放行条件已变），
   * 下一 tick 按新范围重新进入等待；无变化时为空操作。
   */
  setPedalPracticeMode(mode: PedalPracticeMode): void {
    if (this.pedalMode === mode) return
    this.pedalMode = mode
    this.cancelWaiting()
    this.applyPedalFocus()
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
    this.applyPedalFocus()
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
   * 订阅练习等待事件：播放位置进入门控和弦的提前触发窗口时回调该和弦（可提前按键），
   * 位置到达和弦起点后冻结；null 表示等待被取消（seek/停止/暂停/调整门控集合/退出练习等）。
   */
  onPracticeChord(cb: PracticeChordListener): () => void {
    this.practiceChordCb = cb
    return () => {
      if (this.practiceChordCb === cb) this.practiceChordCb = null
    }
  }

  /**
   * 放行当前等待的闸门：闸门指针前移，并把位置回拨/追到闸门起点后继续推进（提前放行时位置
   * 前跳到闸门起点）。门控轨音符**不在此排期发声**——练习按键经 `echoNote` 原样回送到键盘
   * 音源（力度=按键力度，弹错的音也发声）；同 onset 的非门控音符由自由流在放行后的下一
   * tick 以放行时刻排期，随闸门一起发声。
   */
  releaseChord(): void {
    if (this.gatedTracks.size === 0 || this.waitingChord === null) return
    const chord = this.waitingChord
    const now = this.host.now()
    // 放行的门控轨音符打上已排期标记：退出练习后正常流不重复发声（它们已由 echoNote 发声）
    for (const i of this.waitingIndices) this.consumed[i] = 1
    this.waitingIndices = []
    this.nextGate++
    this.waitingChord = null
    // 回拨 offset 从闸门起点继续：同 onset 的非门控音符由自由流在下一 tick 排期，
    // 发声时刻 = now（与放行同步）；后续音符相对放行时刻继续推进
    this.offset = now - chord.start
    this.waitingFrozen = false
  }

  dispose(): void {
    this.stopTicker()
    this.silenceAll()
    this.listeners.clear()
    this.practiceChordCb = null
    this.waitingChord = null
    this.waitingIndices = []
    this.waitingFrozen = false
    this.pedalSegments = []
    this.gates = []
    this.pedalFocusCache = null
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
   * 分轨练习调度：非门控轨按 lookahead 窗口排期（不越过下一个门控和弦）；门控轨进入提前
   * 触发窗口时先回调（允许提前按键），到达和弦起点时冻结播放位置。冻结后整体静默：非门控
   * 轨也不再排期（同 onset 的非门控音符随和弦一起等待，放行后随和弦一起发声）。
   */
  private tickGated(): void {
    const now = this.host.now()
    const pos = now - this.offset
    if (this.waitingChord === null) {
      this.scheduleFree(pos)
      this.tryPrimeGate(pos)
    } else if (!this.waitingFrozen) {
      this.scheduleFree(pos)
      this.tryFreezeChord(now, pos)
    }
    if (pos >= this._duration && this.waitingChord === null) {
      this.pausedAt = this._duration
      this.stopTicker()
      this.setState('paused')
    }
  }

  /**
   * 自由流：非门控轨音符按 lookahead 窗口排期，但**不越过下一个闸门起点**（闸门可能是和弦、
   * 也可能是独立的踏板踩下时刻）——与闸门同 onset 的非门控音符不由自由流提前排期，
   * 而是在放行后的 tick 以放行时刻排期（与闸门一起发声）。
   */
  private scheduleFree(pos: number): void {
    const notes = this.notes
    const from = pos + LATENCY_SEC
    const until = pos + LOOKAHEAD_SEC
    const gatedStart = this.nextGateStart()
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

  /**
   * 门控流：位置进入下一闸门的**提前触发窗口**（闸门起点前一个四分音符）时，收集门控轨和弦
   * （纯踏板闸门没有音符）并回调（让 gate 提前进入判定、可提前按键/踩踏板），但**不冻结位置**——
   * 音符继续下坠，人可提前一个四分音符触发。
   */
  private tryPrimeGate(pos: number): void {
    const gate = this.gates[this.nextGate]
    if (gate === undefined) return
    // 提前窗口：最多提前一个四分音符（按当前位置的拍速折算）
    if (pos < gate.start - this.earlyTriggerSeconds(gate.start)) return
    // 收集门控轨音符（纯踏板闸门没有音符 → 只判踏板）；用和弦自己的起点分组
    const group: Note[] = []
    const indices: number[] = []
    if (gate.noteStart !== null) {
      const from = gate.noteStart - 1e-6
      const until = gate.noteStart + CHORD_EPSILON_SEC
      for (let i = 0; i < this.notes.length && this.notes[i].start <= until; i++) {
        if (this.notes[i].start < from) continue // notes 按 start 排序：跳过更早的音符
        if (!this.gatedTracks.has(this.notes[i].trackIndex)) continue
        group.push(this.notes[i])
        indices.push(i)
      }
    }
    this.waitingIndices = indices
    this.waitingChord = {
      start: gate.start,
      notes: group,
      excused: this.excusedPitches(gate.start, gate.start + CHORD_EPSILON_SEC),
      requiredPedals: new Set(gate.pedals),
      judgedPedals: this.pedalFocusCache?.pedals ?? new Set(),
    }
    this.waitingFrozen = false
    this.practiceChordCb?.(this.waitingChord)
  }

  /** 重算踏板关注范围与练习闸门（曲目/门控集合/踏板模式变化时；瀑布流经 pedalFocus 读取同一结论） */
  private applyPedalFocus(): void {
    if (this.song === null) {
      this.pedalFocusCache = null
      this.gates = []
      return
    }
    this.pedalFocusCache = pedalFocus(
      this.pedalSegments,
      this.song.tracks,
      this.gatedTracks,
      this.pedalMode,
    )
    this.buildGates()
  }

  /**
   * 构造练习闸门：门控轨和弦起点 ∪ 关注范围内的踏板踩下事件（相差 ≤ PEDAL_CHORD_WINDOW_SEC
   * 的并入和弦，更远的独立成闸门）。notes 已按 start 排序，和弦按 CHORD_EPSILON_SEC 分组。
   */
  private buildGates(): void {
    const chordStarts: number[] = []
    for (const n of this.notes) {
      if (!this.gatedTracks.has(n.trackIndex)) continue
      const last = chordStarts[chordStarts.length - 1]
      if (last !== undefined && n.start - last <= CHORD_EPSILON_SEC) continue
      chordStarts.push(n.start)
    }
    const focus = this.pedalFocusCache
    const merged =
      focus === null || focus.pedals.size === 0
        ? chordStarts.map((start) => ({ start, pedals: [] as PedalId[] }))
        : mergePedalGates(chordStarts, this.pedalSegments, focus, PEDAL_CHORD_WINDOW_SEC)
    const isChord = new Set(chordStarts)
    this.gates = merged.map((g) => ({
      start: g.start,
      noteStart: isChord.has(g.start) ? g.start : null,
      pedals: g.pedals,
    }))
  }

  /** 下一个闸门的起点；无闸门则 null */
  private nextGateStart(): number | null {
    return this.gates[this.nextGate]?.start ?? null
  }

  /**
   * 豁免键：在和弦起点处仍在瀑布流键盘上（`note.end > onset`）或正进入
   * （`note.start ≤ onset + CHORD_EPSILON_SEC`）的音符音高，任意轨。等待期间按下这些键
   * 不算错也不重复触发（长音符重复按 / 分轨练习的非练习轨音符）。notes 按 start 排序，
   * 超过 until 即提前停止。
   */
  private excusedPitches(onset: number, until: number): Set<number> {
    const set = new Set<number>()
    for (const n of this.notes) {
      if (n.start > until) break
      if (n.end > onset) set.add(n.pitch)
    }
    return set
  }

  /** 冻结：位置到达已提前触发的门控和弦起点时，把播放位置停住（等待放行） */
  private tryFreezeChord(now: number, pos: number): void {
    if (this.waitingChord === null || this.waitingFrozen) return
    if (pos < this.waitingChord.start) return
    this.waitingFrozen = true
    this.offset = now - this.waitingChord.start
  }

  /** 提前触发窗口时长（秒）：一个四分音符（按 at 处生效的拍速折算） */
  private earlyTriggerSeconds(at: number): number {
    const tempos = this.song?.tempos ?? []
    let bpm = 120
    for (const t of tempos) {
      if (t.time <= at + 1e-6) bpm = t.bpm
      else break
    }
    return 60 / Math.max(1, bpm)
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

  /**
   * 门控模式指针：自由流定位到第一个 start ≥ position 的非门控轨音符，闸门指针定位到
   * 第一个 start ≥ position 的闸门（进入时放弃已开始的音符与已越过的闸门）。
   */
  private setPracticePointers(position: number): void {
    this.nextFree = this.firstOf((n) => !this.gatedTracks.has(n.trackIndex), position)
    this.nextGate = this.firstGateAtOrAfter(position)
    this.consumed.fill(0)
  }

  /** 第一个 start ≥ position 的闸门下标；无则 gates.length */
  private firstGateAtOrAfter(position: number): number {
    let i = 0
    while (i < this.gates.length && this.gates[i].start < position) i++
    return i
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
