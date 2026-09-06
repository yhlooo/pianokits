import type { MidiNoteEvent } from './input'

/**
 * 练习模式按键匹配（纯逻辑，可单测，设计文档 20260906-midi-keyboard-and-practice.md §3.4）。
 *
 * 判定规则：
 * - 触发条件：等待和弦的全部音高都被按住，且无“按错”标记；
 * - 按错标记：等待期间新按下的、不在和弦内的键记为按错（松开即清除）；
 *   等待开始之前就按住的键（如上一和弦的延续指法）不计入按错、也不阻止触发；
 * - 预先按住：进入等待时若全部琴键已按住且无按错 → 立即触发；
 * - 纠错后触发：松开按错的键时若其余条件满足，立即触发；
 * - 等待窗口之外的按键不评估、不标红。
 */
export class ChordGate {
  /** 当前按住的键：pitch → velocity */
  private readonly held = new Map<number, number>()
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
   * 若全部琴键已预先按住且无按错，返回 true 表示应立即放行。
   */
  setChord(pitches: ReadonlySet<number> | null): boolean {
    this.chord = pitches
    this.wrong.clear()
    return this.isSatisfied()
  }

  /** 处理一条按键事件；返回 true 表示本次事件使触发条件满足（调用方应放行播放） */
  note(ev: MidiNoteEvent): boolean {
    if (ev.type === 'noteOn') {
      this.held.set(ev.pitch, ev.velocity)
      if (this.chord !== null && !this.chord.has(ev.pitch)) this.wrong.add(ev.pitch)
    } else {
      this.held.delete(ev.pitch)
      this.wrong.delete(ev.pitch)
    }
    return this.isSatisfied()
  }

  reset(): void {
    this.chord = null
    this.held.clear()
    this.wrong.clear()
  }

  private isSatisfied(): boolean {
    const chord = this.chord
    if (chord === null) return false
    for (const pitch of chord) {
      if (!this.held.has(pitch)) return false
    }
    return this.wrong.size === 0
  }
}
