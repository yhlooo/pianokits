# 设计：「MIDI 键盘」调试工具增加按键力度与踏板信息

- 日期：2026-09-12
- 状态：**正式生效（与实现一致）**。2026-09-12 初版实现（同日草案 draft1 → draft2 → 生效）；
  同日按试用反馈修订（D4）：踏板**按钢琴实际位置从左到右排列**（弱音 67 / 选择延音 66 / 延音 64）、
  音名方块增加**随力度加深的半透明白底**、**去掉踏板行说明文本**、踏板方块**只留数值（去掉 CC 号字样）**、
  力度与踏板数值字号放大到 2 倍；随后按第二轮反馈（D5）收敛：力度/踏板数值**收到 2 倍的 80%**、
  chip 去掉为角标预留的横向空间并把内边距收到 `12px 18px`（音名保持居中、整体收小）、
  力度→视觉强度改为**幂曲线 `I=(v/127)^0.4`**（依据 MIDI 力度—音量平方律的感知逆曲线，见研究文档 §2.1）。
  其余口径：力度数值只进音名方块（五线谱完全不变）；踏板三格恒显；幅度方块为
  **中间大字百分比 + 右上角原始值 + 绿色背景表达触发与深度**；调试页**迁移到共享
  `MidiConnection`**；键盘键色透明度 0.35→1.0；不设指示灯（触发由绿色背景表达）。
- 关联调查结论：`docs/development/research/20260912-web-midi-velocity-and-pedal.md`（下称 **R-VP**）
- 关联参考：`docs/development/reference/midi/webmidi-api.md`
- 影响文档（实施时同步）：`docs/development/design/20260905-debug-tools.md`（§1.3 非目标、§3.3 接口、
  §4.3 页面内容、§5 解析规则、§6 资源释放）、`docs/development/design/20260906-midi-keyboard-and-practice.md`
  （§3.1 共享接入层接口）

## 1. 需求（用户原话拆解 + 已确认决策）

| #   | 需求                                                           | 落地口径                                                                                                                       |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| R1  | 力度数值显示在**音高方块（如 C4）内的右上角**                  | 仅页面中部的音名 chip；左侧大字为音名，右上角为力度整数 0–127（字号 2 倍）                                                     |
| R2  | 力度**同时**体现在音高方块的亮度上（越大越亮）                 | chip 文字与角标亮度随力度增强（`0.55 → 1.0`），并叠加随力度加深的半透明白底（`0.04 → 0.22`）                                   |
| R3  | 力度体现在**键盘按键颜色的深度**上（越大越深，可用透明度）     | 88 键键盘按下键用琥珀色叠加，**不透明度 `0.35 → 1.0`**                                                                         |
| R4  | 踏板信息在**音高信息下方单独一行**                             | 新的独立一行，排在音名 chips 与钢琴键盘之间；**按钢琴从左到右排列**（弱音/选择延音/延音），无说明文本                          |
| R5  | 不支持幅度 → 三个踏板用**三盏指示灯**（亮 = 踩下）             | **改为**：三格恒显数值，踩下由绿色背景表达（不另设灯，见 §4.2）                                                                |
| R6  | 支持幅度 → 三个**方块**，内显幅度值，边框与字体越亮 = 踩得越深 | **中间大字百分比、右上角原始 0–127 值（无 CC 号字样）；绿色背景表达触发与深度**                                                |
| D1  | 五线谱                                                         | **完全不变**（不写数字、不改墨色）——已确认                                                                                     |
| D2  | 踏板格子数量                                                   | **恒显 CC64/66/67 三格**——已确认                                                                                               |
| D3  | 接入层                                                         | 本次**顺带统一**：调试页迁移到共享 `MidiConnection`——已确认                                                                    |
| D4  | 试用反馈（2026-09-12）                                         | 踏板按钢琴左→右排列；chip 加随力度加深的半透明白底；去掉踏板说明文本与 CC 号字样；力度/踏板数值字号 2 倍                       |
| D5  | 试用反馈第二轮（2026-09-12）                                   | chip 收小（不加横向留位、内边距收紧、音名居中）且力度数值收到 80%；踏板右上角数值也收到 80%；力度→视觉强度改为幂曲线（非线性） |

