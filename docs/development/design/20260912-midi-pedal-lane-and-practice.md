# 设计：瀑布流踏板轨道与踏板练习模式

- 日期：2026-09-12
- 状态：**正式生效（2026-09-12 实现）**
- 关联调查结论：`docs/development/research/20260912-midi-pedal-track-relationship.md`（下称 **R-Pedal**）
- 关联参考：`docs/development/reference/midi/format-and-libraries.md`（§1.8 SMF 轨道/通道、
  §2.1.1 @tonejs/midi 的 CC 处理）
- 前置设计：
  - `docs/development/design/20260906-midi-keyboard-and-practice.md`（练习模式基线：门控、ChordGate、分轨压暗）
  - `docs/development/design/20260905-waterfall-track-colors.md`、`20260905-ui-visual-style.md`（瀑布流视觉）
  - `docs/development/design/20260912-midi-debug-velocity-pedal.md`（三踏板 = CC64/66/67、阈值 `>= 64` 的来源）
- 影响文档（实施时同步）：`docs/usage/midi-player.md`；
  `20260906-midi-keyboard-and-practice.md`（`KeyFeedback` → `PracticeFeedback`、瀑布流反馈与练习范围一节）

## 1. 需求

用户原话拆解与落地口径：

| #   | 需求                                                                | 落地口径                                                                                                                      |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R1  | 瀑布流体现踏板**踩下事件与时值**                                    | 按踩下区间画颜色条（时值 = 条的高度，同音符条自下而上坠落）                                                                   |
| R2  | 按钢琴实际位置分**左中右**三列                                      | 左=弱音 CC67 / 中=选择延音 CC66 / 右=延音 CC64（复用 `PEDALS` 数组顺序，见 §3.3）                                             |
| R3  | 居中、条宽 ≈ 4 个白键、间隔 2 个白键                                | 三列总宽 16 个白键、整体水平居中；几何随键盘白键宽等比缩放（§3.4）                                                            |
| R4  | 固定**银白色**，与音符轨色区分                                      | 固定**银灰**渐变（无彩度、明度低于音符条；`#bcc0c6 → #80858c`，alpha 0.35），不随轨色/力度变化（D4）                          |
| R5  | **置于最底下**，不阻挡其它音符                                      | 绘制顺序：踏板条 → 音符条（音符在上层）；踏板条自身半透明以保持可辨                                                           |
| R6  | 条触到键盘上沿时，在**与键盘接触位置**显示明显银白光晕（表示触发）  | 判定线（= 键盘上沿）处该踏板列内的圆角矩形银白光斑（与踏板条同宽或略宽、以判定线为高度中心）；踩下期间常亮，抬起后 120ms 渐隐 |
| R7  | 练习模式增加踏板练习三选一：无踏板 / 延音 / 全部，**默认无踏板**    | `PedalPracticeMode = 'off' \\                                                                                                 | 'sustain' \\ | 'all'`，练习菜单内单选组，默认 `off` |
| R8  | 开启踏板练习时，按键**同时**正确踩下对应踏板才放行，否则阻塞        | 和弦放行条件 = 琴键条件 ∧ 该和弦要求的踏板全部处于踩下状态（踏板按**当前状态**判定，不要求"新鲜重踩"）                        |
| R9  | 踏板分音轨就只判练习轨、不分音轨就全判                              | 归属按**通道**（R-Pedal §5）：踏板通道 ⊆ 音符通道 → 按通道交集判定；否则视为全曲踏板、全部判定（§3.3）                        |
| R10 | 无需判定的踏板条颜色淡一点（同音符压暗）                            | 练习开启时：不在关注范围（模式 ∩ 练习轨通道）内的踏板条压暗；压暗条不显示触发光晕                                             |
| R11 | 踩错踏板 → 踏板条轨道与键盘交界处显示**红色**光晕（位置同正确触发） | 等待期间误踩"参与判定但本和弦不需要"的踏板即标红，红色光晕（同按错键的 `#e0695e`）覆盖同列银光，松开消失                      |

已确认决策（用户表述直接采用，不再另议）：

- **D1** 判定对象是"踏板踩下"（对应 R8 的"正确踩下"）；踏板抬起不作为阻塞条件（见 §6 非目标）；
- **D2** 踏板练习依附于分轨练习：没有轨开启练习时该设置不产生判定（选中非 off 模式会自动全开全部轨，
  避免"选了没反应"，见 §3.6）；
