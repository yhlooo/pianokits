import { parseMidiMessage, type MidiControlChange, type MidiNoteEvent } from './input'

export type MidiConnectionStatus =
  /** 未连接（初始；本方案下仅工具卸载后/未发起前短暂存在） */
  | 'idle'
  /** 授权请求中（requestMIDIAccess 的 Promise 未落定） */
  | 'connecting'
  /** 已授权且至少一台输入设备挂载（练习模式可用的前提） */
  | 'connected'
  /** 已授权但无输入设备（常驻等待插入，靠 statechange 自动连上） */
  | 'no-devices'
  /** 浏览器不支持 Web MIDI */
  | 'unsupported'
  /** 授权被拒绝 */
  | 'denied'
  /** 其它失败 */
  | 'error'

/**
 * 授权请求软提示（ms）：`connecting` 状态超过此时长仍未落定（授权提示未应答 / 平台挂起，
 * 见研究文档 20260906-web-midi-connect-hang.md）时，仅经 `connectingHint` 给出提示，
 * **不拆 access、不进入失败终态**；Promise 晚到仍按真实状态呈现。
 */
export const CONNECT_HINT_MS = 5000

/**
 * 连接超时（ms）：调试工具「MIDI 键盘」页沿用 5s 诊断超时（提示"连接超时"并可重试，
 * 见设计文档 20260905-debug-tools.md §4.3）。保留供 debug/midi-keyboard.ts 复用。
 */
export const CONNECT_TIMEOUT_MS = 5000

export interface MidiConnectionCallbacks {
  onStatus(status: MidiConnectionStatus): void
  /** 解码后的按键事件（复用 core/midi/input.ts 的 parseMidiMessage） */
  onNote(ev: MidiNoteEvent): void
  /** 解码后的控制变化事件（CC：踏板 CC64/66/67 等）；不关心可不实现 */
  onControl?(ev: MidiControlChange): void
  /** 输出端口变化（连接同步 / 热插拔 / 断开清空）；镜像播放音符到键盘音源用 */
  onOutputs?(outputs: readonly MIDIOutput[]): void
}

/**
 * 是否第三方 Web MIDI shim（如 iPad 的 Web MIDI Browser / cordova-plugin-webmidi）。
 * shim 可运行于 HTTP 与 HTTPS，不能仅凭安全上下文判断：
 * - 非安全上下文下仍存在 requestMIDIAccess 必为 shim（原生 Web MIDI 只在安全上下文暴露）；
 * - 安全上下文下改用 shim 注入的非标准全局构造器 MIDIEventDispatcher 识别（原生浏览器无此全局，
 *   见 WebMIDIAPIShimForiOS 的 WebMIDIAPIPolyfill.js）。
 */
export function isShimmedMidi(): boolean {
  return (
    typeof navigator.requestMIDIAccess === 'function' &&
    (!window.isSecureContext ||
      typeof (window as unknown as { MIDIEventDispatcher?: unknown }).MIDIEventDispatcher ===
        'function')
  )
}

function deviceLabel(input: MIDIInput): string {
  const name = input.name?.trim() || '未命名设备'
  const manufacturer = input.manufacturer?.trim()
  return manufacturer ? `${manufacturer} ${name}` : name
}

/**
 * Web MIDI 输入接入层（主工具与调试工具共用的共享服务，设计文档
 * 20260906-midi-keyboard-and-practice.md §3.1，2026-09-07 起改为自动连接语义，
 * 见 20260907-midi-auto-connect.md §4.1）：
 * 请求授权 → 挂载全部 MIDIInput → statechange 热插拔感知；
 * 按键消息解码为 MidiNoteEvent 后回调，控制变化（CC，含踏板）解码后走 onControl。
 *
 * 自动连接语义：`connect()` 请求授权后**常驻 MIDIAccess**，不因无设备而拆除——
 * 无设备时置 `no-devices`，等待 `statechange` 在插入设备后自动翻成 `connected`；
 * 授权失败（denied/unsupported/error）可再次 `connect()` 重试；`connecting` 超过
 * `CONNECT_HINT_MS` 仅提示（不拆、不失败），晚到的结果按真实状态呈现。
 *
 * 另暴露一组**只读诊断视图**（requestStartedAt / errorName / errorMessage / inputCount /
 * isShimmed），供「MIDI 键盘」调试工具的诊断面板使用（设计文档 20260912-…-draft1.md §3.3）：
 * 呈现（文案、面板、重试按钮）留在调试页，连接事实由本层如实提供。
 */
export class MidiConnection {
  private readonly cbs: MidiConnectionCallbacks
  private access: MIDIAccess | null = null
  private readonly attachedInputs: MIDIInput[] = []
  private _status: MidiConnectionStatus = 'idle'
  /** 尝试序号：dispose / reconnect 时自增，作废在途的授权请求结果 */
  private attempt = 0
  private hintId: number | undefined
  private _connectingHint: string | null = null
  private _requestStartedAt: number | null = null
  private _errorName: string | null = null
  private _errorMessage: string | null = null

  constructor(cbs: MidiConnectionCallbacks) {
    this.cbs = cbs
  }

  get status(): MidiConnectionStatus {
    return this._status
  }

  /** connecting 超时软提示；非 connecting 或未超时均为 null */
  get connectingHint(): string | null {
    return this._connectingHint
  }

  /** 最近一次授权请求的发起时刻（`performance.now()`）；从未发起为 null */
  get requestStartedAt(): number | null {
    return this._requestStartedAt
  }

  /** 最近一次失败的 DOMException 名（如 NotAllowedError）；成功或未失败为 null */
  get errorName(): string | null {
    return this._errorName
  }