力度的“深/浅”与“亮/暗”在物理上是同一个连续量（琥珀/文字叠加得越多 → 越深、越亮），
实现上只有一个来源：`velocityIntensity(v) = v / 127`（线性）。

## 2. 可行性结论（先说答案）

**可行，不需要任何新的 Web MIDI 能力**，但有两条必须承认的边界（依据 R-VP §4）：

1. **力度**：早已在 `MidiNoteEvent.velocity` 里（`src/core/midi/input.ts`），调试页拿到后只用于
   “是否按住”、丢掉了数值。纯渲染层缺口，零接入改动。
2. **踏板**：是 CC（`0xBn`），当前解析层**显式丢弃**（`input.ts` 第 36 行“其余 … 返回 null”），
   需新增 CC 事件分支；三个踏板 = **CC64 延音 / CC66 选择延音 / CC67 弱音**（R-VP §3）。
3. **踏板幅度**：规范**没有**设备能力查询接口（MIDI 传统靠厂商 Implementation Chart 声明），
   “是否支持”**只能观察消息值域**：
   - 出现过 `0/127` 之外的中间值 → 幅度确证（方块加琥珀描边标记，数值照显）；
   - 只见过端点值 → 只能表述为“未观察到幅度值”。
     这是**充分判据**：只见过端点值不等于“设备不支持”（用户没半踩时同样只发端点值）。
     UI 文案必须按此措辞（§4.4）。
4. 踏板“踩下”阈值沿用 MIDI 1.0 附录与项目既有实现：**`value >= 64` 为踩下**
   （`src/core/midi/quantize.ts` `buildSustainIntervals()` 同阈值，不能分叉）。

## 3. 架构设计

### 3.1 分层

```
core/midi/input.ts                 ← 消息解码：新增 CC 分支（纯函数、可单测）
  ├─ NoteOn / NoteOff（既有）
  └─ ControlChange（新增：channel / controller / value）
core/midi/pedals.ts                ← 新增：踏板领域纯逻辑（无 DOM）
  ├─ PEDALS：CC64/66/67 → 名称与顺序的唯一事实来源（数组顺序 = 钢琴踏板从左到右）
  ├─ PEDAL_ON_THRESHOLD = 64
  ├─ applyControlChange(...)：CC → PedalState（值 + 是否见过幅度值）
  ├─ isPedalDown / pedalMode / resetPedals
  └─ pedalLevelPercent(value)：0–127 → 0–100（显示用，唯一取整口径）
core/midi/connection.ts            ← 共享接入层：新增 onControl 回调 + 诊断用只读 getter
debug/midi-debug-state.ts          ← 新增：调试页的输入状态与视觉映射（无 DOM，可单测）
  ├─ DebugMidiState：多设备合并的按住键 Map<pitch, velocity> 与 CC Map<cc, PedalState>
  ├─ velocityIntensity(v)：0–127 → 0–1（视觉强度唯一来源）
  ├─ keyPressStyle(v)：→ { alpha, glow }（键盘按键深浅）
  └─ pedalBoxStyle(state)：→ { background, borderColor, color }（幅度方块）
debug/midi-keyboard.ts             ← 只做 DOM 绑定与渲染（接入改用 MidiConnection）
ui/piano-keyboard.ts               ← setPressed 改收 Map<pitch, velocity>
style.css                          ← 力度角标 / 踏板 LED / 踏板方块样式
```

**边界取舍说明**

- `held-keys.ts` 保持“按住键 → 升序音高列表”的单一职责，力度映射不塞进去；
- 力度的**视觉映射**是“调试页的呈现约定”，不是通用领域模型，放 `debug/`；
  踏板三件套（CC 号、阈值、幅度判据、百分比换算）是**领域事实**（将来练习模式用踏板延音直接受益），
  留在 `core/midi/`；
- `core/midi/connection.ts` 是主/调试共享的接入层，新增能力加在它上面而不是再造一份。

### 3.2 消息与踏板接口

