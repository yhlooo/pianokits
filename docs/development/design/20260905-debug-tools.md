# 设计：调试工具集与 MIDI 键盘调试工具

- 日期：2026-09-05
- 状态：**正式生效（与实现一致）**。2026-09-05 初版实现（浮动面板形态）；同日按“每个调试工具一个页面，跟正常工具一样”调整后与实现一致。
- 关联调查结论：`docs/development/research/20260905-web-midi-input.md`（下称 **R-MIDI**）
- 参考：`docs/development/reference/midi/webmidi-api.md`

## 1. 目标与范围

### 1.1 目标

为 pianokits 增加一套仅开发/调试期可见的工具集，第一个工具是“MIDI 键盘”：识别连接电脑的
USB MIDI 键盘，按键时实时显示对应音名（例如按下 C4 显示 `C4`）。调试工具与正常工具一样，
每个工具在内容区占据一个完整页面。

### 1.2 验收标准（可测试）

- URL 含 `?debug=1` 时，外壳顶栏右侧出现“调试”按钮；不含时完全不出现、不引入调试代码。
- 悬浮在“调试”上显示下拉菜单，菜单含“MIDI 键盘”一项。
- 点击“MIDI 键盘”后，内容区切换到该调试工具的页面（与正常工具切换页签一致）；连接键盘后
  按键，页面显示音名（`C4`/`C#4` 等）；**多个键同时按住时，同时显示多个音名**，且各键同色
  （不区分按下先后）。
- 按键时：88 键钢琴键盘点亮对应琴键、大谱表在对应线/间显示音符位置；**抬起即熄灭/消失**
  （谱面只反映当前按住状态，不记录音符历史）。
- 调试工具激活时：“调试”按钮呈现激活态、常规工具页签取消激活；反之亦然。
- 无设备 / 浏览器不支持 Web MIDI / 用户拒绝授权时，页面给出明确的状态提示（不静默失败）。
- 切换到其它工具时，释放 Web MIDI 事件监听等资源。

### 1.3 非目标

- 不把 MIDI 输入接到主播放器的发声/录音（M1 明确不做，见 `20260905-midi-import-player.md` §1.3）。
- 不做输出（`MIDIOutput`）、sysex、CC/pitch bend 等消息的展示（本工具只识别按键）。
- 不做移动端适配（桌面优先，与现有项目一致）。

## 2. 关键技术决策

| #   | 环节         | 决策                                                                                      | 理由                                                                  | 依据          |
| --- | ------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------- |
| 1   | 设备接入     | 原生 Web MIDI API，`navigator.requestMIDIAccess({ sysex: false })`                        | 零依赖、只需读按键；Safari 不支持需显式降级                           | R-MIDI §1、§5 |
| 2   | 消息解析     | 自研纯函数 `parseMidiMessage`（解码 Note On/Off，velocity 0 归为离键）                    | 无库依赖、可单测；Web MIDI 每条事件是完整消息，无需 running status    | R-MIDI §4     |
| 3   | 音名         | 独立纯函数 `midiNoteName(pitch)`，黑键用升号（`C#4`）                                     | 调试需要与调号无关的无歧义命名；不复用记谱语境下的 `spellPitch`       | R-MIDI §1、§4 |
| 4   | 调试开关     | URL query `?debug=1` 驱动，仅当开启时才 import 调试工具模块                               | 生产路径零开销；调试模块整体懒加载                                    | 见 §3         |
| 5   | 调试 UI 形态 | 顶栏右侧“调试”按钮 + hover 下拉；**调试工具与正常工具一样挂载到内容区，一个工具一个页面** | 与正常工具体验一致、有整页空间展示；激活态与页签互斥                  | §4            |
| 6   | 调试工具接口 | **直接复用主 `Tool` 接口**，调试工具注册表即 `Tool[]`                                     | 挂载机制完全一致；外壳统一处理主/调试工具切换，无需平行的面板管理逻辑 | §3            |

## 3. 总体架构

### 3.1 模块划分

```
外壳（shell.ts）—— 主/调试工具统一挂载到内容区（同一时间只挂载一个）
  ├─ 顶栏页签（src/tools.ts）      常规工具：点击页签 → mount(host)
  └─ isDebugEnabled() 为真时 attachDebugMenu(header, debugTools, onSelect)
        ├─ debug/menu.ts       调试按钮 + hover 下拉；点击项回调 onSelect，由外壳挂载
        └─ debug/tools.ts      调试工具注册表（Tool[]，懒加载具体工具）
              └─ debug/midi-keyboard.ts   “MIDI 键盘”工具（Web MIDI 接入 + 页面 UI）

core 层（纯逻辑，可单测，与 UI 解耦）
  ├─ core/midi/input.ts        parseMidiMessage(data) → NoteOn/NoteOff 事件
  ├─ core/midi/note-name.ts    midiNoteName(pitch) → "C4" / "C#4"
  └─ core/midi/held-keys.ts    sortedHeldPitches(held) → 按住键音高升序列表
```

### 3.2 与主工具的边界

- 主工具与调试工具**共用内容区 host 与卸载路径**：切换前先卸载上一个（无论主/调试）；
  激活态互斥——常规工具激活时“调试”按钮无指示条，调试工具激活时页签全部取消激活、
  “调试”按钮出现底部琥珀指示条（与页签同款）。
