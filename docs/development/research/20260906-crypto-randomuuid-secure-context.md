# 非安全上下文下 crypto.randomUUID 不可用：文件库 id 生成兜底（2026-09-06）

> 调查日期：2026-09-06。本文是研究结论文档；文中引用的外部事实均摘录在
> [参考文档](../reference/browser/webcrypto-secure-context.md)（下称「参考文档」），关键处标注来源 URL。

## 1. 问题背景

用户在 iPad 的 Web MIDI Browser 应用中通过普通 HTTP 地址（如 `http://局域网IP:端口`）打开本应用，导入 MIDI 文件时报错：

```
crypto.randomUUID is not a function
```

出错点为 `FileLibrary.importFiles` 中用 `crypto.randomUUID()` 生成文件库记录 id。报错形态（`crypto` 存在、`randomUUID` 缺失）与「页面处于非安全上下文」一致。

## 2. 调查结论

1. **`crypto.randomUUID()` 仅在安全上下文可用**（HTTPS；`localhost`/`127.0.0.1` 亦被视作安全上下文）。页面经普通 HTTP 加载时处于非安全上下文，此时 `window.crypto` 仍然存在，但 `Crypto.prototype.randomUUID` 不存在，调用即抛 `TypeError: crypto.randomUUID is not a function`（参考文档 §1）。
2. **`crypto.getRandomValues()` 是 `Crypto` 接口中唯一可在非安全上下文使用的方法**（参考文档 §2，MDN 原文）。因此非安全上下文下仍可自行构造密码学强度的 v4 UUID：取 16 随机字节，按 RFC 4122 设置版本位（第 7 字节高 4 位 = `0b0100`）与变体位（第 9 字节高 2 位 = `0b10`），再格式化为 `xxxxxxxx-xxxx-...` 形式。
3. **Web MIDI Browser 的情况**：该 iPad 应用（App Store id 953846217，作者 ryoyakawai）是内嵌 WKWebView 的浏览器，通过原生 CoreMIDI 桥接向页面注入 Web MIDI API 包装（<https://github.com/ryoyakawai/WebMIDIAPIWrapper>），因此 Web MIDI 在 HTTP 页面上也能工作；但它不会改变页面的安全上下文状态，`crypto.randomUUID` 等安全上下文门控的 Web API 在 HTTP 页面下依然缺失。这是「MIDI 正常、randomUUID 报错」这一看似矛盾现象的来源。
4. **与既有结论一致**：本项目的 Web MIDI 输入调查（[20260905-web-midi-input.md](20260905-web-midi-input.md)）已记录「Web MIDI API 只在安全上下文可用」；本调查补充的是 Web Crypto 同样存在安全上下文限制，且本项目此前未对文件库 id 生成做非安全上下文兜底。

## 3. 处理决策

在 `src/storage/uuid.ts` 提供 `randomUUID()` 封装（当前唯一调用方为 `FileLibrary.importFiles`）：

- 检测到原生 `crypto.randomUUID` 时直接使用（安全上下文路径，行为不变）；
- 缺失时用 `crypto.getRandomValues(new Uint8Array(16))` 按 RFC 4122 构造 v4 UUID 兜底（非安全上下文路径，保证 HTTP 部署下导入功能可用）。

理由：本应用面向钢琴练习等实机使用场景，用户通过局域网 HTTP 地址（开发服务器、树莓派/NAS 部署等）访问是合理且常见的方式；为单一 API 增加一层兜底成本极低，即可消除整类「非安全上下文」故障，优于要求用户必须部署 HTTPS。

## 4. 未覆盖事项

- `crypto.randomUUID` 本身的浏览器版本门槛（Safari 15.4+，即 iPadOS 15.4+）不在本次处理范围：兜底路径不依赖 `randomUUID`，对旧系统同样有效。
- 非安全上下文下其它 Web API 的限制（如 CacheStorage、`navigator.storage.persist()` 等）未逐项排查；本次仅处理报错点。

## 5. 参考资料

- 外部资料原文摘录：[../reference/browser/webcrypto-secure-context.md](../reference/browser/webcrypto-secure-context.md)
- MDN Crypto.randomUUID()：<https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID>
- MDN Crypto.getRandomValues()：<https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues>
- Web MIDI Browser（App Store）：<https://apps.apple.com/app/web-midi-browser/id953846217>
- ryoyakawai/WebMIDIAPIWrapper：<https://github.com/ryoyakawai/WebMIDIAPIWrapper>
