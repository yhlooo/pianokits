# 设计：MIDI 录音工具（`/midi-recorder`）

- 日期：2026-09-12
- 状态：**正式生效（2026-09-12 实现）**
- 关联参考：`docs/development/reference/midi/format-and-libraries.md`（§1 SMF 格式要点、§2.1 @tonejs/midi 的读写）
- 前置设计：
  - `docs/development/design/20260905-tool-routing.md`（工具页 = `/{工具 id}`，本工具即 `/midi-recorder`）
  - `docs/development/design/20260906-midi-keyboard-and-practice.md`（MIDI 连接层与输出镜像的既有做法）
  - `docs/development/design/20260907-midi-auto-connect.md`（进入页面自动连接、无设备静默等待）
  - `docs/development/design/20260905-ui-visual-style.md`（暗色舞台 + 琥珀强调 + 内联图标）
- 影响文档：仅本文档（开发文档）。面向用户的 `docs/usage/`、`README.md` 由用户维护——
  按 AGENTS.md 口径（2026-09-12 更新），开发过程中不在未获用户要求时直接修改它们；
  因此实现变更（如工具更名「播放 / 练习」、计时器格式、提示色）不会自动同步到用户文档。

## 1. 需求

用户原话拆解与落地口径：

| #   | 需求                                                                                                                             | 落地口径                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | 新增工具「录音」，顶部菜单栏出现按钮，页面 URI `/midi-recorder`                                                                  | 工具注册表新增 `{ id: 'midi-recorder', name: '录音' }`；路径由既有路由机制从 `id` 生成（§3.1）                                             |
| R2  | 录的是 MIDI 信号而非麦克风声音，产出 `.mid` 文件可下载                                                                           | 采集 Web MIDI 的 Note On/Off（`MidiConnection.onNote`），导出 SMF 字节（§3.6）                                                             |
| R3  | 界面中央是音轨；开始录制后音轨向左移动；录制/播放线在中间                                                                        | 音轨 = 钢琴卷帘画布；线固定在音轨区水平中心，时间轴 `position` 前进 → 内容左移（§3.4）                                                     |
| R4  | 识别到音符后在录制线上生成条：长 = 时值、颜色深浅 = 力度、高 = 音高，一格半音                                                    | 音符条纵向占一行（半音行）、横向跨度 = `[start, end]`、填充透明度随力度（1~~127 → 0.30~~1.00）                                             |
| R5  | 音轨最左标注 C4 D4 E4 等音高；每个音高有浅横线分隔                                                                               | 左缘 54px 音名列（白键音名常显、黑键音名行高 ≥12px 时同标）；每行一条浅横线、八度分界（C）更亮（§3.4）                                     |
| R6  | 音轨下方居中 5 个按钮：播放 ▶、录制 ●、结束 ■、保存（软盘）、下载 ⬇                                                              | 控制行居中，顺序即此；结束/保存/下载在音轨为空时禁用（§3.5）                                                                               |
| R7  | 播放和录制在开始后变为暂停按钮                                                                                                   | 播放中显示 ⏸（`mode === 'playing'`）、录制中显示 ⏸（`mode === 'recording'`），再点暂停                                                     |
| R8  | 结束表示清空音轨，有内容才能点，需二次确认「该操作将清空音轨中记录的数据，是否继续」                                             | 确认弹窗文案逐字采用；确认后清空、位置归零（§3.5）                                                                                         |
| R9  | 下载弹框输入文件名，默认 `yyyyMMdd-hhmmss.mid`                                                                                   | 文件名弹窗（默认值取当前本地时间）；未写 `.mid` 时自动补（§3.5）                                                                           |
| R10 | 保存到播放器的本地存储，弹框输入文件名，默认 `yyyyMMdd-hhmmss`                                                                   | 编码为 `.mid` 后写入「播放 / 练习」工具同一个 IndexedDB 文件库（`files`），切到播放器「音乐库」即可见（§3.5）                              |
| R11 | 左右拖动音轨移动播放/录制位置；线在中间；开始播放/录制从线位置起                                                                 | 拖动改变 `position`（内容跟手）；播放指针按 `position` 重定位（§3.3）                                                                      |
| R12 | 录制/播放期间拖动：拖动后继续，但拖动期间不录制/不播放                                                                           | 拖动开始挂起（止音、停表、录制中的按键就地收尾），松手后从新位置继续（§3.3）                                                               |
| R13 | 必须连接 MIDI 键盘才可用；未检测到则播放/录制不可点击，Tips 提示「请先连接 MIDI 键盘」                                           | 播放/录制按钮以 `MidiConnection.status === 'connected'` 为禁用条件；悬停/点击禁用按钮弹出 Tips（§3.4）                                     |
| R14 | 播放通过连接的 MIDI 键盘，本机不播放                                                                                             | 回放只走 `MidiOutputSink` → `MIDIOutput.send`；工具内不创建 AudioContext、不加载采样                                                       |
| R15 | 音轨上方计时器，`00:00` 格式且**秒带两位小数**（如 `23:34.99`），超过 60 分钟继续累加（99:23.45、102:23.45）                     | 新增 `formatClock`（分补零到 2 位、以百分秒向下取整、不折算成小时），显示 `position`；播放器进度条的 `formatTime` 保持整秒原样             |
| R16 | 录制用**覆盖录制**：开始录制后录制线扫过的内容变更为新录制的音符、抹除之前的信息；线没到的位置不抹除，音符被扫过一半就只抹掉一半 | 一次录制 = 一次"扫过"（pass）：按 `[passStart, 线位置]` 擦除旧内容（不分音高，跨边界音符裁掉被扫到的部分），新音符写进这一段（§3.2、§3.3） |

