/**
 * 生成 UUID v4 字符串（用作文件库记录 id）。
 *
 * `crypto.randomUUID` 仅在安全上下文（HTTPS 或 localhost）可用；页面通过普通
 * HTTP 加载时（如 iPad 的 Web MIDI Browser 打开 `http://局域网IP:端口`）该方法
 * 不存在，调用会抛 `crypto.randomUUID is not a function`。
 * `crypto.getRandomValues` 是 Crypto 接口中唯一可在非安全上下文使用的方法，
 * 因此这里用它自行构造 v4 UUID 兜底，保证 HTTP 部署下导入功能可用。
 *
 * 参考：docs/development/reference/browser/webcrypto-secure-context.md
 */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant（10xx）
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
