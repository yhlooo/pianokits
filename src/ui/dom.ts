/** 极简 DOM 构造工具 */

type Child = Node | string | null | undefined

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') {
      node.className = value as string
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value as Record<string, string>)
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'style' && typeof value === 'object' && value !== null) {
      Object.assign(node.style, value as Record<string, string>)
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(child)
  }
  return node
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

/**
 * 计时器时钟 `mm:ss.ff`（秒带两位小数；分补零到 2 位，不折算成小时——超过 60 分钟继续累加：
 * `99:23.45`、`102:23.45`）。以百分秒为单位向下取整，避免四舍五入出现 `00:60.00` 这种进位。
 * 与 `formatTime` 的区别：播放器进度条沿用后者（`0:12`，整秒），录音计时器用本函数（`00:12.34`）。
 */
export function formatClock(seconds: number): string {
  const hundredths = Math.floor(Math.max(0, seconds) * 100)
  const mm = Math.floor(hundredths / 6000)
  const rest = hundredths % 6000
  const ss = Math.floor(rest / 100)
  const ff = rest % 100
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(mm)}:${pad(ss)}.${pad(ff)}`
}

/** 文件时间戳 `yyyyMMdd-hhmmss`（本地时间；下载/保存的默认文件名用） */
export function formatFileStamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}
