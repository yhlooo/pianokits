# 浏览器 MIDI 解析与钢琴采样播放方案调查（2026-09-05）

> 调查日期：2026-09-05。本文是研究结论文档；文中引用的外部事实均摘录在
> [参考文档](../reference/midi/format-and-libraries.md)（下称“参考文档”），关键处标注来源 URL。
> 所有 npm 数据（版本、发布时间、许可、周下载量）以 2026-09-05 查询结果为准，周下载量统计区间为 2026-08-23 ~ 2026-08-29。

## 1. 结论摘要（TL;DR）

**推荐技术组合：**

| 环节 | 推荐 | 理由（详见下文） |
| --- | --- | --- |
| MIDI 解析 | `@tonejs/midi`（2.0.28，MIT） | 功能最贴合需求：音符/轨道/tempo 变化/拍号/调号/PPQ 全解析，且直接给出每个音符的**秒级**时间；零依赖 Tone.js 本体（只依赖 `midi-file`）；类型完整 |
| 播放（首选） | `smplr`（1.0.0，MIT）的 `SplendidGrandPiano` | 音质最好（Steinway、4 层力度、303 个采样、逐音采样不靠移调）；自带 lookahead 调度器与播放事件；`baseUrl` 支持自托管镜像 |
| 播放（备选） | Tone.js `Sampler` + Salamander Grand Piano 采样自托管 | 生态最稳（Tonejs 官方组织、周下载 22.7 万）；采样许可 CC BY 3.0 明确可自托管；代价是单力度层、音色偏“干” |
| 播放（兜底） | Tone.js `PolySynth`（合成音色） | 零下载、可立即开发调试；音质差，仅作开发兜底 |
| 视觉同步 | 基于 `AudioContext.currentTime` 的统一时钟 + lookahead 调度队列 + `requestAnimationFrame` 渲染 | 所有路线共用；音频回调（onStart 等）均不保证精确到帧，视觉必须以解析出的确定性时间驱动 |

**关键事实（详见 reference 文档）：**

