/**
 * 内联 SVG 图标集（视觉风格指南 §5）：20×20 视窗、1.5px 描边、圆角线帽、
 * 单色 currentColor；播放/暂停/停止用实心字形，其余用描边。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg(paths: string[], filled = false, size = 20): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('width', String(size))
  el.setAttribute('height', String(size))
  el.setAttribute('viewBox', '0 0 20 20')
  el.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    if (filled) {
      p.setAttribute('fill', 'currentColor')
    } else {
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', 'currentColor')
      p.setAttribute('stroke-width', '1.5')
      p.setAttribute('stroke-linecap', 'round')
      p.setAttribute('stroke-linejoin', 'round')
    }
    el.append(p)
  }
  return el
}

/** 品牌 logo：乌木底 + 象牙键（呼应 favicon） */
export function logoIcon(size = 22): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('width', String(size))
  el.setAttribute('height', String(size))
  el.setAttribute('viewBox', '0 0 64 64')
  el.setAttribute('aria-hidden', 'true')
  const bg = document.createElementNS(SVG_NS, 'rect')
  bg.setAttribute('width', '64')
  bg.setAttribute('height', '64')
  bg.setAttribute('rx', '14')
  bg.setAttribute('fill', 'currentColor')
  bg.setAttribute('opacity', '0.16')
  el.append(bg)
  const whites = [8, 20, 32, 44]
  for (const x of whites) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', '12')
    r.setAttribute('width', '10')
    r.setAttribute('height', '40')
    r.setAttribute('rx', '2')
    r.setAttribute('fill', 'currentColor')
    el.append(r)
  }
  const blacks = [14.5, 26.5, 50.5]
  for (const x of blacks) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', '12')
    r.setAttribute('width', '5')
    r.setAttribute('height', '24')
    r.setAttribute('rx', '1')
    r.setAttribute('fill', 'var(--bg-0)')
    el.append(r)
  }
  return el
}

/** 播放（实心，光学居中右移 0.5） */
export const playIcon = (): SVGSVGElement =>
  svg(['M7 4.8v10.4c0 .8.9 1.3 1.6.9l8-5.2c.6-.4.6-1.4 0-1.8l-8-5.2C7.9 3.5 7 4 7 4.8Z'], true)

/** 暂停（实心） */
export const pauseIcon = (): SVGSVGElement => svg(['M6 4.5h2.6v11H6zM11.4 4.5H14v11h-2.6z'], true)

/** 停止（实心圆角方块） */
export const stopIcon = (): SVGSVGElement =>
  svg(
    [
      'M6.8 5h6.4c1 0 1.8.8 1.8 1.8v6.4c0 1-.8 1.8-1.8 1.8H6.8c-1 0-1.8-.8-1.8-1.8V6.8C5 5.8 5.8 5 6.8 5Z',
    ],
    true,
  )

/** 视觉占比偏小的图标：按视窗中心整体放大几何、保持 1.5px 描边不变 */
function scaleIcon(icon: SVGSVGElement, scale: number): SVGSVGElement {
  const g = document.createElementNS(SVG_NS, 'g')
  g.setAttribute('transform', `translate(10 10) scale(${scale}) translate(-10 -10)`)
  for (const path of Array.from(icon.children)) {
    path.setAttribute('vector-effect', 'non-scaling-stroke')
    g.append(path)
  }
  icon.append(g)
  return icon
}

/** 音量（描边：喇叭 + 声波） */
export const volumeIcon = (): SVGSVGElement =>
  scaleIcon(
    svg([
      'M4 8.2v3.6h2.6L10 14.6V5.4L6.6 8.2H4Z',
      'M12.2 7.2a4 4 0 0 1 0 5.6',
      'M14.2 5.2a6.8 6.8 0 0 1 0 9.6',
    ]),
    1.2,
  )

/** 静音（描边：喇叭 + ×） */
export const volumeMutedIcon = (): SVGSVGElement =>
  scaleIcon(
    svg(['M4 8.2v3.6h2.6L10 14.6V5.4L6.6 8.2H4Z', 'M12.6 7.4l4.4 4.4M17 7.4l-4.4 4.4']),
    1.2,
  )

/** 导入（描边：加号） */
export const plusIcon = (): SVGSVGElement => svg(['M10 4.5v11M4.5 10h11'])

