/* ============================================================
   构建前端（Node 入口，不用 vite CLI）

   为什么要自己写一个而不是 `npm run build`：

   Vite 在 Windows 上第一次解析真实路径时会执行 `exec('net use')`
   去探测网络映射盘。在受限环境（禁止管道子进程）里这条命令会
   抛 EPERM，导致 vite CLI 直接崩掉 —— 每次构建都要额外授权。

   从 Node 里用编程接口调 `build()`，并且**不经过配置文件加载**，
   就不会走到那个探测。配置直接写在下面，和 vite.config.ts 保持一致。

   跑法：node scripts/build.mjs
   ============================================================ */

import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 与 vite.config.ts 保持一致的构建参数。
// 刻意不写 server 段 —— 那是开发服务器用的，构建不需要。
const config = {
  configFile: false,
  root: process.cwd(),
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
}

try {
  await build(config)
  console.log('')
  console.log('  构建完成，产物在 dist/')
  console.log('')
} catch (err) {
  console.error('')
  console.error('  构建失败：', err?.message ?? err)
  console.error('')
  process.exit(1)
}
