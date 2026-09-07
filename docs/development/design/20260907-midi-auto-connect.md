# 设计：MIDI 键盘自动连接与连接状态展示

- 日期：2026-09-07
- 状态：**正式生效（2026-09-07 实现）**
- 关联文档：
  - `20260906-midi-keyboard-and-practice.md`（生效设计；本设计是对其 §1 需求、§3.1 连接层、
    §3.5 编排控制器、§4.1 入口 UI 的修订）
  - `docs/development/research/20260905-web-midi-input.md`（Web MIDI 接入调查结论）
  - `docs/development/research/20260906-web-midi-connect-hang.md`（连接长期挂起成因）
  - `docs/development/research/20260906-web-midi-ipad.md`（iPad 兼容层缺陷）
  - `docs/development/reference/midi/webmidi-api.md`（Web MIDI API 参考）

## 1. 需求与动机

现状：播放坞右下角有一个"钢琴"图标按钮，**需要用户主动点击**才会发起 `requestMIDIAccess()`
连接 MIDI 键盘。很多用户没意识到要点击这一步，导致键盘一直处于未连接。

目标：把"连接"这件事尽量做**无感、自动**；按钮降级为"连接状态展示 + 状态详情入口"，不再承担
连接/断开动作。

相对生效设计的具体改动：

1. 播放坞"钢琴按钮"从"连接/断开开关"改为**连接状态展示图标**：高亮 = 已连接，暗色 = 未连接；
   点击弹出**状态浮层**，不决定连接/断开。
2. 连接**自动触发**：进入播放器页面即自动发起 `requestMIDIAccess()`；授权后由 `statechange`
   自动感知 MIDI 线插拔，无需轮询。
3. **去掉"断开连接"动作**（不再提供用户主动断开）。
4. 状态浮层内容：**未连接 / 已连接键盘名列表 / 失败原因 + 重连按钮**。

已拍板决策（2026-09-07 讨论确认）：

| #   | 决策项       | 拍板                                                                      |
| --- | ------------ | ------------------------------------------------------------------------- |
| 1   | 首次授权     | 进入页面**直接要求授权**（全自动，不设引导点击）                          |
| 2   | 断开动作     | **不需要**                                                                |
| 3   | 自动连接失败 | 无设备类问题**忽略（静默）**；有设备按理可连却失败 → 右下角**弹报错通知** |
| 4   | 详情浮层     | 未连接 / 键盘名列表 / 失败原因 + 重连按钮                                 |

## 2. 可行性结论（先于方案，作为依据）

1. **热插拔无需轮询**：拿到 `MIDIAccess` 后，设备插入/拔出由 `statechange` 事件主动推送
   （`20260905-web-midi-input.md` §3）；现有 `MidiConnection.sync()` 已接好这条路径。
2. **硬边界：首次必须授权**：Web MIDI 规范要求用户显式授权或曾授权过（`webmidi-api.md` §3）。
   授权之前网页**无法枚举设备、无法感知有没有键盘插着**——枚举本身就依赖 `MIDIAccess`。
3. **"定时轮询 `requestMIDIAccess()`" 不采用**：
   - 授权前：没有 `MIDIAccess`，轮询检测不到任何设备，只会反复触发授权提示；
   - 授权后：`statechange` 已实时感知，轮询冗余。
     故放弃"每隔几秒检测可连接设备"这一手段，改用"授权记忆 + 常驻 `MIDIAccess` + `statechange`"。

## 3. 关键技术决策

| #   | 环节     | 决策                                                                                       | 理由                                                        |
| --- | -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | 自动连接 | 进入播放器即自动 `requestMIDIAccess()`；成功后**常驻 `MIDIAccess`**，不因无设备而拆除      | 回头客（已授权）秒连；常驻才能靠 `statechange` 感知后续插线 |
| 2   | 热插拔   | 只靠 `statechange`（现有 `sync()` 路径），不加轮询                                         | API 原生事件，实时、零成本                                  |
| 3   | 失败语义 | `no-devices`（无设备）= 正常等待态、静默；`denied/unsupported/error` = 报错通知 + 详情原因 | 拍板 3                                                      |
| 4   | 超时     | 不再作为"5s 未连上即失败并拆 access"；改为**软提示**（§4.1）                               | 自动场景下授权提示应答可能慢，硬超时会误伤正常流程          |
| 5   | 断开     | 移除用户主动断开；保留 `dispose()`（工具切换卸载清理）                                     | 拍板 2                                                      |
| 6   | 入口 UI  | 按钮 → 状态图标 + 点击弹状态浮层                                                           | 拍板 4                                                      |

