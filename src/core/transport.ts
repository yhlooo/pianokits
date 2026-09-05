import type { Song } from './model'
import type { AudioEngine } from './engine/types'

export type TransportState = 'empty' | 'ready' | 'playing' | 'paused'

/** 可注入的时间与定时器宿主：生产用 AudioContext 时钟，测试用假时钟（设计文档 §4） */
export interface TransportHost {
  now(): number
  setInterval(cb: () => void, ms: number): number
  clearInterval(id: number): void
}

/** lookahead 窗口（秒）：调度器把未来 100ms 内的音符一次性排入引擎 */
export const LOOKAHEAD_SEC = 0.1
/** 定时器间隔（ms） */
export const TICK_MS = 25
/** 排期补偿（秒）：避免定时器回调边界的竞态 */
const LATENCY_SEC = 0.015

type StateListener = (state: TransportState) => void

/**
 * 播放状态机 + lookahead 调度器 + 时钟（设计文档 §4、§6.3）。
 *
 * 唯一时钟：AudioContext.currentTime。position = now - offset。
 * 调度器只负责声音准时；视觉由视图每帧读 position（不依赖任何音频回调）。
 */
export class Transport {
  private song: Song | null = null
  private notes: Song['notes'] = []
  private engine: AudioEngine
  private host: TransportHost
  private offset = 0
  private pausedAt = 0
  private nextIndex = 0
  private intervalId: number | undefined
  private listeners = new Set<StateListener>()
  private _state: TransportState = 'empty'
  private _duration = 0
  private volume = 1

  constructor(engine: AudioEngine, host: TransportHost) {
    this.engine = engine
    this.host = host
  }

  get state(): TransportState {
    return this._state
  }

  get duration(): number {
    return this._duration
  }

  /** 实时位置（秒）：播放中按音频时钟计算，暂停时取暂停位置 */
  get position(): number {
    if (this._state === 'playing') {
      return Math.min(this._duration, Math.max(0, this.host.now() - this.offset))
    }
    return this.pausedAt
  }

  on(event: 'statechange', cb: StateListener): () => void {
    if (event !== 'statechange') return () => {}
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  setEngine(engine: AudioEngine): void {
    if (this.engine.id === engine.id) {
      this.engine = engine
      return
    }
    const wasPlaying = this._state === 'playing'
    const pos = this.position
    this.engine.allNotesOff()
    this.engine = engine
    engine.setVolume(this.volume)
    if (this.song !== null) {
      this.pausedAt = pos
      this.setNotePointer(pos)
      if (wasPlaying) {
        this.offset = this.host.now() - pos
        this.setState('playing')
      } else if (this._state !== 'empty') {
        this.setState('paused')
      }
    }
  }

  load(song: Song): void {
    this.stopTicker()
    this.engine.allNotesOff()
    this.song = song
    this.notes = song.notes
    this._duration = song.duration
    this.pausedAt = 0
    this.offset = this.host.now()
    this.nextIndex = 0
    this.setState('ready')
  }

  play(): void {
    if (this.song === null || this._state === 'playing') return
    if (this._state === 'empty') return
    if (this.pausedAt >= this._duration - 0.001) {
      // 播完后再点播放：从头开始
      this.seek(0)
    }
    this.offset = this.host.now() - this.pausedAt
    this.setState('playing')
    this.tick()
    this.startTicker()
  }

  pause(): void {
    if (this._state !== 'playing') return
    this.pausedAt = this.position
    this.stopTicker()
    this.engine.allNotesOff()
    this.setState('paused')
  }

  stop(): void {
    if (this.song === null) return
    this.pausedAt = 0
    this.offset = this.host.now()
    this.stopTicker()
    this.engine.allNotesOff()
    this.nextIndex = 0
    this.setState('paused')
  }

  seek(seconds: number): void {
    if (this.song === null) return
    const wasPlaying = this._state === 'playing'
    const target = Math.max(0, Math.min(this._duration, seconds))
    this.engine.allNotesOff()
    this.pausedAt = target
    this.setNotePointer(target)
    this.offset = this.host.now() - target
    this.setState(wasPlaying ? 'playing' : 'paused')
    if (wasPlaying) this.tick()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.engine.setVolume(this.volume)
  }

  dispose(): void {
    this.stopTicker()
    this.engine.allNotesOff()
    this.listeners.clear()
    this.setState('empty')
  }

  /** 定时器回调：把 [now+latency, now+latency+lookahead] 窗口内的音符排入引擎 */
  tick(): void {
    if (this._state !== 'playing' || this.song === null) return
    const now = this.host.now()
    const pos = now - this.offset
    const from = pos + LATENCY_SEC
    const until = pos + LOOKAHEAD_SEC
    const notes = this.notes

    while (this.nextIndex < notes.length && notes[this.nextIndex].start < until) {
      const n = notes[this.nextIndex]
      this.nextIndex++
      if (n.end <= from) continue
      const atTime = this.offset + n.start
      this.engine.scheduleNote({
        pitch: n.pitch,
        velocity: n.velocity,
        time: atTime,
        duration: n.end - n.start,
      })
    }

    if (pos >= this._duration) {
      this.pausedAt = this._duration
      this.stopTicker()
      this.setState('paused')
    }
  }

  private startTicker(): void {
    if (this.intervalId !== undefined) return
    this.intervalId = this.host.setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicker(): void {
    if (this.intervalId !== undefined) {
      this.host.clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  private setNotePointer(position: number): void {
    // 二分：第一个 end > position 的音符
    let lo = 0
    let hi = this.notes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.notes[mid].end <= position) lo = mid + 1
      else hi = mid
    }
    this.nextIndex = lo
  }

  private setState(state: TransportState): void {
    if (this._state === state) return
    this._state = state
    for (const cb of this.listeners) cb(state)
  }
}
