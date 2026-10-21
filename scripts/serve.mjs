/* ============================================================
   极简静态服务器

   为什么不用 Vite：
   1. Vite 在 Windows 上启动时会 spawn 子进程探测真实路径，
      在受限环境里会失败，需要额外授权。用了几次就要授权几次。
   2. 这是「用」而不是「改」程序，不需要热更新。
   3. 启动只要几十毫秒。

   dist/ 是构建产物，用 `npm run build` 更新它。

   跑法：node scripts/serve.mjs
   ============================================================ */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const PORT = Number(process.env.PORT ?? 5183)
const HOST = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 把 URL 路径解析成 dist 下的真实文件，拒绝越界访问 */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0])
  const rel = normalize(clean).replace(/^([/\\])+/, '')
  const full = join(ROOT, rel)
  // 防止 ../ 跳出 dist
  if (!full.startsWith(ROOT)) return null
  return full
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/'
  let target = resolvePath(url === '/' ? '/index.html' : url)
  if (!target) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    let info = await stat(target)
    if (info.isDirectory()) {
      target = join(target, 'index.html')
      info = await stat(target)
    }
    const body = await readFile(target)
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // 本地工具，禁止缓存免得改了看不到
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {
    // 单页应用：找不到的路径都回退到 index.html
    try {
      const body = await readFile(join(ROOT, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404).end('dist/index.html 不存在，请先运行 npm run build')
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log('')
  console.log('  吾又一言 已启动')
  console.log('')
  console.log(`  在浏览器里打开：  http://${HOST}:${PORT}/`)
  console.log('')
  console.log('  关掉这个窗口就等于关掉程序。数据不会丢。')
  console.log('')
})

/* 端口被占用是最常见的「打不开」原因之一：
   多半是已经有一个 吾又一言 在跑（双击了两次 启动.cmd），
   也可能是别的程序占了 5183。原样抛栈的话，用户只会看到一堆红字。 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('')
    console.log(`  端口 ${PORT} 已经被占用了，所以这次没能启动。`)
    console.log('')
    console.log('  如果 吾又一言 本来就在跑，那是正常的 —— 直接用这个地址：')
    console.log(`    http://${HOST}:${PORT}/`)
    console.log('')
    console.log('  如果打开后不是 吾又一言，说明是别的程序占了这个端口。')
    console.log('  换个端口再来（这个窗口先关掉）：')
    console.log(`    set PORT=5184 && node scripts\\serve.mjs`)
    console.log('')
    process.exit(1)
  }
  console.log('')
  console.log(`  [错误] 服务器起不来：${err.message}`)
  console.log('')
  process.exit(1)
})
