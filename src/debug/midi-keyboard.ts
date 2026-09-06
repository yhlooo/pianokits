import { sortedHeldPitches } from '../core/midi/held-keys'
import { parseMidiMessage } from '../core/midi/input'
import { midiNoteName } from '../core/midi/note-name'
import { CONNECT_TIMEOUT_MS } from '../core/midi/connection'
import { el } from '../ui/dom'
import { chevronDownIcon, chevronUpIcon } from '../ui/icons'
import { BLACK_PCS, WHITE_INDEX, buildPiano } from '../ui/piano-keyboard'

// ---------- 大谱表（自绘 SVG）坐标 ----------
// 纵向全部由 S 推导（谱表高、轨间距、谱号、符头、视窗边距都按线间距的比例），
// 调整 S 即可整体缩放谱面；横向尺寸（卡片宽度）不随 S 变化。
const S = 12 // 线间距（staff space）
const STEP = S / 2 // 相邻音级（线↔间）的纵向间距
const STAFF_LINES = 5
/** 五线谱表高度 = 4 个线间距 */
const STAFF_H = (STAFF_LINES - 1) * S
/**
 * 大谱表两轨之间的净空取 6 个线间距（1.5 个谱表高）。
 * 出版级钢琴谱的两轨净空常见 5~8 个线间距（约 1.25~2 倍谱表高）；之前取 3 个偏小，
 * 两根谱表几乎黏在一起。取 6 个后中央 C 两侧加线位（距各自谱表 1 个线间距）仍有充足净空。
 */
const GRAND_GAP = 6 * S
/** 大谱表系统（两根谱表连同中间空隙）的纵向中心，兼作 SVG 视窗中心 → 画面恒上下居中 */
const SYSTEM_CY = 188
const TREBLE_TOP = SYSTEM_CY - (2 * STAFF_H + GRAND_GAP) / 2 // 高音谱表顶线（F5）
const TREBLE_BOTTOM = TREBLE_TOP + STAFF_H // 高音谱表底线（E4）
const BASS_TOP = TREBLE_BOTTOM + GRAND_GAP // 低音谱表顶线（A3）
const BASS_BOTTOM = BASS_TOP + STAFF_H // 低音谱表底线（G2）
const WI_E4 = WHITE_INDEX.get(64) ?? 0
const WI_G2 = WHITE_INDEX.get(43) ?? 0
const VIEW_W = 460 // 谱面宽度，不随 S 变化
// 谱表线两端与视窗边缘各留同样 2 单位空隙（左右对称 → 谱面在卡片内横向居中）；
// 最左端一根竖线纵向贯穿两根谱表（乐谱起始标记），谱号压在其后
const STAFF_X1 = 2
const STAFF_X2 = VIEW_W - 2
/** 乐谱起始竖线：与谱表线左端对齐 */
const START_BAR_X = STAFF_X1
/** 谱号横向中心：落在起始竖线之后、五线之上 */
const CLEF_CX = 48
/** 音符的横向中心：谱表线的横向正中 */
const NOTE_CX = (STAFF_X1 + STAFF_X2) / 2
const NOTE_RX = S * 0.7 // 符头半宽（随线间距等比）
const NOTE_RY = S / 2 // 符头半高 = 1 个线间距：三度刚好相切，不会糊成一团
/** 加线两端超出符头的余量 */
const LEDGER_PAD = NOTE_RX + S / 6
/** 二度音（纵向只差一个音级）符头的横向让位量：按记谱惯例向右错开一个符头宽以上 */
const SECOND_SHIFT = NOTE_RX * 2 + S / 6

// ---------- 八度记号（8va / 15ma / 8vb / 15mb） ----------
/**
 * 谱面**直接记写**的音高范围 C2–C6。超出这个范围的音改为降/升八度记写并标注八度记号，
 * 而不是无限往上补加线——否则为了容纳 88 键全音域，卡片上下要各留一百多个单位的空白。
 */
