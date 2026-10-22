# 编译成 Windows exe

浏览器形态已经可以用（双击 `启动.cmd`）。这份文档说明**怎么把它变成双击即开的 exe**，以及**现在卡在哪一步**。

Rust 工具链本机已经装好了（`%USERPROFILE%\.cargo\bin`，需要时把它加到 PATH）。

---

## 一、环境

已经就绪，不用再装。验证一下：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH
rustc --version
cargo --version
```

> MSVC 依赖：Tauri 需要微软的 C++ 生成工具。如果编译时报「link.exe not found」，
> 装一下 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，
> 勾选「使用 C++ 的桌面开发」即可。

---

## 二、验证逻辑（不需要图形环境）

Rust 侧的磁盘格式规则有测试，和浏览器版是镜像关系：

```powershell
npm run desktop:test
```

这会跑 **17 组断言**（当前全过），验证 Rust 的文件名转义、快照命名、路径拼装与浏览器版**完全一致**。两边只要有一处不一致，同一个小说文件夹就会被两种实现用不同格式读写，数据看起来时有时无。

---

## 三、开发模式试跑（带热更新）

```powershell
npm run desktop:dev
```

会开一个原生窗口，同时前端仍然热更新。这是调界面时最舒服的形态。

---

## 四、打包成 exe

```powershell
npm run desktop:build
```

产物在 `src-tauri/target/release/bundle/`：

- `nsis/吾又一言_0.1.0_x64-setup.exe` —— 安装包（约 2.5 MB，当前用户安装，不需要管理员）
- `msi/吾又一言_0.1.0_x64_en-US.msi` —— Windows Installer 包（约 3.1 MB）

首次编译会下载并编译几百个 Rust crate，**大约 5 到 15 分钟**，之后就快了。

---

## 五、曾经的阻塞：release 版一启动就退出（已定位）

**打包和编译都是成功的**，但装完之后运行 `novel-studio.exe` 会立刻退出，退出码 `-1073740791`（即 `0xC0000409`，`STATUS_STACK_BUFFER_OVERRUN`）。debug 版不会崩。

**已定位（2026-10-22）**：那个"栈溢出"是假的。真实情况是 Tauri 在建窗口时 panic：

```
thread 'main' panicked at tauri-2.12.0/src/app.rs:1444:
Failed to setup app: runtime error: failed to create webview:
WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA), message: "请求的资源在使用中。" })
```

`0x800700AA` 是 `ERROR_BUSY`：WebView2 的用户数据目录
`%LOCALAPPDATA%\com.novelstudio.desktop` 被上一次没退干净的 `msedgewebview2.exe` 占着。
而 release 档设了 `panic = "abort"`，panic 于是变成 `0xC0000409` —— 所以看起来像栈溢出，其实只是一个普通的 panic 被 abort 伪装了。

**验证方式**（当时用的）：把 `main.rs` 里 `windows_subsystem` 注释掉，`cargo build --release` 后直接跑，让 panic 打到控制台。

**当时的临时恢复**：把那个目录改名/删掉即可 —— 但注意它里面可能存着"没选小说库文件夹时"的作品（`localStorage`），所以先导出再清。

**现在的处置**（代码已改）：

- `lib.rs` 装了 panic hook：崩溃会写一行到 `%LOCALAPPDATA%\com.novelstudio.desktop\crash.log`，并弹一个说人话的消息框（`0x800700AA` 单独给恢复步骤）。再也不会"双击了没反应"。
- 发布版重新打开了 `windows_subsystem = "windows"`（没有控制台黑窗），因为上面的消息框替代了控制台的作用。
- 打包目标改成只出 **nsis**：`msi` 那一步的 WiX `light.exe` 在含中文的输出路径下会失败，没必要为一个可选格式拖住整次构建。
- 新增 **`重置界面缓存.cmd`**：结束残留的 `msedgewebview2.exe`、把用户数据目录改名备份，然后你再启动一次即可。

**已经根治**（v0.1.1）：

- 窗口改成在 `lib.rs` 里用 `WebviewWindowBuilder::data_directory()` 建（`tauri.conf.json` 的 `windows` 置空），这样才能控制 WebView2 的缓存目录。
- 启动时用"改名"探测默认缓存目录是否被占（目录里有进程打开着文件就不许改名）；**被占就自动换 `EBWebView-<时间戳>`**，并清理以前留下的临时目录。
- **单实例**：命名互斥体 + `FindWindowW("吾又一言")`，第二次双击只把已有窗口恢复到前面就退出（`WUYOU_ALLOW_MULTI=1` 是给调试用的绕过开关）。
- 实测：默认目录正常 → 起窗口；另起一个实例占着目录 → 第二个自动换目录、照样起窗口；单实例 → 第二次启动立即退出（码 0）、进程数仍为 1。

> **调试注意**：这个程序**不能在只允许写工作区的受限沙箱里跑**。WebView2 要往 `%LOCALAPPDATA%` 写缓存，写入被拒就会报 `0x800700AA` 或 `os error 5`，表现得就像"程序一启动就崩"。我为此误判过一轮，别重复。

---

## 编译好之后会自动发生什么

桌面版和浏览器版**用的是同一个小说文件夹格式**，所以：

- 你之前用浏览器版写的东西，桌面版直接打开就能用，不用迁移
- 反过来也一样
- 界面代码没为桌面版写分支 —— 当初把「存储访问」封装成一个 `StorageAdapter` 接口，就是为了这一刻

两者的差别：

| | 浏览器版 | 桌面版 |
|---|---|---|
| 打开方式 | 双击 `启动.cmd`，走浏览器 | 双击图标，原生窗口 |
| 选文件夹 | File System Access API（`showDirectoryPicker`） | 系统自带的文件夹对话框（Rust 侧 `pick_library`） |
| 文件夹权限 | 每次启动要点一次授权（浏览器的安全限制） | 选一次就记住，下次启动自动接着用 |
| 外部改动检测 | 每 5 秒比一次文件指纹 | 同样要（`signature_of` 命令给路径 + 修改时间） |
| 界面 | 完全一样 | 完全一样 |
| 数据格式 | 完全一样 | 完全一样 |

> **两边都没选文件夹时，内部存储是两套**：浏览器用 localStorage，桌面版用 WebView2 的 localStorage。
> 名字一样但互不相通，看起来"稿子没了"。想在两边之间搬，就选同一个小说库文件夹。

---

## 如果编译失败

把报错发我。最常见的是**缺 C++ 生成工具** —— 见上面的 MSVC 依赖。

图标已经生成好了（`npm run icons`，产物在 `src-tauri/icons/`）。要换图标：

```powershell
npx tauri icon 某个方形png
```

---

## 目前的完成度

- 前端（浏览器形态）：完整，426 项测试全过
- Rust 侧：代码写完、**编译通过、17 项测试全过**、能产出 msi 与 nsis 安装包
- 唯一没解决的是**运行时崩溃**，见上面第五节
