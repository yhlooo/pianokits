/**
 * 工具路由：把「工具 id」映射为页面路径（History API），使每个工具页面拥有独立 URI、
 * 刷新可保持当前页面。路由与工具注册表解耦——这里只负责路径解析，不感知具体工具有哪些。
 */

/** GitHub Pages 404 回退在 sessionStorage 中暂存目标路径所用的键（见 public/404.html） */
const REDIRECT_KEY = 'pianokits-redirect'

/**
 * 应用基路径（以 `/` 结尾）。`base: './'` 部署到 GitHub Pages 子路径时，路由解析需先剔除
 * 基路径前缀。入口模块位于应用根下一级（dev: `/src/`、build: `/assets/`），取其上一级即应用根。
 */
export function appBasePath(): string {
  // `..` 相对 import.meta.url 在运行时求值（dev: /src/、build: /assets/ 的上一级），
  // 构建期无需也无法解析，故标注 @vite-ignore 保留原样。
  const base = new URL(/* @vite-ignore */ '..', import.meta.url).pathname
  return base.endsWith('/') ? base : `${base}/`
}

/** 归一化基路径，保证以 `/` 结尾（根路径为 `/`）。 */
function normalizeBase(basePath: string): string {
  return basePath.endsWith('/') ? basePath : `${basePath}/`
}

/**
 * 从完整 pathname 提取工具 id（基路径之后的第一段路径）。
 * 根路径（无后续段）返回 null；pathname 不在基路径之下时退化为按整段解析。
 */
export function parseToolRoute(pathname: string, basePath: string): string | null {
  const base = normalizeBase(basePath)
  // 根路径（含基路径不带末尾斜杠的写法）返回 null
  if (pathname === base || pathname === base.slice(0, -1)) return null
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname
  const segment = rest.split('/').find((s) => s !== '')
  return segment ?? null
}

/** 由工具 id 构造完整路径（含基路径）。 */
export function buildToolPath(id: string, basePath: string): string {
  return `${normalizeBase(basePath)}${id}`
}

/** GitHub Pages 404 回退：读取 404.html 暂存的目标路径并以 replaceState 恢复；无则不动。 */
export function consumeRedirectPath(): void {
  const saved = sessionStorage.getItem(REDIRECT_KEY)
  if (saved === null) return
  sessionStorage.removeItem(REDIRECT_KEY)
  window.history.replaceState(null, '', saved)
}
