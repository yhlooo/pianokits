# Splendid Grand Piano 采样（本地镜像）

本目录是 smplr `SplendidGrandPiano` 钢琴音色所用的音频采样镜像（自托管，页面运行时
全部从本站加载，无外部请求）。由 `scripts/mirror-samples.mjs` 从以下上游仓库下载。

## 上游来源

- **镜像来源仓库**：<https://github.com/smpldsnds/sfzinstruments-splendid-grand-piano>
  （main 分支；脚本经 jsDelivr CDN 获取文件清单并下载 `samples/` 下的音频文件）
- **原始采样与 SFZ 转制**：<https://github.com/sfzinstruments/SplendidGrandPiano>

## 采样本身与许可

- 原始采样：AKAI 于 2000 年代初以**公有领域（Public Domain）**发布的 Steinway 钢琴采样
  （声明见 sfzinstruments 仓库 README："released as public domain in early 2000 by Akai company"）；
- 转制链：AKAI 采样 → sfzinstruments 转为 SFZ（4 层力度 + 1 层低通滤波合成的最弱层）→
  smplr 转为 ogg/m4a 采样包（MIDI 23–108、5 个力度分组）；
- 使用本采样集建议在"关于"页注明来源（AKAI public domain → sfzinstruments 转制 → smplr 集成）。

## 目录内容与命名

- 每个采样提供 `ogg` 与 `m4a` 两种格式（ogg 供 Chrome/Edge/Firefox，m4a 供 Safari），
  共 452 个文件、约 41.7MB；浏览器运行时只加载其支持的一种格式；
- 上游文件名含 `#`（如 `MF C#1.ogg`），Vite 静态服务无法解码 `%23` 路径，故落盘时把
  `#` 替换为音乐升号 `♯`（U+266F），引擎侧经 `preset.samples.map` 映射回原始名（见
  `src/core/engine/smplr-engine.ts`）。

## 更新方式

```sh
node scripts/mirror-samples.mjs   # 幂等：已存在且大小一致的文件会跳过
```
