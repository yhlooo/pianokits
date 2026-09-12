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
 *
 * 本模块同时承载**文件侧**的踏板领域逻辑（设计文档 20260912-midi-pedal-lane-and-practice.md §3.3）：
 * 踩下区间（时值）、归属范围（按通道 / 全曲）、练习关注范围与和弦踏板要求。
 */

import type { PedalEvent, Track } from '../model'

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

/** 踩下判读阈值：MIDI 1.0 附录与本项目 quantize.ts 的踏板区间构建同值 */
export const PEDAL_ON_THRESHOLD = 64

/** 控制器号 → 踏板定义（含 CC64/66/67 之外的 CC 返回 undefined） */
const PEDAL_BY_CC = new Map<number, PedalDef>(PEDALS.map((p) => [p.cc, p]))
/** 踏板 id → 显示列序（0 = 最左的弱音；与 PEDALS 数组顺序一致，切勿按 CC 号排序） */
const PEDAL_COLUMN = new Map<PedalId, number>(PEDALS.map((p, i) => [p.id, i]))

export function pedalById(id: PedalId): PedalDef {
  // 不可达：PedalId 与 PEDALS 的 id 集合一致（仅防御性兜底）
  const def = PEDALS.find((p) => p.id === id)
  if (def === undefined) throw new RangeError(`未知踏板 id ${id}`)
  return def
}

/** CC 控制器号 → 踏板 id；非三踏板 CC 返回 null */
export function pedalIdOfController(controller: number): PedalId | null {
  return PEDAL_BY_CC.get(controller)?.id ?? null
}

/** 踏板在瀑布流轨道中的列序（0 = 左弱音 / 1 = 中选择延音 / 2 = 右延音） */
export function pedalColumn(id: PedalId): number {
  return PEDAL_COLUMN.get(id) ?? 0
}

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

// ---------- 文件侧领域逻辑（踏板轨道与踏板练习，设计文档 §3.3） ----------

/**
 * 踏板练习模式（练习菜单三选一，默认 off）：
 * - `off`：无踏板练习（踏板轨道全部压暗、不判定）；
 * - `sustain`：只练延音踏板（CC64）；
 * - `all`：三个踏板都练（CC64/66/67）。
 */
export type PedalPracticeMode = 'off' | 'sustain' | 'all'

/** 练习模式包含的踏板集合（off → 空集） */
export function pedalsForMode(mode: PedalPracticeMode): ReadonlySet<PedalId> {
  if (mode === 'off') return new Set()
  if (mode === 'sustain') return new Set<PedalId>(['sustain'])
  return new Set(PEDALS.map((p) => p.id))
}

/**
 * 踏板踩下区间（时值）：同一踏板、同一通道上「踩下（value >= 64）→ 抬起」构成一段。
 * 未抬起又重复踩下忽略（踏板状态不变）；文件结束时仍未抬起的踏板 end = Infinity
 * （曲终一直踩着，语义上持续到结束）。
 */
export interface PedalSegment {
  pedalId: PedalId
  /** 来源通道（归属依据，设计文档 §3.3） */
  channel: number
  /** 来源轨道 index（第一段事件的来源；仅诊断/调试用） */
  trackIndex: number
  /** 秒 */
  start: number
  /** 秒；Infinity = 曲终未抬起 */
  end: number
}

/** 事件流 → 踩下区间（按 start 排序；非三踏板 CC 忽略） */
export function buildPedalSegments(events: readonly PedalEvent[]): PedalSegment[] {
  const open = new Map<string, PedalSegment>()
  const segments: PedalSegment[] = []
  const sorted = [...events].sort((a, b) => a.time - b.time)
  for (const ev of sorted) {
    const pedalId = pedalIdOfController(ev.controller)
    if (pedalId === null) continue
    const key = `${pedalId}|${ev.channel}`
    const current = open.get(key)
    if (ev.value >= PEDAL_ON_THRESHOLD) {
      if (current === undefined) {
        open.set(key, {
          pedalId,
          channel: ev.channel,
          trackIndex: ev.trackIndex,
          start: ev.time,
          end: Number.POSITIVE_INFINITY,
        })
      }
    } else if (current !== undefined) {
      current.end = ev.time
      segments.push(current)
      open.delete(key)
    }
  }
  // 曲终仍未抬起的踏板：end 保持 Infinity
  for (const seg of open.values()) segments.push(seg)
  segments.sort(
    (a, b) =>
      a.start - b.start || a.channel - b.channel || pedalColumn(a.pedalId) - pedalColumn(b.pedalId),
  )
  return segments
}

