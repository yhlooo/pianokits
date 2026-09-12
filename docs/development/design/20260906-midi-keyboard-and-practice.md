# 设计：MIDI 键盘连接与练习模式

- 日期：2026-09-06
- 状态：**正式生效（2026-09-06 实现；连接部分由 `20260907-midi-auto-connect.md` 修订；2026-09-12 由 `20260912-midi-debug-velocity-pedal.md` 扩展：新增 `onControl` 回调与只读诊断 getter，调试页接入改为复用本共享层；同日由 `20260912-midi-pedal-lane-and-practice.md` 扩展：`KeyFeedback` → `PracticeFeedback`（含误踩踏板）、练习模式新增踏板练习三选一与踏板判定，瀑布流新增踏板轨道）**
- 关联文档：
  - `20260905-midi-import-player.md`（MIDI 播放工具主设计；本功能对其 M1 非目标的一次扩展）
  - `docs/development/research/20260905-web-midi-input.md`（Web MIDI 接入调查结论）
  - `docs/development/reference/midi/webmidi-api.md`（Web MIDI API 参考）
  - `20260905-debug-tools.md` §4.3（既有“MIDI 键盘”调试工具的接入模式，本设计的接入层由此提炼为共享服务）
  - `20260907-midi-auto-connect.md`（对本文 §1/§3.1/§3.5/§4.1 连接部分的修订：自动连接 +
    连接状态展示图标，取代“点击连接/断开”）

## 1. 需求

1. MIDI 播放器（播放坞）右下角添加**钢琴状态图标**，进入页面自动连接 MIDI 钢琴键盘，
   高亮/暗色表示已连接/未连接，点击显示连接状态（**由 `20260907-midi-auto-connect.md` 修订**）；
2. 连接后可用 MIDI 钢琴键盘**实时演奏**（按键即发声、离键即止音，音色走当前音频引擎）；
3. 再添加**练习图标**，未连接 MIDI 键盘前该图标置灰禁用：
   - 练习模式下瀑布流音符落到琴键**不自动发声**，等待 MIDI 键盘按下对应琴键才播放；
   - 和弦（同时多键）需**同时按住全部琴键**才触发播放；
   - 按错键、多按键都不触发播放，且按错的键在键盘上**红色显示**。
4. （2026-09-06 追加）键盘既作输入也作音源：播放/练习放行的音符**同步输出一份到键盘
   MIDI 输出端口**，键盘自带音源与电脑播放同步发声（§3.6）。
5. （2026-09-06 追加）练习模式支持**分轨练习**（每轨独立开关）：
   - 开启练习的轨到达判定线时等待琴键放行，**整个播放冻结**（位置停驻、无声音）；
     与门控和弦同 onset 的非练习轨音符随和弦一起等待，放行时一起发声；
   - 练习按钮上方**悬浮菜单**：hover 展开，逐轨显示轨名与瀑布流颜色图例，点击可
     开启/关闭该轨练习（可多选）；
   - 练习按钮点击语义：非全开（含全关）→ 全部开启；全开 → 全部关闭；
   - 只要至少一轨开启练习，练习按钮即高亮。
6. （2026-09-06 追加）暂停/播放联动：
   - 任意轨练习开启时，按下 MIDI 键盘**任意琴键**即从暂停（未播放）恢复播放；
   - 开关练习（练习按钮全开/全关、菜单开关单轨）都自动暂停；
   - 连接 MIDI 键盘不影响暂停/播放状态；断开（点击断开/设备拔出）自动暂停。
7. （2026-09-06 追加）**音量统一（禁用键盘自带音源 + 练习按键软件回送）**：连接键盘且有
   输出端口时发送 **Local Control Off**（CC122=0）禁用键盘自带音源；练习模式（门控中）的
   按键（含弹错的音）**原样回送到键盘输出端口**（力度=按键力度、通道=输入通道）**并同时
   驱动电脑引擎**（同力度），练习轨音量由按键力度决定；非练习轨照常走电脑引擎 + 键盘镜像
   （力度=原曲）。断开/拔出/销毁时恢复 **Local Control On**（CC122=127），避免键盘残留无声状态。
8. （2026-09-06 追加）**练习判定豁免（不算错）**：
   - **长音符重复按**：已触发的音符在其「瀑布流键盘持续期间」（`start ≤ 当前和弦起点
< end`）内再按该键不算错、也不重复触发，仅忽略该按键；
   - **分轨练习的非练习轨音符**：等待期间按下与当前和弦同 onset、或仍在键盘上的
     非练习轨音符不算错（主练一只手、另一只手配合弹协调性时不判定另一只手）；
   - **长踏板持续期间（2026-09-12 修订）**：曲目正踩着某踏板（踩下区间的持续期间内）时踩下它
     不算误踩、也不阻塞——与长音符重复按同一思路，踏板侧完整规则与修订缘由见
     `20260912-midi-pedal-lane-and-practice.md` §3.5（R12/D13）。

## 2. 关键技术决策

