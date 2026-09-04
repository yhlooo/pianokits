import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // 绑定 0.0.0.0：devcontainer 端口转发依赖 IPv4 环回可达
    host: true,
  },
  preview: {
    host: true,
  },
})