- 调试**工具**模块（`debug/menu`、`debug/tools`、`debug/midi-keyboard`）**只在 debug 开启时被 import**，
  保证非调试路径不加载；仅 `debug/flag` 的三行开关谓词被静态引入（无副作用、体积可忽略）。

### 3.3 接口

调试工具复用主工具接口（`src/tool.ts`，不另设接口）：

```ts
// src/tool.ts（既有）
export interface Tool {
  id: string
  name: string
  mount(host: HTMLElement): (() => void) | Promise<() => void>
}
```

```ts
// debug/menu.ts —— 菜单组件与外壳的握手：外壳经 onSelect 收到点击，经 handle 同步激活态
export interface DebugMenuHandle {
  setActive(id: string | null): void
}
export function attachDebugMenu(
  header: HTMLElement,
  tools: readonly Tool[],
  onSelect: (id: string) => void,
): DebugMenuHandle
```

```ts
// debug/flag.ts —— 允许注入 search 以便测试
export function isDebugEnabled(search = window.location.search): boolean
```

```ts
// core/midi/input.ts
export type MidiNoteEvent =
  | { type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { type: 'noteOff'; channel: number; pitch: number; velocity: number }
export function parseMidiMessage(data: Uint8Array): MidiNoteEvent | null
```

```ts
// core/midi/note-name.ts
export function midiNoteName(pitch: number): string
```

```ts
// core/midi/held-keys.ts —— 按住键集合（Map：pitch → velocity）→ 音高升序列表
export function sortedHeldPitches(held: ReadonlyMap<number, number>): number[]
```

## 4. 交互与视觉

遵循 `docs/development/design/20260905-ui-visual-style.md`（乌木/象牙/琥珀体系）。

### 4.1 调试按钮 + 下拉菜单

- 位置：顶栏最右（`margin-left: auto` 推右）。
- 触发：鼠标悬浮显示/隐藏下拉（CSS `:hover`）；`click` 亦切换 `.is-open`（兼顾键盘/触摸）。
- 下拉：`--bg-3` 抬升面、`--shadow-toast` 阴影、圆角 `--r-md`；项为无框文字项，hover 用 `--bg-2`。
- 激活态：调试工具激活时按钮文字转主色并显示底部 2px 琥珀指示条（与 `.shell__tab.is-active` 同款）。

### 4.2 内容区页面（与正常工具一致）

- 点击下拉项后，外壳把该调试工具挂载到内容区 `host`：先卸载上一个工具（主/调试皆可），
  页面即该调试工具的内容；再点同一项或切换到页签，走同一卸载路径释放资源。
- 调试工具不新增顶栏页签——入口只有“调试”下拉，但内容区形态与正常工具完全相同。

### 4.3 “MIDI 键盘”页面内容

自上而下（整页居中，内容超出时纵向滚动）：

1. 状态行：`连接中…` / `已连接 · N 台输入` / `未检测到 MIDI 设备` / `当前浏览器不支持 Web MIDI` /
   `MIDI 授权被拒绝`（异常时展示可读文案）。
2. 设备列表：输入端口名称（`name` + `manufacturer`，chip 样式、可换行排布）。
3. 音名 chips：**按住的所有键并显**（展示字体大字号、按音高升序排列、位置稳定、**各键同色**）；
   无按键时显示 `—` 占位。
4. 88 键钢琴键盘（A0–C8）：按住的键以琥珀色点亮，抬起即熄灭。
5. 大谱表（自绘 SVG，暖象牙纸卡片，高音谱号 + 低音谱号）：按住键在对应线/间显示实心符头
   （超出五线时补加线），抬起即消失——**只反映当前按住状态，不记录音符历史**。
6. 三处反馈共用同一份按住键状态；其音高升序列表由纯函数 `sortedHeldPitches`
   （`core/midi/held-keys.ts`）计算，与 DOM 渲染解耦、可单测。

## 5. 消息解析规则（`parseMidiMessage`）

1. 空数据或长度不足 3 字节 → `null`（忽略）。
2. 状态高 4 位 `0x9`（Note On）：
   - velocity > 0 → `noteOn`；
   - velocity = 0 → 按离键 `noteOff`（velocity 记为 0）。
3. 状态高 4 位 `0x8`（Note Off）→ `noteOff`（保留释放力度）。
4. 其余状态（CC/弯音/触后/sysex/realtime 等）→ `null`。
5. 通道号 = 状态低 4 位（0–15）；音符号、力度直接取 data1/data2。

## 6. 资源释放

- `mount` 返回卸载函数：移除每个 `MIDIInput` 的 `midimessage` 监听、移除 `MIDIAccess` 的
  `statechange` 监听；由外壳在切换工具时统一调用（与主工具一致）。
- 主/调试工具互切、页签切换、页面卸载均走同一卸载路径，避免监听泄漏。

## 7. 非目标与后续扩展

- 后续可在 `debug/tools.ts` 注册更多调试工具（复用 `Tool` 接口，外壳无需改动）。
- 若将来主工具要做“MIDI 键盘演奏/录音”，可直接复用 `core/midi/input.ts` 的解析与
  `core/midi/note-name.ts`，把接入层从调试工具升级为共享服务。