const DIRECT_MIN_PITCH = 36 // C2
const DIRECT_MAX_PITCH = 84 // C6
/** 八度档位 → 记号文本（下标 1 = 一个八度，2 = 两个八度） */
const OTTAVA_LABEL = ['', '8va', '15ma']
const OTTAVA_LABEL_BASSA = ['', '8vb', '15mb']
/** 符头墨迹到八度横线的距离 */
const OTTAVA_GAP = S * 0.5
/** 两档八度横线之间的间距 */
const OTTAVA_STACK = S * 1.1
/** 横线末端朝向音符的小竖钩长度 */
const OTTAVA_HOOK = S * 0.5
const OTTAVA_FONT = S * 0.85
/** 记号文本右对齐到此（横线左端） */
const OTTAVA_LABEL_X = NOTE_CX - 20
const OTTAVA_BAR_X1 = NOTE_CX - 14
const OTTAVA_BAR_X2 = NOTE_CX + 40
/**
 * 固定纵向窗口（不随按键变化，卡片高度恒定）：五线之外上下各留 5.5 个线间距净空——
 * 上方容下最高的记写音 C6 再叠两档八度记号（15ma 文本上沿约在顶线上方 4.6 S 处），
 * 下方对称容下 A0 的 15mb 记号（文本下沿约在底线下方 5.1 S 处）与低音谱号下缘。
 * 上下净空相等 → 大谱表系统在视窗内上下居中。
 */
const WINDOW_TOP = TREBLE_TOP - 5.5 * S
const WINDOW_BOTTOM = BASS_BOTTOM + 5.5 * S
/** 中央 C 及以上归高音谱表，以下归低音谱表（大谱表的常规分界） */
const TREBLE_MIN_PITCH = 60

/**
 * 谱号墨迹的目标外框（SVG 用户单位），按 SMuFL 字体 Bravura 的实测刻刀比例
 * （docs/development/reference/notation/clef-metrics.md，单位均为线间距 S）：
 * - 高音谱号墨迹总高 7.08 S：尾尖下探到**底线下 1.68 S**，上卷高出**顶线上 1.4 S**；
 * - 低音谱号墨迹高 3.64 S：下缘在**底线上 0.44 S**，上缘高出**顶线上 0.08 S**。
 * 谱号字形随回退字体差异很大（Bravura、Noto Music 等字体对 𝄞 / 𝄢 的字形比例各不相同），
 * 所以仍按实测墨迹以 contain 方式装进该框并居中——无论落到什么字体，两个谱号各自对五线的
 * 相对大小与越线量都锁定在上述刻刀比例；maxW 仅兜底，防止偏扁字形横向撑破谱号列。
 */
const CLEF_BOX = {
  treble: {
    top: TREBLE_TOP - 1.4 * S,
    bottom: TREBLE_BOTTOM + 1.68 * S,
    cx: CLEF_CX,
    maxW: 3.2 * S,
  },
  bass: {
    top: BASS_TOP - 0.08 * S,
    bottom: BASS_BOTTOM - 0.44 * S,
    cx: CLEF_CX,
    maxW: 4 * S,
  },
} as const

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
  if (pitch >= TREBLE_MIN_PITCH) {
    const diff = wi - WI_E4
    return { y: TREBLE_BOTTOM - diff * STEP, diff, bottom: TREBLE_BOTTOM }
  }
  const diff = wi - WI_G2
  return { y: BASS_BOTTOM - diff * STEP, diff, bottom: BASS_BOTTOM }
}

interface NotePlacement {
  y: number
  diff: number
  bottom: number
  /** 0 = 按实际音高记写；>0 = 标 8va/15ma（记写低 n 个八度）；<0 = 标 8vb/15mb（记写高 n 个八度） */
  ottava: number
}

/**
 * 音高 → 谱面落位。超出 C2–C6 的音**不往上补加线**，而是按记谱惯例移八度记写：
 * 高音往下移（标 8va / 15ma），低音往上移（标 8vb / 15mb），这样卡片高度恒定，
 * 88 键全音域都能表示且不用为极端音预留大片空白。
 */
function placeNote(pitch: number): NotePlacement {
  let ottava = 0
  if (pitch > DIRECT_MAX_PITCH) ottava = Math.ceil((pitch - DIRECT_MAX_PITCH) / 12)
  else if (pitch < DIRECT_MIN_PITCH) ottava = -Math.ceil((DIRECT_MIN_PITCH - pitch) / 12)
  return { ...staffInfo(pitch - 12 * ottava), ottava }
}

