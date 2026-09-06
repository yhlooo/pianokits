# 设计：MIDI 导入与播放工具（M1）

- 日期：2026-09-05
- 状态：**正式生效（与 M1 实现一致）**。演进：draft1（讨论稿）→ preview（已采纳）→ 生效（2026-09-05 实现完成）。
- 已决策记录见 §11。
- 关联调查结论：
  - `docs/development/research/20260905-file-persistence.md`（文件持久化，下称 **R-持久化**）
  - `docs/development/research/20260905-midi-parse-and-playback.md`（解析与播放，下称 **R-播放**）
  - `docs/development/research/20260905-waterfall-and-notation.md`（渲染，下称 **R-渲染**）
  - `docs/development/research/20260905-packaging-and-licensing.md`（集成方式与许可合规，下称 **R-打包**）

## 1. 目标与范围

### 1.1 目标

pianokits 的第一个工具：导入钢琴 MIDI 文件，在浏览器本地持久记录文件列表（刷新后仍在），点选即用钢琴音色播放；播放时同步显示五线谱与钢琴瀑布流。

### 1.2 MVP 功能清单（M1）

1. **工具外壳**：顶栏为工具页签（品牌 + 工具切换），下方为当前工具的内容区；工具经注册表挂载/卸载（`src/tool.ts` / `src/tools.ts` / `src/shell.ts`），本工具是第一个工具。
2. **导入**：统一用 `<input type="file" accept=".mid,.midi" multiple>`（可选拖拽导入）；文件字节与元数据写入 IndexedDB。
3. **持久化文件列表**：文件名、大小、导入时间；刷新后列表仍在；支持删除与重新导入（列表内容是导入时的快照，重新导入可更新）。
4. **播放**：点击列表项加载并解析；播放/暂停/停止/点击进度条跳转；钢琴采样音色；采样加载进度提示与降级兜底。
5. **瀑布流**：底部为 88 键钢琴键盘，**判定线即键盘上沿（无中间判定线）**；音符条自上而下坠落，落到琴键的瞬间即发声时刻，发声期间琴键点亮；点击跳转、拖拽平移预览、双击恢复跟随、滚轮缩放。
6. **五线谱**：简化量化出的双谱表（大谱表）记谱 + 播放中高亮当前音符 + 自动翻页/滚动，明确定位为"跟随参考谱"。

### 1.3 非目标（M1 明确不做）

- 乐谱/音符编辑、移调、导出 MIDI/MusicXML；
- 多乐器混音（只服务钢琴曲，默认排除打击乐轨）；
- 连音（三连音）自动检测、出版级排版；
- ~~Web MIDI 设备接入、录音~~（**2026-09-06 已实现 Web MIDI 键盘连接与练习模式**，
  见 `20260906-midi-keyboard-and-practice.md`；录音仍未做）；
- 移动端专项适配（桌面优先，布局降级即可）。

### 1.4 验收标准（可测试）

- 连续导入 10 个 MIDI → 刷新页面 → 10 个条目仍在，点击任一可播放；
- 首次播放必须由用户点击手势触发（自动播放策略要求）；
- 瀑布流与谱面高亮与声音的观感同步（视觉以 `AudioContext.currentTime` 计算，误差为渲染帧间隔级别）；
- 1 万音符量级的文件瀑布流滚动不掉帧（视口裁剪保证）。

## 2. 关键技术决策

