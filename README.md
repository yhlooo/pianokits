# PianoKits

> **🏗️ 该项目还处于较早期阶段。随时可能发生破坏性变更。**

MIDI 钢琴工具箱，在线体验： [https://yhlooo.github.io/pianokits](https://yhlooo.github.io/pianokits)

**已实现工具：**

- 播放 / 练习：播放 MIDI 文件（ .mid ）
  - 瀑布流展示音符与踏板轨道
  - MIDI 转五线谱 (beta)
  - 连接 MIDI 键盘播放
  - 连接 MIDI 键盘进行按键练习，支持分轨练习与踏板练习（关 / 仅延音踏板 / 全部踏板）
- 录音：连接 MIDI 键盘录制 MIDI 信号（非麦克风录音），导出 `.mid` 文件或保存到播放器音乐库

## 连接 MIDI 键盘

该应用可通过 USB 等方式连接 MIDI 键盘，插入 MIDI 转 USB 线，在页面上点击“连接 MIDI 键盘”即可。连接过程可能会弹窗请求授权。

连接 MIDI 键盘后可使用通过 MIDI 键盘播放、按键练习等功能。

**浏览器兼容性：**

- Mac / Windows 端需使用 Chrome 或 Chromium 内核（ Edge 等）浏览器打开，不支持 Safari 。
- iPad / iPhone 由于主流浏览器受苹果限制必须使用 Webkit 内核，该内核不支持 Web MIDI 协议。可以使用 [Web MIDI Browser](https://apps.apple.com/cn/app/web-midi-browser/id953846217) 应用打开。