/**
 * 八度记号：横线（末端带朝向音符的小竖钩）+ 左端文本。
 * dir = -1 表示横线在音符上方（8va/15ma），+1 表示在下方（8vb/15mb）。
 * 多档并存时按档位由近及远堆叠；只存在高档位时它就占最近的一档。
 */
function drawOttava(
  g: SVGGElement,
  level: number,
  baseY: number,
  dir: -1 | 1,
  index: number,
): void {
  const y = baseY + dir * (OTTAVA_GAP + index * OTTAVA_STACK)
  const label = dir < 0 ? OTTAVA_LABEL[level] : OTTAVA_LABEL_BASSA[level]
  if (label === undefined) return
  g.append(
    svgEl(
      'text',
      {
        x: String(OTTAVA_LABEL_X),
        y: String(y),
        class: 'midi-debug__ottava',
        'font-size': String(OTTAVA_FONT),
        'text-anchor': 'end',
        'dominant-baseline': 'central',
      },
      label,
    ),
  )
  const bar = { class: 'midi-debug__ottava-bar' }
  g.append(
    svgEl('line', {
      ...bar,
      x1: String(OTTAVA_BAR_X1),
      x2: String(OTTAVA_BAR_X2),
      y1: String(y),
      y2: String(y),
    }),
  )
  const hookEnd = y - dir * OTTAVA_HOOK
  g.append(
    svgEl('line', {
      ...bar,
      x1: String(OTTAVA_BAR_X2),
      x2: String(OTTAVA_BAR_X2),
      y1: String(y),
      y2: String(hookEnd),
    }),
  )
}

/**
 * 超出五线范围的线位补画加线（谱表五线线位为 0/2/4/6/8，相对底线）。
 * 上方第一加线 diff=10，下方第一加线 diff=-2；符头两侧各留一小段，比符头略宽。
 * 加线跟随符头的实际 x（二度音会让位），否则加线会和符头错开。
 */
function appendLedgerLines(g: SVGGElement, diff: number, bottom: number, x: number): void {
  const line = (d: number): void => {
    const y = bottom - d * STEP
    g.append(
      svgEl('line', {
        x1: String(x - LEDGER_PAD),
        x2: String(x + LEDGER_PAD),
        y1: String(y),
        y2: String(y),
      }),
    )
  }
  if (diff > 8) for (let d = 10; d <= diff; d += 2) line(d)
  else if (diff < 0) for (let d = -2; d >= diff; d -= 2) line(d)
}

/** 量文字墨迹用的共享 canvas（measureText 是唯一能拿到真实墨迹范围的办法） */
let inkCtx: CanvasRenderingContext2D | null | undefined
function getInkCtx(): CanvasRenderingContext2D | null {
  if (inkCtx === undefined) {
    try {
      inkCtx = document.createElement('canvas').getContext('2d')
    } catch {
      inkCtx = null
    }
  }
  return inkCtx
}

/**
 * 把谱号的**墨迹**装进 CLEF_BOX（contain：同时受目标高与最大宽约束，墨迹在框内居中）。
 *
 * 必须量墨迹而不是 getBBox——getBBox 给的是字体 em 框，而谱号字形在 em 框里的占位差别
 * 极大（实测 𝄞 墨迹约 1.2em，𝄢 却只有约 0.6em）。按 em 框对齐会让低音谱号只有目标
 * 高度的一半、且明显偏高。canvas 的 actualBoundingBox* 才是真正的墨迹范围，用它对齐
 * 后无论落到 Bravura / Noto Music 还是系统回退字体，谱号都一样贴合自己的五线。
 *
 * 返回是否成功；失败（环境不支持 canvas 度量）时保留静态字号与初始位置。
 */
