fn main() {
    /* 换了图标一定要让 cargo 重跑这个脚本。
       tauri-build 会把 icon.ico 编进 exe 的 Windows 资源里，但它不会为
       这些图片发 rerun-if-changed；于是只替换 icons/icon.ico 再 build 时，
       cargo 认为资源没变，exe 就还嵌着旧图标 —— 表现出来就是
       "图标改了、安装包变了、exe 却没变"。
       这一行把图标目录整个声明成输入，以后换图就不用记得手动 clean。 */
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
