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

## 五、当前的阻塞：release 版一启动就退出

**打包和编译都是成功的**，但装完之后运行 `novel-studio.exe` 会立刻退出，退出码 `-1073740791`（即 `0xC0000409`，`STATUS_STACK_BUFFER_OVERRUN`）。**debug 版不会崩**：

```powershell
cargo build            # debug
cargo run              # 正常起窗口
```

已经排除的：

- 不是图标缺失（`src-tauri/icons/` 六个文件都在）
- 不是前端资源缺失（`dist/` 打进去了，浏览器版同一份 dist 跑得好好的）
- 不是权限问题（换目录、换用户都一样）

下一步的怀疑方向：`main.rs` 里的 `#![windows_subsystem = "windows"]`（为了排查已经注释掉）、
`tauri.conf.json` 的 `windows` 配置，以及 release 下的 panic 策略（`panic = "abort"` 会把
正常的 Rust panic 变成 `0xC0000409`，所以**真实原因可能只是一个普通 panic 被吞掉了**）。

排查办法：先把 `Cargo.toml` 里 release 的 `panic = "abort"` 去掉、把 `windows_subsystem` 注释掉，
再 `cargo build --release` 直接跑，让 panic 信息打到控制台。

---

## 编译好之后会自动发生什么

桌面版和浏览器版**用的是同一个小说文件夹格式**，所以：

- 你之前用浏览器版写的东西，桌面版直接打开就能用，不用迁移
- 反过来也一样
- 前端代码**一行都没改** —— 当初把「存储访问」封装成一个接口，就是为了这一刻

两者的差别：

| | 浏览器版 | 桌面版 |
|---|---|---|
| 打开方式 | 双击 `启动.cmd`，走浏览器 | 双击图标，原生窗口 |
| 文件夹权限 | 每次启动需要点一次授权（浏览器的安全限制） | 不需要，直接读写 |
| 外部改动检测 | 需要（每 5 秒轮询） | 不需要（改动立刻可见） |
| 界面 | 完全一样 | 完全一样 |
| 数据格式 | 完全一样 | 完全一样 |

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