| #   | 环节       | 决策                                                                                                              | 核心理由                                                                                                                                                                  | 依据            |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | 文件持久化 | **方案 B（仅存内容副本，已决策）**：导入时把文件字节 + 元数据存入 IndexedDB，刷新后直接读副本                     | 2026-09-05 讨论决策：行为全浏览器一致、无权限生命周期、实现最简；MIDI 文件小，副本开销可忽略。方案 C（句柄 + 副本，可感知原文件更新）作为未来升级项保留                   | R-持久化 §7     |
| 2   | MIDI 解析  | `@tonejs/midi`，解析后立即归一化为**自研领域模型**，不直接暴露库类型                                              | 一次性给出秒级时间/tempo map/拍号/调号；包一层领域模型使低活跃的依赖可替换                                                                                                | R-播放 §3、§9   |
| 3   | 音频引擎   | **首选** `smplr` 的 `SplendidGrandPiano`（采样自托管到 `public/samples/`）；**兜底** 自写极简振荡器音色（零依赖） | Steinway 采样、4 层力度、逐音采样，音质最佳；公有领域许可可自托管；默认托管在 GitHub Pages 有限流风险故必须镜像                                                           | R-播放 §5.2、§7 |
| 4   | 播放调度   | **自研轻量 lookahead 调度器**（25ms 定时 / 100ms 前瞻，Chris Wilson 模式），不依赖任何库的 Transport/Sequencer    | 调度器是引擎无关的纯逻辑，便于换引擎、自定义 seek/循环；smplr 的 `Sequencer` 是音符数组输入且与我们的 seek 需求耦合度不符                                                 | R-播放 §4、§8   |
| 5   | 瀑布流     | **自绘 Canvas 2D**，不引入任何现成库                                                                              | 需求本质是"视口裁剪 + 三状态视口模型"的简单渲染问题；现成库均弃更/许可证不兼容/生态为零                                                                                   | R-渲染 §2       |
| 6   | 五线谱     | **VexFlow 直雕 + 自研量化管线**，量化输出独立中间表示 `ScoreModel`                                                | 截至 2026-09 浏览器内不存在成熟的 MIDI→乐谱转换器（music21j 无 MIDI 解析、webmscore 仅 mscz、midi2abc 无 JS/WASM 移植），量化必须自研；VexFlow（MIT、活跃）只接住量化结果 | R-渲染 §3       |
| 7   | UI 技术栈  | **原生 TS + 轻量发布订阅 store**，不引入前端框架                                                                  | 已决策（2026-09-05 讨论确认）；M1 只有 4 个视图，框架收益小；store 接口保持极简，未来工具增多时可再评估框架                                                               | §11             |
| 8   | 同步机制   | 统一 `AudioContext.currentTime` 时钟 + lookahead 调度 + rAF 渲染；**视觉不依赖任何音频回调**                      | 所有 `onStart` 类回调都可能提前一个 lookahead 窗口触发，直接驱动视觉会"超前"                                                                                              | R-播放 §8       |

## 3. 总体架构

### 3.1 模块图

```
┌──────────────────────── 外壳（shell.ts） ──────────────────────┐
│  顶栏：品牌 + 工具页签（tools.ts 注册表）                          │
│  工具区：同一时间只挂载一个工具；切换时先调用上一个工具的卸载函数      │
└───────────────────────────┬───────────────────────────────────┘
                    Tool.mount(host) / 卸载回调
┌──────────────────────────── UI 层（本工具） ────────────────────┐
│  TransportView  工具内工具条：播放/暂停/停止/进度条/音量/视图切换    │
│  ├─ LibraryView  文件列表/导入/删除                              │
│  ├─ WaterfallView  Canvas 2D 瀑布流（自上而下坠落，底部键盘为判定线）│
│  └─ ScoreView      VexFlow 五线谱（含高亮与翻页）                 │
└───────────────┬──────────────────────────┬────────────────────┘
                │ 事件订阅（状态变化）        │ 每帧拉取 position（rAF，不经 store）
┌───────────────┴──────────────────────────┴────────────────────┐
│  ui/store.ts   轻量 store：library 状态 / transport 状态 / 设置  │
└───────────────────────────────┬───────────────────────────────┘
┌───────────────────────────────┴───────────────────────────────┐
│                          core 层                               │
│  transport.ts   播放状态机 + lookahead 调度器 + 时钟（seek/pause）│
│  ├─ engine/  AudioEngine 接口                                  │
│  │   ├─ smplr-engine.ts   首选引擎（采样自托管）                 │
│  │   └─ oscillator-engine.ts  兜底引擎（零依赖合成音色）          │
│  └─ midi/                                                     │
│      ├─ parse.ts    @tonejs/midi → Song（领域模型）             │
│      └─ quantize.ts Song → ScoreModel（量化/拼写/分声部）        │
├───────────────────────────────────────────────────────────────┤
│  storage/  library.ts 文件库（导入/列表/读取/删除）               │
│            db.ts      IndexedDB 封装（唯一持久化路径）             │
└───────────────────────────────────────────────────────────────┘
```

