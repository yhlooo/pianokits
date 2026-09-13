import { describe, expect, it } from 'vitest'

import type { RecorderUiState } from '../core/recorder'
import { AUTO_RECORD_HINT, NO_MIDI_HINT, centerHintText, midiHintText } from './recorder-view'

/**
 * 音轨正中央提示的显隐与文案（设计文档 20260913-recorder-auto-record.md §3.2）：
 * 未连接键盘 → 说明未连接；已连接 + 未播放未录制 + 全空音轨 → 提示"演奏即录"；其余不提示。
 */
function state(patch: Partial<RecorderUiState> = {}): RecorderUiState {
  return {
    mode: 'idle',
    hasContent: false,
    duration: 0,
    midiStatus: 'connected',
    midiConnected: true,
    midiLabels: ['Test Keyboard'],
    ...patch,
  }
}

const disconnected = (status: RecorderUiState['midiStatus']): RecorderUiState =>
  state({ midiStatus: status, midiConnected: false, midiLabels: [] })

describe('centerHintText：音轨正中央提示', () => {
  it('已连接、空闲、全空音轨：提示"在 MIDI 键盘上演奏可自动开始录制"', () => {
    expect(centerHintText(state())).toBe(AUTO_RECORD_HINT)
  })

  it('录了一部分再暂停（有内容）后不再提示', () => {
    expect(centerHintText(state({ hasContent: true }))).toBe('')
  })

  it('播放中 / 录制中不提示', () => {
    expect(centerHintText(state({ mode: 'playing', hasContent: true }))).toBe('')
    expect(centerHintText(state({ mode: 'recording', hasContent: true }))).toBe('')
    expect(centerHintText(state({ mode: 'recording' }))).toBe('')
  })

  it('未连接键盘：提示"未连接 MIDI 键盘"（音轨有内容时也提示）', () => {
    expect(centerHintText(disconnected('no-devices'))).toBe(NO_MIDI_HINT)
    expect(centerHintText({ ...disconnected('no-devices'), hasContent: true })).toBe(NO_MIDI_HINT)
  })

  it('未连接的具体原因照实说（与按钮 Tips 同一套文案）', () => {
    expect(centerHintText(disconnected('unsupported'))).toBe('当前浏览器不支持 Web MIDI')
    expect(centerHintText(disconnected('denied'))).toBe(
      'MIDI 授权被拒绝，请在浏览器站点设置中允许后重试',
    )
    expect(centerHintText(disconnected('error'))).toBe('MIDI 连接失败，请重试')
  })

  it('连接尚未有结论（idle / connecting）时不提示：避免每次进页闪一下', () => {
    expect(centerHintText(disconnected('idle'))).toBe('')
    expect(centerHintText(disconnected('connecting'))).toBe('')
  })
})

describe('midiHintText：未连接文案（按钮 Tips / 中央提示共用）', () => {
  it('默认用祈使句（按钮 Tips：「请先连接 MIDI 键盘」）', () => {
    expect(midiHintText('no-devices')).toBe('请先连接 MIDI 键盘')
    expect(midiHintText('connecting')).toBe('请先连接 MIDI 键盘')
  })

  it('可换用陈述句（中央提示：「未连接 MIDI 键盘」）', () => {
    expect(midiHintText('no-devices', NO_MIDI_HINT)).toBe(NO_MIDI_HINT)
  })

  it('已连接返回空串；具体失败原因不受 fallback 影响', () => {
    expect(midiHintText('connected')).toBe('')
    expect(midiHintText('denied', NO_MIDI_HINT)).toBe(
      'MIDI 授权被拒绝，请在浏览器站点设置中允许后重试',
    )
  })
})