  /** 最近一次失败的消息文本；成功或未失败为 null */
  get errorMessage(): string | null {
    return this._errorMessage
  }

  /** 当前已挂载的输入端口数（诊断面板“N 台输入”） */
  get inputCount(): number {
    return this.attachedInputs.length
  }

  /** 是否第三方 Web MIDI shim（诊断提示按 shim 分支措辞用） */
  get isShimmed(): boolean {
    return isShimmedMidi()
  }

  /** 已连接键盘的显示名列表（manufacturer + name）；未连接 / 无设备时为空数组 */
  get connectedLabels(): readonly string[] {
    if (this._status !== 'connected' || this.access === null) return []
    const labels: string[] = []
    // 端口表统一用 forEach 遍历（第三方 Web MIDI shim 的 values() 迭代器无 Symbol.iterator）
    this.access.inputs.forEach((input) => labels.push(deviceLabel(input)))
    return labels
  }

  /**
   * 发起（自动）连接：请求授权并常驻 access。已持有授权（connected / no-devices）
   * 与请求进行中（connecting）时幂等返回；denied / error / unsupported / idle 可再次发起。
   */
  async connect(): Promise<void> {
    if (this.access !== null) return
    if (this._status === 'connecting') return
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.setStatus('unsupported')
      return
    }
    const attempt = ++this.attempt
    this._requestStartedAt = performance.now()
    this._errorName = null
    this._errorMessage = null
    this.setStatus('connecting')
    this.hintId = setTimeout(() => {
      this.hintId = undefined
      if (this._status === 'connecting') {
        this.setHint('授权请求超时，请检查浏览器权限提示或站点设置')
      }
    }, CONNECT_HINT_MS)
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })
      // 在途期间被 dispose：丢弃本次结果
      if (attempt !== this.attempt) return
      this.clearHint()
      this.access = access
      access.addEventListener('statechange', this.onStateChange)
      // sync 决定状态：≥1 台输入 → connected；0 台 → no-devices（常驻等待插入）
      this.sync()
    } catch (err) {
      if (attempt !== this.attempt) return
      this.clearHint()
      this._errorName = err instanceof Error ? err.name : null
      this._errorMessage = err instanceof Error ? err.message : String(err)
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        this.setStatus('denied')
      } else if (err instanceof DOMException && err.name === 'NotSupportedError') {
        this.setStatus('unsupported')
      } else {
        this.setStatus('error')
      }
    }
  }

  dispose(): void {
    this.attempt++
    this.clearHint()
    this.teardownAccess()
    this.setStatus('idle')
  }

  /**
   * 作废在途请求并重新发起一次连接（调试工具“重试连接”用）：先 `dispose()` 再 `connect()`。
   * 授权请求可能永不落定（见研究文档 20260906-web-midi-connect-hang.md），此时旧请求的结果
   * 按 attempt 序号作废，用户可立刻发起一次全新的授权请求。
   */
  reconnect(): Promise<void> {
    this.dispose()
    return this.connect()
  }

  private readonly onStateChange = (): void => {
    this.sync()
  }

  private readonly onMessage = (e: MIDIMessageEvent): void => {
    const data = e.data
    if (data === null) return
    const ev = parseMidiMessage(data)
    if (ev === null) return
    if (ev.type === 'controlChange') this.cbs.onControl?.(ev)
    else this.cbs.onNote(ev)
  }

  /** 重新挂载当前全部输入/输出并刷新状态（初始接入与热插拔共用） */
  private sync(): void {
    if (this.access === null) return
    this.detachInputs()
    // 端口表统一用 forEach 遍历，而非 for…of / [...values()]：第三方 Web MIDI shim
    // （如 iPad 的 Web MIDI Browser / cordova-plugin-webmidi）提供的 inputs/outputs 是
    // 非原生 Map，其 values() 返回的迭代器没有 Symbol.iterator，for…of / 展开会抛
    // TypeError，导致“连接成功却一直显示连接中”。forEach 在原生成与 shim 上行为一致。
    this.access.inputs.forEach((input) => {
      input.addEventListener('midimessage', this.onMessage)
      this.attachedInputs.push(input)
    })
    // 输出端口快照（镜像播放音符到键盘音源用；断开时由 teardownAccess 通知清空）
    const outputs: MIDIOutput[] = []
    this.access.outputs.forEach((output) => outputs.push(output))
    this.cbs.onOutputs?.(outputs)
    this.setStatus(this.attachedInputs.length > 0 ? 'connected' : 'no-devices')
  }

  private detachInputs(): void {
    for (const input of this.attachedInputs) {
      input.removeEventListener('midimessage', this.onMessage)
    }
    this.attachedInputs.length = 0
  }

  /** 摘掉全部输入监听与 statechange 监听并丢弃 access；输出快照清空 */
  private teardownAccess(): void {
    this.detachInputs()
    if (this.access !== null) {
      this.access.removeEventListener('statechange', this.onStateChange)
      this.access = null
      this.cbs.onOutputs?.([])
    }
  }

  private clearHint(): void {
    if (this.hintId !== undefined) {
      clearTimeout(this.hintId)
      this.hintId = undefined
    }
    if (this._connectingHint !== null) this.setHint(null)
  }

  private setHint(hint: string | null): void {
    if (this._connectingHint === hint) return
    this._connectingHint = hint
    // 提示变化也推送：上层控制器据此重读 connectingHint（状态本身未变，不经 setStatus）
    this.cbs.onStatus(this._status)
  }

  private setStatus(status: MidiConnectionStatus): void {
    if (this._status === status) return
    this._status = status
    this.cbs.onStatus(status)
  }
}