工具切换的资源契约：`Tool.mount` 返回卸载函数；MIDI 工具的卸载会停止渲染循环、
dispose 播放器与两个音频引擎、断开视图观察器并关闭 `AudioContext`，保证切换/反复
进出工具不泄漏定时器与音频资源。

### 3.2 两条关键数据流

**导入 → 播放：**

```
用户手势（文件选择/拖拽）
  → FileLibrary.importFiles：文件字节 + 元数据存入 IndexedDB（内容副本）
  → LibraryView 刷新列表
  → 点击条目：FileLibrary.read → bytes（直接读副本，无权限流程）
  → parse.ts → Song
  → quantize.ts → ScoreModel（渲染用，与播放解耦）
  → transport.load(Song)
  → 用户点击"播放"（手势中 resume AudioContext）→ 调度器逐音符驱动 AudioEngine
```

**播放 → 视觉同步：**

```
AudioContext.currentTime（唯一时钟）
  ├─ 调度器：setInterval(25ms) 把未来 100ms 的音符排入引擎（声音准时）
  └─ rAF 循环：position = currentTime - offset
       ├─ WaterfallView.redraw(position)  画时间线、高亮活动音符、自动滚动
       └─ ScoreView.highlight(position)   比对 ScoreModel 事件窗口，高亮音符、翻页
```

### 3.3 设计要点

1. **解析与播放解耦**：`Song` 是自研领域模型（秒级时间轴），`@tonejs/midi` 只在 `parse.ts` 内部出现。库停更或换库不影响其余模块。
2. **量化与渲染解耦**：`quantize.ts` 输出纯数据 `ScoreModel`（小节/声部/时值/临时记号，均带时间窗口），VexFlow 只做排版绘制。未来输出 MusicXML 或换 OSMD/alphaTab 渲染都不动量化层。
3. **调度与引擎解耦**：调度器只面向 `AudioEngine` 接口（`scheduleNote`/`allNotesOff`），换引擎（smplr ↔ Salamander/Tone ↔ 振荡器）不影响播放状态机。
4. **视图不互调、不共享可变状态**：四个视图各自订阅 store 的状态变化（播放/暂停等离散事件），连续量（播放位置）由各视图在自己的 rAF 里从 `Transport.position` 拉取——避免 store 高频写入。

## 4. 时间与同步机制（本设计的心脏）

1. **唯一时钟**：`AudioContext.currentTime`（采样级精度，硬件时钟）。播放开始记录 `offset`，任意时刻 `position = currentTime - offset`。
2. **调度器**：主循环 `setInterval(25ms)`；每次把 `[now+latency, now+latency+100ms]` 窗口内的音符事件以 `scheduleNote({pitch, velocity, time, duration})` 排入引擎（时值由调度器从音符起止时间算出）；定时器抖动被 100ms 前瞻吸收。smplr 的 `start({ time, duration })` 直接对齐 `currentTime`，天然支持。
3. **暂停**：记录 `position`，清空调度队列、对发声中的音符发 `allNotesOff(now)`；**恢复**：以新 `offset = currentTime - position` 重新入队。
4. **跳转（seek）**：等价于"暂停到 t 再恢复"，并触发视图状态复位（谱面翻页到对应小节、瀑布流视图跟随）。
5. **视觉**：rAF 每帧读 `Transport.position` 绘制。**绝不用** smplr 的 `onStart` 等回调驱动视觉（其官方 README 明示可能提前最多一个 lookahead 窗口触发）。
6. **自动播放策略**：应用启动即创建 AudioContext（suspended 状态不妨碍解析与采样预加载）；首次 `resume()` 挂在导入/播放按钮的点击手势中。采样用 `fetch + decodeAudioData` 预加载，不受策略限制。
7. **变速（M2 可选项）**：`position = (currentTime - offset) × rate`，调度器按 `time/rate` 排期；M1 不做。

