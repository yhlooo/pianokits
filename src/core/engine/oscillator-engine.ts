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
  /** 实时演奏 voice（MIDI 键盘）：pitch → voice */
  private readonly liveVoices = new Map<number, Voice>()

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

  noteOn(pitch: number, velocity: number): void {
    // 同音高重复按下：先止住前一个实时 voice
    this.noteOff(pitch)
    const t0 = this.context.currentTime
    const freq = 440 * Math.pow(2, (pitch - 69) / 12)
    const gain = this.context.createGain()
    const peak = 0.18 * (velocity / 127)
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + 0.012)
    // 按住期间保持：起音后指数回落到峰值一半（近似钢琴延音衰减）
    gain.gain.setTargetAtTime(Math.max(peak * 0.5, 0.0001), t0 + 0.012, 0.4)

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
    osc1.start(t0)
    osc2.start(t0)

    this.liveVoices.set(pitch, { oscs: [osc1, osc2], gain })
  }

  noteOff(pitch: number): void {
    const voice = this.liveVoices.get(pitch)
    if (voice === undefined) return
    this.liveVoices.delete(pitch)
    this.releaseVoice(voice, this.context.currentTime, 0.06)
  }

  allNotesOff(): void {
    const now = this.context.currentTime
    for (const list of this.voices.values()) {
      for (const v of list) this.releaseVoice(v, now, 0.03)
    }
    this.voices.clear()
    for (const v of this.liveVoices.values()) this.releaseVoice(v, now, 0.03)
    this.liveVoices.clear()
  }

  /** 快泄增益并停止振荡器（共享的止音路径） */
  private releaseVoice(voice: Voice, now: number, releaseSec: number): void {
    const gain = voice.gain
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + releaseSec)
    for (const o of voice.oscs) {
      try {
        o.stop(now + releaseSec + 0.02)
      } catch {
        // 已停止的源再次 stop 会抛异常，忽略
      }
    }
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
