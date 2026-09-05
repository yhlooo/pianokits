# 调查：MIDI 文件是否区分钢琴左手/右手（高低音区）（2026-09-05）

> 调查日期：2026-09-05。本文是研究结论文档；文中引用的外部事实均摘录在
> [参考文档](../reference/midi/piano-hand-information.md)（下称“参考文档”），关键处标注来源 URL。
> 本次调查为架空研究：不涉及本项目代码改动，结论仅用于厘清 MIDI 格式的能力边界。

## 1. 结论摘要（TL;DR）

**直接回答：MIDI 文件不区分、也无法自描述“左手 / 右手”，同样不标记“高音区 / 低音区”。**

- MIDI（SMF 1.0、General MIDI、以及 MIDI 2.0 公开概览）中**不存在任何与“手”或“声区”相关的字段**：音符事件只携带 时间、通道、音符号（key）、力度（velocity）等；SMF 的全部 meta 事件（曲名、歌词、速度、拍号、调号……）里也没有手部信息。官方规范 RP-001 全文检索 “hand” 只有一句习语 “on the other hand”（参考文档 §1.1、§1.2）。
- “高音区 / 低音区”同样不是 MIDI 概念：音区只能由**音高**（MIDI key number，GM 规定 Middle C = 60）换算得出；而“右手 ≈ 高音区、左手 ≈ 低音区”只是钢琴演奏与记谱的**惯例**（大谱表上谱表归右手、下谱表归左手），既非必然（交叉手、右手跨到低音区很常见），也未被任何格式标准化。问题中“高音区（左手）、低音区（右手）”的对应关系应为“高音区（右手）、低音区（左手）”，结论不受影响。
- 实践中的“左右手信息”只有四种**非标准**的存在方式，都不能保证可用、都不能互操作：
  1. **分轨约定**：一条 MIDI 轨道 = 一只手。记谱软件导出时的行为（MuseScore：每谱表一轨）；但没有规范规定轨道语义，也常见单轨混排（见 Stack Overflow 实例）。
  2. **分通道约定**：左右手放不同 MIDI 通道。Yamaha 教学生态即如此，但“哪个通道是哪只手”依赖市售歌曲数据的预编程 + 设备端设置（CVP 的 Right Ch/Left Ch/Part Ch，默认提示 Right=Ch1、Left=Ch2），设备手册证明这**不是文件自描述**。
  3. **音高启发式**：消费方自己猜（MuseScore 导入时的动态规划拆分、Synthesia 的手动/半自动分割线）。这是算法推断，错误不可避免。
  4. **旁路元数据文件**：如 Synthesia 的 `.synthesia`（逐音符标注 L/R/B）。它的存在本身就是“MIDI 里没有”的旁证。
- 学术研究同样把“手部分配”当作**必须从音符序列推断的潜变量**（Nakamura 等的 merged-output HMM，η_n ∈ {L, R}，参考文档 §7）。
- 更“结构化”的记谱格式也没有标准化的手部字段可对照：MusicXML 4.0 无 `hand` 元素（左右手由 staff/voice 结构隐含）；MEI 的 “hand” 指抄写者笔迹（参考文档 §8）。

**一句话**：MIDI 只记录“什么音、多响、多长、在哪条轨道/通道”，不记录“谁来弹（哪只手）”和“算哪个声区”。任何左右手/音区的区分都必须由制作方用非标准约定暗示，或由消费方事后推断。

## 2. 问题澄清与术语

1. **“左手 / 右手”**：演奏手，MIDI 无此维度。
2. **“高音区 / 低音区”**：由音高推导的模糊地带，MIDI 无“声区”标记；音区边界本身就是人为约定（例如常见的“中央 C 为界”也只是一个惯例）。
3. **钢琴谱惯例**：大谱表两行谱表，通常右手弹上谱表（高音）、左手弹下谱表（低音）。这是记谱/演奏惯例，MIDI 文件导出时该惯例**可能**体现为两条轨道或两个通道，也可能完全丢失（合并成单轨）。

## 3. 规范层面的证据（为什么“没有”）

依据参考文档 §1、§2、§8.3：

