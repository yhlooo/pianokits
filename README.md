# PianoKits

TypeScript 纯 Web 应用，基于 **Vite + TypeScript** 构建。

## 环境要求

- Node.js `^22.13.0 || >=24`（devcontainer 使用 24 LTS）
- pnpm 11（已包含在 devcontainer 镜像中）

## 快速开始

```sh
pnpm install      # 安装依赖
pnpm dev          # 启动开发服务器（HMR 热更新）
```

开发服务器默认运行在 **http://localhost:5173**（devcontainer 已配置端口转发，会自动打开浏览器）。

## 常用命令

| 命令                | 说明                                      |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | 启动开发服务器（HMR）                     |
| `pnpm build`        | 类型检查（tsc）并构建生产产物到 `dist/`   |
| `pnpm preview`      | 本地预览构建产物（http://localhost:4173） |
| `pnpm typecheck`    | 仅运行 TypeScript 类型检查                |
| `pnpm lint`         | ESLint 检查（含类型感知规则）             |
| `pnpm format`       | Prettier 格式化全部文件                   |
| `pnpm format:check` | 检查格式是否合规（CI 用）                 |

## 技术栈

- [Vite 8](https://vite.dev/) — 构建工具与开发服务器
- [TypeScript 6](https://www.typescriptlang.org/) — 严格模式（`strict` + 额外的类型检查开关）
- [ESLint 10](https://eslint.org/) + [typescript-eslint](https://typescript-eslint.io/) — 类型感知的代码检查
- [Prettier 3](https://prettier.io/) — 代码格式化
- pnpm 11 — 包管理器

## 项目结构

```
pianokits/
├── index.html              # 入口 HTML
├── public/                 # 静态资源（原样拷贝到构建产物）
│   └── favicon.svg
├── src/                    # 应用源码
│   ├── main.ts             # 入口脚本
│   └── style.css           # 全局样式
├── eslint.config.js        # ESLint 扁平配置（类型感知）
├── tsconfig.json           # TypeScript 项目引用入口
├── tsconfig.app.json       # 应用代码编译配置（DOM）
├── tsconfig.node.json      # 构建工具链编译配置（Node）
└── vite.config.ts          # Vite 配置（dev/preview 绑定 0.0.0.0 以支持端口转发）
```