1. SMF 规范（[midi.org](https://midi.org/standard-midi-files) 官方 PDF）：format 0/1/2 的区别、PPQ/SMPTE division、`FF 51`（tempo，µs/四分音符）、`FF 58`（拍号）、`FF 59`（调号）；无 tempo/拍号时默认 4/4、120 BPM。
2. `@tonejs/midi` 2.0.28：MIT，2022-02-04 发布，周下载 64,094；其 README 数据结构与源码（`Header.ts`）确认支持 tempos/timeSignatures/keySignatures/PPQ 及音符的 ticks + seconds（[GitHub](https://github.com/Tonejs/Midi)）。
3. lookahead 调度的权威依据是 Chris Wilson《A tale of two clocks》（[web.dev](https://web.dev/articles/audio-scheduling)）：JS 定时器抖动可达数十毫秒，音频时钟是采样精度的；建议 25ms 定时 + 100ms lookahead。Tone.js v15 的默认值即 `lookAhead: 0.1`、`updateInterval: 0.05`、`clockSource: "worker"`。
4. smplr 采样默认托管在 GitHub Pages（`smpldsnds.github.io`），README 明确警告 GitHub Pages 有每秒请求限流；钢琴采样源自 AKAI 公有领域（Public Domain）Steinway 采样（[sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano)），许可上可以镜像自托管。
5. Salamander Grand Piano 采样（Tone.js 官方托管 `tonejs.github.io/audio/salamander`：30 音 × mp3/ogg，mp3 合计 1.92MB / ogg 合计 6.62MB，单力度层）许可为 **CC BY 3.0**（作者 Alexander Holm），自托管需保留署名；npm 上另有 `@audio-samples/piano-mp3-velocityN` 系列提供 V3 的 16 层力度分层（velocity1 单层 4.49MB）。
6. SpessaSynth 系列（Apache-2.0，2026-09 仍在活跃开发）是 **TypeScript 实现的 SF2 合成引擎**（不是 wasm 合成器；仅 SF3 的 Vorbis 解码依赖 WebAssembly），可直接播放 MIDI 文件，提供 `noteOn/noteOff/timeChange` 等事件与 `currentHighResolutionTime`（官方注明“Use for visualization”）——[spessasynth_lib](https://github.com/spessasus/spessasynth_lib)。

## 2. MIDI 文件格式要点（问题 1）

结论依据官方规范《Standard MIDI Files 1.0》（RP-001，MIDI Manufacturers Association，摘录见参考文档 §1）：

- **文件结构**：`MThd` 头块 + 一个或多个 `MTrk` 轨道块；轨道内是“变长 delta-time + 事件”序列。
- **Format 0 / 1 / 2**：
  - 0：单条多通道轨道，互换性最好；
  - 1：多条同时播放的轨道（最常见，钢琴曲多为此格式），tempo map 约定放在**第一轨**；
  - 2：多个相互独立的 pattern（极罕见，多数库只是把它当多轨读）。
- **division（PPQ）**：头块 2 字节。bit 15 = 0 时低 15 位为“每四分音符 tick 数”（PPQ，如 480、960）；bit 15 = 1 时为 SMPTE 时间码制式（Web 场景罕见）。
- **Tempo**：`FF 51 03 tttttt`，单位是**每四分音符微秒数**（500000 = 120 BPM），可在文件中多次出现形成 tempo map；缺省按 120 BPM。
- **拍号**：`FF 58 04 nn dd cc bb`（nn/2^dd 为拍号，cc 为每节拍器点击 MIDI clock 数，bb 为每四分音符的 32 分音符数）。
- **调号**：`FF 59 02 sf mi`（sf：-7~+7 升降号数；mi：0 大调 / 1 小调）。
- **tick → 秒**：`Time(ms) = Ticks × (Tempo(µs/qn) / Division(tick/qn)) / 1000`；有多个 tempo 事件时需按事件顺序累计换算（参考文档 §1.7）。

**对项目的影响**：解析器必须提供 tempo map（否则无法把 ticks 换算成秒）；拍号/调号对五线谱渲染是必要输入；PPQ 是瀑布流分格的依据。

## 3. JS MIDI 解析库对比与推荐（问题 2）

npm 数据（2026-09-05 查询，下载量区间 2026-08-23 ~ 2026-08-29，详见参考文档 §2）：

| 库 | 最新版（发布时间） | 许可 | 周下载 | 定位 | 是否给秒级时间 | tempo/拍号/调号 | TS 类型 | 维护状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **@tonejs/midi** | 2.0.28（2022-02-04） | MIT | 64,094 | 高层：MIDI ↔ JSON/JS 对象 | ✅（note.time / duration 秒 + note.ticks 原始 tick） | ✅（header.tempos/timeSignatures/keySignatures + PPQ） | ✅ 自带 `dist/Midi.d.ts` | npm 2022 年停更；repo 最后 push 2023-07-19，1,001 stars，功能稳定 |
| midi-file | 1.2.4（mod. 2023-03-15） | MIT | 70,660 | 底层：二进制 ↔ 事件数组 | ❌（只给 deltaTime/absoluteTime ticks，需自行换算） | 原样透传 meta 事件，需自行组装 | ✅ 自带 `index.d.ts` | repo 2026-08-12 仍有 push；157 stars；@tonejs/midi 的底层依赖 |
| midi-json-parser | 8.1.75（mod. 2026-07-21） | MIT | 1,205 | 中层：二进制 → 事件 JSON | ❌（同样只有 ticks） | 事件齐全但需自行计算 | ✅ | 活跃（repo push 2026-09-01）；132 stars |
| jsmidgen | 0.1.8（mod. 2025-11-16） | MIT | 705 | **生成器**（从零写 MIDI 文件） | ❌ 不解析文件 | ❌ | ❌ | 多年未实质演进；与“解析”需求不匹配 |

**推荐：`@tonejs/midi`**。理由：

1. **功能与需求 1:1 对应**：一次性给出所有需要的结构化信息——`tracks[].notes[]`（midi、time/seconds、ticks、velocity、duration/seconds）、`header.tempos`（含换算后的秒）、`header.timeSignatures`（含小节号 measures）、`header.keySignatures`（2.0.28 源码已支持，README 文档滞后未列出）、`header.PPQ`、`tracks[].instrument`（program change）。
2. **秒级时间直接可用**：库内部按规范公式（参考文档 §1.7）完成 ticks→秒换算，这正是 lookahead 调度和视觉同步所需的确定性时间轴。
3. **与 Tone.js 无关**：dependencies 只有 `array-flatten` + `midi-file`（参考文档 §2.1），可以独立于 `tone` 包使用；因此“用 smplr 播放”和“用 Tone.js 播放”两条路线都能用它解析。
4. **生态与类型**：Tonejs 官方组织出品、自带 TypeScript 声明、周下载 6.4 万，是事实标准。

**风险与注意**：

- npm 自 2022-02 起未发新版、repo 自 2023-07 起无 push：属“成熟但低活跃”状态。功能覆盖钢琴曲需求足够，但遇到 format 2 / 特殊文件时需自行验证（底层 midi-file 按规范解析多轨，format 2 只是“多个独立轨”读法）。
- README 的数据结构说明未列出 keySignatures，以源码（master 的 `Header.ts`）为准。

**备选**：若后续需要极致控制（自定义事件、保留 running status 等编码细节），可退回底层 `midi-file`（它还提供 `writeMidi` 回写）；`midi-json-parser` 定位介于两者之间但周下载少、需自行换算时间，无优势。`jsmidgen` 是生成器，与本需求无关（若未来做“导出 MIDI”可再评估）。

## 4. 播放调度方案（问题 3a）

### 4.1 为什么必须 lookahead

结论来源：Chris Wilson《A tale of two clocks》（[web.dev](https://web.dev/articles/audio-scheduling)，摘录见参考文档 §3.1）：

- `AudioContext.currentTime` 是音频硬件时钟，**采样级精度**；`start()/stop()` 的时间参数由独立音频线程执行，主线程卡顿不影响已调度事件的准时发声。
- `setTimeout/setInterval` 回调会被布局、GC 等主线程工作**拖偏数十毫秒**，直接用来触发音符必然产生可闻抖动。
- 正确做法：JS 定时器（~25ms）周期性地把**未来 100ms 内**的音符一次性用 `start(time)/stop(time)` 排入音频线程（“lookahead”），定时器抖动被 100ms 缓冲吸收。
- 视觉层用**第三个时钟**：`requestAnimationFrame` 按显示器刷新率渲染，进度取自 `AudioContext.currentTime` 与调度队列中已排期的音符时间。

### 4.2 Tone.js Transport 是否可用

**可用且成熟**。依据（参考文档 §3.2）：

- Tone.js（npm 包 `tone`）15.1.22：MIT，周下载 227,404，repo 14,718 stars、push 2026-09-03，**非常活跃**；unpacked 5.4MB（含 standardized-audio-context 依赖），v15 已内建 `OfflineAudioContext` 支持。
- Transport 官方 wiki：“Tone.Transport is the master timekeeper...Callbacks scheduled with Tone.Transport will be invoked just before the scheduled time with the exact time of the event passed in as the first parameter”——即回调本身不保证到点（会在事件前触发），必须用回调给出的 `time` 参数去调度音频，这与自研 lookahead 是同一原理。
- v15 源码默认值：`lookAhead: 0.1`、`updateInterval: 0.05`、`clockSource: "worker"`（调度时钟跑在 Web Worker，主线程卡顿影响更小）。

**结论**：Tone.js Transport 是 lookahead 方案的成熟封装，可直接用；若选择 smplr 路线，smplr 自带的 `Sequencer` 同样是 lookahead 实现（默认 `lookaheadMs: 200`、`intervalMs: 50`，见参考文档 §4）。两条路线都无需从零手写调度器；但视觉层无论如何都要自己用 `currentTime` + rAF 做。

## 5. 钢琴音色播放方案对比（问题 3b）

### 5.1 方案总览

| 方案 | 音质 | 首次加载 | 网络依赖 | 许可 | 调度/同步能力 | 综合评价 |
| --- | --- | --- | --- | --- | --- | --- |
| **smplr `SplendidGrandPiano`** | ★★★★★（Steinway、4 层力度、303 采样、逐音采样） | 全量约 18MB（估算，单文件实测 ~61KB/ogg × 303）；可流式起播（加载一个即可出声） | 默认 GitHub Pages（有每秒限流警告）；`baseUrl` 可改自托管 | 库 MIT；采样源为 AKAI 公有领域 | 自带 lookahead 调度（`time` 参数对齐 currentTime）、`ready/loadProgress`、`onStart/onEnded`、`Sequencer` 事件（beat/bar/noteOn/noteOff） | **首选**：音质与开箱体验最佳 |
| Tone.js `Sampler` + Salamander（官方托管集） | ★★★（Yamaha C5、单力度层、小三度采样+移调） | mp3 1.92MB 或 ogg 6.62MB（30 音） | 默认 tonejs.github.io；可复制自托管 | 采样 CC BY 3.0（需署名） | 用 Tone.Transport/Sampler 自带 `triggerAttackRelease(time)`；事件需自建 | **备选**：体积小、生态稳、许可明确；音色偏“干” |
| Salamander V3 多层（`@audio-samples/piano-mp3-velocityN`） | ★★★★（16 层力度，按层分包） | 单层 4.49MB；全 16 层 70MB+（估计，未逐包实测） | npm 安装 → 本地文件，天然自托管 | CC BY 3.0 | 同 Tone.Sampler（需把多层组织成 urls map） | 升级音质的中间选项，体积换取真实度 |
| SpessaSynth（spessasynth_lib + SF2/SF3 音源） | 取决于音源（SoundFont 钢琴普遍逊于专用采样） | 库 2.4MB（unpacked）+ 自备音源文件 | 音源自备（本地文件） | 库 Apache-2.0；音源许可各自独立（如 GeneralUser GS） | **最强**：直接读 MIDI、`noteOn/noteOff/timeChange` 事件、`currentHighResolutionTime` 官方定位就是给可视化用 | 备选/进阶路线：换“完整 MIDI 播放器”思路时启用 |
| Tone.js `PolySynth`（合成） | ★（无采样） | 0 | 无 | MIT | 同 Tone.js | 开发兜底 |

### 5.2 smplr（重点调查结论）

npm：[smplr](https://www.npmjs.com/package/smplr) 1.0.0（2026-06-13 发布）、MIT、周下载 14,588、repo 319 stars、2026-06-13 最后一次 push。README 自称“approaching 1.0；pre-1.0 APIs keep working as deprecated aliases”——**刚发布 1.0，处于稳定化初期，但作者（danigb，soundfont-player 作者）活跃**。

- **自带钢琴音色**：`SplendidGrandPiano`（Steinway 采样，源自 [sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano)，AKAI 公有领域采样）。源码统计：5 个力度目录（PPP/PP/MP/MF/FF，其中 PPP 为上游用低通滤波合成的最弱力度层，与上游 README “5th layer added at lowest velocity using filter cutoff” 一致）；**smplr README 将其描述为 "4 velocity groups"（合成层不计入）**。MIDI 23–108 逐音采样、共 303 个 ogg/m4a 文件；单文件实测约 61KB（ogg），全量估算 **~18MB**。
- **采样来源与加载**：默认从 GitHub Pages（`smpldsnds.github.io`）拉取，**不是 CDN**（无多节点/高 SLA）；README 明确警告“GitHub Pages, which rate-limits requests per second”，并推荐 `CacheStorage`（Cache API，仅 HTTPS 安全上下文可用）。加载可流式：加载一个采样即可出声，`piano.ready` 等待全部，`onLoadProgress/loadProgress` 给确定性进度条。
- **是否必须联网**：默认必须（采样在线）；构造参数 `baseUrl` 允许指向自托管镜像（README：“override only if you mirror the samples yourself”），另有 `notesToLoad` 可只加载所需音域子集（大幅减小加载量）。
- **调度与事件**：`piano.start({ note, velocity, time, duration })` 的 `time` 直接对齐 `audioContext.currentTime`（采样级排期）；自带 `Sequencer`（lookaheadMs 200 / intervalMs 50）支持 bar/beat 网格、`scheduleRepeat`；事件 `onStart/onEnded` 与 `seq.on("noteOn"/"noteOff"/"beat"/"bar")`。**注意**：README 明言 `onStart` 的触发时刻不精确——会在实际发声前最多一个 lookahead 窗口（默认 200ms）触发，**视觉同步不能依赖它**（详见 §7）。
- **其他**：内置混响（DattorroReverbNode）、MIDI CC（含延音踏板 64）、`dispose()`、离线渲染 `renderOffline` 导出 WAV、`Soundfont`/`Soundfont2` 等其他乐器。

### 5.3 Tone.js Sampler + Salamander

- 官方托管集（tonejs.github.io/audio/salamander，经 GitHub API 统计）：30 个音符（A0–C8 范围按小三度采样）× mp3/ogg 各一份，**单力度层**；mp3 合计 1.92MB，ogg 合计 6.62MB（参考文档 §3.3）。Tone.Sampler 自动移调补齐未采样音符（官方 README：“Tone.Sampler will pitch shift the samples to fill in gaps”）。
- 许可：CC BY 3.0（作者 Alexander Holm，[Tonejs/audio salamander/README](https://github.com/Tonejs/audio)）→ **允许自托管，需署名**。
- 更高音质变体：npm 的 `@audio-samples/piano-mp3-velocityN`（Salamander V3 分层采样，同许可，velocity1 单层 4.49MB）可用 npm 依赖方式落地到本地、由 Vite 静态服务，彻底绕开外部网络。
- Tone.js `Sampler` 本身：MIT、多采样合成、polyphonic、`release` 等参数；与 `@tonejs/midi` 同属 Tonejs 组织，API 风格一致。

### 5.4 SpessaSynth（修正前提：不是 wasm 合成器）

- 仓库：[spessasus/SpessaSynth](https://github.com/spessasus/SpessaSynth)（Apache-2.0，395 stars，push 2026-09-03，**活跃**）。官方 README：“SoundFont2-based real-time synthesizer written in TypeScript”。
- **引擎形态**：`spessasynth_core` README 明确 “Audio engine is written in pure TypeScript”，TODO 里才有 “Potentially port the system to Emscripten”——即**引擎本体是 TS 实现**（借鉴 FluidSynth 算法），要求 WebAssembly 环境仅因 SF3 的 Vorbis 解码器；因此性能弱于原生合成器（官方 Limitations 自述）。
- **能力**：直接读/写 MIDI（format 0/1/2，format 2 标记 experimental）、播放 SF2/SF3/DLS 音源；“Smart preloading: only preloads the samples used in the MIDI file (down to key and velocity)”——会按曲目裁剪音源加载量；支持离线渲染 WAV、MIDI 导出。
- **浏览器集成**：`spessasynth_lib` 提供 `WorkletSynthesizer`（AudioWorklet 独立线程，主线程冻结不断音），需要**手动复制 `spessasynth_processor.min.js` worklet 处理器文件**到项目静态目录（README 示例明示，且文档警告升级 npm 包时必须同步更新该文件）；另有 Web Worker 合成器模式。unpacked：core 2.3MB、lib 2.4MB。
- **UI 同步能力（本需求最相关）**：`Sequencer.currentTime`（秒，可 seek）、`currentHighResolutionTime`（官方注释“Use for visualization as it's not affected by the audioContext stutter”）；事件系统 `eventHandler.addEvent(...)`：合成器层 `noteOn/noteOff/controllerChange/programChange`，音序器层 `timeChange/songChange/songEnded/metaEvent`（参考文档 §5）。SpessaSynth 应用本身就用这些事件做音符可视化。**结论：具备完整的事件/位置回调，可用于同步 UI。**
- **自带钢琴音色吗**：库本身不带音源（示例里 `fetch("soundfont.sf3")` 自备）；其 Web 应用版附带压缩的 GeneralUser GS 音源。对 pianokits 而言需要自备一份钢琴音源（GeneralUser GS 或裁剪版 SF3）。

### 5.5 PolySynth 兜底

Tone.js `PolySynth`（可包 `Synth`/`FMSynth` 等）：纯合成、无采样、零下载。音质与真实钢琴差距大，仅适合开发期验证调度与渲染链路，或作为采样加载失败时的降级。

## 6. 浏览器自动播放策略（问题 3c）

依据（参考文档 §6）：

- MDN：可自动播放的通用条件——静音/音量 0、用户已与站点交互、站点被浏览器放行、Permissions Policy 授权；否则会被阻止。可用 `navigator.getAutoplayPolicy("audiocontext")` 检测。
- Chrome（自 71 起对 Web Audio 生效）：用户手势前创建的 `AudioContext` 处于 `suspended` 状态，**必须在用户手势后调用 `resume()`**；可通过 `AudioContext.state` 与 `statechange` 事件检测。

**对设计的影响**：

1. “导入 MIDI → 立即出声”不可行：首次出声必须挂在一个真实用户手势上（导入按钮的 click 即天然手势）。
2. 建议流程：页面加载时**先创建并保持 AudioContext**（suspended 状态也能提前解码采样、解析 MIDI，缩短首音延迟），在“导入/播放”手势中调用 `context.resume()`；smplr README 同样提醒“you may need to call context.resume() before playing a note”。
3. 采样预加载（fetch + decodeAudioData）不受自动播放策略限制，可尽早进行。

## 7. 采样托管：自托管 vs CDN（问题 4）

**许可结论（能否放进 `public/` 自托管）：**

| 采样 | 许可 | 能否自托管 |
| --- | --- | --- |
| Salamander Grand Piano（Tone.js 托管集 / V3 分层） | **CC BY 3.0**（作者 Alexander Holm，见参考文档 §3.3、§3.4） | ✅ 可以，**必须保留署名**（README/关于页注明来源） |
| smplr `SplendidGrandPiano` 所用采样 | AKAI 公有领域（Public Domain，见 [sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano) README） | ✅ 可以，无署名义务（但建议注明来源） |
| GeneralUser GS（SpessaSynth 路线） | 独立第三方许可（s.Christian Collins 站点分发） | ⚠️ 需另行核查其许可条款（本次未验证，见 §10） |

**CDN vs 自托管取舍：**

| 维度 | 外部托管（tonejs.github.io / smpldsnds.github.io） | 自托管（复制到 `public/` 或 npm 依赖本地文件） |
| --- | --- | --- |
| 加载可靠性 | 依赖 GitHub Pages：无 SLA、有**每秒请求限流**（smplr README 明示）、被墙/断网即失效 | 与 App 同源同命运：离线可用（配合 Service Worker 可 PWA 化）、无第三方限流 |
| 首次部署体积 | 0 | Salamander 集 ~8.5MB（mp3+ogg）；smplr 钢琴集 ~18MB；需进入 git 仓库 |
| 加载速度 | 单文件 ~60KB，可流式起播；但 303 个请求受限流影响可能变慢 | 本地静态资源 + HTTP 缓存，最稳定可控；仍可只加载所需音域子集 |
| 维护成本 | 无（但上游改动/下线不可控） | 需在仓库内存放采样并跟随上游更新（一次性成本） |

**结论**：本项目场景（本地工具类应用，追求稳定）**倾向自托管**：把 Salamander 集（或 smplr 采样镜像）放入 `public/`，smplr 用 `baseUrl` 指向，Tone.Sampler 用 `baseUrl` 指向本地路径；保留 PolySynth 作为加载失败兜底。若初期想快速验证，可直接用默认在线采样（注意限流风险）。

## 8. 视觉同步设计要点（由调查事实推导）

1. **时间轴唯一来源是解析结果**：`@tonejs/midi` 给出每个音符的绝对秒数（tempo map 已折算）。播放开始时记录 `start = AudioContext.currentTime`，任意音符的墙钟时刻 = `start + note.time`。这是确定性的、与调度无关的时间轴。
2. **音频回调只做辅助**：smplr 的 `onStart`（提前最多 200ms 触发，README 明示）、Tone.Transport 回调（“invoked just before the scheduled time”）都不保证到点；视觉（五线谱当前音符高亮、瀑布流落点）不能以回调触发时刻为准。smplr `Sequencer` 的 `noteOn/noteOff` 虽“driven by actual audio playback”，但经主线程转发仍有抖动。
3. **渲染用 rAF 轮询**：每帧 `t = context.currentTime - start`，与音符时间数组比对绘制；这正是 Chris Wilson 文章给出的“第三个时钟”方案。SpessaSynth 的 `currentHighResolutionTime` 是同样思路的内置实现（若走 SpessaSynth 路线可直接用）。
4. **调度层只负责声音**：lookahead 窗口（100~200ms）内把 `[t, t+dur]` 排给采样器（smplr 的 `time` 参数 / Tone.Sampler 的 `triggerAttackRelease(time)`）；暂停/seek = 清空调度队列 + 重置 `start` 偏移。
5. 五线谱/瀑布流渲染所需的拍号、调号、小节换算数据来自 `header.timeSignatures/keySignatures/PPQ`，同样先于播放确定。

## 9. 明确推荐（汇总）

- **解析**：`@tonejs/midi`（唯一依赖 `midi-file`，与播放层解耦）。
- **播放主路线**：`smplr` 的 `SplendidGrandPiano` —— 音质最佳（4 层力度逐音采样）、API 齐全（ready/progress/CC/reverb/sequencer）、调度参数可调；落地时把采样镜像到 `public/` 并设置 `baseUrl`（许可允许），用 `notesToLoad` 控制加载量，`CacheStorage` 做二次缓存。
- **播放备选路线**：Tone.js `Sampler` + Salamander 采样自托管（CC BY 3.0，署名）——体积最小、与 Tone.js 生态一致；音质上限低于 smplr（单力度层），可后续用 `@audio-samples/piano-mp3-velocityN` 多层包升级。
- **兜底**：Tone.js `PolySynth` 合成音色（零下载）。
- **不推荐首发**：SpessaSynth —— 能力最强（直读 MIDI + 完整事件）但引入音源管理、worklet 文件部署、TS 引擎性能（polyphony 高时官方自述弱于原生）等复杂度；适合作为后续“原生 MIDI 播放器模式”的备选评估项，值得保留在技术雷达中。
- **视觉同步**：统一 `AudioContext.currentTime` 时钟 + lookahead 调度 + rAF 渲染；不依赖任何“到点回调”。

## 10. 主要风险

1. **采样加载时间/体积**：smplr 全量 ~18MB（303 文件）、Salamander 8.5MB；弱网首载慢。缓解：流式起播（smplr 支持先加载部分即出声）、`notesToLoad` 子集、进度条、PolySynth 兜底。
2. **外部托管限流**：smplr 默认采样在 GitHub Pages，有每秒请求限流（README 明示），开发期 HMR 反复拉取易触发；缓解：镜像自托管 + CacheStorage。
3. **CDN/托管依赖**：tonejs.github.io 与 smpldsnds.github.io 均为 GitHub Pages，无 SLA，可能被墙或变更；缓解：采样落地 `public/`。
4. **许可合规**：Salamander 为 CC BY 3.0，自托管/分发必须保留 Alexander Holm 署名；GeneralUser GS（SpessaSynth 路线）许可未验证，采用前需核查。
5. **低活跃维护**：`@tonejs/midi` 自 2022 年停更（功能稳定但 bug 修复慢）；smplr 1.0 刚发布（API 有 MIGRATE 兼容表，仍可能有破坏性变更）。
6. **自动播放策略**：首次播放必须由用户手势触发（`context.resume()`），产品流程需内置“点击播放”环节。
7. **调度回调语义陷阱**：所有 `onStart` 类回调都可能提前触发（最多一个 lookahead 窗口），直接拿来做视觉会“超前”；必须按 §8 的时间轴方案实现。

## 11. 不确定项（如实记录）

- smplr 托管钢琴采样**总大小 ~18MB 为估算**（按 303 × 实测单文件 61KB 推算），未逐文件实测。
- Salamander V3 全 16 层（`@audio-samples/piano-mp3-velocityN` 全系列）总体积未逐包实测（仅 velocity1=4.49MB 为 README 数据）；已发布的 velocity 包数量（1~15 奇数层）未逐一核实。
- SpessaSynth 应用附带 GeneralUser GS 压缩音源的具体大小与**许可条款**未验证。
- `@tonejs/midi` 对 format 2 文件的处理（底层 midi-file 可解析多轨，但高层 API 未做 pattern 级区分）未用真实 format 2 文件验证。
- smplr `Sequencer` 是音符数组输入（不支持直接吃 .mid 文件），已确认需用 `@tonejs/midi` 先转换；但其 `at` 时间记法（bar:beat:tick）与 tempo map 变化的兼容性未深测。
- Tone.js v15 `Transport` 与 smplr `Sequencer` 在不同浏览器（尤其 Safari）下的时钟行为未实测。

## 12. 参考

- 外部资料摘录与全部来源 URL：见 [参考文档](../reference/midi/format-and-libraries.md)（获取日期 2026-09-05）。
- 核心一手来源：
  - SMF 规范：[https://midi.org/standard-midi-files](https://midi.org/standard-midi-files)（官方 PDF）；[http://www.ccarh.org/courses/253/handout/smf/](http://www.ccarh.org/courses/253/handout/smf/)
  - @tonejs/midi：[https://github.com/Tonejs/Midi](https://github.com/Tonejs/Midi)
  - midi-file：[https://github.com/carter-thaxton/midi-file](https://github.com/carter-thaxton/midi-file)
  - midi-json-parser：[https://github.com/chrisguttandin/midi-json-parser](https://github.com/chrisguttandin/midi-json-parser)
  - 调度：[https://web.dev/articles/audio-scheduling](https://web.dev/articles/audio-scheduling)；Tone.js wiki：[https://github.com/Tonejs/Tone.js/wiki/Transport](https://github.com/Tonejs/Tone.js/wiki/Transport)
  - smplr：[https://github.com/danigb/smplr](https://github.com/danigb/smplr)；采样源：[https://github.com/sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano)
  - Salamander 采样：[https://github.com/Tonejs/audio](https://github.com/Tonejs/audio)；npm 分层：[https://www.npmjs.com/package/@audio-samples/piano-mp3-velocity1](https://www.npmjs.com/package/@audio-samples/piano-mp3-velocity1)
  - SpessaSynth：[https://github.com/spessasus/SpessaSynth](https://github.com/spessasus/SpessaSynth)、[https://github.com/spessasus/spessasynth_core](https://github.com/spessasus/spessasynth_core)、[https://github.com/spessasus/spessasynth_lib](https://github.com/spessasus/spessasynth_lib)
  - 自动播放：[https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)；[https://developer.chrome.com/blog/autoplay/](https://developer.chrome.com/blog/autoplay/)
