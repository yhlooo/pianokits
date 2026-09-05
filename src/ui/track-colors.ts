/** 轨道着色色板中的一种颜色：渐变顶 / 底两个 RGB 三元组 */
export type TrackColor = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
]

/**
 * 瀑布流按轨着色色板（设计文档 `20260905-waterfall-track-colors.md` §3.2）：
 * 只分轨不分手，一轨一色，第 6 轨循环回第 1 色。
 * 五色均为低饱和“宝石”色调：明度带一致（顶 66–69%、底 47–53%）、
 * 色相全环分布（相邻最小间隔 37°），与乌木舞台和谐且可区分。
 */
export const TRACK_COLORS: readonly TrackColor[] = [
  // 1 琥珀（与全局 accent 同族，沿用旧右手色）
  [
    [228, 184, 113],
    [194, 145, 74],
  ],
  // 2 钢蓝（沿用旧左手色）
  [
    [143, 168, 196],
    [95, 118, 148],
  ],
  // 3 鼠尾草绿
  [
    [169, 198, 155],
    [110, 143, 99],
  ],
  // 4 松石青
  [
    [143, 196, 186],
    [95, 148, 140],
  ],
  // 5 丁香紫
  [
    [166, 155, 196],
    [116, 105, 146],
  ],
]

/** 轨道号（0 基）→ 色板颜色；超过色板大小按模循环（第 6 轨复用第 1 色） */
export function trackColor(trackIndex: number): TrackColor {
  const index = ((trackIndex % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length
  return TRACK_COLORS[index]
}
