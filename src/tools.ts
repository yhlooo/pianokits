import type { Tool } from './tool'

/** 工具注册表：新工具在此登记，外壳顶栏自动出现对应页签 */
export const tools: Tool[] = [
  {
    // id 即 URI 段（/midi-player）：顶栏名称改为「播放 / 练习」后路径保持不变
    id: 'midi-player',
    name: '播放 / 练习',
    async mount(host) {
      // 懒加载：工具首次激活时才拉取该工具的代码（smplr/VexFlow 等）
      const { createApp } = await import('./app')
      return await createApp(host)
    },
  },
  {
    id: 'midi-recorder',
    name: '录音',
    async mount(host) {
      const { createRecorderApp } = await import('./recorder-app')
      return createRecorderApp(host)
    },
  },
]
