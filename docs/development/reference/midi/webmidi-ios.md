# Web MIDI 在 iOS/iPadOS 上的现状与替代方案参考（外部资料摘录）

> 本文件是参考文档：内容为外部资料（caniuse、App Store、GitHub README、ESP-IDF 源码头文件、
> webmidijs.org）的直接摘录，不做主观加工。所有资料获取日期为 **2026-09-06**。

## 1. 浏览器支持现状（caniuse，2026-08 数据）

来源：<https://caniuse.com/midi>

- Safari（桌面）：3.1–26.5 ❌ 不支持；26.6 ❌；27–TP ❌。
- **Safari on iOS：3.2–26.5 ❌ 不支持；26.6 ❌ 不支持。**
- Chrome：43–151 ✅、152–155 ✅。
- Firefox：108–158 ✅。
- Edge：79–152 ✅。
- 全局使用率：80.88%。
- Resources 一栏给出 [WebKit support bug](https://bugs.webkit.org/show_bug.cgi?id=107250)
  与 [Polyfill](https://github.com/cwilso/WebMIDIAPIShim) 两个链接。

## 2. Apple 官方立场（webmidijs.org 转述）

来源：<https://webmidijs.org/docs/getting-started>（Supported Environments）

> Note that, in 2020, [Apple has announced](https://webkit.org/tracking-prevention/) that they
> would not natively support the Web MIDI API (and a host of other APIs) in Safari because of
> fingerprinting concerns.

即：Apple 在 2020 年的智能跟踪预防公告中已表态，因指纹识别担忧不会在 Safari 原生支持 Web MIDI
API（连同其它一批 API）。WebKit bug #107250（<https://bugs.webkit.org/show_bug.cgi?id=107250>）
长期开放。

## 3. Web MIDI Browser App（App Store，id953846217）

来源：<https://apps.apple.com/app/web-midi-browser/id953846217>

- 免费；**专为 iPad 设计**；类别「音乐」；开发者 Takashi Mizuhiki。
- 简介原文：

  > Web MIDI Browser is a web browser for browsing Web Apps made with Web MIDI API. Web MIDI
  > Browser can activate the Bluetooth MIDI functionality which is a new function of iOS 8.
  > Instruments which support Bluetooth MIDI connectivity can be connected to Web Apps by using
  > this App. … Web MIDI browser can bridge both worlds in iOS.

- 版本历史：最新版本 1.0.6，2016/03/23（App Store 页面另注“已由 Apple 更新以准备 watchOS 27
  兼容性”，非新功能）。
- 兼容性：iOS/iPadOS 9.0+；iPhone/iPad/Apple Watch；Mac（M1+，macOS 11+）。
- 相关开源项目：作者同人的 [WebMIDIAPIShimForiOS](https://github.com/mizuhiki/WebMIDIAPIShimForiOS)。

## 4. cordova-plugin-webmidi（recifra，npm）

来源：<https://github.com/recifra/cordova-plugin-webmidi>（README）

> This is a shim to enable [Web MIDI API](http://www.w3.org/TR/webmidi/) on iOS.
> [WebMIDIAPIPolyfill.js](WebMIDIAPIPolyfill/WebMIDIAPIPolyfill.js) is the bridge script to invoke
> iOS native Core MIDI APIs. And [WebViewDelegate.m](WebMIDIAPIPolyfill/WebViewDelegate.m) is the
> receptor for informal URL schemes triggered by the bridge script. You can build a hybrid Web MIDI
> application with using them.
>
> When launching the sample application, a simple web browser will show. You can run Web MIDI
> applications using the browser as if iOS WebKit had a native API support.
>
> This project is based on [WebMIDIAPIShimForiOS](https://github.com/mizuhiki/WebMIDIAPIShimForiOS)
> The idea was brought from [WebMIDIAPIShim](https://github.com/cwilso/WebMIDIAPIShim) by Chris
> Wilson. WebMIDIAPIPolyfill.js in this project was derived from his great work.

License：Apache License 2.0。

## 5. WebMIDIKit（adamnemecek，Swift）

来源：<https://github.com/adamnemecek/WebMIDIKit>（README）

> WebMIDIKit is an implementation of the WebMIDI API for macOS/iOS. On these OS, the native
> framework for working with MIDI is [CoreMIDI](https://developer.apple.com/reference/coremidi).
> CoreMIDI is old and the API is entirely in C …
>
> WebMIDIKit is a part of the [AudioKit](https://github.com/audiokit/audiokit) project and will
> eventually replace AudioKit's MIDI implementation.

- 用法摘录：`let midi: MIDIAccess = MIDIAccess()`；`inputPort.onMIDIMessage = { ... }`；
  `outputPort.send(noteOn).send(noteOff, offset: 1000)`；支持 `onStateChange`、虚拟端口。
- 注意：该库是**原生侧**库（Swift 封装 Core MIDI），不包含 JS ↔ 原生 桥接层，桥接需自行
  实现（如 WKWebView 的 `WKScriptMessageHandler`）。

## 6. iOS 上 Web Bluetooth 的现状与扩展 polyfill（caniuse，2026-08 数据）

来源：<https://caniuse.com/web-bluetooth>

- Safari（桌面）与 **Safari on iOS：3.2–26.6 ❌ 不支持**（27–TP 亦不支持）。
- 备注原文：

  > Safari on iOS and iPadOS has no native support. A third-party Safari web extension,
  > iOSWebBLE, polyfills `navigator.bluetooth` in JavaScript by bridging to CoreBluetooth, so a
  > website can use Web Bluetooth once a user installs and enables the extension. This is
  > userland support and not part of WebKit, so the support status above stays unsupported.

- iOSWebBLE 的 SDK：<https://github.com/wklm/beacio-sdk>（"Web Bluetooth SDK for iOS Safari —
  https://beacio.com"；配套 App「beacio」，App Store id6761301368）。

## 7. BLE-MIDI GATT UUID（ESP-IDF esp_ble_midi.h 摘录）

来源：<https://github.com/espressif/esp-iot-solution>（`components/bluetooth/ble_profiles/third_party/ble_midi/include/esp_ble_midi.h`）

> ```
> /**
>  * BLE MIDI Service UUID (128-bit): 03B80E5A-EDE8-4B33-A751-6CE34EC4C700
>  */
> #define BLE_MIDI_SERVICE_UUID128 ...
>
> /**
>  * BLE MIDI IO Characteristic UUID (128-bit): 7772E5DB-3868-4112-A1A9-F2669D106BF3
>  */
> #define BLE_MIDI_CHAR_UUID128 ...
> ```

- BLE-MIDI 事件包（BEP）携带 **13 位滚动时间戳（1 ms 分辨率，8192 回绕）**
  （`ESP_BLE_MIDI_TIMESTAMP_MAX 0x1FFF`），每条 MIDI 消息前带时间戳字节。
