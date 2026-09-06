# iPad（WebKit）无 Web MIDI 的替代方案调查（2026-09-06）

> 调查日期：2026-09-06。本文是研究结论文档；文中引用的外部事实均摘录在
> [参考文档](../reference/midi/webmidi-ios.md)（下称“参考文档”），关键处标注来源 URL。

## 1. 结论摘要（TL;DR）

iPad 上所有浏览器（Safari、Chrome、Edge…）都被迫使用 WebKit 内核，而 Web MIDI 至今未进
WebKit，且 **Apple 已于 2020 年公开表态（指纹识别担忧）不会在 Safari 原生支持 Web MIDI**
（参考文档 §1、§2）。“换浏览器”与“等苹果”都不是出路。可行路径有四条：

| 方案                                                | 代码改动                     | 用户门槛               | 硬件覆盖                    | 定位              |
| --------------------------------------------------- | ---------------------------- | ---------------------- | --------------------------- | ----------------- |
| A. 第三方 MIDI 浏览器 App（Web MIDI Browser）       | 零                           | 装 App、在其中打开站点 | USB + BLE（Core MIDI 全量） | 快速验证体验      |
| B. 原生壳包装（WKWebView/Capacitor + Core MIDI 桥） | 零（App 侧），新增原生壳工程 | 装 App                 | USB + BLE（Core MIDI 全量） | 产品化正路        |
| C. BLE MIDI 经 Web Bluetooth 扩展（beacio）         | 中（新写 BLE MIDI provider） | 装扩展 + 蓝牙键盘      | 仅 BLE 键盘                 | Safari 内原生体验 |
| D. 屏上琴键兜底（纯 Web）                           | 小                           | 无                     | 无（不接外设）              | 所有平台兜底      |

**推荐**：先用 A 做零成本验证；决定认真支持 iPad 时走 B（App 代码零改动，接缝已具备）；
键盘支持蓝牙且想留在 Safari 的走 C；无论哪条，D 都值得作为无外设场景的兜底。

## 2. 背景：为什么 iPad 上不行

- **iPadOS 强制 WebKit**：第三方浏览器在 iPad 上只能套 WebKit（Apple 政策），因此
  Chrome/Firefox/Edge 的 iPad 版同样没有 Web MIDI——不支持不是“Safari”的问题，是
  **平台**问题。
- **Apple 已明确不做**：2020 年智能跟踪预防公告表态因指纹担忧不原生支持 Web MIDI 等
  一批 API（参考文档 §2）；WebKit bug #107250 至今开放（参考文档 §1）。
- **连带影响**：iOS 上 Web Bluetooth 同样不支持（BLE MIDI 的直接通道也被堵死），但存在
  **Safari 扩展 polyfill**（iOSWebBLE/beacio，经 CoreBluetooth 桥接 `navigator.bluetooth`，
  参考文档 §6）——这是 C 方案的基础。

## 3. 本项目 MIDI 依赖面盘点

排查 `src/` 后确认，Web MIDI 的触点收敛在极少几处（这是所有替代方案都能低成本落地的关键）：

| 触点     | 位置                                              | 职责                                                                    |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| 输入接入 | `src/core/midi/connection.ts`（`MidiConnection`） | `navigator.requestMIDIAccess()` → 挂 `MIDIInput` → 解码 `MidiNoteEvent` |
| 消息解析 | `src/core/midi/input.ts`（`parseMidiMessage`）    | 纯函数，与浏览器无关                                                    |
| 输出镜像 | `src/core/midi/output.ts`（`MidiOutputSink`）     | 走带排期音符 → `MIDIOutput.send()`（键盘音源同步）                      |
| 调试工具 | `src/debug/midi-keyboard.ts`                      | 同用 `navigator.requestMIDIAccess`（参考实现，独立）                    |

结论：**只要在 JS 侧把 `navigator.requestMIDIAccess` / `MIDIInput` / `MIDIOutput` 的 API
形状补齐（polyfill），应用代码一行都不用改**——练习模式、播放镜像、调试工具全部照常工作。
A、B 都属于这一类；C 需要新写一个“BLE MIDI 连接 provider”接在 `MidiConnection` 同等的
接口后面（或提供等价的 `requestMIDIAccess` polyfill），是四者中唯一动应用代码的。

## 4. 方案评估

### A. Web MIDI Browser（第三方 App，零代码）

App Store 免费 App「Web MIDI Browser」（Takashi Mizuhiki，专为 iPad 设计）内置了
Core MIDI（USB + Bluetooth MIDI）到 Web MIDI API 的桥，在其内打开本应用站点即可用
MIDI 键盘练习（参考文档 §3）。

- 优点：零开发成本；输入/输出都支持。
- 缺点：App 2016 年后无功能更新（v1.0.6）；体验受制于第三方浏览器（无地址栏收藏体验
  一般、隐私说明缺失）；只能作为验证手段，不适合作为产品交付。
- 结论：**适合今天就能在 iPad 上验证“练习模式 + 硬件键盘”体验**。

### B. 原生壳包装（产品化正路）

把现有 web 构建产物包进 iPadOS App（WKWebView，可用 Capacitor 或纯 Xcode 工程），
原生侧用 Core MIDI 接管设备，JS 侧注入 `requestMIDIAccess` polyfill 桥接。

- 已有参考实现：`cordova-plugin-webmidi`（URL scheme 桥，基于 WebMIDIAPIShimForiOS；
  参考文档 §4）；原生侧可用 **WebMIDIKit**（Swift 封装 Core MIDI 成 Web MIDI 形状的 API，
  参考文档 §5）配合 `WKScriptMessageHandler` 自写桥（现代做法，比 URL scheme 干净）。