| #   | 环节         | 决策                                                                                                                                                                                                         | 理由                                                                                                                                                                                                               |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 设备接入     | 复用调试工具的接入模式提炼为共享服务 `MidiConnection`（`core/midi/connection.ts`）                                                                                                                           | 调试工具已验证 Web MIDI 接入/热插拔/错误处理模式；提炼后主工具与调试工具未来可共用（调试工具 §7 已预留此方向）                                                                                                     |
| 2   | 实时演奏     | `AudioEngine` 接口新增 `noteOn/noteOff`（引擎自管实时 voice）；`Transport` 提供同名透传                                                                                                                      | 引擎封装保持“只有 Transport 触碰引擎”的既有分层；smplr 的 `start()` 返回 StopFn 天然支持单音止音，振荡器引擎用自管 voice                                                                                           |
| 3   | 练习模式调度 | **练习模式内建在 `Transport`**：新增 `setPracticeTracks`（门控轨集合）/ `onPracticeChord` / `releaseChord`                                                                                                   | 练习模式只是“调度器到达音符时改为等待放行”，状态机（播放/暂停/停止/跳转）与唯一时钟完全复用；瀑布流/谱面继续每帧读 `transport.position`，等待时位置冻结在和弦起点，音符自然“停”在判定线上                          |
| 4   | 和弦分组     | 同一次等待内，`start` 相差 ≤ 30ms（`CHORD_EPSILON_SEC`）的音符合并为一个和弦，组内原子消费                                                                                                                   | 真实 MIDI 录音的和弦起音常有几毫秒到二三十毫秒的错开；30ms 远小于 120bpm 十六分音符间隔（125ms），不会误并相邻和弦                                                                                                 |
| 5   | 分轨调度     | 门控模式内**双流调度**：门控流按和弦等待放行，自由流（非门控轨）只排期到**下一个门控和弦之前**；和弦只含门控轨音符；每个音符打“已排期”标记，退出练习时按标记合并回单流，不重复发声                           | 与门控和弦同 onset 的非练习轨音符要随和弦一起等待、放行时一起发声（不能提前响）；双流 + 标记合并是唯一时钟下最小侵入的方案（§3.3）                                                                                 |
| 6   | 位置冻结     | 练习轨和弦**一律整体冻结**（`position` 停在和弦起点且不再排期任何音符）；放行时回拨 `offset` 从和弦起点继续，同 onset 的非门控音符由自由流在放行后以放行时刻补发、随和弦一起发声                             | 练习轨音符必须停判定线等待按键，且等待期间不能有声音（非练习轨同 onset 音符一起等）；整体冻结回拨 `offset` 使后续音符相对放行时刻推进                                                                              |
| 7   | 提前触发窗口 | 位置进入门控和弦起点前**一个四分音符**（按拍速折算）即回调判定，位置到达起点才冻结；顺序门控（前一和弦放行后才回调下一和弦）                                                                                 | 人无法精准按键：提前窗口让“早按一点”被判定为触发而不是被忽略，避免到判定线又算“没按”的不连贯；提前放行时位置追到和弦起点，保持节拍推进                                                                             |
| 8   | 匹配判定     | 纯逻辑 `ChordGate`（`core/midi/chord-gate.ts`）                                                                                                                                                              | 判定规则复杂（按错标记、多按拦截、预先按住的立即触发、豁免键忽略），抽成纯模块可单测，与 DOM/音频解耦                                                                                                              |
| 9   | 编排         | `PracticeController`（`core/practice.ts`）：连接生命周期、实时演奏、分轨练习开关、gate ↔ transport 接线、键盘反馈事件                                                                                        | app.ts 是组合根，只做注入与视图更新；控制器不碰 DOM，经回调向外发状态                                                                                                                                              |
| 10  | 键盘反馈     | 瀑布流键盘新增反馈层：按住键琥珀点亮、按错键红色 + 光晕，仅练习模式显示                                                                                                                                      | 复用与「MIDI 键盘」调试页共用的 DOM 钢琴键盘（`ui/piano-keyboard.ts`，2026-09-06 起瀑布流键盘即该组件）的逐键点亮层；红色使用语义色 `--danger`，与点亮色、轨色不冲突                                               |
| 11  | 入口 UI      | 播放坞控制行最右端（视图切换右侧）两个图标按钮：钢琴（连接状态展示，点击弹状态浮层，**由 `20260907-midi-auto-connect.md` 修订**）、练习（全开/全关 + 悬浮分轨菜单）                                          | 与“右下角”需求一致；图标沿用 20×20 / 1.5px 描边 / currentColor 的既有图标语言                                                                                                                                      |
| 12  | 播放镜像     | `MidiOutputSink`（`core/midi/output.ts`）把走带排期的每个音符**同步发一份**到键盘输出端口（键盘自带音源发声）；挂载在 `Transport`（与引擎共用同一排期）                                                      | 用户键盘既是输入也是音源，要求“同步输出一份到键盘”；镜像挂在走带排期点上天然与电脑播放逐音符对齐；Transport 只面对结构化接口，换输出实现不动调度器                                                                 |
| 13  | 音量统一     | `MidiOutputSink` 挂载输出端口时发送 **Local Control Off**（CC122=0），断开/销毁时恢复 **On**（CC122=127）                                                                                                    | 键盘 Local Control On 时物理按键会由键盘自带音源直接发声，造成练习键双重发声、且与程序输出的非练习轨声源（音量旋钮/力度）不一致；禁用自带音源后，练习键经软件回送、非练习轨经引擎+镜像，均由程序掌控、消除双重发声 |
| 14  | 练习键回送   | 练习模式（门控中）的 noteOn/noteOff 经 `MidiOutputSink.echoNote()` **原样**（音高+力度+通道）回送到键盘输出端口，并经 `transport.liveNoteOn/Off` 驱动电脑引擎（同力度）；`releaseChord()` 不再排期门控轨音符 | 练习轨音量应「按按键力度决定」（像弹真钢琴），故禁用键盘本地音源后用软件回送替代本地发声、同时驱动电脑引擎（戴耳机也能听到自己弹的练习轨）；弹错的音同样发声，仅红显+阻止放行；门控轨不再由程序排期，避免双重发声  |