- **D3** 不需要判定的踏板"无需关注"，因此压暗条既不判定、也不显示触发光晕（避免误导）。

## 2. 结论（先说答案）

1. **踏板数据在格式层面属于通道、不属于轨道**（R-Pedal C1）：SMF 的 MTrk 只是时间流容器，
   一条轨可装 16 个通道的事件；@tonejs/midi 的 `Track.channel` 由轨内音符推导、CC 对象不含通道
   （R-Pedal C2）。因此"分音轨"落地为"**按通道归属**"，实测最常见的"多轨同通道、踏板只落在一轨"
   形态（R-Pedal C3）也能正确共享踏板。
2. **归属退化规则**：存在"落在无音符轨上的踏板事件"（纯控制轨，通道不可信）时退化为
   **全曲踏板**——任何练习轨都要判定，正是用户说的"不分音轨就都需要判定"。
3. **顺带修复既有 bug**：`parse.ts` 过去把 @tonejs/midi 的归一化 CC 值（0–1）直接当作 0–127 存入
   `SustainEvent.value`，而 `quantize.ts` 以 `>= 64` 判踩下 → 记谱的"踏板延长长音"从未生效。
   本次把值还原为 0–127（R-Pedal §6）。
4. 判定不改变走带状态机：仍由 `Transport` 冻结/放行，踏板只是**放行条件的与项**；
   `ChordGate` 增加踏板状态与误踩标记，`PracticeController` 把 CC 输入接进去。

## 3. 架构设计

### 3.1 分层与数据流

```
core/model.ts            ← Song.pedalEvents: PedalEvent[]（time / controller / value / trackIndex / channel）
core/midi/parse.ts       ← 采集 CC64/66/67（值还原 0–127、保留 trackIndex + 通道）
core/midi/pedals.ts      ← 踏板领域纯逻辑（已有 Web MIDI 判定 + 新增文件侧逻辑）
   ├─ PedalPracticeMode / pedalsForMode            练习模式 → 踏板集合
   ├─ PedalSegment / buildPedalSegments            CC 事件 → 踩下区间（时值）
   ├─ pedalChannelScope                            归属：通道集合 | null（全曲）
   ├─ PedalFocus / pedalFocus                      练习关注范围（判定踏板 + 通道）
   ├─ isSegmentFocused                             瀑布流压暗与判定共用的同一谓词
   └─ requiredPedalsAt                             和弦时刻要求踩下的踏板
core/midi/quantize.ts    ← 记谱延长改用 song.pedalEvents（按通道取 CC64 区间）
core/midi/chord-gate.ts  ← 判定：琴键条件 ∧ 要求踏板全部踩下 ∧ 无误踩
core/transport.ts        ← 门控和弦携带 requiredPedals / judgedPedals；暴露 pedalFocus
core/practice.ts         ← 模式状态、CC 输入接线、反馈（含误踩踏板）、UI 状态
ui/waterfall-view.ts     ← 踏板条绘制（置底）、触发银白光晕、误踩红晕、练习压暗
ui/piano-keyboard.ts     ← 新增导出 WHITE_KEY_COUNT（踏板条几何用白键宽）
ui/transport-view.ts     ← 练习菜单内"踏板练习"单选组
app.ts                   ← 组装：song.pedalEvents → waterfall.setPedals；练习 UI 状态 → 视图
```

**边界取舍**：

- 踏板"什么时候该踩"是**走带时间轴上的事实**，因此 `requiredPedalsAt` 的调用点在 `Transport`
  （它已经负责和弦分组与 `excused` 计算，`PracticeChord` 是它的对外契约）；
- 踏板"踩没踩"是**输入设备状态**，归 `ChordGate`（纯逻辑、可单测）；两者不互相引用；
- 归属/关注范围是**曲目与练习设置的纯函数**，放 `core/midi/pedals.ts`，Transport 与 UI 共用同一份
  结论（`pedalFocus`），避免两处规则分叉；
- 瀑布流只消费"分段 + 关注范围 + 误踩集合"，不重新解释踏板语义。

### 3.2 模型与解析（core/model.ts、core/midi/parse.ts）

