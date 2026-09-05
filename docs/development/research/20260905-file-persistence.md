# 浏览器本地 MIDI 文件导入与刷新后持久化：方案调查（2026-09-05）

> 调查主题：用户在 Web 页面导入本地 `.mid` 文件后，希望刷新页面（乃至重启浏览器）后文件列表仍在、点选即可播放，无需重复导入。用户原话提到"记录文件路径"——本调查首先澄清这一点在浏览器安全模型下不可行，并给出等价能力与推荐方案。
>
> 本文档是调查结论；外部资料的原文摘录见参考文档 [browser/file-access.md](../reference/browser/file-access.md)（下文以「ref §N」引用其章节）。所有资料获取日期为 2026-09-05，兼容性数据日期见各节。

## 目录

- [1. 结论摘要](#1-结论摘要)
- [2. 为什么拿不到真实路径：等价能力是什么](#2-为什么拿不到真实路径等价能力是什么)
- [3. 问题 1：File System Access API 机制与权限持久化](#3-问题-1file-system-access-api-机制与权限持久化)
- [4. 问题 2：浏览器支持矩阵（截至 2026 年 9 月）](#4-问题-2浏览器支持矩阵截至-2026-年-9-月)
- [5. 问题 3：IndexedDB 存内容副本的可靠性与配额](#5-问题-3indexeddb-存内容副本的可靠性与配额)
- [6. 问题 4：OPFS 作为备选存储](#6-问题-4opfs-作为备选存储)
- [7. 方案对比与推荐](#7-方案对比与推荐)
- [8. 已验证事实与不确定事项](#8-已验证事实与不确定事项)
- [9. 参考资料](#9-参考资料)

## 1. 结论摘要

1. **浏览器无法拿到本地文件真实路径**，这是有意的安全设计；`showOpenFilePicker` 返回的是 `FileSystemFileHandle`（文件句柄），句柄只暴露文件名（`name`），不暴露路径（ref §1、§2）。等价能力有两种：
   - **文件句柄（handle）**：对原文件的能力引用，可随时读取磁盘上的最新内容（相当于"记录文件"本身而非路径）；
   - **内容副本**：把文件字节（Blob/ArrayBuffer）复制到站点的持久化存储（IndexedDB / OPFS）。
2. **File System Access API（选择器 + 句柄 + 权限）目前是 Chromium 独占能力**：Chrome/Edge/Opera 桌面 86+（权限 API 86+），Chrome Android 132+；**Firefox（截至 157）与 Safari（截至 27）均不支持** `showOpenFilePicker` 等选择器（ref §6.1）。任务前提中"Firefox 133 起开始支持 File System Access API"经核实**不成立**——Firefox 111 起支持的是 File System API 的 **OPFS 部分**（`navigator.storage.getDirectory()`），与用户可见文件的选择器/权限 API 是两回事（ref §7）。
3. **Chrome/Edge 的权限持久化**：默认授权是**会话级**的（关闭该源最后一个标签页后失效，并受"一次性权限"自动撤销规则影响）；Chrome 122 起用户可选择"**每次访问都允许**"获得**永久授权**（存入站点权限存储，浏览器重启后仍有效，除非用户撤销）；**已安装的 PWA 授权后自动持久化、不再弹窗**（ref §5.1）。应用侧标准做法：句柄存 IndexedDB → 重载后 `queryPermission()` → 非 `granted` 时在用户手势中 `requestPermission()`（ref §4）。
4. **IndexedDB 存内容副本完全可行且配额绰绰有余**：Blob/File/ArrayBuffer/FileSystemFileHandle 都在结构化克隆支持列表中（ref §8）；配额为磁盘百分比量级（Chromium 60%、Firefox 10 GiB group limit、Safari 60%/旧版 1 GiB 起步），对几 KB～几 MB 的 MIDI 文件不成问题；`persist()` 可防驱逐，`estimate()` 可查用量（ref §9、§10）。
5. **OPFS 是可靠的备选内容存储**：按源私有、对用户和用户可见文件系统不可见、无需权限提示、受配额约束、清站点数据即删除，Chrome 86+/Firefox 111+/Safari 15.2+ 可用（写能力 Safari 26+）（ref §11）。
6. **MVP 推荐方案 C（混合）**：优先存 `FileSystemFileHandle`（Chromium 上可感知原文件更新、保留"文件引用"语义），同时把内容副本存入 IndexedDB/OPFS 兜底（Firefox/Safari、权限丢失、原文件被移动/删除时仍可播放）。若要以最小实现换取最大浏览器一致性，方案 B（仅存内容副本）即可满足核心需求；方案 A（仅存句柄）单独使用不可行。

## 2. 为什么拿不到真实路径：等价能力是什么

- `showOpenFilePicker()` 的返回值是 `FileSystemFileHandle` 数组而非路径（ref §2「Return value」）。规范与 MDN 均未提供任何获取绝对路径的接口；`FileSystemHandle` 只暴露 `name`（文件名）与 `kind`（ref §1）。
- 这是安全设计：网页不得在未经用户同意的情况下枚举或推断本地文件系统结构（防止指纹识别与隐私泄露）。因此用户期望的"记录文件路径"在 Web 平台上**不存在对应的能力**。
- 等价能力：
  - **文件句柄（FileSystemFileHandle）**：持久化后相当于"记录了这个文件本身"。`getFile()` 每次都返回"磁盘上的当前状态"（ref §3），因此原文件被外部修改后能读到更新——这是最接近"引用原文件"的语义。代价：受权限生命周期约束，且要求浏览器支持 FSA（目前仅 Chromium）。
  - **内容副本（Blob/ArrayBuffer → IndexedDB 或 OPFS）**：不引用原文件，无法感知更新，但完全自包含、跨浏览器一致、无权限问题。
- 对 MIDI 场景（文件几 KB～几 MB）而言，两者存储开销都可忽略。

## 3. 问题 1：File System Access API 机制与权限持久化

### 3.1 完整机制

1. **导入**：用户手势中调用 `window.showOpenFilePicker({ types: [{ accept: { "audio/midi": [".mid", ".midi"] } }], multiple: true })` → 得到 `FileSystemFileHandle[]`。选择器返回时，选中文件的**读权限已自动授予**（规范原文见 ref §5.3）。
2. **读取**：`handle.getFile()` → 每次返回磁盘当前状态的 `File` 对象（ref §3）。
3. **持久化句柄**：`FileSystemHandle` 可被结构化克隆、存入 IndexedDB（ref §1 注、§8；Chrome 官方博客以 vscode.dev 为例：`vscode-filehandles-store` 表，ref §5.1）。句柄对象极小（一个引用），不占文件内容空间。
4. **重载后恢复**：
   - 从 IndexedDB 取出句柄，先 `handle.queryPermission({ mode: 'read' })`；
   - 结果为 `'granted'` → 直接 `getFile()` 播放；
   - 结果为 `'prompt'` → 必须在**用户手势**（如点击列表项）中调用 `handle.requestPermission({ mode: 'read' })`，用户同意后返回 `'granted'`（ref §4；`requestPermission` 需要瞬时用户激活，否则抛 `SecurityError`）。对"点选播放"的 UI 而言，点击本身就是手势，可直接在点击处理器中完成。
   - MDN 明确提示：**从 IndexedDB 取出的句柄很有可能是 `'prompt'`**（ref §4 原文），因此必须走 query → request 流程，不能假设仍为 granted。
5. **写入**（可选，如"另存修改后的 MIDI"）：`createWritable()` → `FileSystemWritableFileStream`；写权限需 `requestPermission({ mode: 'readwrite' })`。

### 3.2 浏览器重启后权限是否有效（Chrome/Edge）

分层结论（依据 ref §5.1、§5.2）：

- **会话级授权（默认 / 旧行为）**：Chrome 官方博客原文 "Access lasts until you close the last tab of the origin."（访问持续到你关闭该源的最后一个标签页）。此外 Chrome 116 起的"一次性权限"规则会进一步自动撤销：页面被关闭/导航离开/丢弃（包括关闭 Chrome）、授权满 16 小时、页面在后台停留 5 分钟以上等（ref §5.2）。**此类授权在浏览器重启后无效**，重载后必须重新 `requestPermission`。
- **永久授权（Chrome 122+，Edge 同步跟进）**：Chrome 122 起，用户再次访问时对从 IndexedDB 取出的句柄调用 `requestPermission()` 会看到**三选一提示**："本次允许 / 每次访问都允许 / 不允许"。选"**每次访问都允许**"即获得**无限期授权**（"indefinite access unless access is revoked"），**浏览器重启后依然有效**；授权条目进入站点设置的 **File editing（文件编辑）** 区域，用户可逐项（或整体）撤销（ref §5.1）。拒绝/关闭该提示超过 3 次后不再出现，退回常规提示。
- **站点持久授权确实存在**：即站点设置中的 File editing 权限项（逐文件列出、可撤销），永久授权存储于权限存储中，跨重启有效。
- **PWA 安装与否的区别**：**有区别，且很重要**。Chrome 官方博客原文："The user must have installed the app. Installed apps will automatically persist permissions once the user grants access. In this case, the three-way prompt won't be shown, instead the app gets the new behavior by default."（已安装的应用在用户授权后**自动持久化权限**，不显示三选一提示，直接获得新行为，ref §5.1）。即：**安装为 PWA 后，授权一次即可长期有效**；未安装则默认会话级、需用户在三选一提示中选择"每次访问都允许"才能持久化。
- **Edge**：Edge 为 Chromium 内核，版本号与行为镜像 Chrome（ref §6.1），但 Edge 自己的 UI 文案未在官方文档中单独核实（见 §8 不确定事项）。
- MDN 的现状说明（"权限在页面刷新后不保留，如果该源没有其它打开的标签页"，ref §3）描述的是默认/会话级行为，**未涵盖** Chrome 122+ 永久授权，实践中应以 `queryPermission()` 的实测结果为准。

### 3.3 对"记录文件路径"的答复

浏览器不会（也不能）给网页真实路径；能持久化的是**句柄**或**内容副本**。句柄是最接近"记录文件"的等价物，且受权限生命周期与浏览器支持范围约束；内容副本是自包含的快照。推荐组合使用，见 §7。

## 4. 问题 2：浏览器支持矩阵（截至 2026 年 9 月）

以下数据以 MDN BCD 与 caniuse 为准（数据日期：BCD `api/Window.json` 更新 2026-08-31、`api/FileSystemFileHandle.json` 更新 2025-06-17；caniuse 数据更新 2026-08-24；均为 2026-09-05 获取）。完整表格见 ref §6。

| 能力                                                                | Chrome                 | Edge   | Opera                 | Firefox                | Safari                |
| ------------------------------------------------------------------- | ---------------------- | ------ | --------------------- | ---------------------- | --------------------- |
| `showOpenFilePicker` / `showDirectoryPicker` / `showSaveFilePicker` | 86+                    | 86+    | 72 起部分 / 91 起完整 | **不支持**（截至 157） | **不支持**（截至 27） |
| `queryPermission` / `requestPermission`                             | 86+                    | 86+    | 86+                   | **不支持**             | **不支持**            |
| Chrome Android（参考）                                              | 选择器 132+、权限 109+ | —      | —                     | —                      | —                     |
| OPFS 入口 `storage.getDirectory()`                                  | 86+                    | 86+    | 86+                   | 111+                   | 15.2+                 |
| OPFS 写 `createWritable()` / `FileSystemWritableFileStream`         | 86+                    | 86+    | 86+                   | 111+                   | **26+**               |
| `persist()` / `estimate()`                                          | 55+ / 61+              | mirror | mirror                | 57+                    | 15.2+ / 17+           |

### 4.1 Firefox：任务前提核实为"不成立"

- 任务前提："Firefox 133 起开始支持 File System Access API"。核实结果：**不成立**。
  - MDN BCD（2026-08-31）：`showOpenFilePicker` 等选择器、`queryPermission`/`requestPermission` 对 Firefox 均为 `false`（ref §6.1）。
  - caniuse "File System Access API"（2026-08-24）：Firefox 全部版本（含最新收录的 157）均为不支持（ref §6.1）。
  - MDN《Firefox 133 for developers》发布说明中**没有**任何 FSA 条目（ref §7.2）。
- Firefox 实际支持的是 **OPFS**（File System API 的一部分），自 **Firefox 111**（2023-03-14 发布）起：`navigator.storage.getDirectory()` 可用、无需权限提示、清站点数据即删除（发布说明原文见 ref §7.1）。两者名称相近，很可能是前提的混淆来源。
- 结论：在 Firefox 上无法使用选择器/句柄/权限恢复机制；可行路径只有 `<input type="file">`（或拖拽）导入 + 内容副本持久化（IndexedDB/OPFS）。

### 4.2 Safari：不支持选择器；可用 OPFS + 内容副本

- Safari 不支持 `showOpenFilePicker` 与权限 API（BCD/caniuse，截至 Safari 27，ref §6.1）。
- Safari 15.2+ 支持 OPFS 的读取侧接口（`getDirectory`/`getFileHandle`/`getFile`）；**Safari 26+** 补齐写侧（`createWritable`/`FileSystemWritableFileStream`，BCD 2025-06-17 提交 "Updates for Safari 26 beta"，ref §6.2）。
- 结论：Safari 上的可行方案同样是 `<input type="file">` 导入 + 内容副本（IndexedDB 或 OPFS，后者在 Safari 15.2–25 只能读、需注意写能力版本门槛，建议以 IndexedDB 为主更稳妥）。

### 4.3 支持矩阵对方案选择的影响

FSA 选择器路径只在 Chromium 桌面可用；Firefox/Safari 必须走内容副本。因此任何"只存句柄"的方案（§7 方案 A）在 Firefox/Safari 上直接失效。若产品目标包含这两类浏览器，内容副本路径是**必需**的。

## 5. 问题 3：IndexedDB 存内容副本的可靠性与配额

- **结构化克隆**：IndexedDB 存储使用结构化克隆算法，`Blob`、`File`、`FileList`、`ArrayBuffer`、`TypedArray` 以及 `FileSystemHandle`/`FileSystemFileHandle`/`FileSystemDirectoryHandle` 都在支持类型列表中（ref §8 原文列表）。即：`file.arrayBuffer()`（或直接存 `File`/`Blob` 对象）存入 IndexedDB 是规范支持的标准做法，二进制数据不会经 base64 膨胀。
- **配额**（ref §9.2 原文）：
  - Chromium（Chrome/Edge/Opera）：每源最多磁盘总大小 **60%**（persistent 与 best-effort 同额）。
  - Firefox：best-effort 为 **10% 磁盘与 10 GiB group limit 的较小者**；持久存储最高 50% 磁盘（上限 8 TiB）。
  - Safari：macOS 14/iOS 17 起浏览器应用每源约 **60% 磁盘**；更早版本初始配额 **1 GiB**，用尽后向用户申请扩容。
  - 对比 MIDI 文件几 KB～几 MB 的体积，**配额完全不是瓶颈**（相差 3～5 个数量级）。
- **驱逐（eviction）**（ref §9.3 原文）：
  - 默认 best-effort：存储压力下按 LRU 从最久未使用的源整源删除；获 `persist()` 授权的源被跳过。
  - Safari 特有：开启跨站跟踪防护时，最近 7 天浏览器使用中无交互的源，其脚本创建的数据会被主动删除。
  - Chrome 团队研究："浏览器极少删除数据；用户定期访问的网站，其 best-effort 数据被驱逐的可能性非常小"（ref §9.1 原文）。
  - 一旦驱逐，是**整源**删除（IndexedDB + OPFS 一起清空），且本地数据本就没有跨设备同步/备份语义，需在产品预期中说明。
- **`persist()` / `estimate()`**（ref §10、§12）：
  - `navigator.storage.persist()` 申请持久存储（不被自动驱逐）；Chromium 按启发式**静默自动授予/拒绝**（参与度、已安装 PWA、已加书签、已授予通知权限），Firefox 弹窗询问用户。
  - `navigator.storage.estimate()` 返回 `{ usage, quota }`，可查占用与配额；值仅为近似。
  - 对本应用：可在导入后顺手调用 `persist()`（成本极低，安装为 PWA 时通常直接获批），但即便不成功，几 MB 的 best-effort 数据在实际使用中也几乎不会被驱逐。

## 6. 问题 4：OPFS 作为备选存储

- **能存文件**：`const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle('xxx.mid', { create: true });` 再用 `createWritable()` 写字节（ref §11）。主线程用异步 API；Worker 内可用 `createSyncAccessHandle()` 同步读写（ref §6.2 支持表）。
- **可见性**：按源私有，"private to the origin of the page and not visible to the user"；"你无法在磁盘上找到一一对应的文件，OPFS 本就不打算对用户可见"；**其它源/其它应用无法访问**（ref §11 原文）。
- **配额与清理**：与 IndexedDB 一样受源配额约束并计入 `estimate()`；清除站点存储数据会删除 OPFS；访问无需权限提示（ref §11 原文）。
- **浏览器支持**：入口 `getDirectory` Chrome 86+/Firefox 111+/Safari 15.2+；写 `createWritable` Chrome 86+/Firefox 111+/**Safari 26+**（ref §6.2）。Safari 15.2–25 只能读。
- **与 IndexedDB 的比较（对本项目）**：两者都满足"存几 MB 的 MIDI 副本"。OPFS 的优势是文件系统式组织、超大文件与原地改写（本场景用不上）；IndexedDB 的优势是支持面更老更宽（Safari 15.2–25 也能写）、可与句柄/元数据放同一数据库统一管理。**本场景下 IndexedDB 是更简单稳妥的默认选择**，OPFS 可作为大文件场景或后续的迁移选项。

## 7. 方案对比与推荐

### 7.1 三种方案

- **方案 A：仅存 `FileSystemFileHandle`**——导入时把句柄存入 IndexedDB；刷新后取句柄 → `queryPermission` → 必要时在点击手势中 `requestPermission` → `getFile()` 播放。
- **方案 B：仅存内容副本**——导入时（`showOpenFilePicker` 或 `<input type="file">`）把文件字节与元数据（文件名、大小、导入时间）存入 IndexedDB（或 OPFS）；刷新后直接读副本播放。
- **方案 C：混合**——导入时**同时**存句柄（若浏览器支持）与内容副本；播放时优先走句柄路径（权限 granted 时读原文件最新内容），否则回退副本。

### 7.2 对比

| 维度                     | A 仅句柄                                                                                                  | B 仅副本                                               | C 混合                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| 跨浏览器一致性           | ✗ 差：Firefox/Safari 完全不支持（§4），只有 Chromium 可用                                                 | ★ 最好：三浏览器统一走同一路径，行为一致               | ◐ 好：所有浏览器都满足"刷新后列表仍在"；Chromium 额外获得句柄能力 |
| 能否感知原文件更新       | ★ 能：`getFile()` 每次读磁盘当前状态（ref §3）                                                            | ✗ 不能：副本是导入时的快照                             | ◐ Chromium 上能；其余浏览器为快照                                 |
| 原文件被移动/删除时      | ✗ 播放失败（只能提示用户重新导入）                                                                        | ★ 副本仍在，照常播放                                   | ★ 副本兜底，照常播放                                              |
| 权限/会话依赖            | ✗ 强：会话授权关最后一个标签页失效（ref §5.1）；需用户手势重新授权；Chrome 122+ 永久授权或 PWA 才长期有效 | ★ 无：内容副本不需要任何文件权限                       | ◐ 句柄路径依赖权限，副本路径不依赖；权限丢失自动回退              |
| 实现复杂度               | 中：picker + 句柄 IDB + 权限生命周期（query/request、手势、错误分支）                                     | **低**：读文件 + 存字节 + 读字节，一次实现全浏览器一致 | 较高：两条导入路径与读取路径、回退逻辑、元数据一致性与去重        |
| 可靠性（长期数据可用性） | 低（受权限撤销、文件变动影响）                                                                            | 高（自包含快照）                                       | 高（两条路径互为兜底）                                            |
| 存储开销                 | 极小（只存句柄）                                                                                          | 几 KB～几 MB/文件（对 MIDI 可忽略，§5）                | 两者之和（仍可忽略）                                              |

### 7.3 MVP 推荐：方案 C（混合），理由

1. **核心需求全浏览器可达**：Firefox/Safari 无 FSA（§4.1、§4.2），只有内容副本能让"刷新后列表仍在、点选即播"在所有主流浏览器成立。方案 A 单独使用会直接失去 Firefox/Safari 用户，不能作为 MVP。
2. **在 Chromium 上保留"文件引用"语义、对齐用户"记录文件路径"的期望**：句柄路径能感知原文件更新（用户在 DAW/编辑器中改完 MIDI 后回来即可播放新版本），这是方案 B 无法提供的、对本场景有实际价值的能力。
3. **可靠性最好**：句柄路径的已知故障模式（会话授权失效、原文件被移动/删除、Chrome 122 以下或用户选"本次允许"）全部由副本兜底，任何情况下列表都可用；副本被驱逐的概率本身极低（§5）。
4. **成本可控**：MIDI 文件小，副本存储开销可忽略；句柄路径是官方文档中的标准样板（vscode.dev 同款做法，ref §5.1），额外复杂度主要是"优先句柄、失败回退副本"这一层分支。
5. **明确的降级阶梯**：如果团队评估后认为 MVP 阶段不想维护双路径，**方案 B 是可接受的最小裁剪**（它完整满足核心诉求，仅损失"感知原文件更新"）；**方案 A 单独使用在任何情况下都不推荐**。

### 7.4 落地要点（供后续设计参考）

- 导入：检测 `'showOpenFilePicker' in window` 决定 UI 是否提供"增强导入"；不支持的浏览器用 `<input type="file" accept=".mid,.midi" multiple>` 兜底。两条路径都写入 IndexedDB（记录：文件名、大小、导入时间、内容 ArrayBuffer/Blob、可选 handle）。
- 列表渲染与播放：点击条目 → 若存有句柄且 `queryPermission({mode:'read'})==='granted'` → `getFile()` 播放（新鲜内容）；若为 `'prompt'` → 在点击手势中 `requestPermission()`（用户同意后读原文件，拒绝则读副本）；无句柄或任何异常 → 读副本。
- 权限提示的用户体验：Chrome 122+ 的三选一提示（本次/每次访问都允许/不允许）由浏览器呈现，应用只需调用 `requestPermission()`；安装为 PWA 可让授权自动持久化（ref §5.1），是值得在 UX 上引导的行为。
- 可选加固：导入后调用 `navigator.storage.persist()`；用 `navigator.storage.estimate()` 监控用量（本场景必然远低于配额）。
- 已知边界：刷新后句柄路径依赖权限状态，永远不要假设"上次能读这次也能读"（ref §4 原文：IndexedDB 取出的句柄很可能为 `prompt`）；副本路径无法感知原文件更新，若产品要求"始终最新"，需在 UI 上区分或提示"快照/原文件"状态。

## 8. 已验证事实与不确定事项

**已验证事实**（依据 ref 文档中的一手来源）：

1. `showOpenFilePicker` 返回 `FileSystemFileHandle[]`，不暴露路径；调用需瞬时用户激活（ref §2）。
2. `FileSystemHandle` 可存入 IndexedDB（结构化克隆支持，ref §1、§8）。
3. 选择器返回时读权限自动 granted；从 IndexedDB 取出的句柄查询权限很可能为 `prompt`；`requestPermission` 需用户手势（ref §4、§5.3）。
4. Chrome 122+ 存在永久授权（"每次访问都允许"，无限期直到撤销，可逐项撤销）；此前及默认行为是"关闭该源最后一个标签页后失效"；一次性权限自动撤销规则（16 小时/后台 5 分钟/页面关闭）适用于会话授权（ref §5.1、§5.2）。
5. 已安装 PWA 授权后自动持久化权限（ref §5.1 原文）。
6. 截至 2026-08 数据：Firefox（≤157）与 Safari（≤27）不支持 FSA 选择器与权限 API；Firefox 111+/Safari 15.2+ 支持 OPFS；Safari 26+ 支持 OPFS 写（ref §6）。"Firefox 133 支持 FSA"的前提不成立（ref §7.2）。
7. IndexedDB 可存 Blob/File/ArrayBuffer；各浏览器配额为磁盘百分比量级（60%/10 GiB/1 GiB 起），驱逐按 LRU 整源进行、persist 源被跳过，Safari 有 7 天无交互主动驱逐（ref §8、§9）。
8. OPFS 对用户不可见、受配额约束、清站点数据删除、无需权限提示（ref §11）。

**不确定 / 需进一步验证**：

1. Chrome 122 之后（2024-02 至 2026-09）永久授权的提示形态或默认值是否再有调整：官方博客最新更新仍为 2024-01-09，期间未找到更晚的官方变更说明；实现前建议用当前稳定版 Chrome 实测三选一提示与重启后 `queryPermission` 返回值。
2. Edge/Opera 的权限提示文案与"文件编辑"设置入口是否与 Chrome 完全一致（兼容数据为 mirror，但 UI 细节未见独立官方文档）。
3. MDN 与 Chrome 博客对权限持续时间的表述存在口径差异（MDN 按会话默认行为描述，未提及 Chrome 122+ 永久授权），两者均已摘录，以实测为准。
4. Safari 的 7 天主动驱逐对"已加入主屏幕/安装的 Web App"是否豁免，未见官方说明（web.dev/WebKit 仅列出浏览器应用与内嵌应用的配额差异）。
5. Chrome Android 132+ 才支持选择器，移动端体验未纳入本调查范围。

## 9. 参考资料

- 外部资料原文摘录：见 [../reference/browser/file-access.md](../reference/browser/file-access.md)（§1–§12 分别对应 MDN FSA 概述、showOpenFilePicker、FileSystemFileHandle、query/requestPermission、权限持久化、支持数据、Firefox 发布说明、IndexedDB/结构化克隆、配额与驱逐、persist/estimate、OPFS、web.dev persistent storage；§13 为来源链接汇总）。
- 关键一手来源：
  - MDN File System API：<https://developer.mozilla.org/en-US/docs/Web/API/File_System_API>
  - MDN showOpenFilePicker：<https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker>
  - MDN FileSystemHandle.queryPermission / requestPermission：<https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission>、<https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission>
  - Chrome for Developers：Persistent permissions for the File System Access API：<https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api>
  - Chrome for Developers：One-time permissions：<https://developer.chrome.com/blog/one-time-permissions>
  - WICG File System Access 规范：<https://wicg.github.io/file-system-access/>
  - MDN Browser Compat Data：<https://github.com/mdn/browser-compat-data>
  - caniuse File System Access API：<https://caniuse.com/native-filesystem-api>
  - MDN Storage quotas and eviction criteria：<https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>
  - MDN Origin private file system：<https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>
  - MDN Firefox 111 / 133 for developers：<https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/111>、<https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/133>
  - web.dev Persistent storage：<https://web.dev/articles/persistent-storage>