先考虑过“包一层 `{ note, control }` 双字段”的写法，但类型收窄的现实约束否掉了它：
`ev.type === 'noteOn'` 收窄的只是被判别的那一个对象，**不会**传递到并存的 `note` 字段，
调用方仍要写 `if (ev.note !== null && ev.note.type === 'noteOn')` 这类冗余且易错的判断。
因此采用**单一判别联合**、把 CC 直接加进联合，靠 `type` 收窄：

```ts
// core/midi/input.ts —— 事件由“按键事件”升格为“通道事件联合类型”
export type MidiChannelEvent =
  | { type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; channel: number; pitch: number; velocity: number }
  | { type: 'controlChange'; channel: number; controller: number; value: number }
export function parseMidiMessage(data: Uint8Array): MidiChannelEvent | null
/** 兼容别名：练习模式/连接层只关心按键，继续用这个窄类型（原有 import 路径不变） */
export type MidiNoteEvent = Extract<MidiChannelEvent, { type: 'noteOn' | 'noteOff' }>
```

调用方只写一次判别，例如连接层：

```ts
const ev = parseMidiMessage(data)
if (ev === null) return
if (ev.type === 'controlChange') this.cbs.onControl?.(ev)
else this.cbs.onNote(ev)
```

```ts
// core/midi/pedals.ts
export type PedalId = 'sustain' | 'sostenuto' | 'soft'
export interface PedalDef {
  id: PedalId
  cc: number
  name: string
}
/** CC64 延音 / CC66 选择延音 / CC67 弱音 —— 数组顺序即 UI 显示顺序 */
export const PEDALS: readonly PedalDef[]
export const PEDAL_ON_THRESHOLD = 64

export interface PedalState {
  /** 最近一次收到的值 0–127 */
  value: number
  /** 是否出现过 0/127 之外的中间值 → 幅度模式（本次会话内锁定，不回退） */
  hasLevel: boolean
  /** 是否收到过该 CC 的任何消息（区分“没这个踏板”与“没踩过”） */
  seen: boolean
}
export function initialPedals(): ReadonlyMap<number, PedalState>
/** 纯函数：并入一条 CC（非踏板 CC 原样返回） */
export function applyControlChange(
  states: ReadonlyMap<number, PedalState>,
  controller: number,
  value: number,
): ReadonlyMap<number, PedalState>
export function isPedalDown(s: PedalState): boolean
export function pedalMode(s: PedalState): 'indicators' | 'level'
/** 显示用百分比：round(value / 127 × 100)，即 127 → 100% */
export function pedalLevelPercent(value: number): number
```

```ts
// debug/midi-debug-state.ts
export interface DebugSnapshot {
  /** 按住键：pitch → velocity */
  held: ReadonlyMap<number, number>
  pedals: readonly { def: PedalDef; state: PedalState }[]
  /** 踏板行说明文本（未收到消息 / 开关式 / 幅度式） */
  pedalHint: string
}
export class DebugMidiState {
  feed(ev: MidiChannelEvent): DebugSnapshot
  clearInputs(): DebugSnapshot // 设备全部断开时复位
}
/** 0–127 → 0–1（线性；所有视觉强度的唯一来源） */
export function velocityIntensity(velocity: number): number
/** 键盘按键视觉：不透明度 0.35–1.0 + 光晕 0–0.6 */
export function keyPressStyle(velocity: number): { alpha: number; glow: number }
/** 幅度方块视觉：绿色背景/边框/文字三者的不透明度都随 value 增大 */
export function pedalBoxStyle(value: number): {
  background: string
  borderColor: string
  color: string
}
```

```ts
// ui/piano-keyboard.ts
export interface PianoView {
  el: HTMLElement
  /** 按下态：pitch → velocity（力度驱动色深；缺省 127 = 最浓） */
  setPressed(pressed: ReadonlyMap<number, number>): void
  /** 逐键点亮态（瀑布流）：语义不变 */
  setLit(lit: ReadonlyMap<number, PianoLit>): void
}
```

