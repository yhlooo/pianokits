import { describe, expect, it } from 'vitest'

import { formatClock, formatFileStamp, formatTime } from './dom'

describe('formatTime（播放器进度条，分钟不补零）', () => {
  it('秒向下取整、分钟不进位到小时', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(12.9)).toBe('0:12')
    expect(formatTime(83)).toBe('1:23')
    expect(formatTime(99 * 60 + 23)).toBe('99:23')
    expect(formatTime(102 * 60 + 23)).toBe('102:23')
    expect(formatTime(-5)).toBe('0:00')
  })
})

describe('formatClock（录音计时器，分补零、秒带两位小数、超过 60 分钟继续累加）', () => {
  it('00:00.00 格式', () => {
    expect(formatClock(0)).toBe('00:00.00')
    expect(formatClock(7)).toBe('00:07.00')
    expect(formatClock(7.5)).toBe('00:07.50')
    expect(formatClock(7.05)).toBe('00:07.05')
    expect(formatClock(59.99)).toBe('00:59.99')
    expect(formatClock(60)).toBe('01:00.00')
    expect(formatClock(23 * 60 + 34.99)).toBe('23:34.99')
  })

  it('超过 60 分钟不折算成小时', () => {
    expect(formatClock(99 * 60 + 23.45)).toBe('99:23.45')
    expect(formatClock(102 * 60 + 23.45)).toBe('102:23.45')
    expect(formatClock(60 * 60)).toBe('60:00.00')
  })

  it('向下取整：不会因四舍五入出现 00:60.00', () => {
    expect(formatClock(59.999)).toBe('00:59.99')
    expect(formatClock(119.999)).toBe('01:59.99')
    expect(formatClock(-5)).toBe('00:00.00')
  })
})

describe('formatFileStamp（下载/保存默认文件名的时间戳）', () => {
  it('yyyyMMdd-hhmmss（本地时间、各段补零）', () => {
    const date = new Date(2026, 8, 12, 9, 5, 7) // 2026-09-12 09:05:07
    expect(formatFileStamp(date)).toBe('20260912-090507')
  })
})
