import { sortedHeldPitches } from '../core/midi/held-keys'
import { parseMidiMessage } from '../core/midi/input'
import { midiNoteName } from '../core/midi/note-name'
import { el } from '../ui/dom'

// ---------- 88 键钢琴键盘（A0–C8，与 waterfall-view 同区间） ----------
const MIN_PITCH = 21 // A0
const MAX_PITCH = 108 // C8
const BLACK_PCS = new Set([1, 3, 6, 8, 10])
const WHITE_PITCHES: number[] = []
const BLACK_PITCHES: number[] = []
const WHITE_INDEX = new Map<number, number>()
for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
  if (BLACK_PCS.has(p % 12)) BLACK_PITCHES.push(p)
  else {
    WHITE_INDEX.set(p, WHITE_PITCHES.length)
    WHITE_PITCHES.push(p)
  }
}

// ---------- 大谱表（自绘 SVG）坐标 ----------
const S = 6 // 线间距
const STEP = S / 2 // 每音级 3px
const TREBLE_BOTTOM = 100 // 高音谱表底线 E4 的 y
const BASS_BOTTOM = TREBLE_BOTTOM + 36 // 低音谱表底线 G2 的 y
const STAFF_X1 = 40
const STAFF_X2 = 412
const NOTE_X = 60
const VIEW_W = 460
const VIEW_H = 200
const WI_E4 = WHITE_INDEX.get(64) ?? 0
const WI_G2 = WHITE_INDEX.get(43) ?? 0

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (SVGElement | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) node.append(child)
  return node
}

/** 音高在对应谱表上的纵坐标；diff 为相对谱表底线的音级步数（偶数 = 线位，用于画加线） */
function staffInfo(pitch: number): { y: number; diff: number; bottom: number } {
  const white = BLACK_PCS.has(pitch % 12) ? pitch - 1 : pitch
  const wi = WHITE_INDEX.get(white) ?? 0
  if (pitch >= 60) {
    const diff = wi - WI_E4
    return { y: TREBLE_BOTTOM - diff * STEP, diff, bottom: TREBLE_BOTTOM }
  }
  const diff = wi - WI_G2
  return { y: BASS_BOTTOM - diff * STEP, diff, bottom: BASS_BOTTOM }
}

/**
 * 超出五线范围的线位补画加线（谱表五线线位为 0/2/4/6/8，相对底线）。
 * 上方第一加线 diff=10，下方第一加线 diff=-2；符头两侧各留一小段，比符头略宽。
 */
function appendLedgerLines(g: SVGGElement, diff: number, bottom: number): void {
  const line = (d: number): void => {
    const y = bottom - d * STEP
    g.append(
      svgEl('line', {
        x1: String(NOTE_X - 9),
        x2: String(NOTE_X + 9),
        y1: String(y),
        y2: String(y),
      }),
    )
  }
  if (diff > 8) for (let d = 10; d <= diff; d += 2) line(d)
  else if (diff < 0) for (let d = -2; d >= diff; d -= 2) line(d)
}

interface PianoView {
  el: HTMLElement
  setPressed(pitches: readonly number[]): void
}

function buildPiano(): PianoView {
  const whites = el('div', { class: 'midi-debug__whites' })
  const blacks = el('div', { class: 'midi-debug__blacks' })
  const keyByPitch = new Map<number, HTMLElement>()

  for (const p of WHITE_PITCHES) {
    const key = el('div', { class: 'midi-debug__wkey', dataset: { pitch: p } })
    keyByPitch.set(p, key)
    whites.append(key)
  }
  for (const p of BLACK_PITCHES) {
    const i = WHITE_INDEX.get(p - 1) ?? 0
    // 黑键中心落在其左白键的右边界上
    const left = `calc((100% / 52) * ${i + 1} - (100% / 52) * 0.3)`
    const key = el('div', { class: 'midi-debug__bkey', dataset: { pitch: p }, style: { left } })
    keyByPitch.set(p, key)
    blacks.append(key)
  }

  let prev = new Set<number>()
  return {
    el: el('div', { class: 'midi-debug__piano' }, whites, blacks),
    setPressed(pitches) {
      const next = new Set(pitches)
      for (const p of prev) if (!next.has(p)) keyByPitch.get(p)?.classList.remove('is-pressed')
      for (const p of next) if (!prev.has(p)) keyByPitch.get(p)?.classList.add('is-pressed')
      prev = next
    },
  }
}

interface ScoreView {
  el: HTMLElement
  setNotes(pitches: readonly number[]): void
}