## 2. 关键决策（先说答案）

- **D1 时间轴模型**：音轨是一条从 0 秒起、只增不减的绝对时间轴；`position` = 录制/播放线所在时刻，
  视图按 `x(t) = centerX + (t - position) × PX_PER_SEC` 映射。录制推进 `position` → 内容自然左移，
  拖动改变 `position` → 内容跟手；音符只存绝对秒数，不存在"轨道偏移"这类第二状态。
- **D2 录音语义 = 覆盖录制（punch-in）**（2026-09-12 用户口径修订）：一次录制 = 一次**扫过**
  （pass），录制线从起点扫到当前位置，`[passStart, 线位置]` 区间内的**旧内容按扫过的范围抹除**
  （不分音高——这正是与"叠加"的区别），新弹的音符写进这一段。没被线扫到的位置原样保留；
  音符被扫过一半就只抹掉被扫到的那半（跨边界裁掉、跨两端切成前后两段）。
  因此重录一段 = 把线拖到那段起点、直接弹；不想要的内容会在录制线走过时消失。
  「结束」仍是唯一的整体清空方式（见 D4/D12 关于暂停与拖动的边界）。
- **D3 播放/录制互斥、都可暂停**：`mode ∈ {idle, playing, recording}`；播放中点录制会先暂停播放。
  暂停不是"停止"（停止/清空由「结束」承担），暂停后再点即从当前线位置继续。
- **D4 拖动 = 挂起而非停止，且是覆盖录制的分段点**：拖动期间时钟停走、输出止音、录音的按键就地收尾，
  并在拖动起点**结束本次扫过**（已扫过的区间落定擦除）；松手后按原模式从新位置继续——录制会从新位置
  **重新开始一次扫过**（否则往回拖会把没扫到的区域也抹掉，违背"线没到的不抹除"）。
- **D5 未连接键盘的判定用输入端口**：与播放器练习模式一致，`connected` = 至少一台 MIDI 输入；
  播放实际需要输出端口，但绝大多数键盘同时提供输入/输出，缺输出时回放静默（不额外禁用按钮）。
- **D6 回放/监听都经键盘音源**：连接输出端口后 `MidiOutputSink.sync` 会关闭键盘的 Local Control
  （避免叠音），因此按键必须**回送**（`echoNote`）才听得见——与播放器练习模式同一做法；
  录音采集的同时回送，弹奏者可听到自己弹的音，电脑端全程静默（R14）。
- **D7 音轨显示钢琴全键盘 88 键（A0~~C8，MIDI 21~~108）**（2026-09-12 用户口径修订：88 键都要能看见）：
  88 行等高排布、行高 = 画布高 / 88（900px 窗口下约 8px/行），保证"一格一个半音"的网格稳定，
  不做纵向滚动/自动移位；只有 88 键之外的 MIDI 音（0~~20、109~~127）不画，但仍会被录制与导出。
  行高变密后音名字号随行高缩放（7~11px），88 键时只标白键音名以免上下行重叠。
