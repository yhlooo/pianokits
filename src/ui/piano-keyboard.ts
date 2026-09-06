import { el } from './dom'

/**
 * 88 键钢琴键盘 DOM 组件（A0–C8），「MIDI 键盘」调试页与瀑布流共用。
 *
 * 几何（两页同一套比例，设计文档 20260905-ui-visual-style.md §3.4/§6.4）：
 * - 键盘高度 = 总宽度 × 0.122（KEYBOARD_H_RATIO）；宽度变化（拉伸窗口/缩放）时
 *   高度同步按比例改变——调试页由 CSS aspect-ratio 随宽度自适应，瀑布流由宿主在
 *   resize 时按同比例设置高度；
 * - 52 根白键由 flex 排列，白键之间 1px 键缝（border-right，无亚像素间隙）；
 * - 黑键宽 = 白键宽 × 1.3/2.3、高 = 键盘高 × 2/3；横向占位按组外扩（非全部居中）——
 *   C# 2/3 落在左白键上、D# 2/3 落在右白键上、F# 3/4 落在左白键上、
 *   G# 居中、A# 3/4 落在右白键上；
 * - 圆角与宽度成固定比例（键盘圆角 = 白键宽 × 0.5、黑键底角 = 黑键宽 × 1/4，
 *   随宽度/缩放等比变化），黑键底部另有常态投影。
 *
 * `keyGeometry(totalWidth, pitch)` 把上述几何公式（与 CSS 逐项对应）暴露为纯函数：
 * 瀑布流画布用它画音符条与音区参考线，保证画布内容与底部 DOM 键盘严格对齐。
 *
 * 点亮态有两种：
 * - `setPressed`：简单的“按下”态（琥珀渐变 class），调试页用；
 * - `setLit`：逐键点亮样式（颜色 / 强度 / 光晕），瀑布流用——点亮色按 alpha
 *   混合到键的基础渐变上（等效于画布时代的同色半透明覆盖），逐帧调用即可驱动
 *   释放渐隐；此时禁用该键的 CSS 过渡，避免与逐帧 alpha 打架。
 */

/** 键盘高度 = 总宽度 × 0.122（两页共用同一比例） */
export const KEYBOARD_H_RATIO = 0.122

export const MIN_PITCH = 21 // A0
export const MAX_PITCH = 108 // C8
export const BLACK_PCS = new Set([1, 3, 6, 8, 10])
export const WHITE_INDEX = new Map<number, number>()

const WHITE_PITCHES: number[] = []
const BLACK_PITCHES: number[] = []
for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
  if (BLACK_PCS.has(p % 12)) BLACK_PITCHES.push(p)
  else {
    WHITE_INDEX.set(p, WHITE_PITCHES.length)
    WHITE_PITCHES.push(p)
  }
}

type Rgb = readonly [number, number, number]

/**
 * 黑键横向占位比例：黑键落在左白键上的宽度占比（[分子, 分母]）。
 * C# 2/3、D# 1/3（2/3 在右）、F# 3/4、G# 1/2（居中）、A# 1/4（3/4 在右）——
 * DOM 黑键的 CSS 定位与 keyGeometry 共用本常量，保证两处公式一致。
 */
const BLACK_LEFT_FRAC: Readonly<Record<number, readonly [number, number]>> = {
  1: [2, 3],
  3: [1, 3],
  6: [3, 4],
  8: [1, 2],
  10: [1, 4],
}

/** 黑键宽 = 白键宽 × 1.3/2.3（与 .piano 的 CSS --bkey-w 同一比例） */
export const BLACK_KEY_WIDTH_RATIO = 1.3 / 2.3

export interface KeyGeom {
  /** 键左边缘距键盘左边缘的距离（CSS px） */
  left: number
  /** 键宽（CSS px） */
  width: number
}

/**
 * 由键盘总宽度计算某音高的键位几何（相对键盘左边缘）。
 * 公式与 .piano 的 CSS 逐项对应：
 * - 白键：白键宽 = 总宽度 / 52，left = 白键宽 × 白键序；
 * - 黑键：宽 = 白键宽 × 1.3/2.3，left = 白键宽 × (左白键序 + 1) − 黑键宽 × leftFrac
 *   （横向占位按组外扩，非全部居中）。
 * 瀑布流画布用它画音符条与音区参考线 → 与底部 DOM 键盘严格对齐，靠近边缘也不漂移。
 * pitch 必须在 [MIN_PITCH, MAX_PITCH] 内，否则抛 RangeError。
 */
export function keyGeometry(totalWidth: number, pitch: number): KeyGeom {
  if (pitch < MIN_PITCH || pitch > MAX_PITCH) {
    throw new RangeError(`pitch ${pitch} 超出 88 键范围 ${MIN_PITCH}–${MAX_PITCH}`)
  }
  const keyW = totalWidth / WHITE_PITCHES.length
  const pc = pitch % 12
  if (!BLACK_PCS.has(pc)) {
    const i = WHITE_INDEX.get(pitch)
    // 不可达：范围内白键必有白键序（仅防御性兜底）
    if (i === undefined) throw new RangeError(`pitch ${pitch} 无白键序`)
    return { left: keyW * i, width: keyW }
  }
  const frac = BLACK_LEFT_FRAC[pc]
  // 不可达：BLACK_PCS 与 BLACK_LEFT_FRAC 的键集合一致（仅防御性兜底）
  if (frac === undefined) throw new RangeError(`pitch ${pitch} 无黑键占位比例`)
  const i = WHITE_INDEX.get(pitch - 1)
  // 不可达：黑键必有左邻白键（最低音 A0 即白键，仅防御性兜底）
  if (i === undefined) throw new RangeError(`pitch ${pitch} 无左邻白键`)
  return {
    left: keyW * (i + 1) - keyW * BLACK_KEY_WIDTH_RATIO * (frac[0] / frac[1]),
    width: keyW * BLACK_KEY_WIDTH_RATIO,
  }
}