function fitClef(
  node: SVGTextElement,
  glyph: string,
  box: { top: number; bottom: number; cx: number; maxW: number },
): boolean {
  const ctx = getInkCtx()
  if (ctx === null) return false
  const family = getComputedStyle(node).fontFamily
  const ink = (fs: number): TextMetrics => {
    ctx.font = `${fs}px ${family}`
    return ctx.measureText(glyph)
  }
  const boxH = box.bottom - box.top
  const fs0 = Number(node.getAttribute('font-size') ?? '0')
  const m0 = ink(fs0)
  const h0 = m0.actualBoundingBoxAscent + m0.actualBoundingBoxDescent
  const w0 = m0.actualBoundingBoxLeft + m0.actualBoundingBoxRight
  if (!(h0 > 0) || !(w0 > 0)) return false
  // contain：受高、宽双重约束，取更小的缩放比（扁字形被宽度卡住，不会撑破谱号列）
  const fs1 = fs0 * Math.min(boxH / h0, box.maxW / w0)
  const m1 = ink(fs1)
  const h1 = m1.actualBoundingBoxAscent + m1.actualBoundingBoxDescent
  const w1 = m1.actualBoundingBoxLeft + m1.actualBoundingBoxRight
  if (!(h1 > 0)) return false
  // 用字母基线定位（去掉 dominant-baseline 干扰）：墨迹顶 = y - ascent
  node.removeAttribute('dominant-baseline')
  node.setAttribute('font-size', String(fs1))
  // 墨迹在框内上下居中
  node.setAttribute('y', String(box.top + (boxH - h1) / 2 + m1.actualBoundingBoxAscent))
  // text-anchor 为 start：墨迹左 = x - left，墨迹宽 = left + right
  node.setAttribute('x', String(box.cx - w1 / 2 + m1.actualBoundingBoxLeft))
  return true
}

interface ScoreView {
  el: HTMLElement
  setNotes(pitches: readonly number[]): void
}

