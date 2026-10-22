//! 吾又一言 桌面壳
//!
//! 这个 lib 只做几件事：单实例、选一个能用的界面缓存目录、把窗口建起来、
//! 把命令注册给 Tauri。与磁盘格式有关的逻辑全在 `fsops`（有测试）。
//!
//! 之所以拆成 lib + bin 而不是单一 main.rs：
//! lib 可以被 `cargo test` 直接针对，不需要启动图形环境。
//!
//! ── 为什么窗口是在代码里建的，而不是写在 tauri.conf.json 里 ──
//! 因为要能指定 WebView2 的缓存目录，而配置项里没有这个能力。
//! 这件事不是洁癖：**WebView2 的缓存目录一旦被上一次崩溃留下的
//! msedgewebview2.exe 占住，新建窗口就报 ERROR_BUSY(0x800700AA)**，
//! Tauri 会 panic，而 release 档是 panic=abort，于是进程以
//! 0xC0000409 一声不响地退出 —— 而且每次都留下新的残留进程，
//! 形成"越启动越起不来"的死循环。
//! 现在的做法：先试默认目录，被占就换一个新的，所以**永远不会因为
//! 上一代的残留而起不来**。

pub mod commands;
pub mod fsops;

use std::path::{Path, PathBuf};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    ensure_single_instance();

    let built = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::read_novel,
            commands::write_novel,
            commands::delete_novel,
            commands::pick_library,
        ])
        .setup(|app| {
            let (dir, fell_back) = pick_webview_dir(app.handle());
            if fell_back {
                log_line(&format!(
                    "上次的界面缓存目录被占，这次改用 {}",
                    dir.display()
                ));
                note_to_author(
                    "上次没有正常退出，界面缓存目录被残留进程占着。\n\n\
                     这次已经自动换了一个新的缓存目录，程序照常可用。\n\
                     你的稿子在小说库文件夹里，不受影响；\n\
                     如果之前把稿子存在程序内部（没选过小说库文件夹），\n\
                     重启电脑后再打开一次就能看到它。",
                );
            }
            cleanup_stale_dirs(&dir);

            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("吾又一言")
            .inner_size(1440.0, 940.0)
            .min_inner_size(1024.0, 680.0)
            .center()
            .data_directory(dir)
            .build()?;
            Ok(())
        })
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

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            log_line("正常退出");
        }
    });
}

/* ============================================================
   界面缓存目录：被占就换一个
   ============================================================ */

/// 目录能不能随便动。**用「改名」来判定**：目录里只要有进程打开着文件，
/// Windows 就不允许改名，于是改名失败 = 被占着。
fn dir_is_free(dir: &Path) -> bool {
    if !dir.exists() {
        return true;
    }
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "EBWebView".into());
    let probe = dir.with_file_name(format!("{name}.probe"));
    let _ = std::fs::remove_dir_all(&probe);
    match std::fs::rename(dir, &probe) {
        Ok(()) => {
            let _ = std::fs::rename(&probe, dir);
            true
        }
        Err(_) => false,
    }
}

fn base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(p) = app.path().app_local_data_dir() {
        return p;
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(local).join("com.novelstudio.desktop")
}

/// 返回（要用的目录，是不是退而求其次）
fn pick_webview_dir(app: &tauri::AppHandle) -> (PathBuf, bool) {
    let base = base_dir(app);
    let _ = std::fs::create_dir_all(&base);
    let stable = base.join("EBWebView");
    if dir_is_free(&stable) {
        return (stable, false);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (base.join(format!("EBWebView-{stamp}")), true)
}

/// 顺手清掉以前留下的临时目录（只清没被占的，占着的留给重启）
fn cleanup_stale_dirs(keep: &Path) {
    let base = match keep.parent() {
        Some(p) => p,
        None => return,
    };
    let entries = match std::fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("EBWebView-") || path == keep {
            continue;
        }
        if dir_is_free(&path) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/* ============================================================
   单实例：第二次双击只把已有窗口提到前面
   ============================================================ */

/// 用一个命名互斥体占住"只能有一个实例"。
/// 不引入新依赖：直接调 kernel32。
#[cfg(windows)]
fn ensure_single_instance() {
    use std::os::windows::ffi::OsStrExt;

    // 调试开关：设了它就不再拦第二个实例。
    // 只是为了能测「默认缓存目录被占时自动换目录」这条路径，
    // 正常使用不会设到它。
    if std::env::var("WUYOU_ALLOW_MULTI").ok().as_deref() == Some("1") {
        return;
    }

    let name: Vec<u16> = std::ffi::OsStr::new("Local\\com.novelstudio.desktop.single")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            attrs: *mut std::ffi::c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut std::ffi::c_void;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: *mut std::ffi::c_void) -> i32;
    }

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;

    unsafe {
        let handle = CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr());
        if handle.is_null() {
            return;
        }
        // 句柄不关：进程活着它就活着，退出时系统回收
        if GetLastError() != ERROR_ALREADY_EXISTS {
            return;
        }

        // 已经有实例在跑：把它的窗口叫出来，然后自己退出
        let title: Vec<u16> = std::ffi::OsStr::new("吾又一言")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
        std::process::exit(0);
    }
}

#[cfg(not(windows))]
fn ensure_single_instance() {}

/* ============================================================
   崩溃可见
   ============================================================ */

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let detail = format!("{info}");
        log_line(&format!("PANIC: {detail}"));
        default_hook(info);
        startup_failed(&detail);
    }));
}

fn log_file() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let dir = PathBuf::from(local).join("com.novelstudio.desktop");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("crash.log"))
}

fn log_line(text: &str) {
    if let Some(path) = log_file() {
        use std::io::Write;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "[{stamp}] {text}");
        }
    }
}

/// 有一条要作者知道的事，但又不想用"启动失败"的口气去吓人。
fn note_to_author(text: &str) {
    if std::env::var("WUYOU_NO_DIALOG").ok().as_deref() == Some("1") {
        return;
    }
    show_message("吾又一言", text);
}

fn startup_failed(detail: &str) {
    let hint = if detail.contains("800700AA") {
        "WebView2 说「请求的资源在使用中」。\n\n\
         程序已经尝试换一个缓存目录，仍然失败。\n\
         请重启电脑后再打开；或双击「重置界面缓存.cmd」。"
    } else {
        "启动失败。把下面这段发给开发者就能定位。"
    };
    let msg = format!("{hint}\n\n—— 原始错误 ——\n{detail}");
    eprintln!("{msg}");
    show_message("吾又一言 启动失败", &msg);
}

fn show_message(caption: &str, message: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        if std::env::var("WUYOU_NO_DIALOG").ok().as_deref() == Some("1") {
            eprintln!("[{caption}] {message}");
            return;
        }
        let wide = |s: &str| -> Vec<u16> {
            std::ffi::OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        };
        let text = wide(message);
        let cap = wide(caption);
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
            // MB_OK | MB_SETFOREGROUND
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), cap.as_ptr(), 0x0000_1000);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (caption, message);
    }
}
