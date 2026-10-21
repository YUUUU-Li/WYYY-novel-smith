/* ============================================================
   把图标同步到网页用的位置

   桌面图标和网页图标是两份文件，但应该来自同一张图：
     · 桌面/快捷方式 → src-tauri/icons/icon.ico
     · 浏览器标签页   → public/favicon.ico + public/favicon.png

   Vite 会把 public/ 原样拷进 dist/，所以 favicon 不需要 import，
   直接在 index.html 里写 /favicon.ico 就行。

   跑法：
     npm run icons        重新画内置图标，然后同步
     npm run icons:web    只同步（比如你刚跑过 npx tauri icon 你的图.png）
   ============================================================ */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src-tauri', 'icons')
const OUT = join(HERE, '..', 'public')

const JOBS = [
  ['icon.ico', 'favicon.ico'],
  ['128x128.png', 'favicon.png'],
]

mkdirSync(OUT, { recursive: true })

let missing = 0
for (const [from, to] of JOBS) {
  const src = join(SRC, from)
  if (!existsSync(src)) {
    console.error(`  找不到 ${from} —— 先跑 npm run icons，或者 npx tauri icon 你的图.png`)
    missing++
    continue
  }
  const dst = join(OUT, to)
  copyFileSync(src, dst)
  console.log(`  ${to.padEnd(14)} ${(statSync(dst).size / 1024).toFixed(1)} KB  ← ${from}`)
}

if (missing > 0) process.exit(1)
console.log('\n完成。favicon 会在下次 npm run build 时进 dist/。')
