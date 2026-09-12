import type { MidiControlChange, MidiNoteEvent } from './midi/input'
import type { Song } from './model'
import { MidiConnection, type MidiConnectionStatus } from './midi/connection'
import { ChordGate } from './midi/chord-gate'
import type { PedalFocus, PedalId, PedalPracticeMode } from './midi/pedals'
import { MidiOutputSink } from './midi/output'
import type { Transport } from './transport'

/**
 * 练习模式反馈（推给瀑布流渲染，设计文档 20260906-midi-keyboard-and-practice.md §4.2、
 * 20260912-midi-pedal-lane-and-practice.md §3.5）：按住键琥珀、按错键红 + 光晕、
 * 误踩踏板红 + 光晕。
 */
export interface PracticeFeedback {
  held: ReadonlySet<number>
  wrong: ReadonlySet<number>
  /** 误踩的踏板（等待期间新踩参与判定但本和弦不需要的踏板；松开即清除） */
  wrongPedals: ReadonlySet<PedalId>
}

/** MIDI 状态图标 UI 状态（推给播放坞钢琴状态图标渲染，设计文档 20260907-midi-auto-connect.md §4.3） */
export interface MidiUiState {
  status: MidiConnectionStatus
  /** 已连接键盘显示名列表（多台逐行）；未连接/无设备时为空 */
  connectedLabels: readonly string[]
  /** connecting 超时软提示；其余状态为 null */
  connectingHint: string | null
}

/** 分轨练习的可练习轨信息（悬浮菜单与门控按此列表） */
export interface PracticeTrackInfo {
  /** 轨道 index（对应 Song.tracks / Note.trackIndex） */
  index: number
  /** 轨名（悬浮菜单显示） */
  name: string
}

/** 分轨练习 UI 状态（推给播放坞练习按钮 + 悬浮菜单渲染） */
export interface PracticeUiState {
  /** 当前曲目可练习的轨及每轨开关；无曲目时为空 */
  tracks: readonly (PracticeTrackInfo & { on: boolean })[]
  /** 至少一轨开启练习（练习按钮高亮） */
  active: boolean
  /** 全部轨都已开启练习（此时再点练习按钮 = 全部关闭） */
  allOn: boolean
  /** 踏板练习模式（三选一，默认 off） */
  pedalMode: PedalPracticeMode
  /**
   * 练习模式下踏板轨道的关注范围（判定 + 高亮）；null = 练习未开启或未载入曲目
   * （踏板轨道正常显示）。非 null 但 `pedals` 为空 = 练习中但不判定踏板
   * （踏板练习 off / 练习轨通道内无踏板数据）→ 踏板条全部压暗。
   */
  pedalFocus: PedalFocus | null
}

export interface PracticeCallbacks {
  onStatus(ui: MidiUiState): void
  /** 分轨练习状态（轨列表 / 每轨开关 / 是否激活 / 踏板练习）；任何变化都会回调 */
  onPractice(ui: PracticeUiState): void
  /** null = 非练习模式（隐藏键盘与踏板反馈） */
  onFeedback(fb: PracticeFeedback | null): void
  /** 连接失败报错（超时/被拒/不支持等）：右下角通知胶囊 */
  onConnectError(message: string): void
}

export interface PracticeControllerOptions {
  transport: Transport
  /** 时间换算用（AudioContext 时间 → MIDI send 时间戳），只读 currentTime */
  audioCtx: { currentTime: number }
  callbacks: PracticeCallbacks
}

/**
 * 曲目中可练习的轨：出现在播放事件流（瀑布流）中的轨——song.notes 涉及的非打击乐轨，
 * 按曲目轨序排列。打击乐轨与空轨不进事件流，门控无意义，不列入。
 */
export function practiceTracksOf(song: Song): PracticeTrackInfo[] {
  const noteTracks = new Set(song.notes.map((n) => n.trackIndex))
  return song.tracks
    .filter((t) => noteTracks.has(t.index))
    .map((t) => ({ index: t.index, name: t.name }))
}