## 3. 模块与接口

### 3.1 MIDI 接入层（core/midi/connection.ts）

> 本节连接语义已由 `20260907-midi-auto-connect.md` §4.1 修订：改为**自动连接**（进入页面即
> `connect()`，授权后常驻 `MIDIAccess`，靠 `statechange` 感知插拔，不因无设备而超时拆除；
> 去掉 `disconnect()` 与 `timeout` 终态）。以下为修订后形态：

```ts
type MidiConnectionStatus =
  | 'idle' // 未连接（初始；仅工具卸载/未发起前短暂存在）
  | 'connecting' // 授权请求中（requestMIDIAccess 的 Promise 未落定）
  | 'connected' // 已授权且 ≥1 台输入设备挂载（练习模式可用的前提）
  | 'no-devices' // 已授权但无输入设备（常驻等待插入，靠 statechange 自动连上）
  | 'unsupported' // 浏览器不支持 Web MIDI
  | 'denied' // 授权被拒绝
  | 'error' // 其它失败

export const CONNECT_HINT_MS = 5000 // connecting 超时软提示（不拆 access、不失败）
export const CONNECT_TIMEOUT_MS = 5000 // 调试工具「MIDI 键盘」页沿用 5s 诊断超时

class MidiConnection {
  readonly status: MidiConnectionStatus
  readonly connectingHint: string | null // connecting 超时软提示；其余状态为 null
  readonly connectedLabels: readonly string[] // 已连接键盘 厂商+名称 列表；未连接为空数组
  // 只读诊断视图（2026-09-12 新增，供调试页诊断面板；呈现留在调用方）
  readonly requestStartedAt: number | null // 最近一次授权请求的 performance.now()
  readonly errorName: string | null // 最近一次失败的 DOMException 名
  readonly errorMessage: string | null // 最近一次失败的消息文本
  readonly inputCount: number // 已挂载输入端口数
  readonly isShimmed: boolean // 是否第三方 Web MIDI shim（isShimmedMidi() 的实例视图）
  connect(): Promise<void> // 自动连接：请求授权并常驻 access；connected/no-devices/connecting 幂等
  reconnect(): Promise<void> // dispose() 后立刻重连（调试页“重试连接”：作废在途请求）
  dispose(): void // 工具卸载清理：摘监听、移除 statechange、回 idle
  // 构造回调：onStatus(status)、onNote(MidiNoteEvent)（按键）、
  // onControl?(MidiControlChange)（CC：踏板 CC64/66/67 等，2026-09-12 新增）、
  // onOutputs(outputs)（输出端口变化，镜像播放用）
}
```

要点（沿用调查结论 R-WebMIDI）：

- `navigator.requestMIDIAccess({ sysex: false })`；`NotAllowedError` → denied、`NotSupportedError` → unsupported；
- `statechange` 时重新挂载 inputs 并刷新状态（设备热插拔自动感知；`no-devices` 常驻等待插入）；
- **自动连接语义**：`connect()` 请求授权成功后**常驻 `MIDIAccess`**，不因无设备而超时拆除；
  `denied`/`error`/`idle` 可再次 `connect()` 重试；`connecting` 超过 `CONNECT_HINT_MS` 仅经
  `connectingHint` 软提示（不拆、不失败），晚到的结果按真实状态呈现；`dispose()` 自增 attempt
  序号作废在途请求；
- `sync()` 统一负责“刷新状态”：`attachedInputs` ≥1 → connected，0 → no-devices（初始接入与热插拔共用）；
- 端口表遍历统一用 `forEach`（而非 `for…of` / `[...values()]`）：第三方 Web MIDI shim（如 iPad
  的 Web MIDI Browser）提供的 `inputs`/`outputs` 是非原生 Map，其 `values()` 迭代器没有
  `Symbol.iterator`，`for…of`/展开会抛 `TypeError`，导致“授权成功却一直卡在连接中”
  （见研究文档 `20260906-web-midi-ipad.md` §7）。

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
  notes: Note[] // 该组内全部门控轨音符（start ∈ [start, start+EPS]）
  excused: ReadonlySet<number> // 豁免键：start ≤ 起点+EPS 且 end > 起点 的音符音高（任意轨），等待期间按下不算错
}

