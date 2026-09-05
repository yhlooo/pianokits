import type { Tool } from './tool'

/** 工具注册表：新工具在此登记，外壳顶栏自动出现对应页签 */
export const tools: Tool[] = [
  {
    id: 'midi-player',
    name: 'MIDI 播放器',
    async mount(host) {
      // 懒加载：工具首次激活时才拉取该工具的代码（smplr/VexFlow 等）
      const { createApp } = await import('./app')
      return await createApp(host)
    },
  },
]