```ts
/** 三踏板 CC 事件（CC64/66/67） */
export interface PedalEvent {
  /** 秒 */
  time: number
  /** 踏板控制器号：64 延音 / 66 选择延音 / 67 弱音 */
  controller: number
  /** 0~127（CC 第二数据字节；由 @tonejs/midi 的 0–1 归一化值还原） */
  value: number
  /** 来源轨道 index（对应 Song.tracks） */
  trackIndex: number
  /** 来源轨道通道（@tonejs/midi 由轨内音符推导；无音符轨为 0） */
  channel: number
}

export interface Song {
  // ……既有字段……
  /** 三踏板事件（合并所有非打击乐轨、按 time 排序），供瀑布流踏板轨道与练习判定 */
  pedalEvents: PedalEvent[] // 取代原 sustainEvents
}
```

解析要点：

- 三个踏板 CC（`PEDALS` 的 cc）全部采集，不再只取 CC64；打击乐轨照旧跳过；
- **值还原**：`Math.round(c.value * 127)`（@tonejs/midi 归一化为 0–1，见 R-Pedal §6 的 bug）；
- 保留 `trackIndex` 与 `t.channel`，供归属规则使用；
- 按 `time` 排序（与 notes 一致）。

### 3.3 踏板领域纯逻辑（core/midi/pedals.ts）

```ts
export type PedalPracticeMode = 'off' | 'sustain' | 'all'

/** 练习模式包含的踏板集合：off → ∅、sustain → {延音}、all → 三踏板 */
export function pedalsForMode(mode: PedalPracticeMode): ReadonlySet<PedalId>

/** 踩下区间（时值）：同踏板同通道的「踩下 → 抬起」；曲终未抬起 end = Infinity */
export interface PedalSegment {
  pedalId: PedalId
  channel: number
  trackIndex: number
  start: number
  end: number
}
export function buildPedalSegments(events: readonly PedalEvent[]): PedalSegment[]

/** 踏板数据归属：踏板通道集合；null = 全曲踏板（存在无法归属到音符通道的踏板事件） */
export function pedalChannelScope(
  segments: readonly PedalSegment[],
  tracks: readonly Track[],
): ReadonlySet<number> | null

/** 练习关注范围：参与判定的踏板 + 通道（null = 全曲，不按通道过滤） */
export interface PedalFocus {
  /** 参与判定的踏板 = 模式踏板集合（all 恒为三踏板；与文件里有没有该踏板的踩下事件无关） */
  pedals: ReadonlySet<PedalId>
  channels: ReadonlySet<number> | null
}
/** null = 练习未开启（踏板条正常显示、不判定）；非 null 但 pedals 为空 = 练习中但不关注任何踏板（全部压暗） */
export function pedalFocus(
  segments: readonly PedalSegment[],
  tracks: readonly Track[],
  practiceTracks: ReadonlySet<number>,
  mode: PedalPracticeMode,
): PedalFocus | null

/** 分段是否在关注范围内（瀑布流压暗、requiredPedalsAt 共用） */
export function isSegmentFocused(seg: PedalSegment, focus: PedalFocus): boolean

/**
 * 和弦时刻要求踩下的踏板：分段与 [time, time + windowSec] 有交集（覆盖和弦起点、或在此窗口内踩下）时，
 * 该踏板就是本和弦的要求。踏板按「当前状态」判定 → 早已踩住的长踏板自然满足，不需要重踩。
 */
export function requiredPedalsAt(
  segments: readonly PedalSegment[],
  time: number,
  focus: PedalFocus,
  windowSec: number,
): ReadonlySet<PedalId>
```

归属规则（`pedalChannelScope` + `pedalFocus`）：

```
noteChannels  = { 有音符的非打击乐轨的 channel }
pedalChannels = { 踏板分段所在轨的 channel }
pedalChannels ⊆ noteChannels ? 按通道归属（返回 pedalChannels） : 全曲（返回 null）

练习轨集合 P 的判定通道：
  scope === null        → null（全曲：任何通道的踏板都判定）
  否则                   → scope ∩ { t.channel : t ∈ P }；交集为空 → 该轨无踏板要求
判定踏板 = 模式踏板集合（off → ∅、sustain → {延音}、all → 三踏板）
           前提是该练习部分确有踏板数据（判定通道非空），否则判定踏板为空
```

