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

/** 音量（描边：喇叭 + 声波） */
export const volumeIcon = (): SVGSVGElement =>
  svg([
    'M4 8.2v3.6h2.6L10 14.6V5.4L6.6 8.2H4Z',
    'M12.2 7.2a4 4 0 0 1 0 5.6',
    'M14.2 5.2a6.8 6.8 0 0 1 0 9.6',
  ])

/** 导入（描边：加号） */
export const plusIcon = (): SVGSVGElement => svg(['M10 4.5v11M4.5 10h11'])

/** 重新导入（描边：回转箭头） */
export const refreshIcon = (): SVGSVGElement =>
  svg(['M15.8 10a5.8 5.8 0 1 1-1.7-4.1', 'M15.9 3.4v2.7h-2.7'])

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
  // 白键：三枚描边圆角键
  for (const x of [3.5, 7.5, 11.5]) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', '6.5')
    r.setAttribute('width', '4')
    r.setAttribute('height', '9.5')
    r.setAttribute('rx', '1')
    r.setAttribute('fill', 'none')
    r.setAttribute('stroke', 'currentColor')
    r.setAttribute('stroke-width', '1.5')
    r.setAttribute('stroke-linejoin', 'round')
    el.append(r)
  }
  // 黑键：两枚实心短键，落在白键接缝上
  for (const x of [6.4, 10.4]) {
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', String(x))
    r.setAttribute('y', '6.5')
    r.setAttribute('width', '2.2')
    r.setAttribute('height', '6')
    r.setAttribute('rx', '0.8')
    r.setAttribute('fill', 'currentColor')
    el.append(r)
  }
  return el
}

/** 练习模式（靶心：外环 + 内环 + 四向刻度） */
export const practiceIcon = (): SVGSVGElement =>
  svg([
    'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0',
    'M7 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
    'M10 1.5v2.5M10 16v2.5M1.5 10h2.5M16 10h2.5',
  ])

/** 连接等待（约 270° 圆弧，配合 CSS 旋转动画使用） */
export const spinnerIcon = (): SVGSVGElement => svg(['M10 3a7 7 0 1 1 -7 7'])

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
