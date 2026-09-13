import { Midi } from '@tonejs/midi'

import type { KeySignatureEvent, PedalEvent, Song, TempoEvent, TimeSignatureEvent } from '../model'
import { PEDALS } from './pedals'

/** GM 打击乐通道（channel 9 = 第 10 通道） */
const PERCUSSION_CHANNEL = 9

/** 调号字符串（@tonejs/midi 的 key 字段，如 "C"、"F#"、"Bbm"）→ 升降号数量 */
const KEY_NAME_TO_SF = new Map<string, number>([
  ['C', 0],
  ['G', 1],
  ['D', 2],
  ['A', 3],
  ['E', 4],
  ['B', 5],
  ['F#', 6],
  ['C#', 7],
  ['F', -1],
  ['Bb', -2],
  ['Eb', -3],
  ['Ab', -4],
  ['Db', -5],
  ['Gb', -6],
  ['Cb', -7],
])

/** 调名 → 主音音级（0=C…11=B），大小写/升降号 */
const KEY_NAME_TO_PC: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
}

/** 小调名（如 "Gm"）→ 关系大调 sf：主音 +3 半音后查大调名表 */
function minorKeySf(minorTonicName: string): number {
  const pc = KEY_NAME_TO_PC[minorTonicName]
  if (pc === undefined) return 0
  // 音级 → 顺眼的大调名（升侧用 #、降侧用 b 的常用五度圈名）
  const relNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
  return KEY_NAME_TO_SF.get(relNames[(pc + 3) % 12]) ?? 0
}

/**
 * 修正被当作 latin-1 解码的 UTF-8 轨名（乱码还原）。
 *
 * SMF 规范把文本事件（FF 03 轨名、FF 01 文本）定义为 ASCII，没有规定非 ASCII 的编码，
 * 实际文件普遍两种写法：latin-1 系（多为西欧字符）与 UTF-8。
 * `@tonejs/midi` 统一用 `String.fromCharCode` 按字节取值，于是 UTF-8 的每个字节
 * 变成独立的 U+0080–U+00FF 字符（"右手旋律" → "å³ææå¾"）。
 *
 * 判定：把当前字符串按 latin-1 反向取回原始字节，若这些字节恰好是
 * **合法的 UTF-8 序列且含多字节字符**，则按 UTF-8 重新解码；否则视为真正的
 * latin-1 文本原样返回。`fatal: true` 让非法序列抛错，避免把 "café" 这类
 * 合法 latin-1 字符串误判（其字节 EB 之后缺少续接字节，不是合法 UTF-8）。
 *
 * 局限：不覆盖 GBK/Big5 等其它编码（零依赖下 `TextDecoder` 不可靠支持），
 * 此类轨名会落回原始乱码——需要时另行立项引入解码依赖。
 */
export function decodeMidiText(raw: string): string {
  if (raw === '') return raw
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code > 0xff) return raw // 已含 >U+00FF 字符：说明并非逐字节解码的结果
    bytes[i] = code
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return raw // 不是合法 UTF-8：视为真正的 latin-1 文本
  }
  if (decoded === raw) return raw // 全 ASCII，无需替换
  return decoded
}

/**
 * 解析 MIDI 文件字节为领域模型 Song。
 * 合并所有非打击乐轨道的音符为单一事件流（按 start 排序），
 * 三踏板 CC（64/66/67）另存为踏板事件（按 time 排序，保留来源轨与通道）。
 */
export function parseMidi(bytes: ArrayBuffer): Song {
  const midi = new Midi(bytes)
  const header = midi.header

  const tempos: TempoEvent[] = header.tempos.map((t) => ({
    time: t.time ?? header.ticksToSeconds(t.ticks),
    bpm: t.bpm,
  }))
  if (tempos.length === 0) {
    tempos.push({ time: 0, bpm: 120 })
  }

  const timeSignatures: TimeSignatureEvent[] = header.timeSignatures.map((ts) => ({
    time: header.ticksToSeconds(ts.ticks),
    numerator: ts.timeSignature[0] ?? 4,
    denominator: ts.timeSignature[1] ?? 4,
  }))

  const keySignatures: KeySignatureEvent[] = header.keySignatures.map((ks) => {
    const mi: 0 | 1 = /m$/i.test(ks.key) || ks.scale === 'minor' ? 1 : 0
    const name = ks.key.replace(/m$/i, '')
    // 小调按「关系大调」折算升降号数量（'Gm' → Bb → -2；同名折算会把小调算错）
    const sf = mi === 1 ? minorKeySf(name) : (KEY_NAME_TO_SF.get(name) ?? 0)
    return { time: header.ticksToSeconds(ks.ticks), sf, mi }
  })

  // 部分文件同一时刻会塞多个调号 meta（可能自相矛盾）；同一时刻只保留最后一个
  const keySigsDedup = keySignatures.filter((ks, i, arr) => {
    const next = arr[i + 1]
    return next === undefined || next.time > ks.time + 1e-6
  })

  const tracks = midi.tracks.map((t, index) => {
    // 轨名先做 latin-1→UTF-8 乱码还原（见 decodeMidiText），空名再退到 Track N
    const name = decodeMidiText(t.name).trim()
    return {
      index,
      name: name === '' ? `Track ${index + 1}` : name,
      channel: t.channel,
      instrument: t.instrument.number,
      percussion: t.instrument.percussion || t.channel === PERCUSSION_CHANNEL,
      noteCount: t.notes.length,
    }
  })

  const notes: Song['notes'] = []
  const pedalEvents: PedalEvent[] = []
  for (let i = 0; i < midi.tracks.length; i++) {
    const t = midi.tracks[i]
    if (t.instrument.percussion || t.channel === PERCUSSION_CHANNEL) continue
    // 三踏板（CC64 延音 / CC66 选择延音 / CC67 弱音）：瀑布流踏板轨道与练习判定用。
    // @tonejs/midi 的 CC 值已归一化为 0–1，这里还原成 MIDI 的 0–127（`>= 64` 为踩下）；
    // 事件不带通道（库丢弃），用轨内音符推导出的 t.channel 归属（研究文档
    // 20260912-midi-pedal-track-relationship.md §5）。
    for (const pedal of PEDALS) {
      const changes = t.controlChanges[pedal.cc]
      if (changes === undefined) continue
      for (const c of changes) {
        pedalEvents.push({
          time: c.time,
          controller: pedal.cc,
          value: Math.max(0, Math.min(127, Math.round(c.value * 127))),
          trackIndex: i,
          channel: t.channel,
        })
      }
    }
    for (const n of t.notes) {
      // velocity 0 的 note-on 等价 note-off，@tonejs/midi 一般已处理，这里兜底过滤
      if (n.velocity <= 0) continue
      notes.push({
        pitch: n.midi,
        start: n.time,
        end: n.time + Math.max(n.duration, 0.01),
        velocity: Math.max(1, Math.min(127, Math.round(n.velocity * 127))),
        trackIndex: i,
      })
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  // 同一时刻的踏板事件按轨号/控制器号定序（sort 稳定：同踏板同通道的先后顺序保持不变，
  // 踏板换踩的 0/127 同刻事件不会被重排）
  pedalEvents.sort(
    (a, b) => a.time - b.time || a.trackIndex - b.trackIndex || a.controller - b.controller,
  )

  const duration = notes.reduce((m, n) => Math.max(m, n.end), 0)

  return {
    ppq: header.ppq,
    duration,
    tempos,
    timeSignatures,
    keySignatures: keySigsDedup,
    tracks,
    notes,
    pedalEvents,
  }
}