function buildScore(): ScoreView {
  // 大谱表起始标记：一根竖线，在最左端纵向贯穿、连接两根谱表。
  // 端点各多伸出半个线宽，保证与最上/最下的谱表线平齐接缝。
  const startBar = svgEl('line', {
    x1: String(START_BAR_X),
    x2: String(START_BAR_X),
    y1: String(TREBLE_TOP - 1),
    y2: String(BASS_BOTTOM + 1),
    class: 'midi-debug__startbar',
  })

  const linesG = svgEl('g', { class: 'midi-debug__staff-lines' })
  for (let k = 0; k < STAFF_LINES; k++) {
    const ty = TREBLE_BOTTOM - k * S
    const by = BASS_BOTTOM - k * S
    linesG.append(
      svgEl('line', { x1: String(STAFF_X1), x2: String(STAFF_X2), y1: String(ty), y2: String(ty) }),
    )
    linesG.append(
      svgEl('line', { x1: String(STAFF_X1), x2: String(STAFF_X2), y1: String(by), y2: String(by) }),
    )
  }
  // 初始字号取 SMuFL 字号（1 em = 4 个线间距）、基线取谱号所指音线（第二线 G / 第四线 F）——
  // 对 SMuFL 字体这本身就是刻刀位；插入文档后再由 fitClef 按实测墨迹对齐 CLEF_BOX，
  // 使任意回退字体下的谱号大小/位置都一致。
  const CLEF_G = '𝄞'
  const CLEF_F = '𝄢'
  const clefG = svgEl(
    'text',
    {
      x: String(CLEF_CX),
      y: String(TREBLE_BOTTOM - S),
      class: 'midi-debug__clef',
      'font-size': String(4 * S),
    },
    CLEF_G,
  )
  const clefF = svgEl(
    'text',
    {
      x: String(CLEF_CX),
      y: String(BASS_BOTTOM - 3 * S),
      class: 'midi-debug__clef',
      'font-size': String(4 * S),
    },
    CLEF_F,
  )
  const notesG = svgEl('g', { class: 'midi-debug__snotes' })
  const ottavaG = svgEl('g', { class: 'midi-debug__ottavas' })
  const svg = svgEl(
    'svg',
    {
      class: 'midi-debug__score-svg',
      // 纵向窗口固定（WINDOW_TOP/BOTTOM），不随按键变化 → 卡片高度恒定
      viewBox: `0 ${WINDOW_TOP} ${VIEW_W} ${WINDOW_BOTTOM - WINDOW_TOP}`,
      'aria-hidden': 'true',
    },
    startBar,
    linesG,
    clefG,
    clefF,
    notesG,
    ottavaG,
  )

  let clefsFitted = false
  /** 谱号对齐需要实测墨迹，必须等 SVG 进入文档后再做；未成功就下次 setNotes 再试 */
  function ensureClefLayout(): void {
    if (clefsFitted) return
    clefsFitted = fitClef(clefG, CLEF_G, CLEF_BOX.treble) && fitClef(clefF, CLEF_F, CLEF_BOX.bass)
  }
  // 字体延迟就绪会改变谱号墨迹，就绪后重算一次（fitClef 幂等）
  void document.fonts.ready.then(() => {
    clefsFitted = false
    ensureClefLayout()
  })
  // fonts.ready 只覆盖首批字体；此后新装/懒加载的字体到达（loadingdone）同样要重算
  document.fonts.addEventListener('loadingdone', () => {
    clefsFitted = false
    ensureClefLayout()
  })

  return {
    el: el('div', { class: 'midi-debug__score' }, svg),
    setNotes(pitches) {
      ensureClefLayout()
      notesG.replaceChildren()
      ottavaG.replaceChildren()

      // 同一线/间只画一个符头：白键与其紧邻上方的黑键落位相同（此处不画临时记号）。
      // 若干音高落到同一位置（含移八度后重合），保留八度档位绝对值更大的那个。
      const byY = new Map<number, NotePlacement>()
      for (const p of pitches) {
        const spot = placeNote(p)
        const prev = byY.get(spot.y)
        if (prev === undefined || Math.abs(spot.ottava) > Math.abs(prev.ottava))
          byY.set(spot.y, spot)
      }
      // 按 y 递减（= 音高升序）绘制
      const list = [...byY.values()].sort((a, b) => b.y - a.y)

      let prevY = Number.NaN
      let prevShift = 0
      /** 各八度档位（1 = 八度，2 = 十五度）内符头的墨迹极值，用于决定八度横线的位置 */
      const altaTop = new Map<number, number>()
      const bassaBottom = new Map<number, number>()
      for (const { y, diff, bottom, ottava } of list) {
        // 二度音符头会糊成一团，按记谱惯例向右错开一个符头宽；同列内是三度间隔，恰好相切
        const isSecond = !Number.isNaN(prevY) && prevY - y <= STEP + 0.01
        const shift = isSecond ? (prevShift === 0 ? SECOND_SHIFT : 0) : 0
        const x = NOTE_CX + shift
        const g = svgEl('g', { class: 'midi-debug__snote' })
        appendLedgerLines(g, diff, bottom, x)
        g.append(
          svgEl('ellipse', {
            cx: String(x),
            cy: String(y),
            rx: String(NOTE_RX),
            ry: String(NOTE_RY),
            class: 'midi-debug__shead',
          }),
        )
        notesG.append(g)
        if (ottava > 0) altaTop.set(ottava, Math.min(altaTop.get(ottava) ?? Infinity, y - NOTE_RY))
        else if (ottava < 0) {
          const level = -ottava
          bassaBottom.set(level, Math.max(bassaBottom.get(level) ?? -Infinity, y + NOTE_RY))
        }
        prevY = y
        prevShift = shift
      }

      // 八度记号：高档位由近及远向上堆叠，低档位向下堆叠
      const alta = [...altaTop.keys()].sort((a, b) => a - b)
      alta.forEach((level, i) => drawOttava(ottavaG, level, Math.min(...altaTop.values()), -1, i))
      const bassa = [...bassaBottom.keys()].sort((a, b) => a - b)
      bassa.forEach((level, i) =>
        drawOttava(ottavaG, level, Math.max(...bassaBottom.values()), 1, i),
      )
    },
  }
}

/** 诊断面板行的颜色基调：ok 成功绿 / warn 琥珀提示 / bad 危险红 / neutral 常规 */
type DiagTone = 'ok' | 'warn' | 'bad' | 'neutral'

interface DiagRow {
  value: HTMLElement
}

/** 诊断面板追加一行（dt 标签 + dd 值） */
function addDiagRow(list: HTMLElement, label: string): DiagRow {
  list.append(el('dt', {}, label))
  const value = el('dd')
  list.append(value)
  return { value }
}

function setDiag(row: DiagRow, text: string, tone: DiagTone = 'neutral'): void {
  row.value.textContent = text
  row.value.dataset.tone = tone
}