/**
 * MIDI 键盘 + 分轨练习编排（不触碰 DOM，设计文档 20260906-midi-keyboard-and-practice.md §3.5，
 * 2026-09-07 起连接改自动语义，见 20260907-midi-auto-connect.md §4.2）：
 * - 连接生命周期：进入页面自动连接（autoConnect，幂等）；授权后常驻，插拔靠 statechange；
 *   授权被拒/不支持/其它失败经 onConnectError 报错，无设备（no-devices）静默；
 * - 播放镜像（§3.6）：连接产生的输出端口挂到 MidiOutputSink，走带排期的每个音符同步
 *   发一份到键盘自带音源（与电脑播放同步发声）；断开/拔出时解除；
 * - 实时演奏：已连接且无门控轨时按键直达引擎（经 Transport 透传）；按键**不**回送
 *   输出端口（键盘 Local Control 开启时会造成叠音/回授）；
 * - 分轨练习：每轨独立开关（悬浮菜单多选，可多轨同时练习）；开启练习的轨到达判定线
 *   时等待琴键放行（和弦需同时按住全部对应琴键），其余轨照常直接播放；
 * - 踏板练习（设计文档 20260912-midi-pedal-lane-and-practice.md §3.5）：三选一模式
 *   （off/sustain/all）随分轨练习生效；和弦放行还要求「文件在该和弦处踩下的踏板」全部踩着，
 *   等待期间误踩参与判定的踏板红显并阻止放行；
 * - 练习按钮语义：非全开（含全关）→ 全部开启；全开 → 全部关闭；
 * - 暂停/播放联动：开关任意轨练习（或切换踏板练习模式）都会自动暂停；练习开启时按下任意琴键即从
 *   暂停恢复播放；连接键盘不影响播放状态，设备拔出自动暂停；
 * - 连接状态离开 connected（设备拔出/销毁）时清空全部轨的练习开关与踏板状态（强制退出练习）。
 */
export class PracticeController {
  private readonly transport: Transport
  private readonly cbs: PracticeCallbacks
  private readonly midi: MidiConnection
  private readonly sink: MidiOutputSink
  private readonly gate = new ChordGate()
  /** 当前曲目可练习的轨（setTracks 同步，按曲目轨序） */
  private tracks: readonly PracticeTrackInfo[] = []
  /** 开启练习的轨 index 集合；空 = 练习关闭 */
  private readonly practiceTracks = new Set<number>()
  /** 踏板练习模式（三选一，默认 off = 无踏板练习） */
  private pedalMode: PedalPracticeMode = 'off'
  /** 上一次连接状态（区分“断开”（connected → 非 connected）与连接尝试的中间状态） */
  private lastStatus: MidiConnectionStatus = 'idle'
  private disposed = false

  constructor(opts: PracticeControllerOptions) {
    this.transport = opts.transport
    this.cbs = opts.callbacks
    this.sink = new MidiOutputSink(opts.audioCtx)
    this.midi = new MidiConnection({
      onStatus: (status) => {
        if (this.disposed) return
        const wasConnected = this.lastStatus === 'connected'
        this.lastStatus = status
        if (status !== 'connected') {
          // 连接状态离开 connected（断开/设备拔出）：清空踏板状态（物理踏板已不可信）与练习开关
          this.gate.resetPedals()
          if (this.practiceTracks.size > 0) {
            this.practiceTracks.clear()
            this.applyPractice()
          }
          // 断开（点击断开/设备拔出）自动暂停；连接尝试的中间状态不影响播放
          if (wasConnected) this.transport.pause()
        }
        // 连接失败通知（设计文档 20260907-midi-auto-connect.md §5）：
        // 无设备（no-devices）静默；授权被拒/不支持/其它失败弹右下角报错；connecting 挂起仅浮层提示
        if (status === 'denied') this.cbs.onConnectError('MIDI 授权被拒绝')
        else if (status === 'unsupported') this.cbs.onConnectError('当前浏览器不支持 Web MIDI')
        else if (status === 'error') this.cbs.onConnectError('MIDI 连接失败，请重试')
        this.emitMidiState()
      },
      onNote: (ev) => this.onNote(ev),
      onControl: (ev) => this.onControl(ev),
      onOutputs: (outputs) => this.syncOutputs(outputs),
    })
    this.transport.onPracticeChord((chord) => {
      if (chord === null) {
        this.gate.setChord(null)
        this.emitFeedback()
        return
      }
      const pitches = new Set(chord.notes.map((n) => n.pitch))
      if (this.gate.setChord(pitches, chord.excused, chord.requiredPedals, chord.judgedPedals)) {
        // 预先已按住全部琴键（且要求踏板已踩着）：进入等待即放行
        this.release()
      }
      this.emitFeedback()
    })
    // 初始状态同步
    this.emitMidiState()
    this.applyPractice()
  }

