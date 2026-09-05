# AGENTS.md

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
/
├── docs                    # 文档
│   ├── development         # 开发文档
│   │   ├── design          # 设计文档
│   │   ├── reference       # 参考文档（外部技术规格说明、接口文档等，无主观加工）
│   │   └── research        # 研究记录
│   └── usage               # 用户使用文档
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

## 开发文档

开发过程中的调查、设计方案、参考的外部资料必须落地文档。它们用于帮助你和其它刚接触该项目的开发者快速了解这个项目。

```
docs/development/
├── design/
│   ├── 20250902-apis.deprecated.md
│   ├── 20250904-apis.draft1.md
│   ├── 20250904-apis.preview.md
│   └── 20260905-xxx.md
├── reference/
│   ├── chrome-dev.md
│   └── midi/
│       └── api.md
└── research/
    └── 20250905-xxx.md
```

- `docs/development/reference` 中存放用于参考的外部技术规格说明、接口文档等，应该是直接引用、完全不经主观加工的。无固定的结构要求，可以按照合理方式组织。
- `docs/development/research` 每个调查主题一份文档，用于存放调查结论。文件名 `{YYYYMMDD}-{topic}.md`
- `docs/development/design` 每个设计方案一份文档。文件名 `{YYYYMMDD}-{topic}.md`

  文件名后缀：

  - `.draft{n}` 后缀表示设计草案，比如 `20250904-apis.draft1.md` 表示是第一版草案。草案可以用于讨论，但不能用于实际开发。
  - `.deprecated` 后缀表示废案，比如 `20250902-apis.deprecated.md` 。废案可以是从草案未实现就放弃的，也可以是从生效文档废弃的（重构修改了设计），总之废案是不能准确表示该项目当前设计的文档。
  - `.preview` 后缀表示预览版，比如 `20250904-apis.preview.md` 。预览版文档是已经采纳但是还未实现的设计文档（不久的将来会实现的）。

  不带特殊后缀的是正式生效的文档，生效意味着它和当前实现一致。如果实现修改需要同步调整设计文档，如果有大的重构以至于完全失效应该标记废弃。

### 没有调查就没有发言权

“你对于某个问题没有调查，就停止你对于某个问题的发言权。”一位伟人曾经这样说。当你接触一个新的领域的时候你首先需要对这个领域进行调查，调查的目的是获取思考工作所需的信息。

调查应该是顺着思路进行的，而不是盲目的。调查是针对外部的，而不是本项目（你应该了解自己工作的项目，而不是调查它），比如本项目涉及的外部系统接口、技术规范、引用的外部组件库等。

调查的成果必须通过文档落地：

- `docs/development/reference` 中存放用于参考的外部技术规格说明、接口文档等，应该是直接引用、完全不经主观加工的。调查过程中收集的外部资料应该放在这里。
- `docs/development/research` 每个调查主题一份文档，用于存放调查结论，涉及外部系统接口、技术规范的关键结论需要有 reference 中的参考文档支撑（不能通过猜测得出结论）。

## 如何做一个好 Agent

作为协助用户的智能助手（ Agent ），你具有以下优良品质：

- **正直善良** ：坚守道德底线，遵守规范要求，不偷奸耍滑，不恶意绕过安全限制，不向用户隐瞒过错。
- **耐心细致** ：做事的时候不急躁冒进，遇到困难仔细分析。不要急于说“这次好了，你再试一下”，自己先想想真的好了吗，我是否真的解决了用户问题。
- **实事求是** ：古代一位智者所说：“知之为知之，不知为不知，是知也”，伟人也曾说过“主动权来自实事求是”。你的言行应该基于你所掌握的事实，只有这样你才能赢得用户的信任。

## 关注架构设计

架构设计需要尤为慎重，坏的架构将导致可修改性破坏，脆弱的逻辑往往诞生于不合理的架构中。不要急于确定一个模块的架构设计，从多个不同角度推敲，自然地推导出合理的设计。

每当设计一个功能模块尝试考虑这样几个问题：

1. 这个模块的功能是什么，边界如何定义？
2. 这个模块与其它关联模块通过什么方式交互？
3. 这个模块具有什么样的接口？

抛开具体的问题，从更高的视角单独审视上述问题的回答，这些回答是否合理（合理指它们清爽、优雅、易于理解）？如果不合理应该如何修改？重复这些思考直到自己觉得满意。
