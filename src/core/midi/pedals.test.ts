import { describe, expect, it } from 'vitest'

import type { PedalEvent, Track } from '../model'
import {
  PEDAL_ON_THRESHOLD,
  PEDALS,
  applyControlChange,
  buildPedalSegments,
  initialPedals,
  isPedalController,
  isPedalDown,
  isSegmentFocused,
  pedalChannelScope,
  pedalFocus,
  pedalLevelPercent,
  pedalMode,
  pedalsForMode,
  requiredPedalsAt,
} from './pedals'

const state = (
  m: ReadonlyMap<number, { value: number; hasLevel: boolean; seen: boolean }>,
  cc: number,
) => {
  const s = m.get(cc)
  if (s === undefined) throw new Error(`缺少踏板 ${cc}`)
  return s
}

describe('PEDALS 定义', () => {
  it('三个踏板按钢琴从左到右排列：弱音(67) / 选择延音(66) / 延音(64)', () => {
    expect(PEDALS.map((p) => [p.cc, p.name])).toEqual([
      [67, '弱音'],
      [66, '选择延音'],
      [64, '延音'],
    ])
    expect(PEDAL_ON_THRESHOLD).toBe(64)
  })

  it('isPedalController 只认三个踏板 CC（CC65 Portamento 等不算）', () => {
    expect(isPedalController(64)).toBe(true)
    expect(isPedalController(66)).toBe(true)
    expect(isPedalController(67)).toBe(true)
    expect(isPedalController(65)).toBe(false)
    expect(isPedalController(1)).toBe(false)
    expect(isPedalController(123)).toBe(false)
  })
})

describe('applyControlChange', () => {
  it('初始三踏板均为未踩、未见过消息', () => {
    const m = initialPedals()
    expect([...m.keys()]).toEqual(PEDALS.map((p) => p.cc))
    for (const cc of [64, 66, 67]) {
      expect(state(m, cc)).toEqual({ value: 0, hasLevel: false, seen: false })
    }
  })

  it('只收到端点值 → 不锁定幅度模式（开关式踏板）', () => {
    let m = initialPedals()
    m = applyControlChange(m, 64, 127)
    expect(state(m, 64)).toEqual({ value: 127, hasLevel: false, seen: true })
    m = applyControlChange(m, 64, 0)
    expect(state(m, 64)).toEqual({ value: 0, hasLevel: false, seen: true })
  })

  it('出现 0/127 之外的中间值 → 锁定幅度模式，回到端点也不回退', () => {
    let m = initialPedals()
    m = applyControlChange(m, 64, 80)
    expect(state(m, 64).hasLevel).toBe(true)
    m = applyControlChange(m, 64, 127)
    expect(state(m, 64)).toEqual({ value: 127, hasLevel: true, seen: true })
    m = applyControlChange(m, 64, 0)
    expect(state(m, 64).hasLevel).toBe(true)
  })

  it('各踏板独立判定：延音有幅度不影响弱音', () => {
    let m = initialPedals()
    m = applyControlChange(m, 64, 55)
    m = applyControlChange(m, 67, 127)
    expect(state(m, 64).hasLevel).toBe(true)
    expect(state(m, 67).hasLevel).toBe(false)
  })

  it('非踏板 CC 原样返回（引用相等），调用方据此免于无谓重绘', () => {
    const m = initialPedals()
    expect(applyControlChange(m, 1, 64)).toBe(m)
    expect(applyControlChange(m, 65, 127)).toBe(m)
  })

  it('纯函数：不修改入参状态表', () => {
    const m = initialPedals()
    const next = applyControlChange(m, 64, 100)
    expect(state(m, 64)).toEqual({ value: 0, hasLevel: false, seen: false })
    expect(state(next, 64).value).toBe(100)
  })
})

describe('踩下判读与显示形态', () => {
  it('阈值边界：63 未踩、64 踩下', () => {
    expect(isPedalDown({ value: 63, hasLevel: true, seen: true })).toBe(false)
    expect(isPedalDown({ value: 64, hasLevel: true, seen: true })).toBe(true)
  })

  it('pedalMode：见过幅度值 → level，否则 indicators', () => {
    expect(pedalMode({ value: 127, hasLevel: false, seen: true })).toBe('indicators')
    expect(pedalMode({ value: 30, hasLevel: true, seen: true })).toBe('level')
  })
})