## 5. 数据模型与存储

### 5.1 领域模型（core/model.ts）

```ts
/** 解析后的 MIDI 归一化模型：时间一律为秒，tempo/拍号变化已折算 */
interface Song {
  ppq: number // 每四分音符 tick 数
  duration: number // 秒
  tempos: { time: number; bpm: number }[] // 时间点 + 当时 BPM
  timeSignatures: { time: number; measure: number; numerator: number; denominator: number }[]
  keySignatures: { time: number; sf: number; mi: 0 | 1 }[]
  tracks: Track[] // 原始轨道信息（供轨道勾选，M2 用）
  notes: Note[] // 播放用的事件流：默认合并所有轨道并排除打击乐轨
}
interface Track {
  name: string
  channel: number
  instrument: number
  noteCount: number
}
interface Note {
  pitch: number // MIDI 音高 0~127
  start: number
  end: number // 秒
  velocity: number // 0~127
  trackIndex: number // 瀑布流按轨着色依据（见 20260905-waterfall-track-colors.md）
}
```

### 5.2 记谱中间模型（ScoreModel，quantize.ts 输出）

```ts
interface ScoreModel {
  measures: Measure[]
  events: NotatedEvent[] // 扁平化、带时间窗口，供播放高亮比对
}
interface Measure {
  staffs: Staff[]
} // 大谱表：上（右手）+ 下（左手）
interface Staff {
  voices: Voice[]
}
interface NotatedEvent {
  // 谱面元素 ↔ 播放时间 的映射
  onsetSec: number
  endSec: number
  staff: 'upper' | 'lower'
  measureIndex: number
  // VexFlow 渲染所需：时值、音高、临时记号、声部、是否延音线连接等
}
```

`NotatedEvent` 携带 `onsetSec/endSec` 是关键：谱面高亮 = "当前 position 落在哪个事件的窗口内"，与量化后的谱面视觉元素一一对应，无需再反查。

### 5.3 IndexedDB 结构（storage/db.ts）

- 数据库 `pianokits`，版本 1；
- 对象仓库 `files`（keyPath `id`，uuid）：`{ id, name, size, importedAt, bytes: ArrayBuffer }`；
- 对象仓库 `settings`（keyPath `key`，M1 可选）：音量、瀑布流缩放、视图布局等。

**读取**：点击条目直接读 `bytes` 快照，无任何权限流程。快照语义是方案 B 的已知取舍：原文件在磁盘上的后续修改不影响列表内容，用户可点"重新导入"更新。导入后顺带调 `navigator.storage.persist()` 降低驱逐风险（Safari 有 7 天无交互主动驱逐）。

**升级路径**：若未来要升级方案 C（感知原文件更新），只需给 `files` 仓库增加可选 `handle: FileSystemFileHandle` 字段并在 `read()` 里增加"句柄优先、副本兜底"分支，schema 无需重构。

## 6. 模块接口（节选）

### 6.1 文件库（storage/library.ts）

```ts
interface LibraryItem {
  id: string
  name: string
  size: number
  importedAt: number
}
interface FileLibrary {
  importFiles(files: File[]): Promise<LibraryItem[]> // 文件选择器 / 拖拽共用
  list(): Promise<LibraryItem[]>
  read(id: string): Promise<ArrayBuffer> // 直接读 IndexedDB 副本
  remove(id: string): Promise<void>
}
```

### 6.2 音频引擎（core/engine/types.ts）

