# 调查：踏板信息没有进入声音链路（播放 / 练习输入都听不到延音）

- 日期：2026-09-13
- 触发：用户反馈「MIDI 播放器里播放 .mid 与练习输入回放都听不到踏板（延音不延），机内音响与
  MIDI 键盘音源都没有」
- 复现/验证工具：`scripts/probe-pedal-sound-gap.mjs`（真实 Chromium + 假 Web MIDI + 合成 MIDI）
- 相关设计文档：`docs/development/design/20260906-midi-keyboard-and-practice.md` §6、
  `docs/development/design/20260912-midi-pedal-lane-and-practice.md` §7（两条明确写下的非目标）

## 1. 结论（先说答案）

**不是解析或数据丢失问题，也不是回归**：`Song.pedalEvents` 解析、瀑布流踏板条、练习判定、
记谱延长都正常工作——**只有"声音"这一条链路从未实现踏板**。

`AudioEngine` / `MidiOutputSink` 两个接口里根本没有踏板（CC）能力位，`Transport` 排期时也从不
查 `pedalEvents`：

- 机内引擎：音符一律按 `duration = note.end - note.start`（**键按时值**）排期，踏板不参与；
- MIDI 输出镜像：只发 Note On / Note Off，不发任何曲目 CC；
- 练习/实时输入：踏板 CC 只交给 `ChordGate` 做判定，既不回送到输出端口，也不进引擎——
  而连接键盘后已发 Local Control Off（键盘自带音源被关闭），于是**物理踏板在两条声音路径上
  都完全无声**。

即：**"判定要踏板、声音没踏板"**——练习模式把踏板提升为放行条件（不踩不放行），踩下去却听不出
任何区别；五线谱已按 CC64 延长长音、瀑布流已画踏板条，唯独声音不延长，同一曲目三处口径不一致。
按设计文档口径这是**未实现的功能（非目标遗留）**，但从产品一致性看是实打实的功能缺陷，
且需要一次设计（不是改几行）。

## 2. 实测证据

### 2.1 运行时探针（合成曲目）

合成曲目：三个音键按 0.3s（0.5 / 1.5 / 2.5s），延音 CC64 踩着 0.4–4.5s（正确行为下 voice 应
持续到踏板抬起，而不是 0.3s）。`node scripts/probe-pedal-sound-gap.mjs` 实测：

| 观测点                     | 实测结果                                       | 应有结果                 |
| -------------------------- | ---------------------------------------------- | ------------------------ |
| 输出端口 NoteOn            | 3 条                                           | 3 条 ✓                   |
| 输出端口 CC                | `{CC122:1, CC123:32, CC120:32}`（**无 CC64**） | 含 CC64 踩下/抬起        |
| 机内引擎 voice 发声时长    | `[0.8, 0.8, 0.8]` 秒（0.3 键按 + 0.5 release） | ≈ 4.0 / 3.0 / 2.0 秒     |
| 物理踏板 CC64=127→0 后回送 | 踏板 CC 条数 0 → **0**（无任何反应）           | 至少 2 条（踩下 + 抬起） |

（`CC122` = Local Control Off，`CC123`/`CC120` = 停止时的 All Notes Off / All Sound Off，
都是既有行为，与踏板无关。）

### 2.2 真实曲目的听感差异（`.tmp/梦中的婚礼.mid`）

按记谱侧既有语义（`quantize.ts` 的 `extendWithSustain`：踏板踩住期间，音符结束延长到
「踏板抬起」与「同音高下一次 note-on」先到者）计算：

| 指标             | 数值                         |
| ---------------- | ---------------------------- |
| 音符 / CC64 事件 | 1058 / 204（101 段踩下区间） |
| 被踏板延长的音符 | 822（**78%**）               |
| 总发声时长       | 309.1s → 568.6s（**+84%**）  |
| 最长单音延长     | 2.08s                        |

即：这类真实钢琴曲目的绝大多数音被砍短——"延音没有延"的听感非常明显。

### 2.3 真实曲目的通道分布（决定镜像口径）

`node scripts/inspect-midi.mjs` 实测：

| 文件                        | 轨数 | 各轨通道 | CC64                 |
| --------------------------- | ---- | -------- | -------------------- |
| `.tmp/梦中的婚礼.mid`       | 2    | 0 / 0    | 204 条，落在 track 1 |
| `.tmp/pianokits-6track.mid` | 6    | 全部 0   | 无                   |
| `.tmp/audit/multitrack.mid` | 6    | 全部 0   | 无                   |

