/* ============================================================
   随机拖动压测：抓「一个 id 出现在容器里两次」这类坏数据

   纯函数的随机压测（scripts/org-test.ts 第 11 节）证明不了「真实手势
   走不到坏路」—— 它喂的是我自己构造的参数。这里改成：随机做真实的
   拖动动作，每一步之后从 localStorage 里读回真正存下来的数据，
   检查同样的两条铁律。

   这样能抓到「某条手势路径把一个 id 塞进了不该去的容器」这类问题。

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/verify-drag-fuzz.mjs [步数]
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9351
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'
const STEPS = Number(process.argv[2] ?? 40)
const VERBOSE = process.env.VERBOSE === '1'
const profile = mkdtempSync(join(tmpdir(), 'ns-fuzz-'))

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
    } catch { /* 等 */ }
    if (!page) await sleep(500)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (m, p = {}) => new Promise((res, rej) => {
    const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method: m, params: p }))
  })
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  }
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result.value
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  for (let i = 0; i < 60; i++) {
    const st = await evaluate(`({sk: document.querySelectorAll('.skeleton').length, len: document.getElementById('root')?.innerHTML.length ?? -1})`)
    if (st.sk === 0 && st.len > 0) break
    await sleep(450)
  }

  const clickText = async (t) => {
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(t)})
      if (b) b.click(); return true
    })()`)
    await sleep(420)
  }
  const setField = async (sel, val) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return false
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true
    })()`)
    await sleep(320)
  }

  /** 从 localStorage 读回真正存下来的项目数据 */
  const readProject = () =>
    evaluate(`
      (() => {
        try {
          const key = Object.keys(localStorage).find((k) => k.startsWith('novel-studio:novel:'))
          if (!key) return null
          const n = JSON.parse(localStorage.getItem(key))
          return { folders: n.project.folders, rootItems: n.project.rootItems, entities: n.entities.map((e) => e.id) }
        } catch (e) { return { error: String(e) } }
      })()
    `)

  /** 两条铁律 + 顺带报告每个夹子的数目 */
  const audit = (tag, project, action) => {
    if (!project || project.error) return { bad: true, why: '读不出数据 ' + JSON.stringify(project) }
    const containers = [['ROOT', project.rootItems ?? []], ...(project.folders ?? []).map((f) => [f.id + '/' + f.name, f.items ?? []])]
    const known = new Set([...(project.entities ?? []), ...(project.folders ?? []).map((f) => f.id)])
    const problems = []
    for (const [name, items] of containers) {
      const local = new Map()
      for (const x of items) {
        if (!known.has(x)) problems.push({ tag, name, x, why: '不存在的 id' })
        local.set(x, (local.get(x) ?? 0) + 1)
      }
      for (const [x, n] of local) {
        if (n > 1) {
          problems.push({
            tag,
            name,
            x,
            why: `同一个容器里出现 ${n} 次`,
            数组内容: items.join(','),
            动作: action,
          })
        }
      }
    }
    const counts = containers.map(([name, items]) => {
      const own = items.filter((x) => (project.entities ?? []).includes(x)).length
      return `${name.replace(/^.*\//, '')}:${own}`
    })
    return { problems, counts }
  }

  // ---- 建小说 + 7 个条目 ----
  await evaluate(`(() => {
    const inp = document.querySelector('input[placeholder="小说的名字"]')
    if (!inp) return false
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    s.call(inp, '压测'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(300)
  await clickText('创建')
  await sleep(1400)
  await evaluate(`(() => { const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定')); if (t) t.click(); return true })()`)
  await sleep(700)
  for (let i = 1; i <= 7; i++) {
    await clickText('新建词条')
    await sleep(400)
    await setField('input[placeholder="名称"]', '条目' + i)
    await clickText('返回索引')
    await sleep(320)
  }
  // 两个夹子
  await clickText('新建词条夹')
  await sleep(650)
  await setField('[data-folder-head] input', '宋国')
  await clickText('全部')
  await sleep(500)
  await clickText('新建词条夹')
  await sleep(650)
  await setField('[data-folder-head] input', '子夹')
  await clickText('全部')
  await sleep(500)

  // ---- 随机拖动 ----
  let seed = 987654321
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = (a) => a[Math.floor(rnd() * a.length)]

  const slots = () => `Array.from(document.querySelectorAll('[data-slot]'))`
  const pointOf = async (expr) =>
    evaluate(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) } })()`)

  const doDrag = async (fromPt, toPt) => {
    if (!fromPt || !toPt) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromPt.x, y: fromPt.y })
    await sleep(50)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromPt.x, y: fromPt.y, button: 'left', clickCount: 1 })
    await sleep(70)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromPt.x + 9, y: fromPt.y + 9, button: 'left' })
    await sleep(140)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toPt.x, y: toPt.y, button: 'left' })
    await sleep(160)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toPt.x, y: toPt.y, button: 'left', clickCount: 1 })
    // 落盘是 600ms 防抖，读之前必须等它写完，否则读到的是上一步的状态
    await sleep(1000)
    return true
  }

  let violations = 0

  /* 先看**拖动之前**干不干净 —— 不然后面每一处违规都说不清是谁造成的 */
  {
    const p0 = await readProject()
    const r0 = audit('铺设之后', p0, '无')
    console.log('   铺设之后 rootItems：', (p0?.rootItems ?? []).join(','))
    console.log('   铺设之后各容器条目数：', (r0.counts ?? []).join(' | '))
    if (r0.problems?.length) {
      violations += r0.problems.length
      for (const p of r0.problems.slice(0, 3)) console.log('   ✗', JSON.stringify(p))
    }
  }

  for (let step = 1; step <= STEPS; step++) {
    const n = await evaluate(`${slots()}.length`)
    if (n === 0) {
      // 空容器：回顶层
      await clickText('全部')
      continue
    }
    const fromIdx = Math.floor(rnd() * n)
    const fromPt = await pointOf(`${slots()}[${fromIdx}]`)
    const kinds = await evaluate(`${slots()}.map((e) => e.dataset.kind + ':' + e.dataset.id.slice(-4))`)
    const kindAt = (i) => kinds[i] ?? '?'

    // 一半概率拖到某个夹子的框里（放进），一半概率拖到另一张卡上（换位）
    const folderIdx = await evaluate(`
      (() => { const all = ${slots()}; return all.findIndex((e) => e.dataset.kind === 'folder') })()
    `)
    let toPt
    let folderPt = null
    if (folderIdx >= 0 && rnd() < 0.5) {
      folderPt = await pointOf(`${slots()}[${folderIdx}]`)
      toPt = folderPt
    } else {
      toPt = await pointOf(`${slots()}[${Math.floor(rnd() * n)}]`)
    }

    await doDrag(fromPt, toPt)

    const action = `拖第 ${fromIdx} 项（${kindAt(fromIdx, n)}）→ ${
      folderIdx >= 0 && toPt === folderPt ? '夹子框' : '另一张卡'
    }`
    const project = await readProject()
    const { problems, counts } = audit(`第 ${step} 步`, project, action)
    if (problems && problems.length) {
      violations += problems.length
      for (const p of problems.slice(0, 3)) console.log('   ✗', JSON.stringify(p))
    }
    if (step <= 6 || step % 10 === 0) console.log(`   第 ${step} 步之后：`, counts.join(' | '))

    // 偶尔换个容器待着
    if (rnd() < 0.25) {
      const crumbs = await evaluate(`
        Array.from(document.querySelectorAll('[data-drop-into]')).length
      `)
      void crumbs
      await clickText('全部')
      await sleep(300)
    }
  }

  const finalProject = await readProject()
  const { problems: finalProblems, counts: finalCounts } = audit('收尾', finalProject)
  console.log('\n最终各容器条目数：', (finalCounts ?? []).join(' | '))
  console.log('实体总数：', (finalProject?.entities ?? []).length)
  if (finalProblems && finalProblems.length) {
    violations += finalProblems.length
    for (const p of finalProblems.slice(0, 10)) console.log('   ✗', p)
  }
  console.log(`\n共 ${STEPS} 步随机拖动，违规 ${violations} 处。`)

  ws.close(); edge.kill(); process.exit(violations === 0 ? 0 : 1)
}
main().catch((e) => { console.error('失败：', e.message); try { edge.kill() } catch {} process.exit(1) })
