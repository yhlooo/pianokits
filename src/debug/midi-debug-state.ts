import {
  PEDALS,
  PEDAL_ON_THRESHOLD,
  applyControlChange,
  initialPedals,
  pedalLevelPercent,
  type PedalDef,
  type PedalState,
} from '../core/midi/pedals'
import type { MidiChannelEvent } from '../core/midi/input'

/**
 * 「MIDI 键盘」调试页的输入状态与视觉映射（纯逻辑，无 DOM，可单测）。
 *
 * 两类状态的来源都是同一条 MIDI 消息流（`core/midi/connection.ts` 解码后回调）：
 * - **按住键**：`pitch → velocity`。力度只取 Note On 那一刻的值——MIDI 键盘在键按住期间
 *   不会更新力度，与设备行为一致，无需定时器；
 * - **踏板**：`CC64/66/67 → PedalState`（详见 `core/midi/pedals.ts`）。
 *
 * 所有视觉强度都出自同一条映射 `velocityIntensity`：数值、音名方块亮度与底色、键盘键色深浅、
 * 踏板方块亮度，都是它的不同出口——只有一个映射源，才不会出现“数字 30 却显示成最浓”的错位。
 */

/**
 * 力度 → 视觉强度（0–1）：按**感知响度**取幂曲线，而不是线性。
 *
 * 依据：MIDI 力度与音量的关系接近**平方律**——Csound `ampmidid` 按 Dannenberg
 * 《The Interpretation of MIDI Velocity》(ICMC 2006) 把力度映射为峰值幅度
 * `a = (m·v + b)²`（在给定动态范围 dB 内），即“响度 ≈ 力度的平方”。
 * 视觉强度若取线性，低力度区间会挤在一起（1 与 30 几乎看不出差别），而人对弱音区的
 * 区分恰恰更敏感；因此这里取响度的**单调逆曲线（开方方向）**：
 *
 *   I(v) = (v / 127) ^ 0.4      （0.4 < 1 → 低力度拉开、高力度压缩）
 *
 * 例：v=1/20/40/64/96/127 → I≈0.13/0.42/0.55/0.66/0.77/1.00
 * （线性则只有 0.01/0.16/0.31/0.50/0.76/1.00，低端几乎无差别）。
 * 数值本身仍如实显示 0–127，曲线只作用于视觉强度。
 */
export const VELOCITY_CURVE_EXPONENT = 0.4

export function velocityIntensity(velocity: number): number {
  const clamped = Math.max(0, Math.min(127, velocity))
  return (clamped / 127) ** VELOCITY_CURVE_EXPONENT
}

/** 音名方块（音名 + 力度角标）的文字不透明度：0.50（极轻）→ 1.0（最重），越大越亮 */
export function velocityTextAlpha(velocity: number): number {
  return 0.5 + 0.5 * velocityIntensity(velocity)
}

/**
 * 音名方块的背景不透明度（半透明白底）：0.03（极轻）→ 0.30（最重）。
 * 文字亮度之外再给一层底色，力度差异在整块面积上可见；上限 0.30 是为了让弱音区
 * （I≈0.13 → 0.065）与中强（I≈0.66 → 0.21）之间有明显梯度。
 */
export function velocityFillAlpha(velocity: number): number {
  return 0.03 + 0.27 * velocityIntensity(velocity)
}

/** 踏板方块在“踩下”之后的绿色背景不透明度：64 → 0.10，127 → 0.40（越深越浓） */
export function pedalFillAlpha(value: number): number {
  if (value < PEDAL_ON_THRESHOLD) return 0 // 未触发就没有背景色
  const depth = (Math.min(value, 127) - PEDAL_ON_THRESHOLD) / (127 - PEDAL_ON_THRESHOLD)
  return 0.1 + 0.3 * depth
}

/** 踏板方块边框不透明度：0.30 → 0.85（随值增大而变亮） */
export function pedalBorderAlpha(value: number): number {
  return 0.3 + 0.55 * velocityIntensity(value)
}

/** 踏板方块文字亮度：0.55（未踩/很轻）→ 0.95（踩到底） */
export function pedalTextAlpha(value: number): number {
  return 0.55 + 0.4 * velocityIntensity(value)
}

export interface DebugPedalSnapshot {
  def: PedalDef
  state: PedalState
}

export interface DebugSnapshot {
  /** 按住键：pitch → velocity */
  held: ReadonlyMap<number, number>
  /** 三个踏板的当前状态（顺序同 PEDALS：按钢琴从左到右 弱音 / 选择延音 / 延音） */
  pedals: readonly DebugPedalSnapshot[]
}

export class DebugMidiState {
  private held = new Map<number, number>()
  private pedals: ReadonlyMap<number, PedalState> = initialPedals()

  /** 并入一条解码后的消息，返回最新快照（按键按下/抬起、踏板变化都经这里） */
  feed(ev: MidiChannelEvent): DebugSnapshot {
    if (ev.type === 'noteOn') {
      this.held.set(ev.pitch, ev.velocity)
    } else if (ev.type === 'noteOff') {
      this.held.delete(ev.pitch)
    } else {
      this.pedals = applyControlChange(this.pedals, ev.controller, ev.value)
    }
    return this.snapshot()
  }

  /** 输入设备全部断开时复位（避免残留“幽灵按住/幽灵踩下”） */
  clearInputs(): DebugSnapshot {
    this.held = new Map()
    this.pedals = initialPedals()
    return this.snapshot()
  }

  /** 当前状态快照（不改状态） */
  snapshot(): DebugSnapshot {
    const pedals = PEDALS.map((def) => {
      // 初始状态表覆盖全部踏板；兜底仅为类型收窄
      const state = this.pedals.get(def.cc) ?? { value: 0, hasLevel: false, seen: false }
      return { def, state }
    })
    return { held: this.held, pedals }
  }
}

/**
 * 踏板方块里显示的文案：中间大字为百分比、右上角为原始 MIDI 值。
 * 数值**不论是否触发都显示**（未踩即 0% / 0），触发与否由 `pedalFillAlpha` 的绿色背景表达。
 */
export function pedalBoxText(state: PedalState): { percent: string; raw: string } {
  return { percent: `${pedalLevelPercent(state.value)}%`, raw: String(state.value) }
}
