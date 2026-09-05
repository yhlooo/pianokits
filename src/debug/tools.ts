import type { Tool } from '../tool'

/**
 * 调试工具注册表：新调试工具在此登记，顶栏“调试”下拉自动出现对应项。
 * 调试工具复用主 Tool 接口，与正常工具一样挂载到内容区（一个工具一个页面）。
 */
export const debugTools: Tool[] = [
  {
    id: 'midi-keyboard',
    name: 'MIDI 键盘',
    async mount(host) {
      // 懒加载：仅在首次打开该调试工具时才拉取 Web MIDI 接入代码
      const { mountMidiKeyboard } = await import('./midi-keyboard')
      return mountMidiKeyboard(host)
    },
  },
]
