import type { Song } from '../core/model'
import type { ScoreModel } from '../core/midi/quantize'
import type { TransportState } from '../core/transport'
import type { LibraryItem } from '../storage/library'

export type ViewMode = 'split' | 'waterfall' | 'score'

/** 视图开关对应的面板：瀑布 / 乐谱（两个独立开关，按开启组合推导出 ViewMode） */
export type ViewPanel = 'waterfall' | 'score'

/**
 * 视图面板开关语义（两个开关不能都关闭）：
 * - 瀑布 + 乐谱 = 分屏；仅瀑布 = 瀑布；仅乐谱 = 乐谱；
 * - 关闭唯一开启的面板时，自动开启另一个面板（切换而非全关）。
 */
export function nextViewMode(mode: ViewMode, panel: ViewPanel): ViewMode {
  if (panel === 'waterfall') return mode === 'score' ? 'split' : 'score'
  return mode === 'waterfall' ? 'split' : 'waterfall'
}

export interface AppState {
  files: LibraryItem[]
  currentFile: { id: string; name: string } | null
  song: Song | null
  score: ScoreModel | null
  transport: TransportState
  engine: 'oscillator' | 'smplr'
  engineProgress: { loaded: number; total: number } | null
  volume: number
  view: ViewMode
  notice: string | null
}