class Transport {
  practiceTracks: ReadonlySet<number> // 当前门控轨集合（副本）；空集 = 练习关闭
  setPracticeTracks(tracks: ReadonlySet<number>): void // 设置门控轨集合（进入/调整/退出）
  onPracticeChord(cb: (chord: PracticeChord | null) => void): () => void // null = 等待被取消
  releaseChord(): void // 放行当前等待的和弦
}
```

调度语义（`tick()` 在门控集合非空时改走双流调度）：

1. **双流调度**：门控流按和弦等待放行；自由流（非门控轨音符）按 lookahead 窗口
   [pos+15ms, pos+100ms] 排期，但**不越过下一个门控和弦起点**——与门控和弦同 onset 的
   非门控音符不由自由流提前排期，而是随和弦一起等待/放行；
2. **提前触发窗口与等待**：门控流在播放位置进入下一门控音符起点的**提前触发窗口**（起点前
   一个四分音符，按拍速折算）时，收集 `start ≤ 起点 + 30ms` 的整组**门控轨**音符（同窗口内的
   非门控音符不参与判定），回调 `onPracticeChord(chord)`——gate 提前进入判定、允许人提前
   按键；组内音符**不排入引擎**（练习按键经 echoNote 回送键盘音源发声）；位置到达和弦起点后
   冻结（冻结期间自由流暂停排期，整体无声音）。**顺序门控**：只有当前和弦放行后才回调下一和弦；
3. **放行**：`releaseChord()` **不再排期门控轨音符**（它们已由回送发声），只把门控流越过整组、
   打“已排期”标记（退出练习后不重复发声）、回拨 `offset` 从和弦起点继续；随后自由流在放行后的
   tick 以放行时刻补发同 onset 的非门控音符（随和弦一起发声）；
4. **位置冻结**：位置到达已回调的和弦起点时**整体冻结**（`position` 恒停在和弦起点，音符条底
   贴判定线，且不再排期任何音符）。放行时回拨 `offset = now - 和弦起点`——提前放行时位置追到
   和弦起点，冻结后放行时从和弦起点继续；后续音符相对放行时刻排期；
5. **取消等待**（`seek` / `stop` / `pause` / 切换引擎 / 调整或退出门控集合 / 载入新歌）：
   清空等待并回调 `onPracticeChord(null)`；暂停后恢复播放会重新进入等待并再次回调
   （因此暂停期间琴键状态不参与判定，恢复时按当前按住状态重新评估）；
6. **进出练习**：进入/调整门控集合时 `allNotesOff()` 清掉已排期与发声中的音符，两个流指针
   改为“第一个 start ≥ 当前位置”（放弃已开始的音符）；**退出**（清空集合）时不额外清音：
   等待中的和弦立即按正常调度发声并继续——正常流从“第一个未排期音符”继续（已排期的
   自由轨音符按标记跳过，不重复发声）；
7. 门控模式下 `seek` 用 start 指针；播放到末尾的行为与正常模式一致。

### 3.4 匹配判定（core/midi/chord-gate.ts，纯逻辑）

```ts
class ChordGate {
  heldKeys: ReadonlySet<number> // 当前按住的所有键
  wrongKeys: ReadonlySet<number> // 按错的键（红显）
  setChord(pitches: ReadonlySet<number> | null, excused?: ReadonlySet<number>): boolean // 设置等待中的和弦与豁免集合；true = 已按住全部琴键，立即触发
  note(ev: MidiNoteEvent): boolean // 处理按键；true = 本次事件触发
  reset(): void
}
```

判定规则（每次按键事件后评估；`setChord` 在进入等待时评估一次）：

- **触发条件**：和弦的全部音高都处于「新鲜按下」状态（收到过 noteOn 且尚未被放行消费），
  **且**无“按错”标记；
- **按下消费**：和弦放行时消费掉组内各音高——把它们从「新鲜按下」集合移除。因此同音高的
  连续音符（含完全相同的连续和弦）必须**抬起再重新按下**才能再次触发，一直按住一个键
  不会连续触发多个同音音符；
- **按错标记**：等待期间新按下的、不在和弦内、也不在豁免集合内的键记为按错（红显），松开即清除；
  在等待开始**之前**就按住的键（如上一和弦的延续指法）不计入按错、也不阻止触发——
  这是对“多按了键不能触发”的有意收敛：上一和弦遗留的按住键是正确指法的一部分，
  不应被新和弦标红，且不能阻塞 legato 衔接；
- **豁免键**：等待期间按下、不在和弦内、但在豁免集合内（瀑布流键盘上仍在/正进入的音符，如已触发
  的长音符重复按、分轨练习的非练习轨音符）**完全忽略**——不标错、不标记新鲜按下（不重复触发），
  仅反映到按住状态（键仍亮但不发红）。豁免集合由 `Transport` 收集和弦时计算并随
  `PracticeChord.excused` 传入；
- **预先按住**：等待开始时若和弦全部音高已新鲜按下且无按错 → 立即触发（允许提前一点点
  按好琴键，音符一到判定线即放行；这些按键尚未被前一次放行消费时才生效）；
- **纠错后触发**：松开按错的键时若其余条件满足，立即触发（松键也是评估时机）；
- 等待窗口之外的按键不评估、不标红（音符尚未到判定线，弹什么都不算“按错”）。

> 2026-09-12 修订（见 `20260912-midi-pedal-lane-and-practice.md` §3.5）：`setChord()` 第三参数为
> 「要求**现踩**的踏板」（边缘触发），参与判定的踏板改由 `setJudgedPedals()` 持续同步；
> 纯踏板闸门允许 `pitches` 为空集。琴键规则不变。

### 3.5 编排控制器（core/practice.ts）

```ts
// 反馈类型 2026-09-12 更名为 PracticeFeedback 并新增误踩踏板（见 20260912-midi-pedal-lane-and-practice.md §3.5）
interface PracticeFeedback {
  held: ReadonlySet<number>
  wrong: ReadonlySet<number>
  heldPedals: ReadonlySet<PedalId> // 当前踩下的踏板：练习中踏板光晕只作为"踩下"的反馈
  wrongPedals: ReadonlySet<PedalId> // 误踩的踏板（红晕，与按错键同语义；松开即清除）
}

