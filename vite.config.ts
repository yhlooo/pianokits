import { defineConfig } from 'vite'

export default defineConfig({
  // 使用相对路径作为资源 base，保证部署到 GitHub Pages（项目子路径）后资源仍可加载
  base: './',
  server: {
    // 绑定 0.0.0.0：devcontainer 端口转发依赖 IPv4 环回可达
    host: true,
  },
  preview: {
    host: true,
  },
})
