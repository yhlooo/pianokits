import { isDebugEnabled } from './debug/flag'
import { el } from './ui/dom'
import { logoIcon } from './ui/icons'
import type { Tool } from './tool'
import { tools } from './tools'

import type { DebugMenuHandle } from './debug/menu'

/**
 * 应用外壳：顶栏为工具页签（品牌 + 工具切换），下方为当前工具的内容区。
 * 同一时间只挂载一个工具；切换时先调用上一个工具的卸载函数释放资源。
 * 调试工具（?debug=1 时经“调试”下拉进入）同样挂载到内容区，一个工具一个页面。
 */
export function createShell(root: HTMLElement): void {
  const brand = el('span', { class: 'shell__brand' }, logoIcon(), 'PianoKits')
  brand.querySelector('svg')?.classList.add('shell__logo')
  const tabsEl = el('div', { class: 'shell__tabs' })
  const host = el('div', { class: 'shell__tool' })

  const buttons = new Map<string, HTMLButtonElement>()
  let unmount: (() => void) | null = null
  /** 当前激活的常规工具 id（调试工具激活时为 null） */
  let activeId: string | null = null
  /** 当前激活的调试工具 id（常规工具激活时为 null） */
  let activeDebugId: string | null = null
  let debugMenu: DebugMenuHandle | null = null

  function clearMounted(): void {
    unmount?.()
    unmount = null
    host.replaceChildren()
  }

  function setToolActive(id: string | null): void {
    for (const [tid, btn] of buttons) {
      btn.classList.toggle('is-active', tid === id)
    }
  }

  /** 挂载常规工具（顶栏页签） */
  async function mountTool(id: string): Promise<void> {
    if (id === activeId) return
    const tool = tools.find((t) => t.id === id)
    if (tool === undefined) return
    clearMounted()
    activeId = id
    activeDebugId = null
    setToolActive(id)
    debugMenu?.setActive(null)
    unmount = await tool.mount(host)
  }

  /** 挂载调试工具（经“调试”下拉进入，与常规工具共用内容区） */
  async function mountDebugTool(tool: Tool): Promise<void> {
    if (tool.id === activeDebugId) return
    clearMounted()
    activeId = null
    activeDebugId = tool.id
    setToolActive(null)
    debugMenu?.setActive(tool.id)
    unmount = await tool.mount(host)
  }

  for (const tool of tools) {
    const btn = el('button', { class: 'shell__tab', dataset: { id: tool.id } }, tool.name)
    btn.addEventListener('click', () => {
      void mountTool(tool.id)
    })
    buttons.set(tool.id, btn)
    tabsEl.append(btn)
  }

  const header = el('header', { class: 'shell' }, brand, tabsEl)
  root.append(header, host)

  // 调试菜单：仅当 URL 含 ?debug=1 时懒加载菜单与调试工具代码
  if (isDebugEnabled()) {
    void Promise.all([import('./debug/menu'), import('./debug/tools')]).then(
      ([{ attachDebugMenu }, { debugTools }]) => {
        debugMenu = attachDebugMenu(header, debugTools, (id) => {
          const tool = debugTools.find((t) => t.id === id)
          if (tool !== undefined) void mountDebugTool(tool)
        })
      },
    )
  }

  const first = tools[0]
  if (first !== undefined) void mountTool(first.id)
}