/**
 * “MIDI 键盘”调试工具：识别连接电脑的 USB MIDI 键盘，按键时实时反馈——
 * 大谱表上显示音符位置（只显不记）、音名 chips（并显所有按住键）、88 键钢琴键盘点亮。
 * 三处反馈自上而下为：五线谱 / 音高符号 / 钢琴键盘。
 * 与正常工具一样挂载到内容区，占据一个完整页面。
 * 2026-09-06 起状态行下增加连接诊断面板（安全上下文 / API 可用性 / midi 权限 / 连接阶段），
 * 连接请求 5s 未返回时提示“连接超时”并可重试；各状态变化同时写入浏览器 Console
 * （前缀 `[midi-debug]`）。依据设计文档 docs/development/design/20260905-debug-tools.md §4.3
 * 与研究结论 docs/development/research/20260906-web-midi-connect-hang.md。
 */
export function mountMidiKeyboard(host: HTMLElement): () => void {
  const statusEl = el('div', { class: 'midi-debug__status' })
  // 连接诊断面板（安全上下文 / API / 权限 / 连接阶段）：默认折叠，由状态行右侧三角开关展开
  const diagEl = el('dl', { class: 'midi-debug__diag', hidden: true })
  const rowSecure = addDiagRow(diagEl, '安全上下文')
  const rowApi = addDiagRow(diagEl, 'Web MIDI API')
  const rowPerm = addDiagRow(diagEl, 'MIDI 权限')
  const rowPhase = addDiagRow(diagEl, '连接阶段')
  const diagToggle = el('button', {
    class: 'icon-btn midi-debug__diag-toggle',
    title: '展开详情',
    'aria-expanded': 'false',
  })
  diagToggle.append(chevronDownIcon())
  diagToggle.addEventListener('click', () => {
    const collapsed = diagEl.hidden
    diagEl.hidden = !collapsed
    diagToggle.replaceChildren(collapsed ? chevronUpIcon() : chevronDownIcon())
    diagToggle.title = collapsed ? '收起详情' : '展开详情'
    diagToggle.setAttribute('aria-expanded', String(collapsed))
  })
  const statusRow = el('div', { class: 'midi-debug__status-row' }, statusEl, diagToggle)
  const hintEl = el('div', { class: 'midi-debug__hint', hidden: true })
  const retryEl = el('button', { class: 'midi-debug__retry', hidden: true }, '重试连接')
  retryEl.addEventListener('click', start)
  const devicesEl = el('ul', { class: 'midi-debug__devices' })
  const keysEl = el('div', { class: 'midi-debug__keys' })
  const piano = buildPiano()
  const score = buildScore()
  // 自上而下：状态行（含折叠开关）→ 诊断面板 → 排查提示 → 重试 → 设备列表 → 五线谱 → 音高符号 → 钢琴键盘
  const stageEl = el('div', { class: 'midi-debug__stage' }, score.el, keysEl, piano.el)
  const innerEl = el(
    'div',
    { class: 'midi-debug__inner' },
    statusRow,
    diagEl,
    hintEl,
    retryEl,
    devicesEl,
    stageEl,
  )
  host.append(el('div', { class: 'midi-debug' }, innerEl))

  let disposed = false
  let access: MIDIAccess | null = null
  const attachedInputs: MIDIInput[] = []
  /** 当前按住的键：pitch → velocity（Map 插入顺序即按下顺序） */
  const held = new Map<number, number>()
  /** Permissions API 查询到的 midi 权限对象（change 事件实时刷新诊断面板） */
  let permStatus: PermissionStatus | null = null
  let permState: PermissionState | null = null
  /** 连接尝试序号：dispose / 重试时自增，作废在途的授权请求结果 */
  let attempt = 0
  let requestStart = 0
  let pending = false
  let timedOut = false
  let elapsedTimer: number | undefined
  let timeoutTimer: number | undefined

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
    setStatus(count > 0 ? `已连接 · ${count} 台输入` : '未检测到 MIDI 设备')
    setDiag(
      rowPhase,
      count > 0 ? '已连接，监听按键中' : '已授权，未检测到输入设备（插入设备后自动刷新）',
      count > 0 ? 'ok' : 'neutral',
    )
  }

  function setStatus(text: string): void {
    statusEl.textContent = text
  }

  function setHint(text: string | null): void {
    hintEl.textContent = text ?? ''
    hintEl.hidden = text === null
  }

  function clearTimers(): void {
    if (elapsedTimer !== undefined) {
      clearInterval(elapsedTimer)
      elapsedTimer = undefined
    }
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
      timeoutTimer = undefined
    }
  }

  function elapsed(): number {
    return (performance.now() - requestStart) / 1000
  }

  /** 连接阶段行：请求中实时显示耗时与权限状态，帮助定位“一直连接中” */
  function updatePhase(): void {
    if (!pending) return
    const sec = elapsed()
    let text = `请求授权中（已 ${sec.toFixed(1)}s）`
    if (timedOut) text += ` · 已超过 ${CONNECT_TIMEOUT_MS / 1000}s 超时阈值`
    let tone: DiagTone = timedOut ? 'warn' : 'neutral'
    if (permState === 'prompt') {
      text += ' · 等待用户应答授权提示'
      if (!timedOut) {
        setHint('浏览器应已弹出 MIDI 授权提示，请选择允许；若未看到弹窗，点击地址栏左侧的权限图标')
      }
    } else if (permState === 'granted') {
      text += ' · 已授权，等待浏览器返回设备列表'
    } else if (permState === 'denied') {
      text += ' · 权限已被拒绝，浏览器将很快返回错误'
      tone = 'bad'
    }
    setDiag(rowPhase, text, tone)
  }

  /**
   * 发起一次连接尝试：`requestMIDIAccess` 的 Promise 可能长时间不落定（授权提示未应答、
   * 浏览器/系统 MIDI 服务异常等，见研究文档 20260906-web-midi-connect-hang.md）。
   * 因此启动 5s 计时器先行提示“连接超时”（不放弃在途请求，晚到的结果仍按真实状态呈现），
   * 并实时刷新阶段行耗时——避免“连接中…”无限期悬挂且无任何线索。
   */
  function start(): void {
    if (disposed || typeof navigator.requestMIDIAccess !== 'function') return
    const myAttempt = ++attempt
    clearTimers()
    timedOut = false
    pending = true
    requestStart = performance.now()
    retryEl.hidden = true
    setHint(null)
    setStatus('连接中…')
    setDiag(rowPhase, '正在请求授权…')
    console.info('[midi-debug] 发起 requestMIDIAccess({ sysex: false })')
    elapsedTimer = window.setInterval(updatePhase, 200)
    timeoutTimer = window.setTimeout(() => {
      if (disposed || attempt !== myAttempt || !pending) return
      timedOut = true
      console.warn(`[midi-debug] 连接超过 ${CONNECT_TIMEOUT_MS / 1000}s 仍未返回`)
      setStatus('连接超时')
      updatePhase()
      setHint(
        '授权请求 5s 未返回：请确认浏览器是否弹出了 MIDI 授权提示（地址栏左侧权限图标），' +
          '或在 chrome://settings/content/midiDevices 查看本站点权限；若权限无异常，' +
          '打开 chrome://device-log 查看系统 MIDI 设备枚举日志；' +
          '若页面嵌在 iframe，宿主需通过 Permissions-Policy 允许 midi。点击“重试连接”可再次发起请求。',
      )
      retryEl.hidden = false
    }, CONNECT_TIMEOUT_MS)
    void navigator.requestMIDIAccess({ sysex: false }).then(
      (a) => {
        if (disposed || attempt !== myAttempt) return
        clearTimers()
        pending = false
        console.info(
          `[midi-debug] requestMIDIAccess 返回：inputs=${a.inputs.size} outputs=${a.outputs.size}` +
            `（耗时 ${elapsed().toFixed(1)}s）`,
        )
        access = a
        a.addEventListener('statechange', onStateChange)
        sync()
        if (timedOut) {
          setDiag(
            rowPhase,
            `授权在 ${elapsed().toFixed(1)}s 后返回（超过 5s 超时阈值，最终成功）`,
            'ok',
          )
          setHint(null)
        }
      },
      (err: unknown) => {
        if (disposed || attempt !== myAttempt) return
        clearTimers()
        pending = false
        handleError(err)
      },
    )
  }

  function handleError(err: unknown): void {
    const name = err instanceof DOMException ? err.name : 'Error'
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `[midi-debug] requestMIDIAccess 失败：${name}${message ? `：${message}` : ''}`,
      err,
    )
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      setStatus('MIDI 授权被拒绝')
      setDiag(
        rowPhase,
        '失败：NotAllowedError（用户拒绝 / 站点权限被屏蔽 / Permissions-Policy 不允许）',
        'bad',
      )
      setHint(
        '请在浏览器站点设置中把 MIDI 权限改为“允许”（chrome://settings/content/midiDevices），然后点击“重试连接”。',
      )
    } else if (err instanceof DOMException && err.name === 'NotSupportedError') {
      setStatus('当前浏览器不支持 Web MIDI')
      setDiag(rowPhase, '失败：NotSupportedError（浏览器或系统不支持 Web MIDI）', 'bad')
      setHint(null)
    } else {
      setStatus(`MIDI 连接失败：${message}`)
      setDiag(rowPhase, `失败：${name}${message ? `：${message}` : ''}`, 'bad')
      setHint(null)
    }
    // 不支持时重试无意义；其余失败都可以重试
    retryEl.hidden = err instanceof DOMException && err.name === 'NotSupportedError'
  }

  /** 经 Permissions API 查询 midi 权限并订阅变化（诊断面板“MIDI 权限”行） */
  function queryPermission(): void {
    if (typeof navigator.permissions?.query !== 'function') {
      setDiag(rowPerm, '不可用（本浏览器不支持 Permissions API）', 'warn')
      return
    }
    setDiag(rowPerm, '查询中…')
    void navigator.permissions
      .query({ name: 'midi' })
      .then((ps) => {
        if (disposed) return
        permStatus = ps
        applyPermState(ps.state)
        ps.addEventListener('change', onPermChange)
      })
      .catch((err: unknown) => {
        if (disposed) return
        console.warn('[midi-debug] 查询 midi 权限失败', err)
        setDiag(rowPerm, `查询失败（${err instanceof Error ? err.name : String(err)}）`, 'warn')
      })
  }

  function applyPermState(state: PermissionState): void {
    permState = state
    console.info(`[midi-debug] midi 权限状态：${state}`)
    setDiag(
      rowPerm,
      state === 'granted'
        ? '已授权'
        : state === 'prompt'
          ? '待定（首次使用需应答浏览器授权提示）'
          : '已拒绝',
      state === 'granted' ? 'ok' : state === 'denied' ? 'bad' : 'neutral',
    )
    updatePhase()
  }

  const onPermChange = (): void => {
    if (disposed || permStatus === null) return
    applyPermState(permStatus.state)
  }

  const onStateChange = (): void => {
    if (!disposed) sync()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    attempt++
    clearTimers()
    detachInputs()
    if (access !== null) access.removeEventListener('statechange', onStateChange)
    access = null
    permStatus?.removeEventListener('change', onPermChange)
    permStatus = null
  }

  // —— 初始渲染与诊断信息 ——
  setStatus('连接中…')
  renderAll()
  setDiag(
    rowSecure,
    window.isSecureContext ? '是（HTTPS / localhost）' : '否——非安全上下文无法使用 Web MIDI',
    window.isSecureContext ? 'ok' : 'bad',
  )
  queryPermission()

  if (typeof navigator.requestMIDIAccess === 'function') {
    setDiag(rowApi, '可用', 'ok')
    setDiag(rowPhase, '尚未发起请求')
    start()
  } else {
    setDiag(rowApi, '缺失——当前浏览器不支持 Web MIDI（如 Safari）', 'bad')
    setDiag(rowPhase, '未发起请求')
    setStatus('当前浏览器不支持 Web MIDI')
    setHint(
      window.isSecureContext
        ? 'Safari 等浏览器不支持 Web MIDI，请换用 Chrome / Edge / Firefox。'
        : '当前页面不是安全上下文（需 HTTPS 或 localhost），请改用受支持的地址访问。',
    )
    renderDevices()
  }

  return dispose
}
