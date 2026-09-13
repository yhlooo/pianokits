# 设计：录音工具的踏板支持（录制 / 回放 / 导出 + 三条踏板轨）

- 日期：2026-09-13
- 状态：**正式生效（2026-09-13 实现）**
- 前置设计：`docs/development/design/20260912-midi-recorder.md`（录音工具主设计；本文档扩展其
  §3.2 模型、§3.3 控制器、§3.4 视图、§3.6 导出）
- 关联设计：`docs/development/design/20260913-pedal-sound-path.md`（踏板语义与 CC 镜像的既有做法）
- 影响文档：`docs/usage/midi-recorder.md`（本次按用户要求同步）

## 1. 需求

| #   | 需求                                                     | 落地口径                                                                                       |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R1  | 录制要录下踏板                                         | 采集 CC64/66/67（`MidiConnection.onControl`），与音符同口径的覆盖录制（§3.2）                   |
| R2  | 录制/回放期间的踏板声要听得见                            | 所有踏板 CC 实时回送输出端口（Local Control Off 后这是唯一能听到踏板的方式，同 `echoNote`）      |
| R3  | 回放录下的 MIDI 要带踏板                                 | 回放把踏板区间排入输出（踩下 + 抬起，带时间戳）；线落在区间中途时立即补踩下（§3.3）             |
| R4  | 保存 / 下载的 `.mid` 要带踏板                            | `writeMidi` 按通道写出 CC64/66/67（`@tonejs/midi` 的 `addCC`，0–1 归一化，与 `parse.ts` 对称）   |
| R5  | 音轨最下面单独加三行表示三个踏板                         | 画布底部固定三条踏板轨：上→下 = 弱音(67) / 选择延音(66) / 延音(64)，左侧音名列标注名称（§4）     |
| R6  | 覆盖录制（punch-in）语义对踏板同样生效                   | 扫过的区间内旧踏板区间被擦除（跨边界裁剪、跨两端切断），新踩的写进这一段（§3.2）                |

## 2. 关键决策

- **D1 踏板按「踩下区间」存储**（`RecordedPedalSegment`），不存原始 CC 事件流：覆盖录制的擦除、
  视图的条、回放/导出的 CC 都能由区间唯一导出；与播放器侧 `PedalSegment` 的领域口径一致。
  区间带 `controller` / `channel` / `start` / `end`（录制中尚未抬起为 `Infinity`）/ `value`（踩下值，
  半踏板保留原值；导出时抬起固定写 0）。
- **D2 录制语义 = 与音符同一套 pass 模型**：`visiblePedals()` = 「旧区间按已扫过范围擦除」+「本次已收尾的区间」；
  未抬起的区间算 pending（画到录制线），在暂停录制 / 拖动 / 断开 / 导出时**就地收尾**——
  保证导出文件不会出现悬空踏板（播放器对悬空踏板按"踩到曲终"处理）。
- **D3 pass 起点带踏板状态**：控制器**始终**跟踪物理踏板状态（不只录制中），录制开始时若踏板正踩着，
  在该点开一个区间——否则"录到一半踩下去之前"的状态会丢。
- **D4 只录三踏板**（CC64/66/67，与播放器口径一致）；其它 CC（音量、调制等）只回送、不录、不画。
- **D5 三条踏板轨常显**（不是有数据才出现）：它们是"这三行分别是什么踏板"的固定参照，
  也是录制时踏板状态的落点；左侧音名列标注名称，行序与播放器踏板列一致（弱音/选择延音/延音）。
- **D6 内容与时长口径**：`hasNotes` → **`hasContent`**（音符或踏板任一非空）；`duration` =
  音符结束时刻与踏板结束时刻的较大者（回放末尾判定与计时器口径不变）。
- **D7 会话恢复**：模块级会话变量增加踏板（`restore(notes, pedals, position)`），切走再切回不丢。

## 3. 架构与接口

### 3.1 数据流