> 「判定踏板」取模式口径而非「文件里出现过的踏板」：多数 MIDI 只有 CC64 数据，若按数据取交集，
> 「全部踏板练习」下额外踩弱音就没有任何反馈，红晕形同虚设。压暗只作用于**存在**的踏板条
> （没有数据的踏板本来就没有条），两者不冲突。

### 3.4 瀑布流踏板轨道（ui/waterfall-view.ts）

几何（与 `keyGeometry` 同一白键宽口径，随窗口宽度等比缩放）：

```
白键宽 keyW = 总宽 / 52
条宽 = 4 × keyW            间隔 = 2 × keyW
组宽 = 3 × 4 × keyW + 2 × 2 × keyW = 16 × keyW
组左 = (总宽 − 组宽) / 2 = 18 × keyW
第 i 列（左→右 = 弱音 / 选择延音 / 延音）左边缘 = 组左 + i × 6 × keyW
```

- 竖向与音符条同一映射：条底 = 踩下时刻、条顶 = 抬起时刻，落进可视区才画；
- 颜色固定银灰、**上下渐变**：顶 `rgb(188,192,198)` → 底 `rgb(128,133,140)`，不透明度 0.35，
  顶部 1px 高光（`rgba(255,255,255,0.22)`）；同一高度左右一致，不做横向渐变（D5 试过"均匀单色 +
  左右窄渐变"，D6 按试用反馈改回上下渐变）；
- 不随轨色、力度变化；**只画事件条本身**——不画列底衬/轨道背景，没有踏板事件的列与无踏板曲目
  在画布上没有任何踏板痕迹；
- **绘制顺序：踏板条 → 音符条 → 判定区琥珀光带 → 踏板光晕 → 键盘点亮**。
  即踏板条"置于最底下"（音符永远压在其上，不被遮挡）；踏板光晕是触发信号，画在最上层以保证可见；
- 无踏板数据时整条轨道不出现（连底衬也没有）；三列位置由"事件条出现在哪一列"体现。

光晕（判定线 = 键盘上沿，画布底边）：

| 状态                       | 表现                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| 文件踏板踩下中（关注内）   | 该列底部 14px 银白渐变光带（`rgba(232,238,246,0 → 0.75)`）+ 底边 2px 亮线 + 外发光 |
| 抬起后 120ms               | 同款光晕按剩余时间线性渐隐                                                         |
| 练习中该踏板无需关注       | **不显示**（条已压暗）                                                             |
| 误踩（练习等待中的错踏板） | 同位置红色光晕 `#e0695e`（不透明度 0.95），覆盖同列银光；松开立即消失              |

练习压暗：`setPedalFocus(focus)`，`focus === null` → 全部正常；否则 `!isSegmentFocused(seg, focus)`
的条用 0.14 不透明度绘制（正常 0.35），与音符的分轨压暗语义一致。

### 3.5 练习判定（core/transport.ts、core/midi/chord-gate.ts、core/practice.ts）

**Transport**（走带，持有曲目与门控轨）：

```ts
/** 踏板要求和弦窗口（秒）：和弦起点后此时长内的踩下/持续踩下计为该和弦的要求 */
export const PEDAL_CHORD_WINDOW_SEC = 0.12

export interface PracticeChord {
  start: number
  notes: Note[]
  excused: ReadonlySet<number>
  /** 本和弦要求的踏板（判定范围内、文件在该和弦处处于踩下状态） */
  requiredPedals: ReadonlySet<PedalId>
  /** 本和弦参与判定的踏板（练习模式 ∩ 练习范围）：等待期间误踩这些踏板判错 */
  judgedPedals: ReadonlySet<PedalId>
}

class Transport {
  /** 当前踏板关注范围；null = 分轨练习未开启 */
  get pedalFocus(): PedalFocus | null
  /** 设置踏板练习模式（off/sustain/all）：变化时取消当前等待并按新范围重新进入 */
  setPedalPracticeMode(mode: PedalPracticeMode): void
}
```

- `load(song)` 时 `buildPedalSegments(song.pedalEvents)`；门控集合或模式变化时重算 `pedalFocus`；
- `tryPrimeChord()` 收集和弦时一并计算 `requiredPedals` / `judgedPedals` 放进 `PracticeChord`；
- 模式为 `off`、或练习轨与踏板通道无交集时，`pedalFocus = { pedals: ∅, channels: null }`：
  和弦不带任何踏板要求（等价于当日行为），瀑布流全部压暗。