  get status(): MidiConnectionStatus {
    return this.midi.status
  }

  /** 是否处于练习中（至少一轨开启且已连接） */
  get practiceActive(): boolean {
    return this.isGating()
  }

  /**
   * 切换曲目：更新可练习轨列表；保留与新曲目轨号相交的练习开关（换歌不丢练习选择）。
   * 无曲目时传空列表。
   */
  setTracks(tracks: readonly PracticeTrackInfo[]): void {
    this.tracks = [...tracks]
    const valid = new Set(this.tracks.map((t) => t.index))
    for (const i of [...this.practiceTracks]) {
      if (!valid.has(i)) this.practiceTracks.delete(i)
    }
    this.applyPractice()
  }

  /**
   * 自动连接（进入播放器页面时调用一次；失败态"重连"按钮也复用此路径）。
   * `MidiConnection.connect()` 幂等：已持有授权（connected/no-devices）与 connecting
   * 时不再重复请求；denied/error/idle 时重新发起（设计文档 20260907-midi-auto-connect.md §4.2）。
   */
  autoConnect(): void {
    void this.midi.connect()
  }

  /**
   * 练习按钮点击语义（设计文档 §4.1）：
   * - 全部轨已开启 → 全部关闭；
   * - 其余（全关或部分开启）→ 全部开启。
   * 仅在 connected 时生效；开关集合变化时自动暂停播放。
   */
  togglePractice(): void {
    if (this.midi.status !== 'connected') return
    const before = new Set(this.practiceTracks)
    if (this.allOn()) this.practiceTracks.clear()
    else for (const t of this.tracks) this.practiceTracks.add(t.index)
    this.applyPractice()
    if (!this.sameTrackSet(before, this.practiceTracks)) this.transport.pause()
  }

  /**
   * 悬浮菜单点击单轨：开关该轨练习（可多选；仅 connected 时生效，不在列表内的轨忽略）；
   * 开关集合变化时自动暂停播放。
   */
  toggleTrack(index: number): void {
    if (this.midi.status !== 'connected') return
    if (!this.tracks.some((t) => t.index === index)) return
    const before = new Set(this.practiceTracks)
    if (this.practiceTracks.has(index)) this.practiceTracks.delete(index)
    else this.practiceTracks.add(index)
    this.applyPractice()
    if (!this.sameTrackSet(before, this.practiceTracks)) this.transport.pause()
  }

  /**
   * 切换踏板练习模式（设计文档 20260912-midi-pedal-lane-and-practice.md §3.6）：
   * - 三选一（off/sustain/all），推给 Transport 重算关注范围；
   * - 从 off 切到非 off、且当前没有任何轨在练时**自动全开全部轨**——否则该设置无从生效；
   * - 与分轨开关一致：模式确有变化时自动暂停播放，并外发练习 UI 状态。
   */
  setPedalPractice(mode: PedalPracticeMode): void {
    if (this.pedalMode === mode) return
    this.pedalMode = mode
    if (
      mode !== 'off' &&
      this.midi.status === 'connected' &&
      this.tracks.length > 0 &&
      !this.hasAnyOn()
    ) {
      for (const t of this.tracks) this.practiceTracks.add(t.index)
    }
    this.applyPractice()
    this.transport.pause()
  }

  dispose(): void {
    this.disposed = true
    this.gate.reset()
    this.transport.setPracticeTracks(new Set())
    this.transport.setPedalPracticeMode('off')
    this.transport.setMidiOutput(null)
    this.sink.dispose()
    this.midi.dispose()
  }

