/* ============================================================
   在真实浏览器里量布局

   为什么需要它：
   正文区「没有滚动条」这类问题，靠读代码是猜。CSS 高度链
   （flex → 百分比 → 第三方库的行内样式）出问题的地方太多，
   必须在真的渲染引擎里量。

   做法：启动无头 Edge 并开远程调试，用 CDP 连上去，
   等应用真的初始化完，再注入脚本量各个元素的实际尺寸。

   跑法：node scripts/measure-layout.mjs
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'

const profile = mkdtempSync(join(tmpdir(), 'ns-measure-'))

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    URL,
  ],
  { stdio: 'ignore', detached: false },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等调试端口起来 */
async function waitForTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 端口还没开，继续等
    }
    await sleep(500)
  }
  throw new Error('等不到调试端口')
}

async function main() {
  const target = await waitForTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
      )
    }
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  // 收集页面运行时的报错。
  // 注意：必须在 reload 之前装好监听，否则页面早就加载完了，
  // 早期错误（比如模块加载失败）根本抓不到。
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      console.log(
        '[页面异常]',
        d.exception?.description ?? d.text ?? JSON.stringify(d).slice(0, 200),
      )
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      console.log('[页面错误]', m.params.entry.text?.slice(0, 300))
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      console.log(
        '[console.error]',
        m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300),
      )
    }
  })

  // 重新加载一次，从零开始观察
  await send('Page.reload', { ignoreCache: true })

  // 等应用真的渲染出来（骨架屏消失）
  let ready = false
  for (let i = 0; i < 60; i++) {
    const st = await evaluate(`
      (() => ({
        sk: document.querySelectorAll('.skeleton').length,
        rootLen: document.getElementById('root')?.innerHTML.length ?? -1,
      }))()
    `)
    if (st.sk === 0 && st.rootLen > 0) {
      ready = true
      break
    }
    await sleep(500)
  }
  console.log(ready ? '应用已渲染' : '⚠ 超时，仍是加载态')
  console.log('')

  const diag = await evaluate(`
    (() => {
      const root = document.getElementById('root')
      return {
        rootHTML长度: root ? root.innerHTML.length : -1,
        rootHTML片段: root ? root.innerHTML.slice(0, 300) : '',
        innerText长度: document.body.innerText.length,
        ls可用: (() => { try { localStorage.setItem('__t','1'); return true } catch { return false } })(),
        ls内容: (() => { try { return Object.keys(localStorage).join(',') } catch { return '读不了' } })(),
        样式表数: document.styleSheets.length,
        报错: window.__errs ?? [],
      }
    })()
  `)
  console.log('=== 诊断 ===')
  for (const [k, v] of Object.entries(diag)) {
    if (Array.isArray(v)) {
      console.log(`${k}:`, v.length ? JSON.stringify(v, null, 2) : '(无)')
    } else {
      console.log(`${k}: ${v}`)
    }
  }
  console.log('')

  // 看看现在停在哪个界面
  const screen = await evaluate(`
    (() => {
      const t = document.body.innerText.slice(0, 160).replace(/\\n+/g, ' | ')
      return t
    })()
  `)
  console.log('当前界面文字：', screen || '(空白)')
  console.log('')

  /* 这个配置目录是全新的，所以可能停在「新建小说」。
     先把小说建出来，否则后面量不到任何东西。 */
  const created = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="小说的名字"]')
      if (!inp) return 'already'
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '布局测量')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed'
    })()
  `)
  if (created === 'typed') {
    await sleep(300)
    await evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const b = btns.find(x => x.textContent.trim() === '创建')
        if (b) b.click()
        return true
      })()
    `)
    await sleep(1500)
    console.log('已新建小说')
  }

  /* 切到「设定」视图 */
  await evaluate(`
    (() => {
      const tabs = Array.from(document.querySelectorAll('.nav-tab'))
      const set = tabs.find(b => b.textContent.includes('设定'))
      if (set) set.click()
      return true
    })()
  `)
  await sleep(800)

  /* 一本新小说里没有条目，先在「设定」视图里建一个角色 */
  await evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const b = btns.find(x => /新建角色|新建词条$/.test(x.textContent.trim()))
      if (b) { b.click(); return true }
      return false
    })()
  `)
  await sleep(1200)

  /* 往编辑器里塞大量文字，才能验证「能不能滚」。
     空正文当然不需要滚动条，那样量不出问题。 */
  await evaluate(`
    (() => {
      const cm = document.querySelector('.cm-content')
      if (!cm) return 'no-editor'
      cm.focus()
      // 用 execCommand 插入，React 的 onChange 会收到变更
      const lines = Array.from({ length: 60 }, (_, i) =>
        '第' + (i + 1) + '行：这是一段用来测试滚动的内容，足够长以便撑出滚动条。')
      document.execCommand('insertText', false, lines.join('\\n'))
      return 'inserted'
    })()
  `)
  await sleep(1200)

  const report = await evaluate(`
    (() => {
      const out = {}
      const grab = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          h: Math.round(r.height),
          overflowY: cs.overflowY,
          height: cs.height,
          scrollH: el.scrollHeight,
          clientH: el.clientHeight,
          能滚: el.scrollHeight - el.clientHeight,
        }
      }
      out['.ns-editor'] = grab('.ns-editor')
      out['.cm-editor'] = grab('.cm-editor')
      out['.cm-scroller'] = grab('.cm-scroller')
      out['.cm-content'] = grab('.cm-content')
      out['正文字数'] = document.querySelector('.cm-content')?.textContent?.length ?? 0

      // 真滚一下，验证 scrollTop 会不会变
      const sc = document.querySelector('.cm-scroller')
      let scrolled = null
      if (sc) {
        const before = sc.scrollTop
        sc.scrollTop = 300
        scrolled = { before, after: sc.scrollTop }
      }
      out['实际滚动'] = scrolled
      return out
    })()
  `)

  console.log('=== 正文区各层实测（已塞入大量文字）===')
  for (const [k, v] of Object.entries(report)) {
    if (v && typeof v === 'object') {
      console.log(
        `${k}: 高=${v.h} overflowY=${v.overflowY} height=${v.height}` +
          (v.scrollH !== undefined
            ? ` scrollH=${v.scrollH} clientH=${v.clientH} 能滚=${v.能滚}`
            : ` ${JSON.stringify(v)}`),
      )
    } else {
      console.log(`${k}: ${v}`)
    }
  }

  ws.close()
  edge.kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('失败：', e.message)
  try {
    edge.kill()
  } catch {
    /* 已经退出了 */
  }
  process.exit(1)
})