**ChordGate**（判定，纯逻辑）：

```ts
class ChordGate {
  /** 当前踩下的踏板（值 >= 64；踏板状态跨和弦保持——延音踏板可以一直踩着） */
  private readonly heldPedals = new Map<PedalId, number>()
  /** 等待期间误踩的、参与判定但本和弦不需要的踏板（松开即清除） */
  private readonly wrongPedals = new Set<PedalId>()

  get wrongPedalKeys(): ReadonlySet<PedalId>
  /** 处理一条 CC；返回 true = 本次事件使放行条件满足 */
  control(ev: MidiControlChange): boolean
  /** 设备断开/卸载：清空踏板状态（按住键的语义不变） */
  resetPedals(): void
  setChord(
    pitches: ReadonlySet<number> | null,
    excused?: ReadonlySet<number>,
    requiredPedals?: ReadonlySet<PedalId>,
    judgedPedals?: ReadonlySet<PedalId>,
  ): boolean
}
```

判定规则（在既有琴键规则之上叠加）：

1. **要求踏板**：`requiredPedals` 中的每个踏板当前必须处于踩下状态（`heldPedals`），
   否则不放行——位置冻结在判定线等待，踩下即放行；
2. **踏板按状态判定，不按"新鲜踩下"**：与琴键不同（同音重复必须重按），踏板允许跨和弦一直踩着；
   和弦开始时已踩住的踏板直接计入满足，不要求重踩；
3. **误踩**：等待期间**新踩下**参与判定、但不在 `requiredPedals` 里的踏板 → 记红（`wrongPedals`），
   松开即清除；与按错键一致，红显同样阻止放行（纠错后立即重新评估）；
4. **不参与判定的踏板**（不在 `judgedPedals`：模式外、或不在练习轨通道范围内的踏板）完全忽略——
   不标红、不阻塞，也不满足任何要求；
5. `setChord()` 清空误踩标记（新和弦重新评估）；`heldPedals` 跨和弦保持，仅在设备断开/卸载时复位；
6. 判定踏板集合由 `PracticeChord.judgedPedals` 随和弦下发（= 当前模式 ∩ 练习范围；见 §3.3）。

**PracticeController**（编排）：

- 订阅 `MidiConnection.onControl`：`gate.control(ev)` → 满足则 `releaseChord()`，否则更新反馈；
  未开启练习时也照常并入踏板状态（进入练习时能识别"踏板已经踩着"）；
- `setPedalPractice(mode)`：写入模式并推给 `Transport`；从 `off` 切到非 off 且当前没有任何轨在练时
  **自动全开全部轨**（D2）；模式变化与分轨开关一样自动暂停播放；断开/拔出时清空踏板状态与模式外发；
- `PracticeUiState` 增加 `pedalMode` 与 `pedalFocus`（`active` 为真时取自 `Transport`），
  `onFeedback` 的反馈类型 `KeyFeedback` → `PracticeFeedback`（新增 `wrongPedals`）。

### 3.6 UI（ui/transport-view.ts）

练习菜单（原有的轨列表）下方新增一段"踏板"单选组（文案为 D8 试用反馈后的最终版）：

```
┌ 练习音轨 ─────────────┐
│ 仅对选择开启的音轨进行按键判定 │   ← 分组说明小字
│ ▮ Melody          ●   │
│ ▮ Bass            ○   │
├ 踏板 ─────────────────┤
│ ○ 关                  │   ← 默认
│ ○ 仅延音踏板          │
│ ○ 全部踏板            │
└───────────────────────┘
```

- 原生 `<input type="radio" name="pedal-practice">`（用户要求单选框），`accent-color: var(--accent)`；
- 未连接 MIDI 键盘时与轨行一致置灰禁用；
- 点击 → `onPedalPractice(mode)` → 控制器（菜单不收起，和轨行一致）；
- 切换模式会写入 `Transport` 并暂停播放（与分轨开关一致）。

## 4. 验收

**瀑布流（R1–R6）**

- 载入含 CC64 的曲目：瀑布流中央出现三列踏板轨道（左弱音 / 中选择延音 / 右延音），
  条宽 = 4 白键、间隔 = 2 白键、整体居中；缩放窗口时随白键宽等比缩放；
