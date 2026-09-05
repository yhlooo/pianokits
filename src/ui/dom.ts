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
