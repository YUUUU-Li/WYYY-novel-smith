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
            commands::signature_of,
            commands::export_text,
        ])
        .setup(|app| {
            boot_diag();
            let (dir, fell_back) = pick_webview_dir(app.handle());
            diag_line(&format!("界面缓存目录 = {}", dir.display()));
            if fell_back {
                /* 2026-10-25：这里以前会弹一个「缓存目录被残留进程占着」的提示。
                   实测这个进程是被系统以受限身份启动的：写不进中等完整性的
                   AppData\Local（只有 LocalLow 写得进），所以它每次启动都必然
                   要换目录 —— 于是每次开机都弹一次，纯噪音还吓人。改成只记日志。 */
                log_line(&format!("界面缓存目录不可用，改用 {}", dir.display()));
            }
            cleanup_stale_dirs(&dir);

            /* 为什么这里要绕一道 WindowConfig，而不是 new() 一句句点：
               `drag_drop_enabled` 只能在配置结构体上设置，建造器没有对应的
               方法，而它**必须**是 false —— 理由见下面那段注释。 */
            let win_cfg = tauri::utils::config::WindowConfig {
                label: "main".into(),
                url: tauri::WebviewUrl::App("index.html".into()),
                title: "吾又一言".into(),
                width: 1440.0,
                height: 940.0,
                min_width: Some(1024.0),
                min_height: Some(680.0),
                center: true,
                /* 关掉 Tauri 自带的文件拖放处理器。

                   它在 Windows 上默认是开的，做法是在窗口句柄上注册一个 OLE
                   IDropTarget。一旦注册，WebView2 自己那套 drop 目标就收不到
                   消息了，于是**页面里的 HTML5 拖放整个失效** —— 表现正是
                   「把词条从左边拖进关系网 / 时间线 / 大纲，拖不动」，而这些
                   在浏览器版里全是好的（浏览器里没有这一层）。

                   程序从来没用到「把文件从资源管理器拖进窗口」这个能力
                   （前端一行 onDragDropEvent 都没有），所以关掉零损失。 */
                drag_drop_enabled: false,
                ..Default::default()
            };
            tauri::WebviewWindowBuilder::from_config(app, &win_cfg)?
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
///
/// 为什么要自己验一遍「这个目录真的能写」：
/// Tauri 在建窗口时（`tauri-2.x/src/manager/webview.rs`）只做
/// `if !user_data_dir.exists() { create_dir_all(user_data_dir)? }`，
/// 失败时抛出来的就是一句「拒绝访问。 (os error 5)」—— 不说哪个路径、
/// 不说哪一步、也不知道下一个候选还能用。2026-10-25 那次 0xC0000409
/// 正是卡在这里，白查了一整天。
/// 现在每个候选目录都真写一个探针文件，不行就换下一个；全不行才交给
/// Tauri 去报错，而且每一步的 errno 都已经进了诊断日志。
fn pick_webview_dir(app: &tauri::AppHandle) -> (PathBuf, bool) {
    let base = base_dir(app);
    diag_line(&format!("base = {}", base.display()));

    // 0) 环境变量强制指定 —— 应急开关，绕过一切猜测
    if let Ok(v) = std::env::var("WUYOU_WEBVIEW_DIR") {
        let t = v.trim();
        if !t.is_empty() {
            let p = PathBuf::from(t);
            match can_write_dir(&p) {
                Ok(()) => {
                    diag_line(&format!("WUYOU_WEBVIEW_DIR 可用: {}", p.display()));
                    return (p, false);
                }
                Err(e) => diag_line(&format!("WUYOU_WEBVIEW_DIR 不可用: {} -> {e}", p.display())),
            }
        }
    }

    let stable = base.join("EBWebView");
    let free = dir_is_free(&stable);
    diag_line(&format!(
        "stable = {}  (exists = {}, 可改名 = {})",
        stable.display(),
        stable.exists(),
        free
    ));
    if free {
        match can_write_dir(&stable) {
            Ok(()) => return (stable, false),
            Err(e) => diag_line(&format!("stable 不可写: {e}")),
        }
    }

    // 1) 同目录下换一个新的 → 2) 系统临时目录 → 3) LocalLow（被降权的进程
    //    唯一还写得进去的地方，所以它既是兜底也是"我是不是被降权了"的探针）
    for cand in [
        base.join(format!("EBWebView-{}", now_secs())),
        std::env::temp_dir().join("novel-studio-webview"),
        locallow_temp().join("novel-studio-webview"),
    ] {
        match can_write_dir(&cand) {
            Ok(()) => {
                diag_line(&format!("改用一个能写的缓存目录: {}", cand.display()));
                return (cand, true);
            }
            Err(e) => diag_line(&format!("候选目录不可写: {} -> {e}", cand.display())),
        }
    }

    diag_line("所有候选缓存目录都不可写，交给 Tauri 报错（错因见上面的 errno）");
    (stable, true)
}

/// `%LOCALAPPDATA%\..\LocalLow\Temp`。
/// 低完整性（Low IL）进程只有这里和它自己的容器还能写，
/// 所以这个路径能不能写，本身就是一条诊断信息。
fn locallow_temp() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let p = PathBuf::from(local);
    match p.parent() {
        Some(appdata) => appdata.join("LocalLow").join("Temp"),
        None => PathBuf::from("."),
    }
}

/// 真写一个探针文件来确认目录可用；失败时连 errno 一起带回来。
fn can_write_dir(dir: &Path) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("create_dir_all {e} (raw={:?})", e.raw_os_error()))?;
    let probe = dir.join(".wuyou-write-test");
    {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&probe)
            .map_err(|e| format!("create {e} (raw={:?})", e.raw_os_error()))?;
        f.write_all(b"ok")
            .map_err(|e| format!("write {e} (raw={:?})", e.raw_os_error()))?;
    }
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 启动时的环境自检：把「程序眼里的世界」原样记下来。
fn boot_diag() {
    diag_line("=== 启动 ===");
    if let Ok(exe) = std::env::current_exe() {
        diag_line(&format!("exe = {}", exe.display()));
    }
    for key in ["USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP", "USERNAME"] {
        diag_line(&format!("{key} = {:?}", std::env::var(key).ok()));
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let probes: [(&str, PathBuf); 3] = [
        ("LOCALAPPDATA", PathBuf::from(&local)),
        ("TEMP", std::env::temp_dir()),
        ("LocalLow\\Temp", locallow_temp()),
    ];
    for (label, dir) in probes {
        match can_write_dir(&dir) {
            Ok(()) => diag_line(&format!("写测试 {label} = OK  ({})", dir.display())),
            Err(e) => diag_line(&format!("写测试 {label} = 失败 {e}")),
        }
    }
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

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 诊断日志的落点候选。
/// 2026-10-25 实测：这个进程连 `%TEMP%` 都写不进去（更别说 LOCALAPPDATA），
/// 以前只往 `%TEMP%` 写 —— 结果日志全丢，白查一整天。exe 旁边和 LocalLow
/// 一定写得进，所以按「临时目录 → exe 目录 → LocalLow」依次试。
fn diag_log_candidates() -> Vec<PathBuf> {
    let mut v = vec![std::env::temp_dir().join("novel-studio-diag.log")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join("novel-studio-diag.log"));
        }
    }
    v.push(locallow_temp().join("novel-studio-diag.log"));
    v
}

