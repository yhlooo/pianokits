# 设计：踏板声音链路（播放 .mid / 练习输入都听得到延音）

- 日期：2026-09-13
- 状态：**正式生效（2026-09-13 实现）**
- 关联调查：`docs/development/research/20260913-pedal-sound-path-gap.md`（缺失事实、运行时证据、代码路径）
- 前置设计：
  - `docs/development/design/20260912-midi-pedal-lane-and-practice.md`（踏板数据、归属规则、练习判定）
  - `docs/development/design/20260906-midi-keyboard-and-practice.md`（键盘连接、输出镜像、Local Control Off）
  - `docs/development/design/20260905-midi-import-player.md`（走带、引擎接口、lookahead 调度）
- 已同步修订：`20260906` §6 与 `20260912` §7 中「不镜像延音踏板」两条非目标；
  `docs/usage/midi-player.md`；实施中落定的细节见 §11

## 1. 需求

| #   | 需求                                               | 落地口径                                                                              |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| R1  | 播放 .mid：**机内音响**要听得到曲目的踏板（延音）  | 走带排期时按曲目 CC64 语义把音符发声时值延长（§3.1）                                  |
| R2  | 播放 .mid：**键盘音源**（MIDI 输出镜像）也要有踏板 | 走带把曲目 CC64/66/67 按时间镜像到输出端口，音符仍按键按时值发 Note Off（§5.3、§5.4） |
| R3  | 练习模式：**自己踩的踏板**要发声（机内 + 键盘）    | 实时 CC64 驱动引擎延音层（§5.2），练习中同时回送到输出端口（与按键回送同一口径）      |
| R4  | 非练习的实时演奏：踏板也要有效果（机内）           | 实时 CC64 驱动引擎延音层；按键本就不回送，踏板同步不回送（沿用 `20260906` §6 口径）   |
| R5  | 不干扰既有练习判定                                 | 判定链路（`ChordGate` / 闸门）保持不变，踏板只是**新增**一条发声道                    |
| R6  | 可单测、可探针复验                                 | 踏板语义是纯函数；探针 `scripts/probe-pedal-sound-gap.mjs` 转为断言式验收             |
| R7  | 不留残响                                           | 暂停/停止/跳转/断开时向输出端口补发 `CC64/66/67 = 0`，引擎止住延音中的 voice          |

## 2. 结论（先说答案）

**两个机制，各管一段，互不干扰**：

1. **文件播放 = 排期时烘焙**：`Transport.load()` 用纯函数把「每个音符的实际发声结束时刻」按曲目 CC64
   语义算好（`Float64Array`），排期时**引擎取烘焙时值、MIDI 镜像取键按时值**；镜像再单独排期 CC。
   —— 引擎接口对「排期音符」零改动，两个引擎（smplr / 振荡器）自动同时受益。
2. **实时输入 = 引擎延音层 + CC 回送**：`AudioEngine` 增加 `setSustain(down)`——离键的实时 voice 在
   踏板踩着期间**延后止音**，踏板抬起时统一释放；练习中把 CC 原样回送到输出端口。

这样选型的理由：文件播放的踏板状态在**排期那一刻就是已知的**（曲目数据是静态的），把它换算成
发声时值即可，无需给引擎引入"按时间排期的踏板事件"这套并行调度；而实时输入无法预知，才需要引擎
持有延音状态。两条链路各自最简单。

**改动面（5 个模块 + 1 个纯函数 + 文档）**：

| 模块                            | 改动                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `core/midi/pedals.ts`           | 新增纯函数：`soundingEndsUnderSustain()`、`pedalValuesAt()`          |
| `core/engine/types.ts` + 两引擎 | 接口新增 `setSustain(down)`；实时 voice 延后止音                     |
| `core/midi/output.ts`           | 新增 `scheduleControlChange()` / `echoControl()`；止音时复位踏板 CC  |
| `core/transport.ts`             | load 时烘焙；音符排期分流；CC 镜像指针 + 跳转补状态；`liveSustain()` |
| `core/practice.ts`              | `onControl` 接上「驱动引擎 + 练习中回送」；恢复播放时补发踏板状态    |

