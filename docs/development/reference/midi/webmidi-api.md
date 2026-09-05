# Web MIDI API 参考（外部资料摘录）

> 本文件是参考文档：内容为外部资料（MDN Web Docs、caniuse、W3C 规范、MIDI 1.0 消息概要）的直接摘录，不做主观加工。
> 所有资料获取日期为 **2026-09-05**。

## 1. 规范与官方文档

- W3C Web MIDI API 规范（Working Draft）：<https://webaudio.github.io/web-midi-api/>
- MDN Web MIDI API：<https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API>
- MDN `Navigator.requestMIDIAccess()`：<https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMIDIAccess>
- MDN `MIDIMessageEvent`：<https://developer.mozilla.org/en-US/docs/Web/API/MIDIMessageEvent>
- MIDI 1.0 消息概要（MMA）：<https://midi.org/summary-of-midi-1-0-messages>

## 2. 接口总览（MDN）

> The Web MIDI API connects to and interacts with Musical Instrument Digital Interface (MIDI) Devices.
> The interfaces deal with the practical aspects of sending and receiving MIDI messages.

| 接口                  | 作用                                                  |
| --------------------- | ----------------------------------------------------- |
| `MIDIInputMap`        | 所有可用的 MIDI 输入端口                              |
| `MIDIOutputMap`       | 所有可用的 MIDI 输出端口                              |
| `MIDIAccess`          | 列出输入/输出设备、访问单个设备                       |
| `MIDIPort`            | 单个 MIDI 端口                                        |
| `MIDIInput`           | 接收来自输入端口的 MIDI 消息                          |
| `MIDIOutput`          | 向输出端口排队发送消息（可立即或延迟）                |
| `MIDIMessageEvent`    | 传给 `MIDIInput` 的 `midimessage` 事件                |
| `MIDIConnectionEvent` | 传给 `MIDIAccess` 与 `MIDIPort` 的 `statechange` 事件 |

## 3. 安全要求（MDN）

> Access to the API is requested using the `navigator.requestMIDIAccess()` method.
>
> - The method must be called in a **secure context**.
> - Access may be gated by the `midi` HTTP Permission Policy.
> - The user must explicitly grant permission to use the API through a user-agent specific mechanism, or have previously granted permission. Note that if access is denied by a permission policy it cannot be granted by a user permission.

权限状态可用 Permissions API 查询：

```js
navigator.permissions.query({ name: 'midi', sysex: true }).then((result) => {
  if (result.state === 'granted') {
    // Access granted.
  } else if (result.state === 'prompt') {
    // Using API will prompt for permission
  }
  // Permission was denied by user prompt or permission policy
})
```

## 4. `Navigator.requestMIDIAccess()`（MDN）

### 4.1 语法

```
requestMIDIAccess()
requestMIDIAccess(MIDIOptions)
```

`MIDIOptions`：

| 字段       | 类型    | 说明                                                             |
| ---------- | ------- | ---------------------------------------------------------------- |
| `sysex`    | Boolean | 为 `true` 时允许收发 system exclusive (sysex) 消息，默认 `false` |
| `software` | Boolean | 为 `true` 时允许使用已安装的软件合成器，默认 `false`             |

### 4.2 返回值与异常

返回 `Promise<MIDIAccess>`。

| 异常                | 触发条件                                                        |
| ------------------- | --------------------------------------------------------------- |
| `AbortError`        | 页面因导航被关闭                                                |
| `InvalidStateError` | 底层系统抛出错误                                                |
| `NotSupportedError` | 系统不支持该特性或选项                                          |
| `NotAllowedError`   | 用户或系统拒绝（含 Permission Policy 拒绝、用户先前已拒绝权限） |

### 4.3 示例

```js
navigator.requestMIDIAccess().then((access) => {
  const inputs = access.inputs.values()
  const outputs = access.outputs.values()
  // …
})
```

## 5. 收发消息（MDN）

### 5.1 列出输入/输出端口

```js
for (const entry of midiAccess.inputs) {
  const input = entry[1]
  console.log(
    `Input port [type:'${input.type}'] id:'${input.id}'` +
      ` manufacturer:'${input.manufacturer}' name:'${input.name}' version:'${input.version}'`,
  )
}
```

### 5.2 处理输入消息

```js
function onMIDIMessage(event) {
  let str = `MIDI message received at timestamp ${event.timeStamp}[${event.data.length} bytes]: `
  for (const character of event.data) {
    str += `0x${character.toString(16)} `
  }
  console.log(str)
}

function startLoggingMIDIInput(midiAccess) {
  midiAccess.inputs.forEach((entry) => {
    entry.onmidimessage = onMIDIMessage
  })
}
```

## 6. `MIDIMessageEvent`（MDN）

> The `MIDIMessageEvent` interface of the Web MIDI API represents the event passed to the `midimessage` event of the `MIDIInput` interface. A `midimessage` event is fired every time a MIDI message is sent from a device represented by a `MIDIInput`, for example when a MIDI keyboard key is pressed, a knob is tweaked, or a slider is moved.

| 属性 | 类型         | 说明                                                                                          |
| ---- | ------------ | --------------------------------------------------------------------------------------------- |
| data | `Uint8Array` | 单条 MIDI 消息的数据字节，格式见 MIDI 规范（<https://midi.org/summary-of-midi-1-0-messages>） |

```js
navigator.requestMIDIAccess().then((midiAccess) => {
  Array.from(midiAccess.inputs).forEach((input) => {
    input[1].onmidimessage = (msg) => {
      console.log(msg)
    }
  })
})
```

## 7. 浏览器兼容性（caniuse，2026-08 数据）

来源：<https://caniuse.com/midi>（全局使用率 80.88%）。

| 浏览器           | 支持情况                                      |
| ---------------- | --------------------------------------------- |
| Chrome           | 43+ 支持                                      |
| Edge             | 79+ 支持                                      |
| Firefox          | 108+ 支持（桌面）；Firefox for Android 不支持 |
| Safari（macOS）  | 不支持（WebKit bug #107250 未解决）           |
| Safari（iOS）    | 不支持                                        |
| Opera            | 30+ 支持                                      |
| Samsung Internet | 支持                                          |

> 特性标记为“Not Baseline”：因为 Safari 不支持，不满足 Baseline 条件。
> 相关 bug：WebKit <https://bugs.webkit.org/show_bug.cgi?id=107250>；Firefox <https://bugzilla.mozilla.org/show_bug.cgi?id=836897>。

## 8. MIDI 1.0 通道声音消息要点（用于按键识别）

MIDI 1.0 通道声音消息（channel voice messages）的状态字节高 4 位为消息类型、低 4 位为通道号（0–15）：

| 消息     | 状态字节      | data1           | data2                  |
| -------- | ------------- | --------------- | ---------------------- |
| Note On  | `0x90`–`0x9F` | 音符号（0–127） | 力度 velocity（0–127） |
| Note Off | `0x80`–`0x8F` | 音符号（0–127） | 释放力度（0–127）      |

> 惯例：Note On 且 velocity = 0 等价于 Note Off。
> （依据 MIDI 1.0 消息概要 <https://midi.org/summary-of-midi-1-0-messages>）

音符号 60 = 中央 C（C4，科学音高记号），69 = A4（标准音 440 Hz）。
