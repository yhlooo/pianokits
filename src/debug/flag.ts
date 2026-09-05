/** 调试开关：URL query 含 `debug=1` 时开启。允许注入 search 便于测试。 */
export function isDebugEnabled(search = window.location.search): boolean {
  return new URLSearchParams(search).get('debug') === '1'
}