## 3. 语义定义（唯一真相）

### 3.1 延音（CC64）语义

与 `docs/development/reference/midi/rendering-libraries.md` §Magenta 引用的
`applySustainControlChanges`（magenta-js `core/sequences.ts`）逐条一致——我们采用它的**事件状态机**，
而不是"踏板区间 ∩ 音符起点"的简化式：

1. 按通道（本项目口径，Magenta 按 instrument/program）维护"正在响的音符"集合；
2. **键抬起（Note Off）时踏板踩着 → 不止音**，该音符留在集合里；
3. **踏板抬起（CC64 < 64）时**：集合里所有「键已抬起」的音符在**此刻**结束；键仍按着的继续；
4. **同音高再次击键**时：前一音（无论是否被延音）在**新音起点截断**（钢琴上弦被重新击打）；
   若截断到零时值则整个音符不发声；
5. 曲终仍未收尾的音符在**最后一个事件时刻**结束（不会出现 Infinity）；
6. 归属：`pedalChannelScope`（`core/midi/pedals.ts` 既有）——踏板通道 ⊆ 音符通道时**按通道**各自
   应用；存在无法归属的踏板事件（纯控制轨）时退化为**全曲踏板**（所有音符共用一台状态机）。

> 与既有记谱实现的差异（本设计顺带修复，见 §8 步骤 7）：`quantize.ts` 现在的条件是
> 「**音符起点**落在踏板区间内」（`iv.on <= n.start && iv.off > n.start`），会漏掉
> 「起点在踏板踩下之前、键在踏板踩着时抬起」的音符；Magenta 语义按**音符结束时刻**判定。
> 发声侧一律用 §3.1 的正确语义。

### 3.2 踏板与通道的关系

- 延音作用域是**通道**（同 `pedals.ts` 既有归属规则），打击乐轨已被 `parse.ts` 排除；
- 镜像通道口径：**全部固定通道 0**（与现状一致：走带镜像音符本来就固定 0），多通道文件的踏板事件
  按时间顺序合并到通道 0。备选"按来源通道镜像"见 §6 D3；
- 机内引擎无通道概念，只按烘焙结果发声。

### 3.3 三个踏板的能力边界

| 踏板                   | 机内引擎（烘焙/实时）                    | MIDI 输出镜像 |
| ---------------------- | ---------------------------------------- | ------------- |
| CC64 延音              | **完整支持**（§3.1；实时走延音层）       | 支持          |
| CC66 选择延音          | 不建模（smplr 无对应能力）               | 支持          |
| CC67 弱音              | 不建模                                   | 支持          |
| 半踏板（0–127 中间值） | 按阈值 64 二值化（`PEDAL_ON_THRESHOLD`） | 原值镜像      |

"不建模"= 机内声音与键盘音源在这两个踏板上会有差异，属已知非目标（§9）。

### 3.4 曲终与时长

- 烘焙只受「踏板抬起 / 同音高再次击键 / 最后事件时刻」约束，不产生 Infinity；
- 走带时长 `_duration = max(song.duration, 烘焙后的最大发声结束时刻)`——踏板尾巴不会被提前切断；
- `Song.duration` **不变**（瀑布流/五线谱布局沿用），只有走带进度条会略长一点。

## 4. 架构与数据流

```
解析（不变）
  Song.pedalEvents ──┬─→ 瀑布流踏板条 / 练习判定（不变）
                     └─→ 【新】soundingEndsUnderSustain(notes, tracks, pedalEvents) → Float64Array
                                                                                          │
走带排期 tick()/scheduleFree()                                                            │
  ├─ engine.scheduleNote({ pitch, velocity, time, duration: 烘焙时值 }) ←──────────────────┘
  └─ midiOut.scheduleNote({ pitch, velocity, time, duration: 键按时值, channel: 0 })
      midiOut.scheduleControlChange({ controller, value, time, channel: 0 })  ←【新】CC 镜像

实时输入（练习 / 非练习）
  MidiConnection.onControl(CC64)
    ├─ ChordGate.control(...)                    （判定，不变）
    ├─ transport.liveSustain(down) → engine.setSustain(down)   【新】离键 voice 延后止音
    └─ gating 时 midiOut.echoControl(ev)                        【新】回送键盘音源
```

