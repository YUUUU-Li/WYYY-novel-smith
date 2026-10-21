// 发布版不要弹出控制台黑窗。
// 诊断期间临时关掉：release 崩溃时没有控制台就看不到 panic 信息。
// #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    novel_studio_lib::run()
}
