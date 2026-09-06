import { appBasePath, buildToolPath, consumeRedirectPath, parseToolRoute } from './router'
import { el } from './ui/dom'
import { logoIcon } from './ui/icons'
import type { Tool } from './tool'
import { tools } from './tools'

import type { DebugMenuHandle } from './debug/menu'

/** 已解析的工具及其来源（常规工具 / 调试工具） */
interface ResolvedTool {
  tool: Tool
  kind: 'regular' | 'debug'
}

/**
 * 应用外壳：顶栏为工具页签（品牌 + 工具切换），下方为当前工具的内容区。
 * 同一时间只挂载一个工具；切换时先调用上一个工具的卸载函数释放资源。
 * 每个工具页面拥有独立 URI（`/{工具 id}`，如 `/midi-player`、`/midi-keyboard`），
 * 切换/刷新通过 History API 保持页面；调试工具与常规工具在 URI 上不作区分。
 * 调试工具（经顶栏“调试”下拉进入）同样挂载到内容区，一个工具一个页面。
 */
export function createShell(root: HTMLElement): void {
  const basePath = appBasePath()
  const brand = el('span', { class: 'shell__brand' }, logoIcon(), 'PianoKits')
  brand.querySelector('svg')?.classList.add('shell__logo')
  const tabsEl = el('div', { class: 'shell__tabs' })
  const host = el('div', { class: 'shell__tool' })

  const buttons = new Map<string, HTMLButtonElement>()
  let unmount: (() => void) | null = null
  /** 当前激活的工具（常规或调试），无则 null */
  let active: { id: string; kind: 'regular' | 'debug' } | null = null
  /** 调试工具注册表：完成懒加载后填充 */
  let debugTools: Tool[] = []
  let debugMenu: DebugMenuHandle | null = null

  function clearMounted(): void {
    unmount?.()
    unmount = null
    host.replaceChildren()
  }

  function setTabActive(id: string | null): void {
    for (const [tid, btn] of buttons) {
      btn.classList.toggle('is-active', tid === id)
    }
  }

  /** 在常规与调试工具注册表中解析工具 */
  function resolveTool(id: string): ResolvedTool | null {
    const regular = tools.find((t) => t.id === id)
    if (regular !== undefined) return { tool: regular, kind: 'regular' }
    const debug = debugTools.find((t) => t.id === id)
    if (debug !== undefined) return { tool: debug, kind: 'debug' }
    return null
  }

  /** 挂载已解析的工具（常规与调试统一处理） */
  async function mountResolved(entry: ResolvedTool): Promise<void> {
    if (active !== null && active.id === entry.tool.id && active.kind === entry.kind) return
    clearMounted()
    active = { id: entry.tool.id, kind: entry.kind }
    setTabActive(entry.kind === 'regular' ? entry.tool.id : null)
    debugMenu?.setActive(entry.kind === 'debug' ? entry.tool.id : null)
    unmount = await entry.tool.mount(host)
  }

  /** 导航到工具：更新 URI（保留 query/hash）并挂载 */
  function navigateTo(id: string): void {
    const entry = resolveTool(id)
    if (entry === null) return
    const path = buildToolPath(id, basePath)
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path + window.location.search + window.location.hash)
    }
    void mountResolved(entry)
  }

  /** 依据当前 URI 挂载工具；correctUrl 为真时对无/未知路由校正 URL（仅初始加载用） */
  async function routeFromLocation(correctUrl: boolean): Promise<void> {
    const id = parseToolRoute(window.location.pathname, basePath)
    const entry = id !== null ? resolveTool(id) : null
    if (entry !== null) {
      await mountResolved(entry)
      return
    }
    const fallback = tools[0]
    if (fallback === undefined) return
    if (correctUrl) {
      window.history.replaceState(
        null,
        '',
        buildToolPath(fallback.id, basePath) + window.location.search + window.location.hash,
      )
    }
    await mountResolved({ tool: fallback, kind: 'regular' })
  }

  for (const tool of tools) {
    const btn = el('button', { class: 'shell__tab', dataset: { id: tool.id } }, tool.name)
    btn.addEventListener('click', () => navigateTo(tool.id))
    buttons.set(tool.id, btn)
    tabsEl.append(btn)
  }

  const header = el('header', { class: 'shell' }, brand, tabsEl)
  root.append(header, host)

  // 浏览器前进/后退：按新 URI 挂载对应工具
  window.addEventListener('popstate', () => {
    void routeFromLocation(false)
  })

  async function bootstrap(): Promise<void> {
    // GitHub Pages 404 回退：先把暂存的路径恢复到地址栏，再据此路由
    consumeRedirectPath()
    // 调试菜单：懒加载菜单与调试工具代码后挂载到顶栏
    const [{ attachDebugMenu }, { debugTools: dt }] = await Promise.all([
      import('./debug/menu'),
      import('./debug/tools'),
    ])
    debugTools = dt
    debugMenu = attachDebugMenu(header, dt, (id) => navigateTo(id))
    await routeFromLocation(true)
  }

  void bootstrap()
}
