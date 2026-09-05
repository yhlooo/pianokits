# 设计：五线谱调号拟合与时值/符杠呈现（draft1）

- 日期：2026-09-05
- 状态：**草案（draft1）**，与实现同步演进；实现完成后转正式文档
- 关联：设计 `20260905-score-notation.draft1.md`（M2 记谱管线，本设计落实/调整其中
  §5.2 自适应量化、§5.5 拼写、§5.7 符杠的剩余事项）

## 1. 背景与根因

用 `.tmp/梦中的婚礼.mid`（G 小调，含 B♭/E♭ 大量出现）实测当前渲染，用户报告两类问题，
经源码与浏览器实测定位到四处根因：

### 1.1 全局调号缺失、黑键全写升号

记谱直接信任 MIDI 的 keySignature 元数据。该文件同一时刻塞了 10 个 keysig meta
（含 `Bb major` 与多个 `C major`），`activeAt` 在等时事件中取最后一个 → `sf=0`，
于是所有 E♭/B♭ 按 C 大调拼成 D♯/A♯（用户所说「升 2 / 升 6」）。其余两个关联缺
陷：`parse.ts` 将小调 meta 按同名大调折算（'Gm' → +1，应为关系大调 B♭ → −2）；
`score-view.ts` 给小调 keySpec 拼 `'m'`，而 VexFlow 的小调名按其自身调号定义
（'Bbm' = 5 降），语义不一致会画错。

### 1.2「音符没有时值」是渲染 bug（非量化问题）

`score-view.ts` 调用 `Beam.generateBeams()` 后**从未绘制生成的 Beam**。VexFlow 5
中音符一旦挂 `beam`，自身不再画符干/符尾（源码 `stavenote.js`：
`shouldRenderStem = hasStem() && !this.beam`），符干由 `beam.draw()` 负责。漏画
的净效果：所有八分/十六分音符变成无符干的裸符头，时值信息全部丢失。

### 1.3 无附点时值

`decomposeBeats` 只产出 4/2/1/0.5/0.25 五种时值。该曲时值直方图中 ≈0.71 拍
（附点八分，341/480 ticks）与 ≈1.42 拍（附点四分，683/480 ticks）非常密集，全部
被拆成「延音线粘连的八分+十六分」，满屏连线。

### 1.4 符杠整小节一把抓

默认 `(2/8)` 分组对小节内所有音符随意组合，跨延音线粘连，且对 3/8、5/8、7/8 等
拍号分组错乱（该曲恰有 4/4→3/4→7/8→3/8 变拍）。

## 2. 设计决策

### 2.1 全局调号：整曲调式拟合（`src/core/midi/key-detect.ts`）

不再依赖 MIDI keysig 元数据作为记谱调号，改为**时长加权音级直方图拟合**：

1. 全体非打击乐音符 → 时长加权（`ws = max(0.01, end-start)`）pitch-class 直方图；
2. 候选 `sf ∈ [-7, +7]` 逐一试拼写，代价 = Σ（权重 × 临时记号罚分）：调号未覆盖黑键
   记 1，与调号冲突的白键（需 `n` 还原号）记 1.5——`SIG_SHARP_PCS`/`SIG_FLAT_PCS`
   存的是「被改变的白键音级」，黑键覆盖判据为 `(pc±1) ∈ sigSet`；
3. 平手规则：`|sf|` 小优先；再以 Krumhansl–Schmuckler 24 调特征相关度定主音与
   模式，若最优调性的 sf 与最小代价 sf 的代价差 ≤ 容差（2 秒时值），按调性定 sf；
4. `confidence = (cost(0) - cost(best)) / cost(0)`，作为是否推翻元数据的判据。

**与元数据的冲突策略**（`quantize.ts#resolveKeysig`）：meta 缺失或与估计一致 →
用估计；冲突时估计置信度 ≥ `ESTIMATE_OVERRIDE_CONFIDENCE = 0.15` 用估计，否则信
meta。整曲使用**单一调号**（分段转调列为已知限制）。

`parse.ts` 同时修复：小调 meta 按关系大调折算（+3 半音后查大调名表）；同一时刻
多个 keysig meta 只保留最后一个。

### 2.2 附点时值分解（`quantize.ts#decomposeBeats`）

候选时值扩为 4 / 3（附点半）/ 2 / 1.5（附点四分）/ 1 / 0.75（附点八分）/ 0.5 /
0.25，规则：

- 拍点上优先最长合法时值（含附点半/附点四分，附点四分可占一拍半、允许越到下
  一拍中点，符合惯例）；
- **附点八分仅当其整体落在本拍内部时采用**（附点不越拍点），否则退化为八分 +
  十六分延音线；
- 八分需八分网格（0.5 拍）对齐，其余用十六分填补。

`beatBounds(numerator, denominator)` 统一提供小节内拍边界：简单拍按拍均等
（x/8 单位八分）；复合拍（x/8 分子为 3 的倍数）每 3 个八分一组；不规则拍
5/8 = 3+2、7/8 = 2+2+3 硬编码，余者按单位平均。它同时驱动时值分解与渲染端
符杠分组，保证两处拍结构一致。

