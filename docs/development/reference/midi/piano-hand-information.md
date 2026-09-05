# MIDI 中“手 / 声部 / 音区”信息的外部资料摘录

> 本文件是参考文档：内容为外部资料（官方规范、软件源码、产品手册、官方文档、学术论文）的直接摘录，不做主观加工。
> 所有资料的获取日期为 **2026-09-05**。调查主题：MIDI 文件是否区分（或能否表达）钢琴左右手 / 高低音区。
> 调查结论见研究文档 [20260905-midi-piano-hand-separation.md](../research/20260905-midi-piano-hand-separation.md)。

## 1. SMF（Standard MIDI File）1.0 官方规范（RP-001）

- 来源：MIDI Manufacturers Association《Standard MIDI Files 1.0》(RP-001, Revised February 1996)。
- 页面：[https://midi.org/standard-midi-files](https://midi.org/standard-midi-files)；PDF 由该页面提供的 Google Drive 链接
  `RP-001_v1-0_Standard_MIDI_Files_Specification_96-1-4.pdf` 下载（2026-09-05 获取）。

### 1.1 全文检索结果：“hand” 仅出现一次，且为惯用语

规范正文中 “hand” 一词只出现在一处，且是习语 “on the other hand”（另一方面），与左右手无关：

> A Format 0 file has a header chunk followed by one track chunk. ... On the other hand, perhaps someone will write a format conversion from format 1 to format 0 which might be so easy to use in some setting that it would save you the trouble of putting it into your program.

规范全文同样没有 “left hand”“right hand”“voice”（声部）等概念。

### 1.2 规范定义的 Meta 事件全集（FF 00–FF 7F 中有定义的）

> Meta-events initially defined include:
>
> - **FF 00 02 ssss** Sequence Number — This optional event, which must occur at the beginning of a track, ... specifies the number of a sequence. ...
> - **FF 01 len text** Text Event — Any amount of text describing anything. ...
> - **FF 02 len text** Copyright Notice
> - **FF 03 len text** Sequence/Track Name — If in a format 0 track, or the first track in a format 1 file, the name of the sequence. Otherwise, the name of the track.
> - **FF 04 len text** Instrument Name — A description of the type of instrumentation to be used in that track. May be used with the MIDI Prefix meta-event to specify which MIDI channel the description applies to, or the channel may be specified as text in the event itself.
> - **FF 05 len text** Lyric
> - **FF 06 len text** Marker
> - **FF 07 len text** Cue Point
> - **FF 20 01 cc** MIDI Channel Prefix — The MIDI channel (0-15) contained in this event may be used to associate a MIDI channel with all events which follow... This capability is also present in Yamaha's ESEQ file format.
> - **FF 2F 00** End of Track
> - **FF 51 03 tttttt** Set Tempo
> - **FF 54 05 hr mn se fr ff** SMPTE Offset
> - **FF 58 04 nn dd cc bb** Time Signature
> - **FF 59 02 sf mi** Key Signature
> - **FF 7F len data** Sequencer-Specific Meta-Event — Special requirements for particular sequencers may use this event type: the first byte or bytes of data is a manufacturer ID (these are one byte, or, if the first byte is 00, three bytes). ...

（列表中没有与“手”“声部”“音区”有关的任何事件；FF 03/FF 04 为自由文本，规范不规定其内容格式。）
（注：本节引文为 PDF 文本提取结果，已修正断行空白等提取伪影，未改动字句。）

### 1.3 轨道块与音符事件的组成（CCARH 补充说明）

来源：CCARH（Stanford）《Outline of the Standard MIDI File Structure》，
[http://www.ccarh.org/courses/253/handout/smf/](http://www.ccarh.org/courses/253/handout/smf/)（2026-09-05 获取）。

> track_event = \<v_time\> + \<midi_event\> | \<meta_event\> | \<sysex_event\>
>
> - **\<v_time\>** a variable length value specifying the elapsed time (delta time) from the previous event to this event.
> - **\<midi_event\>** any MIDI channel message such as note-on or note-off. Running status is used in the same manner as it is used between MIDI devices.
> - **\<meta_event\>** an SMF meta event.
> - **\<sysex_event\>** an SMF system exclusive event.

同一页面给出的 meta event 类型清单：

> | Type | Event                  | Type | Event                          |
> | ---- | ---------------------- | ---- | ------------------------------ |
> | 0x00 | Sequence number        | 0x20 | MIDI channel prefix assignment |
> | 0x01 | Text event             | 0x2F | End of track                   |
> | 0x02 | Copyright notice       | 0x51 | Tempo setting                  |
> | 0x03 | Sequence or track name | 0x54 | SMPTE offset                   |
> | 0x04 | Instrument name        | 0x58 | Time signature                 |
> | 0x05 | Lyric text             | 0x59 | Key signature                  |
> | 0x06 | Marker text            | 0x7F | Sequencer specific event       |
> | 0x07 | Cue point              |      |                                |

（MIDI channel message 本身只携带 通道/音符号/力度 等信息，即 MIDI 1.0 的 Note On/Off 等 7 类通道消息，不含手或声部字段。）

## 2. General MIDI System Level 1 官方规范（RP-003）

- 来源：MIDI Manufacturers Association《General MIDI System Level 1 Specification》(RP-003, Revised 1996)。
  PDF（Google Drive 公开链接，2026-09-05 获取）。全文检索 “hand”：仅出现一次，为打击乐音色名 “Hand Clap”（拍手声）。

> MIDI Channels Supported:
>
> - All 16 MIDI channels.
> - Each channel can play a variable number of voices (polyphony).
> - Each channel can play a different instrument (timbre).
> - Key-based Percussion is always on channel 10.

> Note on/Note off:
>
> - Octave Registration: Middle C = MIDI Key 60 (3CH)
> - All voices, including percussion, respond to velocity

> 1.
>
> Acoustic Grand Piano &nbsp; 33. Acoustic Bass

（以上为 PDF 文本提取对 GM Sound Set 双列表格的拼接结果：program 1 = Acoustic Grand Piano。）

（GM 只定义音色（program，钢琴 = program 1）与通道 10 打击乐约定；对“哪只手/哪个声区”无任何定义。）

## 3. MuseScore 源码摘录（左/右手由软件启发式推断）

- 来源：GitHub 仓库 [musescore/MuseScore](https://github.com/musescore/MuseScore)，`main` 分支，2026-09-05 获取。

### 3.1 MIDI 导入：`src/importexport/midi/internal/midiimport/importmidi_lrhand.cpp`

> ```cpp
> namespace mu::iex::midi {
> namespace LRHand {
> bool needToSplit(const std::multimap<ReducedFraction, MidiChord>& chords,
>                  GM1Program midiProgram,
>                  bool isDrumTrack)
> {
>     if (isDrumTrack || !MChord::isGrandStaffProgram(midiProgram)) {
>         return false;
>     }
>     const int octave = 12;
>     for (const auto& chord: chords) {
>         ...
>         if (maxPitch - minPitch > octave) {
>             return true;
>         }
>     }
>     return false;
> }
> ```

（即：仅当轨道是“大谱表（grand staff）类”GM1 音色（含原声钢琴等键盘/竖琴类音色，见 `importmidi_chord.cpp` 的 `isGrandStaffProgram`，列表含 AcousticGrandPiano … OrchestralHarp、SynthStrings1/2 等）、且存在跨度超过 1 个八度的和弦时，才对该轨启用左/右手拆分。）

拆分算法为动态规划，按“惩罚最小”在相邻和弦间选择切分点，切分点左侧音符归左手、右侧归右手：

> ```cpp
> struct SplitTry {
>     int penalty = 0;
>     // split point - note index, such that: LOW part = [0, split point)
>     // and HIGH part = [split point, size)
>     // if split point = size then the chord is assigned to the left hand
>     int prevSplitPoint = -1;
> };
> ```

惩罚项（`findPitchWidthPenalty`、`findSimilarityPenalty`、`findDurationPenalty`、`findNoteCountPenalty`）基于：两侧音域的宽度（≤1 个八度不加罚）、与前一和弦切分点的相似性（八度/伴奏/单音旋律减罚）、音符时值是否一致、音符数量比例等——全部是**从音高与时序推导**，不使用任何文件内元数据。

调用处 `src/importexport/midi/internal/midiimport/importmidi.cpp`：

> ```cpp
> if (LRHand::needToSplit(mtrack.chords, mtrack.program, mtrack.mtrack->drumTrack())) {
>     midiImportOperations.data()->trackOpers.doStaffSplit.setValue(trackIndex, true);
> }
> ...
> LRHand::splitIntoLeftRightHands(tracks);
> ```

### 3.2 MIDI 导出：`src/importexport/midi/internal/midiexport/exportmidi.cpp`

> ```cpp
> //---------------------------------------------------
> //    write key signatures
> //    assume every staff corresponds to a midi track
> //---------------------------------------------------
> ```

轨道名来自谱表所属乐器：

> ```cpp
> //--------------------------------------------
> //    write track names
> //--------------------------------------------
> int staffIdx = 0;
> for (auto& track1: m_midiFile.tracks()) {
>     Staff* staff  = m_score->staff(staffIdx);
>     muse::ByteArray partName = staff->partName().toUtf8();
>     ...
>     ev.setMetaType(META_TRACK_NAME);
>     ...
>     ++staffIdx;
> }
> ```

（即 MuseScore 的 MIDI 导出按“一个谱表一条 MIDI 轨道”组织，钢琴大谱表因此导出为两条轨道；这只是该软件的导出策略，非文件格式要求。）

## 4. Yamaha CVP-609/605 参考手册摘录（教学功能的“手 → 通道”是设备设置项）

- 来源：Yamaha《CVP-609/605 Referenzhandbuch》（德文版官方参考手册），
  [https://usa.yamaha.com/files/download/other_assets/1/328771/cvp609_de_rm_b0.pdf](https://usa.yamaha.com/files/download/other_assets/1/328771/cvp609_de_rm_b0.pdf)（2026-09-05 获取）。
  以下为原文摘录（德文），附逐条中译。

Guide 功能详细设置中的 **Right Ch / Left Ch** 参数：

> Legt fest, welcher MIDI-Kanal in den MIDI-Song-Daten für den rechten und den linken Part benutzt wird. Diese Einstellung schaltet zurück auf „Auto“, wenn ein anderer Song ausgewählt wird.
>
> - **Auto**: Die MIDI-Kanäle der MIDI-Song-Daten für die Parts der linken und rechten Hand werden automatisch zugewiesen. Die Parts werden jeweils auf den Kanal festgelegt, der bei Part Ch im Song-Setting-Display (Seite 80) eingestellt wurde.
> - **1–16**: Weist einen angegebenen MIDI-Kanal (1–16) den Parts für die rechte und für die linke Hand zu.
> - **Off (nur Left Ch)**: Keine Kanalzuweisung. Dies schaltet die Notendarstellung für die linke Hand ein und aus.

（中译：设置 MIDI 歌曲数据中哪一个 MIDI 通道用作右手/左手声部；换歌时恢复 “Auto”。“Auto”：左右手声部的通道按 Song-Setting 中 Part Ch 设定的通道自动分配；“1–16”：手动指定通道；“Off”：不分配。）

**Part Ch**（歌曲设置）一节：

> **Right** — Legt fest, welcher Kanal dem Part für die rechte Hand zugewiesen ist.
> **Left** — Legt fest, welcher Kanal dem Part für die linke Hand zugewiesen ist.
> **Auto Set** — Wenn eingeschaltet („On“), werden die MIDI-Kanäle für die Parts der rechten und linken Hand automatisch entsprechend der Vorprogrammierung in den kommerziell erhältlichen Song-Daten festgelegt. Normalerweise sollte diese Option aktiviert sein („On“).

（中译：Right/Left 指定左右手声部使用哪个通道；Auto Set 开启时按“市售歌曲数据中的预编程”自动设定。）

Guide 灯说明中的提示（同手册）：

> HINWEIS: Wenn die Tastatur-LEDs nicht wie beabsichtigt leuchten, stellen Sie im „Part Ch“-Display den Right-Kanal auf „Ch1“ und den Left-Kanal auf „Ch2“ ein.

（中译：若键盘指示灯不按预期亮起，请在 Part Ch 界面将 Right 通道设为 Ch1、Left 通道设为 Ch2。）

另（同手册）：

> HINWEIS: Die Guide-Einstellungen können als Teil der Song-Daten gespeichert werden (Seite 70).

（中译：Guide 设置可以作为歌曲数据的一部分保存。）

（即：在 Yamaha 教学生态中，“哪个通道 = 哪只手”来自**市售歌曲数据的预编程 + 设备端用户设置**，不是 MIDI 文件格式的自描述信息。）

## 5. Synthesia 文档摘录（手部信息靠用户标注，存于专属元数据文件）

- 来源 1：Synthesia-LLC/metadata-editor 官方 wiki《Hand Parts》，
  [https://github.com/Synthesia-LLC/metadata-editor/wiki/Hand-Parts](https://github.com/Synthesia-LLC/metadata-editor/wiki/Hand-Parts)（2026-09-05 获取，GitHub wiki raw 原文）。

> In Synthesia's settings for a particular song, you can mark each part as being associated with the left hand, right hand, background notes, or some combination of each using the hand splitting tool. These steps give Synthesia fine-grained information about how every note in a song should be treated: played by the user, by Synthesia in the background, or not at all depending on which hand and mode the user selects.
>
> The metadata editor can extract this `Parts` information and store it in a .synthesia file so it can be shared with others. This allows third-party songs with more than two tracks to appear with the Melody/Rhythm/Recital buttons available immediately instead of requiring intervention from the user.

> Use `L`, `R`, `B`, `X`, or `-` to denote the "next" note belongs to the left hand, right hand, is a background note, should be discarded by Synthesia, or should not be changed ... respectively.
> ...
> The default track and measure (when left unspecified) are 0 and 1 respectively. ... **All notes default to `B` or "Background" notes.**

> Here is the `Parts` field for _Sevivon, Sov, Sov, Sov_, from G Major Music Theory:
>
> ```
> t1:RA t2:LA
> ```

- 来源 2：Synthesia 官方支持指南《Splitting the piano part》，
  [https://synthesiagame.com/support/guide/AssignHands](https://synthesiagame.com/support/guide/AssignHands)（2026-09-05 获取）。

> In this guide you'll learn how to split a single piano part into separate hands. This may be necessary when working with songs you found elsewhere or created yourself. **Most MIDI editors focus on the final output quality of the sound. So the internal grouping of notes is often overlooked, combining the piano into a single part.** Following this guide, you'll be able to practice each hand separately.

> A good first step is to split the entire song all at once. This will set most notes correctly and only small corrections will remain. Select the **Split From Here** tool from the menu. Click or tap near the middle of both hands. Adjust the split point until it looks fairly accurate.

## 6. Dorico 官方论坛回复摘录（左右手 = voice，导出分通道需手动配置）

- 来源：Steinberg 官方论坛《Export grand staff piano as separate MIDI parts?》，
  [https://forums.steinberg.net/t/export-grand-staff-piano-as-separate-midi-parts/158067](https://forums.steinberg.net/t/export-grand-staff-piano-as-separate-midi-parts/158067)（2026-09-05 获取）。

> **Derrek（版主）**: Normally the right and left hands on the piano are separate voices (turn on View > Note and Rest Colors > Voice Colors to see) which you can assign to separate MIDI channels in Play Mode.
>
> **dspreadbury（Daniel Spreadbury，Dorico 产品负责人）**: Yes, if you use independent voice playback you can assign the voices of each hand to separate channels, and that will be preserved when exporting MIDI.

后续跟帖：

> **Kekko38**: ... I have two voices in both the treble clef and the bass clef (piano piece). But Dorico then makes 4 different voices. How are there only 2 tracks?

## 7. 学术文献摘录（手部分配在研究中被视为需推断的未知量）

- 来源：Nakamura, E.; Benetos, E.; Yoshii, K.; Dixon, S.《Statistical Piano Reduction Controlling Performance Difficulty》(arXiv:1808.05006)，
  HTML 版 [https://ar5iv.labs.arxiv.org/html/1808.05006](https://ar5iv.labs.arxiv.org/html/1808.05006)（2026-09-05 获取）。

> A piano-score model with the left and right hand parts can be obtained by first constructing a model for each hand part and then combining the two models. **If musical notes are already assigned to two hand parts, such a combined model can be obtained directly. On the other hand, if the part assignment is not given, as in the piano reduction problem, the model should be able to describe the probability for all cases of part assignment.** Such a model for piano music with **unknown hand parts** can be constructed based on the merged-output HMM Nakamura2014 ; Nakamura2017TASLP .

> First, the hand part (left or right) associated with a note p_n is represented by an additional stochastic variable η_n ∈ {L, R}.

（引文中的数学符号按原文数学内容做了 Unicode 化（p_n、η_n ∈ {L, R}），非符号内容未改动。）

## 8. 其他格式对照

### 8.1 MusicXML 4.0：元素索引中不存在 “hand” 元素

- 来源：W3C 维护的 MusicXML 4.0 参考《Element Index》，
  [https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/)（2026-09-05 获取）。
  对元素索引做全文检索，“hand” 仅出现在打击乐元素名 `handbell`（手铃）中；索引中没有 “hand”/“left-hand”/“right-hand” 元素。
  （MusicXML 中钢琴左右手由 `<part>` 内的两条 `<staff>` 及 `<voice>` 结构隐含表达，无专用“手”字段。）

### 8.2 MEI（Music Encoding Initiative）v5：术语 “hand” 指抄写者笔迹

- 来源：MEI Guidelines v5 元素参考（`note` 等页面），
  [https://music-encoding.org/guidelines/v5/elements/note.html](https://music-encoding.org/guidelines/v5/elements/note.html)（2026-09-05 获取）。
  该页面中与 “hand” 相关的定义（`handList`/`handShift` 相关描述）：

> Marks the beginning of a passage written in a new hand, or of a change in the scribe, writing style, ink or character of the document hand.

（即 MEI 的 “hand” 是手稿学概念（抄写者笔迹），不是演奏的左右手。）

### 8.3 MIDI 2.0 概览（Wikipedia）

- 来源：[https://en.wikipedia.org/wiki/MIDI_2.0](https://en.wikipedia.org/wiki/MIDI_2.0)（2026-09-05 获取）。
  对该条目正文做全文检索：“hand” 出现 0 次。条目对 MIDI 2.0 新特性的概述：

> ... there were five components to MIDI such as; M2-100-U v1.0 MIDI 2.0 Specification Overview, M2-101-UM v1.1 MIDI-CI Specification, M2-102-U v1.0 Common Rules for MIDI-CI Profiles, M2-103-UM v1.0 Common Rules for MIDI-CI PE and M2-104-UM v1.0 UMP and MIDI 2.0 Protocol Specification. Other specifications regarding MIDI 2.0 include: allowing the use of 32,000 controllers and wide range note enhancements. These enhancements are made better through the property exchange.

（概览所列新特性为更高精度/更多控制器/UMP/Property Exchange 等，未见“手/声部”语义。注意：本结论基于该概览条目，未逐一核对 M2 系列规范全文，见研究文档“不确定项”。）

## 9. 社区提问实录（典型钢琴 MIDI 文件的“无手部信息”现象）

- 来源：Stack Overflow 问题 78544660《How can I access right and left hands of piano MIDI track separately with python?》，
  [https://stackoverflow.com/questions/78544660/...](https://stackoverflow.com/questions/78544660/how-can-i-access-right-and-left-hands-of-piano-midi-track-separately-with-python)（2026-09-05 经 Stack Exchange API 获取，提问正文摘录）。

> I'm exploring MIDI files with Python and MuseScore. When I open a MIDI file ... on MuseScore, I see that the piano track is automatically split into two staves: right and left hands. However when I print the MIDI file tracks in Python with mido or pretty_midi there is only one track with notes on it. My question is, how does MuseScore know which notes correspond to which hand if there seems to be nothing indicating it in the MIDI file?
>
> ... Track 0 has no notes on it, just defines the time signature and other global constants like ticks per beat. Track 1 has all the notes on it, but there seems to be nothing which notes correspond to what hand, yet I see that MuseScore recognizes it as a piano track with right and left hands separated. I know that it is an Acoustic Grand Piano track because of the program_change message. Maybe there some piece of information I can retrieve with mido that tells which notes correspond to what hand?

---

## 附：数据获取方式说明（2026-09-05）

- RP-001 / RP-003 官方 PDF：由 [midi.org](https://midi.org/standard-midi-files) 页面提供的 Google Drive 链接下载，`pdftotext` 提取文本后检索。
- CCARH 页面：`curl` 直接获取 HTML 原文。
- MuseScore 源码：GitHub raw（`main` 分支，`musescore/MuseScore` 仓库）。
- Yamaha 手册：`usa.yamaha.com` 官方 PDF（德文版 CVP-609/605 参考手册），`pdftotext` 提取。
- Synthesia wiki：GitHub wiki raw（`raw.githubusercontent.com/wiki/...`）；Synthesia 支持指南与 Steinberg 论坛：站点直接访问不可达（连接失败/反爬），经第三方阅读代理（r.jina.ai）转码获取，引文标点以原文为准。
- Stack Overflow：Stack Exchange API（questions/78544660, filter=withbody）；该问题截至获取时无回答。
- MusicXML 4.0 元素索引：W3C 官方页面全文检索。
- MEI Guidelines v5：官方页面全文检索。
- 注意：musescore.org 官方 handbook 页面因 Cloudflare 拦截（HTTP 403）未能直接获取，故 MuseScore 相关事实以官方源码为准。
