import { parseMidiMessage, type MidiNoteEvent } from './input'

export type MidiConnectionStatus =
  /** 未连接（初始 / 已断开） */
  | 'idle'
  /** 授权请求中（连接尝试进行中） */
  | 'connecting'
  /** 已授权且至少一台输入设备挂载（练习模式可用的前提） */
  | 'connected'
  /** 已授权但无输入设备（连接尝试窗口内等待设备插入） */
  | 'no-devices'
  /** 连接尝试超时（5s 内未连上） */
  | 'timeout'
  /** 浏览器不支持 Web MIDI */
  | 'unsupported'
  /** 授权被拒绝 */
  | 'denied'
  /** 其它失败 */
  | 'error'

/**
 * 连接尝试超时（ms）：超过此时长仍未连接上（授权未完成 / 无设备）即放弃本次尝试，
 * 状态进入 timeout 并通知上层弹报错（设计文档 20260906-midi-keyboard-and-practice.md §4.1）。
 */
export const CONNECT_TIMEOUT_MS = 5000

export interface MidiConnectionCallbacks {
  onStatus(status: MidiConnectionStatus): void
  /** 解码后的按键事件（复用 core/midi/input.ts 的 parseMidiMessage） */
  onNote(ev: MidiNoteEvent): void
}

function deviceLabel(input: MIDIInput): string {
  const name = input.name?.trim() || '未命名设备'
  const manufacturer = input.manufacturer?.trim()
  return manufacturer ? `${manufacturer} ${name}` : name
}

/**
 * Web MIDI 输入接入层（主工具与调试工具共用的共享服务，设计文档
 * 20260906-midi-keyboard-and-practice.md §3.1）：
 * 请求授权 → 挂载全部 MIDIInput → statechange 热插拔感知；
 * 按键消息解码为 MidiNoteEvent 后回调。
 *
 * 连接尝试语义（§4.1）：connect() 启动一次 5s 限时尝试（attempting = true）；
 * - 期间 resolved 且有设备 → connected（attempting 结束）；
 * - 期间 resolved 但无设备 → no-devices（继续等待到超时，热插拔可立即连上）；
 * - 期间被 disconnect()（用户点击取消）→ idle（attempting 结束，在途结果作废）；
 * - 5s 仍未 connected → timeout（在途结果作废，报错由上层负责）。
 */
export class MidiConnection {
  private readonly cbs: MidiConnectionCallbacks
  private access: MIDIAccess | null = null
  private readonly attachedInputs: MIDIInput[] = []
  private _status: MidiConnectionStatus = 'idle'
  /** 尝试序号：connect/disconnect/超时都会自增，用于作废在途的授权请求结果 */
  private attempt = 0
  private timeoutId: number | undefined
  private _attempting = false

  constructor(cbs: MidiConnectionCallbacks) {
    this.cbs = cbs
  }

  get status(): MidiConnectionStatus {
    return this._status
  }

  /** 连接尝试是否进行中（5s 窗口内：授权请求中，或已授权但尚未等到设备） */
  get attempting(): boolean {
    return this._attempting
  }

  /** 已连接键盘的显示名（manufacturer + name）；未连接时为 null */
  get connectedLabel(): string | null {
    if (this._status !== 'connected' || this.access === null) return null
    const first = this.access.inputs.values().next().value
    if (first === undefined) return null
    return deviceLabel(first)
  }

  async connect(): Promise<void> {
    // 先用局部变量判定，避免 TS 把 this._status 收窄后影响 await 之后的检查
    const status = this._status
    if (status === 'connecting' || status === 'connected' || this._attempting) return
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.setStatus('unsupported')
      return
    }
    // 清理上一次残留的 access（授权已成功但超时/断连后的重试）
    this.teardownAccess()
    const attempt = ++this.attempt
    this._attempting = true
    this.setStatus('connecting')
    this.timeoutId = setTimeout(() => {
      this.timeoutId = undefined
      this._attempting = false
      this.attempt++ // 作废在途的授权请求结果
      this.teardownAccess()
      this.setStatus('timeout')
    }, CONNECT_TIMEOUT_MS)
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })
      // 在途期间被取消（disconnect）或超时：丢弃本次结果
      if (attempt !== this.attempt || this._status !== 'connecting') return
      this.access = access
      access.addEventListener('statechange', this.onStateChange)
      // sync 决定状态：connected 时结束尝试（清计时器）；no-devices 则继续等待到超时
      this.sync()
    } catch (err) {
      if (attempt !== this.attempt || this._status !== 'connecting') return
      this.clearTimeout()
      this._attempting = false
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        this.setStatus('denied')
      } else if (err instanceof DOMException && err.name === 'NotSupportedError') {
        this.setStatus('unsupported')
      } else {
        this.setStatus('error')
      }
    }
  }

  disconnect(): void {
    this.clearTimeout()
    this.attempt++
    this._attempting = false
    this.teardownAccess()
    this.setStatus('idle')
  }

  dispose(): void {
    this.disconnect()
  }

  private readonly onStateChange = (): void => {
    this.sync()
  }

  private readonly onMessage = (e: MIDIMessageEvent): void => {
    const data = e.data
    if (data === null) return
    const ev = parseMidiMessage(data)
    if (ev !== null) this.cbs.onNote(ev)
  }

  /** 重新挂载当前全部输入并刷新状态（初始接入与热插拔共用）；
   *  连上（≥1 台设备）即结束连接尝试（清计时器），无设备则保持 attempting 等待超时 */
  private sync(): void {
    if (this.access === null) return
    this.detachInputs()
    for (const input of this.access.inputs.values()) {
      input.addEventListener('midimessage', this.onMessage)
      this.attachedInputs.push(input)
    }
    if (this.attachedInputs.length > 0) {
      this.clearTimeout()
      this._attempting = false
      this.setStatus('connected')
    } else {
      this.setStatus('no-devices')
    }
  }

  private detachInputs(): void {
    for (const input of this.attachedInputs) {
      input.removeEventListener('midimessage', this.onMessage)
    }
    this.attachedInputs.length = 0
  }

  /** 摘掉全部输入监听与 statechange 监听并丢弃 access */
  private teardownAccess(): void {
    this.detachInputs()
    if (this.access !== null) {
      this.access.removeEventListener('statechange', this.onStateChange)
      this.access = null
    }
  }

  private clearTimeout(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId)
      this.timeoutId = undefined
    }
  }

  private setStatus(status: MidiConnectionStatus): void {
    if (this._status === status) return
    this._status = status
    this.cbs.onStatus(status)
  }
}