  /** 输出端口变化：同步到镜像 sink 并挂/摘 Transport（无输出端口时不镜像；
   *  端口清空时先静默并清队列，避免键盘上残留长音） */
  private syncOutputs(outputs: readonly MIDIOutput[]): void {
    if (this.disposed) return
    if (outputs.length === 0) this.sink.allNotesOff()
    this.sink.sync(outputs)
    this.transport.setMidiOutput(outputs.length > 0 ? this.sink : null)
  }

  /** 把当前分轨开关与踏板练习模式推给 Transport，并外发反馈与练习 UI 状态 */
  private applyPractice(): void {
    const gating = this.isGating()
    this.transport.setPracticeTracks(gating ? new Set(this.practiceTracks) : new Set())
    this.transport.setPedalPracticeMode(this.pedalMode)
    this.emitFeedback()
    this.emitPractice()
  }

  private isGating(): boolean {
    return this.midi.status === 'connected' && this.hasAnyOn()
  }

  private hasAnyOn(): boolean {
    return this.tracks.some((t) => this.practiceTracks.has(t.index))
  }

  private allOn(): boolean {
    return this.tracks.length > 0 && this.tracks.every((t) => this.practiceTracks.has(t.index))
  }

  /** 两个轨号集合内容一致（练习开关无实际变化时不触发自动暂停） */
  private sameTrackSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    if (a.size !== b.size) return false
    for (const x of a) {
      if (!b.has(x)) return false
    }
    return true
  }

  private onNote(ev: MidiNoteEvent): void {
    if (this.isGating()) {
      // 练习中：任意按键按下即从暂停（或未播放）恢复播放（设计文档 §3.5 暂停/播放联动）
      if (ev.type === 'noteOn' && this.transport.state !== 'playing') {
        this.transport.play()
      }
      // 按键原样回送到键盘音源（力度=按键力度）并同时驱动电脑引擎（同力度），弹错的音也
      // 发声；仅参与判定，满足条件才放行推进瀑布流（放行不再重复发声）
      this.sink.echoNote(ev)
      if (ev.type === 'noteOn') this.transport.liveNoteOn(ev.pitch, ev.velocity)
      else this.transport.liveNoteOff(ev.pitch)
      if (this.gate.note(ev)) this.release()
      this.emitFeedback()
      return
    }
    // 实时演奏
    if (ev.type === 'noteOn') this.transport.liveNoteOn(ev.pitch, ev.velocity)
    else this.transport.liveNoteOff(ev.pitch)
  }

  /**
   * 踏板 CC（CC64/66/67）：并入 gate 的踏板状态并参与判定。
   * 练习中满足放行条件即放行；未开启练习时也照常并入（进入练习时能识别"踏板已经踩着"）。
   */
  private onControl(ev: MidiControlChange): void {
    if (this.disposed) return
    const triggered = this.gate.control(ev)
    if (!this.isGating()) return
    if (triggered) this.release()
    else this.emitFeedback()
  }

  /** 放行当前等待的和弦：走带继续（门控轨音符已由 echoNote 发声）；gate 清空等待直至下一和弦 */
  private release(): void {
    this.transport.releaseChord()
    this.gate.setChord(null)
  }

  private emitFeedback(): void {
    this.cbs.onFeedback(
      this.isGating()
        ? {
            held: new Set(this.gate.heldKeys),
            wrong: new Set(this.gate.wrongKeys),
            wrongPedals: new Set(this.gate.wrongPedalKeys),
          }
        : null,
    )
  }

  private emitPractice(): void {
    this.cbs.onPractice({
      tracks: this.tracks.map((t) => ({ ...t, on: this.practiceTracks.has(t.index) })),
      active: this.isGating(),
      allOn: this.allOn(),
      pedalMode: this.pedalMode,
      pedalFocus: this.isGating() ? this.transport.pedalFocus : null,
    })
  }

  private emitMidiState(): void {
    this.cbs.onStatus({
      status: this.midi.status,
      connectedLabels: this.midi.connectedLabels,
      connectingHint: this.midi.connectingHint,
    })
  }
}