## 5. 模块接口

### 5.1 `core/midi/pedals.ts`（纯函数，新增）

```ts
/**
 * 按 §3.1 语义返回每个音符的**发声结束时刻**（秒），下标与 notes 对齐。
 * notes 需按 start 排序（Song.notes 已保证）；无踏板数据时返回 n.end 原值。
 */
export function soundingEndsUnderSustain(
  notes: readonly Note[],
  tracks: readonly Track[],
  pedalEvents: readonly PedalEvent[],
): Float64Array

/** 时刻 at 时各踏板控制器的当前值（0–127；无事件为 0），用于跳转/恢复播放时补发镜像状态 */
export function pedalValuesAt(
  pedalEvents: readonly PedalEvent[],
  at: number,
): ReadonlyMap<number, number>
```

实现要点：把 `cc64 事件 + 音符起止`合并成一条按时间排序的事件流（同时刻**音符事件在前、CC 在后**，
与 Magenta 一致），跑一遍状态机；全曲踏板退化时跳过通道分组。复杂度 O((n+m) log(n+m))。

### 5.2 `core/engine/types.ts` + 两个引擎

```ts
export interface AudioEngine {
  // …既有方法…
  /**
   * 延音（damper，CC64）状态：true = 踩着。只影响**实时演奏**的 voice（文件播放的踏板
   * 已在排期时烘焙成时值）；抬起时释放所有"已离键但仍被延音"的 voice。
   * CC66/67 与半踏板不建模（§3.3）。allNotesOff 不清除本状态（物理踏板可能仍踩着）。
   */
  setSustain(down: boolean): void
}
```

- `SmplrEngine`：`liveStops: Map<pitch, StopFn>` 表示按住中的键；新增
  `sustainedStops: Map<pitch, StopFn[]>`。`noteOff` 时踏板踩着 → 从 `liveStops` 移到
  `sustainedStops`（不止音），否则调用 StopFn；`setSustain(false)` → 全部调用并清空。
  **重击同音高**（`noteOn`）硬止两个表里的旧 voice（钢琴语义，§3.1 第 4 条）。
- `OscillatorEngine`：同一套逻辑，用既有的 `releaseVoice()` 实现。
- `allNotesOff()` / `dispose()`：两表都清；`allNotesOff` 保持踏板标志位不变。

### 5.3 `core/midi/output.ts`

```ts
/** 排期一条 CC（时间戳换算同 scheduleNote；已过期立即发送） */
scheduleControlChange(ev: { controller: number; value: number; time: number; channel?: number }): void

/** 回送实时 CC（练习中的踏板；无输出端口为空操作），data 用普通 number[]（shim 兼容） */
echoControl(ev: MidiControlChange): void

/** allNotesOff 追加：CC64/66/67 = 0（16 通道），避免输出端口/键盘残留延音 */
```

### 5.4 `core/transport.ts`

```ts
private soundingEnd = new Float64Array(0)   // load 时烘焙
private mirroredCcs: MirroredCc[] = []      // load 时构建（CC64/66/67，按时间排序）
private ccPointer = 0

load(song)：
  this.soundingEnd = soundingEndsUnderSustain(song.notes, song.tracks, song.pedalEvents)
  this.mirroredCcs = buildMirroredCcs(song.pedalEvents)      // 只留三踏板 CC
  this._duration = max(song.duration, max(soundingEnd))

tick()/tickGated()：
  scheduleCcs(pos)                       // lookahead 窗口内推进 ccPointer，逐条 scheduleControlChange
  音符排期 → engine 用 (soundingEnd[i] - n.start)；midiOut 用 (n.end - n.start) 且带通道 0

所有指针重定位处（load / seek / stop / scrub / setEngine / 进出练习）：
  ccPointer = 二分(mirroredCcs, position)
play()（含从暂停恢复）与 seek() 之后：
  primePedalState(当前 position)          // 补发该时刻的踏板状态（避免"跳进延音段/暂停恢复后听不到延音"）
setMidiOutput(sink)（播放中途插上键盘）：
  primePedalState(当前 position)          // 新挂上的端口立刻处于正确的踏板状态

liveSustain(down: boolean): void         // → engine.setSustain(down)
```

