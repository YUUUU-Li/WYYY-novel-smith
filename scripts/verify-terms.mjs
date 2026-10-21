/* ============================================================
   「字典」并进「概念」，在真浏览器里走一遍

   为什么必须跑浏览器：
   · 迁移发生在打开作品的路上（adopt），纯函数测过不等于接线对了
   · 「迁移之后要顺手落盘」只有回头读 localStorage 才知道
   · 「断链 → 一键建成条目 → 链接能跳」是一条跨视图的路

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/verify-terms.mjs
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9381
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'
const LS_PREFIX = 'novel-studio:'

const profile = mkdtempSync(join(tmpdir(), 'ns-terms-'))
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

let checks = 0
let failures = 0
function check(label, ok, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

async function main() {
  let page
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {
      /* 端口还没开 */
    }
    if (!page) await sleep(500)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
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
  const pageErrors = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(
        msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text,
      )
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      pageErrors.push(msg.params.entry.text)
    }
  }
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
    }
    return r.result.value
  }
  const clickText = async (t) => {
    const ok = await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(t)})
        if (b) { b.click(); return true }
        return false
      })()
    `)
    await sleep(450)
    return ok
  }
  const setInput = async (sel, value) => {
    const ok = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return false
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        s.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(350)
    return ok
  }
  const goView = async (name) => {
    await evaluate(`
      (() => {
        const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes(${JSON.stringify(name)}))
        if (t) t.click()
        return true
      })()
    `)
    await sleep(900)
  }

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.reload', { ignoreCache: true })

  for (let i = 0; i < 60; i++) {
    const st = await evaluate(`
      (() => ({ sk: document.querySelectorAll('.skeleton').length, len: document.getElementById('root')?.innerHTML.length ?? -1 }))()
    `)
    if (st.sk === 0 && st.len > 0) break
    await sleep(500)
  }

  console.log('\n[1] 建一本小说，然后往里塞一份「老格式」的数据')

  await setInput('input[placeholder="小说的名字"]', '合并核对')
  await sleep(300)
  await clickText('创建')
  await sleep(1600)

  console.log('\n[0] 导航里不该再有「字典」（打开作品之后才显示导航）')
  const nav = await evaluate(
    `Array.from(document.querySelectorAll('.nav-tab')).map((b) => b.textContent.trim())`,
  )
  console.log('    导航：', JSON.stringify(nav))
  check('导航是六项（概览 + 五个功能）', nav.length === 6, JSON.stringify(nav))
  check('「字典」这一项没了', !nav.some((x) => x.includes('字典')), JSON.stringify(nav))

  /* 直接改 localStorage 里的那份小说：加两条词条、给一个条目写两句
     [[双括号]]（一个指真实条目、一个指不存在的词），然后刷新。
     这条路径等价于「打开一个用了旧版本的书」。 */
  const injected = await evaluate(`
    (() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith(${JSON.stringify(LS_PREFIX + 'novel:')}))
      if (!key) return null
      const novel = JSON.parse(localStorage.getItem(key))
      novel.entities = [
        {
          id: 'e_old1', type: 'character', name: '林昭', tags: [], links: [],
          summary: '北境守将', body: '他和[[成刃]]一起守过[[雪原]]。', file: '',
        },
      ]
      novel.terms = [
        {
          id: 't1', term: '息', pronunciation: 'xī', gloss: 'breath',
          definition: '这个世界的原初力量。', links: [{ to: 'e_old1', type: '参与' }],
        },
        { id: 't2', term: '成刃', definition: '把息压进刀里。', links: [] },
      ]
      localStorage.setItem(key, JSON.stringify(novel))
      return { key, terms: novel.terms.length, entities: novel.entities.length }
    })()
  `)
  console.log('    塞进去的旧数据：', JSON.stringify(injected))
  check('找到了这本小说的存储', injected !== null, String(injected))

  await send('Page.reload', { ignoreCache: true })
  await sleep(3000)

  console.log('\n[2] 打开之后：词变成了概念条目')

  await goView('设定')
  const afterOpen = await evaluate(`
    (() => {
      const t = document.body.innerText
      return {
        有息: t.includes('息'),
        有成刃: t.includes('成刃'),
        概念计数: (t.match(/概念/g) || []).length,
        页面上还有字典吗: !!Array.from(document.querySelectorAll('.nav-tab')).find((b) => b.textContent.includes('字典')),
      }
    })()
  `)
  console.log('    设定页：', JSON.stringify(afterOpen))
  check('「息」出现在设定里', afterOpen.有息, JSON.stringify(afterOpen))
  check('「成刃」出现在设定里（它本来是同名并进去的那个）', afterOpen.有成刃)
  check('「概念」这个类型出现了', afterOpen.概念计数 > 0, String(afterOpen.概念计数))

  /* 迁移应当顺手落盘：再读一次 localStorage，terms 该是空的、条目该多了 */
  const persisted = await evaluate(`
    (() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith(${JSON.stringify(LS_PREFIX + 'novel:')}))
      const novel = JSON.parse(localStorage.getItem(key))
      return {
        terms: novel.terms.length,
        概念条目: novel.entities.filter((e) => e.type === 'concept').map((e) => e.name),
        成刃的正文: (novel.entities.find((e) => e.name === '成刃') || {}).body ?? null,
        成刃的读音字段: ((novel.entities.find((e) => e.name === '成刃') || {}).fields ?? {}),
        息的读音: (((novel.entities.find((e) => e.name === '息') || {}).fields ?? {})['读音'] ?? null),
        息的链接类型: ((novel.entities.find((e) => e.name === '息') || {}).links ?? []).map((l) => l.type),
        字段声明: ((novel.project.fieldSchemas || {}).concept || []).map((f) => f.key),
      }
    })()
  `)
  console.log('    迁移之后存下去的样子：', JSON.stringify(persisted))
  check('词条列表在磁盘上被清空（不会每开一次都重迁）', persisted.terms === 0, String(persisted.terms))
  check('真的多出了概念条目', persisted.概念条目.length >= 2, JSON.stringify(persisted.概念条目))
  check('同名的「成刃」只留一条，但定义没丢',
    (persisted.成刃的正文 ?? '').includes('把息压进刀里。'), String(persisted.成刃的正文))
  check('读音进了概念条目的自定义字段', persisted.息的读音 === 'xī', String(persisted.息的读音))
  check('概念类型补上了「读音」「直译」字段声明',
    persisted.字段声明.includes('读音') && persisted.字段声明.includes('直译'),
    JSON.stringify(persisted.字段声明))
  check('「息」和那个条目的关系落成「相关」', persisted.息的链接类型.every((t) => t !== '参与'),
    JSON.stringify(persisted.息的链接类型))

  console.log('\n[3] 概览：断链列出来，一键建成条目')

  await goView('概览')
  const brokenPanel = await evaluate(`
    (() => {
      const t = document.body.innerText
      return {
        提到断链: t.includes('指向不存在的条目'),
        列出雪原: t.includes('[[雪原]]'),
        有建成按钮: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '建成条目'),
        有术语表: !!document.querySelector('[data-glossary]'),
      }
    })()
  `)
  console.log('    概览：', JSON.stringify(brokenPanel))
  check('概览里写着有断链', brokenPanel.提到断链, JSON.stringify(brokenPanel))
  check('断链列的是那个真找不到的名字', brokenPanel.列出雪原)
  check('每条断链旁边有「建成条目」', brokenPanel.有建成按钮)
  check('术语表出现了（概念条目的只读视图）', brokenPanel.有术语表)

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '建成条目')
      if (b) b.click()
      return !!b
    })()
  `)
  await sleep(900)
  const resolved = await evaluate(`
    (() => {
      const t = document.body.innerText
      return {
        还报断链: t.includes('指向不存在的条目'),
        连成一条了: t.includes('都指向真实条目'),
      }
    })()
  `)
  console.log('    建成之后：', JSON.stringify(resolved))
  check('建成之后断链消失了', resolved.还报断链 === false, JSON.stringify(resolved))

  const entityMade = await evaluate(`
    (() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith(${JSON.stringify(LS_PREFIX + 'novel:')}))
      const novel = JSON.parse(localStorage.getItem(key))
      const e = novel.entities.find((x) => x.name === '雪原')
      return e ? { type: e.type } : null
    })()
  `)
  check('那个名字真的成了概念条目', entityMade?.type === 'concept', JSON.stringify(entityMade))

  console.log('\n[4] 页面无报错')
  check('控制台无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400))

  console.log('')
  console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
  ws.close()
  edge.kill()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('失败：', e.message)
  try {
    edge.kill()
  } catch {
    /* 已经退出 */
  }
  process.exit(1)
})