/**
 * 踏板数据归属（研究文档 20260912-midi-pedal-track-relationship.md §5）：
 * 踏板是通道消息，练习判定按**通道**归属。返回踏板事件所在轨的通道集合；
 * 若存在「踏板通道不在音符通道集合内」的情况（纯控制轨——@tonejs/midi 无法给出其真实通道），
 * 返回 null 表示**全曲踏板**（不分音轨，任何练习轨都要判定）。
 */
export function pedalChannelScope(
  segments: readonly PedalSegment[],
  tracks: readonly Track[],
): ReadonlySet<number> | null {
  const noteChannels = new Set<number>()
  for (const t of tracks) {
    if (t.percussion || t.noteCount === 0) continue
    noteChannels.add(t.channel)
  }
  const pedalChannels = new Set<number>()
  for (const seg of segments) pedalChannels.add(seg.channel)
  for (const c of pedalChannels) {
    if (!noteChannels.has(c)) return null // 无法归属到任何声部 → 视为全曲踏板
  }
  return pedalChannels
}

/**
 * 练习模式下踏板轨道的关注范围（判定 + 瀑布流压暗共用）：
 * - `pedals`：本模式**参与判定**的踏板（all = 三踏板，sustain = 只判延音；练习模式自己的口径，
 *   不因文件里没有某个踏板的踩下事件而缩小——否则"全部踏板练习"下额外踩错踏板就抓不到了）；
 * - `channels`：参与判定的通道；null = 全曲（不按通道过滤）。
 */
export interface PedalFocus {
  pedals: ReadonlySet<PedalId>
  channels: ReadonlySet<number> | null
}

/**
 * 由曲目踏板数据、练习轨集合与练习模式推导关注范围：
 * - 练习未开启（练习轨集合为空）→ null（踏板条全部正常显示、不判定）；
 * - 练习开启但踏板练习为 off / 练习轨通道内没有任何踏板数据 →
 *   `{ pedals: ∅, channels: null }`（踏板条全部压暗、和弦不带踏板要求）；
 * - 其余：判定踏板 = 模式踏板集合，判定通道 = 踏板归属通道 ∩ 练习轨通道（全曲踏板时为 null）。
 */
export function pedalFocus(
  segments: readonly PedalSegment[],
  tracks: readonly Track[],
  practiceTracks: ReadonlySet<number>,
  mode: PedalPracticeMode,
): PedalFocus | null {
  if (practiceTracks.size === 0) return null
  const modePedals = pedalsForMode(mode)
  if (modePedals.size === 0) return { pedals: new Set(), channels: null }

  const scope = pedalChannelScope(segments, tracks)
  let channels: ReadonlySet<number> | null = null
  if (scope !== null) {
    const practiceChannels = new Set<number>()
    for (const t of tracks) {
      if (practiceTracks.has(t.index)) practiceChannels.add(t.channel)
    }
    const intersection = new Set<number>()
    for (const c of scope) {
      if (practiceChannels.has(c)) intersection.add(c)
    }
    // 练习的部分没有任何踏板数据 → 踏板不参与判定（踏板条全部压暗）
    if (intersection.size === 0) return { pedals: new Set(), channels: null }
    channels = intersection
  }
  return { pedals: modePedals, channels }
}

/** 分段是否在关注范围内（瀑布流压暗与判定共用的唯一谓词） */
export function isSegmentFocused(seg: PedalSegment, focus: PedalFocus): boolean {
  if (!focus.pedals.has(seg.pedalId)) return false
  return focus.channels === null || focus.channels.has(seg.channel)
}

