/* ============================================================
   启动器：把「等服务器起来 → 开浏览器 → 跑服务器」串成一步

   为什么不让 启动.cmd 自己干这些：
   cmd.exe 在代码页切到 UTF-8 之后，读批处理文件会按字节算偏移，
   一行里有中文就可能串位，然后把中文的半个字节当成命令去执行
   （报错长这样：'ho' is not recognized as an internal or external command）。
   所以 启动.cmd 现在**一个非 ASCII 字符都不许有**，
   所有中文提示都由 Node 打印 —— Node 输出 UTF-8 是可靠的。

   这个脚本做三件事：
   1. 端口已经有人应答 → 说明本来就在跑，直接开页面，不重复启动
   2. 否则先挂一个后台轮询，等端口真的应答了再开浏览器
      （不要用 sleep 猜时间：猜错的结果是浏览器停在一个死链接上）
   3. 起服务器

   跑法（由 启动.cmd 调起）：node scripts/launch.mjs
   ============================================================ */

import { connect } from 'node:net'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.PORT ?? 5183)
const HOST = '127.0.0.1'
const URL = `http://${HOST}:${PORT}/`
const WAIT_MS = Number(process.env.WAIT_MS ?? 20000)

/** 端口上有东西在应答吗 */
function probe() {
  return new Promise((resolve) => {
    const sock = connect({ host: HOST, port: PORT })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    setTimeout(() => done(false), 700)
  })
}

/** 用系统默认浏览器打开。stdio 断开，免得占住这个进程的输出。
    NO_OPEN=1 时不打开，方便自动化里试跑这个脚本。 */
function openBrowser() {
  if (process.env.NO_OPEN === '1') {
    console.log(`  （NO_OPEN=1，跳过打开浏览器。地址：${URL}）`)
    return
  }
  spawn('cmd', ['/c', 'start', '', URL], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  }).unref()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 1. 已经在跑就别再起一个 */
if (await probe()) {
  console.log('')
  console.log('  吾又一言 已经在跑了，直接打开页面。')
  console.log('')
  console.log(`    ${URL}`)
  console.log('')
  openBrowser()
  process.exit(0)
}

console.log('')
console.log('  吾又一言 正在启动...')
console.log('')
console.log('  等它起来之后浏览器会自动打开。')
console.log('  用完不要关这个窗口 —— 关掉它网页就打不开了（数据不会丢）。')
console.log('  想让它一直开着，把这个窗口最小化就行。')
console.log('')

/* 2. 后台等就绪，然后开浏览器 */
void (async () => {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    await sleep(300)
    if (await probe()) {
      console.log(`  已就绪，正在打开 ${URL}`)
      openBrowser()
      return
    }
  }
  console.log('')
  console.log('  [注意] 等了 20 秒端口还没应答。')
  console.log('  看一眼这个窗口里有没有报错，有的话把它发给 AI。')
  console.log(`  也可以手动在浏览器里试：${URL}`)
  console.log('')
})()

/* 3. import 就会 listen。端口被占时 serve.mjs 会给出人话并退出 */
await import('./serve.mjs')
