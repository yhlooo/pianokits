# 设计：MIDI 键盘连接与练习模式

- 日期：2026-09-06
- 状态：**正式生效（2026-09-06 实现）**
- 关联文档：
  - `20260905-midi-import-player.md`（MIDI 播放工具主设计；本功能对其 M1 非目标的一次扩展）
  - `docs/development/research/20260905-web-midi-input.md`（Web MIDI 接入调查结论）
  - `docs/development/reference/midi/webmidi-api.md`（Web MIDI API 参考）
  - `20260905-debug-tools.md` §4.3（既有“MIDI 键盘”调试工具的接入模式，本设计的接入层由此提炼为共享服务）

## 1. 需求

1. MIDI 播放器（播放坞）右下角添加**钢琴图标**，点击连接 MIDI 钢琴键盘；
2. 连接后可用 MIDI 钢琴键盘**实时演奏**（按键即发声、离键即止音，音色走当前音频引擎）；
3. 再添加**练习图标**开启练习模式，未连接 MIDI 键盘前该图标置灰禁用：
   - 练习模式下瀑布流音符落到琴键**不自动发声**，等待 MIDI 键盘按下对应琴键才播放；
   - 和弦（同时多键）需**同时按住全部琴键**才触发播放；
   - 按错键、多按键都不触发播放，且按错的键在键盘上**红色显示**。
4. （2026-09-06 追加）键盘既作输入也作音源：播放/练习放行的音符**同步输出一份到键盘
   MIDI 输出端口**，键盘自带音源与电脑播放同步发声（§3.6）。

## 2. 关键技术决策

| #   | 环节         | 决策                                                                                                                                                    | 理由                                                                                                                                                                                      |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 设备接入     | 复用调试工具的接入模式提炼为共享服务 `MidiConnection`（`core/midi/connection.ts`）                                                                      | 调试工具已验证 Web MIDI 接入/热插拔/错误处理模式；提炼后主工具与调试工具未来可共用（调试工具 §7 已预留此方向）                                                                            |
| 2   | 实时演奏     | `AudioEngine` 接口新增 `noteOn/noteOff`（引擎自管实时 voice）；`Transport` 提供同名透传                                                                 | 引擎封装保持“只有 Transport 触碰引擎”的既有分层；smplr 的 `start()` 返回 StopFn 天然支持单音止音，振荡器引擎用自管 voice                                                                  |
| 3   | 练习模式调度 | **练习模式内建在 `Transport`**：新增 `setPracticeMode` / `onPracticeChord` / `releaseChord`                                                             | 练习模式只是“调度器到达音符时改为等待放行”，状态机（播放/暂停/停止/跳转）与唯一时钟完全复用；瀑布流/谱面继续每帧读 `transport.position`，等待时位置冻结在和弦起点，音符自然“停”在判定线上 |
| 4   | 和弦分组     | 同一次等待内，`start` 相差 ≤ 30ms（`CHORD_EPSILON_SEC`）的音符合并为一个和弦，组内原子消费                                                              | 真实 MIDI 录音的和弦起音常有几毫秒到二三十毫秒的错开；30ms 远小于 120bpm 十六分音符间隔（125ms），不会误并相邻和弦                                                                        |
| 5   | 匹配判定     | 纯逻辑 `ChordGate`（`core/midi/chord-gate.ts`）                                                                                                         | 判定规则复杂（按错标记、多按拦截、预先按住的立即触发），抽成纯模块可单测，与 DOM/音频解耦                                                                                                 |
| 6   | 编排         | `PracticeController`（`core/practice.ts`）：连接生命周期、实时演奏、练习开关、gate ↔ transport 接线、键盘反馈事件                                       | app.ts 是组合根，只做注入与视图更新；控制器不碰 DOM，经回调向外发状态                                                                                                                     |
| 7   | 键盘反馈     | 瀑布流键盘新增反馈层：按住键琥珀点亮、按错键红色 + 光晕，仅练习模式显示                                                                                 | 复用瀑布流既有键盘绘制几何；红色使用语义色 `--danger`，与点亮色、轨色不冲突                                                                                                               |
| 8   | 入口 UI      | 播放坞控制行最右端（视图切换右侧）两个图标按钮：钢琴（连接/断开）、练习（开/关）                                                                        | 与“右下角”需求一致；图标沿用 20×20 / 1.5px 描边 / currentColor 的既有图标语言                                                                                                             |
| 9   | 播放镜像     | `MidiOutputSink`（`core/midi/output.ts`）把走带排期的每个音符**同步发一份**到键盘输出端口（键盘自带音源发声）；挂载在 `Transport`（与引擎共用同一排期） | 用户键盘既是输入也是音源，要求“同步输出一份到键盘”；镜像挂在走带排期点上天然与电脑播放逐音符对齐；Transport 只面对结构化接口，换输出实现不动调度器                                        |