/** 白键基础渐变（顶→底），点亮色按 alpha 混合到其上 */
const WHITE_BASE: readonly [Rgb, Rgb] = [
  [244, 241, 235], // #f4f1eb
  [227, 223, 215], // #e3dfd7
]
/** 黑键基础渐变（顶→底） */
const BLACK_BASE: readonly [Rgb, Rgb] = [
  [42, 40, 37], // #2a2825
  [20, 19, 18], // #141312
]
/** 黑键常态投影（点亮时追加在光晕之后，保持黑键的立体感） */
const BLACK_KEY_SHADOW = '0 1px 2px rgba(0, 0, 0, 0.6)'

/** c 以不透明度 a 叠在 base 上（线性混合），返回 CSS 颜色 */
function mix(c: Rgb, base: Rgb, a: number): string {
  return `rgb(${Math.round(base[0] + (c[0] - base[0]) * a)},${Math.round(
    base[1] + (c[1] - base[1]) * a,
  )},${Math.round(base[2] + (c[2] - base[2]) * a)})`
}

function rgba(c: Rgb, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}

export interface PianoLit {
  /** 点亮色（RGB 三元组，0~255） */
  color: Rgb
  /** 点亮强度 0~1（释放渐隐时逐帧递减），默认 1 */
  alpha?: number
  /** 外发光强度 0~1（0 = 无光晕，光晕颜色同 color），默认 0 */
  glow?: number
}

export interface PianoView {
  el: HTMLElement
  /** 按下态（琥珀点亮）：Map 之外的键恢复常态 */
  setPressed(pitches: readonly number[]): void
  /** 逐键点亮态：Map 之外的键恢复常态 */
  setLit(lit: ReadonlyMap<number, PianoLit>): void
}

export function buildPiano(): PianoView {
  const whites = el('div', { class: 'piano__whites' })
  const blacks = el('div', { class: 'piano__blacks' })
  const keyByPitch = new Map<number, HTMLElement>()
  const isBlack = new Set<number>()

  for (const p of WHITE_PITCHES) {
    const i = WHITE_INDEX.get(p) ?? 0
    // 左边缘与黑键定位共用同一坐标公式（var(--key-w) × 白键序），
    // 避免 flex 布局的亚像素累积取整让黑键相对白键分界线产生漂移
    const key = el('div', {
      class: 'piano__wkey',
      dataset: { pitch: p },
      style: { left: `calc(var(--key-w) * ${i})` },
    })
    keyByPitch.set(p, key)
    whites.append(key)
  }
  for (const p of BLACK_PITCHES) {
    isBlack.add(p)
    const i = WHITE_INDEX.get(p - 1) ?? 0
    // 黑键宽 = 白键宽 × 1.3/2.3（CSS --bkey-w）；横向占位按组外扩（非全部居中）：
    // leftFrac = 黑键落在左白键上的宽度占比（与 keyGeometry 共用 BLACK_LEFT_FRAC）
    const frac = BLACK_LEFT_FRAC[p % 12]
    // 左边缘 = 左白键右边界（分界线）− leftFrac × 黑键宽
    const left = `calc(var(--key-w) * ${i + 1} - var(--bkey-w) * (${frac[0]} / ${frac[1]}))`
    const key = el('div', { class: 'piano__bkey', dataset: { pitch: p }, style: { left } })
    keyByPitch.set(p, key)
    blacks.append(key)
  }

  let prevPressed = new Set<number>()
  return {
    el: el('div', { class: 'piano' }, whites, blacks),
    setPressed(pitches) {
      const next = new Set(pitches)
      for (const p of prevPressed)
        if (!next.has(p)) keyByPitch.get(p)?.classList.remove('is-pressed')
      for (const p of next) if (!prevPressed.has(p)) keyByPitch.get(p)?.classList.add('is-pressed')
      prevPressed = next
    },
    setLit(lit) {
      for (const [p, key] of keyByPitch) {
        const s = lit.get(p)
        if (s === undefined) {
          key.style.removeProperty('background')
          key.style.removeProperty('box-shadow')
          key.style.transition = ''
          continue
        }
        const a = Math.max(0, Math.min(1, s.alpha ?? 1))
        const base = isBlack.has(p) ? BLACK_BASE : WHITE_BASE
        key.style.background = `linear-gradient(${mix(s.color, base[0], a)}, ${mix(
          s.color,
          base[1],
          a,
        )})`
        const shadows: string[] = []
        if ((s.glow ?? 0) > 0) shadows.push(`0 0 10px ${rgba(s.color, (s.glow ?? 0) * a)}`)
        if (isBlack.has(p)) shadows.push(BLACK_KEY_SHADOW)
        key.style.boxShadow = shadows.join(', ')
        // 点亮由逐帧 setLit 驱动（渐隐），不走 CSS 过渡
        key.style.transition = 'none'
      }
    },
  }
}
