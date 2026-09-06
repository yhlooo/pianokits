import { afterEach, describe, expect, it, vi } from 'vitest'

import { randomUUID } from './uuid'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUUID', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('原生 crypto.randomUUID 可用（安全上下文）时优先使用它', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000')
    expect(randomUUID()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('randomUUID 缺失（非安全上下文）时用 getRandomValues 兜底生成 v4', () => {
    const source = new Uint8Array(16).fill(0xab)
    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(source)
        return array
      },
    })
    // 0xab 全字节 → 第 7 字节版本位变 0x4b、第 9 字节变体位变 0xab
    expect(randomUUID()).toBe('abababab-abab-4bab-abab-abababababab')
  })

  it('兜底路径输出符合 UUID v4 格式且各不相同', () => {
    const realGetRandomValues = crypto.getRandomValues.bind(crypto)
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues })
    const a = randomUUID()
    const b = randomUUID()
    expect(a).toMatch(UUID_V4_RE)
    expect(b).toMatch(UUID_V4_RE)
    expect(a).not.toBe(b)
  })
})