- 踏板条为固定银灰（接近灰度、不抢眼），与音符轨色明显区分；音符条绘制在其上层（踏板条不遮挡音符）；
- 没有踏板事件的列、以及无踏板数据的曲目：画布上不出现任何踏板轨道背景，只有事件条本身；
- 播放到踩下时刻：该列判定线处出现明显银白光晕；抬起后渐隐；未到时刻不亮；
- 无踏板 CC 的曲目不出现踏板轨道（不留空槽）。

**练习判定（R7–R11）**

- 练习菜单出现「练习音轨」（含说明"仅对选择开启的音轨进行按键判定"）与「踏板」三个单选框
  （关 / 仅延音踏板 / 全部踏板，默认"关"）；未连接键盘时禁用；切换模式自动暂停播放；
- 选中"仅延音踏板"/"全部踏板"且没有任何轨在练 → 自动全开全部轨；
- 默认（无踏板）：所有踏板条压暗、不显示触发光晕，判定与今日一致；
- 延音模式：只有延音条正常显示，弱音/选择延音压暗；练习轨通道外的踏板条压暗；
- 和弦到达判定线：只按琴键不踩要求的踏板 → 播放冻结、不放行；踩下要求的踏板 → 立即放行；
- 和弦不要求任何踏板时误踩参与判定的踏板 → 该列红色光晕 + 不放过；松开后（若琴键满足）立即放行；
- 一直踩住延音踏板跨和弦 → 后续要求延音的和弦直接满足（不要求重踩）；
- 非判定踏板（模式外/练习轨范围外）随便踩：不标红、不阻塞；
- 误踩的红晕位置与正确触发的银白光晕完全一致（同列、判定线处）。

**工程**

- `parse.ts` 踏板值域为 0–127（修复后记谱的踏板延长生效，`quantize` 单测覆盖）；
- 纯逻辑（分段、归属、关注范围、要求踏板、Gate 踏板判定）全部有单测；
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` 全绿；
- Playwright 探针（真实 Chromium + 假 Web MIDI + 合成 MIDI）逐项验证视觉与判定。

## 5. 实施步骤

| 步  | 内容                                                                  | 关键产出                         |
| --- | --------------------------------------------------------------------- | -------------------------------- |
| 1   | `model.ts`：`PedalEvent` + `Song.pedalEvents`（取代 `sustainEvents`） | 领域模型                         |
| 2   | `parse.ts`：采集三踏板 CC、值还原 0–127、保留轨与通道                 | 解析层 + 单测（含值域 bug 回归） |
| 3   | `pedals.ts`：模式、分段、归属、关注范围、要求踏板                     | 纯函数 + 单测                    |
| 4   | `quantize.ts`：改用 `pedalEvents`（按通道取 CC64 区间）               | 记谱延长修复 + 单测              |
| 5   | `chord-gate.ts`：踏板状态、误踩、放行条件                             | 判定 + 单测                      |
| 6   | `transport.ts`：`PracticeChord` 扩展、`pedalFocus`、模式设置          | 调度 + 单测                      |
| 7   | `practice.ts`：`onControl` 接线、模式状态、UI 状态与反馈              | 编排 + 单测                      |
| 8   | `waterfall-view.ts` / `piano-keyboard.ts`：踏板条、光晕、压暗         | 视觉                             |
| 9   | `transport-view.ts` / `style.css` / `app.ts`：单选组与组装            | UI                               |
| 10  | 文档同步 + 全量校验 + Playwright 探针                                 | 见文首"影响文档"                 |

## 6. 实施中落定的细节（2026-09-12）

- **判定踏板 = 模式口径**（§3.3 方框说明）：`all` 模式恒判三踏板，即使本曲只有 CC64 数据；
  误踩红晕/阻塞因此对所有模式内的踏板都生效。压暗只针对存在的踏板条与范围外通道；
- **压暗条不显示触发光晕**（D3）：练习中"无需关注"的踏板条既不判定、也不亮银白光晕，
  避免与"该踩"的信号混淆；正常播放（未开启练习）时全部踏板条照常发光；
- **自动全开全部轨**（D2 落地）：从 `off` 切到非 off、且没有任何轨在练时自动全开全部轨，
  并自动暂停；切换模式同样自动暂停（与分轨开关一致）；
- **顺带修复解析值域 bug**：`parse.ts` 过去把 @tonejs/midi 归一化的 0–1 CC 值直接存进
  `SustainEvent.value`（模型注释与 `quantize.ts` 阈值都按 0–127），导致记谱的"踏板延长长音"
  从未生效；现改为 `Math.round(value * 127)`，并把延音区间**按通道**分组（不同通道的踏板
  不再互相延长音符），`quantize.test.ts` 的踏板用例覆盖；
- **踏板事件定序**：同一时刻按「轨号 → 控制器号」定序，排序稳定，同踏板同通道的
  0/127（换踩）先后顺序不被重排；
- **瀑布流踏板条不随力度/轨色变化**：固定银灰渐变（`#bcc0c6 → #80858c`），练习压暗时
  0.14 不透明度（正常 0.35）；**不画轨道/列的底衬**，只画事件条本身；