## 3. 模块与接口

### 3.1 MIDI 接入层（core/midi/connection.ts）

```ts
type MidiConnectionStatus =
  | 'idle' // 未连接（初始/已断开）
  | 'connecting' // 授权请求中
  | 'connected' // 已授权且 ≥1 台输入设备挂载（练习模式可用的前提）
  | 'no-devices' // 已授权但无输入设备（连接尝试窗口内等待设备插入）
  | 'timeout' // 连接尝试超时（5s 内未连上）
  | 'unsupported' // 浏览器不支持 Web MIDI
  | 'denied' // 授权被拒绝
  | 'error' // 其它失败

export const CONNECT_TIMEOUT_MS = 5000 // 连接尝试超时

class MidiConnection {
  readonly status: MidiConnectionStatus
  readonly attempting: boolean // 连接尝试是否进行中（5s 窗口内）
  readonly connectedLabel: string | null // 已连接键盘的 厂商+名称；未连接为 null
  connect(): Promise<void> // 发起一次 5s 限时连接尝试
  disconnect(): void // 取消尝试/断开：摘监听、移除 statechange、回 idle
  dispose(): void // 同 disconnect
  // 构造回调：onStatus(status)、onNote(MidiNoteEvent)（复用 core/midi/input.ts 的 parseMidiMessage）
}
```

要点（沿用调查结论 R-WebMIDI）：

- `navigator.requestMIDIAccess({ sysex: false })`；`NotAllowedError` → denied、`NotSupportedError` → unsupported；
- `statechange` 时重新挂载 inputs 并刷新状态（设备热插拔自动感知）；
- **连接尝试语义**（`attempting`）：`connect()` 启动 5s 限时尝试——期间授权成功且有设备 →
  connected（尝试结束）；已授权但无设备 → no-devices，**继续等待到 5s 超时**（窗口内热插拔
  即连上）；期间 `disconnect()`（用户点击取消）→ idle；5s 仍非 connected → timeout
  （拆掉 access，在途的授权结果作废）。每次 connect/disconnect/超时都会使 attempt 序号自增，
  `await` 之后校验序号与状态，杜绝迟到的授权结果覆盖新一轮连接；
- `sync()` 统一负责“连上即结束尝试”：connected 时清计时器、attempting 置 false（初始接入与
  热插拔共用此路径）。

### 3.2 实时演奏（AudioEngine 扩展）

```ts
interface AudioEngine {
  // ……既有方法……
  /** 立即发声（实时演奏，如 MIDI 键盘按下）；同音高重复按下会先止住前一个 */
  noteOn(pitch: number, velocity: number): void
  /** 止住实时演奏中的音（如 MIDI 键盘松开）；不经过调度器 */
  noteOff(pitch: number): void
}
```

- `SmplrEngine`：`piano.start({ note, velocity, duration: null })` 的返回值即停止函数，按音高存
  `Map<pitch, StopFn>`；`noteOff` 调用对应 StopFn；`allNotesOff` 一并停掉全部实时 voice。
- `OscillatorEngine`：自管实时 voice（振荡器 + 增益，起音后指数回落保持），`noteOff` 走增益
  快泄 + 停止；`allNotesOff`/`dispose` 一并清理。
- `Transport` 增加 `liveNoteOn/liveNoteOff` 透传，保持引擎私有。

### 3.3 练习模式（Transport 扩展）

```ts
export const CHORD_EPSILON_SEC = 0.03

export interface PracticeChord {
  start: number // 和弦起点（秒）
  notes: Note[] // 该组内全部音符（start ∈ [start, start+EPS]）
}

class Transport {
  setPracticeMode(on: boolean): void
  onPracticeChord(cb: (chord: PracticeChord | null) => void): () => void // null = 等待被取消
  releaseChord(): void // 放行当前等待的和弦
}
```

调度语义（`tick()` 在练习模式下改走 `tickPractice()`）：

1. **等待**：播放位置到达下一和弦起点（`pos >= notes[nextIndex].start`）时，收集
   `start ≤ 起点 + 30ms` 的整组音符，冻结播放位置（`offset = now - 起点`，位置精确停在
   起点），回调 `onPracticeChord(chord)`。和弦音符**不排入引擎**；
2. **放行**：`releaseChord()` 以 `host.now()` 为发声时刻把组内各音符按其原始时值与力度排入
   引擎（跳过零时值），`nextIndex` 越过整组，`offset = now - 起点` 使播放从和弦起点继续推进；
3. **取消等待**（`seek` / `stop` / `pause` / 切换引擎 / 退出练习 / 载入新歌）：清空等待并回调
   `onPracticeChord(null)`；暂停后恢复播放会重新进入等待并再次回调（因此暂停期间琴键状态
   不参与判定，恢复时按当前按住状态重新评估）；