function buildScore(): ScoreView {
  const linesG = svgEl('g', { class: 'midi-debug__staff-lines' })
  for (let k = 0; k < 5; k++) {
    const ty = TREBLE_BOTTOM - k * S
    const by = BASS_BOTTOM - k * S
    linesG.append(
      svgEl('line', { x1: String(STAFF_X1), x2: String(STAFF_X2), y1: String(ty), y2: String(ty) }),
    )
    linesG.append(
      svgEl('line', { x1: String(STAFF_X1), x2: String(STAFF_X2), y1: String(by), y2: String(by) }),
    )
  }
  const clefG = svgEl(
    'text',
    {
      x: '6',
      y: String(TREBLE_BOTTOM - S),
      class: 'midi-debug__clef',
      'font-size': '54',
      'dominant-baseline': 'central',
    },
    '𝄞',
  )
  const clefF = svgEl(
    'text',
    {
      x: '10',
      y: String(BASS_BOTTOM - 3 * S),
      class: 'midi-debug__clef',
      'font-size': '42',
      'dominant-baseline': 'central',
    },
    '𝄢',
  )
  const notesG = svgEl('g', { class: 'midi-debug__snotes' })
  const svg = svgEl(
    'svg',
    { class: 'midi-debug__score-svg', viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, 'aria-hidden': 'true' },
    linesG,
    clefG,
    clefF,
    notesG,
  )

  return {
    el: el('div', { class: 'midi-debug__score' }, svg),
    setNotes(pitches) {
      notesG.replaceChildren()
      for (const p of pitches) {
        const { y, diff, bottom } = staffInfo(p)
        const g = svgEl('g', { class: 'midi-debug__snote' })
        appendLedgerLines(g, diff, bottom)
        g.append(
          svgEl('ellipse', {
            cx: String(NOTE_X),
            cy: String(y),
            rx: '7',
            ry: '4.6',
            class: 'midi-debug__shead',
          }),
        )
        notesG.append(g)
      }
    },
  }
}

/**
 * “MIDI 键盘”调试工具：识别连接电脑的 USB MIDI 键盘，按键时实时反馈——
 * 音名 chips（并显所有按住键）、88 键钢琴键盘点亮、大谱表上显示音符位置（只显不记）。
 * 与正常工具一样挂载到内容区，占据一个完整页面。
 * 依据设计文档 docs/development/design/20260905-debug-tools.md §4.3。
 */
export function mountMidiKeyboard(host: HTMLElement): () => void {
  const statusEl = el('div', { class: 'midi-debug__status' })
  const devicesEl = el('ul', { class: 'midi-debug__devices' })
  const keysEl = el('div', { class: 'midi-debug__keys' })
  const piano = buildPiano()
  const score = buildScore()
  const stageEl = el('div', { class: 'midi-debug__stage' }, keysEl, piano.el, score.el)
  const innerEl = el('div', { class: 'midi-debug__inner' }, statusEl, devicesEl, stageEl)
  host.append(el('div', { class: 'midi-debug' }, innerEl))

  let disposed = false
  let access: MIDIAccess | null = null
  const attachedInputs: MIDIInput[] = []
  /** 当前按住的键：pitch → velocity（Map 插入顺序即按下顺序） */
  const held = new Map<number, number>()

  function renderAll(): void {
    const pitches = sortedHeldPitches(held)
    keysEl.replaceChildren()
    if (pitches.length === 0) {
      keysEl.append(el('div', { class: 'midi-debug__note' }, '—'))
    } else {
      for (const p of pitches)
        keysEl.append(el('div', { class: 'midi-debug__key' }, midiNoteName(p)))
    }
    piano.setPressed(pitches)
    score.setNotes(pitches)
  }

  function deviceLabel(input: MIDIInput): string {
    const name = input.name?.trim() || '未命名设备'
    const manufacturer = input.manufacturer?.trim()
    return manufacturer ? `${manufacturer} ${name}` : name
  }

  function renderDevices(): void {
    devicesEl.replaceChildren()
    if (access === null) return
    const inputs = [...access.inputs.values()]
    if (inputs.length === 0) {
      devicesEl.append(
        el('li', { class: 'midi-debug__device midi-debug__device--empty' }, '（无）'),
      )
      return
    }
    for (const input of inputs) {
      devicesEl.append(el('li', { class: 'midi-debug__device' }, deviceLabel(input)))
    }
  }

  function onMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (data === null) return
    const ev = parseMidiMessage(data)
    if (ev === null) return
    if (ev.type === 'noteOn') held.set(ev.pitch, ev.velocity)
    else held.delete(ev.pitch)
    renderAll()
  }

  function detachInputs(): void {
    for (const input of attachedInputs) input.removeEventListener('midimessage', onMessage)
    attachedInputs.length = 0
  }

  function attachInputs(): void {
    detachInputs()
    if (access === null) return
    for (const input of access.inputs.values()) {
      input.addEventListener('midimessage', onMessage)
      attachedInputs.push(input)
    }
  }

  function sync(): void {
    if (access === null) return
    attachInputs()
    renderDevices()
    const count = access.inputs.size
    statusEl.textContent = count > 0 ? `已连接 · ${count} 台输入` : '未检测到 MIDI 设备'
  }

  const onStateChange = (): void => {
    if (!disposed) sync()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    detachInputs()
    if (access !== null) access.removeEventListener('statechange', onStateChange)
    access = null
  }

  statusEl.textContent = '连接中…'
  renderAll()

  if (typeof navigator.requestMIDIAccess !== 'function') {
    statusEl.textContent = '当前浏览器不支持 Web MIDI'
    renderDevices()
    return dispose
  }

  navigator
    .requestMIDIAccess({ sysex: false })
    .then((a) => {
      if (disposed) return
      access = a
      a.addEventListener('statechange', onStateChange)
      sync()
    })
    .catch((err: unknown) => {
      if (disposed) return
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        statusEl.textContent = 'MIDI 授权被拒绝'
      } else if (err instanceof DOMException && err.name === 'NotSupportedError') {
        statusEl.textContent = '当前浏览器不支持 Web MIDI'
      } else {
        statusEl.textContent = `MIDI 连接失败：${err instanceof Error ? err.message : String(err)}`
      }
    })

  return dispose
}