```
MidiConnection.onControl(CC) ─┬─→ sink.echoControl(ev)                    实时回送（D6 口径，始终）
                              └─→ 录制中：heldPedals 开/闭 → _passPedals    覆盖录制（pass 模型）
RecorderController.tick() ──────→ sink.scheduleControlChange(踩下/抬起)     回放排期
writeMidi(notes, pedals) ───────→ track.addCC(...)                          导出 / 保存到播放器
visiblePedals() / pendingPedals() ─→ RecorderView 底部三条踏板轨            视图
```

### 3.2 领域模型（`core/recorder-model.ts`）

```ts
/** 录制得到的踏板踩下区间（时间轴绝对秒数） */
export interface RecordedPedalSegment {
  /** 控制器号：64 延音 / 66 选择延音 / 67 弱音 */
  controller: number
  /** MIDI 通道 0~15 */
  channel: number
  start: number
  /** 抬起时刻；录制中尚未抬起为 Infinity（收尾时在 pass/拖动/导出边界闭合） */
  end: number
  /** 踩下值 0~127（半踏板保留原值） */
  value: number
}

export function erasePedalRange(segments, from, to): RecordedPedalSegment[]  // 与音符共用 clipOutside 内核
export function mergePedals(a, b): RecordedPedalSegment[]                    // 按 start 升序合并
export function pedalTrackDuration(segments): number                         // 最后一个区间的结束时刻
export function firstPedalAtOrAfter(segments, position): number              // 第一个 end > position 的下标
```

- 复用既有 `clipOutside` 的时间裁剪内核（把泛型放宽到 `start/end` 结构即可同时服务音符与踏板）；
- 擦除 `[from, to]`：区间被扫到多少抹多少（跨边界裁剪、跨两端切成两段），与音符完全同构；
- 指针谓词用 `end > position`（不是 `start >= position`）：线落在区间中途时要保留该区间，
  回放排期才能补发"踩下"。

### 3.3 控制器（`core/recorder.ts`）

新增状态：`_pedals`（已提交区间）、`_passPedals`（本次 pass 已收尾）、`heldPedals`
（本次 pass 未抬起的区间，key = `${controller}|${channel}`）、`pedalDown`（物理踏板状态，
始终更新）、`nextPedalIndex`（回放指针）。

| 方法                      | 行为                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `onControl(ev)`           | 始终 `echoControl`；录制中且未挂起时：≥64 开区间、<64 收尾（收尾进 `_passPedals`）              |
| `beginPass(position)`     | `pedalDown` 里踩着的踏板在 `position` 处开区间（D3）                                            |
| `closeAllHeldPedals(at)`  | 暂停录制 / 拖动起点 / 断开时把未抬起的区间就地收尾（与 `closeAllHeld` 对称）                     |
| `visiblePedals()`         | `mergePedals(erasePedalRange(_pedals, passStart, position), _passPedals)`（渐进擦除，与音符同构）|
| `pendingPedals()`         | 未抬起的区间（`end` = 当前线位置），供视图画到录制线                                             |
| `exportPedals()`          | 保存/下载快照：`visiblePedals()` + 未抬起区间补到当前线位置                                      |
| `tick()`                  | 窗口内开始的区间 → `scheduleControlChange(踩下)` + `scheduleControlChange(抬起, 0)`（各自时间戳）|
| `togglePlay()`            | 指针 = 第一个 `end > position` 的区间（线在区间中途 → 首个 tick 立即补发踩下）                   |
| `clear()` / `restore()`   | 清空 / 还原踏板（会话恢复见 D7）                                                                |

回送时机与音符一致：连接输出端口后键盘 Local Control 被关闭，踏板必须经 `echoControl` 才发声。

### 3.4 导出（`core/midi/write.ts`）

```ts
writeMidi(notes: readonly RecordedNote[], pedals: readonly RecordedPedalSegment[] = [], opts?)
```

- 通道集合 = 音符通道 ∪ 踏板通道（某通道只有踏板时也建轨）；
- 轨内 `track.addCC({ number: controller, value: value / 127, time: start })` 与抬起（value 0）；
  `@tonejs/midi` 的 CC 值是 0–1 归一化（编码时 `Math.floor(value * 127)`，与 `parse.ts` 的
  `Math.round(value * 127)` 对称）；