describe('pedalLevelPercent', () => {
  it('按 /127 线性换算并四舍五入', () => {
    expect(pedalLevelPercent(0)).toBe(0)
    expect(pedalLevelPercent(63)).toBe(50) // 49.6 → 50
    expect(pedalLevelPercent(64)).toBe(50) // 50.4 → 50
    expect(pedalLevelPercent(127)).toBe(100)
    expect(pedalLevelPercent(1)).toBe(1)
  })

  it('越界值收敛到 0–100', () => {
    expect(pedalLevelPercent(-5)).toBe(0)
    expect(pedalLevelPercent(200)).toBe(100)
  })
})

// ---------- 文件侧领域逻辑（设计文档 20260912-midi-pedal-lane-and-practice.md §3.3） ----------

function pedalEvent(
  time: number,
  controller: number,
  value: number,
  trackIndex = 0,
  channel = 0,
): PedalEvent {
  return { time, controller, value, trackIndex, channel }
}

function track(index: number, channel: number, noteCount = 1, percussion = false): Track {
  return { index, name: `T${index}`, channel, instrument: 0, percussion, noteCount }
}

describe('pedalsForMode', () => {
  it('off 不含任何踏板；sustain 只含延音；all 含三踏板', () => {
    expect([...pedalsForMode('off')]).toEqual([])
    expect([...pedalsForMode('sustain')]).toEqual(['sustain'])
    expect([...pedalsForMode('all')].sort()).toEqual(['soft', 'sostenuto', 'sustain'])
  })
})

describe('buildPedalSegments', () => {
  it('同踏板同通道「踩下 → 抬起」构成一段；重复踩下忽略；非踏板 CC 忽略', () => {
    const segments = buildPedalSegments([
      pedalEvent(0, 64, 127),
      pedalEvent(0.5, 64, 127), // 未抬起又踩：忽略
      pedalEvent(1, 64, 0),
      pedalEvent(2, 7, 127), // 音量：非踏板
      pedalEvent(3, 67, 127),
      pedalEvent(4, 67, 0),
    ])
    expect(segments.map((s) => [s.pedalId, s.start, s.end])).toEqual([
      ['sustain', 0, 1],
      ['soft', 3, 4],
    ])
  })

  it('曲终未抬起 → end = Infinity（一直踩到结束）', () => {
    const [seg] = buildPedalSegments([pedalEvent(1, 64, 100)])
    expect(seg.pedalId).toBe('sustain')
    expect(seg.end).toBe(Number.POSITIVE_INFINITY)
  })

  it('不同通道各自独立成段，结果按 start 排序', () => {
    const segments = buildPedalSegments([
      pedalEvent(2, 64, 127, 1, 1),
      pedalEvent(0, 64, 127, 0, 0),
      pedalEvent(3, 64, 0, 1, 1),
      pedalEvent(1, 64, 0, 0, 0),
    ])
    expect(segments.map((s) => [s.channel, s.start, s.end])).toEqual([
      [0, 0, 1],
      [1, 2, 3],
    ])
  })

  it('阈值边界：63 不算踩下（不能开启一段）', () => {
    expect(buildPedalSegments([pedalEvent(0, 64, 63)])).toEqual([])
    expect(buildPedalSegments([pedalEvent(0, 64, 64)])).toHaveLength(1)
  })
})

