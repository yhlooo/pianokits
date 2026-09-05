import type { Note } from '../model'

/**
 * 调式拟合：从音符内容估计整曲调号（升降号数量 sf）与主音/大小调。
 *
 * 动机：现实中的 MIDI 文件的 keySignature 元数据经常缺失、为占位默认值（C 大调）
 * 或自相矛盾（同一时刻多个冲突 meta），直接信任元数据会让一首 G 小调的曲子
 * 被记成「C 大调 + 满屏逐音升号记号」（应为 2 个降号的全局调号）。
 *
 * 算法：
 * 1. 全部非打击乐音符 → 时长加权 pitch-class 直方图；
 * 2. 候选 sf ∈ [-7, +7] 逐一试拼写，代价 = Σ(时长权重 × 临时记号罚分)，取最小；
 *    罚分：调号覆盖的黑键 0、未覆盖黑键需 '#'/'b' 记 1、与调号冲突的白键需 'n' 记 1.5；
 * 3. 平手时 |sf| 小优先；再用 Krumhansl–Schmuckler 大小调特征相关度定主音与模式：
 *    若最优调性对应的 sf 与最小代价的 sf 相差不超过 TOL 个记号，采用调性结果
 *    （纯黑键缺失导致的二义性按音乐性裁决）；
 * 4. confidence = 相对 sf=0 的记号节省率，供「估计 vs 元数据」冲突裁决使用。
 */

/** 调号升降音集合（音级），与 quantize.ts 拼写共用 */
export const SIG_SHARP_PCS = [5, 0, 7, 2, 9, 4, 11] as const // F C G D A E B
export const SIG_FLAT_PCS = [11, 4, 9, 2, 7, 0, 5] as const // B E A D G C F

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11])

export interface KeyEstimate {
  /** 升降号数量：正 = 升号数，负 = 降号数（C 大调 = 0） */
  sf: number
  /** 0 = 大调，1 = 小调 */
  mi: 0 | 1
  /** 主音音级（0 = C … 11 = B） */
  tonicPc: number
  /** 置信度：相比 sf=0 节省的临时记号占比（0..1），sf=0 最优时为 0 */
  confidence: number
}

/** 估计与元数据冲突时仍优先估计结果的最小置信度 */
export const ESTIMATE_OVERRIDE_CONFIDENCE = 0.15

/** 音级直方图在候选 sf 下的临时记号代价（时长加权） */
function sigCost(hist: readonly number[], sf: number): number {
  // SIG_*_PCS 存的是「被升降的白键音级」：升号使该白键 +1 半音、降号使 -1 半音
  const sharpSet = new Set<number>(SIG_SHARP_PCS.slice(0, Math.max(0, sf)))
  const flatSet = new Set<number>(SIG_FLAT_PCS.slice(0, Math.max(0, -sf)))
  let cost = 0
  for (let pc = 0; pc < 12; pc++) {
    const w = hist[pc]
    if (w <= 0) continue
    if (WHITE_PCS.has(pc)) {
      // 白键与调号冲突（如 F 大调中的 B♮）：需还原记号，记 1.5（更扎眼）
      if (sharpSet.has(pc) || flatSet.has(pc)) cost += 1.5 * w
    } else {
      // 黑键：被某个升号白键（-1 半音让它）或降号白键（+1 半音让它）覆盖则无记号
      const covered = sharpSet.has((pc - 1 + 12) % 12) || flatSet.has((pc + 1) % 12)
      if (!covered) cost += w
    }
  }
  return cost
}

/** Krumhansl–Schmuckler 调性特征（降序权重，索引为主音相对音级） */
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    num += da * db
    va += da * da
    vb += db * db
  }
  if (va < 1e-9 || vb < 1e-9) return 0
  return num / Math.sqrt(va * vb)
}

/** 24 个调中特征相关度最高的（主音 + 模式） */
function bestTonality(hist: readonly number[]): { tonicPc: number; mi: 0 | 1; score: number } {
  let best = { tonicPc: 0, mi: 0 as 0 | 1, score: Number.NEGATIVE_INFINITY }
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated: number[] = []
    for (let i = 0; i < 12; i++) rotated.push(hist[(tonic + i) % 12])
    for (const [mi, profile] of [
      [0, KS_MAJOR],
      [1, KS_MINOR],
    ] as const) {
      const score = pearson(rotated, profile)
      if (score > best.score) best = { tonicPc: tonic, mi, score }
    }
  }
  return best
}

// 大调主音音级 → sf（五度圈）：C0 Db-5 D2 Eb-3 E4 F-1 F#6 G1 Ab-4 A3 Bb-2 B5
const MAJOR_SF: Record<number, number> = {
  0: 0,
  1: -5,
  2: 2,
  3: -3,
  4: 4,
  5: -1,
  6: 6,
  7: 1,
  8: -4,
  9: 3,
  10: -2,
  11: 5,
}

/** 调性（主音 + 大小调）→ 调号 sf（小调取关系大调，+3 半音） */
export function tonalitySf(tonicPc: number, mi: 0 | 1): number {
  const relPc = mi === 1 ? (tonicPc + 3) % 12 : tonicPc
  return MAJOR_SF[relPc]
}

/**
 * 估计整曲调号。
 * @param notes 非打击乐音符（parse 已过滤）
 */
export function estimateKey(notes: readonly Note[]): KeyEstimate {
  const hist = new Array<number>(12).fill(0)
  for (const n of notes) {
    const w = Math.max(0.01, n.end - n.start)
    hist[((n.pitch % 12) + 12) % 12] += w
  }
  const total = hist.reduce((s, v) => s + v, 0)
  if (total <= 0) return { sf: 0, mi: 0, tonicPc: 0, confidence: 0 }

  // 每个 sf 的临时记号代价
  const costs: { sf: number; cost: number }[] = []
  for (let sf = -7; sf <= 7; sf++) costs.push({ sf, cost: sigCost(hist, sf) })
  costs.sort((a, b) => a.cost - b.cost || Math.abs(a.sf) - Math.abs(b.sf))
  let bestSf = costs[0].sf
  const minCost = costs[0].cost

  // 调性裁决：最优调性对应的 sf 若与最小代价接近（≤2 次记号的容忍），按调性取 sf/模式
  const tonal = bestTonality(hist)
  const tonalSf = tonalitySf(tonal.tonicPc, tonal.mi)
  const tonalCost = sigCost(hist, tonalSf)
  let tonicPc = tonal.tonicPc
  let mi = tonal.mi
  if (tonalSf !== bestSf && tonalCost <= minCost + 2 * total * 0.001 + 2) {
    bestSf = tonalSf
  } else {
    // 采用代价最优 sf；主音信息仅在 info 层面修正为该 sf 框架内相关度最高者
    let bestInSf = { tonicPc: tonal.tonicPc, mi: tonal.mi, score: Number.NEGATIVE_INFINITY }
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const m of [0, 1] as const) {
        const sf = tonalitySf(tonic, m)
        if (sf !== bestSf) continue
        const rotated: number[] = []
        for (let i = 0; i < 12; i++) rotated.push(hist[(tonic + i) % 12])
        const score = pearson(rotated, m === 1 ? KS_MINOR : KS_MAJOR)
        if (score > bestInSf.score) bestInSf = { tonicPc: tonic, mi: m, score }
      }
    }
    tonicPc = bestInSf.tonicPc
    mi = bestInSf.mi
  }

  const baseCost = sigCost(hist, 0)
  const confidence = baseCost <= 0 ? 0 : Math.min(1, Math.max(0, (baseCost - minCost) / baseCost))
  return { sf: bestSf, mi, tonicPc, confidence }
}