/** 关闭/删除（描边：×） */
export const xIcon = (): SVGSVGElement => svg(['M5.5 5.5l9 9M14.5 5.5l-9 9'])

/** 侧栏切换（类似 FontAwesome sidebar：面板轮廓 + 左侧窄栏分隔线）；折叠/展开共用同一图标 */
export const sidebarIcon = (): SVGSVGElement => svg(['M2.5 3.5h15v13h-15z', 'M7 3.5v13'])

/** MIDI 键盘连接（描边白键 + 实心黑键，呼应品牌琴键元素） */
export function midiKeyboardIcon(): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('width', '20')
  el.setAttribute('height', '20')
  el.setAttribute('viewBox', '0 0 20 20')
  el.setAttribute('aria-hidden', 'true')
  // 白键：三枚描边圆角键，铺满画布主体（与其它 20×20 图标同一视觉占比）
  for (const x of [2.75, 7.25, 11.75]) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', '3')
    r.setAttribute('width', '4.5')
    r.setAttribute('height', '13.5')
    r.setAttribute('rx', '1.2')
    r.setAttribute('fill', 'none')
    r.setAttribute('stroke', 'currentColor')
    r.setAttribute('stroke-width', '1.5')
    r.setAttribute('stroke-linejoin', 'round')
    el.append(r)
  }
  // 黑键：两枚实心短键，落在白键接缝上
  for (const x of [6, 10.5]) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', '3')
    r.setAttribute('width', '2.5')
    r.setAttribute('height', '8')
    r.setAttribute('rx', '0.9')
    r.setAttribute('fill', 'currentColor')
    el.append(r)
  }
  return el
}

/** 练习模式（打开的书：左右两页在书脊处相接） */
export const practiceIcon = (): SVGSVGElement =>
  svg([
    'M1.5 2.5h5.5a4 4 0 0 1 4 4V17a3 3 0 0 0-3-3H1.5z',
    'M18.5 2.5H13a4 4 0 0 0-4 4V17a3 3 0 0 1 3-3h6.5z',
  ])

/** 连接等待（约 270° 圆弧，配合 CSS 旋转动画使用） */
export const spinnerIcon = (): SVGSVGElement => svg(['M10 3a7 7 0 1 1 -7 7'])

/** 瀑布流（三根自左上向右下坠落的音符条，实心） */
export function waterfallIcon(): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('width', '20')
  el.setAttribute('height', '20')
  el.setAttribute('viewBox', '0 0 20 20')
  el.setAttribute('aria-hidden', 'true')
  const bars: Array<[number, number]> = [
    [3.5, 2.5],
    [8.5, 6.5],
    [13.5, 10.5],
  ]
  for (const [x, y] of bars) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', String(y))
    r.setAttribute('width', '3')
    r.setAttribute('height', '6')
    r.setAttribute('rx', '1.5')
    r.setAttribute('fill', 'currentColor')
    el.append(r)
  }
  return el
}

/** 乐谱（五线谱，描边） */
export const scoreIcon = (): SVGSVGElement =>
  svg(['M3 4.5h14', 'M3 7.5h14', 'M3 10.5h14', 'M3 13.5h14', 'M3 16.5h14'])

/** 展开/收起三角：向下（默认折叠态，点击展开） */
export const chevronDownIcon = (): SVGSVGElement => svg(['M5 8l5 5 5-5'])

/** 展开/收起三角：向上（展开态，点击收起） */
export const chevronUpIcon = (): SVGSVGElement => svg(['M5 12l5-5 5 5'])

/** 空状态装饰：一排琴键剪影（64×24 视窗，currentColor 平涂） */
export function keysArtIcon(): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('width', '72')
  el.setAttribute('height', '30')
  el.setAttribute('viewBox', '0 0 72 30')
  el.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 8; i++) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(i * 9 + 0.5))
    r.setAttribute('y', '0.5')
    r.setAttribute('width', '8')
    r.setAttribute('height', '29')
    r.setAttribute('rx', '1.5')
    r.setAttribute('fill', 'none')
    r.setAttribute('stroke', 'currentColor')
    el.append(r)
  }
  for (const i of [0, 1, 3, 4, 5]) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(i * 9 + 6))
    r.setAttribute('y', '0.5')
    r.setAttribute('width', '5.5')
    r.setAttribute('height', '17')
    r.setAttribute('rx', '1')
    r.setAttribute('fill', 'currentColor')
    el.append(r)
  }
  return el
}
