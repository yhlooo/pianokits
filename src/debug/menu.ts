import { el } from '../ui/dom'
import type { Tool } from '../tool'

/** 调试菜单句柄：供外壳（shell）同步“调试”按钮的激活态 */
export interface DebugMenuHandle {
  setActive(id: string | null): void
}

/**
 * 调试菜单：顶栏右侧“调试”按钮 + hover 下拉（列调试工具）。
 * 点击下拉项回调 onSelect，由外壳负责把该调试工具挂载到内容区（与正常工具一致）。
 * 依据设计文档 docs/development/design/20260905-debug-tools.md §4。
 */
export function attachDebugMenu(
  header: HTMLElement,
  tools: readonly Tool[],
  onSelect: (id: string) => void,
): DebugMenuHandle {
  const trigger = el('button', { class: 'debug-menu__trigger' }, '调试')
  const dropdown = el('div', { class: 'debug-menu__dropdown' })
  const menu = el('div', { class: 'debug-menu' }, trigger, dropdown)

  for (const tool of tools) {
    const item = el('button', { class: 'debug-menu__item', dataset: { id: tool.id } }, tool.name)
    item.addEventListener('click', () => {
      menu.classList.remove('is-open')
      onSelect(tool.id)
    })
    dropdown.append(item)
  }

  trigger.addEventListener('click', () => {
    menu.classList.toggle('is-open')
  })

  // 触控端无 hover：点击外部空白收起下拉（桌面 hover 由 CSS 控制，不受影响）
  document.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target as Node)) menu.classList.remove('is-open')
  })

  header.append(menu)

  return {
    setActive(id) {
      trigger.classList.toggle('is-active', id !== null)
    },
  }
}