- **SMF 1.0（RP-001）**：文件结构 = 头块 + 轨道块；轨道 = 变长 delta-time + 事件。事件种类仅三类：MIDI 通道消息（note on/off、program change 等，载荷为通道/音符号/力度）、meta 事件（FF 01 文本、FF 03 轨道名、FF 04 乐器名、FF 51 速度、FF 58 拍号、FF 59 调号、FF 7F 厂商自定义……）、sysex。**全部事件类型中没有“手”**。轨道名/乐器名是自由文本，规范不规定内容——手部信息理论上只能靠“民间给轨道起名 RH/LH”这类非标准写法传递，而规范不背书任何命名约定。
- **General MIDI Level 1（RP-003）**：只规定音色映射（program 1 = Acoustic Grand Piano）、通道 10 打击乐、Middle C = key 60 等；全文 “hand” 仅出现于打击乐音色名 “Hand Clap”。**没有手部/声部约定**。
- **MIDI 2.0（Wikipedia 概览）**：新特性为更高精度、更多控制器、UMP、Property Exchange 等，概览正文 “hand” 出现 0 次（未逐本核对 M2 规范全文，见 §7）。

**推论**：凡是声称“从 MIDI 文件读出手部信息”的软件，读到的都不是标准字段，而是某个特定来源文件的非标准约定，或自己推断的结果。

## 4. 实践中的四种“间接约定”及可靠性

| 方式                          | 谁在用 / 实例（来源）                                                                                                                         | 可靠性                                             | 备注                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| **分轨**（一手一轨）          | MuseScore MIDI 导出按“每谱表一轨”组织（源码注释 “assume every staff corresponds to a midi track”，参考文档 §3.2）                             | 仅对“按谱表导出的”文件成立；许多文件单轨混排双手   | 轨道语义无标准；两条同名轨道（如都叫 Piano）也常见       |
| **分通道**（一手一通道）      | Yamaha 教学生态：市售 song data 预编程左右手通道；CVP 设备用 Right Ch/Left Ch/Part Ch（默认提示 Ch1/Ch2）消费（§4）                           | 仅对特定厂商的预编程文件成立；通道映射需设备端设置 | 最接近“约定俗成”的生态，但仍非文件自描述；换来源即失效   |
| **音高启发式**（事后推断）    | MuseScore MIDI 导入（`importmidi_lrhand.cpp` 动态规划拆分，仅对大谱表类音色、且和弦跨度 > 1 八度时启用，§3.1）；Synthesia 的 Split 工具（§5） | 无保证：交叉手、双手交替跑动等都会判错             | 各家算法不同、阈值不同，结果不可互换                     |
| **旁路元数据文件**            | Synthesia `.synthesia`（逐音符 L/R/B 标注，§5）                                                                                               | 对该软件可靠；MIDI 文件本身依旧没有                | 厂商专属格式，其他软件不识别                             |
| （附）**轨道名文本**（FF 03） | 自由文本，规范不规定写法（§1.2）                                                                                                              | 不保证存在、不保证统一写法                         | 只能“碰运气”识别；本次调查未找到任何定义该命名约定的规范 |

**关键佐证一**（Yamaha 手册，参考文档 §4）：CVP 参考手册明确说 Auto Set 开启时“MIDI 通道……自动根据**市售歌曲数据中的预编程**设定”——即手部通道信息存在于**歌曲数据的制作约定**里，不在 MIDI 格式里；并且设备还提示用户“把 Right 通道设为 Ch1、Left 通道设为 Ch2”以备预编程不符时手工修正。

**关键佐证二**（Synthesia 官方指南，参考文档 §5）：“Most MIDI editors focus on the final output quality of the sound. So the internal grouping of notes is often overlooked, combining the piano into a single part.”——第一方声明：多数 MIDI 文件根本不保留双手分组。

**关键佐证三**（Dorico 官方论坛，参考文档 §6）：产品负责人 dspreadbury 的回答表明，Dorico 中左右手是“声部（voice）”，**只有用户手动把各手声部指派到不同通道，导出的 MIDI 才会保留分通道**；且有用户反馈多声部导出成 4 条轨道的困惑——进一步说明通道/轨道语义全靠制作方临时配置。

**关键佐证四**（MuseScore 源码，参考文档 §3.1）：MuseScore 导入时“识别左右手”的行为是 `LRHand::needToSplit` + 动态规划启发式，输入只有音符音高/时值/音色 program——证明该软件**自己也认为**文件里没有手部信息，需要“算”出来。

## 5. 各软件行为对比（由参考文档事实汇总）

| 软件 / 设备         | 导入（识别手）                                         | 导出（保留手）                                         |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| MuseScore           | 启发式自动拆分为两条谱表（仅大谱表类音色、特定条件下） | 每谱表一条 MIDI 轨道（双手自然分轨）                   |
| Dorico              | 手 = 声部（voice）                                     | 仅当用户把手部声部手动指派到独立通道后才保留分通道     |
| Yamaha CVP 教学功能 | 靠 Right Ch/Left Ch/Part Ch 设置 + 歌曲数据预编程      | （教学文件由厂商预编程制作）                           |
| Synthesia           | 用户用手动分割线（Split From Here）标注                | 标注存于 `.synthesia` 旁路文件，MIDI 不变              |
| 一般 DAW/编辑器     | —                                                      | 多按“音轨→MIDI 轨道”直出，双手分组随制作工程而定或丢失 |

