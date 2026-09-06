import { describe, expect, it } from 'vitest'

import { nextViewMode } from './state'

describe('nextViewMode（瀑布/乐谱双开关，不能都关闭）', () => {
  it('分屏下关任一开关 → 只剩另一个', () => {
    expect(nextViewMode('split', 'waterfall')).toBe('score')
    expect(nextViewMode('split', 'score')).toBe('waterfall')
  })

  it('仅瀑布时关瀑布 → 自动开启乐谱（切换而非全关）', () => {
    expect(nextViewMode('waterfall', 'waterfall')).toBe('score')
  })

  it('仅乐谱时关乐谱 → 自动开启瀑布（切换而非全关）', () => {
    expect(nextViewMode('score', 'score')).toBe('waterfall')
  })

  it('开启另一开关 → 回到分屏', () => {
    expect(nextViewMode('waterfall', 'score')).toBe('split')
    expect(nextViewMode('score', 'waterfall')).toBe('split')
  })
})
