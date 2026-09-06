import type { MidiNoteEvent } from './midi/input'
import { MidiConnection, type MidiConnectionStatus } from './midi/connection'
import { ChordGate } from './midi/chord-gate'
import { MidiOutputSink } from './midi/output'
import type { Transport } from './transport'

/** 练习模式键盘反馈：按住键 + 按错键（推给瀑布流渲染，设计文档 20260906-midi-keyboard-and-practice.md §4.2） */
export interface KeyFeedback {
  held: ReadonlySet<number>
  wrong: ReadonlySet<number>
}

/** MIDI 按钮 UI 状态（推给播放坞钢琴按钮渲染） */
export interface MidiUiState {
  status: MidiConnectionStatus
  /** 连接尝试进行中（5s 窗口内）：旋转等待；点击取消连接 */
  attempting: boolean
  /** 已连接键盘的显示名；未连接为 null */
  deviceLabel: string | null
}

export interface PracticeCallbacks {
  onStatus(ui: MidiUiState): void
  onPractice(on: boolean): void
  /** null = 非练习模式（隐藏键盘反馈） */
  onFeedback(fb: KeyFeedback | null): void
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
 * MIDI 键盘 + 练习模式编排（不触碰 DOM，设计文档 20260906-midi-keyboard-and-practice.md §3.5）：
 * - 连接生命周期：点击尝试连接（5s 限时）、点击取消、点击断开；失败经 onConnectError 报错；
 * - 播放镜像（§3.6）：连接产生的输出端口挂到 MidiOutputSink，走带排期的每个音符同步
 *   发一份到键盘自带音源（与电脑播放同步发声）；断开/拔出时解除；
 * - 实时演奏：已连接且非练习模式时按键直达引擎（经 Transport 透传）；按键**不**回送
 *   输出端口（键盘 Local Control 开启时会造成叠音/回授）；
 * - 练习模式：仅在 connected 时可开；接线 Transport 等待回调 ↔ ChordGate，
 *   触发即放行；gate 每次变化后把按住/按错键经 onFeedback 外发；
 * - 连接状态离开 connected（断开/设备拔出）时强制退出练习模式。
 */
export class PracticeController {
  private readonly transport: Transport
  private readonly cbs: PracticeCallbacks
  private readonly midi: MidiConnection
  private readonly sink: MidiOutputSink
  private readonly gate = new ChordGate()
  private practiceOn = false
  private disposed = false

  constructor(opts: PracticeControllerOptions) {
    this.transport = opts.transport
    this.cbs = opts.callbacks
    this.sink = new MidiOutputSink(opts.audioCtx)
    this.midi = new MidiConnection({
      onStatus: (status) => {
        if (this.disposed) return
        if (this.practiceOn && status !== 'connected') this.setPractice(false)
        // 连接失败（非用户主动取消）：弹报错通知
        if (status === 'denied') this.cbs.onConnectError('MIDI 授权被拒绝')
        else if (status === 'unsupported') this.cbs.onConnectError('当前浏览器不支持 Web MIDI')
        else if (status === 'error') this.cbs.onConnectError('MIDI 连接失败，请重试')
        else if (status === 'timeout')
          this.cbs.onConnectError('连接 MIDI 键盘超时，请确认设备已连接并允许授权后重试')
        this.emitMidiState()
      },
      onNote: (ev) => this.onNote(ev),
      onOutputs: (outputs) => this.syncOutputs(outputs),
    })
    this.transport.onPracticeChord((chord) => {
      if (chord === null) {
        this.gate.setChord(null)
        this.emitFeedback()
        return
      }
      const pitches = new Set(chord.notes.map((n) => n.pitch))
      if (this.gate.setChord(pitches)) {
        // 预先已按住全部琴键：进入等待即放行
        this.release()
      }
      this.emitFeedback()
    })
    // 初始状态同步
    this.emitMidiState()
    this.cbs.onPractice(false)
    this.cbs.onFeedback(null)
  }

  get status(): MidiConnectionStatus {
    return this.midi.status
  }

  get practice(): boolean {
    return this.practiceOn
  }

  /**
   * 钢琴按钮点击语义（设计文档 §4.1）：
   * - 已连接 → 断开；连接尝试中（attempting）→ 取消连接；
   * - 其余（未连接/超时/被拒等）→ 发起一次连接尝试。
   */
  toggleMidi(): void {
    if (this.midi.status === 'connected') {
      this.midi.disconnect()
      return
    }
    if (this.midi.attempting) {
      this.midi.disconnect()
      return
    }
    if (this.midi.status === 'unsupported') return
    void this.midi.connect()
  }

  /** 开关练习模式（仅 connected 时可开） */
  togglePractice(): void {
    this.setPractice(!this.practiceOn)
  }

  dispose(): void {
    this.disposed = true
    if (this.practiceOn) {
      this.practiceOn = false
      this.transport.setPracticeMode(false)
    }
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

  private setPractice(on: boolean): void {
    if (this.practiceOn === on) return
    if (on && this.midi.status !== 'connected') return
    this.practiceOn = on
    this.gate.reset()
    this.transport.setPracticeMode(on)
    this.emitFeedback()
    this.cbs.onPractice(on)
  }

  private onNote(ev: MidiNoteEvent): void {
    if (this.practiceOn) {
      // 练习模式：按键不直接发声，仅参与判定；满足条件则放行（发声按原曲时值/力度）
      if (this.gate.note(ev)) this.release()
      this.emitFeedback()
      return
    }
    // 实时演奏
    if (ev.type === 'noteOn') this.transport.liveNoteOn(ev.pitch, ev.velocity)
    else this.transport.liveNoteOff(ev.pitch)
  }

  /** 放行当前等待的和弦：引擎发声、走带继续；gate 清空等待直至下一和弦 */
  private release(): void {
    this.transport.releaseChord()
    this.gate.setChord(null)
  }

  private emitFeedback(): void {
    this.cbs.onFeedback(
      this.practiceOn
        ? { held: new Set(this.gate.heldKeys), wrong: new Set(this.gate.wrongKeys) }
        : null,
    )
  }

  private emitMidiState(): void {
    this.cbs.onStatus({
      status: this.midi.status,
      attempting: this.midi.attempting,
      deviceLabel: this.midi.connectedLabel,
    })
  }
}
