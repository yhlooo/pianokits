# 外部依赖的集成方式与许可合规调研（2026-09-05）

> 调查主题：设计草案（`docs/development/design/20260905-midi-import-player.draft1.md`）涉及的全部外部依赖——
> 它们是以什么方式集成（随项目打包，还是页面运行时从外部加载）？各自是什么许可模式？有无版权风险？
>
> 关键事实的原文摘录见参考文档：
>
> - `docs/development/reference/midi/format-and-libraries.md`（§7：smplr 采样托管与上游采样许可声明）
> - `docs/development/reference/midi/rendering-libraries.md`（§2.6.1：VexFlow 字体包结构与许可）
> - 其余数据沿用 2026-09-05 的三份既有调查（下文引用处标注）。

## 1. 结论摘要

1. **全部 JS 库都是 npm 依赖、构建期打包**：`@tonejs/midi`、`smplr`、`vexflow`（及可选 `@tonaljs/tonal`）经 Vite 构建进产物，**页面运行时不需要从外部加载任何代码**。
2. **唯一"默认外链"的是音频采样**：smplr 默认运行时从 `smpldsnds.github.io`（GitHub Pages）逐个拉取采样文件。这不是技术限制而是分发选择——smplr 官方提供 `baseUrl` 允许镜像自托管。**本项目决策为：把采样镜像到 `public/samples/` 自托管**（已实现，实测 452 个文件 / 41.7MB），从而做到全量随站点打包部署、无外部运行时依赖。
3. **VexFlow 5 的字形文件不在主包，但 `vexflow/bravura` 入口以内嵌 base64 解决**：主包只内嵌字形**度量数据**（JS 模块）；官方把字形拆分为独立 npm 包 `@vexflow-fonts/*`。**实现最终选择**：从 `vexflow/bravura` 子入口引入——该入口把 Bravura woff2 以 base64 data URI 直接内嵌进 JS（`build/esm/src/fonts/bravura.js`，约 330KB），因此**无需独立字体 npm 包、无运行时字体外链**（`@vexflow-fonts/bravura` 不作为运行时依赖）。许可合规事项按用户决定整体推迟，未做特殊处理。
4. **许可风险总体很低**：代码库全部 MIT；Bravura 字体 SIL OFL 1.1（Steinberg）；SplendidGrand 采样为公有领域（AKAI 2000 年代初发布，上游声明）；Salamander 为 CC BY 3.0（仅需署名）。设计阶段已主动规避了 AGPL（gridsound）、GPL（webmscore）、BUSL、UNLICENSED 等有传染性或非开放许可的候选。
5. **唯一"未经核实"的许可是 GeneralUser GS 音源**（仅 SpessaSynth 备选路线涉及），本方案 M1/M2 均不引入，采用前必须另行核查。

## 2. 集成方式总表

| 依赖/资源                      | 类型                                | 集成方式                                                                                 | 运行时是否需要外部加载                      |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| `@tonejs/midi` 2.0.28          | npm JS 库                           | `pnpm add` → Vite 构建进产物                                                             | 否                                          |
| `smplr` 1.0.0                  | npm JS 库                           | 同上                                                                                     | 库本体否；**采样默认外链，已镜像解决**      |
| `vexflow` 5.0.0                | npm JS 库                           | `vexflow/bravura` 子入口（含内嵌字体的度量/字形模块）                                    | 否（字体以 base64 内嵌于构建产物）          |
| `@vexflow-fonts/bravura` 1.0.2 | npm 字体资源包                      | 不作为依赖（合规事项按用户决定整体推迟，未随包分发其许可文本）                           | 否（无运行时引用）                          |
| SplendidGrand 钢琴采样         | 音频资源（**实测 41.7MB**）         | 镜像到 `public/samples/sfzinstruments-splendid-grand-piano/samples/`，`baseUrl` 指向本地 | 否（自托管后）；不自托管则依赖 GitHub Pages |
| Salamander 钢琴采样（备选）    | 音频资源（mp3 1.92MB / ogg 6.62MB） | 同上                                                                                     | 否                                          |
| `vitest` 5.0.0                 | dev 依赖                            | 仅测试期使用，不进生产产物                                                               | 否                                          |
| `playwright` 1.62.1            | dev 依赖                            | 冒烟测试用无头 Chromium                                                                  | 否                                          |
| `@tonaljs/tonal`（M2 可选）    | npm JS 库                           | 构建进产物                                                                               | 否                                          |