- **颜色按试用反馈调过四轮**：初版银白（`#f2f4f7 → #bac1cb`，alpha 0.9）经真实曲目
  （`.tmp/梦中的婚礼.mid`）截图对比后判定"太突出"，改为银灰并压低不透明度（D4）；
  D5 试过"均匀单色 + 左右窄渐变"，D6 按反馈改回**上下渐变**——条体明度约 58–79/255
  （音符条 100–130、背景约 20），既一眼可辨又不与音符争焦点；
- **光晕（D5→D6→D7→D9）**：最终实现是**以判定线为高度中心的圆角矩形光斑**——贴图按宽度缓存
  （`buildPedalGlowSprite`）：圆角矩形宽 = 条宽 + 2×8px、高 = 2×15px（**判定线在高度中点**、
  可见半高 15px）、圆角 8px，填充"中点最亮 → 上下对称渐隐（两端 0.3）"的纵向渐变，
  整块 `filter: blur(4px)` 柔化，四周留 `PEDAL_GLOW_PAD = 14px` 容纳模糊外溢；
  **不画发光条**（D6 去掉），绘制时把矩形高度中点对齐判定线并 `clip()` 到判定线以上 →
  只有上半块可见，下半块（钢琴键盘区域）不画。探针实测：判定线处亮度 207（高度中点峰值）、
  上方 13px 处 121（向上渐隐）、条外 10px 处 110（远端背景 72）、
  光晕半宽 58 / 上方 12px 56（条半宽 45 → 含模糊外溢只略宽）、判定线下方 4px 处
  (21,20,19) 为纯背景；
- `scripts/probe-pedal-lane-practice.mjs` 固化了这些口径：`isGrayBar`/`isSilverGlow`、
  "无事件列 == 普通背景"、"条体上下渐变且同高度左右一致"、"光晕左右外扩"、
  "光晕侧边不向内收（extent 比 ≥ 0.8）"、"光晕宽度 ≥ 条宽且只略宽（< 条半宽 + 30px）"、
  "光晕以判定线最亮、向上渐隐（顶部比贴线处暗 20+）"、"判定线下方无光晕"；
- **探针**：`scripts/probe-pedal-lane-practice.mjs`（真实 Chromium + 假 Web MIDI + 合成 MIDI）
  逐项断言单选框、列几何、银灰事件条、"无事件列 == 普通背景"、光晕接触时刻、压暗、冻结、
  误踩红晕与正确踏板放行；
  调查工具 `scripts/inspect-midi.mjs` 打印轨/通道/踏板事件概览。

## 7. 非目标

- **不判定踏板抬起**：只有"踩下"构成阻塞条件（R8 原文只要求"正确踩下"）。一直踩着延音踏板不放
  不会被判错——"踩过头"的判定需要引入踏板抬起事件的门控，留待后续；
- 不做踏板时值的节奏判定（踩早/踩晚的容差评分）、不做踏板练习评分与记录；
- 不把踏板数据镜像到 MIDI 输出端口（键盘音源的 CC64 调度仍是非目标，见 `20260906`§6）；
- 五线谱不画踏板记号（记谱只沿用 CC64 延长长音的既有语义）；
- 不做"设备没有踏板"的自动降级：若键盘发不出所选踏板，练习会停在判定线等待，
  用户可切换"关"退出（界面上的银白光晕已指示需要踩哪个踏板）；
- 不为获取 CC 真实通道引入第二个解析器（`midi-file` 直读）——见 R-Pedal §5 的偏差说明。
