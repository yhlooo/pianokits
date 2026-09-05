# 参考：钢琴瀑布流与五线谱渲染相关库的外部资料摘录

> 本文档仅收录外部资料的直接摘录与客观数据，不做主观加工和选型结论。选型结论见
> `docs/development/research/20260905-waterfall-and-notation.md`。
>
> **调查日期：2026-09-05（UTC）。** 所有 npm / GitHub 数据均于该日通过官方 API 实时获取：
>
> - npm 元数据：`https://registry.npmjs.org/<pkg>`（最新版本、许可证、最后发布时间、unpacked 体积）
> - npm 周下载量：`https://api.npmjs.org/downloads/point/last-week/<pkg>`
> - GitHub 仓库信息：`https://api.github.com/repos/<owner>/<repo>`（stars、最后 push、许可证、归档状态）
> - 代码/文档摘录：各仓库 `raw.githubusercontent.com` 上的 README / 源码文件
>
> 文中的"最后提交（push）时间"指 GitHub API 的 `pushed_at` 字段（任意分支上的最近一次 push），
> 与"npm 最后发布"是两回事，两者都列出以资区分。

## 1. 钢琴瀑布流 / 钢琴卷帘候选

### 1.1 @magenta/music（magenta/magenta-js）—— Visualizer

- npm 包：`@magenta/music`，最新版 `1.23.1`，最后发布于 **2021-11-01**（npm registry `time` 字段）；未标记 deprecated。
- 许可证：Apache-2.0（npm 与 GitHub 一致）。
- 周下载量：3,068（2026-09-05）。
- unpacked 体积：11.43 MB。
- GitHub 仓库：`magenta/magenta-js`（原 `tensorflow/magenta-js`，API 返回 Moved Permanently 重定向至此），stars 2,125，最后 push **2026-06-22**，未归档。
- 注意：仓库在 2026 年仍有零星提交，但 npm 自 2021-11 起未再发布新版本。

源码 `music/src/core/visualizer.ts`（获取日期 2026-09-05）文件头注释：

```ts
/**
 * A module containing a visualizer for `NoteSequences`.
 *
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * ...
 */
```

Visualizer 配置接口（同上文件）：

```ts
export interface VisualizerConfig {
  noteHeight?: number
  noteSpacing?: number
  pixelsPerTimeStep?: number
  noteRGB?: string
  activeNoteRGB?: string
  minPitch?: number
  maxPitch?: number
}
```

抽象基类 `BaseVisualizer.redraw()` 的 JSDoc（同上文件）：

```
Redraws the entire note sequence, optionally painting a note as active
@param activeNote (Optional) If specified, this `Note` will be painted
in the active color.
@param scrollIntoView (Optional) If specified and the note being painted is
offscreen, the parent container will be scrolled so that the note is
in view.
@returns The x position of the painted active note. Useful for
automatically advancing the visualization if the note was painted outside
of the screen.
```

该文件导出的具体类（grep 结果）：`PianoRollCanvasVisualizer`、`Visualizer`
（继承 `PianoRollCanvasVisualizer`）、`PianoRollSVGVisualizer`、`WaterfallSVGVisualizer`。

官方 demo `music/demos/visualizer.ts`（获取日期 2026-09-05）中，播放驱动可视化重绘的方式：

```ts
const player = new mm.SoundFontPlayer(
  'https://storage.googleapis.com/magentadata/js/soundfonts/sgm_plus',
  mm.Player.tone.Master,
  null,
  null,
  {
    run: (note: mm.NoteSequence.Note) => {
      for (let i = 0; i < visualizers.length; i++) {
        visualizers[i].redraw(note, true)
      }
    },
    stop: () => {
      for (let i = 0; i < visualizers.length; i++) {
        visualizers[i].clearActiveNotes()
      }
    },
  },
)
```

即：Visualizer 输入是 Magenta 自己的 `NoteSequence` 数据结构；播放中的"当前音符高亮 +
自动滚动"由 `SoundFontPlayer` 的 `run` 回调驱动 `redraw(note, true)` 完成。
仓库与 demo 中未见到缩放、点击跳转等交互 API。