```ts
interface AudioEngine {
  readonly id: 'smplr' | 'oscillator'
  init(opts: { onProgress?: (loaded: number, total: number) => void }): Promise<void>
  readonly ready: boolean
  /** 在精确的 AudioContext 时间排期一个音符（含时值），引擎自行安排止音 */
  scheduleNote(ev: { pitch: number; velocity: number; time: number; duration: number }): void
  /** 立即止住所有正在发声的音（暂停/停止用） */
  allNotesOff(time: number): void
  setVolume(linear: number): void
  dispose(): Promise<void>
}
```

- `smplr-engine.ts`：`SplendidGrandPiano`，`baseUrl` 指向自托管 `/samples/splendid/`，`notesToLoad` 按曲目音域裁剪首载量，`CacheStorage` 二次缓存（smplr README 推荐做法）；
- `oscillator-engine.ts`：每音符两个振荡器 + 指数衰减增益包络，约 40 行，采样加载失败/离线兜底，也用于自动化测试。

### 6.3 播放器（core/transport.ts）

```ts
type TransportState = 'empty' | 'ready' | 'playing' | 'paused'
interface Transport {
  load(song: Song): void // 解析完成 → ready
  play(): Promise<void> // 内含 AudioContext.resume()（必须手势调用）
  pause(): void
  seek(seconds: number): void
  stop(): void
  readonly state: TransportState
  readonly position: number // 实时计算：currentTime - offset
  readonly duration: number
  setVolume(v: number): void
  on(event: 'statechange', cb: (s: TransportState) => void): () => void
}
```

调度器为 `transport.ts` 内部私有实现：音符事件按 `start` 预排序，双指针推进；`seek` 用二分定位事件指针。

### 6.4 瀑布流视图（ui/waterfall-view.ts）

```ts
class WaterfallView {
  setNotes(notes: Note[]): void // 播放同一首歌期间不重建
  setPosition(positionSec: number, playing: boolean): void // rAF 每帧调用
  destroy(): void // 卸载：断开 ResizeObserver
  // 判定线即底部键盘上沿（无中间判定线）：音符条自上而下坠落，
  // 条底到判定线的时刻 = 发声时刻（与音频调度共用同一时钟，天然对齐），
  // 发声期间对应琴键点亮发光。
  // 交互：click（音符区）→ 换算为时间回调 onSeek(t)；
  //        drag → 上下平移时间窗（脱离跟随，预览用）；dblclick → 恢复跟随；
  //        wheel → 以指针为锚点缩放 pxPerSecond；
  // 内部状态：{ pxPerSecond（纵向）, viewTopSec（画布顶边时间）, playheadSec, follow }
}
```

渲染要点：底部 88 键键盘（白键 + 黑键 + C 键标注）离屏缓存只画一次；时间轴为纵向、
未来在上（画布顶边时间 = `viewTopSec`），`y(t) = 音符区高度 - (t - 判定线时间) × pxPerSecond`
（t 越大 y 越小）；跟随播放时 `viewTopSec = playhead + 音符区高度 / pxPerSecond`，使判定线
始终对齐播放头；音符按 start 排序 + 二分查找可见窗口（判定线以下部分裁剪隐藏）；发声中的
琴键用发光色覆盖绘制。`devicePixelRatio` 适配。

### 6.5 五线谱视图（ui/score-view.ts）

```ts
class ScoreView {
  setScore(score: ScoreModel): void // VexFlow 按系统排版（分页/滚动条）
  setPosition(positionSec: number): void // rAF 每帧调用：比对事件窗口 → 高亮 + 翻页
}
```

VexFlow 用 `Factory/EasyScore` 高层 API；高亮用 `Note.setStyle()` 后重绘当前系统（成本低）；换页/滚动由 `NotatedEvent` 的时间窗口与小节映射驱动。

### 6.6 量化管线（core/midi/quantize.ts，M1 范围）

