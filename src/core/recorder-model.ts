/**
 * 录音工具的领域模型（与「播放 / 练习」工具的 Song 无关）：
 * 录音是自时间轴 0 起、按秒记时的音符集合，可直接编码成 .mid 文件或存回播放器文件库。
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
 * 把一个音符按时间窗口 `[from, to]` 裁掉落在窗口内的部分，返回窗口之外剩下的片段：
 * 完全在窗口内 → 空；只被窗口切掉头或尾 → 一段；窗口落在音符中间 → 前后两段；
 * 与窗口不相交 → 原样返回（同一个对象，不做无谓拷贝）。
 */
function clipOutside(n: RecordedNote, from: number, to: number): RecordedNote[] {
  if (n.end <= from || n.start >= to) return [n]
  const out: RecordedNote[] = []
  if (n.start < from) out.push({ ...n, end: from })
  if (n.end > to) out.push({ ...n, start: to })
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