describe('pedalChannelScope / pedalFocus（归属规则）', () => {
  const sustained = buildPedalSegments([pedalEvent(0, 64, 127, 1, 0), pedalEvent(2, 64, 0, 1, 0)])

  it('踏板都在有音符的通道上 → 按通道归属（多轨同通道共享踏板）', () => {
    const tracks = [track(0, 0), track(1, 0)]
    expect([...(pedalChannelScope(sustained, tracks) ?? [])]).toEqual([0])
    // 两轨同通道：练任一轨都判定同一份踏板
    for (const practice of [new Set([0]), new Set([1])]) {
      const focus = pedalFocus(sustained, tracks, practice, 'all')
      expect(focus?.channels).toEqual(new Set([0]))
      expect([...(focus?.pedals ?? [])].sort()).toEqual(['soft', 'sostenuto', 'sustain'])
    }
  })

  it('存在无音符轨（纯控制轨）上的踏板 → 全曲踏板（channels = null，任何练习轨都判定）', () => {
    const controlOnly = buildPedalSegments([pedalEvent(0, 64, 127, 9, 5)])
    const tracks = [track(0, 0), track(9, 5, 0)]
    expect(pedalChannelScope(controlOnly, tracks)).toBeNull()
    const focus = pedalFocus(controlOnly, tracks, new Set([0]), 'sustain')
    expect(focus).toEqual({ pedals: new Set(['sustain']), channels: null })
  })

  it('练习未开启（无练习轨）→ null（踏板轨道全部正常显示）', () => {
    expect(pedalFocus(sustained, [track(0, 0)], new Set(), 'all')).toBeNull()
  })

  it('练习中但踏板练习为 off / 练习轨通道无踏板 → pedals 为空（全部压暗、不判定）', () => {
    const tracks = [track(0, 0), track(1, 1)]
    expect(pedalFocus(sustained, tracks, new Set([1]), 'all')).toEqual({
      pedals: new Set(),
      channels: null,
    })
    expect(pedalFocus(sustained, tracks, new Set([0]), 'off')).toEqual({
      pedals: new Set(),
      channels: null,
    })
  })

  it('判定踏板 = 模式口径：sustain 只判延音；all 三踏板都判（文件没有数据的踏板也判）', () => {
    const events = buildPedalSegments([pedalEvent(0, 64, 127, 0, 0), pedalEvent(1, 64, 0, 0, 0)])
    const tracks = [track(0, 0)]
    expect([...(pedalFocus(events, tracks, new Set([0]), 'sustain')?.pedals ?? [])]).toEqual([
      'sustain',
    ])
    // all：即使本曲只有 CC64 数据，额外踩弱音/选择延音也算误踩（否则"全部踏板练习"形同虚设）
    expect([...(pedalFocus(events, tracks, new Set([0]), 'all')?.pedals ?? [])].sort()).toEqual([
      'soft',
      'sostenuto',
      'sustain',
    ])
  })
})

describe('requiredPedalsAt / isSegmentFocused', () => {
  const segments = buildPedalSegments([
    pedalEvent(1, 64, 127, 0, 0), // 1–3 秒踩着延音
    pedalEvent(3, 64, 0, 0, 0),
    pedalEvent(5, 67, 127, 0, 0), // 5 秒起弱音（与练习轨通道无关的用例另测）
  ])
  const tracks = [track(0, 0)]

  it('覆盖和弦起点的长踏板算要求；和弦后 120ms 内新踩下的也算', () => {
    const focus = pedalFocus(segments, tracks, new Set([0]), 'all')!
    expect([...requiredPedalsAt(segments, 2, focus, 0.12)]).toEqual(['sustain'])
    expect([...requiredPedalsAt(segments, 4.95, focus, 0.12)]).toEqual(['soft'])
  })

  it('和弦前已抬起 / 窗口外才踩下的踏板不算要求', () => {
    const focus = pedalFocus(segments, tracks, new Set([0]), 'all')!
    expect([...requiredPedalsAt(segments, 3.5, focus, 0.12)]).toEqual([])
    expect([...requiredPedalsAt(segments, 4.5, focus, 0.12)]).toEqual([])
  })

  it('关注范围外的踏板不算要求（练习轨通道无踏板 / 模式外）', () => {
    // 两轨都有音符（通道 1 / 0），踏板归属通道 0 → 练通道 1 的轨时无踏板要求
    const other = [track(0, 1), track(1, 0)]
    const noMatch = pedalFocus(segments, other, new Set([0]), 'all')!
    expect([...requiredPedalsAt(segments, 2, noMatch, 0.12)]).toEqual([])
    const sustainOnly = pedalFocus(segments, tracks, new Set([0]), 'sustain')!
    expect([...requiredPedalsAt(segments, 4.95, sustainOnly, 0.12)]).toEqual([])
  })

  it('isSegmentFocused：踏板类型与通道都在范围内才算关注', () => {
    const focus = pedalFocus(segments, tracks, new Set([0]), 'sustain')!
    const [sustainSeg, softSeg] = segments
    expect(isSegmentFocused(sustainSeg, focus)).toBe(true)
    expect(isSegmentFocused(softSeg, focus)).toBe(false)
    expect(isSegmentFocused({ ...sustainSeg, channel: 1 }, focus)).toBe(false)
  })
})