- **练习门控期间不镜像文件 CC**（§6 D4）：`tick` 里检测到 gating 就只推进指针、不发送；进入 gating
  时 `setPracticeTracks` 既有的 `silenceAll()` 会把输出端口的踏板状态复位。机内引擎的烘焙**不受影响**。
- `primePedalState` 与 `scheduleCcs` 在 gating 期间都跳过；`scrub()`（拖动预览）只重定位指针、
  **不补发**（拖动期间本就静音）。

### 5.5 `core/practice.ts`

```ts
private onControl(ev: MidiControlChange): void {
  // 判定（不变）
  const expected = this.transport.pedalsDownAt(this.transport.position)
  const triggered = this.gate.control(ev, expected)
  // 【新】发声道：延音驱动引擎（练习与非练习实时演奏都生效）
  if (pedalIdOfController(ev.controller) === 'sustain') {
    this.transport.liveSustain(ev.value >= PEDAL_ON_THRESHOLD)
  }
  // 【新】练习中把踏板原样回送键盘音源（与 onNote 的 echoNote 同一口径；非练习实时演奏不回送）
  if (this.isGating()) this.sink.echoControl(ev)
  if (!this.isGating()) return
  if (triggered) this.release()
  this.emitFeedback()
}
```

- **恢复播放时补发踏板状态**：`allNotesOff()` 会给输出端口发 `CC64=0`，而用户可能一直踩着物理踏板
  （没有新的踩下沿）。因此在 transport 状态进入 `playing` 时，把 `gate` 当前按住的踏板再回送一次
  （订阅既有的 `transport.on('statechange')`，只在 gating 时）。

## 6. 决策口径（2026-09-13 用户确认，已按此实现）

| #   | 决策                                   | 推荐                                                                             | 备选 / 影响                                                                                       |
| --- | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D1  | 文件播放的实现方式                     | **排期时烘焙**（§2）；引擎接口对排期音符零改动，采样级精确                       | 引擎内建"按时间排期的踏板事件"——与烘焙等价却更复杂，不采用                                        |
| D2  | 机内引擎支持范围                       | **只 CC64**（阈值 64，忽略半踏板）；CC66/67 只镜像                               | 建模 CC66（sostenuto）需与延音区间叠加，收益小，留待后续                                          |
| D3  | 镜像通道                               | **固定通道 0**（保持现状；实测真实曲目轨道通道全是 0，见调查 §2.3）              | 按来源通道镜像更忠实，但会让多通道文件在键盘上换成 GM 音色，属行为变化                            |
| D4  | 练习门控期间是否镜像**文件**踏板       | **不镜像**（踏板是人的责任；避免程序 CC 与物理踏板互相打断），只回送实时 CC      | 按 `pedalFocus` 精确过滤（复杂、收益小）                                                          |
| D5  | 非练习实时演奏是否回送踏板             | **不回送**（与"不回送实时按键"一致），只驱动机内延音                             | 回送则键盘音源也响，但会与机内声音叠成两套音源                                                    |
| D6  | 曲终仍踩着的踏板                       | 按 §3.1 第 5 条在最后事件时刻收尾（无 Infinity）；走带时长按需延长               | 固定加一段尾巴（如 +2s）——不必要，样本自然衰减已够                                                |
| D7  | 录音工具（`/midi-recorder`）是否本次做 | **另案**（录音模型/punch-in 擦除/导出都要扩展，独立设计与验证）                  | 本次一起做：`RecordedPedalEvent` + 覆盖录制擦除 + `write.ts` 写 CC + 回放镜像；工作量约与主体相当 |
| D8  | 记谱（`quantize.ts`）是否同步修语义    | **建议同步**（改用同一纯函数，修正"起点在踏板踩下之前"的漏延长），需回归谱面用例 | 只动声音、不动记谱——两处语义继续分叉                                                              |