渲染端 `pieceToDuration` 输出 `2d/4d/8d`；VexFlow 5 的 `StaveNote` 解析 `'d'`
后缀只影响 tick 值，**附点记号必须显式 `Dot.buildAndAttach([note], { all: true })`**
（参考 `easyscore.js` 内部用法）。

### 2.3 符杠按拍分组并真正绘制（`score-view.ts#buildVoice`）

- 不再调用 `Beam.generateBeams`；改为声部内按 `beatBounds` 分拍：同拍内连续的
  八分/十六分（含附点八/十六）组成 `new Beam(group)`；
- 延音线连接的片段（piece index > 0）与不可上符杠的音符是分组边界（符杠不穿
  越延音线/休止符/长音符）；
- `voice.draw()` 之后统一 `beam.setContext(ctx).draw()` —— 补上 1.2 中缺失的
  绘制调用；
- 符干方向：多声部小节内声部 0 朝上、其余朝下（VexFlow 惯例，`Beam` 构造须传
  `autoStem=false`）；单声部小节交给 `new Beam(notes, autoStem=true)`（按谱表
  中线自行判断）。

### 2.4 跨小节延音线

同一来源音符在小节边界被拆成相邻两个事件时，量化端标记
`NotatedEvent.tieNext: TieLink[]`（目标事件 id + 双方 keys 下标）与
`tiePrev: number[]`。渲染端按情况绘制：

- 目标事件在**同一系统**：画完整 `StaveTie`（前事件末片段 → 目标事件首片段）；
- 目标事件在**其它系统**（可能懒加载未渲染，不能引用其 StaveNote）：各画一段到
  小节线附近的**半边弧**（SVG quadratic Bézier，符干方向反向弯曲）；
- 和弦部分延续按 key 拼写逐一匹配（`used` 集合防重复）。

### 2.5 keySpec 一律用关系大调名

`score-view.ts#keySpec` 不再为小调拼 `'m'`：`SF_TO_KEYSPEC[sf]` 输出 'C'…'Bb'…，
只表达升降号数量（语义与本项目 `sf` 一致），避免 VexFlow 小调名的歧义。

### 2.6 小节布局：音符区等宽 + 记谱符号实测预留

原先每行把可用宽度均分为小节宽，导致行首小节（含谱号/调号/拍号）的音符区
更窄、音符显拥挤。改为：

- **全曲所有小节的「音符区宽度」（`measurePitch`）一致**，作为记谱外观的统一
  基准；
- 每列小节的**额外符号宽度**用探针 Stave 实测：以同样修饰符（谱号/调号/拍号
  组合）构造 `Stave`，比对 `getNoteStartX()` 相对空谱表的偏移（结果缓存到
  `prefixDeltaCache`）；同一列跨谱表取最大值，保证行内同列对齐；
- 小节列宽 = `measurePitch + 该列额外符号宽度`；
- 拍号在**变化处**一并重显（之前只在第 0 小节显示，变拍文件会丢拍号），变化处
  同样预留实测宽度。

## 3. 数据模型变更

```ts
// quantize.ts
interface TieLink {
  targetId: number
  fromKeys: number[]
  toKeys: number[]
}
interface NotatedEvent {
  /* …既有字段… */ tieNext?: TieLink[]
  tiePrev?: number[]
}

// key-detect.ts
interface KeyEstimate {
  sf: number
  mi: 0 | 1
  tonicPc: number
  confidence: number
}
function estimateKey(notes: Note[]): KeyEstimate
const ESTIMATE_OVERRIDE_CONFIDENCE = 0.15

// quantize.ts 新增导出
function beatBounds(numerator: number, denominator: number): number[]
function decomposeBeats(offset: number, total: number, bounds: readonly number[]): ScorePiece[]
```

`Measure.keysig` 与 `ScoreModel.displayKeysig` 改为**全曲统一调号**（不再逐小节
取 meta）。

## 4. 验证

- 单测（`key-detect.test.ts` / `quantize.test.ts`）：大小调内容 → sf 拟合、五音
  阶无歧义、meta 冲突策略（高置信覆盖 / 低置信回落）、附点分解表、拍边界表、
  跨小节 tie 标记（含和弦部分延续）。
- Playwright 实拍（`.tmp/`）：
  - 梦中的婚礼：行首谱号后 2 个降号；谱内 E♭/B♭ 无逐个记号（不再出现 D♯/A♯）；
    附点节奏显示附点；八分/十六分按拍成组且符干符杠可见；3/4、7/8、3/8 小节
    分组正确。
  - 回归：C 大调合成样例（`pianokits-ui.mid`）无多余调号、附点/符杠/延音线正常；
    6 轨样例多谱表正常。
- `pnpm typecheck` / `pnpm lint` / `pnpm test`（43 通过）/ `pnpm build` 全绿。

## 5. 已知限制（后续）

- 整曲单一调号，中途转调不检测（转调段会出现较多逐音记号）；
- 附点十六分（0.375 拍）受 1/16 量化网格限制不会出现，不处理；
- 三连音/连音检测、`@tonaljs` 和声上下文拼写仍按计划后续推进；
- 跨音域大跳音区的符杠斜率由 VexFlow 默认计算，未做坡度收敛修饰。
