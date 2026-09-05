import { el } from './ui/dom'
import { logoIcon } from './ui/icons'
import { tools } from './tools'

/**
 * 应用外壳：顶栏为工具页签（品牌 + 工具切换），下方为当前工具的内容区。
 * 同一时间只挂载一个工具；切换时先调用上一个工具的卸载函数释放资源。
 */
export function createShell(root: HTMLElement): void {
  const brand = el('span', { class: 'shell__brand' }, logoIcon(), 'PianoKits')
  brand.querySelector('svg')?.classList.add('shell__logo')
  const tabsEl = el('div', { class: 'shell__tabs' })
  const host = el('div', { class: 'shell__tool' })

  const buttons = new Map<string, HTMLButtonElement>()
  let activeId: string | null = null
  let unmount: (() => void) | null = null

  async function activate(id: string): Promise<void> {
    if (id === activeId) return
    unmount?.()
    unmount = null
    host.replaceChildren()
    activeId = id
    for (const [tid, btn] of buttons) {
      btn.classList.toggle('is-active', tid === id)
    }
    const tool = tools.find((t) => t.id === id)
    if (tool === undefined) return
    const cleanup = await tool.mount(host)
    unmount = cleanup
  }

  for (const tool of tools) {
    const btn = el('button', { class: 'shell__tab', dataset: { id: tool.id } }, tool.name)
    btn.addEventListener('click', () => {
      void activate(tool.id)
    })
    buttons.set(tool.id, btn)
    tabsEl.append(btn)
  }

  root.append(el('header', { class: 'shell' }, brand, tabsEl), host)

  const first = tools[0]
  if (first !== undefined) void activate(first.id)
}
