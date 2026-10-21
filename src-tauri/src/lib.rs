//! 吾又一言 桌面壳
//!
//! 这个 lib 只做两件事：把命令注册给 Tauri，以及在启动时把窗口建起来。
//! 与磁盘格式有关的逻辑全在 `fsops`（有测试），命令层在 `commands`。
//!
//! 之所以拆成 lib + bin 而不是单一 main.rs：
//! lib 可以被 `cargo test` 直接针对，不需要启动图形环境。
//! 在没有 GUI 的环境里也能验证逻辑正确性。

pub mod commands;
pub mod fsops;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::read_novel,
            commands::write_novel,
            commands::delete_novel,
            commands::pick_library,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
