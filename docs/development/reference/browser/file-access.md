# 浏览器文件访问与持久化存储：外部资料摘录（reference）

> 本文件为外部技术资料的直接摘录（原文或原文翻译），不做主观加工，用于支撑 `docs/development/research/20260905-file-persistence.md` 中的调查结论。
>
> 摘录格式：英文原文摘录自各页面，关键段落附中文译文（以「译」标注）。所有资料获取日期均为 **2026-09-05**，除非单独注明。

- [1. File System Access API 概述（MDN）](#1-file-system-access-api-概述mdn)
- [2. Window.showOpenFilePicker()（MDN）](#2-windowshowopenfilepicker-mdn)
- [3. FileSystemFileHandle（MDN）](#3-filesystemfilehandle-mdn)
- [4. FileSystemHandle.queryPermission() / requestPermission()（MDN）](#4-filesystemhandlequerypermission--requestpermission-mdn)
- [5. 权限持久化规则](#5-权限持久化规则)
  - [5.1 Chrome 官方博客：Persistent permissions for the File System Access API](#51-chrome-官方博客persistent-permissions-for-the-file-system-access-api)
  - [5.2 Chrome 官方博客：One-time permissions](#52-chrome-官方博客one-time-permissions)
  - [5.3 WICG File System Access 规范：Permissions 章节](#53-wicg-file-system-access-规范permissions-章节)
- [6. 浏览器支持数据（MDN BCD / caniuse）](#6-浏览器支持数据mdn-bcd--caniuse)
- [7. Firefox 相关发布说明（MDN）](#7-firefox-相关发布说明mdn)
- [8. IndexedDB 与结构化克隆（MDN）](#8-indexeddb-与结构化克隆mdn)
- [9. 存储配额与驱逐（MDN）](#9-存储配额与驱逐mdn)
- [10. StorageManager.persist() / estimate()（MDN）](#10-storagemanagerpersist--estimate-mdn)
- [11. Origin Private File System（OPFS，MDN）](#11-origin-private-file-systemopfs-mdn)
- [12. web.dev：Persistent storage](#12-webdevpersistent-storage)
- [13. 来源链接汇总](#13-来源链接汇总)

---

## 1. File System Access API 概述（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/File_System_API>（获取日期 2026-09-05，内容取自 MDN 内容仓库 main 分支对应页面）

> The **File System API** — with extensions provided via the **File System Access API** to access files on the device file system — allows read, write and file management capabilities.
>
> Most of the interaction with files and directories is accomplished through handles. A parent `FileSystemHandle` class helps define two child classes: `FileSystemFileHandle` and `FileSystemDirectoryHandle`, for files and directories respectively.
>
> The handles represent a file or directory on the user's system. You can first gain access to them by showing the user a file or directory picker using methods such as `window.showOpenFilePicker()` and `window.showDirectoryPicker()`. Once these are called, the file picker presents itself and the user selects either a file or directory. Once this happens successfully, a handle is returned.
>
> 译：File System API（通过 File System Access API 扩展，用于访问设备文件系统上的文件）提供读、写和文件管理能力。对文件和目录的交互大多通过 handle 完成：`FileSystemHandle` 父类下有两个子类 `FileSystemFileHandle`（文件）和 `FileSystemDirectoryHandle`（目录）。handle 代表用户系统上的文件或目录，可通过 `window.showOpenFilePicker()` 等选择器获得。

> [!NOTE]
> Objects based on {{domxref("FileSystemHandle")}} can also be serialized into an {{domxref("IndexedDB API", "IndexedDB", "", "nocode")}} database instance, or transferred via {{domxref("window.postMessage", "postMessage()")}}.
>
> 译：基于 `FileSystemHandle` 的对象可以被序列化进 IndexedDB 数据库实例，也可以通过 `postMessage()` 传递。

关于 OPFS 的概述原文（同页面）：

> The origin private file system (OPFS) is a storage endpoint provided as part of the File System API, which is private to the origin of the page and not visible to the user like the regular file system. It provides access to a special kind of file that is highly optimized for performance and offers in-place write access to its content.
>
> 译：源私有文件系统（OPFS）是 File System API 提供的一个存储端点，对页面源（origin）私有，不像常规文件系统那样对用户可见。它提供一种为性能高度优化、支持原地写入的特殊文件。

## 2. Window.showOpenFilePicker（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker>（获取日期 2026-09-05）

> The **`showOpenFilePicker()`** method of the `Window` interface shows a file picker that allows a user to select a file or multiple files and returns a handle for the file(s).
>
> 译：`Window` 接口的 `showOpenFilePicker()` 方法显示一个文件选择器，允许用户选择一个或多个文件，并返回这些文件的 handle。

语法与参数（原文节选）：

```js
showOpenFilePicker()
showOpenFilePicker(options)
```

- `excludeAcceptAllOption`：布尔值，默认 `false`。设为 `true` 时不提供"不过滤类型"选项。
- `id`：通过指定 ID，浏览器可以为不同 ID 记住不同的目录。
- `multiple`：布尔值，默认 `false`。设为 `true` 时允许选择多个文件。
- `startIn`：一个 `FileSystemHandle` 或一个知名目录（`"desktop"`、`"documents"`、`"downloads"`、`"music"`、`"pictures"`、`"videos"`），用于指定对话框打开位置。
- `types`：允许选择的文件类型数组。每项含 `description`（可选描述）与 `accept`（MIME 类型 → 扩展名数组的映射）。

返回值（原文）：

> **Return value**: A {{jsxref("Promise")}} whose fulfillment handler receives an {{jsxref('Array')}} of {{domxref('FileSystemFileHandle')}} objects.
>
> 译：返回一个 Promise，其履行回调收到一个 `FileSystemFileHandle` 对象数组。

异常（原文节选）：

- `AbortError`：用户未做选择即关闭提示框，或用户代理认为所选文件过于敏感或危险时抛出。
- `SecurityError`：调用被同源策略阻止，**或调用并非经由用户交互（如按钮点击）触发**时抛出。

安全要求（原文）：

> **Security**: [Transient user activation](/en-US/docs/Web/Security/Defenses/User_activation) is required. The user has to interact with the page or a UI element in order for this feature to work.
>
> 译：需要瞬时用户激活（transient user activation）。用户必须先与页面或某个 UI 元素交互，此功能才能工作。

> 注意：该页面标注此 API 状态为 experimental（实验性），页面标记为 "Secure context"（要求安全上下文，即 HTTPS 或 localhost）。

## 3. FileSystemFileHandle（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle>（获取日期 2026-09-05）

> The **`FileSystemFileHandle`** interface of the File System API represents a handle to a file system entry. The interface is accessed through the `window.showOpenFilePicker()` method.
>
> Note that read and write operations depend on file-access permissions that do not persist after a page refresh if no other tabs for that origin remain open. The {{domxref("FileSystemHandle.queryPermission()", "queryPermission")}} method of the {{domxref("FileSystemHandle")}} interface can be used to verify permission state before accessing a file.
>
> 译：`FileSystemFileHandle` 接口代表一个文件系统条目的 handle，通过 `window.showOpenFilePicker()` 获得。注意：读写操作依赖文件访问权限；如果该源没有其它打开的标签页，权限在页面刷新后不会保留。可用 `FileSystemHandle` 接口的 `queryPermission` 方法在访问文件前验证权限状态。
>
> （备注：此句描述的是默认的"会话级"权限行为；Chrome 122 起的"永久授权"选项是例外，见本文档 5.1 节。）

实例方法（原文节选）：

- `getFile()`：Returns a {{jsxref('Promise')}} which resolves to a {{domxref('File')}} object **representing the state on disk of the entry** represented by the handle.
  - 译：返回一个 Promise，解析为表示该 handle 所代表条目**在磁盘上的当前状态**的 `File` 对象。（即每次调用都读取磁盘最新内容。）
- `createWritable()`：返回 Promise，解析为可用于写文件的 `FileSystemWritableFileStream`。
- `createSyncAccessHandle()`：返回 Promise，解析为 `FileSystemSyncAccessHandle`，用于同步读写文件；**仅限专用 Web Worker 内使用**。

## 4. FileSystemHandle.queryPermission / requestPermission（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission>、<https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission>（获取日期 2026-09-05）

`queryPermission(descriptor)`（原文）：

> The **`queryPermission()`** method of the `FileSystemHandle` interface queries the current permission state of the current handle.
>
> **Return value**: A `Promise` that resolves with `PermissionStatus.state` which is one of `'granted'`, `'denied'` or `'prompt'`.
>
> If this resolves with "prompt", the website will have to call `requestPermission()` before any operations on the handle can be done. If this resolves with "denied" any operations will reject. Usually handles returned by the local file system handle factories will initially resolves with "granted" for their read permission state. However, other than through the user revoking permission, a handle retrieved from IndexedDB is also likely to resolves with "prompt".
>
> 译：`queryPermission()` 查询当前 handle 的权限状态，解析为 `'granted'` / `'denied'` / `'prompt'` 之一。若为 `"prompt"`，网站必须先调用 `requestPermission()` 才能对该 handle 做任何操作；若为 `"denied"`，所有操作都会被拒绝。通常由本地文件系统 handle 工厂（即选择器）返回的 handle，其读权限状态初始为 `"granted"`；而除了用户主动撤销权限的情形之外，**从 IndexedDB 取出的 handle 也很有可能解析为 `"prompt"`**。
>
> （备注：MDN 此句未反映 Chrome 122+ 永久授权的情况——获得永久授权后，从 IndexedDB 取出的 handle 可继续解析为 `granted`，详见 5.1 节。）

参数 `descriptor`：`{ mode?: 'read' | 'write' | 'readwrite' }`。

`requestPermission(descriptor)`（原文）：

> The **`requestPermission()`** method of the `FileSystemHandle` interface requests read or readwrite permissions for the file handle.
>
> **Security**: [Transient user activation](/en-US/docs/Web/Security/Defenses/User_activation) is required. The user has to interact with the page or a UI element in order for this feature to work.
>
> 译：`requestPermission()` 为文件 handle 请求读或读写权限。需要瞬时用户激活：用户必须先与页面或某个 UI 元素交互。

`SecurityError` 的触发条件（原文节选）：

> Thrown in one of the following cases:
> - The method was called in a context that's not same-origin as the top-level context (i.e., a cross-origin iframe).
> - There was no transient user activation such as a button press. This includes when the handle is in a non-Window context which cannot consume user activation, such as a worker.
>
> 译：在以下情形之一抛出：与顶层上下文不同源（如跨源 iframe）的上下文中调用；没有瞬时用户激活（如按钮点击）——包括在无法消耗用户激活的非 Window 上下文（如 Worker）中的 handle。

## 5. 权限持久化规则

### 5.1 Chrome 官方博客：Persistent permissions for the File System Access API

来源：<https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api>（获取日期 2026-09-05；页面标注 "Last updated 2024-01-09 UTC"；作者 Thomas Steiner，介绍 Chrome 122 起的新行为）

> The File System Access API allows developers to access files on the user's local hard disk in a reading and (optionally) writing manner.
>
> Access lasts until you close the last tab of the origin.
>
> 译：File System Access API 允许开发者以读取（和可选的写入）方式访问用户本地硬盘上的文件。（旧的）访问授权持续到你关闭该源的最后一个标签页为止。

> In the File System Access API, access to files and folders is managed through `FileSystemHandle` objects: `FileSystemFileHandle` objects for files, and `FileSystemDirectoryHandle` objects for folders (directories). Both can be stored in IndexedDB, and this is exactly what VS Code does.
>
> 译：对文件和文件夹的访问通过 `FileSystemHandle` 对象管理。两者都可以存入 IndexedDB，VS Code（vscode.dev）正是这么做的。

Chrome 122 起的新三选一权限提示（原文）：

> The new behavior can be observed as of Chrome 122. To test it earlier, starting from Chrome 120, toggle the two flags `chrome://flags/#file-system-access-persistent-permission` and `chrome://flags/#one-time-permission` to **Enabled**.
>
> This new three-way prompt has the following options:
> - **Allow this time:** Allows the app to have access to files for the current session. (This corresponds to the existing behavior.)
> - **Allow on every visit:** Allows the app to have indefinite access unless access is revoked. Once the app has been granted persistent access, newly opened files and folders will be accessible persistently, too.
> - **Don't allow:** Doesn't allow the app to have access to files. (This corresponds to the existing behavior.)
>
> 译：新行为自 Chrome 122 起可观察到（120 起可经两个 flag 提前开启）。新的三选一提示包含：
> - **本次允许**：应用可在当前会话内访问文件（对应旧行为）。
> - **每次访问都允许**：应用获得无限期访问，除非授权被撤销。一旦应用获得永久访问授权，之后新打开的文件和文件夹也将自动获得永久访问。
> - **不允许**：应用不能访问文件（对应旧行为）。

站点设置中的逐项撤销（原文）：

> Secondly, the new behavior entails a new section in the site settings, which users can reach through a launch icon next to the **File editing** toggle. This launch icon, when clicked, opens the **Privacy and security** settings for the app in question where the user sees a list of items for all the files and folders the app has access to. Access can be revoked on a per-item basis by clicking the trashcan icon.
>
> 译：新行为还包括站点设置中的新区域（用户可经 **文件编辑（File editing）** 开关旁的启动图标进入）。打开后用户能看到该应用有权访问的所有文件和文件夹的条目列表，并可点击垃圾桶图标逐项撤销访问权限。

触发永久授权的三个前置条件（原文）：

> There are no developer-facing changes to the File System Access API. To trigger the new behavior with persistent permissions, there are three ways with different preconditions that need to be met:
> 1. The user must have granted permission to a file or folder (or multiple files or folders) during the last visit to an origin and the app must have stored the corresponding `FileSystemHandle` objects in IndexedDB. Upon the next visit to the origin, the app must have retrieved any one of the stored `FileSystemHandle` objects from IndexedDB and then have called its `FileSystemHandle.requestPermission()` method. If these preconditions are met, the new three-way prompt will be shown.
> 2. The origin must have called the `FileSystemHandle.requestPermission()` method on a `FileSystemHandle` to which access was granted before, but whose access has been automatically revoked due to the tab being backgrounded for a while. (The automatic permission revocation works based on the same logic as described in the article One-time permissions in Chrome.) If these preconditions are met, the new three-way prompt will be shown.
> 3. The user must have installed the app. Installed apps will automatically persist permissions once the user grants access. In this case, the three-way prompt won't be shown, instead the app gets the new behavior by default.
>
> 译：对 File System Access API 而言没有面向开发者的变化。触发永久授权的新行为有三条路径，各有前置条件：
> 1. 用户在上次访问该源时曾授予某个（或多个）文件/文件夹权限，且应用已把对应 `FileSystemHandle` 对象存入 IndexedDB；下次访问该源时，应用从 IndexedDB 取出任意一个已存的 handle 并调用其 `requestPermission()` 方法——满足这些条件即显示新的三选一提示。
> 2. 源对之前已获授权、但因标签页长时间处于后台而被自动撤销权限的 handle 调用 `requestPermission()`（自动撤销逻辑与《One-time permissions in Chrome》一文相同）。
> 3. **用户已安装该应用（PWA）。已安装的应用在用户授予访问权限后会自动持久化权限，此时不会显示三选一提示，应用默认直接获得新行为。**

> Aligning with the way it works in one-time permissions, if the user denies or dismisses the prompt more than three times, it will no longer trigger, and instead the regular permission prompt will show.
>
> 译：与一次性权限（one-time permissions）的行为一致：如果用户拒绝或关闭提示超过三次，该提示将不再触发，转而显示常规权限提示。

### 5.2 Chrome 官方博客：One-time permissions

来源：<https://developer.chrome.com/blog/one-time-permissions>（获取日期 2026-09-05；页面标注 "Last updated 2023-08-01 UTC"；介绍 Chrome 116 起的一次性权限，File System Access API 的会话授权按其规则自动撤销）

> one-time permission grants expire as soon as any of the following conditions are met:
> - The page has been closed, was navigated away from, or was discarded. This includes closing Chrome.
> - 16 hours have passed since granting permission.
> - The user manually revokes the permission (for example, in Site controls), or the permission is overridden through an enterprise policy.
> - The page has been in the background for at least 5 minutes—except if the capability is allowed to run in the background, like camera or microphone.
>
> 译：一次性权限授予在满足以下任一条件时立即失效：
> - 页面已被关闭、导航离开或被丢弃（包括关闭 Chrome）。
> - 自授予权限起已过 16 小时。
> - 用户手动撤销权限（例如在站点控件中），或权限被企业策略覆盖。
> - 页面已在后台停留至少 5 分钟（除非该能力允许后台运行，如摄像头或麦克风）。

### 5.3 WICG File System Access 规范：Permissions 章节

来源：<https://wicg.github.io/file-system-access/>（规范源文件 <https://github.com/WICG/file-system-access/blob/main/index.bs>，获取日期 2026-09-05）

「Local File System Permissions」章节原文：

> The fact that the user picked the specific files returned by the [local file system handle factories] in a prompt should be treated by the user agent as the user intending to grant read access to the website for the returned files. As such, at the time the promise returned by one of the [local file system handle factories] resolves, [permission state] for a descriptor with [handle] set to the returned handle, and [mode] set to "read" should be "granted".
>
> 译：用户在选择器中选择的特定文件应被视为用户有意向网站授予这些文件的读访问权。因此，当本地文件系统 handle 工厂返回的 promise 履行时，对返回 handle 的、mode 为 "read" 的权限描述符，其权限状态应为 "granted"。

权限请求算法的安全要求（原文节选）：

> If |global| is not a {{Window}}, then [throw] a "{{SecurityError}}" {{DOMException}}.
> If |global| does not have [transient activation], then [throw] a "{{SecurityError}}" {{DOMException}}.
> If |settings|'s [environment settings object/origin] is not [same origin] with |settings|'s [top-level origin], then [throw] a "{{SecurityError}}" {{DOMException}}.
>
> 译：全局对象不是 Window 时抛出 SecurityError；没有瞬时用户激活时抛出 SecurityError；与顶层来源不同源时抛出 SecurityError。

> 说明：规范本身不规定授权是否跨浏览器重启持久化，而是交由用户代理的权限存储实现（"persisted in the user agent's permission store" 属实现行为）；Chrome 的实际行为见 5.1/5.2 节。

## 6. 浏览器支持数据（MDN BCD / caniuse）

数据来源（获取日期 2026-09-05）：

- MDN Browser Compatibility Data（BCD，即 MDN 页面兼容表的原始数据）：<https://github.com/mdn/browser-compat-data>；`api/Window.json` 最近更新 **2026-08-31**；`api/FileSystemFileHandle.json` 最近更新 **2025-06-17**（"Updates for Safari 26 beta"）。
- caniuse：<https://caniuse.com/native-filesystem-api>（"File System Access API" 条目），数据文件最近更新 **2026-08-24**。

### 6.1 File System Access API（用户可见文件系统的选择器与权限）

MDN BCD 数据（`api.Window.showOpenFilePicker` / `showDirectoryPicker` / `showSaveFilePicker`，2026-08-31）：

| 浏览器 | showOpenFilePicker / showDirectoryPicker / showSaveFilePicker | queryPermission / requestPermission |
| --- | --- | --- |
| Chrome（桌面） | 86+ | 86+ |
| Edge（桌面） | 86+（mirror Chrome） | 86+（mirror Chrome） |
| Opera（桌面） | mirror Chrome（caniuse：72 起部分支持，91 起完整支持） | mirror Chrome |
| Chrome Android | 132+ | 109+ |
| Firefox（桌面/Android） | **不支持（false）** | **不支持（false）** |
| Safari（macOS/iOS） | **不支持（false）** | **不支持（false）** |

caniuse "File System Access API" 条目（2026-08-24）：

- Chrome：86–104 部分支持（备注 #2 "Parts of the API are still missing."），105 起完整支持；截至数据中最新版本 154 仍为完整支持。
- Edge：86–104 部分支持，105 起完整支持（至 151）。
- Opera：72–90 部分支持，91 起完整支持（至 134）。
- Firefox：所有版本（含数据中最新 157）均为 **不支持**。
- Safari：所有版本（含 26.x 与 27）均为 **不支持**。
- 备注 #1（Chrome/Edge/Opera 74–85 前身）："Can be enabled in desktop Chromium browsers with the `#native-file-system-api` flag."

### 6.2 File System API 各接口（含 OPFS 所需接口）

MDN BCD 数据（`api/FileSystemFileHandle.json`、`api/FileSystemDirectoryHandle.json`、`api/FileSystemWritableFileStream.json`、`api/FileSystemSyncAccessHandle.json`、`api/StorageManager.json`）：

| 接口 / 方法 | Chrome | Edge/Opera | Firefox | Safari |
| --- | --- | --- | --- | --- |
| `FileSystemFileHandle` / `FileSystemDirectoryHandle` | 86+ | mirror | 111+ | 15.2+ |
| `FileSystemFileHandle.getFile()` | 86+ | mirror | 111+ | 15.2+ |
| `FileSystemFileHandle.createWritable()` | 86+ | mirror | 111+ | **26+** |
| `FileSystemWritableFileStream` | 86+ | mirror | 111+ | **26+** |
| `FileSystemFileHandle.createSyncAccessHandle()` | 102+ | mirror | 111+ | 15.2+ |
| `StorageManager.getDirectory()`（OPFS 入口） | 86+ | mirror | 111+ | 15.2+ |
| `StorageManager.persist()` / `persisted` | 55+ | mirror | 57+ | 15.2+ |
| `StorageManager.estimate()` | 61+ | mirror | 57+ | 17+ |

> 注：BCD 中 Firefox 111 / Safari 15.2 对上述 handle 类接口的支持指的是 File System API 的 **OPFS 部分**（配合 `getDirectory()` 使用），而非用户可见文件系统的选择器；Firefox 与 Safari 均无 `showOpenFilePicker` 等选择器（见 6.1）。Safari 26 起补充了 `createWritable()` / `FileSystemWritableFileStream`（写能力）。

## 7. Firefox 相关发布说明（MDN）

### 7.1 Firefox 111 发布说明（OPFS 支持）

来源：<https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/111>（获取日期 2026-09-05）

> [Origin private file system (OPFS)](/en-US/docs/Web/API/File_System_API/Origin_private_file_system) is now supported when using the [File System API](/en-US/docs/Web/API/File_System_API). The data in this file system is origin-specific: permission prompts are not required to access files, and clearing data for the site/origin deletes the storage. The OPFS is accessed with the {{domxref("StorageManager.getDirectory()")}} method, by calling `navigator.storage.getDirectory()` in a worker or the main thread. See [Firefox bug 1785123](https://bugzil.la/1785123) for more details.
>
> 译：使用 File System API 时，源私有文件系统（OPFS）现已支持。该文件系统中的数据按源隔离：访问文件无需权限提示，清除站点/源数据会删除该存储。OPFS 通过 `StorageManager.getDirectory()` 访问，即在工作线程或主线程中调用 `navigator.storage.getDirectory()`。

### 7.2 Firefox 133 发布说明（关于 File System Access API）

来源：<https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/133>（获取日期 2026-09-05）

> 事实核对：**Firefox 133 发布说明中没有任何关于 File System Access API（`showOpenFilePicker` 等）的条目**。与该前提一致，MDN BCD（2026-08-31）与 caniuse（2026-08-24）均记录 Firefox 对 `showOpenFilePicker` / `showDirectoryPicker` / `showSaveFilePicker` 为不支持（截至数据覆盖的最新 Firefox 157）。Firefox 111 起支持的是 File System API 的 OPFS 部分（见 7.1），两者不同。

## 8. IndexedDB 与结构化克隆（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API>、<https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm>（获取日期 2026-09-05）

> IndexedDB is a low-level API for client-side storage of significant amounts of structured data, including files/blobs.
>
> IndexedDB lets you store and retrieve objects that are indexed with a **key**; any objects supported by the [structured clone algorithm](/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) can be stored.
>
> 译：IndexedDB 是用于客户端存储大量结构化数据（包括文件/blob）的低层 API。IndexedDB 允许按 key 存储和检索对象；凡结构化克隆算法支持的对象都可存储。

结构化克隆算法支持的类型中与本调查相关的条目（原文列表节选）：

- {{jsxref("ArrayBuffer")}}
- {{domxref("Blob")}}
- {{domxref("File")}}
- {{domxref("FileList")}}
- {{domxref("FileSystemDirectoryHandle")}}
- {{domxref("FileSystemFileHandle")}}
- {{domxref("FileSystemHandle")}}
- {{jsxref("TypedArray")}}

> 注：结构化克隆算法用于 `structuredClone()`、Worker 间的 `postMessage()` 传递、**将对象存入 IndexedDB** 等场景。`FileSystemFileHandle` 在列表中，说明它可被克隆并存入 IndexedDB（与 1 节 MDN 概述一致）。

## 9. 存储配额与驱逐（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>（获取日期 2026-09-05）

### 9.1 两种存储模式（原文）

> Data for an origin can be stored in two ways in a browser, _persistent_ and _best-effort_:
> - Best-effort: this is the way that data is stored by default. Best-effort data persists as long as the origin is below its quota, the device has enough storage space, and the user doesn't choose to delete the data via their browser's settings.
> - Persistent: an origin can opt-in to store its data in a persistent way. Data stored this way is only evicted, or deleted, if the user chooses to, by using their browser's settings.
>
> 译：源的数据在浏览器中有两种存储方式：**尽力而为（best-effort，默认）**——只要源未超配额、设备空间足够、用户未在浏览器设置中删除，数据就保留；**持久（persistent，需主动申请）**——数据只会在用户自行通过浏览器设置删除时被清除。

> Note that [research from the Chrome team](https://web.dev/articles/persistent-storage) shows that data is very rarely deleted by the browser. If a user visits a website regularly, there is very little chance that its stored data, even in best-effort mode, will get evicted by the browser.
>
> 译：Chrome 团队的研究显示，浏览器极少删除数据。如果用户定期访问一个网站，其存储数据（即使处于 best-effort 模式）被浏览器驱逐的可能性非常小。

### 9.2 各浏览器配额（原文节选）

Firefox：

> In Firefox, the maximum storage space an origin can use in best-effort mode is whichever is the smaller of: 10% of the total disk size where the profile of the user is stored. Or 10 GiB, which is the _group limit_ that Firefox applies to all origins that are part of the same {{Glossary("site")}}.
>
> Origins for which persistent storage has been granted can store up to 50% of the total disk size, capped at 8 TiB, and are not subject to the group limit.
>
> 译：Firefox 中，best-effort 模式下每个源的最大存储空间是以下两者中的较小者：用户 profile 所在磁盘总大小的 10%；或 10 GiB（Firefox 对同一 site 下所有 origin 施加的 group limit）。获得持久存储的源最多可用磁盘总大小的 50%（上限 8 TiB），且不受 group limit 约束。

Chrome / Chromium 系：

> In browsers based on the [Chromium open-source project](https://www.chromium.org/Home/), including Chrome and Edge, an origin can store up to 60% of the total disk size in both persistent and best-effort modes.
>
> 译：基于 Chromium 的浏览器（包括 Chrome 和 Edge）中，一个源在 persistent 与 best-effort 两种模式下都最多可存储磁盘总大小的 60%。

Safari / WebKit：

> Starting with macOS 14 and iOS 17:
> - For WebKit-based browser apps, each origin can store up to around 60% of total disk.
> - For other WebKit-based apps that embed web content, each origin can store up to around 15% of total disk. ...
>
> In earlier versions of Safari, an origin is given an initial 1 GiB quota. Once the origin reaches this limit, Safari asks the user for permission to let the origin store more data.
>
> 译：自 macOS 14 与 iOS 17 起：基于 WebKit 的浏览器应用中每个源最多可存磁盘总大小的约 60%；其它嵌入 Web 内容的应用约 15%。在更早的 Safari 版本中，每个源初始配额为 1 GiB，用完后 Safari 会向用户请求允许存储更多数据。

### 9.3 驱逐（原文节选）

> When a device is running low on storage space, also known as _storage pressure_ ... Browsers use a Least Recently Used (LRU) policy to deal with this scenario. The data from the least recently used origin is deleted. ...
>
> This eviction mechanism only applies to origins that are not persistent and skips over origins that have been granted data persistence by using {{domxref("StorageManager.persist()", "navigator.storage.persist()")}}.
>
> 译：设备存储空间紧张（storage pressure）时，浏览器采用 LRU（最近最少使用）策略，从最久未使用的源开始删除数据。该驱逐机制只作用于未获持久授权的源，会跳过通过 `navigator.storage.persist()` 获得持久授权的源。

Safari 的主动驱逐（原文）：

> Safari proactively evicts data when cross-site tracking prevention is turned on. If an origin has no user interaction, such as click or tap, in the last seven days of browser use, its data created from script will be deleted.
>
> 译：Safari 在开启跨站跟踪防护时会主动驱逐数据：若一个源在最近 7 天的浏览器使用中没有用户交互（如点击或轻点），其由脚本创建的数据将被删除。

> When an origin's data is evicted by the browser, all of its data, not parts of it, is deleted at the same time.
>
> 译：源的某类数据被浏览器驱逐时，该源的全部数据（而非部分）会被同时删除。

超出配额的行为（原文）：

> Attempting to store more than an origin's quota using IndexedDB, Cache, or OPFS, for example, fails with a `QuotaExceededError` exception.
>
> 译：尝试使用 IndexedDB、Cache 或 OPFS 存储超过源配额的数据时，会以 `QuotaExceededError` 异常失败。

## 10. StorageManager.persist() / estimate()（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist>、<https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate>（获取日期 2026-09-05）

`persist()`（原文）：

> The **`persist()`** method of the `StorageManager` interface requests permission to use persistent storage, and returns a `Promise` that resolves to `true` if permission is granted and bucket mode is persistent, and `false` otherwise. The browser may or may not honor the request, depending on browser-specific rules.
>
> 译：`persist()` 请求使用持久存储的权限，返回解析为 `true`（已授权且存储桶模式为持久）/ `false` 的 Promise。浏览器是否批准取决于浏览器特定规则。

`estimate()`（原文）：

> The **`estimate()`** method of the `StorageManager` interface asks the Storage Manager for how much storage the current origin takes up (`usage`), and how much space is available (`quota`).
>
> Return value: A `Promise` that resolves to an object with the following properties:
> - `quota`: A numeric value in bytes which provides a conservative approximation of the total storage the user's device or computer has available for the site origin or Web app.
> - `usage`: A numeric value in bytes approximating the amount of storage space currently being used by the site or Web app...
>
> The returned values are not exact: between compression, deduplication, and obfuscation for security reasons, they will be imprecise.
>
> 译：`estimate()` 查询当前源占用的存储量（`usage`）与可用空间（`quota`），返回 `{ usage, quota }`（字节）。返回值并不精确（压缩、去重与出于安全考虑的混淆都会造成偏差）。

## 11. Origin Private File System（OPFS，MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>（获取日期 2026-09-05）

> The **origin private file system** (OPFS) is a storage endpoint provided as part of the [File System API](/en-US/docs/Web/API/File_System_API), which is private to the origin of the page and not visible to the user like the regular file system. It provides access to a special kind of file that is highly optimized for performance and offers in-place write access to its content.
>
> 译：OPFS 是 File System API 提供的存储端点，对页面源私有，不像常规文件系统那样对用户可见；提供为性能高度优化、支持原地写入的特殊文件。

OPFS 与用户可见文件系统的区别（原文）：

> - The OPFS is subject to [browser storage quota restrictions](/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), just like any other origin-partitioned storage mechanism (for example {{domxref("IndexedDB API", "IndexedDB API", "", "nocode")}}). You can access the amount of storage space the OPFS is using via {{domxref("StorageManager.estimate()", "navigator.storage.estimate()")}}.
> - Clearing storage data for the site deletes the OPFS.
> - Permission prompts and security checks are not required to access files in the OPFS.
> - Browsers persist the contents of the OPFS to disk somewhere, but you cannot expect to find the created files matched one-to-one. The OPFS is not intended to be visible to the user.
>
> 译：
> - OPFS 与其它按源划分的存储机制（如 IndexedDB）一样受浏览器存储配额限制；可用 `navigator.storage.estimate()` 查看 OPFS 占用空间。
> - 清除站点存储数据会删除 OPFS。
> - 访问 OPFS 中的文件不需要权限提示与安全检查。
> - 浏览器会把 OPFS 内容持久化到磁盘某处，但你别指望能在磁盘上找到一一对应的文件；OPFS 本就不打算对用户可见。

`StorageManager.getDirectory()`（原文）：

> The **`getDirectory()`** method of the `StorageManager` interface is used to obtain a reference to a `FileSystemDirectoryHandle` object allowing access to a directory and its contents, stored in the origin private file system (OPFS).
>
> 译：`StorageManager` 接口的 `getDirectory()` 方法用于获取对 OPFS 根目录的 `FileSystemDirectoryHandle` 引用，从而访问存储在 OPFS 中的目录及其内容。

## 12. web.dev：Persistent storage

来源：<https://web.dev/articles/persistent-storage>（获取日期 2026-09-05）

Chromium 系对 `navigator.storage.persist()` 的自动判定（原文节选）：

> ...do not show any prompts to the user. Instead, if a site is considered important, the persistent storage permission is automatically granted, otherwise it is silently denied. The heuristics to determine if a site is important include: How high is the level of site engagement? Has the site been installed or bookmarked? Has the site been granted permission to show notifications?
>
> 译：（Chromium 浏览器）不向用户显示任何提示；若站点被认为"重要"，持久存储权限被自动授予，否则被静默拒绝。判定站点是否重要的启发式包括：站点参与度（engagement）有多高？站点是否已被安装（PWA）或加书签？站点是否已被授予显示通知的权限？

Firefox（原文节选）：

> Firefox delegates the permission request to the user. When persistent storage is requested, it prompts the user with a UI popup asking if they will allow the site to store data in persistent storage.
>
> 译：Firefox 将权限请求交给用户：请求持久存储时弹出 UI 询问是否允许该站点使用持久存储。

## 13. 来源链接汇总

| # | 来源 | URL | 获取/更新时间 |
| --- | --- | --- | --- |
| 1 | MDN File System API | <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API> | 2026-09-05 |
| 2 | MDN Window.showOpenFilePicker() | <https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker> | 2026-09-05 |
| 3 | MDN FileSystemFileHandle | <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle> | 2026-09-05 |
| 4 | MDN FileSystemHandle.queryPermission() | <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission> | 2026-09-05 |
| 5 | MDN FileSystemHandle.requestPermission() | <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission> | 2026-09-05 |
| 6 | Chrome for Developers: Persistent permissions for the File System Access API | <https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api> | 获取 2026-09-05；文章更新 2024-01-09 |
| 7 | Chrome for Developers: One-time permissions | <https://developer.chrome.com/blog/one-time-permissions> | 获取 2026-09-05；文章更新 2023-08-01 |
| 8 | WICG File System Access 规范 | <https://wicg.github.io/file-system-access/> | 2026-09-05 |
| 9 | MDN BCD（compat 数据） | <https://github.com/mdn/browser-compat-data> | 2026-09-05（Window.json 更新 2026-08-31；FileSystemFileHandle.json 更新 2025-06-17） |
| 10 | caniuse: File System Access API | <https://caniuse.com/native-filesystem-api> | 数据更新 2026-08-24 |
| 11 | MDN Firefox 111 for developers | <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/111> | 2026-09-05 |
| 12 | MDN Firefox 133 for developers | <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/133> | 2026-09-05 |
| 13 | MDN IndexedDB API | <https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API> | 2026-09-05 |
| 14 | MDN The structured clone algorithm | <https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm> | 2026-09-05 |
| 15 | MDN Storage quotas and eviction criteria | <https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria> | 2026-09-05 |
| 16 | MDN StorageManager.persist() | <https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist> | 2026-09-05 |
| 17 | MDN StorageManager.estimate() | <https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate> | 2026-09-05 |
| 18 | MDN StorageManager.getDirectory() | <https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory> | 2026-09-05 |
| 19 | MDN Origin private file system | <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system> | 2026-09-05 |
| 20 | web.dev: Persistent storage | <https://web.dev/articles/persistent-storage> | 2026-09-05 |