即：常见形态是"多轨同通道 0、踏板只落在其中一轨"（与
`research/20260912-midi-pedal-track-relationship.md` 的结论一致）。因此"镜像通道固定 0"
（走带镜像音符本来就固定 0）对这类文件与"按来源通道镜像"等价——设计草案
`design/20260913-pedal-sound-path.draft1.md` 的 D3 据此推荐固定 0。

## 3. 代码路径分析

| 链路                            | 现状                                                                                                    | 关键位置                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 解析（数据侧）                  | CC64/66/67 全部采集，值还原 0–127，带来源轨/通道                                                        | `core/midi/parse.ts` §踏板采集                                              |
| 视觉（瀑布流）/ 判定 / 记谱     | 踏板条、关注范围、闸门要求、`extendWithSustain` 延长长音——**都正常**                                    | `ui/waterfall-view.ts`、`core/midi/pedals.ts`、`core/midi/quantize.ts`      |
| 走带排期 → 机内引擎             | 只排 `{pitch, velocity, time, duration}`，`duration` 取键按时值；引擎接口无踏板概念                     | `core/transport.ts` `tick()` / `scheduleFree()`、`core/engine/types.ts`     |
| 走带排期 → MIDI 输出镜像        | `MidiOutputSink.scheduleNote` 只发 `0x90`/`0x80`；无 CC 排期 API                                        | `core/midi/output.ts`                                                       |
| 练习/实时输入 → 输出镜像 / 引擎 | `onNote` 回送并驱动引擎；`onControl` **只喂 gate**，不回送、不进引擎；键盘 Local Control Off → 彻底无声 | `core/practice.ts` `onNote` / `onControl`、`core/midi/output.ts` `echoNote` |
| 录音工具（`/midi-recorder`）    | `MidiConnection` 未实现 `onControl`，CC 录制时即丢弃；模型/回放/导出只有音符                            | `core/recorder.ts`、`core/recorder-model.ts`、`core/midi/write.ts`          |

几个具体事实：

1. **引擎无踏板能力**：`core/engine/types.ts` 的 `AudioEngine` 只有 `scheduleNote` / `noteOn` /
   `noteOff` / `allNotesOff`；`ScheduledNote` 只有 pitch / velocity / time / duration / channel。
   `SmplrEngine.scheduleNote` 直接 `piano.start({duration})`——smplr 在 `duration != null` 时
   于 `startT + duration` 停声（`node_modules/smplr/dist/index.js` 的 voice.stop(releaseAt)），
   本身没有延音（sustain）概念；`OscillatorEngine` 同理在 `t0 + duration + 0.05` 停振荡器。
2. **走带从不查 `pedalEvents` 做声音**：`Transport.load()` 里 `buildPedalSegments(song.pedalEvents)`
   只用于练习关注范围/闸门（`pedalFocus` / `pedalsDownAt`），`tick()` 与 `scheduleFree()` 的排期
   参数完全不含踏板。
3. **输出端口无 CC 排期**：`MidiOutputSink` 会发的 CC 只有 `CC122`（Local Control）与
   `CC123`/`CC120`（止音）；`echoNote` 的类型是 `MidiNoteEvent`，物理上收不到踏板。
4. **练习判定要踏板（但不发声）**：设计文档 R8/D11（`20260912-midi-pedal-lane-and-practice.md`）
   规定闸门放行 = 琴键条件 ∧ 要求踏板**现踩**；`PracticeController.onControl` 只做判定，
   没有对称的"回送 + 驱动引擎"。
5. **记谱与声音口径不一致**：`quantize.ts` 的 `extendWithSustain` 已按 CC64 延长长音（五线谱上
   是长音/延音线），声音却按键按时值砍断。
6. **曲终尾巴**：`Song.duration = max(note.end)`（`parse.ts`），不含踏板尾巴；曲终未抬起的踏板
   （`PedalSegment.end = Infinity`）在实现踏板发声后需要收口。

## 4. 与设计文档的关系 / 是否算实现缺陷

两条设计文档把这件事**显式写成了非目标**，因此当前实现与文档是一致的，不是偷偷漏掉的回归：

