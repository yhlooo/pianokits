import type { MidiControlChange, MidiNoteEvent } from './input'
import { PEDAL_ON_THRESHOLD, pedalIdOfController, type PedalId } from './pedals'

/** 空踏板集合（`control()` 的默认 `expected`：调用方给不出文件踏板状态时按"文件此刻没踩"处理） */
const NO_PEDALS: ReadonlySet<PedalId> = new Set()

/**
 * 练习模式按键匹配（纯逻辑，可单测，设计文档 20260906-midi-keyboard-and-practice.md §3.4，
 * 踏板判定见 20260912-midi-pedal-lane-and-practice.md §3.5）。
 *
 * 判定规则：
 * - 触发条件：和弦的全部音高都被「新鲜按下」（收到 noteOn 且尚未被放行消费）、无“按错”标记，
 *   且**本闸门要求的踏板都已「现踩」**（边缘触发）、无误踩踏板标记；
 * - 新鲜按下与消费：noteOn 把该音高标记为“已按下”；和弦放行时消费掉组内各音高（从按下集合移除）。
 *   因此同音高的连续音符必须抬起（noteOff）再重新按下（noteOn）才能再次触发——
 *   一直按住一个键不会连续触发多个同音音符；
 * - 按错标记：等待期间新按下的、不在和弦内、也不在豁免集合内的键记为按错（松开即清除）；
 *   等待开始之前就按住的键（如上一和弦的延续指法）不计入按错、也不阻止触发；
 * - 豁免键：等待期间按下、不在和弦内、但在豁免集合内（瀑布流键盘上仍在/正进入的音符，
 *   如已触发的长音符重复按、分轨练习中非练习轨的音符）完全忽略——不标错、不标记新鲜按下
 *   （不重复触发），只反映到按住状态；
 * - 预先按住：进入等待时若和弦全部音高已新鲜按下且无按错 → 立即触发（尚未消费过的提前按键）；
 * - 纠错后触发：松开按错的键时若其余条件满足，立即触发；
 * - 等待窗口之外的按键不评估、不标红。
 *
 * 踏板规则（边缘触发，与琴键同等地位；设计文档 §3.5 的 2026-09-12 修订）：
 * - **必须现踩**：闸门要求的踏板，必须是**本闸门开始之后**收到的踩下转变才算数——
 *   「一直踩着不放」不能通过（这正是要防的作弊）；
 * - **长踏板与长音符同等**：文件此刻正踩着的踏板（`expected`，即踏板踩下区间的持续期间内）
 *   随时踩下都算正确——持续期间内松开再踩、或没踩时补踩，都不记误踩，也不再阻塞放行
 *   （同琴键的「豁免键」：仍在/正进入瀑布流的长音符重复按不标错）；
 * - **误踩**：踩下「参与判定（judgedPedals）、本闸门不要求、且文件此刻也没踩着」的踏板 → 记红
 *   （松开即清除）。有闸门等待时与按错键一样阻止放行；**没有闸门等待时只红显、不阻塞**
 *   （按键在窗口外不评估，踏板则要求给出反馈）；不参与判定的踏板（模式外 / 练习轨范围外）完全忽略；
 * - `judgedPedals` 由调用方随练习范围持续同步（`setJudgedPedals`），不随单个闸门清空；
 * - 踏板按住状态跨闸门保持，仅 `resetPedals()`（设备断开/卸载）时清空。
 */
export class ChordGate {
  /** 当前按住的键：pitch → velocity */
  private readonly held = new Map<number, number>()
  /** 已收到 noteOn 且尚未被放行消费的键（放行后同键需重新按下才能再次触发） */
  private readonly pressed = new Set<number>()
  /** 等待中的和弦音高集合；null = 无等待（不评估按键） */
  private chord: ReadonlySet<number> | null = null
  /** 等待期间按下且不在和弦内、也不在豁免集合内的键（红显） */
  private readonly wrong = new Set<number>()
  /** 豁免集合：等待期间按下不算错（长音符重复按 / 非练习轨音符等） */
  private excused = new Set<number>()
  /** 当前踩下的踏板：踏板 id → 最近一次值（值 >= 阈值；抬起时移除） */
  private readonly heldPedals = new Map<PedalId, number>()
  /** 本闸门开始后新踩下的踏板（边缘触发：只有这些才算满足要求） */
  private readonly pressedPedals = new Set<PedalId>()
  /** 误踩的、参与判定但本闸门不要求的踏板（红显，松开即清除） */
  private readonly wrongPedals = new Set<PedalId>()
  /** 本闸门要求「现踩」的踏板 */
  private requiredPedals: ReadonlySet<PedalId> = new Set()
  /** 参与判定的踏板（练习模式 ∩ 练习范围）；由 setJudgedPedals 持续同步 */
  private judgedPedals: ReadonlySet<PedalId> = new Set()

  get heldKeys(): ReadonlySet<number> {
    return new Set(this.held.keys())
  }

  get wrongKeys(): ReadonlySet<number> {
    return new Set(this.wrong)
  }

  /** 误踩的踏板（红显） */
  get wrongPedalKeys(): ReadonlySet<PedalId> {
    return new Set(this.wrongPedals)
  }

