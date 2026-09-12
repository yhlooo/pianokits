# 研究：MIDI 文件里踏板（CC）数据与音轨的关系

- 日期：2026-09-12
- 状态：**调查结论**（支撑设计 `docs/development/design/20260912-midi-pedal-lane-and-practice.md`）
- 参考：`docs/development/reference/midi/format-and-libraries.md`（§1.8 SMF 轨道/通道规范引文、
  §2.1.1 @tonejs/midi 对 CC 的处理源码）、`docs/development/research/20260912-web-midi-velocity-and-pedal.md`
  （踏板 = CC64/66/67、阈值 `>= 64` 为踩下）
- 外部资料获取日期：2026-09-12

## 1. 问题

瀑布流要画踏板轨道、练习模式要判定踏板，必须先回答：

- Q1：MIDI 文件里踏板事件（CC64/66/67）**属于音轨还是通道**？能否归属到某条练习轨？
- Q2：现有解析库（@tonejs/midi）到底暴露了什么？
- Q3：真实文件里踏板数据长什么样？
- Q4：归属规则应该定成什么，才能同时满足「分音轨就只判练习轨的踏板 / 不分音轨就全部判定」？

## 2. Q1 规范层：CC 是**通道消息**，轨道只是容器

SMF 规范（引文见参考文档 §1.8）明确：

1. **一条 MTrk 可以装最多 16 个通道的事件**：
   > A track chunk contains a sequential stream of MIDI data which may contain information for up to
   > 16 MIDI channels.
2. **轨道里的事件就是 MIDI 通道消息**，而通道号写在状态字节里（CC 为 `1011nnnn`）：
   > `<MIDI event>` is any MIDI channel message.
3. Format 0 被描述为 **single multi-channel track**；Format 1 是 “a collection of tracks”。
   即「轨道」是组织/时间流单位，「通道」才是发声单元。
4. **MIDI Channel Prefix（FF 20 01 cc）** 元事件的存在本身即证据：它用来把「通道」关联给后续事件；
   规范还专门提示 “If MIDI channels refer to ‘tracks’, this message may help jam several tracks into a
   format 0 file”——规范假定「通道」与「轨道」是两个独立维度。

**结论 C1**：踏板事件在格式层面属于**通道**，不属于轨道。同一轨里可以有多个通道的踏板事件，
同一通道的踏板事件也可以分散在多条轨里。**「踏板分不分音轨」在文件格式层面没有定义**，
完全取决于文件作者/DAW 的排布方式。

## 3. Q2 库层：@tonejs/midi 拿不到 CC 的真实通道

源码摘录（参考文档 §2.1.1）：

- `Track.channel` 由轨内 **noteOn** 推导（取最后一个 noteOn 的通道），**CC 不参与**；无音符轨恒为 0；
- `ControlChange` 只有 `number / ticks / time / value`，**没有 channel 字段**——`midi-file` 解析出的
  `channel` 在 `addCC()` 时被丢弃；
- CC 的值被归一化为 0–1（`value / 127`），写出时再乘回 127。

**结论 C2**：用 @tonejs/midi 时，踏板的通道只能用「该轨的 `Track.channel`」近似，且只有
**轨内有音符**时才可信；纯 CC 轨（控制轨）一律报 0，无法区分它实际属于哪个通道。

## 4. Q3 实测：真实文件里踏板常常「多轨同通道、只落在一轨」

用 `scripts/inspect-midi.mjs`（@tonejs/midi，2026-09-12；调查时为本仓库样本手工脚本）检查本仓库样本：

| 文件                        | 轨数 | 各轨通道 | 踏板事件                                                      |
| --------------------------- | ---- | -------- | ------------------------------------------------------------- |
| `.tmp/梦中的婚礼.mid`       | 2    | 都是 0   | **CC64 共 204 条全部在第 2 轨**（460 个音符）；第 1 轨无 CC64 |
| `.tmp/pianokits-6track.mid` | 6    | 都是 0   | 无踏板 CC                                                     |
| `.tmp/pianokits-ui.mid`     | 2    | 都是 0   | 无踏板 CC                                                     |
| `.tmp/align-probe.mid`      | 2    | 都是 0   | 无踏板 CC                                                     |