Vite 机制说明：`node_modules` 依赖经打包器合并为产物文件；`public/` 目录原样拷贝进 `dist/`。
因此"跟项目一起打包"对上述每一项都成立；是否保留运行时外链完全是我们自己的选择。

## 3. 采样加载：默认外链 vs 自托管的取舍

smplr 默认行为（README 原文，ref format-and-libraries §7.1）：采样放在 `smpldsnds.github.io`
（GitHub Pages），"no need to download them"；但同一份 README 明确警告：

- GitHub Pages **有每秒请求限流**，开发期 HMR 反复拉取容易触发；
- 官方推荐用其 `CacheStorage`（基于 Cache API，仅 HTTPS）做浏览器端缓存；
- `baseUrl` 选项原文："override only if you mirror the samples yourself"。

对比（数据沿用 `20260905-midi-parse-and-playback.md` §7）：

| 维度         | 默认外链（GitHub Pages）             | 镜像自托管（进 `public/`，已决策）                                  |
| ------------ | ------------------------------------ | ------------------------------------------------------------------- |
| 加载可靠性   | 无 SLA、有限流、可能被墙/断网失效    | 与站点同源同命运；配合缓存离线可用                                  |
| 首次部署体积 | 0                                    | ~18MB 进 git 仓库（估算，见 §6 不确定项）                           |
| 加载性能     | 452 个逐文件请求，受限流影响可能变慢 | 本地静态资源 + HTTP 缓存，最稳定                                    |
| 维护成本     | 无（但上游改动/下线不可控）          | 一次性镜像成本，跟随上游更新（`scripts/mirror-samples.mjs` 可重跑） |

**结论**：本项目是本地工具类应用、追求稳定，**自托管是正确选择**（已写入设计决策并实现）。
若后续不想让 41.7MB 进 git 仓库，可行的替代是"首次在线拉取 → 存入 OPFS/IndexedDB 永久缓存"，
但首访依赖外网且实现成本更高，暂不采纳。

### 3.1 实现中发现并绕过的两个坑（2026-09-05 实测）

1. **smplr 拼 URL 不做编码（上游缺陷）**：其 `SampleLoader` 以
   `${baseUrl}/${采样名}.${格式}` 拼接且不调用 `encodeURIComponent`（源码
   `src/smplr/sample-loader.ts` 实测）。采样名含空格与 `#`（如 `MF C#1`）时，
   `#` 会被 URL 解析成片段标识 → 请求 404（node fetch 实测：pathname 截断为
   `MF%20C`、hash=`#1.ogg`）。绕过方式：不用 `SplendidGrandPiano` 工厂，改以
   `pianoToPreset` + `Sampler(preset)` 组合，在 `preset.samples.map` 中提供
   编码后的路径映射。
2. **Vite 静态服务无法解码 `%23` 路径**：即便把 `#` 编码为 `%23`，Vite dev/preview
   的静态中间件也会把请求回退到 `index.html`（实测 200 + text/html 510 字节），
   而 GitHub Pages 却能正常服务。绕过方式：镜像落盘时把文件名中的 `#` 替换为
   音乐升号 `♯`（U+266F，实测可正常服务），配合上述 `samples.map` 完成
   原始名 → `encodeURIComponent(♯ 名)` 的映射。冒烟测试证实：226 个采样请求全部
   命中本地镜像、55 个升号文件请求成功、零外部请求。

## 4. 许可模式与版权风险评估

| 依赖/资源                                                                                                                              | 许可                                                                                   | 版权风险       | 义务/注意点                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `@tonejs/midi`                                                                                                                         | MIT                                                                                    | 无             | 分发时保留许可声明即可                                                                       |
| `smplr`                                                                                                                                | MIT                                                                                    | 无             | 同上                                                                                         |
| `vexflow`                                                                                                                              | MIT                                                                                    | 无             | 同上                                                                                         |
| Bravura 字体（内嵌于 `vexflow/bravura` 入口，随 JS 打包）                                                                              | **SIL OFL 1.1**（Copyright Steinberg Media Technologies GmbH，保留名 "Bravura"）       | **低**         | 附随义务（版权声明 + OFL 文本）的落地按用户决定推迟，未做特殊处理                            |
| SplendidGrand 采样                                                                                                                     | **公有领域（PD）**：上游声明 "released as public domain in early 2000 by Akai company" | **低**         | 无署名义务；建议在 about 页注明来源（AKAI PD 采样 / sfzinstruments 转换为 SFZ / smplr 转换） |
| Salamander 采样（备选）                                                                                                                | **CC BY 3.0**（作者 Alexander Holm）                                                   | **低**         | **必须署名**：在 about/README 注明作者与许可链接                                             |
| GeneralUser GS 音源（仅 SpessaSynth 备选路线）                                                                                         | **未核实**                                                                             | **中（未知）** | 采用前必须核查其许可条款；本方案不涉及                                                       |
| （设计阶段已排除的候选）gridsound（AGPL-3.0）、webmscore（GPL）、`@sudobility/music_codecs`（BUSL-1.1）、`osmd-extended`（UNLICENSED） | —                                                                                      | —              | 排除理由：copyleft 传染 / 非开放许可 / 无许可，见 `20260905-waterfall-and-notation.md` §4.3  |