interface MidiUiState {
  status: MidiConnectionStatus
  connectedLabels: readonly string[] // 已连接键盘名列表（多台逐行；未连接为空）
  connectingHint: string | null // connecting 超时软提示；其余状态为 null
}

interface PracticeTrackInfo {
  index: number // 轨道 index（对应 Song.tracks / Note.trackIndex）
  name: string // 轨名（悬浮菜单显示）
}

interface PracticeUiState {
  tracks: readonly (PracticeTrackInfo & { on: boolean })[] // 可练习轨及每轨开关
  active: boolean // 至少一轨开启练习（练习按钮高亮）
  allOn: boolean // 全部轨都已开启（再点练习按钮 = 全部关闭）
  pedalMode: PedalPracticeMode // 踏板练习模式（off/sustain/all，默认 off）——2026-09-12 新增
  pedalFocus: PedalFocus | null // 踏板轨道关注范围（判定 + 高亮）；null = 练习未开启
}

interface PracticeCallbacks {
  onStatus(ui: MidiUiState): void
  onPractice(ui: PracticeUiState): void // 分轨练习状态（轨列表 / 每轨开关 / active / allOn）
  onFeedback(fb: PracticeFeedback | null): void // null = 非练习模式（隐藏键盘与踏板反馈）
  onConnectError(message: string): void // 连接失败（被拒/不支持等）→ 右下角报错通知
}

class PracticeController {
  constructor(opts: { transport: Transport; callbacks: PracticeCallbacks })
  autoConnect(): void // 自动连接（进页面调用；失败态“重连”复用）；MidiConnection.connect 幂等
  setTracks(tracks: readonly PracticeTrackInfo[]): void // 切换曲目：更新轨列表，与旧开关求交
  togglePractice(): void // 非全开（含全关）→ 全开；全开 → 全关
  toggleTrack(index: number): void // 开关单轨（可多选）
  setPedalPractice(mode: PedalPracticeMode): void // 踏板练习三选一（2026-09-12 新增）
  get practiceActive(): boolean
  dispose(): void
}

