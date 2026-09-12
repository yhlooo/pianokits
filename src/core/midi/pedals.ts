/**
 * 钢琴三踏板的 MIDI 领域逻辑（纯函数，无 DOM，可单测）。
 *
 * 三个踏板是 MIDI 1.0 规定的控制器号（CC，状态字节 0xBn）：
 * - **CC64 Damper Pedal（延音踏板）**：MIDI 1.0 明确 `0–63 = Off，64–127 = On`；
 * - **CC66 Sostenuto（选择延音踏板）**；
 * - **CC67 Soft Pedal（弱音踏板）**。
 *
 * **踏板幅度（踏板角度 / 半踏板）** 就是 CC 的第二数据字节（0–127），规范里没有
 * “设备是否支持幅度”的能力查询接口（见研究文档 20260912-web-midi-velocity-and-pedal.md §4），
 * 因此只能**观察消息值域**判定：某踏板出现过 0/127 之外的中间值即锁定为幅度模式
 * （`hasLevel`）。这是充分判据——只见过端点值不代表设备不支持，可能只是没有半踩。
 */

export type PedalId = 'sustain' | 'sostenuto' | 'soft'

export interface PedalDef {
  id: PedalId
  /** MIDI 控制器号 */
  cc: number
  /** 中文踏板名（UI 标签） */
  name: string
}

/**
 * 显示顺序即数组顺序，**按钢琴踏板从左到右的实际位置**：
 * 左 = 弱音（CC67）、中 = 选择延音（CC66）、右 = 延音（CC64）。
 * 数组顺序与 CC 号大小无关，切勿按 CC 号排序。
 */
export const PEDALS: readonly PedalDef[] = [
  { id: 'soft', cc: 67, name: '弱音' },
  { id: 'sostenuto', cc: 66, name: '选择延音' },
  { id: 'sustain', cc: 64, name: '延音' },
]

/** 踩下判读阈值：MIDI 1.0 附录与本项目 quantize.ts 的 buildSustainIntervals 同值 */
export const PEDAL_ON_THRESHOLD = 64

export interface PedalState {
  /** 最近一次收到的值 0–127 */
  value: number
  /** 是否出现过 0/127 之外的中间值 → 支持幅度表达（本次会话内锁定，不回退） */
  hasLevel: boolean
  /** 是否收到过该 CC 的任何消息（区分“没接这个踏板”与“没踩过”） */
  seen: boolean
}

/** 踏板控制器号集合（含阈值判读在内的一切踏板逻辑的唯一入口） */
const PEDAL_CCS = new Set(PEDALS.map((p) => p.cc))

export function isPedalController(controller: number): boolean {
  return PEDAL_CCS.has(controller)
}

/** 初始踏板状态：三个踏板各一份（未收到任何消息） */
export function initialPedals(): ReadonlyMap<number, PedalState> {
  const states = new Map<number, PedalState>()
  for (const p of PEDALS) states.set(p.cc, { value: 0, hasLevel: false, seen: false })
  return states
}

/**
 * 并入一条 CC 消息，返回新的踏板状态表（纯函数，不修改入参）。
 * 非踏板 CC 原样返回入参引用，调用方可用引用相等判断“是否有踏板状态变化”。
 */
export function applyControlChange(
  states: ReadonlyMap<number, PedalState>,
  controller: number,
  value: number,
): ReadonlyMap<number, PedalState> {
  const prev = states.get(controller)
  if (prev === undefined) return states
  const next = new Map(states)
  next.set(controller, {
    value,
    // 出现过中间值即锁定幅度模式：踏板回到 0/127 时 UI 不会在两种形态间抖动
    hasLevel: prev.hasLevel || (value > 0 && value < 127),
    seen: true,
  })
  return next
}

/** 踩下判读（`value >= 64`） */
export function isPedalDown(state: PedalState): boolean {
  return state.value >= PEDAL_ON_THRESHOLD
}

/** 显示形态：出现过幅度值 → 方块显数值；只见过端点值 → 按开关式呈现 */
export function pedalMode(state: PedalState): 'indicators' | 'level' {
  return state.hasLevel ? 'level' : 'indicators'
}

/** 幅度百分比（显示用）：round(value / 127 × 100)，即 127 → 100% */
export function pedalLevelPercent(value: number): number {
  const clamped = Math.max(0, Math.min(127, value))
  return Math.round((clamped / 127) * 100)
}
