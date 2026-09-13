import { CacheStorage, Sampler, pianoToPreset } from 'smplr'
import type { Smplr } from 'smplr'

import { appBasePath } from '../../router'

import type { AudioEngine, EngineInitOptions, ScheduledNote } from './types'

/**
 * 自托管采样路径（public/samples/ 镜像，见 scripts/mirror-samples.mjs）。
 * 相对应用基路径拼接（而非写死 `/samples/...`），保证部署到 GitHub Pages 子路径
 * （如 `/pianokits/`）时采样仍能命中正确地址，不会因根路径假设而 404。
 */
const SAMPLES_BASE_URL = `${appBasePath()}samples/sfzinstruments-splendid-grand-piano/samples`

/**
 * smplr SplendidGrandPiano 引擎（首选）。
 *
 * 不走 smplr 的 SplendidGrandPiano 工厂，而用 pianoToPreset + Sampler 组合，
 * 以便在 preset.samples.map 中对文件名做 URL 编码——smplr 拼接 URL 时不编码，
 * 采样名中的 `#`（如 "MF C#1"）会被 URL 解析成锚点导致 404（上游缺陷）。
 */
export class SmplrEngine implements AudioEngine {
  readonly id = 'smplr' as const
  private readonly context: AudioContext
  private piano: Smplr | null = null
  private _ready = false
  private volume = 1
  /** 实时演奏 voice（MIDI 键盘）：pitch → 停止函数（smplr start() 的返回值） */
  private readonly liveStops = new Map<number, () => void>()
  /** 已离键但仍被延音（CC64 踩着）的实时 voice：pitch → 停止函数（同音高可能多个） */
  private readonly sustainedStops = new Map<number, Array<() => void>>()
  /** 延音踏板是否踩着（实时 voice 的止音时机；不影响已排期的文件播放音符） */
  private sustainDown = false

  constructor(context: AudioContext) {
    this.context = context
  }

  get ready(): boolean {
    return this._ready
  }

  async init(opts?: EngineInitOptions): Promise<void> {
    const preset = pianoToPreset({
      baseUrl: SAMPLES_BASE_URL,
      formats: ['ogg', 'm4a'],
      decayTime: 0.5,
      detune: 0,
    })
    const names = preset.groups.flatMap((g) => g.regions.map((r) => r.sample))
    // 采样名含空格与 #（如 "MF C#1"）：
    // 1) smplr 拼 URL 时不编码，'#' 会被 URL 解析成锚点 → 404（上游缺陷）；
    // 2) 镜像落盘时已把 '#' 换成 '♯'（Vite 静态服务无法解码 %23 路径）。
    // 因此这里做 原始名 → URL 编码后的 ♯ 名 映射。
    preset.samples.map = Object.fromEntries(
      names.map((n) => [n, encodeURIComponent(n.replaceAll('#', '♯'))]),
    )

    const piano = Sampler(this.context, {
      preset,
      storage: CacheStorage(),
      volume: 100,
      onLoadProgress: (progress) => opts?.onProgress?.(progress.loaded, progress.total),
    })
    await piano.ready
    this.piano = piano
    piano.output.volume = Math.round(this.volume * 127)
    this._ready = true
  }

  scheduleNote(ev: ScheduledNote): void {
    if (this.piano === null) return
    this.piano.start({
      note: ev.pitch,
      velocity: ev.velocity,
      time: ev.time,
      duration: ev.duration,
    })
  }

  noteOn(pitch: number, velocity: number): void {
    // 同音高重复按下：先止住前一个实时 voice（含延音中仍响着的——弦被重新击打）
    this.stopLiveVoice(pitch)
    if (this.piano === null) return
    // duration 省略/null = 不自动止音（自然延音），离键时用返回的停止函数止音
    const stop = this.piano.start({ note: pitch, velocity, duration: null })
    this.liveStops.set(pitch, stop)
  }

  noteOff(pitch: number): void {
    const stop = this.liveStops.get(pitch)
    if (stop === undefined) return
    this.liveStops.delete(pitch)
    // 踏板踩着：延后止音（等 setSustain(false) 统一释放）；否则立即止音
    if (this.sustainDown) {
      const list = this.sustainedStops.get(pitch)
      if (list === undefined) this.sustainedStops.set(pitch, [stop])
      else list.push(stop)
      return
    }
    stop()
  }

  setSustain(down: boolean): void {
    if (this.sustainDown === down) return
    this.sustainDown = down
    if (!down) this.releaseSustained()
  }

  allNotesOff(): void {
    // stop() 停掉发声中的 voice；其内部的 AudioBufferSourceNode 在排期时间之前被 stop
    // 则不会发声，因此已排期未发声的音符也会被取消。
    this.piano?.stop()
    for (const stop of this.liveStops.values()) stop()
    this.liveStops.clear()
    this.releaseSustained()
  }

  /** 释放全部"已离键但仍被延音"的 voice（踏板抬起 / 止音 / 卸载） */
  private releaseSustained(): void {
    for (const list of this.sustainedStops.values()) {
      for (const stop of list) stop()
    }
    this.sustainedStops.clear()
  }

  /** 硬止某音高的全部实时 voice（按住中 + 延音中） */
  private stopLiveVoice(pitch: number): void {
    const live = this.liveStops.get(pitch)
    if (live !== undefined) {
      this.liveStops.delete(pitch)
      live()
    }
    const sustained = this.sustainedStops.get(pitch)
    if (sustained !== undefined) {
      this.sustainedStops.delete(pitch)
      for (const stop of sustained) stop()
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.piano !== null) {
      this.piano.output.volume = Math.round(this.volume * 127)
    }
  }

  dispose(): void {
    this.piano?.dispose()
    this.piano = null
    this.liveStops.clear()
    this.sustainedStops.clear()
    this._ready = false
  }
}
