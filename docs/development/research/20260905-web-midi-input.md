# 浏览器 Web MIDI 输入方案调查（2026-09-05）

> 调查日期：2026-09-05。本文是研究结论文档；文中引用的外部事实均摘录在
> [参考文档](../reference/midi/webmidi-api.md)（下称“参考文档”），关键处标注来源 URL。

## 1. 结论摘要（TL;DR）

**推荐方案：直接用浏览器原生 Web MIDI API（零第三方依赖），配合自研极薄的核心层纯函数。**

| 环节       | 决策                                                                      | 理由                                                                                                |
| ---------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 设备接入   | `navigator.requestMIDIAccess({ sysex: false })`                           | 原生 API 即可枚举输入端口、订阅 `statechange`；本需求只读按键，无需 sysex（参考文档 §4.1）          |
| 消息订阅   | 对每个 `MIDIInput` 监听 `midimessage`                                     | `MIDIMessageEvent.data` 是 `Uint8Array`，一条完整 MIDI 消息，无跨事件 running status（参考文档 §6） |
| 消息解析   | 自研纯函数解码通道声音消息（Note On/Off）                                 | 只需识别按键，不必引入 webmidi 类库；纯函数可单测（参考文档 §8）                                    |
| 音名显示   | 音符号 → 科学音高记号（`C4` 等，黑键用升号）                              | 与项目既有 `spellPitch`（记谱语境）区分开，调试用无歧义命名                                         |
| TypeScript | 直接用 DOM lib 自带类型（`MIDIAccess`/`MIDIInput`/`MIDIMessageEvent` 等） | 无需额外 `@types` 包                                                                                |

**关键事实：**

1. Web MIDI API 只在**安全上下文（HTTPS，localhost 亦算）**可用，且可能需要用户授予权限；
   可能被 `midi` HTTP Permission Policy 拒绝（参考文档 §3）。
2. 不支持时 `requestMIDIAccess()` 抛 `NotSupportedError`，被拒抛 `NotAllowedError`（参考文档 §4.2）。
3. `MIDIAccess.inputs`/`.outputs` 是可迭代的 Map 结构；端口增删通过 `MIDIAccess` 的 `statechange`
   （`MIDIConnectionEvent`）通知（参考文档 §2、§5.1）。
4. 浏览器兼容性（caniuse，参考文档 §7）：Chrome 43+、Edge 79+、Firefox 108+、Opera 30+ 支持；
   **Safari（macOS/iOS）不支持**（WebKit bug #107250）。全局使用率约 80.88%。
5. MIDI 1.0：Note On 状态字节 `0x9n`、Note Off `0x8n`（n=通道 0–15）；Note On 且 velocity=0
   等价 Note Off；音符号 60=C4、69=A4（参考文档 §8）。

## 2. 需求与约束

- 需求：识别连接电脑的 USB MIDI 键盘，按键时显示对应音名（例如按 C4 显示 `C4`）。
- 约束：本项目是 Vite + TypeScript 纯 Web 应用；`tsconfig` 已包含 `DOM` lib，自带 Web MIDI 类型；
  开发服务器绑定 0.0.0.0（devcontainer 端口转发，`http://localhost:5173` 属安全上下文）。

## 3. Web MIDI API 关键机制（问题 1：如何接入）

来源 MDN（参考文档 §3–§6）：

- 接入入口唯一：`navigator.requestMIDIAccess()`，返回 `Promise<MIDIAccess>`。
- `MIDIAccess` 持有 `inputs`（`MIDIInputMap`）与 `outputs`（`MIDIOutputMap`），都是 Map 风格、可迭代。
- 每个 `MIDIInput` 通过 `midimessage` 事件推送一条条完整消息，`event.data` 为 `Uint8Array`。
- 端口热插拔通过 `MIDIAccess`/`MIDIPort` 的 `statechange` 事件感知。
- 权限：首次调用会触发浏览器授权；可用 `navigator.permissions.query({ name: 'midi', sysex: false })`
  预查询（参考文档 §3）。

**对项目的影响**：接入代码只需 `requestMIDIAccess()` → 遍历 `inputs.values()` 挂监听 → 监听
`statechange` 刷新设备列表；不需要任何 npm 依赖。

## 4. 消息格式（问题 2：如何解析出“哪个键”）

依据 MIDI 1.0 消息概要（参考文档 §8）：

- 状态字节高 4 位区分类型，低 4 位为通道号。
- Note On `0x9n`：`[status, noteNumber, velocity]`；Note Off `0x8n`：`[status, noteNumber, velocity]`。
- Note On 且 velocity=0 视作 Note Off（常见于部分键盘只用 Note On + 零力度表达离键）。
- 音符号 60 = 中央 C（C4）；黑键用升号命名（`C#4`）是与记谱语境（`spellPitch` 按调号拼写）无关的
  无歧义选择。

**对项目的影响**：解析器只需处理 `0x9n`/`0x8n` 三种情况；其余（CC、pitch bend、sysex、system real-time）
一律忽略。Web MIDI 事件里一条消息是完整的（含状态字节），无需处理 running status。

## 5. 兼容性风险与降级（问题 3：不支持的浏览器怎么办）

- Safari 全系不支持（参考文档 §7）：这类环境下 `navigator.requestMIDIAccess` 为 `undefined` 或调用
  抛 `NotSupportedError`，调试工具应显式提示“当前浏览器不支持 Web MIDI”，而不是静默失败。
- 用户拒绝授权：抛 `NotAllowedError`，同样应显式提示。
- 无设备连接：`inputs` 为空，提示“未检测到 MIDI 设备”，并靠 `statechange` 在插入设备后自动更新。

**对项目的影响**：调试工具需要三态状态机（不支持 / 未授权 / 已连接），并对外呈现连接状态与设备列表。

## 6. 参考资料

- 参考文档：`docs/development/reference/midi/webmidi-api.md`
- MDN Web MIDI API：<https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API>
- caniuse Web MIDI：<https://caniuse.com/midi>