`梦中的婚礼` 是典型的「分手导出」形态：左右手各一轨、**都在通道 0**，踏板 CC 只落在其中一轨。
此时：

- 按**轨**归属 → 练另一只手（第 1 轨）时完全看不到踏板，与听感不符（MIDI 播放时 CC64 影响同通道的
  全部音符，两只手都该踩踏板）；
- 按**通道**归属 → 两轨共享通道 0 的踏板，与实际发声一致。

**结论 C3**：实际文件中最常见的两种排布是「多轨同通道、踏板只在一轨」与「一轨一通道、踏板随声部」；
按通道归属对两者都成立，按轨道归属会在第一种形态下判断失真。

## 5. Q4 本项目采用的归属规则

踏板归属 = **通道**；练习判定范围按下面的规则收敛（`pedals.ts` 纯函数，设计文档 §3.3）：

```
pedalChannels = { 出现踏板事件的轨的 Track.channel }
noteChannels  = { 有音符的非打击乐轨的 Track.channel }
if pedalChannels ⊆ noteChannels:
    按通道归属：练习轨集合 P 的判定通道 = pedalChannels ∩ channels(P)
else:
    全曲踏板（不分音轨）：所有通道的踏板都参与判定
```

理由：

1. **与 MIDI 播放语义一致**：CC64 只影响同通道的音符，跨通道的踏板本就不该被要求（例如
   钢琴轨 ch0 的踏板不应要求弦乐轨 ch1 弹奏者去踩）；
2. **覆盖实测形态 C3**：同通道多轨共享踏板（分手练习的任一只手都能看到并判定踏板）；
3. **纯控制轨退化为「全部判定」**：当踏板事件落在无音符轨上时（@tonejs/midi 无法给出可信通道，
   C2），说明它不属于任何具体声部，按「不分音轨 → 都需要判定」处理，正是用户要求的口径；
4. **无交集即无要求**：练习轨通道与本曲踏板通道无交集时，该轨没有踏板需要判定（这条声部本来
   就没有踏板），不会把「没有踏板数据」误判成「必须踩踏板才能过」。

### 已知偏差（接受）

- 轨内**多通道**的单轨文件（罕见）里，`Track.channel` 只反映最后一个 noteOn 的通道，归属可能偏差；
  不为它引入第二套解析（直接用 `midi-file` 重解析整个文件）——收益极小、双解析路径的维护成本更大；
- `@tonejs/midi` 丢弃 CC 通道是库的既有限制；本项目的领域模型保留 `trackIndex + channel` 两个字段，
  将来若换用直读解析器，归属规则无需改动。

## 6. 踏板事件的时值（踩下区间）与值域

- **踩下判读**：`value >= 64`（与 MIDI 1.0 附录、`quantize.ts` 的 `buildSustainIntervals()` 同阈值，
  见 `20260912-web-midi-velocity-and-pedal.md` §3.1）；
- **时值**：同一踏板（同通道）上「踩下 → 抬起」构成一个区间；重复踩下（未抬起又踩）忽略；
  文件结束时仍未抬起的踏板视为持续到曲终（`end = Infinity`）；
- **值域 bug（本次实测发现）**：`parse.ts` 过去把 @tonejs/midi 的**归一化值 0–1** 直接写进
  `SustainEvent.value`（模型注释与 `quantize.ts` 阈值都按 0–127），导致 `value >= 64` 恒为假、
  记谱的「踏板延长长音」实际从未生效（实测 `梦中的婚礼.midi` 的 CC64 值为 0/1，而非 0/127）。
  本次改为 `Math.round(value * 127)`，顺带修复（设计文档 §3.2）。
