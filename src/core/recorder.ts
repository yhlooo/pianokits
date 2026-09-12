import { MidiConnection, type MidiConnectionStatus } from './midi/connection'
import type { MidiNoteEvent } from './midi/input'
import { MidiOutputSink } from './midi/output'
import {
  MIN_NOTE_SEC,
  eraseRange,
  firstNoteAtOrAfter,
  mergeNotes,
  overlayNote,
  trackDuration,
  type RecordedNote,
} from './recorder-model'

/**
 * 录音走带（设计文档 20260912-midi-recorder.md §3）：
 * - 时间轴：0 起、按秒记时；`position` 即录制/播放线所在位置，拖动音轨改变它；
 * - 三种模式：idle（空闲/暂停）、playing（回放）、recording（录制）；播放与录制互斥；
 * - 录制是**覆盖录制**（punch-in）：一次录制 = 一次"扫过"——录制线从起点扫到当前位置，
 *   扫过区间内的旧内容按扫过的范围抹除（没扫到的位置原样保留，音符被扫到多少抹多少），
 *   同时把新弹的音符写进这一段（§3.3 的 pass 模型）；
 * - 录制/播放中拖动音轨 → 挂起（不录不放），录制在拖动处结束一次"扫过"、松手后从新位置重新开始；
 * - 回放：lookahead 调度，音符只经 MIDI 输出（连接的键盘音源）发声，本机不发声；
 * - 连接要求：未连接 MIDI 键盘时播放/录制不可用（视图禁用按钮 + Tips 提示）。
 */

/** lookahead 窗口（秒）：把未来 100ms 内开始的音符排入 MIDI 输出 */
export const LOOKAHEAD_SEC = 0.1
/** 调度定时器间隔（ms） */
export const TICK_MS = 25
/** 排期补偿（秒）：避免定时器回调边界的竞态 */
const LATENCY_SEC = 0.015

/** 录音工具的走带模式 */
export type RecorderMode =
  /** 空闲（含暂停播放/暂停录制） */
  | 'idle'
  /** 回放中 */
  | 'playing'
  /** 录制中 */
  | 'recording'

/** 走带离散状态（位置是连续量，视图每帧直接读 `position` 与 `visibleNotes()`） */
export interface RecorderUiState {
  mode: RecorderMode
  /** 音轨有内容（结束/保存/下载按钮可用前提；含录制中尚未收尾的音符） */
  hasNotes: boolean
  /** 音轨总时长（秒，最后一个音符的结束时刻） */
  duration: number
  /** MIDI 连接状态 */
  midiStatus: MidiConnectionStatus
  /** 是否已连接 MIDI 键盘（播放/录制可用前提） */
  midiConnected: boolean
  /** 已连接键盘显示名（多台逐行） */
  midiLabels: readonly string[]
}

/** 可注入时钟与定时器宿主（生产用 performance.now，测试用假时钟） */
export interface RecorderHost {
  now(): number
  setInterval(cb: () => void, ms: number): number
  clearInterval(id: number): void
}

export interface RecorderCallbacks {
  /** 离散状态变化（模式/是否有内容/连接状态） */
  onState(state: RecorderUiState): void
}

export interface RecorderControllerOptions {
  callbacks: RecorderCallbacks
  /** 省略则用 performance.now 单调时钟（秒） */
  host?: RecorderHost
}

/** 生产时钟：performance.now 毫秒 → 秒（与 MIDIOutput.send 的时间戳同源） */
const DEFAULT_HOST: RecorderHost = {
  now: () => performance.now() / 1000,
  setInterval: (cb, ms) => window.setInterval(cb, ms),
  clearInterval: (id) => window.clearInterval(id),
}

const EMPTY_NOTES: readonly RecordedNote[] = []

/** 录制中按住（尚未松开）的按键 */
interface HeldNote {
  start: number
  velocity: number
  channel: number
}

