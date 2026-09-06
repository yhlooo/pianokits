import type { MidiNoteEvent } from './input'

/**
 * 练习模式按键匹配（纯逻辑，可单测，设计文档 20260906-midi-keyboard-and-practice.md §3.4）。
 *
 * 判定规则：
 * - 触发条件：和弦的全部音高都被「新鲜按下」（收到 noteOn 且尚未被放行消费），且无“按错”标记；
 * - 新鲜按下与消费：noteOn 把该音高标记为“已按下”；和弦放行时消费掉组内各音高（从按下集合移除）。
 *   因此同音高的连续音符必须抬起（noteOff）再重新按下（noteOn）才能再次触发——
 *   一直按住一个键不会连续触发多个同音音符；
 * - 按错标记：等待期间新按下的、不在和弦内的键记为按错（松开即清除）；
 *   等待开始之前就按住的键（如上一和弦的延续指法）不计入按错、也不阻止触发；
 * - 预先按住：进入等待时若和弦全部音高已新鲜按下且无按错 → 立即触发（尚未消费过的提前按键）；
 * - 纠错后触发：松开按错的键时若其余条件满足，立即触发；
 * - 等待窗口之外的按键不评估、不标红。
 */
export class ChordGate {
  /** 当前按住的键：pitch → velocity */
  private readonly held = new Map<number, number>()
  /** 已收到 noteOn 且尚未被放行消费的键（放行后同键需重新按下才能再次触发） */
  private readonly pressed = new Set<number>()
  /** 等待中的和弦音高集合；null = 无等待（不评估按键） */
  private chord: ReadonlySet<number> | null = null
  /** 等待期间按下且不在和弦内的键（红显） */
  private readonly wrong = new Set<number>()

  get heldKeys(): ReadonlySet<number> {
    return new Set(this.held.keys())
  }

  get wrongKeys(): ReadonlySet<number> {
    return new Set(this.wrong)
  }

  /**
   * 设置等待中的和弦（null = 取消等待）。清除旧和弦的按错标记；
   * 若全部琴键已新鲜按下且无按错，返回 true 表示应立即放行（并消费组内音高）。
   */
  setChord(pitches: ReadonlySet<number> | null): boolean {
    this.chord = pitches
    this.wrong.clear()
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
      this.pressed.add(ev.pitch)
      if (this.chord !== null && !this.chord.has(ev.pitch)) this.wrong.add(ev.pitch)
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

  reset(): void {
    this.chord = null
    this.held.clear()
    this.pressed.clear()
    this.wrong.clear()
  }

  private isSatisfied(): boolean {
    const chord = this.chord
    if (chord === null) return false
    for (const pitch of chord) {
      if (!this.held.has(pitch) || !this.pressed.has(pitch)) return false
    }
    return this.wrong.size === 0
  }

  /** 消费当前和弦各音高的按下标记：同键在下一次放行前需重新按下 */
  private consume(): void {
    const chord = this.chord
    if (chord === null) return
    for (const pitch of chord) this.pressed.delete(pitch)
  }
}