## 4. 模块与接口

### 4.1 `core/midi/connection.ts`（`MidiConnection`）

**状态机**（去掉 `timeout` 作为对外终态）：

```ts
type MidiConnectionStatus =
  | 'idle' // 初始（进入页面、发起自动连接前的瞬间）
  | 'connecting' // 正在请求授权（requestMIDIAccess 的 Promise 未落定）
  | 'connected' // 已授权且 ≥1 台输入设备挂载
  | 'no-devices' // 已授权但 0 台输入（常驻等待插入，非"尝试窗口内"）
  | 'denied' // 授权被拒
  | 'unsupported' // 浏览器不支持 Web MIDI
  | 'error' // 其它失败
```

**接口变化**：

- `connect()` 语义改为**自动连接**：授权成功后常驻 `access`；`sync()` 发现 0 台输入时置
  `no-devices` 且**不再等超时拆 access**（与生效设计 §3.1 的"无设备 → 5s 超时拆 access"相反）。
- `disconnect()` 移除；保留 `dispose()`（清理监听、恢复 Local Control On、清输出快照）。
- `connectedLabel: string | null` 改为 `connectedLabels: readonly string[]`（已连接键盘名列表，
  覆盖多台键盘；空数组 = 未连接）。
- `attempting` 语义收敛：spinner 只在 `status === 'connecting'` 时显示（原 `attempting` 还覆盖
  "无设备的尝试窗口内"，新语义下不再需要，可由 status 直接推导）。

**超时处理（软提示，替代原硬超时）**：

- `requestMIDIAccess` 长期不落定（`20260906-web-midi-connect-hang.md` 的挂起场景）时，
  保留一个计时器，仅用于在详情浮层给出"授权请求超时，请检查浏览器权限提示或站点设置"的
  **软提示**——**不拆 access、不进入终态失败**；Promise 晚到仍按真实状态呈现（沿用研究文档
  "晚到结果按真实状态呈现"的既有策略）。
- 具体：`connecting` 状态下超过阈值未落定，状态仍为 `connecting`，但 `MidiUiState`
  增加 `connectingHint: string | null` 供浮层展示提示。

### 4.2 `core/practice.ts`（`PracticeController`）

- 构造时（或由 `createApp` 在组装完成后显式调用）自动 `void this.midi.connect()`。
- 移除 `toggleMidi()` 的断开分支；失败态的"重连"直接复用 `midi.connect()`（`connect()` 对
  `denied/error/no-devices` 可再次发起，仅 `connecting/connected` 时幂等返回）。
- 失败通知策略（§5）：`no-devices` 不弹；其余失败经 `onConnectError` 弹右下角报错。
- 其余规则不变：连接状态离开 `connected` → 清练习开关 + 自动暂停；`onOutputs` → 播放镜像与
  Local Control；实时演奏 / 练习按键 / 门控判定均不变。

### 4.3 `MidiUiState` 扩展（`core/practice.ts`）

```ts
interface MidiUiState {
  status: MidiConnectionStatus
  connectedLabels: readonly string[] // 已连接键盘名列表（替代 deviceLabel）
  connectingHint: string | null // connecting 超时软提示；其余状态为 null
  // attempting 移除：spinner 由 status === 'connecting' 推导
}
```

### 4.4 `ui/transport-view.ts`（`TransportView`）

- `midiBtn` 三态（复用现有 CSS 类）：暗色（未连接/无设备/失败）、旋转（connecting）、
  琥珀高亮（connected）。
- 点击不再 `onMidiToggle()`，改为**弹出状态浮层**（复用练习悬浮菜单的定位 / 外部点击收起机制）：
  - **未连接 / 连接中 / 失败**：按 status 渲染标题与正文；`denied/error` 及 `connecting` 超时
    软提示附"重连"按钮（触发 `midi.connect()`）；`unsupported` 不附重连（重试无意义）。
  - **已连接**：列出 `connectedLabels`（多台逐行）。
  - **no-devices**：显示"已授权，等待插入 MIDI 键盘"（静默，无重连）。