- `20260906-midi-keyboard-and-practice.md` §6：「**不镜像延音踏板**（CC64）：走带仍不向输出端口
  调度 CC，键盘音源听感无踏板；后续若做 CC64 调度可一并镜像。」
- `20260912-midi-pedal-lane-and-practice.md` §7：「不把踏板数据镜像到 MIDI 输出端口（键盘音源的
  CC64 调度仍是非目标，见 `20260906`§6）。」

但下列不一致说明它已经构成**需要修复的功能缺陷**（不是"可选增强"）：

1. 练习模式**要求**用户现踩踏板才能放行，踏板却对声音零影响——用户被要求做一个听不出结果的动作，
   且连接键盘后物理踏板在键盘音源上被 Local Control Off 静默、又没有软件回送，属于"按了没反应"；
2. 记谱（延长）与瀑布流（踏板条）都已经按踏板语义呈现，唯独声音不遵循——同一事实三套口径；
3. 用户对"MIDI 播放器"的合理预期就是听到曲目本来的演奏（含踏板）。

## 5. 修复需要触及的点与待定设计问题（留给设计文档定案）

**接口/实现**

- `AudioEngine`：增加踏板能力。smplr 无内建延音，两条候选路线：
  (a) **排期时烘焙**——复用 `extendWithSustain` 语义把音符时值按踏板区间延长后再排期（改动小、
  对文件播放有效；但实时演奏、半踏板、选择性踏板（sostenuto）覆盖不到）；
  (b) **引擎延音层**——踏板踩下时保留已离键的 voice、抬起时释放（文件播放与实时演奏统一，
  可支持半踏板；需要与 smplr 的 voice 生命周期/`allNotesOff` 交互设计）。
- `MidiOutputSink`：增加 CC 排期（如 `scheduleControlChange`）与实时回送（`echoControl`）；
  暂停/停止/跳转时必须补发 `CC64=0`，否则键盘音源残留延音。
- `PracticeController.onControl`：练习判定之外，把踏板 CC 原样回送输出端口并驱动引擎
  （与 `onNote` 对称）。
- 录音工具若要一并支持：`MidiConnection` 接 `onControl` → 领域模型增加踏板事件 → 回放/导出
  同步（`write.ts` 写 CC）。

**语义/产品口径待定**

- 练习模式中，练习轨的踏板事件是"用户要踩的"——程序是否还应自动镜像这些 CC / 自动延音？
  （否则用户踩与程序踩重复）；非练习轨的踏板是否照常？
- 只镜像 CC64，还是三踏板（CC66/67）一起？半踏板（0–127 中间值）如何表达？
- 踏板与通道的对应（解析侧 CC 通道由轨内音符推导，纯控制轨退化为通道 0，见
  `research/20260912-midi-pedal-track-relationship.md`）。
- 曲终未抬起的踏板、暂停/停止/seek 时的收口；`Song.duration` 是否要含踏板尾巴。
- 修复后需同步修订 `20260906` §6 与 `20260912` §7 两条非目标，并更新 `docs/usage/midi-player.md`。

## 6. 修复（2026-09-13 已实施）

上述问题已按设计文档 `docs/development/design/20260913-pedal-sound-path.md` 修复（该文档为正式生效文档）：

- **文件播放**：`core/midi/pedals.ts` 的 `soundingEndsUnderSustain` 按 Magenta.js 事件状态机把每个音符
  烘焙成实际发声结束时刻，`Transport` 排期时**引擎取烘焙时值、MIDI 镜像取键按时值**，并新增
  CC64/66/67 的镜像排期（跳转/恢复播放/新挂端口补发踏板状态）；
- **实时输入**：`AudioEngine.setSustain` 引擎延音层（离键 voice 延后止音），练习中把实时 CC 回送
  输出端口；暂停/停止/换端口时补发 `CC64/66/67 = 0`，恢复播放补发按住中的踏板；
- **记谱**：`quantize.ts` 改用同一函数，顺带修正"起点在踏板踩下之前"的漏延长；
- **验证**：`scripts/probe-pedal-sound-gap.mjs` 转为断言式探针并全部通过（输出端口 CC64 序列
  `[0,0,0,127,0]`、机内 voice 时长 `4.5/3.5/2.5s`、暂停复位、练习回送），单测 323 项全绿。