> **已变更（2026-09-05）**：本节描述的「以 C4 分左右手」M1 记谱算法已被
> `20260905-score-notation.draft1.md` 取代并实现——分谱表改按 MIDI 音轨（谱号按轨内
> 主音区判定）、谱表内复调分声部、量化网格改 1/16、新增踏板延音。下述 M1 描述仅作
> 历史留存；当前实现见 quantize.ts 源码与新设计文档。

输入 `Song`，输出 `ScoreModel`。M1 算法（明确为"参考谱"级）：

1. **网格**：读 `timeSignatures`（缺省 4/4）；网格步长 1/8（1/16 为可调参数）；
2. **量化**：`start` 吸附最近网格点；时长圆整到合法时值并跨拍拆分为"延音线连接"的时值组合；
3. **分声部**：以 C4（MIDI 60）为界分左右手谱表，同时起音的合并为和弦（单声部内），跨界音符用"哪只手更近"启发式修正；
4. **拼写**：读 `keySignatures`（缺省 C 大调）；M1 用固定策略（按调号候选枚举 + 简单最近邻），接受"非黑键音带临时记号"的观感；
5. **休止符**：同声部内空隙折叠为休止符（从简）。

M2 计划（不进 M1）：tempo/拍号检测、最小编辑距离量化、`@tonaljs` 拼写改进、连音（3:2 网格试探）、双手内部多声部、休止符合并优化。

## 7. UI 设计

> 视觉语言（色彩 token、字体、控件、动效等）以生效文档 `20260905-ui-visual-style.md` 为准；本节只描述信息架构与布局。

### 7.1 布局（桌面优先）

```
┌──────────────────────────────────────────────────────────────┐
│ PianoKits  [MIDI 播放器 | （未来工具）]        ← 外壳顶栏（工具切换）│
├───────────────┬──────────────────────────────────────────────┤
│ 文件库        │  视图切换：[瀑布流 | 五线谱 | 分屏]              │
│ ▪ nocturne.mid│ ┌────────────────────────────┐                 │
│ ▪ étude.mid  │ │     瀑布流：自上而下坠落      │                 │
│ ▪ sonata.mid │ │     （底部键盘为判定线）      │                 │
│ (名称/大小/    │ │      或 五线谱（VexFlow）    │                 │
│  导入时间)     │ └────────────────────────────┘                 │
│ [▥]           │  ──●────  进度条（播放坞上沿）                  │
│               │  [▥] ▶ ⏸ ⏹  2:31/4:05  音量 [分屏|瀑布流|五线谱]│ ← 播放坞控制行
└───────────────┴──────────────────────────────────────────────┘
```

- 外壳顶栏负责工具切换，工具内容区只渲染当前工具；
- **播放坞钉在页面最底部**（进度条上沿 + 控制行），不横跨页面：只占左侧栏右边的内容区
  （侧栏通高到底）；顶部除外壳页签外不放任何控制按钮；
- **侧栏可折叠**：展开态侧栏左下角有收起按钮，与播放坞控制行最左的展开按钮**共用同一侧栏
  图标**（`▥`，面板 + 左侧窄栏分隔线）；折叠后侧栏完全不露（首列收为 0）。展开按钮在展开态
  即预留占位、折叠后显示，出现时不挤压其它控件，且与播放按钮多留间隔以示与播放功能无关；
- 视图切换三态：瀑布流 / 五线谱 / 分屏（宽屏分屏左右排，窄屏自动变标签页）；
- 文件列表项 hover 出删除/重新导入；
- 首次加载采样时播放按钮变进度条，加载完可用（振荡器兜底期间允许播放）。

### 7.2 关键交互流

1. **首次导入**：点击"导入 MIDI"（手势①）→ 文件对话框 → 文件字节存入 IndexedDB → 列表出现条目 → 点击条目（手势②）→ 解析 → 采样进度 → 就绪；
2. **再次访问**：页面加载 → 从 IndexedDB 出列表（无网络请求）→ 点击条目 → 读副本 → 解析（小文件毫秒级）→ 采样已缓存则直接就绪；
3. **播放中**：暂停/跳转随时可用；瀑布流与谱面始终显示同一 `position`；瀑布流音符条坠落到底部键盘时发声并点亮琴键，谱面高亮当前事件（拖拽瀑布流可脱离跟随浏览，双击恢复，浏览不影响播放）。