- **D8 导出为 SMF 用既有依赖 `@tonejs/midi` 的编码器**（`Midi#toArray()`），与 `parse.ts` 同一库、天然可往返；
  不手写二进制编码器（参考文档 §1 的 VLQ/块结构只用于核对）。PPQ 480、速度 120 BPM。
  **轨名只用 ASCII**：该库的文本事件按 latin-1 逐字节写出，中文轨名在文件里会变乱码。
- **D9 弹窗用原生 `<dialog>` + `showModal()`**：Esc/遮罩关闭、焦点管理由平台提供（`ui/dialog.ts` 两个原语）。
- **D10 播放到末尾自动暂停**；在末尾再点播放则从头开始（与播放器一致，避免"点了没反应"）。
- **D11 键盘拔出/连接丢失自动暂停**（录音把按住的键收尾），已录音符保留。
- **D12 音轨在同一页面会话内跨工具保留**：切到其它工具会卸载本页，卸载时把音轨与线位置存入
  `recorder-app.ts` 的模块级变量，切回时经 `RecorderController.restore()` 还原（刷新页面不保留，不做持久化）。
  理由：录完去播放器看一眼再切回来是常见动线，切换工具就丢内容会让人不敢切页；真正需要长期留存的
  路径是「保存到播放器文件库 / 下载」（R9、R10）。

## 3. 架构设计

### 3.1 分层与数据流

```
src/tools.ts                  ← 注册工具 { id: 'midi-recorder', name: '录音' }（顶栏页签 + 路由 /midi-recorder）
src/recorder-app.ts           ← 装配：控制器 ↔ 视图、保存/下载/清空三个文件动作、通知胶囊、rAF 循环
src/core/recorder.ts          ← RecorderController：时间轴走带（时钟/模式/拖动挂起）+ 采集 + 回放调度 + MIDI 连接
src/core/recorder-model.ts    ← RecordedNote 领域模型 + overlayNote / trackDuration / firstNoteAtOrAfter（纯函数）
src/core/midi/write.ts        ← writeMidi：RecordedNote[] → SMF 字节（@tonejs/midi 编码）
src/core/midi/connection.ts   ← （既有）输入接入：自动连接、热插拔、Note/CC 解码
src/core/midi/output.ts       ← （既有）输出镜像：Local Control 控制、排期 Note On/Off、止音
src/storage/library.ts        ← （既有）播放器文件库（IndexedDB `files`）：保存目标
src/ui/recorder-view.ts       ← 视图：钢琴卷帘画布 + 计时器 + 5 按钮 + Tips + 拖动手势
src/ui/dialog.ts              ← （新增）模态弹窗原语：confirmDialog / promptDialog / closeDialogs
```

**边界取舍**：

- 录音"什么时候、录了什么"是**走带状态机**，归 `RecorderController`（可注入时钟与定时器，纯逻辑可单测）；
- 音符的时间裁剪（覆盖擦除 / 同音高接管）是**与走带无关的纯函数**，归 `recorder-model.ts`（切分规则单测覆盖）；
- 视图只画"位置 + 当前可见音轨 + 模式"，不理解录音语义；拖动只上报"新的线位置"，是否挂起/如何分段由控制器决定；
- 文件动作（保存/下载/清空确认）是**宿主 I/O**，留在装配层 `recorder-app.ts`，控制器不碰 Blob/IndexedDB。

### 3.2 领域模型（src/core/recorder-model.ts）

```ts
/** 录制得到的音符（时间轴绝对秒数） */
export interface RecordedNote {
  pitch: number // 0~127
  velocity: number // 1~127（力度 → 条的颜色深浅）
  start: number // 秒
  end: number // 秒（> start）
  channel: number // 0~15（录制时保留，回放/导出沿用）
}

export const MIN_NOTE_SEC = 0.02 // 同刻按下/松开也留出可听、可画的最短时值
export function overlayNote(notes, note): RecordedNote[] // 放进一个音符（同音高接管），返回新的有序数组
export function eraseRange(notes, from, to): RecordedNote[] // 覆盖擦除 [from,to] 内的全部内容（不分音高）
export function mergeNotes(a, b): RecordedNote[] // 合并两条有序音轨（保持升序，同 start 按音高）
export function trackDuration(notes): number // 最后一个音符的结束时刻
export function firstNoteAtOrAfter(notes, position): number // 回放指针二分定位
```

