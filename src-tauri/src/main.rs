// 发布版不要弹出控制台黑窗。
// 崩溃时会由 lib.rs 里的 panic hook 写日志 + 弹一个消息框，
// 所以关掉控制台也不会再出现「双击了没反应、什么也看不到」。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    novel_studio_lib::run()
}