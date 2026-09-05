import type { Song } from '../core/model'
import type { ScoreModel } from '../core/midi/quantize'
import type { TransportState } from '../core/transport'
import type { LibraryItem } from '../storage/library'

export type ViewMode = 'split' | 'waterfall' | 'score'

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