- 优点：App 代码零改动；USB + BLE 全量；体验可控（图标/全屏/离线）。
- 缺点：需要 Xcode 构建、Apple Developer 账号（分发需上架/签名）、审校维护成本；桥接层
  要覆盖本项目用到的能力面（输入枚举/热插拔 `statechange`/输出 `send`+`clear` 时间戳）。
- 结论：**认真做 iPad 支持时的正路**。

### C. BLE MIDI 经 Web Bluetooth 扩展（留在 Safari）

iPad 安装 beacio（iOSWebBLE）Safari 扩展后，网页可用 Web Bluetooth（经 CoreBluetooth）；
本项目再实现 BLE-MIDI 协议解析（GATT 服务 `03B80E5A-…`、MIDI Data I/O 特征
`7772E5DB-…`、13 位滚动时间戳，参考文档 §7），作为 `MidiConnection` 的备选接入
（或注入等价 `requestMIDIAccess` polyfill）。

- 优点：用户留在 Safari 原生体验；不建 App 工程。
- 缺点：只覆盖**蓝牙 MIDI 键盘**；USB-only 键盘需 CME WIDI / Yamaha MD-BT01 等
  USB→BLE 适配器；要求用户装扩展（有门槛）；BLE MIDI 无 `statechange` 热插拔语义、
  端口枚举与输出镜像需自行适配——工作量中等，且是四者中唯一需要动应用代码的。
- 结论：**键盘本身支持蓝牙时的轻量路线**，可作 B 的补充而非替代。

### D. 屏上琴键兜底（纯 Web）

项目调试工具已实现屏上钢琴键盘（`src/debug/midi-keyboard.ts`）；把触摸按键事件转换为
`MidiNoteEvent` 注入既有管线（`PracticeController` 的 gate / `transport.liveNoteOn`），
即可让 iPad（乃至手机）在**没有任何外设**的情况下使用练习模式。

- 优点：零门槛、零依赖、所有平台可用；也是 B/C 之外的无外设体验补充。
- 缺点：不是硬件 MIDI，无触感，只能单手、和声练习受限。
- 结论：**作为永久兜底体验纳入规划**，与 A/B/C 不冲突。

## 5. 推荐路线

1. **立即验证**：部署站点，用 A（Web MIDI Browser）在 iPad 上验证练习模式全流程；
2. **产品化**：体验确认后走 B（原生壳 + Core MIDI 桥），App 代码零改动；
3. **Safari 路线**：目标用户键盘多为蓝牙 MIDI 时，评估 C（beacio + BLE provider）；
4. **并行兜底**：D（屏上琴键）作为所有平台无外设场景的体验兜底；
5. 当前 `unsupported` 状态已有 UI 提示（“当前浏览器不支持 Web MIDI”），若落 A/C 可把
   该提示在 iPad 上替换为对应引导文案（指向 App/扩展）。

## 6. 对实现的影响

本调查只产出结论；若采纳 B 或 C，需另立设计文档（原生壳工程结构 / BLE provider 接口）。
核心接缝不变：`MidiConnection` 与 `MidiOutputSink` 之上的所有代码（practice、transport、
UI）无需感知底层接入方式。

## 7. Web MIDI Browser 卡在“连接中”的成因（补充）

结合用户反馈与桥接源码（WebMIDIAPIShimForiOS 的 `WebMIDIAPIPolyfill.js`）实测确认，方案 A
（Web MIDI Browser）在使用时的两个具体表现，已落实到 `src/debug/midi-keyboard.ts` 的连接诊断面板：

1. **`requestMIDIAccess` 返回非原生 Promise**：shim 的 `requestMIDIAccess` 返回一个自定义 Promise
   （只实现了 `then`，非标准 Promise），它要等 App 原生侧（Core MIDI 桥）经 `_callback_onReady`
   回调才 resolve。因此页面长期显示“连接中…”等价于 **App 原生桥未返回**——常见原因是 MIDI 键盘未
   连接 / 未被 App 识别（USB 需连好并允许外设访问、蓝牙需先配对），或 App 本身异常（2016 年后
   未更新）。这不是网页代码可修复的，属用户侧操作或 App 局限。
2. **Permissions API 无法查询 midi 权限**：shim 不注入 `navigator.permissions`，WebKit 的
   Permissions API 对 `query({ name: 'midi' })` 抛 `NotSupportedError`（个别实现抛 `TypeError`）。
   这是平台限制，与连接是否成功无关，诊断面板应显示为中性信息而非错误。

此外，shim 不要求安全上下文（HTTP 即可用），因此检测到 shim 时“非安全上下文”不应判为连接故障。

## 8. 参考资料

- 参考文档：`docs/development/reference/midi/webmidi-ios.md`
- caniuse Web MIDI：<https://caniuse.com/midi>
- WebKit bug #107250：<https://bugs.webkit.org/show_bug.cgi?id=107250>
- Apple 智能跟踪预防公告：<https://webkit.org/tracking-prevention/>
- Web MIDI Browser App：<https://apps.apple.com/app/web-midi-browser/id953846217>
- cordova-plugin-webmidi：<https://github.com/recifra/cordova-plugin-webmidi>
- WebMIDIKit：<https://github.com/adamnemecek/WebMIDIKit>
- caniuse Web Bluetooth：<https://caniuse.com/web-bluetooth>
- beacio SDK（iOSWebBLE）：<https://github.com/wklm/beacio-sdk>
- ESP-IDF esp_ble_midi.h：<https://github.com/espressif/esp-iot-solution>