## 7. 验收

**单测**

- `pedals.test.ts`：§3.1 五条语义各一例（键抬起时踏板踩着 → 延到踏板抬起；踏板踩下前已离键 → 不延；
  同音高再击键截断；换踩（0 → 127 紧邻）清掉前一和声；全曲踏板退化；无踏板数据原样返回；曲终未抬起 → 最后事件时
  刻）+ **Magenta.js 官方用例逐值一致**；
- `output.test.ts`：`scheduleControlChange` 的时间戳换算/过期立即发送/普通数组；
  `echoControl` 无端口空操作；`allNotesOff` 追加三踏板复位（16 通道）；
- `transport.test.ts`：引擎拿到烘焙时值、镜像拿到键按时值 + CC 事件；seek 补发踏板状态；
  gating 期间不镜像；`_duration` 含踏板尾巴；
- `practice.test.ts`：练习中 CC64 回送 + 驱动引擎；非练习不回送但驱动引擎；恢复播放补发踏板状态。

**探针（真实 Chromium + 假 Web MIDI）**

- `scripts/probe-pedal-sound-gap.mjs` 由"打印事实"升级为断言：播放含 CC64 曲目 → 输出端口出现
  CC64 踩下/抬起、机内 voice 时长被延长到踏板抬起；练习模式踩物理踏板 → 输出端口收到 CC64；
  暂停/停止后 → 输出端口收到 `CC64=0`；
- 复跑 `probe-pedal-lane-practice.mjs`（踏板视觉/判定不得回归）、`probe-practice.mjs`、
  `probe-recorder.mjs`。

**真机手测**

- `.tmp/梦中的婚礼.mid`：机内音响与键盘音源都能听出延音（此前 78% 的音符被砍短）；
- 练习模式（仅延音踏板）：踩下踏板可听到自己弹的音被延音、键盘音源同步；
- 暂停→恢复：无残留延音、也无需重踩踏板才恢复延音（D-恢复补发）。

**工程**

- `pnpm test` / `typecheck` / `lint` / `build` 全绿；`pnpm format:check` 通过。

## 8. 实施步骤

| 步  | 内容                                                                                           | 规模 |
| --- | ---------------------------------------------------------------------------------------------- | ---- |
| 1   | `pedals.ts`：`soundingEndsUnderSustain` + `pedalValuesAt` + 单测                               | M    |
| 2   | `engine/types.ts` + `smplr-engine.ts` + `oscillator-engine.ts`：`setSustain` 与延音表          | M    |
| 3   | `output.ts`：`scheduleControlChange` / `echoControl` / 踏板复位 + 单测                         | S    |
| 4   | `transport.ts`：烘焙、排期分流、CC 镜像指针、跳转补状态、`liveSustain` + 单测                  | L    |
| 5   | `practice.ts`：`onControl` 接线、恢复播放补发踏板状态 + 单测                                   | S    |
| 6   | 探针升级 + 真机手测（含既有探针回归）                                                          | M    |
| 7   | （D8 选做）`quantize.ts` 改用同一语义 + 记谱单测/谱面回归                                      | M    |
| 8   | 文档同步：本设计转正式、`20260906` §6 与 `20260912` §7 非目标修订、`docs/usage/midi-player.md` | S    |

## 9. 非目标

- 不做 CC66（选择延音）/CC67（弱音）的**机内**建模，也不做半踏板（§3.3）；
- 不做踏板的**节奏判定/评分**（沿用 `20260912` §7）；
- 不做录音工具的踏板录制/回放/导出（D7 另案）；
- 不改瀑布流/五线谱的踏板呈现（记谱延长的语义修正见 D8，属可选）；
- 不引入第二个 MIDI 解析器（踏板通道仍沿用 `parse.ts` 的轨内推导，纯控制轨退化为全曲口径）。

## 10. 风险与缓解