4. **进出练习**：进入时 `allNotesOff()` 清掉 lookahead 已排期与发声中的音符，指针改为
   “第一个 start ≥ 当前位置”（start 指针）；退出时等待中的和弦立即按正常调度发声并继续
   （指针天然指向该和弦起点），不额外清音；
5. 练习模式下 `seek` 用 start 指针；播放到末尾的行为与正常模式一致。

### 3.4 匹配判定（core/midi/chord-gate.ts，纯逻辑）

```ts
class ChordGate {
  heldKeys: ReadonlySet<number> // 当前按住的所有键
  wrongKeys: ReadonlySet<number> // 按错的键（红显）
  setChord(pitches: ReadonlySet<number> | null): boolean // 设置等待中的和弦；true = 已按住全部琴键，立即触发
  note(ev: MidiNoteEvent): boolean // 处理按键；true = 本次事件触发
  reset(): void
}
```

判定规则（每次按键事件后评估；`setChord` 在进入等待时评估一次）：

- **触发条件**：和弦的全部音高都在按住集合中，**且**无“按错”标记；
- **按错标记**：等待期间新按下的、不在和弦内的键记为按错（红显），松开即清除；
  在等待开始**之前**就按住的键（如上一和弦的延续指法）不计入按错、也不阻止触发——
  这是对“多按了键不能触发”的有意收敛：上一和弦遗留的按住键是正确指法的一部分，
  不应被新和弦标红，且不能阻塞 legato 衔接；
- **预先按住**：等待开始时若和弦全部音高已按住且无按错 → 立即触发（允许提前一点点
  按好琴键，音符一到判定线即放行）；
- **纠错后触发**：松开按错的键时若其余条件满足，立即触发（松键也是评估时机）；
- 等待窗口之外的按键不评估、不标红（音符尚未到判定线，弹什么都不算“按错”）。

### 3.5 编排控制器（core/practice.ts）

```ts
interface KeyFeedback {
  held: ReadonlySet<number>
  wrong: ReadonlySet<number>
}

interface MidiUiState {
  status: MidiConnectionStatus
  attempting: boolean // 连接尝试进行中（旋转等待；点击取消）
  deviceLabel: string | null // 已连接键盘名（tooltip 用）
}

interface PracticeCallbacks {
  onStatus(ui: MidiUiState): void
  onPractice(on: boolean): void
  onFeedback(fb: KeyFeedback | null): void // null = 非练习模式（隐藏键盘反馈）
  onConnectError(message: string): void // 连接失败（超时/被拒等）→ 右下角报错通知
}

class PracticeController {
  constructor(opts: { transport: Transport; callbacks: PracticeCallbacks })
  toggleMidi(): void
  togglePractice(): void
  get practice(): boolean
  dispose(): void
}
```

职责与规则：

1. 持有 `MidiConnection`，`toggleMidi()` 点击语义：**已连接 → 断开**；**尝试中
   （attempting）→ 取消**（回 idle，不报错）；**其余 → 发起一次连接尝试**；
2. 连接失败（timeout / denied / unsupported / error）经 `onConnectError` 弹报错，
   **主动取消不报错**；
3. **实时演奏**：已连接且非练习模式时，noteOn/noteOff → `transport.liveNoteOn/Off`；
   练习模式下按键**不直接发声**（发声由触发时按原曲时值/力度播放，避免双重声源）；
4. **练习开关**：仅在 `connected` 时可开；连接状态离开 `connected`（断开/设备拔出）时
   强制退出练习模式；
5. **接线**：`transport.onPracticeChord(chord)` → `gate.setChord(pitches)`，立即触发时
   随即 `releaseChord()`；`gate.note()` 返回触发时 `releaseChord()`；每次 gate 状态变化
   后经 `onFeedback` 把 `held/wrong` 推给瀑布流；
6. 收到 `null`（等待取消）→ 清空 gate 和弦并重发反馈；
7. **播放镜像**：持有 `MidiOutputSink`（以 `audioCtx` 做时间换算），订阅连接的
   `onOutputs` —— 有输出端口时 `transport.setMidiOutput(sink)`（走带排期的每个音符
   同步发一份到键盘音源），端口清空（断开/拔出）时先静默再解除镜像。

### 3.6 播放镜像（core/midi/output.ts）

```ts
class MidiOutputSink {
  constructor(audioCtx: { currentTime: number })
  sync(outputs: readonly MIDIOutput[]): void // 更换输出端口（连接同步/热插拔/断开清空）
  scheduleNote(ev: { pitch; velocity; time; duration }): void // Note On + 时值结束的 Note Off
  allNotesOff(): void // 清空未发送队列 + 16 通道 All Notes Off / All Sound Off
  dispose(): void
}
```

