import { describe, expect, it } from 'vitest'

import { buildToolPath, parseToolRoute } from './router'

describe('router', () => {
  describe('buildToolPath', () => {
    it('根基路径下生成单段路径', () => {
      expect(buildToolPath('midi-player', '/')).toBe('/midi-player')
      expect(buildToolPath('midi-keyboard', '/')).toBe('/midi-keyboard')
    })

    it('子路径基路径下拼接基路径与工具 id', () => {
      expect(buildToolPath('midi-player', '/pianokits/')).toBe('/pianokits/midi-player')
    })

    it('自动补齐基路径末尾斜杠', () => {
      expect(buildToolPath('midi-player', '/pianokits')).toBe('/pianokits/midi-player')
    })
  })

  describe('parseToolRoute', () => {
    it('从根基路径提取工具 id', () => {
      expect(parseToolRoute('/midi-player', '/')).toBe('midi-player')
      expect(parseToolRoute('/midi-keyboard', '/')).toBe('midi-keyboard')
    })

    it('从子路径基路径提取工具 id', () => {
      expect(parseToolRoute('/pianokits/midi-player', '/pianokits/')).toBe('midi-player')
    })

    it('根路径返回 null', () => {
      expect(parseToolRoute('/', '/')).toBeNull()
      expect(parseToolRoute('/pianokits/', '/pianokits/')).toBeNull()
    })

    it('子路径根不带末尾斜杠也视为根', () => {
      expect(parseToolRoute('/pianokits', '/pianokits/')).toBeNull()
    })

    it('提取首段路径（是否合法由注册表判定）', () => {
      expect(parseToolRoute('/unknown-tool', '/')).toBe('unknown-tool')
      expect(parseToolRoute('/midi-player/extra', '/')).toBe('midi-player')
    })
  })
})