模式一致：**没有一个参与者把“手”当作 MIDI 的固有属性，全部把它当作外部约定或推断结果。**

## 6. 对“如果一定要在 MIDI 中表达手部信息”的结论

- **没有标准做法**。现实可选项只有：a) 分轨/分通道（配合轨道名 FF 03 文本标注，如 RH/LH），b) 消费端启发式（音高阈值或动态规划），c) 旁路元数据文件。
- 三者都需要接受“不可互操作/会出错”的代价；对教学类应用，通行做法是 b + 用户手工校正（Synthesia 模型），或 a + 设备端配置（Yamaha 模型）。
- 本项目（pianokits）若未来需要“左右手分色/分轨”类功能，这一格式事实决定了只能走上述路线之一，**不能指望 MIDI 文件自带该信息**。（此为对调查结论的顺势推演，不构成本次的设计决策。）

## 7. 不确定项（如实记录）

- MIDI 2.0 的结论基于 Wikipedia 概览条目（正文 “hand” 0 次），未逐一核对 M2-100/M2-104 等规范全文。
- MusicXML 结论基于 4.0 元素索引的全文检索（无 hand 元素），未逐属性核对 XSD；不排除个别属性有手部语义，但即使有也属 MusicXML 而非 MIDI。
- Yamaha 手册为德文版官方 PDF；英文版未获取（事实不影响，引文已附中译）。
- musescore.org 官方 handbook 页面因 Cloudflare 拦截未能获取，MuseScore 相关事实以官方源码（`main` 分支，2026-09-05）为准。
- Synthesia 支持指南与 Steinberg 论坛页面经第三方转码代理获取，个别标点可能失真；Synthesia wiki 为 GitHub raw 原文。
- “民间以轨道名 RH/LH 标注双手”为已知现象，但本次调查未找到任何规范或权威文档定义该写法，故未将其列为可依赖约定。

## 8. 参考

- 外部资料摘录与全部来源 URL：见 [参考文档](../reference/midi/piano-hand-information.md)（获取日期 2026-09-05）。
- 核心来源：
  - SMF 1.0 官方规范：[https://midi.org/standard-midi-files](https://midi.org/standard-midi-files)
  - CCARH SMF 结构概要：[http://www.ccarh.org/courses/253/handout/smf/](http://www.ccarh.org/courses/253/handout/smf/)
  - General MIDI Level 1（RP-003）：[https://midi.org/general-midi-level-1](https://midi.org/general-midi-level-1)
  - MuseScore 源码：[https://github.com/musescore/MuseScore](https://github.com/musescore/MuseScore)（`importmidi_lrhand.cpp`、`importmidi.cpp`、`exportmidi.cpp`）
  - Yamaha CVP-609/605 参考手册（德文）：[https://usa.yamaha.com/files/download/other_assets/1/328771/cvp609_de_rm_b0.pdf](https://usa.yamaha.com/files/download/other_assets/1/328771/cvp609_de_rm_b0.pdf)
  - Synthesia Hand Parts wiki：[https://github.com/Synthesia-LLC/metadata-editor/wiki/Hand-Parts](https://github.com/Synthesia-LLC/metadata-editor/wiki/Hand-Parts)；Splitting the piano part 指南：[https://synthesiagame.com/support/guide/AssignHands](https://synthesiagame.com/support/guide/AssignHands)
  - Dorico 官方论坛：[https://forums.steinberg.net/t/export-grand-staff-piano-as-separate-midi-parts/158067](https://forums.steinberg.net/t/export-grand-staff-piano-as-separate-midi-parts/158067)
  - Nakamura et al., Statistical Piano Reduction Controlling Performance Difficulty：[https://ar5iv.labs.arxiv.org/html/1808.05006](https://ar5iv.labs.arxiv.org/html/1808.05006)
  - MusicXML 4.0 元素索引：[https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/)
  - MEI Guidelines v5：[https://music-encoding.org/guidelines/v5/elements/note.html](https://music-encoding.org/guidelines/v5/elements/note.html)
  - Wikipedia MIDI 2.0：[https://en.wikipedia.org/wiki/MIDI_2.0](https://en.wikipedia.org/wiki/MIDI_2.0)
  - Stack Overflow 78544660：[https://stackoverflow.com/questions/78544660/how-can-i-access-right-and-left-hands-of-piano-midi-track-separately-with-python](https://stackoverflow.com/questions/78544660/how-can-i-access-right-and-left-hands-of-piano-midi-track-separately-with-python)