- `Transport` 增加可选 `setMidiOutput(sink | null)`：`tick()` 与 `releaseChord()` 的每个
  音符经 `scheduleToBoth()` 同时排入引擎与镜像 sink——**电脑播放与键盘音源逐音符对齐**；
  `pause/stop/seek/换引擎/进出练习/载入新歌` 的静默路径同时触发 `sink.allNotesOff()`
  （`MIDIOutput.clear()` 清掉尚未发送的排期消息 + 全通道止音，避免暂停后键盘残留长音）；
- **时间换算**：`send()` 时间戳基于 `performance.now()`，排期时间是 AudioContext 时间，
  两者同源 → `ts = performance.now() + (time - currentTime) * 1000`；已过期的时间
  不带时间戳（立即发送）；力度钳制 1~127（0 会被键盘解释为 Note Off）；
- **不回送实时按键**：用户按键（实时演奏）不镜像到输出端口——键盘 Local Control 开启
  （默认）时回送会造成叠音/回授；此取舍见 §6 非目标；
- 通道固定 0（钢琴主通道），发送到全部输出端口。

## 4. UI

### 4.1 入口按钮（播放坞控制行最右端）

- 顺序：`[音量][视图切换][钢琴][练习]`（练习在最右端）；
- **钢琴图标**（琴键剪影：描边白键 + 实心黑键，沿用图标语言）三态：
  - **未连接**：暗色（弱文本色，比常规图标按钮暗一档），tooltip“连接 MIDI 键盘”，
    点击发起连接尝试；失败态（超时/被拒/不支持/失败）恢复暗色，tooltip 提示原因（点击重试）；
  - **连接尝试中**（attempting，5s 窗口）：图标换成**旋转等待圆弧**（CSS 动画），
    tooltip“连接中（点击取消）”，点击**取消连接**（回未连接暗色，不报错）；
  - **已连接**：琥珀高亮，tooltip“已连接 {键盘名称}（点击断开）”，点击**断开连接**；
- 连接尝试**超时 5s 未连上**：右下角弹出**报错通知胶囊**（危险色左边条，5s 自动消退 +
  关闭按钮，位置在播放坞右上方），按钮恢复未连接暗色；
- **练习图标**：靶心（圆环 + 四向刻度），标题“练习模式（需先连接 MIDI 键盘）”；
  未连接时 `disabled` 置灰；开启后琥珀高亮（`is-active`）；
- 开启练习模式时若当前不是瀑布流视图，自动切到瀑布流（练习的视觉载体是瀑布流键盘）。

### 4.2 瀑布流键盘反馈（仅练习模式）

- 按住键：琥珀 `#d9a45b` 半透明点亮（含黑键），画在轨色点亮之上；
- 按错键：语义色 `#e0695e` 高不透明 + 同色光晕，画在最上层；
- 数据来自 `onFeedback`，`setKeyFeedback(null)` 清除（退出练习模式）。

## 5. 验收

- 未连接：钢琴按钮暗色，tooltip“连接 MIDI 键盘”，点击进入连接中；
- 连接中：旋转等待图标，tooltip“连接中（点击取消）”，点击取消后恢复暗色且不报错；
- 5s 内连上：按钮变亮，tooltip 显示键盘名称，点击断开；
- 5s 未连上：右下角弹出报错通知，按钮恢复暗色；
- 连接 MIDI 键盘后按键即发声、离键即止（音色 = 当前引擎）；
- 键盘有输出端口时：播放/练习放行的每个音符在键盘自带音源上同步发声；断开/拔出后停止镜像；
- 未连接时练习图标置灰不可点；连接后可点、断开后自动退出并恢复置灰；
- 练习模式：音符落到判定线停住不发声；按对全部和弦键立即发声并继续下落；
- 按错/多按：不发声、错误键红显，松开后红显消失；纠错后按对立即放行；
- 播放/暂停/停止/拖拽跳转在练习模式下语义不变；暂停期间松键/换指恢复后按当前按住状态重新判定；
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` 全绿。

## 6. 非目标

- 不判定节奏（按键时刻不影响音符时值/音量，只做“放行”门）；
- 不做按错统计、评分、练习记录持久化；
- **不回送实时按键**到输出端口（键盘 Local Control 开启时回送会叠音/回授；Local Off +
  软件回送场景留待后续，届时可加“回送按键”开关）；
- **不镜像延音踏板**（CC64）：走带目前不处理 sustainEvents，键盘音源听感无踏板；后续
  若做 CC64 调度可一并镜像；
- 不改调试工具“MIDI 键盘”页面（其接入逻辑未来可迁移到 `MidiConnection`，本次不迁移）。