  /** 当前踩下的踏板（诊断/测试用） */
  get heldPedalKeys(): ReadonlySet<PedalId> {
    return new Set(this.heldPedals.keys())
  }

  /** 同步「参与判定」的踏板集合（练习范围变化时调用；与单个闸门无关） */
  setJudgedPedals(pedals: ReadonlySet<PedalId>): void {
    this.judgedPedals = new Set(pedals)
  }

  /**
   * 设置等待中的闸门（null = 取消等待）、豁免键集合与要求的踏板。清除旧闸门的按错/误踩标记，
   * 并**清空闸门开始前收到的踏板踩下**（边缘触发：只有闸门开始后现踩的才算）；
   * 若琴键与踏板条件全部满足，返回 true 表示应立即放行（并消费组内音高与已踩踏板）。
   *
   * 注意：`pitches` 允许为空集——纯踏板闸门（该时刻没有音符要按）时只判踏板。
   *
   * @param requiredPedals 本闸门要求「现踩」的踏板（文件在该时刻踩下的踏板）
   */
  setChord(
    pitches: ReadonlySet<number> | null,
    excused: ReadonlySet<number> = new Set(),
    requiredPedals: ReadonlySet<PedalId> = new Set(),
  ): boolean {
    this.chord = pitches
    this.excused = new Set(excused)
    this.requiredPedals = new Set(requiredPedals)
    this.pressedPedals.clear()
    this.wrong.clear()
    this.wrongPedals.clear()
    if (this.isSatisfied()) {
      this.consume()
      return true
    }
    return false
  }

  /** 处理一条按键事件；返回 true 表示本次事件使触发条件满足（调用方应放行播放） */
  note(ev: MidiNoteEvent): boolean {
    if (ev.type === 'noteOn') {
      this.held.set(ev.pitch, ev.velocity)
      // 豁免键（不在和弦内、但在豁免集合内）：完全忽略——不标错、不标记新鲜按下（不重复触发）
      if (this.chord !== null && !this.chord.has(ev.pitch) && this.excused.has(ev.pitch)) {
        // ignore
      } else {
        this.pressed.add(ev.pitch)
        if (this.chord !== null && !this.chord.has(ev.pitch)) this.wrong.add(ev.pitch)
      }
    } else {
      this.held.delete(ev.pitch)
      this.wrong.delete(ev.pitch)
    }
    if (this.isSatisfied()) {
      this.consume()
      return true
    }
    return false
  }

  /**
   * 处理一条 CC（踏板）事件；返回 true 表示本次事件使触发条件满足。
   * 非踏板 CC 忽略（不改变任何状态）。
   *
   * @param expected 文件此刻正处于踩下状态（踩下区间**持续期间**）的踏板：在其中踩下不算误踩，
   *   也不阻止放行——长踏板与长音符同等对待，同一段持续期间内松开再踩仍然正确；
   *   参与判定、既不是本闸门要求、文件此刻也没踩着的踏板才是误踩。
   */
  control(ev: MidiControlChange, expected: ReadonlySet<PedalId> = NO_PEDALS): boolean {
    const pedalId = pedalIdOfController(ev.controller)
    if (pedalId === null) return false
    if (ev.value >= PEDAL_ON_THRESHOLD) {
      this.heldPedals.set(pedalId, ev.value)
      this.pressedPedals.add(pedalId) // 边缘触发：本次踩下可用于本闸门
      // 误踩 = 参与判定 ∧ 本闸门不要求 ∧ 文件此刻也没踩着；无闸门等待时也红显，只是不阻塞
      if (
        this.judgedPedals.has(pedalId) &&
        !this.requiredPedals.has(pedalId) &&
        !expected.has(pedalId)
      ) {
        this.wrongPedals.add(pedalId)
      }
    } else {
      this.heldPedals.delete(pedalId)
      this.wrongPedals.delete(pedalId)
    }
    if (this.isSatisfied()) {
      this.consume()
      return true
    }
    return false
  }

  /** 清空踏板状态（设备断开/拔出：物理踏板已不可信） */
  resetPedals(): void {
    this.heldPedals.clear()
    this.pressedPedals.clear()
    this.wrongPedals.clear()
    this.requiredPedals = new Set()
    this.judgedPedals = new Set()
  }

  reset(): void {
    this.chord = null
    this.held.clear()
    this.pressed.clear()
    this.wrong.clear()
    this.excused.clear()
    this.resetPedals()
  }

  private isSatisfied(): boolean {
    const chord = this.chord
    if (chord === null) return false
    for (const pitch of chord) {
      if (!this.held.has(pitch) || !this.pressed.has(pitch)) return false
    }
    if (this.wrong.size > 0 || this.wrongPedals.size > 0) return false
    for (const pedal of this.requiredPedals) {
      if (!this.pressedPedals.has(pedal)) return false
    }
    return true
  }

  /** 消费当前闸门各音高的按下标记与要求的踏板踩下：下一次放行前需重新按下 / 重新踩 */
  private consume(): void {
    const chord = this.chord
    if (chord === null) return
    for (const pitch of chord) this.pressed.delete(pitch)
    for (const pedal of this.requiredPedals) this.pressedPedals.delete(pedal)
  }
}