// 曲目中可练习的轨：出现在播放事件流（song.notes）中的非打击乐轨，按曲目轨序
function practiceTracksOf(song: Song): PracticeTrackInfo[]
```

职责与规则：

1. 持有 `MidiConnection`，`autoConnect()`（**由 `20260907-midi-auto-connect.md` 修订**）：
   进入页面时调用一次，发起自动连接；授权失败（denied/error）后由详情浮层“重连”按钮再次
   `autoConnect()`（幂等）；
2. 连接失败通知（**修订**）：无设备（no-devices）静默；授权被拒（denied）/ 不支持
   （unsupported）/ 其它失败（error）经 `onConnectError` 弹右下角报错；connecting 挂起仅经
   `connectingHint` 浮层软提示、不弹报错；
3. **实时演奏 / 练习按键**：已连接且无门控轨时，noteOn/noteOff → `transport.liveNoteOn/Off`
   （驱动电脑引擎）；有门控轨（练习中）时，noteOn/noteOff → `sink.echoNote(ev)` 原样回送到
   键盘音源（力度=按键力度、通道=输入通道）**并同时 `transport.liveNoteOn/Off` 驱动电脑引擎
   （同力度，弹错的音也发声）**，再参与 gate 判定，满足条件才 `releaseChord()` 放行
   （放行不再排期门控轨音符，避免与回送双重发声）；
4. **分轨练习开关**：`practiceTracks` 集合（轨 index）非空且 connected 时把集合推给
   `transport.setPracticeTracks`，空集合（关闭练习）推空集；仅在 `connected` 时可开启
   任何轨；连接状态离开 `connected`（设备拔出）时**清空全部轨的练习开关**（强制退出）；
5. **练习按钮语义**：全部轨已开启 → 全部关闭；其余（全关或部分开启）→ 全部开启。
   悬浮菜单点击单轨开关该轨（可多选），不在轨列表内的点击忽略；
6. **暂停/播放联动**：开关任意轨练习（练习按钮全开/全关、菜单开关单轨，集合确有
   变化时）自动 `transport.pause()`（仅播放中生效）；练习开启（connected 且有门控轨）
   时收到任意 noteOn 且未在播放 → `transport.play()` 恢复播放（该按键同时参与判定）；
   连接过程不触碰播放状态；连接状态离开 connected（设备拔出，经
   `lastStatus` 前值判定）→ `transport.pause()`；
7. **切换曲目**（`setTracks`）：app 在载入歌曲时传 `practiceTracksOf(song)` 的结果
   （仅列出出现在瀑布流中的非打击乐轨）；练习开关与新的轨列表**求交保留**（换歌不丢
   练习选择，轨号失效的部分丢弃）；
8. **接线**：`transport.onPracticeChord(chord)` → `gate.setChord(pitches, chord.excused)`，
   立即触发时随即 `releaseChord()`；`gate.note()` 返回触发时 `releaseChord()`；每次 gate
   状态变化后经 `onFeedback` 把 `held/wrong` 推给瀑布流；
9. 收到 `null`（等待取消）→ 清空 gate 和弦并重发反馈；
10. **播放镜像**：持有 `MidiOutputSink`（以 `audioCtx` 做时间换算），订阅连接的
    `onOutputs` —— 有输出端口时 `transport.setMidiOutput(sink)`（走带排期的每个音符
    同步发一份到键盘音源），端口清空（断开/拔出）时先静默再解除镜像。

### 3.6 播放镜像（core/midi/output.ts）

```ts
class MidiOutputSink {
  constructor(audioCtx: { currentTime: number })
  sync(outputs: readonly MIDIOutput[]): void // 更换输出端口（连接同步/热插拔/断开清空）；有端口发 Local Off、清空前恢复 Local On
  scheduleNote(ev: { pitch; velocity; time; duration }): void // Note On + 时值结束的 Note Off
  echoNote(ev: MidiNoteEvent): void // 练习按键回送：noteOn/noteOff 原样（音高+力度+通道）发回输出端口
  allNotesOff(): void // 清空未发送队列 + 16 通道 All Notes Off / All Sound Off
  dispose(): void
}
```

- `Transport` 增加可选 `setMidiOutput(sink | null)`：`tick()`（含自由流）的每个非门控音符
  经 `scheduleToBoth()` 同时排入引擎与镜像 sink——**电脑播放与键盘音源逐音符对齐**；门控轨
  音符不再排期（练习按键经 `echoNote` 回送发声）；`pause/stop/seek/换引擎/进出练习/载入新歌`
  的静默路径同时触发 `sink.allNotesOff()`（`MIDIOutput.clear()` 清掉尚未发送的排期消息 +
  全通道止音，避免暂停后键盘残留长音）；
- **时间换算**：`send()` 时间戳基于 `performance.now()`，排期时间是 AudioContext 时间，
  两者同源 → `ts = performance.now() + (time - currentTime) * 1000`；已过期的时间
  不带时间戳（立即发送）；力度钳制 1~127（0 会被键盘解释为 Note Off）；
  - **Note On / Note Off 分别按各自时刻换算**：Note On 按 `time`、Note Off 按
    `time + duration` 各自调用换算。练习放行的音符 `time` 即当前时刻（Note On 已过期、
    立即发送、无时间戳），若据此把 Note Off 也立即发送，会把键盘音源上只响了一半的长音
    切断——Note Off 必须按结束时刻单独排期（已过期的结束时刻才立即发送）；
- **Local Control（禁用键盘自带音源）**：`sync()` 挂载输出端口时发送 **Local Control Off**
  （CC122=0，通道 0）禁用键盘自带音源——物理按键不再由键盘内部音源直接发声；`sync([])`
  （断开/拔出）与 `dispose()` 恢复 **Local Control On**（CC122=127），避免键盘残留无声状态；
- **练习按键回送 + 引擎驱动**：`echoNote(ev)` 把练习模式（门控中）的 noteOn/noteOff 原样
  （音高+力度+通道）发回输出端口，同时 `transport.liveNoteOn/Off` 驱动电脑引擎（同力度）——
  练习轨音量=按键力度、弹错的音也发声，键盘与电脑都能听到自己弹的练习轨；此时门控轨音符
  不再经 `scheduleNote` 排期，避免双重发声；无输出端口时 `echoNote` 为空操作（此时 Local
  Control 未被禁用，键盘本地发声），但电脑引擎仍经 `liveNoteOn/Off` 发声；
- **不回送实时（非练习）按键**：非门控下的按键不镜像到输出端口——Local Control Off 后键盘自带
  音源已静默，实时演奏仅经 `liveNoteOn/Off` 驱动电脑引擎发声，无需回送（避免叠音/回授）；
- 通道固定 0（钢琴主通道，`echoNote` 保留输入通道），发送到全部输出端口。

## 4. UI

### 4.1 入口按钮（播放坞控制行最右端）

> 本节钢琴按钮语义已由 `20260907-midi-auto-connect.md` §6 修订：从“连接/断开开关”改为
> **连接状态展示图标 + 状态浮层**，连接改自动触发。以下为修订后形态：

- 顺序：`[音量][瀑布][乐谱][钢琴][练习]`（练习在最右端；音量、瀑布/乐谱均为图标按钮，
  音量滑块为喇叭图标上方的竖向弹层）；
- **钢琴状态图标**（琴键剪影：描边白键 + 实心黑键，沿用图标语言）三态：
  - **未连接/无设备/失败**：暗色（弱文本色，比常规图标按钮暗一档），tooltip 提示状态/原因；
    点击弹出**状态浮层**（未连接 / 失败原因 + 重连按钮）；
  - **连接中**（connecting）：图标换成**旋转等待圆弧**（CSS 动画），tooltip“正在连接 MIDI 键盘…”；
  - **已连接**：琥珀高亮，tooltip“已连接（点击查看键盘）”，点击浮层列出**全部已连接键盘名**；
- **自动连接**：进入播放器页面即自动 `requestMIDIAccess()`；授权后靠 `statechange` 感知插拔，
  插线即连；不再提供“断开连接”入口；
- 失败通知：`denied/unsupported/error` 右下角弹**报错通知胶囊**（危险色左边条，5s 自动消退 +
  关闭按钮，位置在播放坞右上方）；`no-devices`（无设备）静默；connecting 挂起仅浮层软提示；
- **状态浮层**：钢琴按钮包一层 `position: relative` 包装器，点击切换 `.is-open` 展开/收起，
  点菜单外部空白收起；内容按状态渲染——未连接 / 已连接键盘名列表 / 失败原因 + “重连”按钮
  （denied/error 显示，点击重新请求）；
- **练习图标**：打开的书（左右两页在书脊处相接），标题“练习模式（需先连接 MIDI 键盘）”；
  未连接时 `disabled` 置灰；**只要至少一轨开启练习即琥珀高亮（`is-active`）**；
  - 点击语义：非全开（含全关）→ 开启全部轨练习（tooltip“开启全部轨练习”）；
    全开 → 关闭全部轨练习（tooltip“关闭全部轨练习”）；
- **分轨练习悬浮菜单**：练习按钮包一层 `position: relative` 包装器，桌面端（有 hover）
  hover（含移入菜单途中，桥接带盖住空隙）或 `focus-within` 时在按钮上方展开，`z-index`
  高于播放坞；触控端（无 hover）点击练习按钮切换 `.is-open` 展开/收起，点菜单外部空白收起；
  - 菜单内容：标题“分轨练习”+ 每轨一行——**瀑布流轨色渐变图例**（`trackColor(index)` 顶/底
    色）+ 轨名（超长省略）+ 右侧开关圆点（开启时琥珀点亮、行内琥珀淡底）；
  - 点击某行开关该轨练习，**菜单不收起**（可多选）；未连接 MIDI 键盘时行 `disabled`
    置灰不可点，但菜单仍可悬浮查看；无曲目时显示“载入曲目后，这里可以按轨开启练习”占位；
  - 菜单只列出出现在瀑布流中的轨（`practiceTracksOf(song)`：非打击乐、有音符，按曲目轨序）；
- 开启任意一轨练习时若当前不是瀑布流视图，自动切到瀑布流（练习的视觉载体是瀑布流键盘）。

### 4.2 瀑布流键盘反馈（仅练习模式）

- 按住键：琥珀 `#d9a45b` 半透明点亮（含黑键），画在轨色点亮之上；
- 按错键：语义色 `#e0695e` 高不透明 + 同色光晕，画在最上层；
- 数据来自 `onFeedback`，`setFeedback(null)` 清除（退出练习模式）；
- （2026-09-12）误踩踏板：在曲目并未踩着该踏板的时刻踩下「参与判定」的踏板 → 同色红晕画在
  踏板列与键盘交界处（位置与银白触发光晕一致），松开即清除；曲目正踩着该踏板（踩下持续期间）时
  踩下不算误踩——长踏板与长音符同等对待，见
  `20260912-midi-pedal-lane-and-practice.md` §3.4/§3.5；
