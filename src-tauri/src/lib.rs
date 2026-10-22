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
    install_panic_hook();

    let built = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::read_novel,
            commands::write_novel,
            commands::delete_novel,
            commands::pick_library,
        ])
        .build(tauri::generate_context!());

    /* 为什么不用 .run(...).expect(...)：
       Tauri 的 run() 在建窗口失败时直接 panic，而 release 版是
       windows_subsystem=windows + panic=abort —— 结果是进程一声不响地
       以 0xC0000409 退出，作者看到的就是"双击了没反应"。
       现在改成先 build（返回 Result），失败时把原因说清楚再退出。 */
    let app = match built {
        Ok(app) => app,
        Err(e) => {
            startup_failed(&format!("{e}"));
            std::process::exit(1);
        }
    };

    app.run(|_app, _event| {});
}

/// 把崩溃写成一条能看懂的记录：日志文件 + 消息框。
///
/// 起因：release 版没有控制台，Tauri 在 setup 阶段 panic（最常见的是
/// WebView2 报 ERROR_BUSY，用户数据目录被上一次没退干净的进程占着），
/// panic=abort 之后进程直接以 0xC0000409 退出 —— 作者什么也看不到。
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let detail = format!("{info}");
        let log = data_dir().map(|d| d.join("crash.log"));
        if let Some(path) = &log {
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(path.as_path()));
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "[{stamp}] {detail}")
                });
        }
        default_hook(info);
        startup_failed(&format!(
            "{detail}\n\n这条记录也写进了：\n{}",
            log.map(|p| p.display().to_string())
                .unwrap_or_else(|| "(找不到可写目录)".into())
        ));
    }));
}

fn data_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    Some(std::path::PathBuf::from(base).join("com.novelstudio.desktop"))
}

fn startup_failed(detail: &str) {
    let hint = if detail.contains("800700AA") {
        "WebView2 说「请求的资源在使用中」。\n\n\
         通常是上一次没关干净：残留的 msedgewebview2 进程占着数据目录。\n\
         依次试：\n\
         1. 打开任务管理器，结束所有 msedgewebview2.exe\n\
         2. 还不行就双击程序目录里的「重置界面缓存.cmd」\n\n\
         （这个目录里没有你的稿子；稿子在小说库文件夹里。）"
    } else {
        "启动失败。把这段发给开发者就能定位。"
    };
    let msg = format!("{hint}\n\n—— 原始错误 ——\n{detail}");
    eprintln!("{msg}");
    show_message(&msg);
}

/// 没有窗口就没有人能看见 eprintln。用一个系统消息框把原因说出来。
fn show_message(message: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide = |s: &str| -> Vec<u16> {
            std::ffi::OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        };
        let text = wide(message);
        let caption = wide("吾又一言 启动失败");
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut std::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                utype: u32,
            ) -> i32;
        }
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x0000_0010);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = message;
    }
}