> 为什么 `setPressed(Map)` 而不是新开 `setPressedVelocities` 或加第四参数：调用点只有调试页一处，
> `Map<pitch, velocity>` 正是它已有的状态；同时把琥珀基础渐变收进 `piano-keyboard.ts`
> （与 `WHITE_BASE`/`BLACK_BASE` 同处），避免“CSS 的 `is-pressed` 一套色 + JS 另一套色”分叉。
> `setLit` 仍归瀑布流的逐帧点亮，职责不重叠（前者事件驱动，后者动画帧驱动）。

### 3.3 统一接入层（D3：已实施）

迁移前 `core/midi/connection.ts`（共享层）与 `debug/midi-keyboard.ts` 各自实现
“请求授权 / 挂载输入 / statechange / 解码回调”。诊断面板、5s 超时、重试、shim 识别这些能力
原本都长在调试页那份私有实现里，所以迁移不是“删代码”，而是把关注点拆清楚：

| 关注点                                               | 归属                              | 说明                           |
| ---------------------------------------------------- | --------------------------------- | ------------------------------ |
| 授权/挂载/热插拔/解码                                | `MidiConnection`（共享）          | 已有能力                       |
| CC 事件分发                                          | `MidiConnection` 的 `onControl?`  | 新增；练习模式不实现则行为不变 |
| 连接诊断数据（阶段耗时、权限状态、错误名、端口计数） | `MidiConnection` 暴露只读诊断视图 | 新增（见下）                   |
| 呈现（文案、诊断面板、重试按钮、Console 日志）       | `debug/midi-keyboard.ts`          | 保留在调试页                   |

`MidiConnection` 需要补的诊断表面（只加不删，练习模式不受影响）：

```ts
export interface MidiConnectionCallbacks {
  onStatus(status: MidiConnectionStatus): void
  onNote(ev: MidiNoteEvent): void
  /** 新增：控制变化（踏板等）；实现方不关心可不实现 */
  onControl?(ev: MidiControlChange): void
  onOutputs?(outputs: readonly MIDIOutput[]): void
}

export class MidiConnection {
  // …既有成员…
  /** 新增：请求发起时刻（performance.now()），调试页据此显示“已 N.Ns” */
  get requestStartedAt(): number | null
  /** 新增：失败原因名（NotAllowedError / NotSupportedError / 其它），供诊断行展示 */
  get errorName(): string | null
  /** 新增：端口计数（诊断面板“N 台输入”） */
  get inputCount(): number
  /** 新增：是否检测到第三方 Web MIDI shim（把现有 shim 判定从调试页下沉） */
  get isShimmed(): boolean
}
```

迁移后调试页保留：安全上下文 / API 可用性 / midi 权限（Permissions API 查询与 change 订阅）/
连接阶段实时耗时 / 5s 超时提示 + 重试 / shim 分支提示 / Console `[midi-debug]` 日志 / 设备列表 /
卸载释放。其中“5s 超时先提示、不放弃在途请求”的语义由调试页保留（`CONNECT_TIMEOUT_MS` 不动），
它与共享层的 `CONNECT_HINT_MS` 软提示是两套语义（前者是调试页的诊断阈值，后者是共享层的软提示）。

已实现的迁移细节：

- `MidiConnection` 新增 `onControl?` 回调（按键仍走 `onNote`）与只读诊断 getter
  `requestStartedAt` / `errorName` / `errorMessage` / `inputCount` / `isShimmed`；
- 新增 `reconnect()`：先 `dispose()` 再 `connect()`，用于调试页“重试连接”——
  在途授权请求可能永不落定，重试必须作废旧请求再发起新请求；
- shim 判定 `isShimmedMidi()` 从调试页下沉为 `connection.ts` 的导出函数（环境事实，谁都能用）；
- `MidiConnection` 用 `performance.now()` 记录请求发起时刻，供诊断面板显示“已 N.Ns”。

## 4. 交互与视觉

### 4.1 力度（R1/R2/R3，D1：谱面不变）

唯一映射源 `I = velocityIntensity(v) = v / 127`（线性）。**线性**的理由：调试工具的职责是如实
呈现 MIDI 值；任何曲线都会让“显示 64 却给出 0.8 的浓色”，妨碍判读。

