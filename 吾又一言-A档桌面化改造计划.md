0. 一句话结论
A 档一共六件事，预计 2–4 个工作日。不需要服务器、不需要账号、不联网。做完之后：双击图标直接出窗口，不弹黑框、不挂在浏览器里；重复双击只会把已有窗口提到前面；关掉重开会回到上次的窗口位置；托盘里能右键打开/退出；可以设开机自启；「关于」里能看到版本号和数据位置。
A 档真正的门槛不在代码，而在两件事上：一是 Windows 代码签名证书（不买就会被 SmartScreen 拦一句"未知发布者"），二是打磨细节的耐心。
1. 什么算做完（验收标准）
这一节就是验收清单。下面每一项都能用眼睛验证，不需要看代码。
用户动作
期望结果
现状
双击桌面图标
直接出现程序窗口：无控制台黑框、无浏览器地址栏、无标签页
已做到
已经开着一个窗口时再双击
不出现第二个实例，已有窗口被提到最前面
缺
点窗口右上角 ×
按选定策略：A1 直接退出 / A2 缩到托盘常驻（二选一，不能含糊）
缺
右键托盘图标
菜单里有「打开主窗口」「退出」两项，且都能用
缺
勾选「开机自启」后重启电脑
登录后窗口自己起来，不需要点任何东西
缺
挪动窗口、调整大小后退出，再打开
回到上次的位置和大小（跨显示器也要正常）
缺
打开「关于」
显示版本号、数据目录（可一键打开）、许可说明
缺
装完卸载
能干净卸掉：程序文件清掉，小说数据不删（数据不在安装目录）
基本具备
2. 现状盘点
先说已经有、不用重做的，避免重复劳动。
已完成
还缺（就是 A 档要补的）
3. 六项任务：做什么、怎么做、怎么验收
3.1 单实例：第二次双击不再开新窗口
为什么：「双击了两次」是用户最常见的行为。没有单实例时，第二个进程会和第一个抢同一个 WebView2 数据目录，直接报 0x800700AA —— 之前那个"一启动就崩"的极端版就是它。
怎么做：
验收：连点两次图标，任务管理器里只有一组进程；第二次点击后已有窗口跳到最前。
// src-tauri/src/lib.rs（示意）
tauri::Builder::default()
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
if let Some(w) = app.get_webview_window("main") {
let _ = w.unminimize();
let _ = w.show();
let _ = w.set_focus();
}
}))
.plugin(tauri_plugin_dialog::init())
3.2 托盘图标：常驻一个图标，右键能关
为什么：常驻类软件（输入法、笔记、下载器）都在托盘留一个入口。它同时解决"关掉窗口以后怎么再打开"和"怎么退出"两个问题。
怎么做：
验收：托盘出现图标；右键两个菜单项都能用；图标不显示成白块。
// src-tauri/src/lib.rs（示意）
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
let open = MenuItemBuilder::with_id("open", "打开主窗口").build(app)?;
let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
TrayIconBuilder::with_id("main")
.icon(app.default_window_icon().unwrap().clone())
.menu(&menu)
.show_menu_on_left_click(false)
.on_menu_event(|app, ev| match ev.id().as_ref() {
"open" => {
if let Some(w) = app.get_webview_window("main") {
let _ = w.show();
let _ = w.set_focus();
}
}
"quit" => app.exit(0),
_ => {}
})
.build(app)?;
3.3 关窗行为：先定一件事，再写代码
这是个产品决策，不是技术问题。两种方案，选一个，别含糊。
方案
用户点 × 之后
优点
代价
A1 直接退出
程序完全退出，托盘图标也消失
行为简单；不会被误以为"没关掉"；不占内存
下次打开要重新点图标
A2 缩到托盘
窗口隐藏，进程继续跑，托盘图标还在
再打开是瞬间的；写作类工具常这样
用户可能以为已经关了；必须给显眼的「退出」；要和开机自启一起想清楚
建议：写作工具选 A2（缩到托盘），但必须满足三条 —— 托盘菜单有明确的「退出」、第一次关窗时提示一句"已缩到托盘，右键可退出"、设置里可以改回"关窗即退出"。
// 关窗 = 缩到托盘（示意）
.on_window_event(|window, event| {
if let tauri::WindowEvent::CloseRequested { api, .. } = event {
if window.label() == "main" {
api.prevent_close();
let _ = window.hide();
}
}
})
3.4 窗口位置与大小记忆
为什么：写作工具通常是"固定姿势"打开的，位置每次重拖一遍会烦。
怎么做：
验收：挪窗口 → 退出 → 重开，位置一致；换成只有一个屏幕的状态再开一次，窗口出现在可见范围内。
3.5 开机自启
为什么：一次配好，之后永远不用找图标。属于成熟桌面软件的默认能力。
怎么做：
验收：勾上 → 重启电脑 → 窗口自己出现；取消 → 重启不再出现。
注意：如果同时选了"关窗 = 缩到托盘"，开机自启就会常驻内存。要么两者不并存，要么在设置里给一句说明。
3.6 「关于」+ 版本信息
为什么：出问题时用户第一句要说的就是"我这是哪个版本"。这也是唯一的署名位置。
怎么做：
验收：显示 v0.1.0 + 数据目录，点"打开目录"能在资源管理器里看到小说文件夹。
3.7 收尾打磨（决定"像不像软件"的地方）
4. 需要改的文件清单
文件
改什么
src-tauri/Cargo.toml
加 4 个依赖：single-instance、window-state、autostart；给 tauri 打开 tray-icon feature
src-tauri/src/lib.rs
注册 4 个插件；建托盘与菜单；拦 CloseRequested；加 app_meta 命令
src-tauri/tauri.conf.json
窗口 visible:false、title、最小尺寸；安装包 productName / publisher
src-tauri/capabilities/default.json
补 autostart 与 window-state 的权限条目
src/ 前端（侧栏底部或设置区）
开机自启开关、「关于」入口、首次关窗提示
package.json
如果前端用 JS 插件，加 @tauri-apps/plugin-autostart 等依赖
5. 建议的实施顺序与工时
顺序有讲究：先解决"不能多开"，再解决"关不掉"，最后才是锦上添花。
顺序
任务
工时
风险
1
单实例
半天
开发模式下也生效，调试时容易迷惑
2
关窗策略（定 A1 / A2）
半天
产品决策要先定，否则后面全要改
3
托盘图标 + 菜单
半天到一天
图标资源路径；高分屏发糊
4
窗口位置记忆
半天
多显示器拔插
5
开机自启
半天
和"缩到托盘"的语义冲突
6
关于 + 启动白屏 + 收尾
半天到一天
没有技术风险，纯打磨
合计 2–4 个工作日（含每项的真机验证与一次完整打包）。如果只做前三项（单实例 + 关窗策略 + 托盘），一天半就能明显感到"这就是个软件"。
6. 坑与注意事项
6.1 SmartScreen：不签名就会被拦
6.2 自启的路径问题
6.3 单实例与多会话
6.4 托盘与打包
6.5 别把 A 档做成"关不掉的常驻"
6.6 升级时数据别丢
7. 明确不做的（把边界写下来）
8. 附：怎么验证（照着做）
打包并安装
cd novel-studio
npm run build
npx tauri build
# 产物：src-tauri\target\release\bundle\nsis\吾又一言_0.1.0_x64-setup.exe
单实例
托盘
关窗策略
窗口记忆
开机自启
9. 如果你不想自己动手
六个任务的代码量都不大，难点全在"打包之后才暴露"的那几个坑：图标路径、多显示器、单实例与隐藏窗口的配合、SmartScreen。所以更省时间的做法是：把这份文档当成验收清单，让实现的人按第 8 节逐条演示给你看 —— 只要每一条都能当场演示，A 档就算做完了。