## 8. 依赖清单与资源

| 依赖                        | 版本（调查日） | 用途                               | 许可       | 备注                                                |
| --------------------------- | -------------- | ---------------------------------- | ---------- | --------------------------------------------------- |
| `@tonejs/midi`              | 2.0.28         | MIDI 解析                          | MIT        | 2022 起停更但功能稳定；仅 parse.ts 内部引用，可替换 |
| `smplr`                     | 1.0.0          | 钢琴采样引擎                       | MIT        | 2026-06 发布；API 有 MIGRATE 兼容表                 |
| `vexflow`                   | 5.0.0          | 五线谱雕刻                         | MIT        | 经 `vexflow/bravura` 子入口引入，字体以 base64 内嵌 |
| （dev）`vitest`             | 5.0.0          | 单元测试                           | MIT        | 量化器/调度器各有测试（见 §11 第 7 条）             |
| （dev）`playwright`         | 1.62.1         | 冒烟测试（scripts/smoke-test.mjs） | Apache-2.0 | 无头 Chromium 验证导入→渲染→播放主流程              |
| （M2 可选）`@tonaljs/tonal` | —              | 拼写改进                           | MIT        | M1 不引入                                           |

乐谱字形说明：VexFlow 5 主包不含字形文件，但 `vexflow/bravura` 入口把 Bravura 字体以
base64 data URI 内嵌进 JS，**无需独立字体 npm 包、无运行时外链**（实现中不依赖
`@vexflow-fonts/*`）。许可合规事项按用户决定整体推迟，未做特殊处理。

静态资源（采样，进 `public/samples/`）：

- **首选（已实现）**：smplr `SplendidGrandPiano` 采样镜像，**实测 452 个文件、41.7MB**
  （226 个 ogg 19.0MB + 226 个 m4a 22.7MB，m4a 供 Safari 使用；AKAI 公有领域）——
  Steinway、4 层力度（上游另有 1 层低通滤波合成的最弱层）、逐音采样；由
  `scripts/mirror-samples.mjs` 从 jsDelivr 镜像（smplr 默认的 GitHub Pages 有限流风险，
  必须自托管）；
- **落盘命名**：上游采样名含 `#`（如 `MF C#1.ogg`），而 Vite 静态服务无法解码 `%23`
  路径，故镜像落盘时把 `#` 替换为 `♯`（U+266F），引擎侧经 `preset.samples.map`
  完成原始名 → 编码后路径的映射（`src/core/engine/smplr-engine.ts`）；
- **备选**：Salamander Grand Piano（Tone.js 托管集 mp3 1.92MB / ogg 6.62MB，CC BY 3.0
  需署名）——体积小、音质单层力度。

## 9. 分阶段计划

| 阶段             | 内容                                                                                                                       | 交付标准                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **M1**（本草案） | 导入 + 持久化列表 + 播放（smplr + 兜底引擎）+ 瀑布流（滚动/高亮/点击跳转）+ 简化五线谱（参考谱级）                         | §1.4 验收标准全通过                    |
| **M2**           | 量化改进（tempo/拍号检测、拼写、休止符、连音试探）；瀑布流缩放；轨道勾选；变速/音量；PWA 化（manifest + 离线采样）         | 记谱质量在典型钢琴曲上"可读性"明显提升 |
| **M3**           | `ScoreModel` → MusicXML 导出（`musicxml-io` 序列化）；渲染层可切换 OSMD/alphaTab；评估 SpessaSynth（完整 MIDI 播放器模式） | 谱面可导出并被 MuseScore 等打开        |

## 10. 主要风险与缓解

