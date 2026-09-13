/**
 * 录音工具的领域模型（与「播放 / 练习」工具的 Song 无关）：
 * 录音是自时间轴 0 起、按秒记时的音符集合与踏板踩下区间，可直接编码成 .mid 文件或存回播放器文件库。
 */

/** 最小音符时值（秒）：同刻按下/松开也留出可听、可画的最短时值 */
export const MIN_NOTE_SEC = 0.02

/** 录制得到的音符（时间轴绝对秒数） */
export interface RecordedNote {
  /** MIDI 音高 0~127 */
  pitch: number
  /** 力度 1~127（1 = 最弱，画面上颜色最浅） */
  velocity: number
  /** 起点（秒，音轨时间轴） */
  start: number
  /** 终点（秒，> start） */
  end: number
  /** MIDI 通道 0~15（录制时保留，回放与导出沿用同一通道） */
  channel: number
}

/** 音轨总时长（秒）：最后一个音符的结束时刻；空轨为 0 */
export function trackDuration(notes: readonly RecordedNote[]): number {
  let max = 0
  for (const n of notes) {
    if (n.end > max) max = n.end
  }
  return max
}

/**
 * 把一段带 `[start, end]` 的对象按时间窗口 `[from, to]` 裁掉落在窗口内的部分，返回窗口之外
 * 剩下的片段：完全在窗口内 → 空；只被窗口切掉头或尾 → 一段；窗口落在中间 → 前后两段；
 * 与窗口不相交 → 原样返回（同一个对象，不做无谓拷贝）。音符与踏板区间共用本内核。
 */
function clipOutside<T extends { start: number; end: number }>(
  span: T,
  from: number,
  to: number,
): T[] {
  if (span.end <= from || span.start >= to) return [span]
  const out: T[] = []
  if (span.start < from) out.push({ ...span, end: from })
  if (span.end > to) out.push({ ...span, start: to })
  return out
}

/**
 * 把新音符放进音轨（同音高的旧音符在重叠处被**接管**）。
 *
 * 一个音高在同一时刻只能响一个音：同音高与新音符重叠的旧音符被裁剪，
 * 完全落在新音符区间内的被移除（跨越两端的切成前后两段）；不同音高互不影响。
 * 返回按 start 升序的新数组（原数组不被修改）。
 */
export function overlayNote(notes: readonly RecordedNote[], note: RecordedNote): RecordedNote[] {
  const next: RecordedNote[] = []
  for (const n of notes) {
    if (n.pitch !== note.pitch) {
      next.push(n)
      continue
    }
    next.push(...clipOutside(n, note.start, note.end))
  }
  next.push(note)
  next.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return next
}

/**
 * 覆盖录制：擦除 `[from, to]` 时间窗口内的**全部**内容（不分音高，这正是覆盖与叠加的区别）。
 *
 * 与窗口相交的音符只保留窗口之外的部分——录制线扫过多少就抹掉多少：
 * 完全在窗口内的整体抹除、跨越窗口边界的被裁掉被扫到的部分、跨越窗口两端的切成前后两段。
 * `to <= from`（还没扫过任何位置）时原样返回（浅拷贝）。
 */
export function eraseRange(
  notes: readonly RecordedNote[],
  from: number,
  to: number,
): RecordedNote[] {
  if (!(to > from)) return [...notes]
  const next: RecordedNote[] = []
  for (const n of notes) next.push(...clipOutside(n, from, to))
  return next
}

/** 合并两条按 start 升序的音符序列（保持升序，同 start 按音高）；不裁剪、不去重 */
export function mergeNotes(a: readonly RecordedNote[], b: readonly RecordedNote[]): RecordedNote[] {
  if (a.length === 0) return [...b]
  if (b.length === 0) return [...a]
  const out: RecordedNote[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a[i]
    const y = b[j]
    if (x.start < y.start || (x.start === y.start && x.pitch <= y.pitch)) out.push(a[i++])
    else out.push(b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

/** 第一个 start >= position 的音符下标（notes 按 start 升序）；无则 notes.length */
export function firstNoteAtOrAfter(notes: readonly RecordedNote[], position: number): number {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].start < position) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ---------- 踏板（设计文档 20260913-recorder-pedals.md §3.2） ----------

/**
 * 录制得到的踏板**踩下区间**（时间轴绝对秒数）。
 *
 * 以区间而不是原始 CC 事件流存储：覆盖录制的擦除、视图的条、回放与导出的 CC 都能由区间唯一导出，
 * 且与播放器侧 `PedalSegment` 的领域口径一致（CC64 延音 / CC66 选择延音 / CC67 弱音）。
 */
export interface RecordedPedalSegment {
  /** 控制器号：64 延音 / 66 选择延音 / 67 弱音 */
  controller: number
  /** MIDI 通道 0~15（录制时保留，回放与导出沿用） */
  channel: number
  /** 踩下时刻（秒，音轨时间轴） */
  start: number
  /** 抬起时刻（秒）；录制中尚未抬起为 Infinity（在 pass/拖动/导出边界收尾） */
  end: number
  /** 踩下值 0~127（半踏板保留原值；抬起固定写 0） */
  value: number
}

/** 踏板区间总时长（秒）：最后一个区间的结束时刻；空轨为 0（非有限 end 视为未收尾，不计入） */
export function pedalTrackDuration(segments: readonly RecordedPedalSegment[]): number {
  let max = 0
  for (const s of segments) {
    if (Number.isFinite(s.end) && s.end > max) max = s.end
  }
  return max
}

/**
 * 覆盖录制：擦除 `[from, to]` 时间窗口内的**全部**踏板区间（与音符的 `eraseRange` 同一裁剪内核）。
 * 与窗口相交的区间只保留窗口之外的部分（跨边界裁剪、跨两端切成两段）。
 * `to <= from`（还没扫过任何位置）时原样返回（浅拷贝）。
 */
export function erasePedalRange(
  segments: readonly RecordedPedalSegment[],
  from: number,
  to: number,
): RecordedPedalSegment[] {
  if (!(to > from)) return [...segments]
  const next: RecordedPedalSegment[] = []
  for (const s of segments) next.push(...clipOutside(s, from, to))
  return next
}

/** 合并两条按 start 升序的踏板区间序列（保持升序，同 start 按控制器号、通道） */
export function mergePedals(
  a: readonly RecordedPedalSegment[],
  b: readonly RecordedPedalSegment[],
): RecordedPedalSegment[] {
  if (a.length === 0) return [...b]
  if (b.length === 0) return [...a]
  const out: RecordedPedalSegment[] = []
  let i = 0
  let j = 0
  const before = (x: RecordedPedalSegment, y: RecordedPedalSegment): boolean =>
    x.start < y.start ||
    (x.start === y.start &&
      (x.controller < y.controller || (x.controller === y.controller && x.channel <= y.channel)))
  while (i < a.length && j < b.length) {
    if (before(a[i], b[j])) out.push(a[i++])
    else out.push(b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

/**
 * 第一个 `end > position` 的踏板区间下标（无则 segments.length）——**不是** `start >= position`：
 * 录制/播放线落在某段区间中途时该段仍要排期（回放首个 tick 立即补发"踩下"）。
 *
 * `end` 不单调（不同踏板/通道的区间可以重叠，例如延音 0–10s 与弱音 1–2s），因此不能二分；
 * 区间数量级很小（一次演奏几十~几百段），且只在起播/跳转/清空时定位一次。
 */
export function firstPedalAtOrAfter(
  segments: readonly RecordedPedalSegment[],
  position: number,
): number {
  let i = 0
  while (i < segments.length && segments[i].end <= position) i++
  return i
}
