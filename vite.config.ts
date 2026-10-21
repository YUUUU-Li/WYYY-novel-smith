import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 本地桌面工具，不需要暴露到局域网。
//
// 注：在禁止子进程管道的受限沙箱里启动会失败，因为 Vite 在 Windows 上
// 第一次解析真实路径时会执行 `exec('net use')` 探测网络驱动器。
// 试过用轮询式监听绕开，无效 —— 那一步发生在加载配置阶段，比服务器
// 选项生效更早。这是环境限制，不是代码问题；正常终端里启动不受影响。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5183,
    strictPort: false,
    open: false,
    watch: {
      // 编辑器写文件时会在源文件旁留一个临时目录，
      // 文件监听器会去 watch 它，而那一刻它正被锁着 → EBUSY 直接搞崩 dev server。
      // 忽略这些目录，比事后重启省事得多。
      ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
})