| 风险                                                  | 缓解                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| 记谱质量有天然上限（三连音、rubato 会出"不对劲"的谱） | MVP 定位"跟随参考谱"并在 UI 标注；量化参数可调；M2 迭代；预留 MusicXML 出口 |
| 采样 41.7MB 首载慢 / GitHub Pages 限流（已消除外链）  | 自托管镜像 + `CacheStorage` 二次缓存 + 流式起播 + 振荡器兜底                |
| `@tonejs/midi` 低活跃维护                             | 领域模型隔离，替换成本限于 parse.ts                                         |
| smplr 1.0 刚发布、API 可能变动                        | 引擎接口隔离；锁定版本；Salamander/Tone 为备用路线                          |
| 自动播放策略拦截出声                                  | AudioContext 提前创建、`resume()` 挂在导入/播放手势                         |
| 视觉"超前"（音频回调提前触发）                        | 视觉只用 `currentTime - offset`，绝不依赖音频回调                           |
| VexFlow 5 新 org 维护节奏待观察                       | M3 的渲染层抽象天然可切换 OSMD/alphaTab                                     |
| 内容副本是快照，原文件修改不生效                      | 方案 B 的已知取舍（已决策）；UI 提供"重新导入"更新；未来可升级方案 C        |

## 11. 决策记录与待讨论问题

**已决策（2026-09-05 讨论确认）：**

1. **五线谱进 M1**，定位"跟随参考谱"（UI 标注"自动记谱，仅供跟随参考"）；
2. **采样**：smplr `SplendidGrandPiano`，镜像到 `public/samples/` 自托管（~18MB）；
3. **UI 技术栈**：原生 TS + 轻量 store，不引入前端框架；
4. **文件持久化**：方案 B（仅存内容副本到 IndexedDB）；方案 C 记录为未来升级项。

**仍可再议（当前默认值）：**

5. **视图布局**：默认"分屏（宽屏）/ 标签页（窄屏）+ 手动切换"；
6. **轨道处理**：默认 M1 合并所有非打击乐轨播放，M2 再加轨道勾选列表；
7. **单元测试**：建议引入 vitest，至少覆盖量化器与调度器（纯逻辑、易测、出错影响大）。

**实现后变更（已同步到本文各处）：**

- 2026-09-05 ①工具集外壳：顶栏改为工具页签（`src/tool.ts`/`src/tools.ts`/`src/shell.ts`），
  工具经 `Tool.mount/卸载函数` 挂载，MIDI 工具整体作为第一个工具（含资源清理契约）。
- 2026-09-05 ②瀑布流改为**自上而下坠落**：判定线即底部钢琴键盘上沿（无中间判定线），
  音符条落到琴键瞬间发声、发声期间琴键点亮；纵向时间轴 + 拖拽/双击/滚轮交互。
- 2026-09-05 ③记谱管线重构（§6.6 已变更）：分谱表从「C4 分左右手」改为「按 MIDI 音轨
  分谱表（谱号按轨内主音区判定）」+ 谱表内复调分声部 + 量化网格 1/16 + 踏板延音
  （CC64），实现见 `20260905-score-notation.draft1.md`。
- 2026-09-05 ④工具路由：外壳改为 History API 路径路由，每个工具页面拥有独立 URI
  （`/{工具 id}`，如 `/midi-player`），刷新/后退/前进可保持页面；详见 `20260905-tool-routing.md`。
- 2026-09-05 ⑤侧栏可折叠（§7.1）：侧栏左下角收起按钮 + 播放坞最左展开按钮，两者共用同一
  侧栏图标；折叠后侧栏完全不露，展开按钮位置始终预留、出现时不挤压其它控件。
- 2026-09-06 ⑥Web MIDI 键盘连接与练习模式：播放坞右下角新增钢琴（连接/断开 MIDI 键盘、
  实时演奏）与练习（瀑布流音符落到琴键等待按键放行、和弦需同时按全、按错键红显）两个
  图标按钮；未连接 MIDI 键盘前练习图标置灰禁用。设计详见
  `20260906-midi-keyboard-and-practice.md`。