三者共用同一个 `clipOutside(note, from, to)` 时间裁剪内核：完全在窗口内 → 空；只被切掉头/尾 → 一段；
窗口落在音符中间 → 前后两段；不相交 → 原样。区别只在窗口怎么来：

- `eraseRange`（**覆盖录制**）：窗口 = 录制线扫过的 `[passStart, 线位置]`，**不分音高**——这一段里的一切
  都被带走；
- `overlayNote`（**同一音高的接管**）：窗口 = 新音符的 `[start, end]`，且只作用于**同音高**旧音符——
  一个音高同一时刻只能响一个音（同音高重触发、跨通道重音都靠它收尾）。

函数都不修改入参；`eraseRange` 在 `to <= from`（还没扫过）时原样返回。

### 3.3 走带控制器（src/core/recorder.ts）

状态：`mode`（idle/playing/recording）、`running`（时钟是否推进，拖动挂起时为 false）、
`position`（线位置）、`_notes`（已提交音轨）、`_passStart`/`_passNotes`（本次覆盖录制的起点与新音符）、
`held`（录制中按住的键）、`nextIndex`（回放排期指针）。
时钟注入 `RecorderHost { now(), setInterval, clearInterval }`，生产实现为 `performance.now() / 1000`
（与 `MIDIOutput.send` 的时间戳同源，见 `core/midi/output.ts` 的换算）。

**覆盖录制的 pass 模型**（R16/D2）：一次录制 = 一次"扫过"。进行中时

```ts
visibleNotes() = mergeNotes(eraseRange(_notes, _passStart, position), _passNotes)
```

即"旧音轨按已扫过的区间擦除"+"本次录制的新音符"；由于 `position` 每帧在涨，**擦除是渐进的**——
被线扫过的旧音符一点点从头部消失，线没到的部分原样保留（视图每帧取 `visibleNotes()` 绘制，
所以它返回新数组，不能只靠离散状态快照）。暂停/拖动/断开时 `commitPass(线位置)` 把这次擦除落定
（`_notes = mergeNotes(eraseRange(...), _passNotes)`），下一次录制从新位置重新起一次 pass。

| 方法                                  | 行为                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `togglePlay()`                        | 未连接或可见音轨为空 → 空操作；已到末尾 → 先回到 0；从 `position` 二分定位指针、起时钟与 25ms 调度定时器 |
| `toggleRecord()`                      | 未连接 → 空操作；从 `position` 起一次 pass（覆盖录制）；再点 → 收尾按住的键 + `commitPass`、停表         |
| `clear()`                             | 结束：停表、止音、丢弃音符与 pass 状态、位置归零（二次确认在装配层）                                     |
| `beginScrub()`/`scrub()`/`endScrub()` | 挂起 → 只改位置 → 从新位置继续；录制中在拖动起点 `commitPass`、松手后从新位置 `beginPass`（D4）          |
| `visibleNotes()`                      | 当前可见音轨（覆盖录制中为擦除后的结果），视图与导出共用                                                 |
| `exportNotes()`                       | 保存/下载快照：`visibleNotes()` + 录制中尚未收尾的音符（补到当前线位置；不改走带状态）                   |
| `pendingNotes()`                      | 录制中尚未收尾的音符（`end` = 当前线位置），供视图把条形画到录制线                                       |
| `onNote(ev)`                          | 回送到键盘音源（D6）；录制中且未挂起时按 Note On/Off 建/收音符（收尾的音符进 `_passNotes`）              |

回放：`tick()` 把 `[pos + 15ms, pos + 100ms]` 窗口内开始的音符经 `MidiOutputSink.scheduleNote` 排入输出
（`time = timeAt(note.start)`，通道沿用音符通道；`ScheduledNote` 为此新增可选 `channel` 字段，
音频引擎忽略该字段）；已结束的音符不补发；`pos >= duration` 时自动暂停。暂停/拖动/清空都调用
`sink.allNotesOff()`（All Notes Off + All Sound Off，16 通道）避免键盘残留长音。