总体判断：**当前技术组合无 copyleft 传染风险、无商业授权费用、无"不可再分发"限制**；
全部依赖允许随 Web 应用构建产物分发。风险集中在两点：GeneralUser GS（不涉及）与
SplendidGrand "公有领域"声明的来源可信度（见 §6）。

## 5. 合规落地清单（实现状态）

> 2026-09-05 用户决定：**所有 JS/TS 包的许可不做任何特殊处理（含 Bravura），合规问题整体推迟**。
> 下列各项仅作现状记录。

1. [x] 第三方依赖许可清单：`pnpm licenses list` 随仓库维护（npm 库全部 MIT，dev 依赖另含 Apache-2.0 的 playwright）；
2. [ ]（推迟）构建配置把各 npm 库的 LICENSE 文本拷贝进产物并在 about 页展示；
3. [ ]（推迟）Bravura 字体（SIL OFL 1.1）的版权声明与许可文本附随分发；
4. [ ]（推迟）若任何阶段改用 Salamander 采样：署名 Alexander Holm + CC BY 3.0 链接（M1 未采用 Salamander，不涉及）；
5. [x] SplendidGrand 来源注明：`scripts/mirror-samples.mjs` 头部注释、`public/samples/sfzinstruments-splendid-grand-piano/README.md`（上游仓库与许可声明）与本文 §7 均注明（AKAI public domain、sfzinstruments 转制、smplr 集成）；
6. [x] 未引入 GPL/AGPL/BUSL/UNLICENSED 依赖（当前依赖全部为 MIT/Apache-2.0 + OFL 字体）。

## 6. 风险与不确定项（如实记录）

1. **采样总体积已实测**：镜像清单来自 jsDelivr 目录 API（2026-09-05），共 452 个文件、41.7MB（226 个 ogg 19.0MB + 226 个 m4a 22.7MB）。早期"~18MB/303 文件"的估算作废。
2. **"公有领域"声明未经独立法律验证**：依据是上游 sfzinstruments 仓库 README 的文字声明（AKAI 2000 年代初以公有领域发布）；该采样集历史久、社区使用广泛，实际风险很低，但若产品商业化发行，建议做一次正式许可审查。
3. **VexFlow 5 字体装配已按实现验证**：`vexflow/bravura` 入口以 base64 data URI 内嵌 woff2，无运行时外链；独立字体 npm 包不再需要。其 OFL 附随义务的落地方式按用户决定推迟，未做特殊处理。
4. **smplr URL 拼接缺陷（见 §3.1）已绕过**，但属上游行为，升级 smplr 版本时需复查该映射是否仍然生效（冒烟测试含升号文件请求断言，可回归验证）。
5. CC BY 3.0 / OFL 1.1 的署名与分发要求在"纯浏览器应用"场景下，通过 about 页 + 随包许可文件即可满足，无额外组织成本。

## 7. 参考

- 原文摘录：`docs/development/reference/midi/format-and-libraries.md` §7、`docs/development/reference/midi/rendering-libraries.md` §2.6.1
- 一手来源：
  - smplr README（含采样托管、baseUrl、CacheStorage、SplendidGrandPiano 说明、MIT 许可）：<https://github.com/danigb/smplr>
  - 采样上游许可声明：<https://github.com/sfzinstruments/SplendidGrandPiano>
  - VexFlow 字体包与许可文本：npm `@vexflow-fonts/bravura@1.0.2`（LICENSE.txt，SIL OFL 1.1，Steinberg）
  - VexFlow 5.0.0 包文件清单：unpkg meta 接口实测（2026-09-05）