/// 往第一个写得进的候选里追加一行。
fn diag_write(line: &str) {
    for p in diag_log_candidates() {
        if append_line(&p, line) {
            return;
        }
    }
}

/// 追加一行，返回到底写进去了没有。
fn append_line(path: &Path, line: &str) -> bool {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(mut f) => writeln!(f, "{line}").is_ok(),
        Err(_) => false,
    }
}

/// 崩溃、退出这类事件：优先写 crash.log，写不进去就退到临时目录。
/// 以前这里是 `if let Ok(..) { .. }` 静默吞错 —— 结果程序在最需要日志的
/// 那一刻，一行都没留下（2026-10-25 那次四条崩溃，crash.log 纹丝不动）。
fn log_line(text: &str) {
    let line = format!("[{}] {text}", now_secs());
    let mut wrote = false;
    if let Some(path) = log_file() {
        wrote = append_line(&path, &line);
    }
    if !wrote {
        diag_write(&line);
    }
}

/// 诊断行：crash.log 和诊断日志各写一遍。
/// 两处都写是刻意的 —— 「写不进去」本身就是要诊断的症状。
fn diag_line(text: &str) {
    let line = format!("[{}] {text}", now_secs());
    eprintln!("{line}");
    if let Some(path) = log_file() {
        let _ = append_line(&path, &line);
    }
    diag_write(&line);
}

/// 有一条要作者知道的事，但又不想用"启动失败"的口气去吓人。
/// 2026-10-25：目前没有调用点（原来那条「缓存目录被占」的提示改成写日志了），
/// 保留是因为它是唯一「温和提示」的入口，以后要弹东西还用它。
#[allow(dead_code)]
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
    // 把日志的位置也印在弹框里：崩溃现场最缺的就是"日志在哪"。
    // 只列候选、不写实际落点，因为这一刻很可能连日志都写不进去。
    let logs = diag_log_candidates()
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let msg = format!("{hint}\n\n—— 原始错误 ——\n{detail}\n\n—— 诊断日志 ——\n{logs}");
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