- **分轨压暗**：有轨开启练习时，app 把开启练习的轨集合传给
  `waterfall.setPracticeTracks(gated)`——练习轨正常显示，**非练习轨**的瀑布流音符条
  与琴键点亮按亮度 0.6 / 不透明度 0.62 压暗（比正常暗淡一点、仍清晰可辨），突出正在
  练习的轨；练习关闭（断连/全关）传 `null` 恢复全部正常显示。
- **实现（2026-09-06）**：瀑布流键盘与「MIDI 键盘」调试页共用 DOM 钢琴组件
  （`ui/piano-keyboard.ts`，见视觉风格指南 §3.4/§6.4）——轨色点亮、渐隐与练习反馈
  由 `setLit` 逐键合成（反馈色叠在轨色之上），组件内部把点亮色按 alpha 混合到键的
  基础渐变上，等效于画布时代的分层覆盖。

## 5. 验收

> 连接相关验收项已由 `20260907-midi-auto-connect.md` §7 修订，此处同步为修订后形态：

- 进入播放器页面自动发起连接；已授权用户秒连、零点击；首次进入弹出浏览器授权提示；
- 授权后未插键盘：状态图标暗色、浮层“等待插入 MIDI 键盘”、**不弹报错**；插入键盘后经
  `statechange` 自动连上并高亮；