### 1.2 react-piano-roll（dpren/react-piano-roll）

- npm 包：`react-piano-roll`，最新版 `0.1.3`，最后发布于 **2019-07-02**；未标记 deprecated。
- 许可证：MIT。
- 周下载量：30（2026-09-05）。
- GitHub：`dpren/react-piano-roll`，stars 27，最后 push 2024-06-27。
  （npm 发布停滞但仓库 2024 年仍有零星提交。）

README 摘录（获取日期 2026-09-05）：

> A React fork of [mjhasbach/pixi-piano-roll](https://github.com/mjhasbach/pixi-piano-roll).
>
> Note: this is not an audio sequencer in itself – it's just the graphical part.

输入数据格式（README 代码示例）：

```jsx
noteData={[
  ["0:0:0", "F5", ""],
  ["0:0:0", "C4", "2n"],
  ...
]}
```

播放控制通过 ref 暴露（README "Playback API" 一节）：

```jsx
playbackRef.current.toggle() // ⏯️
playbackRef.current.seek('0:0:0') // ⏹️
```

其上游 `pixi-piano-roll`（mjhasbach）的文档说明（随 README 一并复制）：

> ## pixiPianoRoll
>
> JavaScript 2D WebGL / Canvas animated piano roll
>
> **Author:** Matthew Hasbach
> **License**: MIT
> **Copyright**: Matthew Hasbach 2015

`pixi-piano-roll` npm 最新版 `1.2.3`，最后发布 2015-12-17，周下载量 11；
GitHub stars 23，最后 push 2015-12-17。基于旧版 PixiJS，与 react-piano-roll 同属弃更状态。

### 1.3 gridsound/daw

- GitHub：`gridsound/daw`，stars 1,860，最后 push 2026-07-28，**许可证 AGPL-3.0**。
- 没有同名 npm 发布（npm 搜索 "gridsound" 无结果），以 Web 应用形式分发（daw.gridsound.com）。

README 摘录（获取日期 2026-09-05）：

> GridSound is a free, work-in-progress, half open-source digital audio
> workstation written with HTML5 and more precisely with the WebAudio API.

其 PianoRoll 是 DAW 应用内部组件（跟随整个应用仓库），README 未声明其可作为独立库使用；
npm 上无独立包。AGPL-3.0 且无独立分发，是引用其 PianoRoll 代码的两大障碍。

### 1.4 其他 npm 上的 piano-roll 类包（2026-09-05 数据）

以下为 npm 搜索 "piano-roll" 命中的相关包，周下载量均不超过两位数，全部属于
个人项目 / 新项目：

| 包名                                             | 最新版 | npm 最后发布 | 周下载量 | 许可证  | GitHub stars | 最后 push  |
| ------------------------------------------------ | ------ | ------------ | -------- | ------- | ------------ | ---------- |
| `wave-roll`（crescent-stdio/wave-roll）          | 0.4.0  | 2025-12-06   | 66       | MIT     | 27           | 2026-08-07 |
| `@minagishl/react-piano-roll`                    | 0.1.0  | 2025-12-22   | 15       | MIT     | 6            | 2026-04-14 |
| `vue-piano-roll`（howardah/vue-piano-roll）      | 1.3.1  | 2025-12-12   | 17       | MIT     | 5            | 2025-12-12 |
| `piano-visualizer`（d-buckner/piano-visualizer） | 1.2.1  | 2026-06-12   | 5        | MIT     | 1            | 2026-06-12 |
| `midi-visualizer`（stagas/midi-visualizer）      | 1.0.1  | 2022-08-01   | 11       | —       | —            | —          |
| `wavesurfer-piano-roll-plugin`                   | 0.2.0  | 2026-02-19   | 0        | —       | —            | —          |
| `piano-roll`                                     | 0.1.1  | 2017-08-18   | —        | GPL-2.0 | —            | —          |

其中 `wave-roll` 的 README 摘录（获取日期 2026-09-05）：

> **WaveRoll** is an interactive [JavaScript library](https://www.npmjs.com/package/wave-roll)
> that enables comparative visualization and synchronized playback of multiple
> MIDI piano rolls on a browser.
>
> Multi-instrument MIDI files are supported with automatic GM instrument mapping
> and per-track mute/volume/visibility controls.

它以 Web Component（`<wave-roll>`）形式使用，定位是多轨对比可视化（配套 arXiv 论文
arXiv:2511.09562），而非面向播放器界面的单曲瀑布流组件。

## 2. 五线谱路线相关库

### 2.1 abcjs（paulrosen/abcjs）

- npm 包：`abcjs`，最新版 `6.7.0`，最后发布 **2026-08-07**。
- 许可证：MIT。
- 周下载量：55,059（2026-09-05）。
- unpacked 体积：5.68 MB。
- GitHub：stars 2,334，最后 push 2026-08-09，未归档。

README 摘录（获取日期 2026-09-05）：

> # Javascript library for rendering standard music notation in a browser.
>
> This library makes it easy to incorporate **sheet music** into your **websites**.
> You can also turn visible **ABC** text into sheet music ... You can also generate
> **MIDI files** or play them directly in your browser.

即 abcjs 的 MIDI 能力是 **ABC → MIDI 的合成输出**（README 只描述了该方向）；
README 与文档中均无 MIDI → ABC 的转换功能。

版本动态（README "Announcement" 各节）：6.0.0 出 beta 正式发布；6.1.0 新增移调
（ABC in → ABC out）；6.6.0 新增 `chordGrid`；6.7.0 为 bugfix 版；README 同时写明
"version 7 is already in planning"。

播放高亮/光标能力：官方文档 [Timing Callbacks](https://docs.abcjs.net/animation/timing-callbacks.html)
（获取日期 2026-09-05）摘录：

> This runs an animation timer and does callbacks at various intervals. This
> allows you to do various effects that are timed with beats or playing notes.

参数表（同页）：

| 参数              | 说明（原文）                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `beatCallback`    | "Called for each beat passing the beat number (starting at 0)."                                                              |
| `eventCallback`   | "Called for each event (either a note, a rest, or a chord, and notes in separate voices are grouped together.)"              |
| `lineEndCallback` | "Called at the end of each line. (This is useful if you want to be sure the music is scrolled into view at the right time.)" |

`beatCallback` 传入参数中包括光标坐标信息（同页节选）：

> ... cursor if the beat occurs between notes. This is an object with the
> attributes { left: , top: , height: } This can be used to smooth out the
> cursor by moving it on the beat callbacks.

另在 Audio 文档（`docs/audio/synthesized-sound.md` 对应站点页）中提及可将视觉对象
（visual object）与合成器配对（节选）：

> ... visual object, but this is a way to custom build any sequence.

### 2.2 abcMIDI 项目的 midi2abc（C 命令行工具）及其 JS/WASM 移植现状

官方页面 [abc.sourceforge.net/abcMIDI/](https://abc.sourceforge.net/abcMIDI/)
（获取日期 2026-09-05）摘录：

> abcMIDI is a package of programs developed by James Allwright for processing
> ABC music notation files. It consists of several programs: `abc2midi`,
> `abc2abc`, `yaps`, and `midi2abc`.

关于 `midi2abc`（同页）：

> Midi2abc is another useful program included with this package. It produces an
> ABC file from a MIDI file. In some circumstances the resulting ABC file is not
> particularly easy to read, but it is a fairly accurate representation of the
> MIDI file. This program is also useful for debugging `abc2midi` when the output
> file does not sound quite right ...

维护者为 Seymour Shlien，以 C 源码分发，命令行界面使用。

npm 移植现状（2026-09-05 实测）：npm 搜索 `abc2midi`、`abcmidi`、`midi2abc`
均**无结果**（`midi2abc` 在 registry 中 "Not found"），未找到 abcMIDI 工具链的
JS/WASM 移植包。

仅有的一款同类开源实现：`marmooo/midi2abc`（GitHub stars 29，最后 push 2026-05-01，
MIT）。其 README（获取日期 2026-09-05）全文核心句：

> # midi2abc
>
> Convert MIDI to ABC notation by using Tone.js note sequence generated by
> Magenta.js.

即其转换路径为"MIDI → Magenta.js 量化成 NoteSequence → Tone.js 时序 → 自写 ABC 输出"，
是单作者的小型实验项目（无 npm 发布、无测试体系可见），与 abcMIDI 的 midi2abc 无关。

### 2.3 opensheetmusicdisplay（OSMD）

- npm 包：`opensheetmusicdisplay`，最新版 `2.1.2`，最后发布 **2026-08-06**。
- 许可证：BSD-3-Clause。
- 周下载量：25,329（2026-09-05）。
- unpacked 体积：1.92 MB。
- GitHub：stars 1,953，最后 push 2026-09-03，未归档。

README 摘录（获取日期 2026-09-05）：

> OpenSheetMusicDisplay renders MusicXML sheet music in the browser. It is the
> missing link between [MusicXML](https://www.musicxml.com/) and
> [VexFlow](https://www.vexflow.com/).

README 中关于播放能力的说明（图片配图文字）：

> (Mockup, OSMD on its own does not support playback)

Key Features 节选：

> - _Soon: Audio Playback (work in progress, early access build available for
>   [Github sponsors](https://github.com/sponsors/opensheetmusicdisplay))_
> - Uses [Vexflow](https://www.vexflow.com/) for rendering and (partly) layout
> - Parses most MusicXML tags and integrates it into an accessible and modifiable
>   data model (e.g. to change a note's color)
> - Allows modification of the displayed score, like hiding parts or instruments,
>   hiding instrument names, title or composer, a more compact layout, or coloring notes
> - Outputs SVG or PNG

Limitations 节选：

> Not all MusicXML tags and attributes are (fully) supported:
>
> - Advanced Pedal marks (down/up brackets and lift wedge currently in early access
>   for sponsors, "Ped." and "*" signs supported)
> - Some attributes like special drums noteheads/glyphs
>
> Also, **OSMD is a renderer, not a full interactive sheet music editor.**
> Rendering takes some time for long scores, and you can't easily/quickly move
> notes, place new notes, etc. ...
> (You can manipulate the SVG nodes for instant changes like note re-coloring, see
> [Exploring the Demo | Wiki](...))

光标：OSMD 类文档中存在 `Cursor` 类（`https://opensheetmusicdisplay.github.io/classdoc/classes/Cursor.html`，
页面标题 "Cursor | OpenSheetMusicDisplay"），提供跟随播放位置的光标。

配套播放器的 npm 状态（2026-09-05）：

| 包                                      | 最新版 | 最后发布   | 许可证         | 周下载量 |
| --------------------------------------- | ------ | ---------- | -------------- | -------- |
| `osmd-audio-player`（官方 org）         | 0.7.0  | 2021-12-30 | MIT            | 325      |
| `osmd-extended`（社区，带 AudioPlayer） | 1.9.2  | 2025-08-07 | **UNLICENSED** | —        |

### 2.4 music21j（cuthbertLab/music21j）

- npm 包：`music21j`，最新版 `0.23.7`，最后发布 **2026-08-25**。
- 许可证：BSD-3-Clause。
- 周下载量：441（2026-09-05）。
- unpacked 体积：10.66 MB。
- GitHub：stars 159，最后 push 2026-09-02，未归档。

README 摘录（获取日期 2026-09-05）：

> **Music21j: An Interactive Framework for Musical Analysis**
>
> **Music21j** is a Javascript reinterpretation of the [Music21 Python] package,
> a toolkit for computer-aided musicology, now with intuitive HTML/Javascript
> interfaces. Some things music21j can do include:
>
> - Visualize and hear changes in Streams quickly (using [Vexflow] and [MIDI.js])
> - Connect scores to MIDI devices (via Web Midi or [JazzSoft] plugin)
> - Analyze and perform music theory at a lower level than Python music21

关于 MIDI 文件解析：检索其 `src/converter.ts`（获取日期 2026-09-05），**没有任何
"midi" 相关代码**；仓库树中与 midi 相关的源码仅有 `src/miditools.ts`（实时 MIDI 事件
播放器）与 `src/webmidi.ts`（Web MIDI 设备接入），不存在 .mid 二进制文件 → Stream 的
解析器。即 music21j 目前只支持 MusicXML 的解析/序列化（`src/converter.ts`），**不支持
MIDI 文件导入**。

### 2.5 webmscore（LibreScore/webmscore）

- npm 包：`webmscore`，最新版 `1.2.1`，最后发布 **2023-01-24**。
- 许可证：GPL（npm 声明为 `GPL`；项目基于 MuseScore 的 libmscore，GPL 传染）。
- 周下载量：769（2026-09-05）。
- unpacked 体积：23.46 MB（含两份 wasm：`webmscore.lib.wasm` 与 `webmscore.lib.mem.wasm`）。
- GitHub：stars 181，最后 push 2023-01-24，未归档（但已 3 年无提交）。

README 摘录（获取日期 2026-09-05）：

> # webmscore
>
> > MuseScore's libmscore (the core library) in WebAssembly!
>
> ## Features
>
> - Parse `mscz` file data
> - Get score metadata
> - Export part score
> - Generate music sheets in SVG/PNG/PDF format
> - Generate MIDI
> - Generate audio files in WAV, OGG, MP3, or FLAC format
> - Synthesize raw audio frames, can be used in the Web Audio API
> - Export as MusicXML compressed/uncompressed
> - Generate position information of measures or segments on the generated sheets
> - Run inside a Web Worker thread

MIDI 导入支持：README 的输入只描述 "Parse `mscz` file data"；检索其
`webmscore.cdn.mjs`（获取日期 2026-09-05），`load()` 中出现的文件扩展名字符串只有
`'mscz'`，无 `'mid'`。即 npm 包未暴露 MIDI 文件导入能力（libmscore 原版 C++ 是否可
导入 MIDI 与 webmscore 的 JS 封装是否开放该能力是两回事，本文只记录 webmscore 包
的实际状态）。

另注：`webmscore-webpack5@0.21.0-a`（2022-09-24）为早期实验包。搜索（2026-09-05）
未发现 MuseScore 官方发布的公开 npm wasm 包。

### 2.6 vexflow（vexflow/vexflow）

- npm 包：`vexflow`，最新版 `5.0.0`，最后发布 **2025-03-05**。
- 许可证：MIT（仓库 LICENSE 文件开头 "Copyright (c) 2023-present VexFlow contributors"，
  正文为 MIT 条款）。
- 周下载量：43,760（2026-09-05）。
- unpacked 体积：20.29 MB。
- GitHub：`vexflow/vexflow`（新 org，VexFlow 5 起迁入），stars 234，最后 push 2026-08-06；
  旧仓库 `0xfe/vexflow` stars 4,366，最后 push 2025-03-05（与 v5.0.0 发布同日）。

README 摘录（获取日期 2026-09-05）：

> VexFlow is an open-source library for rendering sheet music. It is written in
> TypeScript, and outputs scores to HTML Canvas and SVG. It works in browsers and
> in Node.js projects (e.g., a command line script to save a score as a PDF).

> ## Factory and EasyScore
>
> Factory and EasyScore are VexFlow's high-level API for creating staves, voices,
> and notes.

> [VexFlow](https://vexflow.com) was created by [Mohit Muthanna Cheppudira](https://muthanna.com)
> in 2010. It is currently maintained by [Ron Yeh](https://github.com/ronyeh) and
> [Rodrigo Vilar](https://github.com/rvilarl).

VexFlow 是"雕刻引擎"：它按你给它的音符/谱表对象排版绘制，不包含任何 MIDI 解析、
量化、分声部逻辑。

### 2.6.1 VexFlow 乐谱字体（@vexflow-fonts/*，2026-09-05 获取）

npm 包 `vexflow@5.0.0` 的文件清单（unpkg meta 接口实测）显示：主包内置了字体**度量数据**模块
（`build/esm/src/fonts/{bravura,petaluma,petalumascript,gonville,academico,academicobold}.js`，
其中 bravura.js 329,664 字节、petaluma.js 300,557 字节），但**不含字形文件本身**（包内无 .otf/.woff2）。
字形文件由 VexFlow 官方以独立 npm 包分发（仓库 `vexflow/vexflow-fonts`，描述原文）：

> Fonts for use with VexFlow. Each font is published as a separate NPM package.

`@vexflow-fonts/bravura@1.0.2` 包内容（unpkg meta 接口实测）：

| 文件            | 大小         | 说明                     |
| --------------- | ------------ | ------------------------ |
| `bravura.woff2` | 247,200 字节 | Web 字体（浏览器加载用） |
| `bravura.otf`   | 512,924 字节 | 桌面/排版用途            |
| `metadata.json` | 733,542 字节 | SMuFL 字形度量           |
| `index.css`     | 177 字节     | @font-face 声明          |
| `LICENSE.txt`   | 4,420 字节   | 许可文本                 |

`@vexflow-fonts/bravura` LICENSE.txt 关键内容摘录：

> Copyright © 2019, Steinberg Media Technologies GmbH (http://www.steinberg.net/),
> with Reserved Font Name "Bravura".
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.

OFL 1.1 许可文本中与本项目相关的条款摘录：

> The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works.
>
> 2. Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. ...

（结论性判断见 research 文档 `20260905-packaging-and-licensing.md`，此处仅收录原文。）

### 2.7 alphaTab（CoderLine/alphaTab）

- npm 包：`@coderline/alphatab`，最新版 `1.8.4`，最后发布 **2026-07-05**。
- 许可证：MPL-2.0。
- 周下载量：10,790（2026-09-05）。
- unpacked 体积：13.04 MB。
- GitHub：stars 1,822，最后 push 2026-09-03。

README 摘录（获取日期 2026-09-05）：

> alphaTab is a cross platform music notation and guitar tablature rendering library.

> alphaTab can load music notation from various sources like Guitar Pro 3-7,
> AlphaTex and MusicXML and render them into beautiful music sheets right within
> your browser (or application). Using a built in midi synthesizer named alphaSynth
> the music sheets can also be played in your browser.

Features 节选：

> - Load GuitarPro 3-5, GuitarPro 6, Guitar Pro 7, AlphaTex or MusicXML
> - Render as SVG or Raster Graphics ...
> - Display single or multiple instruments as standard music notation and guitar
>   tablatures consisting of ... piano grand staff, tied notes, grace notes, ...
>   tuplets, fingering ...
> - Play the music sheet via built-in Midi+SoundFont2 Synthesizer ...

alphaTab 同样没有 MIDI → 乐谱的转换能力（输入是 GuitarPro/AlphaTex/MusicXML，
alphaSynth 只做播放输出）。

### 2.8 其他候选（简要数据）

| 包/产品                                           | 说明（官方描述或页面）                                                                                                    | 许可证       | 备注                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| `@sudobility/music_codecs`（johnqh/music_codecs） | "Score encoders and decoders for ScoreSmith - MIDI, MusicXML and tracker modules. Shared by ..."，0.2.19，2026-09-03 发布 | **BUSL-1.1** | Business Source License，非开放许可证，商用/生产使用受限 |
| `musicxml-io`（tan-z-tan/musicxml-io）            | "Parse and serialize MusicXML (.xml/.mxl) and ABC notation with high round-trip fidelity"，0.10.1，2026-09-02 发布        | MIT          | 只做 MusicXML/ABC 序列化，无 MIDI 输入                   |
| `osmd-extended`                                   | OSMD + AudioPlayer 的社区增强包                                                                                           | UNLICENSED   | npm 许可证字段为 UNLICENSED，引用有风险                  |
| Soundslice                                        | 在线乐谱平台，提供 embed miniplayer 与 Data API（soundslice.com）                                                         | 商业服务     | 依赖其平台与付费计划，非本地渲染库                       |
| SmartScore（Musitek）                             | 商业乐谱识别/编辑软件                                                                                                     | 商业软件     | 桌面产品，与浏览器内渲染场景关系弱                       |

### 2.9 MIDI → MusicXML 转换器候选（2026-09-05 复核）

本节为对 `20260905-waterfall-and-notation.md` §3.3 结论的补充复核，收录该文档未列出的
"MIDI→乐谱转换器"候选，全部经实测确认不可用或方向不符。

#### 2.9.1 midi2musicxml（kaibadash/midi2musicxml）

- GitHub：`kaibadash/midi2musicxml`，许可证 MIT（README 声明 "MIT License. Copyright 2020 kaiba"）。
- 语言/运行要求：Java 11+（Gradle 构建，GUI/CUI），**不是 JS/TS 库**，npm 无同名包。
- 定位：为 NEUTRINO（歌声合成器）服务的 "MIDI + 歌词文本 → MusicXML" 转换器。
- README 开头（获取日期 2026-09-05）原文：

  > midi2musicxml is no longer maintained, please use tyouseisientool.
  > https://github.com/sigprogramming/tyouseisientool

- 其继任者 `tyouseisientool`（sigprogramming）同样为桌面 Java 工具（歌声调声用途），
  面向"单旋律 + 歌词"的歌声合成工作流，与钢琴双谱表记谱诉求不符。

#### 2.9.2 concertmaster（MegaArman/concertmaster）

- npm 包：`concertmaster`，最新版 `0.2.2`，最后发布 **2018-05-29**，`flags.unstable = true`。
- 描述（npms.io 检索）："A simple module to help convert musically relevant information"。
- npms.io 质量分 0.53、流行度 0.036。2018 年停发，属弃更个人项目，无实际转换能力证据。

#### 2.9.3 musicvis-lib（fheyen/musicvis-lib）

- npm 包：`musicvis-lib`，最新版 `0.55.0`，最后发布 **2022-03-10**，`flags.unstable = true`。
- 描述（npms.io 检索）："Music analysis and visualization library"，关键词含 MIDI/MusicXML，
  但定位是音乐分析与可视化（配合其可视化论文/站点），不是 MIDI→乐谱转换器。

#### 2.9.4 muse-js 撞名说明（重要）

- npm 上名为 `muse-js` 的包是 `urish/muse-js`：**"Muse 2016 EEG Headset JavaScript
  Library (using Web Bluetooth)"**，是 2016 年的脑电头环蓝牙库，与 MuseScore / 音乐完全无关。
- 因此"用 MuseScore 的 wasm 版本（muse-js）做 MIDI 转谱"不成立：该 npm 名已被占用，
  MuseScore 官方的浏览器 wasm 能力目前仍只有 `webmscore`（见 §2.5，且只收 mscz、GPL、弃更）。

#### 2.9.5 @magenta/music 的序列量化工具（`core/sequences`）

`@magenta/music@1.23.1`（§1.1，npm 自 2021-11 停发）的 `core/sequences` 模块提供与
"MIDI→谱"量化环节直接相关的纯函数（官方 TypeDoc，获取日期 2026-09-05）：

| 函数                         | 作用（原文摘要）                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `quantizeNoteSequence`       | "Quantize a NoteSequence proto relative to tempo ... snapped to a nearby quantized step"，要求单一 tempo、单一拍号，抛多 tempo/拍号异常 |
| `quantizeToStep`             | "Quantizes seconds to the nearest step, given steps_per_second"                                                                         |
| `mergeConsecutiveNotes`      | "Any consecutive notes of the same pitch are merged into a sustained note ... grouped by instrument"                                    |
| `applySustainControlChanges` | "Create a new NoteSequence with sustain pedal control changes applied ... Extends each note within a sustain"                           |

这些是**量化/延音处理工具函数**，输出仍是 Magenta 的 `NoteSequence`（量化步进），
**不产出五线谱/MusicXML**；但作为自研量化算法的参考实现有价值（尤其是
`applySustainControlChanges` 对踏板延音的处理）。因 npm 已弃更 4 年+、依赖 11 MB，
不建议作为运行时依赖，仅作算法参考。

#### 2.9.6 npms.io 全量检索（2026-09-05）

- `api.npms.io/v2/search?q=midi musicxml` 仅返回 3 个包：`musicvis-lib`、`concertmaster`、
  `webmscore`，均为 unstable / 弃更，且无一提供可用的 MIDI→MusicXML 转换。
- `api.npms.io/v2/search?q=midi to sheet music` 返回 **0 结果**。

## 3. 数据汇总表（2026-09-05 实测）

| 包 / 仓库                  | npm 最新版 | npm 最后发布 | 周下载量 | 许可证       | unpacked | GitHub stars                      | 最后 push  |
| -------------------------- | ---------- | ------------ | -------- | ------------ | -------- | --------------------------------- | ---------- |
| `@magenta/music`           | 1.23.1     | 2021-11-01   | 3,068    | Apache-2.0   | 11.43 MB | 2,125                             | 2026-06-22 |
| `react-piano-roll`         | 0.1.3      | 2019-07-02   | 30       | MIT          | 0.04 MB  | 27                                | 2024-06-27 |
| `pixi-piano-roll`          | 1.2.3      | 2015-12-17   | 11       | MIT          | —        | 23                                | 2015-12-17 |
| gridsound/daw              | （无 npm） | —            | —        | AGPL-3.0     | —        | 1,860                             | 2026-07-28 |
| `wave-roll`                | 0.4.0      | 2025-12-06   | 66       | MIT          | —        | 27                                | 2026-08-07 |
| `abcjs`                    | 6.7.0      | 2026-08-07   | 55,059   | MIT          | 5.68 MB  | 2,334                             | 2026-08-09 |
| `opensheetmusicdisplay`    | 2.1.2      | 2026-08-06   | 25,329   | BSD-3-Clause | 1.92 MB  | 1,953                             | 2026-09-03 |
| `vexflow`                  | 5.0.0      | 2025-03-05   | 43,760   | MIT          | 20.29 MB | 234（新 org）/ 4,366（0xfe 旧仓） | 2026-08-06 |
| `music21j`                 | 0.23.7     | 2026-08-25   | 441      | BSD-3-Clause | 10.66 MB | 159                               | 2026-09-02 |
| `webmscore`                | 1.2.1      | 2023-01-24   | 769      | GPL          | 23.46 MB | 181                               | 2023-01-24 |
| `@coderline/alphatab`      | 1.8.4      | 2026-07-05   | 10,790   | MPL-2.0      | 13.04 MB | 1,822                             | 2026-09-03 |
| `@sudobility/music_codecs` | 0.2.19     | 2026-09-03   | —        | BUSL-1.1     | 0.49 MB  | —                                 | —          |
| `musicxml-io`              | 0.10.1     | 2026-09-02   | —        | MIT          | 1.60 MB  | —                                 | —          |
| `osmd-audio-player`        | 0.7.0      | 2021-12-30   | 325      | MIT          | 0.18 MB  | —                                 | —          |
| `osmd-extended`            | 1.9.2      | 2025-08-07   | —        | UNLICENSED   | 1.88 MB  | —                                 | —          |

> 说明：`@magenta/music` 的 registry `time.modified` 为 2022-06-12（早于 2026 年），
> 但按版本 `time` 字段其最后一个版本 1.23.1 发布于 2021-11-01，上表采用版本发布时间。
