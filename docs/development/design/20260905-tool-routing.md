# 设计：工具路由（每工具独立 URI）

- 日期：2026-09-05
- 状态：**正式生效（与实现一致）**。2026-09-05 初版实现；同日移除 `?debug=1` 调试开关（调试工具始终加载）。
- 关联设计：`20260905-debug-tools.md`（调试工具复用同一路由机制）、`20260905-midi-import-player.md`（工具外壳）。

## 1. 目标与范围

### 1.1 目标

外壳此前用内存状态切换工具：切换只在点击页签/下拉项时发生，URL 不变，因此刷新后总是回到
首个工具。本设计给每个工具页面一个独立 URI（路径），使：

- 每个工具对应一个稳定的路径（如 MIDI 播放器 `/midi-player`、MIDI 键盘 `/midi-keyboard`）；
- 刷新、浏览器前进/后退、直接打开（深链接）都能保持/恢复对应页面；
- 调试工具与常规工具在 URI 上**不作区分**（都是 `/{工具 id}`，无 `/debug/` 前缀之类）。

### 1.2 非目标

- 不做服务端路由 / 多入口 HTML（仍是单页应用，路径由前端 History API 管理）。
- 不做工具内子路由（工具内部状态不进入 URL，例如播放器的分屏/瀑布流/谱面视图切换仍走内存 store）。

### 1.3 验收标准（可测试）

- 访问 `/` 会校正 URL 为 `/midi-player` 并挂载 MIDI 播放器。
- 访问 `/midi-player` 挂载 MIDI 播放器；刷新后仍在同一页面。
- 访问 `/midi-keyboard` 挂载 MIDI 键盘；刷新后仍在 MIDI 键盘页。
- 点击页签/调试下拉项会更新地址栏路径，同时**保留** query 与 hash。
- 浏览器后退/前进按历史路径切换工具。
- 未知路径访问时，回退到首个常规工具并校正 URL。
- 部署到 GitHub Pages 子路径后，深链接刷新（如 `/pianokits/midi-player`）仍能恢复到对应页面。

## 2. 关键技术决策

| #   | 环节          | 决策                                                                                 | 理由                                                                             |
| --- | ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | 路由形态      | History API 路径路由（`pushState`/`replaceState` + `popstate`），路径即 `/{工具 id}` | 用户要求「每个页面一个 URI」且刷新可保持；无需引入路由库（工具数量少，自研足够） |
| 2   | 路径来源      | 复用 `Tool.id` 作为路径段（`midi-player`、`midi-keyboard`），不新增独立 path 字段    | id 本就稳定且唯一，避免两套标识不同步                                            |
| 3   | 调试/常规区分 | URI 不区分；调试工具始终加载（不再有 `?debug=1` 开关）                               | 满足「URI 上不区分调试与普通工具」；调试工具不再需要 query 开关                  |
| 4   | query 处理    | 切换工具只改 pathname，**保留** `search`（query）与 `hash`                           | 保留用户带入的 query/hash，切换工具时不丢失                                      |
| 5   | 基路径        | 运行时由入口模块位置推导应用基路径（`new URL('..', import.meta.url)`）               | `base: './'` 部署到 GitHub Pages 子路径后，pathname 含子路径前缀，路由需先剔除   |
| 6   | GH Pages 深链 | `public/404.html` 把目标路径暂存 sessionStorage 后跳回应用根，由路由器恢复           | GH Pages 无服务端重写，深链接 404 时用 404 回退页兜底，使刷新在部署环境同样可用  |

## 3. 总体架构

```
main.ts ── createShell(root)
  └─ shell.ts（路由器 + 外壳）
       ├─ 启动：consumeRedirectPath() → 懒加载调试工具 → routeFromLocation(true)
       ├─ 页签点击 / 调试下拉点击 → navigateTo(id) → pushState(新路径) + 挂载
       └─ popstate → routeFromLocation(false) → 按当前路径挂载
  router.ts（纯路径逻辑，可单测）
       ├─ appBasePath()            应用基路径（/ 结尾）
       ├─ parseToolRoute(path, base)   pathname → 工具 id | null
       ├─ buildToolPath(id, base)   工具 id → 完整路径
       └─ consumeRedirectPath()    读取 404 回退暂存的路径并恢复
```

- 外壳仍通过 `Tool.mount(host)` 挂载/卸载，路由只决定「挂哪个」，不改变工具的挂载契约。
- 常规工具（`src/tools.ts`）与调试工具（`src/debug/tools.ts`）合并解析：
  `resolveTool(id)` 先查常规注册表，再查调试注册表。

## 4. 接口

```ts
// src/router.ts
export function appBasePath(): string
export function parseToolRoute(pathname: string, basePath: string): string | null
export function buildToolPath(id: string, basePath: string): string
export function consumeRedirectPath(): void
```

`parseToolRoute` / `buildToolPath` 为纯函数（基路径作参数），可脱离 DOM 单测；`appBasePath` /
`consumeRedirectPath` 触碰 `import.meta.url` / `sessionStorage` / `history`，仅由外壳在启动期调用。

## 5. 与调试工具的边界

- 调试工具与常规工具共用 `resolveTool` 与 `mountResolved`，路径同为 `/{id}`；激活态渲染仍按来源
  区分（常规工具点亮页签、调试工具点亮「调试」按钮）。
- 调试工具代码随外壳启动即被 import，访问 `/midi-keyboard` 直接挂载 MIDI 键盘（不再依赖 `?debug=1`）。
- 调试工具相关说明见 `20260905-debug-tools.md`；该文档 §3 的挂载描述由本文路由机制承接。