export class RecorderController {
  private readonly cbs: RecorderCallbacks
  private readonly host: RecorderHost
  private readonly midi: MidiConnection
  private readonly sink: MidiOutputSink
  /** 已提交的音轨（按 start 升序；覆盖录制中不含本次尚未收尾的新音符） */
  private _notes: RecordedNote[] = []
  /** 本次覆盖录制的起点（秒）；null = 当前没有进行中的录制 */
  private _passStart: number | null = null
  /** 本次录制已收尾的新音符（不受本次擦除影响，收尾时并入音轨） */
  private _passNotes: RecordedNote[] = []
  private _mode: RecorderMode = 'idle'
  /** 时钟是否推进（挂起时 false；模式仍保留，松手后继续） */
  private running = false
  /** 时钟锚点：`anchorWall` 时刻对应时间轴 `anchorPos` */
  private anchorWall = 0
  private anchorPos = 0
  /** 暂停/拖动时的时间轴位置（running 为 false 时生效） */
  private pausedPos = 0
  /** 录制中按住的键：pitch → 起点/力度/通道 */
  private readonly held = new Map<number, HeldNote>()
  /** 回放调度指针：第一个尚未排期的音符下标 */
  private nextIndex = 0
  private intervalId: number | undefined
  /** 拖动音轨中（挂起播放/录制） */
  private suspended = false
  private disposed = false

  constructor(opts: RecorderControllerOptions) {
    this.cbs = opts.callbacks
    this.host = opts.host ?? DEFAULT_HOST
    // 输出镜像的时钟即本走带时钟：排期时间（秒）× 1000 直接成为 send() 时间戳
    const host = this.host
    this.sink = new MidiOutputSink({
      get currentTime(): number {
        return host.now()
      },
    })
    this.midi = new MidiConnection({
      onStatus: () => this.onMidiStatus(),
      onNote: (ev) => this.onNote(ev),
      onOutputs: (outputs) => {
        // 端口清空（拔出）：先静默清队列，避免键盘残留长音
        if (outputs.length === 0) this.sink.allNotesOff()
        this.sink.sync(outputs)
      },
    })
    this.emitState()
  }

  /** 录制/播放线位置（秒） */
  get position(): number {
    if (!this.running) return this.pausedPos
    return Math.max(0, this.anchorPos + (this.host.now() - this.anchorWall))
  }

  get mode(): RecorderMode {
    return this._mode
  }

  /** 音轨总时长（秒）：当前可见音轨最后一个音符的结束时刻（覆盖录制中随擦除变化） */
  get duration(): number {
    return trackDuration(this.visibleNotes())
  }

  /**
   * 当前可见音轨：非录制中就是已提交的音轨；覆盖录制中是"旧音轨在录制线扫过区间内的部分
   * 已抹除"的结果 + 本次录制已收尾的新音符。线的左侧随录制推进不断被抹掉，右侧保持原样。
   * 视图与导出都取它（擦除是渐进的，不能用离散状态的快照）。
   */
  visibleNotes(): readonly RecordedNote[] {
    const from = this._passStart
    if (from === null) return this._notes
    return mergeNotes(eraseRange(this._notes, from, this.position), this._passNotes)
  }

  /** MIDI 连接状态（未连接时播放/录制不可用） */
  get midiStatus(): MidiConnectionStatus {
    return this.midi.status
  }

  /** 进入页面自动连接 MIDI 键盘（幂等；已授权时立即恢复已连设备） */
  autoConnect(): void {
    void this.midi.connect()
  }

  /**
   * 播放/暂停切换：从录制/播放线位置开始回放（播到末尾后再点播放则从头开始），
   * 音符只发往 MIDI 输出（键盘音源），本机不发声。
   */
  togglePlay(): void {
    if (this._mode === 'playing') {
      this.pausePlayback()
      return
    }
    if (this.disposed || this._notes.length === 0) return
    if (this.midi.status !== 'connected') return
    if (this._mode === 'recording') this.finishRecording()
    // 已到（或超过）末尾：从头开始，避免"点了播放没反应"
    if (this.pausedPos >= this.duration - 0.001) this.pausedPos = 0
    this._mode = 'playing'
    this.nextIndex = firstNoteAtOrAfter(this._notes, this.pausedPos)
    this.startClock()
    this.startTicker()
    this.tick()
    this.emitState()
  }

  /**
   * 录制/暂停切换：从录制/播放线位置开始**覆盖录制**（录制线扫过的旧内容被抹除）；
   * 暂停时把按住的键在当前位置收尾并结束这一次"扫过"，再点录制即从新位置重新开始。
   */
  toggleRecord(): void {
    if (this._mode === 'recording') {
      this.finishRecording()
      return
    }
    if (this.disposed || this.midi.status !== 'connected') return
    if (this._mode === 'playing') this.pausePlayback()
    this._mode = 'recording'
    this.held.clear()
    this.beginPass(this.pausedPos)
    this.startClock()
    this.emitState()
  }