- 拔出键盘：图标转暗、练习开关清空、播放暂停、Local Control 恢复 On；再插入自动重连；
- 已连接时点击图标：浮层列出全部已连接键盘名（多台逐行）；不再提供“断开连接”入口；
- 失败（denied/unsupported/error）：右下角报错通知；浮层显示失败原因，denied/error 附重连；
- connecting 长期挂起：浮层“授权请求超时…”软提示，不拆 access、不弹报错，晚到结果按真实状态呈现；
- 连接 MIDI 键盘后按键即发声、离键即止（音色 = 当前引擎）；
- 键盘有输出端口时：连接即发送 Local Control Off（禁用键盘自带音源）；练习模式按键（含弹错的音）
  原样回送到键盘音源（力度=按键力度）并驱动电脑引擎（同力度），非练习轨走电脑引擎 + 键盘镜像
  （力度=原曲）；拔出/销毁恢复 Local Control On；
- 未连接时练习图标置灰不可点；连接后可点、断开后自动退出并恢复置灰；
- 练习模式：音符进入提前触发窗口（起点前一个四分音符）即可按键判定，落到判定线停住；
  按下练习键即经回送 + 引擎发声（力度=按键力度），按对全部和弦键后继续下落；提前按键可在
  音符到达前放行（位置追到和弦起点）；
- 按错/多按：错误键红显且**仍发声**（回送 + 引擎），但不触发播放；松开后红显消失；纠错后按对立即放行；
- 豁免键：已触发的长音符在其瀑布流键盘持续期间内重复按不判错、不重复触发；分轨练习时按下
  与当前和弦同 onset 或仍在键盘上的非练习轨音符不判错、不阻止练习轨触发；
- 顺序门控：前一和弦放行后才进入下一和弦的判定（不能跳按）；
- 播放/暂停/停止/拖拽跳转在练习模式下语义不变；暂停期间松键/换指恢复后按当前按住状态重新判定；
- 分轨练习：
  - 悬浮练习按钮即展开菜单：每行 = 轨名 + 对应瀑布流颜色图例；点击行开关该轨，菜单不收起、可多选；
  - 部分门控：开启练习的轨等待琴键（和弦判定仅含门控轨音符），整个播放冻结在判定线
    （无声音、位置停驻）；放行时门控音符与同 onset 非门控音符一起发声，后续音符相对放行推进；
  - 部分门控时练习轨瀑布流正常显示，非练习轨瀑布流（音符条与琴键点亮）明显变暗；全关恢复；
  - 全轨门控：行为同部分门控（位置冻结在判定线，放行后从和弦起点继续）；
  - 练习按钮：全关/部分开点击 → 全开；全开点击 → 全关；至少一轨开启时按钮高亮；
  - 换曲后菜单显示新曲目轨；练习开关与新曲目轨号求交保留；断连清空全部分轨开关；
- 暂停/播放联动：
  - 练习开启时暂停：按下 MIDI 键盘任意琴键即恢复播放（该按键仍参与判定）；
  - 开关练习（练习按钮全开/全关、菜单开关单轨）自动暂停；
  - 连接 MIDI 键盘不改变播放/暂停状态；断开（点击断开/设备拔出）自动暂停；
- （2026-09-12 增补）踏板轨道与踏板练习的验收见 `20260912-midi-pedal-lane-and-practice.md` §4；
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` 全绿。

## 6. 非目标

- 不判定节奏（按键时刻不影响音符时值/音量，只做“放行”门）；
- 不做按错统计、评分、练习记录持久化；
- **不回送实时（非练习）按键**到输出端口（Local Control Off 后键盘自带音源已静默，实时演奏
  仅经电脑引擎发声；如需让键盘自带音源也随实时演奏发声，可留待后续加“回送按键”开关）；
- **不镜像延音踏板**（CC64）：走带仍不向输出端口调度 CC，键盘音源听感无踏板；后续
  若做 CC64 调度可一并镜像。共享层已能收到 CC（`onControl`，2026-09-12），练习模式自
  2026-09-12 起消费 CC 做踏板判定（`20260912-midi-pedal-lane-and-practice.md`），但不外发；
- ~~不改调试工具“MIDI 键盘”页面（其接入逻辑未来可迁移到 `MidiConnection`，本次不迁移）~~
  —— **2026-09-12 已完成迁移**（见 `20260912-midi-debug-velocity-pedal.md` §3.3）：调试页不再自持
  `requestMIDIAccess` 流程，改用 `MidiConnection`；诊断面板/5s 超时/重试/文案仍留在调试页。
