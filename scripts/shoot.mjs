/* ============================================================
   截图看一眼

   圆角这种事读 CSS 是看不出好坏的，得真渲染出来看。
   这个脚本建一本小说、造几个条目，然后把几个主要界面截成 png。

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/shoot.mjs [输出目录]
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9348
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'
const OUT = process.argv[2] ?? '.shots'

const profile = mkdtempSync(join(tmpdir(), 'ns-shot-'))
mkdirSync(OUT, { recursive: true })

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', URL,
], { stdio: 'ignore', detached: false })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let page
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { /* 等端口 */ }
    if (!page) await sleep(500)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { res, rej })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  }
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result.value
  }
  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log('  ', file)
  }
  const clickText = async (t) => {
    const ok = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(t)})
      if (!b) return false
      b.click(); return true
    })()`)
    await sleep(500)
    return ok
  }

  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.reload', { ignoreCache: true })
  for (let i = 0; i < 60; i++) {
    const st = await evaluate(`({sk: document.querySelectorAll('.skeleton').length, len: document.getElementById('root')?.innerHTML.length ?? -1})`)
    if (st.sk === 0 && st.len > 0) break
    await sleep(500)
  }

  await shoot('01-空作品库')

  // 建小说
  await evaluate(`(() => {
    const inp = document.querySelector('input[placeholder="小说的名字"]')
    if (!inp) return false
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    s.call(inp, '圆角试验'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(300)
  await clickText('创建')
  await sleep(1500)

  // 造几个条目
  await evaluate(`(() => { const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定')); if (t) t.click(); return true })()`)
  await sleep(700)
  const names = ['林昭', '苏无咎', '北境要塞', '寒刃']
  for (const n of names) {
    await clickText('新建词条')
    await sleep(600)
    await evaluate(`(() => {
      const el = document.querySelector('input[placeholder="名称"]')
      if (!el) return false
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      s.call(el, ${JSON.stringify(n)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true
    })()`)
    await sleep(400)
    await clickText('返回索引')
    await sleep(400)
  }
  // 补一句话摘要，卡片才不空
  await evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('textarea')).find(t => t.placeholder?.includes('一句话'))
    if (!el) return false
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '北境要塞守将，守了十年。'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(500)
  await clickText('返回索引')
  await sleep(600)

  await shoot('02-设定-卡片网格')

  // 紧凑表格
  await evaluate(`(() => { const b = document.querySelector('button[title="切换为紧凑列表"]'); if (b) b.click(); return true })()`)
  await sleep(600)
  await shoot('03-设定-紧凑表格')
  await evaluate(`(() => { const b = document.querySelector('button[title="切换为卡片视图"]'); if (b) b.click(); return true })()`)
  await sleep(500)

  // 词条夹
  await clickText('新建词条夹')
  await sleep(700)
  await evaluate(`(() => {
    const el = document.querySelector('[data-folder-head] input')
    if (!el) return false
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    s.call(el, '北境人物'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(400)
  await evaluate(`(() => {
    const el = document.querySelector('[data-folder-head] textarea')
    if (!el) return false
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '所有和北境有关的人。'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(400)
  await shoot('04-词条夹页面')
  await clickText('全部')
  await sleep(600)
  await shoot('05-设定-带词条夹')

  /* 悬停态：把鼠标真放到元素上再截 —— 只看 CSS 判断不出「是不是变黑了」 */
  const hoverByText = async (text, name) => {
    const p = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === ${JSON.stringify(text)})
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (!p) {
      console.log('    找不到可悬停的按钮：', text)
      return
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await sleep(400)
    await shoot(name)
  }

  await hoverByText('新建词条夹', '05b-悬停-次按钮')
  await hoverByText('概览', '05c-悬停-导航')

  // 悬停一张卡片
  const cardPt = await evaluate(`(() => {
    const el = document.querySelector('[data-slot][data-kind="entity"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (cardPt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardPt.x, y: cardPt.y })
    await sleep(400)
    await shoot('05d-悬停-卡片')
  }

  // 条目编辑页
  await evaluate(`(() => { const el = document.querySelector('[data-slot][data-kind="entity"]'); if (el) el.click(); return true })()`)
  await sleep(900)
  await shoot('06-条目编辑')

  /* 事件页：参与角色标签 + 发生地点。
     这两栏是新做的，得看一眼它们挤在同一列里协不协调。 */
  await clickText('返回索引')
  await sleep(400)
  await clickText('新建词条')
  await sleep(700)
  await clickText('事件')
  await sleep(500)
  await evaluate(`(() => {
    const el = document.querySelector('input[placeholder="名称"]')
    if (!el) return false
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    s.call(el, '雪原之战'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(400)
  for (const who of ['林昭', '苏无咎']) {
    const started = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('添加参与角色') || x.textContent.includes('再加一个'))
      if (b) b.click(); return !!b
    })()`)
    if (!started) break
    await sleep(400)
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(who)})
      if (b) b.click(); return !!b
    })()`)
    await sleep(500)
  }
  await shoot('06b-事件-参与角色')

  // 关系网
  await evaluate(`(() => { const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('关系网')); if (t) t.click(); return true })()`)
  await sleep(1000)

  /* 往画布上放几个方格。
     画布收的是 HTML5 拖放（dataTransfer 里带条目 id），
     所以这里用 CDP 的 dispatchDragEvent 真的走一遍。 */
  const dropOnCanvas = async (name, x, y) => {
    // 先在左栏找到那个词条的 id（它就是 dataTransfer 里要带的）
    const id = await evaluate(`(() => {
      const el = Array.from(document.querySelectorAll('[draggable="true"]'))
        .find((e) => e.textContent.trim() === ${JSON.stringify(name)})
      return el ? el.dataset.id ?? el.getAttribute('data-id') ?? null : null
    })()`)
    if (!id) return false
    const data = {
      items: [{ mimeType: 'text/plain', data: id }],
      dragOperationsMask: 1,
    }
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
    await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
    await sleep(80)
    await send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
    await sleep(400)
    return true
  }

  /* 左栏的词条行到底有没有 data-id —— 先探一下，免得静默失败 */
  const probe = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[draggable="true"]'))
    return rows.slice(0, 3).map((e) => ({
      text: e.textContent.trim(),
      attrs: Array.from(e.attributes).map((a) => a.name + '=' + a.value).join(' '),
    }))
  })()`)
  console.log('    左栏可拖的行：', JSON.stringify(probe))

  await dropOnCanvas('林昭', 700, 300)
  await dropOnCanvas('苏无咎', 1050, 300)
  await dropOnCanvas('北境要塞', 700, 480)
  await sleep(400)
  await shoot('07-关系网')

  /* 删除模式下的悬停反馈：纯视觉的东西，只能截出来看 */
  const clickBtn = async (text) => {
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(text)})
      if (b) b.click(); return true
    })()`)
    await sleep(420)
  }

  // 先连一条线，删除连线才有东西可指
  await clickBtn('连线')
  const pts = await evaluate(`
    Array.from(document.querySelectorAll('[data-node]')).slice(0, 2).map((g) => {
      const r = g.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
  `)
  for (const p of pts) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await sleep(80)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(400)
  }

  await clickBtn('删除方格')
  const nodePt = await evaluate(`(() => {
    const g = document.querySelector('[data-node]')
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (nodePt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodePt.x, y: nodePt.y })
    await sleep(450)
    await shoot('07b-删除方格-悬停')
  } else {
    console.log('    画布上找不到方格')
  }

  await clickBtn('删除连线')
  const mid = await evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('path')).find(
      (x) => x.getAttribute('stroke') === 'transparent' && x.getAttribute('stroke-width') === '16',
    )
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (mid) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y })
    await sleep(450)
  } else {
    console.log('    找不到连线的点击区')
  }
  await shoot('07c-删除连线-悬停')

  // 概览
  await evaluate(`(() => { const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('概览')); if (t) t.click(); return true })()`)
  await sleep(800)
  await shoot('08-概览')

  // 搜索面板
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 })
  await sleep(700)
  await shoot('09-搜索面板')

  ws.close(); edge.kill(); process.exit(0)
}
main().catch((e) => { console.error('失败：', e.message); try { edge.kill() } catch {} process.exit(1) })
