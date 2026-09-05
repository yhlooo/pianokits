# 谱号字形度量（SMuFL / Bravura / Noto Music）

记谱用谱号相对五线的正确大小与位置依据。供自绘大谱表（`src/debug/midi-keyboard.ts` 的
`CLEF_BOX`）使用。

## 1. SMuFL 规范原文摘录

来源：w3c-cg/smufl 仓库 `markdown/specification/scoring-metrics-glyph-registration.md`
（<https://github.com/w3c-cg/smufl/blob/a99b7d3f5eaec922437c8ede4e4916c0148531c8/markdown/specification/scoring-metrics-glyph-registration.md>，
2026-09-05 获取）：

> - Dividing the em in four provides an analogue for a five-line staff: if a font uses
>   1000 upm (design units per em), as is conventional for a PostScript font, one staff
>   space is equal to 250 design units; if a font uses 2048 upm, as is conventional for
>   a TrueType font, one staff space is equal to 512 design units.
>
> - Clefs should be positioned such that the pitch the clef refers to is on the baseline
>   (e.g. the F clef is placed such that the upper dot is above and the lower dot below
>   the baseline). If a clef does not refer specifically to a pitch, its y=0 should
>   coincide with the center staff line on a five-line staff, or the visual center for
>   staves with more or fewer than five lines (e.g. tablature staves).

即：**1 个线间距 = 0.25 em**；G 谱号基线在 G 音所在线（五线第二线）上，F 谱号基线在 F 音
所在线（五线第四线）上，两点分居基线两侧。

## 2. 实测墨迹范围（canvas `measureText` 的 `actualBoundingBox*`）

方法：Chromium（Playwright 1.62）中 canvas 2D 上下文，`ctx.font = '100px Bravura'` 等
度量对应字符→ `actualBoundingBoxAscent/Descent/Left/Right`。SMuFL 体系下 100px 字号即
1 em = 4 个线间距 → **25px = 1 个线间距**。度量代码见提交记录（临时脚本，仓库不保留）。

### 2.1 Bravura（随 `vexflow` 包内嵌的 woff2，`vexflow/build/esm/src/fonts/bravura.js`）

| 字符                           | 字形               | ascent | descent | left | right | 高  | 宽  |
| ------------------------------ | ------------------ | ------ | ------- | ---- | ----- | --- | --- |
| U+1D11E 𝄞 (= U+E050 gClef)     | 高音谱号           | 110    | 67      | 0    | 68    | 177 | 68  |
| U+1D122 𝄢 (= U+E062 fClef)     | 低音谱号（含两点） | 27     | 64      | 1    | 69    | 91  | 70  |
| U+E0A4 noteheadBlack（校验用） | 符头               | 13     | 13      | 1    | 30    | 26  | 31  |

换算（25px = 1 线间距，基线 = 谱号所指音线）：

- **𝄞（G 谱号）**：以第二线（G 线）为基线，墨迹向上 4.4、向下 2.68，**总高 7.08 个线间距**；
  相对五线（底线 = 0、顶线 = 4）：下缘在**底线下 1.7 (≈1.68)**，上缘在**顶线上 1.4**。
- **𝄢（F 谱号，含两点）**：以第四线（F 线）为基线，墨迹向上 1.08、向下 2.56，
  **总高 3.64 个线间距**；相对五线：下缘在**底线上 0.44**，上缘在**顶线上 0.08**。
- 符头高 26px ≈ 1.04 个线间距、上下对称——与 SMuFL「符头应位于线位/间位上」一致，
  说明度量方法与基线约定成立。

### 2.2 Noto Music（`@fontsource/noto-music`，noto-music-music-400-normal.woff2，非 SMuFL 体系）

| 字符      | 高（@100px） | 宽（@100px） | 备注                                   |
| --------- | ------------ | ------------ | -------------------------------------- |
| U+1D11E 𝄞 | 173          | 62           | 与 Bravura 接近（总高约 6.9 个线间距） |
| U+1D122 𝄢 | 80           | 70           | 墨迹整体在基线上方（descent 为负）     |

各字体谱号在自身 em 框内的占位/比例差异明显 → 项目内谱号必须按**实测墨迹**对齐到目标
外框（contain），不能写死字号与基线。

## 3. 应用取值（`midi-keyboard.ts` 的 `CLEF_BOX`，S = 1 线间距）

| 谱号     | 目标墨迹外框（相对所属谱表）                | 依据              |
| -------- | ------------------------------------------- | ----------------- |
| 高音谱号 | 顶线上 1.4 S ～ 底线下 1.68 S（高 7.08 S）  | §2.1 Bravura 实测 |
| 低音谱号 | 顶线上 0.08 S ～ 底线上 0.44 S（高 3.64 S） | §2.1 Bravura 实测 |
