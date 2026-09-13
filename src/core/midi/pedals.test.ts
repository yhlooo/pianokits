import { describe, expect, it } from 'vitest'

import type { Note, PedalEvent, Track } from '../model'
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
  mergePedalGates,
  pedalLevelPercent,
  pedalMode,
  pedalValuesAt,
  pedalsDownAt,
  pedalsForMode,
  soundingEndsUnderSustain,
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

describe('mergePedalGates / isSegmentFocused（练习闸门）', () => {
  const segments = buildPedalSegments([
    pedalEvent(1, 64, 127, 0, 0), // 1–3 秒踩着延音
    pedalEvent(3, 64, 0, 0, 0),
    pedalEvent(5, 67, 127, 0, 0), // 5 秒起弱音
  ])
  const tracks = [track(0, 0)]
  const focusAll = () => pedalFocus(segments, tracks, new Set([0]), 'all')!

  it('踏板踩下事件并入相近的和弦闸门；远离和弦的独立成闸门（踏板与按键同等地位）', () => {
    // 和弦 1.1s（与踏板 1.0s 相差 0.1 ≤ 窗口）→ 并入；和弦 3.5s 与踏板 5.0s 相差 1.5 → 独立
    const gates = mergePedalGates([1.1, 3.5], segments, focusAll(), 0.2)
    expect(gates).toEqual([
      { start: 1.1, pedals: ['sustain'] },
      { start: 3.5, pedals: [] },
      { start: 5.0, pedals: ['soft'] },
    ])
  })

  it('窗口外的和弦保持无踏板要求；没有和弦时全部踏板事件都独立成闸门', () => {
    expect(mergePedalGates([2.5], segments, focusAll(), 0.2)).toEqual([
      { start: 1.0, pedals: ['sustain'] },
      { start: 2.5, pedals: [] },
      { start: 5.0, pedals: ['soft'] },
    ])
    expect(mergePedalGates([], segments, focusAll(), 0.2)).toEqual([
      { start: 1.0, pedals: ['sustain'] },
      { start: 5.0, pedals: ['soft'] },
    ])
  })

  it('同一瞬间踩下的多个踏板并成同一个要求', () => {
    const both = buildPedalSegments([pedalEvent(1, 64, 127, 0, 0), pedalEvent(1.01, 67, 127, 0, 0)])
    expect(mergePedalGates([], both, pedalFocus(both, tracks, new Set([0]), 'all')!, 0.2)).toEqual([
      { start: 1, pedals: ['sustain', 'soft'] },
    ])
  })

  it('关注范围外的踏板不进闸门（练习轨通道无踏板 / 模式外）', () => {
    // 两轨都有音符（通道 1 / 0），踏板归属通道 0 → 练通道 1 的轨时没有踏板闸门
    const other = [track(0, 1), track(1, 0)]
    const noMatch = pedalFocus(segments, other, new Set([0]), 'all')!
    expect(mergePedalGates([2], segments, noMatch, 0.2)).toEqual([{ start: 2, pedals: [] }])
    const sustainOnly = pedalFocus(segments, tracks, new Set([0]), 'sustain')!
    expect(mergePedalGates([], segments, sustainOnly, 0.2)).toEqual([
      { start: 1, pedals: ['sustain'] },
    ])
  })

  it('isSegmentFocused：踏板类型与通道都在范围内才算关注', () => {
    const focus = pedalFocus(segments, tracks, new Set([0]), 'sustain')!
    const [sustainSeg, softSeg] = segments
    expect(isSegmentFocused(sustainSeg, focus)).toBe(true)
    expect(isSegmentFocused(softSeg, focus)).toBe(false)
    expect(isSegmentFocused({ ...sustainSeg, channel: 1 }, focus)).toBe(false)
  })
})

function note(pitch: number, start: number, end: number, trackIndex = 0): Note {
  return { pitch, start, end, velocity: 100, trackIndex }
}

