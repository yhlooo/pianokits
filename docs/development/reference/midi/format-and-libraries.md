# MIDI 文件格式与相关 JS 库参考（外部资料摘录）

> 本文件是参考文档：内容为外部资料（官方规范、库 README、源码、npm 注册表、官方博客）的直接摘录，不做主观加工。
> 所有资料的获取日期为 **2026-09-05**，npm 数据以调查当日注册表为准。

## 1. SMF（Standard MIDI File）格式要点

来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》(RP-001, Revised February 1996)。
官方页面：[https://midi.org/standard-midi-files](https://midi.org/standard-midi-files)（页面提供 PDF 下载链接
`RP-001_v1-0_Standard_MIDI_Files_Specification_96-1-4.pdf`，本文摘录自该 PDF，2026-09-05 获取）。
补充来源：CCARH（Stanford）《Outline of the Standard MIDI File Structure》，
[http://www.ccarh.org/courses/253/handout/smf/](http://www.ccarh.org/courses/253/handout/smf/)（2026-09-05 获取）。
（以下英文引文取自 PDF 文本提取，已修正断行空白等提取伪影。）

### 1.1 文件结构

> A standard MIDI file is composed of "chunks". It starts with a header chunk and is followed by one or more track chunks.
> SMF = \<header_chunk> + \<track_chunk> [ + \<track_chunk> ... ]
>
> 1. The track ID string which is four characters long. For example, header chunk IDs are "MThd", and Track chunk IDs are "MTrk".
> 2. next is a four-byte unsigned value that specifies the number of bytes in the data section of the track.
> 3. finally comes the data section of the chunk.

（来源：CCARH《Outline of the Standard MIDI File Structure》）

### 1.2 头块（Header Chunk）

> header_chunk = "MThd" + \<header_length\> + \<format\> + \<n\> + \<division\>
> **\<header_length\>** 4 bytes — length of the header chunk (always 6 bytes long--the size of the next three fields...).
> **\<format\>** 2 bytes — **0** = single track file format; **1** = multiple track file format; **2** = multiple song file format (i.e., a series of type 0 files)
> **\<n\>** 2 bytes — number of track chunks that follow the header chunk
> **\<division\>** 2 bytes — unit of time for delta timing. If the value is positive, then it represents the units per beat. For example, +96 would mean 96 ticks per beat. If the value is negative, delta times are in SMPTE compatible units.

（来源：CCARH《Outline of the Standard MIDI File Structure》）

官方规范对 `<division>` 的说明：

> The third word, \<division\>, specifies the meaning of the delta-times. It has two formats, one for metrical time, and one for time-code-based time:
>
> - ticks per quarter-note
> - negative SMPTE format
>
> If bit 15 of \<division\> is a zero, the bits 14 thru 0 represent the number of delta-time "ticks" which make up a quarter-note. For instance, if \<division\> is 96, then a time interval of an eighth-note between two events in the file would be 48.
> If bit 15 of \<division\> is a one, delta-times in a file correspond to subdivisions of a second, in a way consistent with SMPTE and MIDI time code. Bits 14 thru 8 contain one of the four values -24, -25, -29, or -30, corresponding to the four standard SMPTE and MIDI time code formats (-29 corresponds to 30 drop frame), and represents the number of frames per second. ... The second byte (stored positive) is the resolution within a frame: typical values may be 4 (MIDI time code resolution), 8, 10, 80 (bit resolution), or 100.

（来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》）

### 1.3 Format 0 / 1 / 2

> A Format 0 file has a header chunk followed by one track chunk. It is the most interchangeable representation of data. It is very useful for a simple single-track player in a program which needs to make synthesizers make sounds...
> A Format 1 or 2 file has a header chunk followed by one or more track chunks. Programs which support several simultaneous tracks should be able to save and read data in format 1, a vertically one-dimensional form, that is, as a collection of tracks. Programs which support several independent patterns should be able to save and read data in format 2, a horizontally one-dimensional form.

（来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》）

### 1.4 tempo map 的存放约定

> To make it easy for the synchronizer to extract this data from a MIDI File, tempo information should always be stored in the first MTrk chunk. For a format 0 file, the tempo will be scattered through the track and the tempo map reader should ignore the intervening events; for a format 1 file, the tempo map must be stored as the first track.
> All MIDI Files should specify tempo and time signature. If they don't, the time signature is assumed to be 4/4, and the tempo 120 beats per minute.

（来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》）

### 1.5 关键 Meta 事件

> FF 51 03 tttttt Set Tempo, in microseconds per MIDI quarter-note
> This event indicates a tempo change. ... Representing tempos as time per beat instead of beat per time allows absolutely exact long-term synchronization with a time-based sync protocol such as SMPTE time code or MIDI time code.

> FF 58 04 nn dd cc bb Time Signature
> The time signature is expressed as four numbers. nn and dd represent the numerator and denominator of the time signature as it would be notated. The denominator is a negative power of two: 2 represents a quarter-note, 3 represents an eighth-note, etc. The cc parameter expresses the number of MIDI clocks in a metronome click. The bb parameter expresses the number of notated 32nd-notes in what MIDI thinks of as a quarter-note (24 MIDI Clocks). ... Therefore, the complete event for 6/8 time, where the metronome clicks every three eighth-notes, but there are 24 clocks per quarter-note, 72 to the bar, would be (in hex): FF 58 04 06 03 24 08

> FF 59 02 sf mi Key Signature
> sf = -7: 7 flats; sf = -1: 1 flat; sf = 0: key of C; sf = 1: 1 sharp; sf = 7: 7 sharps
> mi = 0: major key; mi = 1: minor key

（来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》）

### 1.6 变长数值（Variable Length Quantity）

> A variable length value uses the low order 7 bits of a byte to represent the value or part of the value. The high order bit is an "escape" or "continuation" bit. All but the last byte of a variable length value have the high order bit set. The last byte has the high order bit cleared. The bytes always appear most significant byte first.
> Variable length: 0x7F → 127; 0x81 0x7F → 255; 0x82 0x80 0x00 → 32768

（来源：CCARH《Outline of the Standard MIDI File Structure》）

### 1.7 delta time（tick）到毫秒的换算（规范附录）

> Time (in ms.) = (Number of Ticks) * (Tempo (uS/qn) / Div (ticks/qn)) / 1000
> As an example, if the Set Tempo value were 500000 uS per qn, and the Division were 96 ticks per qn, then the amount of time at 6144 Ticks into the SMF would be: Time = 6144 * (500000/96) / 1000 = 32000 milliseconds
> ... In practice, SMFs can contain multiple Set Tempo Meta Events spaced throughout the file, and in order to calculate a correct elapsed time for any Tick, a running calculation needs to be performed. Note that while the Time Signature is not needed to perform the above calculation, Time Signature is needed, however, if the elapsed time is desired for a particular Bar/Beat value.

（来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》附录）

## 2. JS MIDI 解析库：README / 源码摘录

### 2.1 @tonejs/midi

- 仓库：[https://github.com/Tonejs/Midi](https://github.com/Tonejs/Midi)
- README（master 分支，2026-09-05 获取）：[https://github.com/Tonejs/Midi](https://github.com/Tonejs/Midi)

> Midi makes it straightforward to read and write MIDI files with Javascript. It uses midi-file for parsing and writing.

安装与解析示例（README 原文）：

> `npm install @tonejs/midi`
>
> ```javascript
> // load a midi file in the browser
> const midi = await Midi.fromUrl('path/to/midi.mid')
> //the file name decoded from the first track
> const name = midi.name
> //get the tracks
> midi.tracks.forEach((track) => {
>   const notes = track.notes
>   notes.forEach((note) => {
>     //note.midi, note.time, note.duration, note.name
>   })
> })
> ```
>
> ```javascript
> // If you are using Node.js or have the raw binary string from the midi file, just use the `parse` method:
> const midiData = fs.readFileSync('test.mid')
> const midi = new Midi(midiData)
> ```

README 中给出的解析结果数据结构（关键字段）：

> ```javascript
> {
>   // the transport and timing data
>   header: {
>     name: String,                     // the name of the first empty track,
>                                       // which is usually the song name
>     tempos: TempoEvent[],             // the tempo, e.g. 120
>     timeSignatures: TimeSignatureEvent[],  // the time signature, e.g. [4, 4],
>     PPQ: Number                       // the Pulses Per Quarter of the midi file
>                                       // this is read only
>   },
>   duration: Number,                   // the time until the last note finishes
>   tracks: [
>     {
>       name: String,
>       channel: Number,
>       notes: [
>         {
>           midi: Number,               // midi number, e.g. 60
>           time: Number,               // time in seconds
>           ticks: Number,              // time in ticks
>           name: String,               // note name, e.g. "C4",
>           pitch: String,              // the pitch class, e.g. "C",
>           octave : Number,            // the octave, e.g. 4
>           velocity: Number,           // normalized 0-1 velocity
>           duration: Number,           // duration in seconds between noteOn and noteOff
>         }
>       ],
>       controlChanges: { /* ... */ },
>       instrument: {
>         number : Number,              // the instrument number 0-127
>         family: String,
>         name : String,
>         percussion: Boolean,
>       },
>     }
>   ]
> }
> ```

（注：以上 README 数据结构摘录未列出 keySignatures，但 2.0.28 源码 `src/Header.ts` 已包含调号解析，见下。）

源码 `src/Header.ts`（master 分支，2026-09-05 获取）：

> ```typescript
> export interface TempoEvent {
>   ticks: number
>   bpm: number
>   time?: number
> }
>
> export interface TimeSignatureEvent {
>   ticks: number
>   timeSignature: number[]
>   measures?: number
> }
>
> export interface KeySignatureEvent {
>   ticks: number
>   key: string
>   scale: string
> }
> ```

> ```typescript
> export class Header {
>     tempos: TempoEvent[] = [];
>     timeSignatures: TimeSignatureEvent[] = [];
>     keySignatures: KeySignatureEvent[] = [];
>     meta: MetaEvent[] = [];
>     name = "";
>     ...
> }
> ```

调号解析逻辑（`Header` 构造函数内）：

> ```typescript
> } else if (event.type === "keySignature") {
>     this.keySignatures.push({
>         key: keySignatureKeys[event.scale][event.key + 7],
>         scale: event.scale === 0 ? "major" : "minor",
>         ticks: event.absoluteTime,
>     });
> }
> ```

tempo 秒数换算（`update()` 方法内）：

> ```typescript
> this.tempos.forEach((event, index) => {
>     const lastBPM = index > 0 ? this.tempos[index - 1].bpm : this.tempos[0].bpm;
>     const beats = event.ticks / this.ppq - lastEventBeats;
>     const elapsedSeconds = (60 / lastBPM) * beats;
>     event.time = elapsedSeconds + currentTime;
>     ...
> });
> ```

npm 注册表数据（registry.npmjs.org，2026-09-05 查询）：

- latest 版本：`2.0.28`，发布时间 `2022-02-04T21:08:15.289Z`
- 许可证：MIT
- dependencies：`array-flatten ^3.0.0`、`midi-file ^1.2.2`
- unpackedSize：287,668 字节
- 周下载量：64,094（统计区间 2026-08-23 ~ 2026-08-29，api.npmjs.org）
- GitHub 仓库：1,001 stars，最近一次 push `2023-07-19`

### 2.2 midi-file

- 仓库：[https://github.com/carter-thaxton/midi-file](https://github.com/carter-thaxton/midi-file)
- README（master 分支，2026-09-05 获取）

> The parser is loosely based on midi-file-parser and jasmid, but totally rewritten to use arrays instead of strings for portability.

> ```typescript
> import * as midiManager from 'midi-file'
> const input = fs.readFileSync('star_wars.mid')
> // Convert buffer to midi object
> const parsed = midiManager.parseMidi(input)
> // Convert object to midi buffer
> const output = midiManager.writeMidi(parsed)
> ```

> The intermediate representation has a 'header' and 'tracks', and each track is an array of events.

> ```javascript
> // When parsing the file with `readMidi`, each compressed event using running status bytes will have a `running` flag set on it.
> // Similarly, each `noteOff` event that was encoded using 0x09 will have a `byte9` property set on it.
> var output = writeMidi(parsed, { useByte9ForNoteOff: true, running: true })
> ```

npm 注册表数据（2026-09-05 查询）：

- latest 版本：`1.2.4`，注册表 `time.modified`：`2023-03-15T21:11:55.285Z`
- 许可证：MIT
- 自带类型声明：package.json `types: index.d.ts`
- unpackedSize：47,239 字节
- 周下载量：70,660（2026-08-23 ~ 2026-08-29）
- GitHub 仓库：157 stars，最近一次 push `2026-08-12`

### 2.3 midi-json-parser

- 仓库：[https://github.com/chrisguttandin/midi-json-parser](https://github.com/chrisguttandin/midi-json-parser)
- README（master 分支，2026-09-05 获取）

> **This module is parsing midi files into a human-readable JSON object.**
> This module parses a binary MIDI file and turns it into a JSON representation. This JSON representation can then for example be used to pass it on to the midi-player.

> ```typescript
> import { parseArrayBuffer } from 'midi-json-parser'
> parseArrayBuffer(arrayBuffer).then((json) => {
>   // json is the JSON representation of the MIDI file.
> })
> ```

> ```typescript
> interface IMidiFile {
>   division: number
>   format: number
>   tracks: TMidiEvent[][]
> }
> ```

README 中列出的可解析事件类型包含 `IMidiKeySignatureEvent`、`IMidiSetTempoEvent`、`IMidiTimeSignatureEvent`、
`IMidiNoteOnEvent`、`IMidiNoteOffEvent`、`IMidiProgramChangeEvent`、`IMidiControlChangeEvent`、`IMidiEndOfTrackEvent` 等
（完整列表见 README）。

npm 注册表数据（2026-09-05 查询）：

- latest 版本：`8.1.75`，注册表 `time.modified`：`2026-07-21T17:23:14.923Z`
- 许可证：MIT
- unpackedSize：51,625 字节
- 周下载量：1,205（2026-08-23 ~ 2026-08-29）
- GitHub 仓库：132 stars，最近一次 push `2026-09-01`

### 2.4 jsmidgen

- 仓库：[https://github.com/dingram/jsmidgen](https://github.com/dingram/jsmidgen)
- GitHub 仓库描述（2026-09-05 查询）：“A pure-JavaScript MIDI generator”

> 该库是“生成器”（从零生成 MIDI 文件），不是解析器。

npm 注册表数据（2026-09-05 查询）：

- latest 版本：`0.1.8`，注册表 `time.modified`：`2025-11-16T11:48:53.043Z`
- 许可证：MIT
- unpackedSize：34,945 字节
- 周下载量：705（2026-08-23 ~ 2026-08-29）
- GitHub 仓库：237 stars；最近提交 `2025-11-15`（"Bump version to 0.1.8" / "Fix typo in setTimeSignature()"）

## 3. Web Audio 精确调度（lookahead）参考

### 3.1 Chris Wilson《A tale of two clocks》（web.dev，Google Chrome 开发者文档）

- 来源：[https://web.dev/articles/audio-scheduling](https://web.dev/articles/audio-scheduling)（2026-09-05 获取）

> The Web Audio API exposes access to the audio subsystem's hardware clock. This clock is exposed on the AudioContext object through its .currentTime property... it's designed to be able to specify alignment at an individual sound sample level...

> The worst part of the JavaScript timing APIs are that... the actual callback of timer events in JavaScript (through window.setTimeout() or window.setInterval) can easily be skewed by tens of milliseconds or more by layout, rendering, garbage collection, and XMLHTTPRequest and other callbacks...

> Well, the best way to handle timing is to set up a collaboration between JavaScript timers (setTimeout(), setInterval() or requestAnimationFrame()) and the audio hardware scheduling.

> ...each call will schedule for the next 100ms [with a setTimeout interval of 25ms]. The downside of this long lookahead is that tempo changes, etc., will take a tenth of a second to take effect; however, we are much more resilient to interruptions...

> A good place to start is probably 100ms of "lookahead" time, with intervals set to 25ms.

核心调度循环（文章代码）：

> ```javascript
> while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
>   scheduleNote(current16thNote, nextNoteTime)
>   nextNote()
> }
> ```

关于视觉渲染：

> ...the right way to do visual display is making use of a THIRD timing system! ...synchronized to the visual display... via the requestAnimationFrame API. ... With very complex synced graphics (e.g. precise display of dense musical notes as they play in a musical notation package), requestAnimationFrame() will give you the smoothest, most precise graphic and audio synchronization.

### 3.2 Tone.js Transport（官方 wiki）

- 来源：[https://github.com/Tonejs/Tone.js/wiki/Transport](https://github.com/Tonejs/Tone.js/wiki/Transport)（wiki 原文，2026-09-05 获取）

> Tone.Transport is the master timekeeper, allowing for application-wide synchronization of sources, signals and events along a shared timeline. Callbacks scheduled with Tone.Transport will be invoked just before the scheduled time with the **exact** time of the event passed in as the first parameter to the callback.

> Tone.Transport's callbacks pass `time` into the callback because, without the Web Audio API, Javascript timing can be quite imprecise. ... The Web Audio API provides sample-accurate scheduling for methods like `start`, `stop` and `setValueAtTime`, so we have to use the precise `time` parameter passed into the callback to schedule methods within the callback.

> ```javascript
> Tone.Transport.scheduleRepeat(
>   function (time) {
>     note.triggerAttack(time)
>   },
>   '8n',
>   '1m',
> )
> ```

wiki 的 References 一节直接链接到 Chris Wilson 的 Web Audio 调度文章。

Tone.js v15.1.22 调度相关默认值（源码 `Tone/core/context/Context.ts`，dev 分支，2026-09-05 获取）：

> ```typescript
> static getDefaults(): ContextOptions {
>     return {
>         clockSource: "worker",
>         latencyHint: "interactive",
>         lookAhead: 0.1,
>         updateInterval: 0.05,
>     } as ContextOptions;
> }
> ```

npm 注册表数据（2026-09-05 查询，包名 `tone`）：

- latest 版本：`15.1.22`，注册表 `time.modified`：`2026-08-07T12:37:24.852Z`
- 许可证：MIT
- unpackedSize：5,401,640 字节
- dependencies：`tslib ^2.3.1`、`standardized-audio-context ^25.3.70`
- 周下载量：227,404（2026-08-23 ~ 2026-08-29）
- GitHub 仓库：14,718 stars，最近一次 push `2026-09-03`

### 3.3 Tone.js Sampler 与 Salamander 采样（README 摘录）

- 来源：Tone.js README（dev 分支，2026-09-05 获取）

> ## Tone.Sampler
>
> Multiple samples can also be combined into an instrument. If you have audio files organized by note, `Tone.Sampler` will pitch shift the samples to fill in gaps between notes. So for example, if you only have every 3rd note on a piano sampled, you could turn that into a full piano sample.
> Unlike the other synths, Tone.Sampler is polyphonic so doesn't need to be passed into Tone.PolySynth
>
> ```javascript
> const sampler = new Tone.Sampler({
>   urls: {
>     C4: 'C4.mp3',
>     'D#4': 'Ds4.mp3',
>     'F#4': 'Fs4.mp3',
>     A4: 'A4.mp3',
>   },
>   release: 1,
>   baseUrl: 'https://tonejs.github.io/audio/salamander/',
> }).toDestination()
> ```

Tone.js 官方示例采样仓库 [Tonejs/audio](https://github.com/Tonejs/audio)（“Audio files used in Tone.js examples”）：
`master` 分支 `salamander/` 目录经 GitHub API 统计（2026-09-05）共有 **30 个 mp3（合计 1.92 MB）+ 30 个 ogg（合计 6.62 MB）**，
即音符 A0–A7、C1–C8、D#1–D#7、F#1–F#7（小三度间隔采样，覆盖 88 键范围，其余音符由 Sampler 移调补齐），每个音符单文件（该托管集合不含力度分层）。

`salamander/README`（Tonejs/audio 仓库，2026-09-05 获取）原文：

> Salamander Grand Piano V2 / Yamaha C5
> Technical info
> Recorded @ 48khz24bit
> 16 Velocity layers Sampled in minor thirds from the lowest A.
> ...
> Licence:
> CC-by
> http://creativecommons.org/licenses/by/3.0/
> Author: Alexander Holm

### 3.4 Salamander 采样的 npm 分发（@audio-samples/piano-mp3-velocityN）

- 来源：[https://www.npmjs.com/package/@audio-samples/piano-mp3-velocity1](https://www.npmjs.com/package/@audio-samples/piano-mp3-velocity1)
  （README 经 jsDelivr 获取，2026-09-05）

> # @audio-samples/piano-mp3-velocity1
>
> Salamander Grand Piano V3 MP3 samples
>
> ## Samples source
>
> archive.org/details/SalamanderGrandPianoV3
>
> ## Samples license
>
> - CC BY 3.0 creativecommons.org/licenses/by/3.0/
> - Author: Alexander Holm
>
> ## Total size
>
> 4.49MB

（该系列另有 velocity3/5/7/9/11/13/15、release、pedals 等包，属于 Salamander Grand Piano V3 的 16 层力度分层，按层分包装载。）

## 4. smplr（Web Audio 采样乐器库）

- 仓库：[https://github.com/danigb/smplr](https://github.com/danigb/smplr)
- README（main 分支，2026-09-05 获取）：[https://github.com/danigb/smplr](https://github.com/danigb/smplr)

> `smplr` is a collection of sampled instruments for Web Audio API ready to be used with no setup required.

> #### Library goals
>
> - No setup: specifically, all samples are online, so no need for a server.
> - Easy to use: everything should be intuitive for non-experienced developers
> - Decent sounding: uses high quality open source samples.

> Samples are stored at https://github.com/smpldsnds and there is no need to download them.

SplendidGrandPiano 一节原文：

> ### SplendidGrandPiano
>
> A sampled acoustic piano. It uses Steinway samples with 4 velocity groups from SplendidGrandPiano
>
> ```javascript
> import { SplendidGrandPiano } from 'smplr'
> const piano = SplendidGrandPiano(new AudioContext())
> piano.start({ note: 'C4' })
> ```
>
> The second argument of the constructor accepts the following options:
>
> - `baseUrl`: where the piano samples are fetched from. Defaults to the public hosted set on `smpldsnds.github.io`; override only if you mirror the samples yourself.

加载与播放 API 摘录：

> You can start playing notes as soon as one sample is loaded. To wait for all of them, await either:
>
> - `piano.ready` — resolves to `void` (preferred for new code).
>
> Track how many samples have loaded via the `onLoadProgress` option or the `loadProgress` getter...
> `total` is known before loading starts, so you can display a determinate progress bar.

> ```javascript
> piano.start({ note: 'C4', velocity: 80, time: 5, duration: 1 })
> ```
>
> Schedule notes via the `time` and `duration` properties (both in seconds). `time` is measured against `audioContext.currentTime`.

事件（onStart 时序说明原文）：

> Two events are available: `onStart` and `onEnded`...
> ⚠️ The invocation time of `onStart` is not exact: it fires slightly before the audio actually starts, by up to the scheduler's lookahead window (200ms by default; configurable via the `scheduler` option...).

Sequencer 一节摘录：

> `Sequencer` schedules notes from one or more tracks against any smplr instrument with sample-accurate timing.
>
> ```javascript
> const seq = Sequencer(context, {
>   bpm: 120, // default 120
>   ppq: 480, // pulses per quarter note, default 480
>   timeSignature: 4, // accepts `4` (→ 4/4) or `{ numerator, denominator }`
>   loop: false,
>   lookaheadMs: 200, // scheduling lookahead, default 200
>   intervalMs: 50, // flush interval, default 50
> })
> ```

> `noteOn` and `noteOff` events fire when the instrument's `onStart` / `onEnded` callbacks are called, so they are driven by the actual audio playback — not by the scheduling lookahead.

> ```javascript
> seq.on("beat", (beat, time) => { ... });
> seq.on("bar", (bar, time) => { ... });
> ```

缓存与限流警告（原文）：

> The default sample sets are hosted on GitHub Pages, which rate-limits requests per second. That can be a problem, especially in a development environment with hot reload (most React frameworks).
> To cache samples in the browser, use a `CacheStorage` object: ...
> ⚠️ `CacheStorage` is based on the Cache API and only works in secure environments that run over `https`.

`Soundfont` 一节的采样来源：

> A Soundfont player. By default it loads audio from Benjamin Gleitzman's package of pre-rendered sound fonts (github.com/gleitz/midi-js-soundfonts).

smplr 钢琴采样清单（源码 `src/splendid-grand-piano.ts`，main 分支，2026-09-05 获取，经统计）：

> ```typescript
> const BASE_URL = 'https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples'
> ```
>
> `formats` 默认 `["ogg", "m4a"]`；力度分层 `LAYERS` 共 5 组：
> PPP vel_range [1,40]（61 个采样）、PP [41,67]（61）、MP [68,84]（62）、MF [85,100]（62）、FF [101,127]（57），
> 采样音符范围 MIDI 23–108，**合计 303 个采样文件**。

（注：smplr README 描述为“4 velocity layers”，与上游 sfzinstruments README 的说法一致——原采样为 4 层，最弱力度层为低通滤波合成，即 sfzinstruments README 原文：“5th layer added at lowest velocity using filter cutoff.”；smplr 源码中的 PPP 层即该滤波层（带 `cutoff: 1000` 低通参数），故源码实际为 5 组。）

实测单个采样文件大小（HTTP HEAD，2026-09-05）：`PP C4.ogg` = 61,613 字节；`PP C4.m4a` = 68,116 字节。

npm 注册表数据（2026-09-05 查询）：

- latest 版本：`1.0.0`，发布时间 `2026-06-13`（`time.modified: 2026-06-13T22:28:09.310Z`）
- 许可证：MIT
- unpackedSize：1,034,924 字节
- 周下载量：14,588（2026-08-23 ~ 2026-08-29）
- GitHub 仓库：319 stars，最近一次 push `2026-06-13`
- README 末节注明 “smplr is approaching 1.0; pre-1.0 APIs keep working as deprecated aliases.”

采样来源仓库 [sfzinstruments/SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano) README（2026-09-05 获取）原文：

> # Splendid Grand Piano
>
> Public Domain samples by AKAI
> This samples set was released as public domain in early 2000 by Akai company.
> It's a Steinway samples with 4 velocity layers.
> The version we put here is the 256 MB version.

## 5. SpessaSynth（SF2/DLS/MIDI 合成引擎）

- 主应用仓库：[https://github.com/spessasus/SpessaSynth](https://github.com/spessasus/SpessaSynth)
  （“MIDI SoundFont/DLS player and editor written in TypeScript.”）
- 核心库：[https://github.com/spessasus/spessasynth_core](https://github.com/spessasus/spessasynth_core)
  （“JavaScript MIDI + SoundFont/DLS Library”）
- 浏览器封装：[https://github.com/spessasus/spessasynth_lib](https://github.com/spessasus/spessasynth_lib)
  （README 均为 master 分支，2026-09-05 获取）

主应用 README 摘录：

> **SpessaSynth** is a SoundFont2-based real-time synthesizer written in TypeScript, previously pure JavaScript.

> ### SpessaSynth Project index
>
> - spessasynth_core - SF2/DLS/MIDI library
> - spessasynth_lib - spessasynth_core wrapper optimized for browsers and WebAudioAPI
> - SpessaSynth (you are here) - online/local MIDI player/editor application

> Features 中与可视化相关：
>
> - **Visualization of the played sequence:** with cool effects like visual pitch bend and note-on effects!
> - Comes bundled with a compressed GeneralUser GS SoundFont to get you started

> ## License
>
> Copyright © 2026 Spessasus
> Licensed under the Apache-2.0 License.

spessasynth_core README 摘录（引擎形态关键表述）：

> _A powerful multipurpose SF2/DLS/MIDI JavaScript library. It works with any modern JS environment that supports WebAssembly._
>
> ### Limitations
>
> - Audio engine is written in pure TypeScript, so it may not be as performant as native implementations
>
> #### TODO
>
> - Improve the performance of the engine
> - Potentially port the system to Emscripten

（即：合成引擎本体是纯 TypeScript 实现，非 wasm 合成器；要求 WebAssembly 环境主要用于 SF3 的 Vorbis 解码。）
README 同时注明 “No external dependencies: Only vorbis decoder for SF3 support!”。

> ### Powerful and Fast MIDI Sequencer
>
> - **Supports MIDI formats 0, 1, and 2:** _note: format 2 support is experimental as it's very, very rare._
> - **Smart preloading:** Only preloads the samples used in the MIDI file for smooth playback _(down to key and velocity!)_

spessasynth_lib README 摘录：

> It allows you to:
>
> - Play MIDI files using SF2/SF3/DLS files!
> - Read and write MIDI files!
>
> - **AudioWorklet synthesizer:**
>   - Runs in a **separate thread** for maximum performance!
>   - Does not stop playing even when the main thread is frozen!
> - **Web Worker synthesizer:** ...

> ```javascript
> import { WorkletSynthesizer } from "spessasynth_lib";
> const sfont = await (await fetch("soundfont.sf3")).arrayBuffer();
> const ctx = new AudioContext();
> // make sure you copied the worklet processor!
> await ctx.audioWorklet.addModule("./spessasynth_processor.min.js");
> const synth = new WorkletSynthesizer(ctx);
> await synth.soundBankManager.addSoundBank(sfont, "main");
> ...
> ```

spessasynth_lib `docs/sequencer/index.md` 摘录（位置与可视化相关，2026-09-05 获取）：

> ### currentTime
>
> The current playback time of the song in seconds. Can be set to seek to a specific position in the song.
>
> ### currentHighResolutionTime
>
> A smoothed version of currentTime. **Use for visualization** as it's not affected by the audioContext stutter.

> ### eventHandler
>
> Allows setting up custom event listeners for the sequencer.
> The event types match spessasynth_core's sequencer event types...

spessasynth_core `docs/spessa-synth-sequencer/event-types.md` 摘录（2026-09-05 获取）：

> ### timeChange
>
> Called when the time is changed. It also gets called when a song gets changed.
>
> - newTime: number - the new time in seconds.
>
> ### metaEvent
>
> Called when a MIDI Meta event is encountered. ...
>
> ### songChange / songEnded / loopCountChange ...

spessasynth_core `docs/spessa-synth-processor/event-types.md` 摘录（2026-09-05 获取）：

> ### `noteOn`
>
> - `midiNote`: `number` - the MIDI key number of the note that was pressed. Ranges from 0 to 127.
> - `channel`: `number` ...
> - `velocity`: `number` - the velocity of the note... Ranges from 0 to 127.
>
> ### `noteOff`
>
> - `midiNote`: `number` ...
>
> ### `controllerChange` / `programChange` ...

npm 注册表数据（2026-09-05 查询）：

- `spessasynth_core`：latest `4.3.22`，`time.modified: 2026-08-24T11:52:20.195Z`，Apache-2.0，
  unpackedSize 2,318,709 字节，周下载 7,665（2026-08-23 ~ 2026-08-29）
- `spessasynth_lib`：latest `4.3.14`，`time.modified: 2026-08-18T12:11:17.057Z`，Apache-2.0，
  unpackedSize 2,402,884 字节，周下载 5,904（2026-08-23 ~ 2026-08-29）
- GitHub：主应用 395 stars、push `2026-09-03`；core 65 stars、push `2026-09-02`

## 6. 浏览器自动播放策略参考

### 6.1 MDN《Autoplay guide for media and Web Audio APIs》

- 来源：[https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)（2026-09-05 获取）

> As a general rule, you can assume that media will be allowed to autoplay only if _at least one_ of the following is true:
>
> - The audio is muted or its volume is set to 0
> - The user has interacted with the site (by clicking, tapping, pressing keys, etc.)
> - If the site has been allowlisted...
> - If the autoplay Permissions Policy is used to grant autoplay support to an \<iframe\> and its document.
>
> Otherwise, the playback will likely be blocked.

> The [`Navigator.getAutoplayPolicy()`](...) method can be used to check the autoplay policy for a type of media feature (i.e., all media elements, or all audio contexts) in a document, or to check whether a specific media element or audio context can autoplay.

### 6.2 Chrome for Developers《Chrome 自动播放政策》博客

- 来源：[https://developer.chrome.com/blog/autoplay/](https://developer.chrome.com/blog/autoplay/)（2026-09-05 获取）

> 自 Chrome 71 起，Web Audio API 已纳入自动播放功能。……如果在文件接收使用者手势之前建立 `AudioContext`，则会以「已暂停」状态建立，您必须在使用者手势后呼叫 `resume()`。

> ```javascript
> document.querySelector('button').addEventListener('click', function () {
>   context.resume().then(() => {
>     console.log('Playback resumed successfully')
>   })
> })
> ```

> 如要侦测浏览器是否需要使用者互动才能播放音讯，请在建立 `AudioContext.state` 后检查该值。如果允许播放，则应立即切换为 `running`。否则为 `suspended`。

## 7. smplr 采样集成方式与采样来源许可（补充摘录，2026-09-05 获取）

### 7.1 smplr README 关于采样托管与加载（来源：https://github.com/danigb/smplr）

> Samples are stored at https://github.com/smpldsnds and there is no need to download them.

（即：默认采样集托管在 `smpldsnds.github.io`（GitHub Pages），运行时按需拉取。）

> The default sample sets are hosted on GitHub Pages, which rate-limits requests per second. That can be a problem, especially in a development environment with hot reload (most React frameworks).
>
> To cache samples in the browser, use a `CacheStorage` object:
> ... First time the instrument loads, will fetch the samples from http. Subsequent times from cache.

> ⚠️ `CacheStorage` is based on the Cache API and only works in secure environments that run over `https`.

`SplendidGrandPiano` 构造选项原文：

> - `baseUrl`: where the piano samples are fetched from. Defaults to the public hosted set on `smpldsnds.github.io`; override only if you mirror the samples yourself.
> - `notesToLoad`: an object with the following shape: `{ notes: number[], velocityRange: [number, number]}` to specify a subset of notes to load

`SplendidGrandPiano` 音色说明原文：

> A sampled acoustic piano. It uses Steinway samples with 4 velocity groups from SplendidGrandPiano

库本体许可：MIT（README 末尾 "## License MIT License"）。

采样 URL 拼接方式（源码 `src/smplr/sample-loader.ts`，node_modules 内 1.0.0 实测，2026-09-05）：

> ```ts
> const format = findFirstSupportedFormat(json.samples.formats) ?? json.samples.formats[0] ?? "ogg";
> const base = json.samples.baseUrl.replace(/\/$/, "");
> const names = collectSampleNames(json);
> ...
> const path = json.samples.map?.[name] ?? name;
> const url = `${base}/${path}.${format}`;
> ```

即：URL 由 `baseUrl + 采样名 + 扩展名` 直接拼接，**采样名不做 URL 编码**；`formats`
按浏览器支持顺序选择（Safari 跳过 ogg）。该行为的工程影响见 research 文档
`20260905-packaging-and-licensing.md` §3.1（此处仅收录事实）。

### 7.2 采样上游仓库 sfzinstruments/SplendidGrandPiano README 许可声明

（来源：https://github.com/sfzinstruments/SplendidGrandPiano ，README 2026-09-05 获取）

> # Splendid Grand Piano
>
> Public Domain samples by AKAI
>
> This samples set was released as public domain in early 2000 by Akai company.
> It's a Steinway samples with 4 velocity layers.
> The version we put here is the 256 MB version.
> All samples has been properly fixed and converted to flac, and mapped to SFZ format with ARIA extensions by kinwie.

> - 5th layer added at lowest velocity using filter cutoff.

（即：上游声明采样为 AKAI 于 2000 年代初以公有领域（Public Domain）发布；原始采样 4 个力度层，
上游 SFZ 另用低通滤波合成出最弱力度层作为"第 5 层"。）

---

## 附：数据获取方式说明

- npm 版本/时间/许可/体积：`registry.npmjs.org` 与 `npm view`（2026-09-05）。
- npm 周下载量：`api.npmjs.org/downloads/point/last-week/<pkg>`，统计区间 **2026-08-23 ~ 2026-08-29**。
- GitHub 仓库活跃度/许可：GitHub REST API（2026-09-05）。
- SMF 规范：midi.org 页面提供的官方 PDF（`RP-001_v1-0_Standard_MIDI_Files_Specification_96-1-4.pdf`，
  由 [https://midi.org/standard-midi-files](https://midi.org/standard-midi-files) 的 Google Drive 链接下载）。
- Tonejs/audio 仓库 salamander 采样大小：GitHub Git Trees API（recursive），按 blob size 求和。
- smplr 托管采样单文件大小：对 `smpldsnds.github.io` 发起 HTTP HEAD 请求实测。