/**
 * 时刻 `at` 时**关注范围内、文件正处于踩下状态**的踏板（踩下区间的持续期间：`start ≤ at < end`，
 * 曲终未抬起的段一直踩着）。
 *
 * 练习判定用它把**长踏板**与**长音符**同等对待（设计文档
 * 20260912-midi-pedal-lane-and-practice.md §3.5 的 2026-09-12 修订）：持续期间内松开再踩、
 * 或本来就没踩时补踩，都是在"文件正踩着"的时刻踩下 → 正确，不记误踩。
 * 与 `isSegmentFocused` 同一关注范围口径（模式 ∩ 练习通道），因此未被压暗的踏板才可能算"踩着"。
 */
export function pedalsDownAt(
  segments: readonly PedalSegment[],
  focus: PedalFocus,
  at: number,
): Set<PedalId> {
  const down = new Set<PedalId>()
  for (const seg of segments) {
    if (seg.start <= at && at < seg.end && isSegmentFocused(seg, focus)) down.add(seg.pedalId)
  }
  return down
}

/**
 * 同一次踩下判为「同一瞬间」的容差（秒）：与和弦分组的 CHORD_EPSILON_SEC 同量级，
 * 用于把同一时刻踩下的多个踏板并成一个要求。
 */
export const PEDAL_EVENT_EPSILON_SEC = 0.03

/** 练习闸门点里的踏板要求（由 `mergePedalGates` 产出） */
export interface PedalGatePoint {
  /** 判定时刻：合并到和弦时 = 和弦起点，独立踏板闸门 = 踏板踩下时刻 */
  start: number
  /** 本闸门要求「现踩」的踏板（边缘触发） */
  pedals: PedalId[]
}

/**
 * 把「关注范围内的踏板踩下事件」并入和弦时间轴，得到练习闸门点（设计文档
 * 20260912-midi-pedal-lane-and-practice.md §3.5）：
 * - 与某个和弦起点相差 ≤ `windowSec` 的踏板事件 → **并入该和弦闸门**（与琴键一起踩，
 *   判定时刻取和弦起点）；
 * - 其余踏板事件各自成为**独立闸门**——踏板与按键同等地位：没有音符要按的时刻也能单独判定；
 * - 同一瞬间（≤ `PEDAL_EVENT_EPSILON_SEC`）踩下的多个踏板并成同一个要求。
 *
 * 返回按 start 排序；不含踏板要求的和弦闸门也会保留（`pedals` 为空数组）。
 */
export function mergePedalGates(
  chordStarts: readonly number[],
  segments: readonly PedalSegment[],
  focus: PedalFocus,
  windowSec: number,
): PedalGatePoint[] {
  // 1) 关注范围内的踏板踩下事件 → 时刻 + 该时刻踩下的踏板
  const pedalDowns: { start: number; pedals: PedalId[] }[] = []
  if (focus.pedals.size > 0) {
    for (const seg of segments) {
      if (!isSegmentFocused(seg, focus)) continue
      const last = pedalDowns[pedalDowns.length - 1]
      if (last !== undefined && seg.start - last.start <= PEDAL_EVENT_EPSILON_SEC) {
        if (!last.pedals.includes(seg.pedalId)) last.pedals.push(seg.pedalId)
        continue
      }
      pedalDowns.push({ start: seg.start, pedals: [seg.pedalId] })
    }
  }

  // 2) 和弦闸门 + 并入靠近的踏板事件；远离和弦的踏板事件独立成闸门
  const gates: PedalGatePoint[] = chordStarts.map((start) => ({ start, pedals: [] }))
  for (const down of pedalDowns) {
    const near = gates.find((g) => Math.abs(g.start - down.start) <= windowSec)
    if (near === undefined) {
      gates.push({ start: down.start, pedals: [...down.pedals] })
      continue
    }
    for (const pedal of down.pedals) {
      if (!near.pedals.includes(pedal)) near.pedals.push(pedal)
    }
  }
  gates.sort((a, b) => a.start - b.start)
  return gates
}