| 出口               | 公式                                                   | 效果                                        |
| ------------------ | ------------------------------------------------------ | ------------------------------------------- |
| 音名 chip 角标数值 | 直接显示 `velocity`（0–127 整数）                      | 精确读数                                    |
| 音名 chip 亮度     | 音名与角标同为 `rgba(文本色, 0.50 + 0.50·I)`           | 力度小 → 字色浅，力度大 → 纯白（越大越亮）  |
| 音名 chip 底色     | `background-color: rgba(244, 241, 235, 0.03 + 0.27·I)` | 半透明白底随力度加深，整块面积都能看出强弱  |
| 钢琴键盘键色       | `alpha = 0.30 + 0.70·I`，`glow = 0.6·I`                | 力度 1 也是明显琥珀、力度 127 最浓 + 外发光 |
| 五线谱             | **不动**                                               | 按用户要求保持现状（谱面只表达音高）        |

音名 chip 结构：

```
┌──────────────────┐
│  C4          96  │   ← 音名居中；右上角力度 1.5rem（音名的 0.43 倍，tabular-nums）
└──────────────────┘
```

- chip `position: relative` + **对称内边距**（`12px 18px`，比 2 倍字号版收紧）：音名始终在方框正中；
- 角标用 `position: absolute; top: 5px; left: 0; right: 7px; text-align: right` 贴右上角，
  **不写 width、也不为它预留横向空间**——角标覆盖在音名 em 框的右上角，与墨迹几乎不重叠，
  因此方框尺寸与音名居中都不受角标影响（三位数 127 也放得下）。
- 力度是**按下瞬间**取一次的值（MIDI 键盘 Note On 之后不再更新力度），键按住期间数值恒定，
  这与设备行为一致，不需要定时器。

### 4.2 踏板行（R4/R5/R6，D2/D4：恒显三格）

- 位置：音名 chips 之后、钢琴键盘之前；三格 + 每格下方小字标签。
- **排列顺序 = 钢琴踏板从左到右**：弱音（CC67） / 选择延音（CC66） / 延音（CC64）。
  数组顺序即显示顺序（`PEDALS`），与 CC 号大小无关。
- 三格**始终存在**：没有该踏板时就是“淡一档 + 数值 0”，不会因为踏板数量变化而跳动。
- **不显示说明文本**（试用反馈第 3 条）：`pedalHint` 与其 DOM 已删除；三格的数值 + 绿色背景
  已足够表达状态，“未观察到幅度值”这类信息只在文档与 Console 日志里说明。

**为什么没有独立指示灯形态**：需求最初设想“不支持幅度 → 三盏指示灯”，但确认改为
“三格恒显 + 数值恒显”后，指示灯是冗余的——**踩下与否由绿色背景直接表达**（`value >= 64`
有背景、未触发没有），一眼可辨；再加一盏灯反而两套信号互相干扰。`pedalMode` 因此只用于
给“出现过幅度值”的格子加一圈琥珀细描边（`.is-level`），不作形态切换。

**幅度方块（三格恒显）**

```
┌────────────────┐
│           96   │   ← 右上角：原始 0–127 值（1rem、tabular-nums，不带 CC 号字样）
│      76%       │   ← 中间大字：百分比＝round(value/127×100)（1.5rem）
└────────────────┘
        延音          ← 格下方小字标签
```

- **数值恒显**（未触发也显示，已明确）：未触发时显示 `0%` + `0`；字号为初版的 1.6 倍
  （先按 D4 放大到 2 倍，再按 D5 收到 80%），方块 84×58；
- **背景 = 触发与深度**：`value < 64` → `transparent`（不触发就没有背景色）；
  `value >= 64` → 温和绿色（`--success`）且**越深表示踩得越深**：
  `background: rgba(90, 190, 130, 0.10 + 0.30 · (value-64)/63)`；
- **边框与字体亮度**随值增大：`border-color: rgba(90, 190, 130, 0.30 + 0.55·I)`、
  `color: rgba(244, 241, 235, 0.55 + 0.40·I)`；