- `tooltip`：connected → "已连接 {列表首名}…"；其余按 status 给原因/提示。
- 回调变更：`TransportViewCallbacks` 移除 `onMidiToggle`，新增 `onMidiRetry`（浮层重连按钮）。

## 5. 失败通知策略（对应拍板 3）

| 状态                    | 右下角报错通知   | 详情浮层                                              |
| ----------------------- | ---------------- | ----------------------------------------------------- |
| `no-devices`            | 否（静默）       | "已授权，等待插入 MIDI 键盘"                          |
| `denied`                | 是               | "MIDI 授权被拒绝" + 重连                              |
| `unsupported`           | 是               | "当前浏览器不支持 Web MIDI"（无重连）                 |
| `error`                 | 是               | "MIDI 连接失败，请重试" + 重连                        |
| `connecting` 超时软提示 | 否（浮层内提示） | "授权请求超时，请检查浏览器权限提示或站点设置" + 重连 |

**"有设备按理可连却失败"的判定说明（实事求是）**：受 Web MIDI 授权模型限制，授权前无法枚举
设备，因此**无法直接"检测到有设备"**。这里用**失败类型近似**：`no-devices` 判定为"无设备"
（静默）；`denied/unsupported/error/超时` 判定为"授权/环境/平台层失败"（弹报错）。其中
`denied` 严格说是"用户拒绝授权"而非"有设备但失败"，但同样需要用户行动，故一并弹报错。

## 6. UI 细节

- 图标顺序不变：`[音量][瀑布][乐谱][钢琴][练习]`。
- 首次授权：进入页面即自动 `requestMIDIAccess()`（拍板 1），浏览器弹出授权提示；若个别浏览器
  因无用户手势不弹提示，详情浮层的"重连"按钮即手动手势入口（点击后再请求，满足手势要求）。
- 状态浮层示意：

```text
┌─────────────────────────┐   ┌─────────────────────────┐
│ MIDI 键盘未连接          │   │ MIDI 键盘                │
│ （暗色图标）             │   │ • CASIO Privia PX-160    │
│ [重连]（仅失败态显示）   │   │ • Alesis Q49             │
└─────────────────────────┘   └─────────────────────────┘
```

## 7. 验收

- 进入播放器页面自动发起连接；已授权用户（回头客）秒连、零点击；
- 首次进入弹出浏览器 MIDI 授权提示，允许后即连接；拒绝后状态图标暗色 + 右下角报错 + 浮层显示
  "授权被拒绝"与重连按钮；
- 授权后未插键盘：状态图标暗色、浮层"等待插入 MIDI 键盘"、**不弹报错**；插入键盘后经
  `statechange` 自动连上并高亮；
- 拔出键盘：图标转暗、练习开关清空、播放暂停、Local Control 恢复 On；再插入自动重连；
- 已连接时点击图标：浮层列出全部已连接键盘名（多台逐行）；
- 失败（denied/unsupported/error）：右下角报错通知 5s 消退；浮层显示失败原因，denied/error
  附重连按钮，点击可重新请求；
- 连接长期挂起：`connecting` 下超过阈值在浮层显示"授权请求超时…"软提示，不拆 access、不弹
  报错，Promise 晚到仍按真实状态呈现；
- 不再提供"断开连接"入口；工具切换卸载时正确清理（`dispose`）。
- 回归：实时演奏、练习模式、播放镜像、分轨练习、暂停/播放联动行为与生效设计一致；
  `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` 全绿。

## 8. 非目标

- **不做定时轮询兜底**：除非后续实测某平台 `statechange` 不可靠，否则不加"每隔几秒重扫端口"
  的保险丝（可作为后续单独决策）。
- iPad 兼容层（Web MIDI Browser shim）的引导文案延续现有 `unsupported`/诊断提示，不在本方案内
  扩展（如需在 iPad 上替换引导文案，另立设计，见 `20260906-web-midi-ipad.md` §5）。

> 已定案：超时软提示阈值取 **5000ms**（`CONNECT_HINT_MS`，与既有调试工具诊断阈值
> `CONNECT_TIMEOUT_MS` 一致）。因为已从"5s 失败拆 access"改为"仅浮层软提示、不拆不失败"，
> 提示早 1~2 秒也无副作用，无需放宽。
