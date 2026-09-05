import type { AudioEngine, ScheduledNote } from './types'

interface Voice {
  oscs: OscillatorNode[]
  gain: GainNode
}

/**
 * 零依赖振荡器兜底引擎：三角波 + 倍频正弦，指数衰减包络。
 * 用于采样加载失败/加载中/离线场景与自动化测试。
 */
export class OscillatorEngine implements AudioEngine {
  readonly id = 'oscillator' as const
  readonly ready = true

  private readonly context: AudioContext
  private readonly master: GainNode
  private readonly voices = new Map<number, Voice[]>()

  constructor(context: AudioContext) {
    this.context = context
    this.master = context.createGain()
    this.master.connect(context.destination)
  }

  async init(): Promise<void> {}

  scheduleNote(ev: ScheduledNote): void {
    const t0 = Math.max(ev.time, this.context.currentTime)
    const freq = 440 * Math.pow(2, (ev.pitch - 69) / 12)
    const gain = this.context.createGain()
    const peak = 0.18 * (ev.velocity / 127)
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(ev.duration, 0.05) * 0.95)

    const osc1 = this.context.createOscillator()
    osc1.type = 'triangle'
    osc1.frequency.value = freq
    const osc2 = this.context.createOscillator()
    osc2.type = 'sine'
    osc2.frequency.value = freq * 2
    const osc2Gain = this.context.createGain()
    osc2Gain.gain.value = 0.35

    osc1.connect(gain)
    osc2.connect(osc2Gain)
    osc2Gain.connect(gain)
    gain.connect(this.master)

    const end = t0 + ev.duration + 0.05
    osc1.start(t0)
    osc2.start(t0)
    osc1.stop(end)
    osc2.stop(end)

    const voice: Voice = { oscs: [osc1, osc2], gain }
    const list = this.voices.get(ev.pitch) ?? []
    list.push(voice)
    this.voices.set(ev.pitch, list)
    voice.oscs[0].onended = () => {
      const remaining = (this.voices.get(ev.pitch) ?? []).filter((v) => v !== voice)
      if (remaining.length > 0) this.voices.set(ev.pitch, remaining)
      else this.voices.delete(ev.pitch)
    }
  }

  allNotesOff(): void {
    const now = this.context.currentTime
    for (const list of this.voices.values()) {
      for (const v of list) {
        v.gain.gain.cancelScheduledValues(now)
        v.gain.gain.setValueAtTime(Math.max(v.gain.gain.value, 0.0001), now)
        v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03)
        for (const o of v.oscs) {
          try {
            o.stop(now + 0.05)
          } catch {
            // 已停止的源再次 stop 会抛异常，忽略
          }
        }
      }
    }
    this.voices.clear()
  }

  setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(
      Math.max(0, Math.min(1, volume)),
      this.context.currentTime,
      0.01,
    )
  }

  dispose(): void {
    this.allNotesOff()
    this.master.disconnect()
  }
}
