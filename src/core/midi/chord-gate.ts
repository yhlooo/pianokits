import type { MidiControlChange, MidiNoteEvent } from './input'
import { PEDAL_ON_THRESHOLD, pedalIdOfController, type PedalId } from './pedals'

/**
 * 练习模式按键匹配（纯逻辑，可单测，设计文档 20260906-midi-keyboard-and-practice.md §3.4，
 * 踏板判定见 20260912-midi-pedal-lane-and-practice.md §3.5）。
 *
 * 判定规则：
 * - 触发条件：和弦的全部音高都被「新鲜按下」（收到 noteOn 且尚未被放行消费）、无“按错”标记，
 *   且**本和弦要求的踏板全部处于踩下状态**、无误踩踏板标记；
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
 * 踏板规则（与琴键有意不同）：
 * - **按当前状态判定**：要求的踏板只要此刻踩着即满足（踏板可以跨和弦一直踩着，不要求每个和弦重踩）；
 *   进入等待前已踩住的踏板照常计入满足；
 * - **误踩**：等待期间新踩下「参与判定（judgedPedals）但本和弦不要求」的踏板 → 记红（松开即清除），
 *   与按错键一样阻止放行；不参与判定的踏板（模式外 / 练习轨范围外）完全忽略；
 * - 踏板状态跨和弦保持（延音踏板可以一直踩着），仅 `resetPedals()`（设备断开/卸载）时清空。
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
  /** 等待期间误踩的、参与判定但本和弦不需要的踏板（红显，松开即清除） */
  private readonly wrongPedals = new Set<PedalId>()
  /** 本和弦要求的踏板（当前必须踩着） */
  private requiredPedals: ReadonlySet<PedalId> = new Set()
  /** 本和弦参与判定的踏板（等待期间新踩这些踏板才算误踩） */
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

  /**
   * 设置等待中的和弦（null = 取消等待）、豁免键集合与踏板要求。清除旧和弦的按错/误踩标记；
   * 若琴键与踏板条件全部满足，返回 true 表示应立即放行（并消费组内音高）。
   *
   * @param requiredPedals 本和弦要求踩下的踏板（文件该类踏板处于踩下状态）
   * @param judgedPedals 本和弦参与判定的踏板（练习模式 ∩ 练习范围）——等待期间新踩的非要求踏板算误踩
   */
  setChord(
    pitches: ReadonlySet<number> | null,
    excused: ReadonlySet<number> = new Set(),
    requiredPedals: ReadonlySet<PedalId> = new Set(),
    judgedPedals: ReadonlySet<PedalId> = new Set(),
  ): boolean {
    this.chord = pitches
    this.excused = new Set(excused)
    this.requiredPedals = new Set(requiredPedals)
    this.judgedPedals = new Set(judgedPedals)
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
   */
  control(ev: MidiControlChange): boolean {
    const pedalId = pedalIdOfController(ev.controller)
    if (pedalId === null) return false
    if (ev.value >= PEDAL_ON_THRESHOLD) {
      this.heldPedals.set(pedalId, ev.value)
      // 等待期间新踩下、参与判定但本和弦不需要的踏板 → 误踩（预先踩住的不算，同琴键语义）
      if (
        this.chord !== null &&
        this.judgedPedals.has(pedalId) &&
        !this.requiredPedals.has(pedalId)
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
      if (!this.heldPedals.has(pedal)) return false
    }
    return true
  }

  /** 消费当前和弦各音高的按下标记：同键在下一次放行前需重新按下 */
  private consume(): void {
    const chord = this.chord
    if (chord === null) return
    for (const pitch of chord) this.pressed.delete(pitch)
  }
}