时长/位置不设上限：录音可持续推进，计时器照实累加（R15）。

### 3.4 视图（src/ui/recorder-view.ts）

- **几何**：音域 MIDI 21（A0）~108（C8）共 88 行；行高 = 画布高 / 88；左侧 54px 音名列；
  横向 64 px/秒（视窗内约 18 秒）；线位于音轨区（画布去掉音名列后）水平中心。
- **绘制顺序**：背景渐变 → 黑键行底色 → 每行浅横线（C 行更亮）→ 每秒淡竖线（5 秒略亮）→
  已录音符 → 录制中的音符（亮白描边）→ 录制/播放线 → 音名列与分隔线。
  **音轨内不画任何说明文字**（2026-09-12 用户口径）：提示信息只出现在按钮 Tips 与控件上，
  画面留给音符（此前的"请先连接 MIDI 键盘""按 ● 开始录制…"两处居中提示均已移除）。
  正在发声的音符（线落在时值内）额外描淡白边；录制线红色、播放线琥珀，均带 8px 淡光带。
- **音符条**：`rgba(230,186,118) → rgba(168,119,46)` 竖向渐变，透明度 `0.30 + 0.70 × (velocity-1)/126`；
  极短音符至少 2px；越界部分裁剪，音域外不画。
- **计时器**：音轨上方居中，`formatClock(position)` = `mm:ss.ff`（`00:00.00`、`00:12.34`、`23:34.99`；
  超过 60 分钟继续累加：`99:23.45`、`102:23.45`）。以百分秒向下取整，避免四舍五入出现 `00:60.00`；
  每帧刷新（无变化不写 DOM），EB Garamond 的数字等宽（实测 `00:00.00` 与 `11:11.11` 同宽），跳字不抖动。
- **状态行**：右上角只显示已连接信息（`已连接：<键盘名>`）；未连接时不在这里重复提示，
  连接提示统一由禁用按钮的 Tips 承担（2026-09-12 试用反馈：同一句话在页面上出现三次太吵）。
- **按钮**：见 §3.5 表格；播放/录制外面包一层 `span`（disabled 元素不派发鼠标事件），
  包装器负责 hover 显示 Tips、点击禁用按钮闪现 2.5 秒。
- **拖动**：`pointerdown` 记录起点，水平位移超过 3px 才算拖动（避免误触）并回调 `onScrubStart`，
  之后每次移动回调 `onScrub(startPos - dx / PX_PER_SEC)`（内容跟手），`pointerup/pointercancel` 回调 `onScrubEnd`；
  画布 `touch-action: none`，触控横拖不被浏览器接管。
- **尺寸**：`ResizeObserver` 监听舞台，按 `devicePixelRatio` 设置画布位图并 `setTransform` 缩放。
- **重绘**：每帧 `render(position, pending)`；位置未变、待收尾集合未变（非录制时为同一常量引用）且无
  脏标记时跳过绘制，空闲时不空转。

### 3.5 按钮语义与文件动作

| 按钮         | 图标  | 可用条件                     | 行为                                                                   |
| ------------ | ----- | ---------------------------- | ---------------------------------------------------------------------- |
| 播放/暂停    | ▶ / ⏸ | 已连接键盘 **且** 音轨有内容 | 从线位置回放/暂停（禁用时 Tips：未连接 → 提示连接；空轨 → 提示先录制） |
| 录制/暂停    | ● / ⏸ | 已连接键盘                   | 从线位置录制/暂停（禁用时 Tips：`请先连接 MIDI 键盘` 等）              |
| 结束（清空） | ■     | 音轨有内容                   | 二次确认「该操作将清空音轨中记录的数据，是否继续」→ 清空并复位位置     |
| 保存         | 软盘  | 音轨有内容                   | 弹窗输入文件名（默认 `yyyyMMdd-hhmmss`）→ 编码后写入播放器文件库       |
| 下载         | ⬇     | 音轨有内容                   | 弹窗输入文件名（默认 `yyyyMMdd-hhmmss.mid`）→ 触发浏览器下载           |

- 保存与下载共用 `writeMidi(controller.exportNotes())`；文件名缺 `.mid`/`.midi` 后缀时自动补 `.mid`。
- 保存走既有 `FileLibrary.importFiles`（IndexedDB `files` 对象仓），与播放器「音乐库」同一份数据，
  不新增存储路径（AGENTS.md 的单一持久化路径口径）。