describe('soundingEndsUnderSustain（延音踏板 → 实际发声结束时刻）', () => {
  const t0 = [track(0, 0)]

  it('键抬起时踏板踩着 → 音符延到踏板抬起', () => {
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5)], t0, [
      pedalEvent(0.4, 64, 127),
      pedalEvent(2, 64, 0),
    ])
    expect([...ends]).toEqual([2])
  })

  it('踏板踩下之前键已抬起 → 不延（踏板不能复活已经止住的音）', () => {
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5)], t0, [
      pedalEvent(0.6, 64, 127),
      pedalEvent(2, 64, 0),
    ])
    expect([...ends]).toEqual([0.5])
  })

  it('键仍按着时踏板抬起 → 不受影响（照常响到键抬起）', () => {
    const ends = soundingEndsUnderSustain([note(60, 0, 2)], t0, [
      pedalEvent(0, 64, 127),
      pedalEvent(1, 64, 0),
    ])
    expect([...ends]).toEqual([2])
  })

  it('踏板踩着时同音高再次击键 → 前一音在新音起点截断（弦被重新击打）', () => {
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5), note(60, 1, 1.5)], t0, [
      pedalEvent(0.4, 64, 127),
      pedalEvent(3, 64, 0),
    ])
    expect([...ends]).toEqual([1, 3])
  })

  it('换踩（0 → 127 紧邻）会清掉前一和声：键已抬起的音在抬起时刻结束，新音照常受新一段延音', () => {
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5), note(62, 3.2, 3.6)], t0, [
      pedalEvent(0.4, 64, 127),
      pedalEvent(3, 64, 0),
      pedalEvent(3.003, 64, 127),
      pedalEvent(5, 64, 0),
    ])
    expect([...ends]).toEqual([3, 5])
  })

  it('参考实现用例（Magenta.js applySustainControlChanges 的官方用例逐值一致）', () => {
    const notes = [note(11, 0.22, 0.5), note(40, 2.5, 3.5), note(55, 4.0, 4.01)]
    const pedals = [
      pedalEvent(0.0, 64, 127),
      pedalEvent(0.75, 64, 0),
      pedalEvent(2.0, 64, 127),
      pedalEvent(3.0, 64, 0),
      pedalEvent(3.75, 64, 127),
      pedalEvent(4.5, 64, 127), // 已经踩着时重复踩下：无影响
      pedalEvent(4.8, 64, 0),
      pedalEvent(4.9, 64, 127),
      pedalEvent(6.0, 64, 0),
    ]
    expect([...soundingEndsUnderSustain(notes, t0, pedals)]).toEqual([0.75, 3.5, 4.8])
  })

  it('按通道归属：不同通道的踏板互不影响', () => {
    const tracks = [track(0, 0), track(1, 1)]
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5, 0), note(64, 0, 0.5, 1)], tracks, [
      pedalEvent(0.4, 64, 127, 0, 0),
      pedalEvent(2, 64, 0, 0, 0),
    ])
    expect([...ends]).toEqual([2, 0.5])
  })

  it('纯控制轨上的踏板（无法归属通道）→ 全曲踏板，所有音符都延音', () => {
    const tracks = [track(0, 3), track(9, 5, 0)]
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5, 0)], tracks, [
      pedalEvent(0.4, 64, 127, 9, 5),
      pedalEvent(2, 64, 0, 9, 5),
    ])
    expect([...ends]).toEqual([2])
  })

  it('曲终仍未抬起 → 结束在最后一个事件时刻（不产生 Infinity）', () => {
    const ends = soundingEndsUnderSustain([note(60, 0, 0.5), note(64, 2, 2.5)], t0, [
      pedalEvent(0.4, 64, 127),
    ])
    expect([...ends]).toEqual([2.5, 2.5])
  })

  it('无踏板数据 / 非踏板 CC → 原样返回键按时值（引用新数组）', () => {
    const notes = [note(60, 0, 0.5)]
    expect([...soundingEndsUnderSustain(notes, t0, [])]).toEqual([0.5])
    expect([...soundingEndsUnderSustain(notes, t0, [pedalEvent(0, 67, 127)])]).toEqual([0.5])
  })

  it('阈值：63 不算踩下（不延音）；64 算', () => {
    expect([
      ...soundingEndsUnderSustain([note(60, 0, 0.5)], t0, [pedalEvent(0.4, 64, 63)]),
    ]).toEqual([0.5])
    expect([
      ...soundingEndsUnderSustain([note(60, 0, 0.5)], t0, [pedalEvent(0.4, 64, 64)]),
    ]).toEqual([0.5]) // 未抬起 → 结束在最后事件时刻（0.5）
  })
})

describe('pedalValuesAt（时刻 → 各踏板当前值，供输出端口补发状态）', () => {
  const events = [pedalEvent(0, 64, 127), pedalEvent(1, 64, 0), pedalEvent(2, 67, 100, 0, 0)]

  it('取 at 之前（含）最后一条事件的值；未收到消息的踏板为 0', () => {
    expect([...pedalValuesAt(events, -1)]).toEqual([
      [67, 0],
      [66, 0],
      [64, 0],
    ])
    expect([...pedalValuesAt(events, 0)]).toEqual([
      [67, 0],
      [66, 0],
      [64, 127],
    ])
    expect(pedalValuesAt(events, 1.5).get(64)).toBe(0)
    expect(pedalValuesAt(events, 9).get(67)).toBe(100)
    expect(pedalValuesAt(events, 9).get(66)).toBe(0)
  })
})

describe('pedalsDownAt（踩下区间的持续期间）', () => {
  const segments = buildPedalSegments([
    pedalEvent(1, 64, 127, 0, 0), // 延音 1–3 秒
    pedalEvent(3, 64, 0, 0, 0),
    pedalEvent(4, 67, 127, 0, 0), // 弱音 4 秒起（曲终未抬起 → 一直踩着）
  ])
  const focusAll = pedalFocus(segments, [track(0, 0)], new Set([0]), 'all')!

  it('持续期间内（含踩下时刻、不含抬起时刻）为「文件正踩着」', () => {
    expect([...pedalsDownAt(segments, focusAll, 0.9)]).toEqual([])
    expect([...pedalsDownAt(segments, focusAll, 1)]).toEqual(['sustain']) // 踩下时刻
    expect([...pedalsDownAt(segments, focusAll, 2.5)]).toEqual(['sustain'])
    expect([...pedalsDownAt(segments, focusAll, 3)]).toEqual([]) // 抬起时刻起不再踩着
    expect([...pedalsDownAt(segments, focusAll, 4)]).toEqual(['soft'])
    expect([...pedalsDownAt(segments, focusAll, 99)]).toEqual(['soft']) // 曲终未抬起
  })

  it('关注范围外的踏板/通道不算「踩着」（与压暗同一口径）', () => {
    const sustainOnly = pedalFocus(segments, [track(0, 0)], new Set([0]), 'sustain')!
    expect([...pedalsDownAt(segments, sustainOnly, 4.5)]).toEqual([]) // 弱音不在模式内
    const noMatch = pedalFocus(segments, [track(0, 1), track(1, 0)], new Set([0]), 'all')!
    expect([...pedalsDownAt(segments, noMatch, 2)]).toEqual([]) // 练习轨通道与踏板通道无交集
    expect([...pedalsDownAt(segments, { pedals: new Set(), channels: null }, 2)]).toEqual([])
  })
})