- 方块宽度固定（84×58）、数字 `tabular-nums` → 数值变化不引起宽度抖动；
- `value = 64` 是触发边界（与 `PEDAL_ON_THRESHOLD` 同源，单测覆盖 63/64）。

### 4.3 三格状态的组合规则

| 情况                     | 该格显示                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| 未收到该 CC 的任何消息   | 方块内显示 `0%` / `0`，整体压暗（`.is-idle`）；不加琥珀描边         |
| 收到过消息、只见过端点值 | 同上（数值照显、不再压暗）；仍不加琥珀描边                          |
| 出现过中间值             | 方块加一圈琥珀细描边（`.is-level`），数值与绿色背景照常随 CC 值变化 |

三格始终存在、宽度固定（84×58），数值变化不会引起该行跳动；没有说明文本行。

### 4.4 语义边界（R-VP §4.2，仅文档与 Console 记录）

“只见过端点值”不等于“设备不支持该踏板有幅度”（可能只是没有半踩过）。这一语义边界
不再放在界面上（试用反馈第 3 条移除说明文本），而由本节与 Console 日志
（`[midi-debug] CC{n} = {v}`）承载；出现中间值时方块会加一圈琥珀描边（`.is-level`），
据此可确认已进入幅度模式。

### 4.5 多设备与复位

- 多设备同时接入 → **合并**为一份状态（按键按 pitch 去重，踏板按 CC 取最近值）；
- 设备全部断开（`statechange` → 0 台输入）→ 清空按键与踏板状态（避免幽灵踩下），
  诊断面板照旧显示“未检测到 MIDI 设备”；
- Console（`[midi-debug]` 前缀）新增：每个首次见到的 CC 打印
  `CC{controller} 首次收到（value={v}）`，便于用户反馈时取证。

### 4.6 视觉体系

只用现有令牌（`--accent` 琥珀 `#d9a45b`、`--success` 绿、`--text-0/1/2`、`--line`、`--r-md`），
不引入新色相；浅色文字/边框一律用同一令牌的 alpha 变体，遵循
`docs/development/design/20260905-ui-visual-style.md` 的乌木/象牙/琥珀体系。

两处颜色写字面量而非只用 var()（都要与 alpha 合成）：

- 踏板绿：`rgba(90, 190, 130, α)` 是 `--success: #7fb285` 同色系（更饱和一档，作“亮起”信号更清楚），
  α 由 `pedalFillAlpha` / `pedalBorderAlpha` / `pedalTextAlpha` 三个纯函数算出后写在行内样式上；
- 键盘琥珀：`piano-keyboard.ts` 的 `PRESS_RGB = [217,164,91]` 即 `--accent`，用既有 `mix()`/`rgba()`
  与键的基础渐变合成（与 `setLit` 同一套混合公式）。

## 5. 实施步骤（已完成）

| 步  | 内容                                                       | 关键产出                                                                                     | 规模            |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------- |
| 1   | `input.ts` 加 CC 分支；`MidiNoteEvent` 改为 `Extract` 别名 | CC64/66/67 解析 + 非 3 字节/系统消息仍返回 null                                              | ~20 行 + 测试   |
| 2   | 新增 `core/midi/pedals.ts`                                 | 三踏板定义、阈值、幅度判据、百分比                                                           | ~70 行 + 测试   |
| 3   | `connection.ts` 加 `onControl?` 与诊断 getter              | 共享层具备 CC 与诊断能力                                                                     | ~50 行 + 测试   |
| 4   | 新增 `debug/midi-debug-state.ts`                           | 力度映射、键盘/方块视觉、状态容器                                                            | ~110 行 + 测试  |
| 5   | `piano-keyboard.ts` 改 `setPressed(Map)`                   | 键盘深浅渲染                                                                                 | ~30 行          |
| 6   | `debug/midi-keyboard.ts` 迁移接入层 + 接线 UI              | 删除私有 requestMIDIAccess 流程，改由 `MidiConnection` + 诊断 getter 驱动；chip 角标、踏板行 | ~200 行（净减） |
| 7   | `style.css` 新样式                                         | chip 角标 / LED / 方块 / 说明文本                                                            | ~80 行          |
| 8   | 文档同步 + `typecheck` / `lint` / `test`                   | 见文首“影响文档”                                                                             | —               |