- 结果经顶部通知胶囊反馈（复用 `.notice` 视觉）：**成功用 `notice--success`（绿色左边条）**，
  失败保持默认红色左边条并显示原因；保存成功文案简化为「已保存到播放器：xxx.mid」（工具已更名为「播放 / 练习」，故界面文案用简称「播放器」）。
  胶囊在录音页额外带 `notice--recorder`（下移到计时器行之下），避免盖住计时器。
- 卸载本工具时把音轨与线位置写入模块级会话变量，切回时 `restore()` 还原（D12）；`dispose()` 仍会
  释放 MIDI 连接并恢复键盘 Local Control。

### 3.6 SMF 编码（src/core/midi/write.ts）

`writeMidi(notes, { bpm = 120, trackName = 'PianoKits Recording' })`：`new Midi()` → `header.setTempo` →
按 `channel` 升序分轨（一通道一轨，多通道时轨名 `… Ch{n}`）→ `track.addNote({ midi, time, duration,
velocity: v/127, noteOffVelocity: 0 })` → `midi.toArray()` → 精确长度的 `ArrayBuffer`。
音高/力度/通道钳制到合法字节，非正时值丢弃，空数组也写出合法（无音符）文件。

## 4. 与既有模块的关系

- **输入**：复用 `MidiConnection`（自动连接、`statechange` 热插拔、message 解码），不新增 Web MIDI 访问路径；
- **输出**：复用 `MidiOutputSink`；`ScheduledNote` 新增可选 `channel`（默认 0，保持既有调用不变），
  使录音回放保留录制通道；
- **存储**：复用 `FileLibrary` / IndexedDB，不新增对象仓；
- **弹窗**：新增通用 `ui/dialog.ts`（原生 `<dialog>`），后续工具可复用；
- **路由/外壳**：不新增机制，`Tool` 注册即获得顶栏页签与 `/midi-recorder` URI。

## 5. 非目标

- 不做麦克风/音频录音，不做音频文件导入；
- 不做节拍器、量化（音符时间就是演奏时刻）、速度/拍号编辑（导出固定 120 BPM、4/4）；
- 不做纵向滚动（88 键一次全显示，D7）、不做多轨/分轨录音（多通道录制合并到同一条音轨显示）；
- 不做撤销/重做；局部擦除靠**覆盖录制**（把线拖到目标位置重弹，见 D2），整体清空用「结束」；
- 不在本机播放（R14），也不做键盘音色/音量控制（沿用键盘自身设置）。

## 6. 验证

- 单元测试：`src/core/recorder-model.test.ts`（同音高接管 / `eraseRange` 覆盖擦除的裁切与切分 /
  `mergeNotes` / 时长 / 指针）、
  `src/core/recorder.test.ts`（连接要求、录制时值与通道、同音高重触发、暂停续录、
  **覆盖录制：渐进擦除 / 只抹扫过的部分 / 导出同步 / 拖动分段**、拖动挂起与恢复、
  回放排期与时间戳、末尾自动暂停、清空止音、导出快照、会话恢复）、`src/core/midi/write.test.ts`
  （`parseMidi` 往返：音高/力度/时间/通道、多通道分轨、力度极值、空输入、钳制）、
  `src/ui/dom.test.ts`（`formatClock` 分补零与超过 60 分钟、`formatFileStamp`）；
- `pnpm format:check` / `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`；
- 浏览器端（`scripts/probe-recorder.mjs`，Playwright + 注入假 Web MIDI）：页签与 URI、按钮禁用与 Tips
  （悬停/点击禁用按钮）、假键盘发送 Note On/Off 后音符条出现并左移、拖动改变线位置、
  切走再切回音轨与线位置保留、键盘拔出自动暂停、结束二次确认（取消保留 / 确认清空）、
  下载弹窗默认文件名与空名校验（真实下载并校验 `MThd` 文件）、保存后播放器音乐库出现新条目、
  **在已有内容上覆盖录制后导出：被扫过的时间段内不再有旧音符**；
  已下载文件用 `@tonejs/midi` 复核：Format 1 / 480 PPQ / 120 BPM / 音高力度时值通道一致。