- `end` 非有限的区间直接跳过（防御：正常路径已由控制器收尾）；`end <= start` 同样跳过。

### 3.5 视图（`ui/recorder-view.ts`）

- **布局**：画布底部固定 `PEDAL_AREA_H = 3 × 14px + 1px 分隔线`；音域区高度 = 画布高 − `PEDAL_AREA_H`，
  88 键行高按音域区重算（音符条、横向行线、音名列都以音域区为界）；
- **踏板轨**：上→下 = 弱音 / 选择延音 / 延音；左侧音名列在对应行标注名称（右对齐小字号）；
- **踏板条**：银灰渐变（与播放器踏板条同色 `#bcc0c6 → #80858c`）、高度 = 行高 − 3、圆角；
  录制中未收尾的区间画到录制线并加亮白描边；线落在区间内（正在踩着）加淡白描边；
- 时间网格与录制/播放线仍贯穿整幅画布（踏板轨不改变走带视觉）。

### 3.6 装配（`recorder-app.ts`）

- `writeMidi(controller.exportNotes(), controller.exportPedals())`（保存与下载共用）；
- 每帧 `view.render(position, visibleNotes, pendingNotes, visiblePedals, pendingPedals)`；
- 会话变量增加 `pedals`；卸载时快照、切回时 `restore`。

## 4. 验收

**单测**

- `recorder-model.test.ts`：`erasePedalRange`（完全在内 / 跨头 / 跨尾 / 跨两端 / 不相交）、
  `mergePedals`、`pedalTrackDuration`、`firstPedalAtOrAfter`（含"线落在区间中途不跳过"）；
- `recorder.test.ts`：录制踩下/抬起成区间、pass 起点带踏板状态、覆盖录制擦除（渐进 + 只抹扫过的部分）、
  暂停/拖动就地收尾、回放排期（踩下 + 抬起 + 时间戳 + 中途补发）、清空止音含踏板复位、
  导出快照、会话恢复、`hasContent` 口径；
- `write.test.ts`：`writeMidi(notes, pedals)` → `parseMidi` 往返（CC 值/时间/通道、
  踏板专用通道建轨、`end` 非法跳过、空输入）。

**探针（`scripts/probe-recorder.mjs`）**

- 假键盘发 CC64 → 三条踏板轨出现在画布底部、踩下区间条可见（采样像素）；
- 录制中发踏板 → 导出文件的 `parseMidi` 结果含 CC64 事件；
- 回放时输出端口收到 CC64 踩下 + 抬起；
- 覆盖录制：在已有踏板的区间上重录后，被扫过的时间段内旧踏板消失。

**工程**：`pnpm test` / `typecheck` / `lint` / `build` / `format:check` 全绿。

## 5. 实施步骤

| 步  | 内容                                                                    | 规模 |
| --- | ----------------------------------------------------------------------- | ---- |
| 1   | `recorder-model.ts`：`RecordedPedalSegment` + 裁剪/合并/指针纯函数 + 单测 | M    |
| 2   | `write.ts`：按通道写 CC + 往返单测                                        | S    |
| 3   | `recorder.ts`：采集 / pass 模型 / 回放 / 导出快照 / `hasContent` + 单测   | L    |
| 4   | `recorder-view.ts`：底部三条踏板轨（布局、标签、条、pending 描边）        | M    |
| 5   | `recorder-app.ts`：导出与每帧渲染接线、会话恢复                           | S    |
| 6   | 探针扩展 + 实跑验证                                                      | M    |
| 7   | 文档同步：本文档、`20260912-midi-recorder.md`、`docs/usage/midi-recorder.md` | S    |

## 6. 非目标

- 不做半踏板的连续曲线录制（区间只保留踩下值；抬起写 0）——播放器侧同样只按阈值二值化；
- 不做踏板抬起/踩下的节奏评定、不做三踏板之外 CC 的录制（D4）；
- 不改变音符的既有覆盖录制语义与视图几何（只把音域区高度让给三条踏板轨）；
- 不做纵向滚动/踏板轨高度自定义。