## 6. 验收标准（可测试）

**力度**

- 按下任意键：音名 chip 右上角显示该次 Note On 的力度整数（0–127）。
- 力度大时 chip 更亮（底色更深）、键盘键色更深；**低力度之间也要肉眼可辨**（v=1 与 v=20 的观感差
  不小于 v=100 与 v=127）；同一力度下白键/黑键“深浅”方向一致。
- 五线谱**完全不变**（无数字、无墨色变化）。

**踏板**

- 踩/放延音踏板：踏板行**第三格（延音）**的数值与绿色背景即时变化（左→右 = 弱音 / 选择延音 / 延音）。
- 幅度模式：百分比 = `round(value/127×100)`，右上角原始值同步；`value = 63/64` 分别对应无背景/有背景。
- 出现中间值后锁为幅度模式；踏板回到 0 后**不回退**。
- 未收到踏板消息时：三格显示 `0%` / `0` 且压暗，说明文本为“未收到踏板消息（CC64/66/67）”。
- 只发端点值时：说明文本为“踏板为开关式：未观察到幅度值（踩半程可再试）”。
- 拔掉设备：按键与踏板状态清空，无残留点亮。

**接入层迁移回归**

- 安全上下文 / API 可用性 / midi 权限 / 连接阶段耗时 / 5s 超时 + 重试 / shim 提示 / 设备列表
  / 卸载释放 逐项与迁移前一致（含 iPad Web MIDI shim 分支的人工核对）。
- 练习模式行为不变（`parseMidiMessage` 新增分支不影响 Note 事件；`MidiConnection.onNote` 语义不变）。

**工程**

- 纯逻辑（映射、判据、状态合并、百分比）均有单测；`pnpm test` / `pnpm typecheck` / `pnpm lint` 全绿。

## 7. 实施中落定的细节

- **不设指示灯/小圆点**：踩下的即时信号由方块绿色背景承担（见 §4.2 开头说明）；`pedalMode`
  退化为“加一圈琥珀描边”的标记，不再切换形态。
- **踏板顺序**：按钢琴实际位置左→右 = 弱音 / 选择延音 / 延音（`PEDALS` 数组顺序即显示顺序）。
- **不显示踏板说明文本**：`pedalHint` 纯函数与 `.midi-debug__pedal-hint` 节点均已删除。
- **力度角标与底色**：角标 1.5rem（2 倍的 80%）覆盖在音名 em 框右上角，chip 不为其预留横向空间、
  内边距对称（`12px 18px`）、音名居中；底色 `rgba(244, 241, 235, 0.03 + 0.27·I)` 随力度加深。
- **力度→强度为幂曲线**：`I = (v/127)^0.4`（`VELOCITY_CURVE_EXPONENT`），键盘 alpha 与 chip
  亮度/底色、踏板视觉同源；依据是 MIDI 力度—音量平方律（Dannenberg ICMC 2006）。
- **百分比取整**：`Math.round(value / 127 × 100)`，127 → 100%、126 → 99%、63/64 → 50%。
- **多设备合并**：不区分设备来源，按键按 pitch 去重、踏板按 CC 取最近值（与迁移前的调试页一致）。
- **按压光晕**：键盘按下键的琥珀光晕用 CSS `piano-press-glow` 呼吸动画（900ms 交替），
  明暗摆幅由 keyframes 读取元素当前的 `--press-alpha`——力度越大越亮；抬起时动画移除，
  由 `to` 帧平滑收束（不硬切）。
- **性能**：调试页用增量 chip 复用替代整段重建（按键时只改文本与颜色），踏板三格复用同一批 DOM；
  每收到一条消息重绘一次，无累积状态。
- **浏览器实测**：`scripts/probe-midi-debug-velocity-pedal.mjs`（假 Web MIDI 设备 + 真实 Chromium）
  逐项断言力度角标/亮度、键色深浅、三踏板三种状态与说明文案、抬起复原、谱面不随力度变化。
