# Web MIDI 连接长期停留在“连接中”的成因与定位手段调查（2026-09-06）

> 调查日期：2026-09-06。起因：用户反馈“MIDI 键盘”调试页面一直显示“连接中…”。
> 本文是研究结论文档；引用的外部事实摘录在
> [参考文档](../reference/midi/webmidi-api.md)（下称“参考文档”），关键处标注来源 URL。
> 未找到权威依据的成因明确标注为**推测**，不作为结论使用。

## 1. 结论摘要（TL;DR）

1. 调试页“连接中…”恒显示，**等价于 `navigator.requestMIDIAccess()` 返回的 Promise 既不
   resolve 也不 reject**（见 §2 代码路径）。原实现没有超时、没有诊断信息，因此页面无法
   自行区分成因。
2. 该 Promise 的落定与**用户对浏览器授权提示的应答**绑定：用户未应答时请求一直等待
   （参考文档 §3：用户必须通过浏览器特定机制显式授权）。授权提示被忽略、被遮挡、未弹出
   是最常见的“一直连接中”成因。
3. 其余成因：浏览器/系统 MIDI 服务异常（**推测**：Linux 下无 MIDI 设备或 ALSA/udev
   异常时 Chromium 后端可能长期不返回；已有先例是 Linux 内核 6.5 回归导致 Web MIDI
   应用不可用，见 §5 参考资料 4）；页面嵌在 iframe 且宿主 Permissions-Policy 不允许
   `midi` 时按规范应 reject `NotAllowedError`（参考文档 §3.1），但授权提示被抑制时
   可能表现为长期不落定（**推测**）。
4. 定位手段（§4）：安全上下文检查、API 存在性检查、Permissions API 查询 `midi` 权限
   状态（granted / prompt / denied）、浏览器站点权限设置、`chrome://device-log`、
   跨浏览器对照。这些手段已内建到调试页的诊断面板（见设计文档 20260905-debug-tools.md
   §4.3）。
5. 项目措施：调试页增加诊断面板（安全上下文 / Web MIDI API 可用性 / midi 权限状态 /
   连接阶段实时耗时）、5s 超时提示与“重试连接”按钮、全部状态变化写入 Console
   （`[midi-debug]` 前缀）；超时不放弃在途请求，晚到的结果按真实状态呈现。
   超时阈值复用共享服务的 `CONNECT_TIMEOUT_MS`（5000ms，见设计文档
   20260906-midi-keyboard-and-practice.md §3.1）。

## 2. 现象与代码路径

`src/debug/midi-keyboard.ts` 原实现：挂载时把状态行置为“连接中…”，随后调用
`requestMIDIAccess()`；resolve 后按设备数显示“已连接 / 未检测到”，reject 按异常名显示
“被拒绝 / 不支持 / 失败”。也就是说，**只要 Promise 不落定，状态行就永远停在“连接中…”**，
没有任何超时与线索。

## 3. 成因分析

| #   | 成因                                         | 依据                                                    | 页面表现                                                     |
| --- | -------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | 授权提示未应答（被忽略/被遮挡/未弹出）       | 参考文档 §3：用户必须显式授权，授权经浏览器特定机制完成 | 一直“连接中…”；权限状态为 prompt                             |
| 2   | 浏览器/系统 MIDI 服务异常                    | **推测**（无权威 bug 报告支撑）                         | 一直“连接中…”；权限状态可能已 granted                        |
| 3   | iframe 宿主 Permissions-Policy 不允许 `midi` | 参考文档 §3.1：策略拒绝时 reject `NotAllowedError`      | 按规范应显示“被拒绝”；提示被抑制时可能长期不落定（**推测**） |
| 4   | 浏览器不支持 / 非安全上下文                  | 参考文档 §3：安全上下文要求；§7：Safari 不支持          | 立即显示“不支持”（API 缺失），不会停在“连接中…”              |
| 5   | 用户已拒绝授权                               | 参考文档 §4.2：reject `NotAllowedError`                 | 立即显示“被拒绝”，不会停在“连接中…”                          |

排查时应优先验证成因 1（权限状态是否为 prompt），再考虑成因 2/3。

## 4. 定位手段

手动定位（开发者工具 Console）：

```js
window.isSecureContext // 必须 true（HTTPS / localhost）
typeof navigator.requestMIDIAccess // 必须 'function'
navigator.permissions.query({ name: 'midi' }).then((r) => console.log('midi 权限:', r.state)) // granted / prompt / denied
// 单独发起一次请求，观察是否落定：
navigator
  .requestMIDIAccess({ sysex: false })
  .then((a) => console.log('resolved, inputs =', a.inputs.size))
  .catch((e) => console.error(e.name, e.message))
```

- 权限状态为 `prompt` 且请求挂起 → 授权提示未应答：检查地址栏左侧权限图标，或到
  `chrome://settings/content/midiDevices` 查看/修改本站点权限；
- 权限已 `granted` 仍挂起 → 平台层问题：查看 `chrome://device-log` 的 MIDI 设备枚举
  日志，重启浏览器或换浏览器（Firefox）对照；
- 立即 reject `NotAllowedError` → 站点权限被屏蔽或 iframe 权限策略不允许（参考文档 §3.1）；
- `requestMIDIAccess` 为 undefined → 非安全上下文或不支持的浏览器（参考文档 §3、§7）。

## 5. 参考资料

1. 参考文档：`docs/development/reference/midi/webmidi-api.md`
   （§3 安全要求、§3.1 Permissions-Policy midi、§4.2 异常表、§7 兼容性）
2. MDN Permissions-Policy `midi`：<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/midi>
3. MDN Web MIDI API：<https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API>
4. Launchpad bug 2043299（Linux 6.5 内核回归破坏 Web MIDI 应用，平台层故障先例）：
   <https://bugs.launchpad.net/ubuntu/+source/linux/+bug/2043299>