  /**
   * 结束（清空音轨）：停止走带、丢弃全部音符并把位置复位到 0。
   * 视图负责二次确认后再调用。
   */
  clear(): void {
    this.held.clear()
    this.stopTicker()
    this.silence()
    this.running = false
    this.suspended = false
    this._mode = 'idle'
    this.pausedPos = 0
    this._notes = []
    this._passStart = null
    this._passNotes = []
    this.nextIndex = 0
    this.emitState()
  }

  /**
   * 开始拖动音轨：挂起播放/录制。录制中先把手上的键在当前位置收尾并**结束这一次扫过**
   * （擦除只到拖动起点为止——拖动会让位置跳变，跨过没扫到的区域不该被抹掉）；
   * 松手后从新位置重新开始一次覆盖录制。
   */
  beginScrub(): void {
    if (this.running) {
      if (this._mode === 'recording') {
        const at = this.position
        this.closeAllHeld(at)
        this.commitPass(at)
      }
      this.pausedPos = this.position
      this.running = false
      this.stopTicker()
      this.silence()
    }
    this.suspended = this._mode !== 'idle'
  }

  /** 拖动中：只移动位置，不播放也不录制 */
  scrub(position: number): void {
    this.pausedPos = Math.max(0, position)
    if (this._mode === 'playing') this.nextIndex = firstNoteAtOrAfter(this._notes, this.pausedPos)
  }

  /** 拖动结束：拖动前在播放/录制则从新位置继续（录制从新位置重新起一次覆盖） */
  endScrub(): void {
    if (!this.suspended) return
    this.suspended = false
    if (this._mode === 'recording') this.beginPass(this.pausedPos)
    this.startClock()
    if (this._mode === 'playing') {
      this.startTicker()
      this.tick()
    }
  }

  /**
   * 导出用音符快照（保存/下载共用）：以当前可见音轨为准（覆盖录制中已抹除的部分不再导出），
   * 录制中时把尚未收尾的音符补到当前位置；不改动走带状态。
   */
  exportNotes(): readonly RecordedNote[] {
    const base = this.visibleNotes()
    if (this._mode !== 'recording' || this.held.size === 0) return base
    const at = this.position
    let out: RecordedNote[] = [...base]
    for (const [pitch, h] of this.held) {
      out = overlayNote(out, {
        pitch,
        velocity: h.velocity,
        channel: h.channel,
        start: h.start,
        end: Math.max(at, h.start + MIN_NOTE_SEC),
      })
    }
    return out
  }

  /** 录制中尚未收尾的音符（供画面把条形一直画到录制线）；其余情况为空 */
  pendingNotes(): readonly RecordedNote[] {
    if (this._mode !== 'recording' || !this.running || this.held.size === 0) return EMPTY_NOTES
    const at = this.position
    const out: RecordedNote[] = []
    for (const [pitch, h] of this.held) {
      out.push({
        pitch,
        velocity: h.velocity,
        channel: h.channel,
        start: h.start,
        end: Math.max(at, h.start + 0.001),
      })
    }
    return out
  }

  /**
   * 恢复音轨（同一页面会话内切走再切回时保留录制内容）：装载音符、回到空闲模式，
   * 并把录制/播放线放到上次的位置；不做合并/裁剪（数据来自本工具自身）。
   */
  restore(notes: readonly RecordedNote[], position: number): void {
    this.held.clear()
    this.stopTicker()
    this.silence()
    this._notes = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    this._passStart = null
    this._passNotes = []
    this._mode = 'idle'
    this.running = false
    this.suspended = false
    this.pausedPos = Math.max(0, position)
    this.nextIndex = firstNoteAtOrAfter(this._notes, this.pausedPos)
    this.emitState()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopTicker()
    this.silence()
    this.held.clear()
    this.sink.dispose()
    this.midi.dispose()
  }

  // ---------- 内部 ----------

  /** 暂停回放：止音、停表、模式回 idle（位置留在原地） */
  private pausePlayback(): void {
    if (this._mode !== 'playing') return
    this.pausedPos = this.position
    this.running = false
    this.stopTicker()
    this.silence()
    this._mode = 'idle'
    this.emitState()
  }

  /** 暂停录制：按住的键在当前位置收尾，结束本次扫过（擦除落定），停表，模式回 idle */
  private finishRecording(): void {
    if (this._mode !== 'recording') return
    const at = this.position
    this.closeAllHeld(at)
    this.commitPass(at)
    this.pausedPos = at
    this.running = false
    this._mode = 'idle'
    this.emitState()
  }

  /** 开始一次覆盖录制：此后 [position, 录制线] 区间内的旧内容会被抹除 */
  private beginPass(position: number): void {
    this._passStart = position
    this._passNotes = []
  }

