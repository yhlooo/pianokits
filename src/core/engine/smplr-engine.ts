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

  allNotesOff(): void {
    // stop() 停掉发声中的 voice；其内部的 AudioBufferSourceNode 在排期时间之前被 stop
    // 则不会发声，因此已排期未发声的音符也会被取消。
    this.piano?.stop()
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
    this._ready = false
  }
}