| 风险                                            | 缓解                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| 延音使同时发声的 voice 变多（smplr 无复音上限） | 真实钢琴曲目并发 voice 通常在几十以内；探针观察播放稳定性，必要时后续加 voice 上限   |
| 输出端口 `clear()` 把未发送的 CC 一起清掉       | 止音路径显式补发 `CC64/66/67=0`（§5.3）；恢复播放补发踏板状态（§5.5）                |
| 练习冻结/放行时已排期的 CC 仍可能触发           | 进入 gating 走既有 `silenceAll()`（含 `clear()` + 踏板复位）；gating 期间不再排期 CC |
| 键盘音源与机内声音在 CC66/67/半踏板上不一致     | 已在 §3.3 明确为已知边界；`docs/usage/midi-player.md` 写明                           |
| 烘焙改变音符排期时值，影响既有走带单测          | 单测同步更新为"引擎 = 烘焙时值、镜像 = 键按时值"的口径                               |

## 11. 实施中落定的细节（2026-09-13）

- **语义实现取 Magenta.js 事件状态机**（`soundingEndsUnderSustain`，`core/midi/pedals.ts`）：
  同时刻事件**音符在前、CC 在后**（稳定排序，与参考实现一致）；`pedals.test.ts` 把 Magenta.js
  官方用例（`sequences_lib_test.py` 的 `testApplySustainControlChanges`）逐值固化为回归用例。
- **修正草案里的一处错误预期**：草案 §7 曾写"连续换踩（0/127 同刻）不断音"——正确语义是
  **换踩即抬起**：键已抬起的音在抬起时刻结束（前一和声被清掉），键仍按着的音继续（§3.1 第 2/3 条，
  Magenta.js 官方用例的 4.8s 一条亦如此）。`probe`/单测按此口径。
- **换踩与"不断音"的边界**：真实曲目（`.tmp/梦中的婚礼.mid`）的 0/127 相差 1–3ms，属**刻意换踩**
  （清前一和声），不是连续踩；smplr 的 `ampRelease = 0.5s` 让清音听感自然。
- **镜像通道固定 0**（D3）：`Transport` 的 `MIRROR_CHANNEL`；音符与 CC 同通道，保证键盘音源
  "踏板作用到它听到的那些音"。
- **状态补发（prime）时机**：`play()`（含暂停恢复）、`seek()`、`setMidiOutput()`（播放中途插键盘）；
  `scrub()` 只重定位指针、不补发（拖动期间静音）。补发会连 `CC=0` 一起发（显式状态，简单可靠）。
- **引擎延音层**：`noteOn` 重击同音高时**硬止含延音中的旧 voice**（§3.1 第 4 条）；
  `allNotesOff()` 保留踏板标志位（物理踏板可能仍踩着）；`setEngine()` 重新下发实时踏板状态。
- **练习模式**（D4/D5）：门控期间不镜像文件踏板（`scheduleCcs` 只推进指针）；实时 CC 仅在
  gating 时回送（保留输入通道）；恢复播放时把 gate 里"按住中的踏板"补发一次（记住最近输入通道），
  否则 `allNotesOff()` 的 `CC=0` 会让物理踏板"看起来松开了"、必须重踩才恢复延音。
- **记谱同步**（D8）：`quantize.ts` 的 `extendWithSustain` 改用同一函数，顺带修正了
  "起点在踏板踩下之前、键在踏板踩着时抬起"的漏延长；新增单测固化该形态。
- **验收结果**：`pnpm test` 323 项全绿（新增/改写踏板相关 26 项）；`typecheck`/`lint`/`build` 全绿；
  `scripts/probe-pedal-sound-gap.mjs`（断言式）通过——输出端口 CC64 序列 `[0,0,0,127,0]`（含
  prime + 踩下 + 抬起）、机内 voice 时长 `4.5 / 3.5 / 2.5s`（= 烘焙 4.0/3.0/2.0 + release 0.5）、
  暂停复位、练习回送均通过；`probe-pedal-lane-practice.mjs`、`probe-recorder.mjs` 回归通过。
  已知遗留：`probe-practice.mjs` / `probe-per-track-practice.mjs` 是**本次之前就已失效**的旧探针
  （期望的连接文案与 `.view-switch__btn` 选择器在当前 UI 中已不存在），与本次改动无关。