  /**
   * 结束本次扫过：把 [passStart, end] 内的旧内容正式抹除，并并入本次录制的新音符。
   * 只抹掉扫过的区间——区间之外的旧内容（包括跨越边界音符没被扫到的部分）保持原样。
   */
  private commitPass(end: number): void {
    const from = this._passStart
    if (from === null) return
    this._notes = mergeNotes(eraseRange(this._notes, from, end), this._passNotes)
    this._passStart = null
    this._passNotes = []
  }

  /** 把某个按住的键在 `end` 时刻收尾成音符并放进"本次录制的新音符" */
  private closeHeld(pitch: number, end: number): void {
    const h = this.held.get(pitch)
    if (h === undefined) return
    this.held.delete(pitch)
    // 新音符记在本次录制的批次里：它们位于录制线扫过的区间内，不该被本次擦除波及
    this._passNotes = overlayNote(this._passNotes, {
      pitch,
      velocity: h.velocity,
      channel: h.channel,
      start: h.start,
      end: Math.max(end, h.start + MIN_NOTE_SEC),
    })
    this.emitState()
  }

  /** 全部按住的键在 end 时刻收尾 */
  private closeAllHeld(end: number): void {
    for (const pitch of [...this.held.keys()]) this.closeHeld(pitch, end)
  }

  private onNote(ev: MidiNoteEvent): void {
    if (this.disposed) return
    // 实时监听：按键回送到键盘音源。连接后键盘自带音源被关闭（Local Control Off），
    // 回送是演奏者听到自己弹奏的唯一途径（与播放器练习模式同一做法）。
    this.sink.echoNote(ev)
    if (this._mode !== 'recording' || !this.running) return
    const at = this.position
    if (ev.type === 'noteOn') {
      // 同音高重复触发：前一个先收尾（一个音高同一时刻只有一个音）
      this.closeHeld(ev.pitch, at)
      this.held.set(ev.pitch, { start: at, velocity: ev.velocity, channel: ev.channel })
      this.emitState()
    } else {
      this.closeHeld(ev.pitch, at)
    }
  }

  private onMidiStatus(): void {
    if (this.disposed) return
    // 键盘断开（拔出/连接失败）：录制或回放中的走带暂停（录制把按住的键收尾）
    if (this.midi.status !== 'connected' && this._mode !== 'idle') {
      if (this._mode === 'recording') this.finishRecording()
      else this.pausePlayback()
    }
    this.emitState()
  }

  /** 时钟从当前位置开始推进 */
  private startClock(): void {
    this.anchorPos = this.pausedPos
    this.anchorWall = this.host.now()
    this.running = true
  }

  /** 时间轴时刻 → 宿主时钟时刻（MIDI 排期用） */
  private timeAt(timelineSec: number): number {
    return this.anchorWall + (timelineSec - this.anchorPos)
  }

  /** lookahead 调度：把窗口内开始的音符排入 MIDI 输出；到末尾自动暂停 */
  private tick(): void {
    if (this._mode !== 'playing' || !this.running) return
    const pos = this.position
    const until = pos + LOOKAHEAD_SEC
    const notes = this._notes
    while (this.nextIndex < notes.length && notes[this.nextIndex].start < until) {
      const n = notes[this.nextIndex]
      this.nextIndex++
      // 已结束的音符不补发（拖动/暂停跨过时）
      if (n.end <= pos + LATENCY_SEC) continue
      this.sink.scheduleNote({
        pitch: n.pitch,
        velocity: n.velocity,
        channel: n.channel,
        time: this.timeAt(n.start),
        duration: n.end - n.start,
      })
    }
    if (pos >= this.duration) {
      this.pausedPos = this.duration
      this.running = false
      this.stopTicker()
      this.silence()
      this._mode = 'idle'
      this.emitState()
    }
  }

  private startTicker(): void {
    if (this.intervalId !== undefined) return
    this.intervalId = this.host.setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicker(): void {
    if (this.intervalId === undefined) return
    this.host.clearInterval(this.intervalId)
    this.intervalId = undefined
  }

  /** 止住键盘音源上所有正在发声/已排期的音 */
  private silence(): void {
    this.sink.allNotesOff()
  }

  private emitState(): void {
    const notes = this.visibleNotes()
    this.cbs.onState({
      mode: this._mode,
      hasNotes: notes.length > 0 || this.held.size > 0,
      duration: trackDuration(notes),
      midiStatus: this.midi.status,
      midiConnected: this.midi.status === 'connected',
      midiLabels: this.midi.connectedLabels,
    })
  }
}
